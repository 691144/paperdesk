/* PaperDesk cloud providers: Google Drive and Microsoft OneDrive.
   Sign-in runs as a full-page redirect (works in installed apps on desktop and
   Android), and every file lives in the app's own private folder:
   - Google: the hidden appDataFolder (scope drive.appdata)
   - OneDrive: Apps/<app name> (scope Files.ReadWrite.AppFolder)
   Nothing passes through any server other than Google's or Microsoft's. */
(function () {
  'use strict';
  const C = window.PDSyncCore;
  const CFG = window.PAPERDESK_CONFIG || {};
  const FILE = 'paperdesk-sync.json';
  const PENDING = 'pd.auth.pending';

  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
  };
  const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');
  function b64url(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function rand(n = 24) { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); }
  async function pkce() {
    const verifier = rand(48);
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return { verifier, challenge: b64url(new Uint8Array(d)) };
  }
  function clientId(type) { return String(ls.get('pd.clientId.' + type) || CFG[type + 'ClientId'] || '').trim(); }

  class NetError extends Error { constructor() { super('Could not reach the cloud. You may be offline.'); this.code = 'network'; } }
  async function net(url, opts) { try { return await fetch(url, opts); } catch { throw new NetError(); } }
  async function ok(res, what) {
    if (res.ok) return res;
    let detail = ''; try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    const e = new Error(`${what} failed (HTTP ${res.status}).`); e.code = 'http'; e.status = res.status; e.detail = detail; throw e;
  }
  const payload = (doc) => JSON.stringify({ app: 'PaperDesk', format: 1, savedAt: new Date().toISOString(), doc });
  function parsePayload(text) { const j = JSON.parse(text); if (!j || j.app !== 'PaperDesk' || !j.doc) throw new Error('The cloud file is not a PaperDesk sync file.'); return j.doc; }

  /* ---------------- shared token handling ---------------- */
  class Provider {
    constructor(type, label) { this.type = type; this.label = label; this.key = 'pd.auth.' + type; }
    get configured() { return !!clientId(this.type); }
    get connected() { return !!ls.get(this.key); }
    get account() { return ls.get(this.key)?.hint || ''; }
    tokens() { return ls.get(this.key) || {}; }
    /** Scopes granted so far (as the provider reported them). */
    get scopes() { return this.tokens().scopes || []; }
    hasScopes(list) { const have = new Set(this.scopes.map((x) => x.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase())); return list.every((x) => have.has(x.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase())); }
    saveTokens(t) { ls.set(this.key, { ...this.tokens(), ...t }); }
    expire() { const t = this.tokens(); if (t.access) { delete t.access; ls.set(this.key, t); } }
    async api(url, opts = {}) {
      const send = async () => net(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + await this.token() } });
      let res = await send();
      if (res.status === 401) { this.expire(); res = await send(); }
      return res;
    }
  }

  /* ---------------- Google Drive ---------------- */
  const G_FILES = 'https://www.googleapis.com/drive/v3/files';
  const G_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  class GoogleDrive extends Provider {
    constructor() { super('google', 'Google Drive'); }
    async authUrl(silent, extra = []) {
      const state = rand();
      const scope = [...new Set(['https://www.googleapis.com/auth/drive.appdata', ...extra])].join(' ');
      const p = new URLSearchParams({
        client_id: clientId('google'), redirect_uri: redirectUri(), response_type: 'token',
        scope, include_granted_scopes: 'true', state,
      });
      // Sync asks for consent explicitly; extra permissions only prompt when they are new.
      if (silent) p.set('prompt', 'none'); else if (!extra.length) p.set('prompt', 'consent');
      if (this.account) p.set('login_hint', this.account);
      return { url: 'https://accounts.google.com/o/oauth2/v2/auth?' + p, pending: { state } };
    }
    async complete(params) {
      const access = params.get('access_token');
      if (!access) throw new Error('Google did not return a sign-in token.');
      this.saveTokens({ access, exp: Date.now() + (Number(params.get('expires_in')) || 3600) * 1000 - 60000, scopes: (params.get('scope') || '').split(/\s+/).filter(Boolean) });
      try {
        const r = await this.api('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)');
        if (r.ok) this.saveTokens({ hint: (await r.json()).user?.emailAddress || '' });
      } catch { /* the account name is only a hint */ }
    }
    async token() {
      const t = this.tokens();
      if (t.access && t.exp > Date.now()) return t.access;
      throw new C.AuthError('Google sign-in has expired.');
    }
    async disconnect() {
      const t = this.tokens(); ls.set(this.key, null);
      if (t.access) { try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t.access), { method: 'POST' }); } catch { /* best effort */ } }
    }
    async find(name) {
      const q = new URLSearchParams({ spaces: 'appDataFolder', q: `name = '${name}' and trashed = false`, fields: 'files(id,version)', pageSize: '1' });
      const r = await ok(await this.api(`${G_FILES}?${q}`), 'Looking for the Drive copy');
      return (await r.json()).files?.[0] || null;
    }
    async create(name, content, mime) {
      const boundary = 'pd' + rand(9);
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: ['appDataFolder'] })}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n${content}\r\n--${boundary}--`;
      return ok(await this.api(`${G_UPLOAD}?uploadType=multipart&fields=id,version`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }), 'Saving to Drive');
    }
    async read() {
      const f = await this.find(FILE);
      if (!f) return null;
      const r = await ok(await this.api(`${G_FILES}/${f.id}?alt=media`), 'Downloading from Drive');
      return { doc: parsePayload(await r.text()), version: String(f.version) };
    }
    async write(doc, version) {
      const f = await this.find(FILE);
      if ((f ? String(f.version) : null) !== (version == null ? null : String(version))) throw new C.ConflictError();
      if (!f) { await this.create(FILE, payload(doc), 'application/json'); return; }
      await ok(await this.api(`${G_UPLOAD}/${f.id}?uploadType=media&fields=version`, { method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: payload(doc) }), 'Saving to Drive');
    }
    async readBlob(h) {
      const f = await this.find(`blob-${h}.txt`);
      if (!f) return null;
      return (await ok(await this.api(`${G_FILES}/${f.id}?alt=media`), 'Downloading an attachment')).text();
    }
    async writeBlob(h, value) {
      if (await this.find(`blob-${h}.txt`)) return;
      await this.create(`blob-${h}.txt`, value, 'text/plain; charset=UTF-8');
    }
  }

  /* ---------------- Microsoft OneDrive ---------------- */
  const MS = 'https://login.microsoftonline.com/common/oauth2/v2.0';
  const MS_SCOPE = 'Files.ReadWrite.AppFolder offline_access openid profile';
  const ROOT = 'https://graph.microsoft.com/v1.0/me/drive/special/approot';
  const enc = (path) => path.split('/').map(encodeURIComponent).join('/');
  class OneDrive extends Provider {
    constructor() { super('microsoft', 'OneDrive'); }
    scopeString(extra = []) { return [...new Set([...MS_SCOPE.split(' '), ...(this.tokens().extra || []), ...extra])].join(' '); }
    async authUrl(silent, extra = []) {
      const state = rand(); const { verifier, challenge } = await pkce();
      const p = new URLSearchParams({
        client_id: clientId('microsoft'), response_type: 'code', redirect_uri: redirectUri(), response_mode: 'fragment',
        scope: this.scopeString(extra), state, code_challenge: challenge, code_challenge_method: 'S256', prompt: silent ? 'none' : 'select_account',
      });
      if (this.account) p.set('login_hint', this.account);
      return { url: `${MS}/authorize?${p}`, pending: { state, verifier, extra } };
    }
    async tokenRequest(form, extra = []) {
      const res = await net(`${MS}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId('microsoft'), scope: this.scopeString(extra), ...form }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new C.AuthError(j.error_description?.split('\r\n')[0] || 'Microsoft sign-in has expired.'); e.status = res.status; throw e; }
      const t = { access: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60000 };
      if (j.refresh_token) t.refresh = j.refresh_token;
      if (j.scope) t.scopes = j.scope.split(/\s+/).filter(Boolean);
      if (extra.length) t.extra = [...new Set([...(this.tokens().extra || []), ...extra])];
      if (j.id_token) { try { const claims = JSON.parse(atob(j.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); t.hint = claims.preferred_username || claims.email || ''; } catch { /* hint only */ } }
      this.saveTokens(t);
      return t.access;
    }
    async complete(params, pending) {
      const code = params.get('code');
      if (!code) throw new Error('Microsoft did not return a sign-in code.');
      await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: pending.verifier }, pending.extra || []);
    }
    async token() {
      const t = this.tokens();
      if (t.access && t.exp > Date.now()) return t.access;
      if (t.refresh) {
        try { return await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh }); }
        catch (e) { if (e.code === 'auth') { const cur = this.tokens(); delete cur.refresh; ls.set(this.key, cur); } throw e; }
      }
      throw new C.AuthError('Microsoft sign-in has expired.');
    }
    async disconnect() { ls.set(this.key, null); }
    async read() {
      const meta = await this.api(`${ROOT}:/${FILE}?$select=eTag`);
      if (meta.status === 404) return null;
      await ok(meta, 'Looking for the OneDrive copy');
      const { eTag } = await meta.json();
      const r = await ok(await this.api(`${ROOT}:/${FILE}:/content`), 'Downloading from OneDrive');
      return { doc: parsePayload(await r.text()), version: eTag };
    }
    async write(doc, version) {
      const headers = { 'Content-Type': 'application/json' };
      if (version) headers['If-Match'] = version;
      const url = `${ROOT}:/${FILE}:/content` + (version ? '' : '?@microsoft.graph.conflictBehavior=fail');
      const res = await this.api(url, { method: 'PUT', headers, body: payload(doc) });
      if (res.status === 412 || res.status === 409) throw new C.ConflictError();
      await ok(res, 'Saving to OneDrive');
    }
    async readBlob(h) {
      const r = await this.api(`${ROOT}:/${enc(`blobs/${h}.txt`)}:/content`);
      if (r.status === 404) return null;
      return (await ok(r, 'Downloading an attachment')).text();
    }
    async writeBlob(h, value) {
      await ok(await this.api(`${ROOT}:/${enc(`blobs/${h}.txt`)}:/content`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: value }), 'Saving an attachment');
    }
  }

  const providers = { google: new GoogleDrive(), microsoft: new OneDrive() };

  /** Sends the page to the provider's sign-in. silent = no prompt, used to renew. */
  async function startSignIn(type, { silent = false, scopes = [], purpose = 'sync', resume = null } = {}) {
    const p = providers[type];
    const { url, pending } = await p.authUrl(silent, scopes);
    ls.set(PENDING, { ...pending, provider: type, silent, purpose, resume, at: Date.now() });
    location.assign(url);
  }

  /** Finishes a sign-in when the page loads with the provider's answer in the URL. */
  async function handleRedirect() {
    const pending = ls.get(PENDING);
    if (!pending) return null;
    const params = new URLSearchParams(location.hash.slice(1));
    if (params.get('state') !== pending.state) {
      if (Date.now() - (pending.at || 0) > 10 * 60000) ls.set(PENDING, null);
      return null;
    }
    ls.set(PENDING, null);
    history.replaceState(null, '', location.pathname + location.search);
    const p = providers[pending.provider];
    const base = { provider: pending.provider, silent: pending.silent, purpose: pending.purpose || 'sync', resume: pending.resume || null };
    let result;
    if (params.get('error')) result = { ...base, ok: false, error: params.get('error_description') || params.get('error') };
    else {
      try { await p.complete(params, pending); result = { ...base, ok: true }; }
      catch (e) { result = { ...base, ok: false, error: e.message }; }
    }
    window.PDCloud.lastReturn = result;
    try { window.dispatchEvent(new CustomEvent('pd-auth-return', { detail: result })); } catch { /* old browsers */ }
    return result;
  }

  window.PDCloud = { providers, startSignIn, handleRedirect, redirectUri, clientId, setClientId: (type, v) => ls.set('pd.clientId.' + type, v ? String(v).trim() : null), NetError };
})();
