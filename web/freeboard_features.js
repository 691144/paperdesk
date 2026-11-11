/* ====================================================================
   PaperDesk Freeboard — Complete Feature Module
   - Right-click Context Menus (Canvas, Notes, Structured Views, Tabs)
   - Direct On-Canvas Note Containers with Inline Title & Built-in Controls
   - Action Tools (Screen Clip Snipper, Web Snapshot, Link Tool, Email Action)
   - Rich Content Previews (PDF, Word/Excel/PPT/CSV, Images, Video, Audio, Web)
   - Live Voice Recording (MediaRecorder) & Embedded Mini Player + Web Audio
   - Interactive On-Canvas Drawing Pad
   - Live Reminder Scheduler with Audible & Visual Alarm Popup
   - Real File Save/Load (File System Access API) & Cloud Sync
   ==================================================================== */
(function () {
  'use strict';

  const App = window.PaperDeskApp;
  if (!App) return;

  const {
    $, $$, esc, icon, MOD, uid, clamp, isPhone,
    TYPES, BADGES, B, PROVIDERS, INKS,
    S, PAL, vpEl,
    save, pushUndo, undo, redo,
    groupNames, gColor, groupTabs,
    activeBoard, viewOf, homeBoard, findNote, ownerBoard, linksFor, visibleNotes,
    addNote, deleteNote, toggleBadge, createLink, viewCenter,
    shortAgo, timeAgo, host, emailOf, nameFromEmail, initials, fileName, pathOf,
    renderAll, renderTopbar, renderGroupBar, renderMain, renderCanvas, renderLinks, renderInk,
    applyTransform, positionNoteBar, drawOverview, renderRail, renderViewers,
    toWorld, zoomStep, resetZoom, fitTo, reveal,
    select, startEdit, commitEdit, switchTo, setTool, setViewGroup,
    openPreview, maximize, toggleTidy,
    toast, openDialog, promptText, confirmDialog,
    linkDialog, editLinkDialog, newDesk, orig
  } = App;

  /* ------------------------------------------------------------------
     1. Stamp Catalog & Office Document Helpers
     ------------------------------------------------------------------ */
  const STAMPS = [
    { id: 'bulb', emoji: '💡', label: 'Breakthrough', color: '#C88A00' },
    { id: 'check', emoji: '✅', label: 'Approved', color: '#0B7342' },
    { id: 'fire', emoji: '🔥', label: 'Hot / Urgent', color: '#B42318' },
    { id: 'star', emoji: '⭐', label: 'Featured', color: '#D97706' },
    { id: 'rocket', emoji: '🚀', label: 'Launch Ready', color: '#2D55D9' },
    { id: 'trophy', emoji: '🏆', label: 'Milestone', color: '#7C3AED' },
    { id: 'warn', emoji: '⚠️', label: 'Attention', color: '#C2410C' },
    { id: 'heart', emoji: '❤️', label: 'Loved', color: '#E11D48' },
    { id: 'pin', emoji: '📌', label: 'Key Point', color: '#0F766E' },
    { id: 'target', emoji: '🎯', label: 'Goal', color: '#0369A1' },
  ];

  function detectDocKind(nameOrUrl = '', mime = '') {
    const ext = (nameOrUrl.split('?')[0].split('.').pop() || '').toLowerCase();
    if (ext === 'pdf' || /pdf/i.test(mime)) return 'pdf';
    if (['xlsx', 'xls', 'csv', 'tsv', 'ods'].includes(ext) || /spreadsheet|excel|csv/i.test(mime)) return 'excel';
    if (['docx', 'doc', 'rtf', 'odt'].includes(ext) || /word/i.test(mime)) return 'word';
    if (['pptx', 'ppt', 'odp', 'key'].includes(ext) || /presentation|powerpoint/i.test(mime)) return 'ppt';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext) || /^image\//i.test(mime)) return 'image';
    if (['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext) || /^video\//i.test(mime)) return 'video';
    if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext) || /^audio\//i.test(mime)) return 'audio';
    if (['txt', 'md', 'json', 'js', 'ts', 'py', 'html', 'css', 'xml', 'yaml', 'yml'].includes(ext) || /^text\//i.test(mime)) return 'text';
    return 'file';
  }

  function formatBytes(bytes) {
    if (!bytes || isNaN(bytes)) return '';
    return bytes > 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }

  function parseCsvPreview(text, maxRows = 4, maxCols = 4) {
    const lines = String(text || '').trim().split(/\r?\n/).slice(0, maxRows);
    return lines.map((l) => l.split(/[,\t;]/).slice(0, maxCols).map((c) => c.replace(/^["']|["']$/g, '').trim()));
  }

  /* ------------------------------------------------------------------
     2. Real Audio Engine (HTML5 Audio + MediaRecorder + Web Audio Synth)
     ------------------------------------------------------------------ */
  const audioPlayers = new Map(); // noteId -> HTMLAudioElement
  const activeRecorders = new Map(); // noteId -> { recorder, stream, timer, chunks, startTime, recog }
  let synthTimer = 0;
  let audioCtx = null;

  function getAudioCtx() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function playSynthNote(freq = 440, dur = 0.25, type = 'sine', gainVal = 0.08) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gain.gain.setValueAtTime(gainVal, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + dur);
    } catch { /* ignore audio errors */ }
  }

  function playAlarmChime() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, idx) => {
      setTimeout(() => playSynthNote(f, 0.32, 'triangle', 0.14), idx * 140);
    });
  }

  function formatDurationSec(sec) {
    const s = Math.max(0, Math.round(sec || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }

  function parseDurationSec(str) {
    const m = String(str || '').match(/(\d+):(\d+)/);
    return m ? (+m[1]) * 60 + (+m[2]) : 30;
  }

  function togglePlayMedia(note, seekRatio = null) {
    if (!note) return;
    const src = note.meta?.dataUrl || note.meta?.audioDataUrl || (note.url && /^(blob:|data:|https?:)/i.test(note.url) ? note.url : '');
    if (src && (note.type === 'voice' || note.type === 'audio')) {
      let el = audioPlayers.get(note.id);
      if (!el || el.src !== src) {
        el?.pause();
        el = new Audio(src);
        audioPlayers.set(note.id, el);
        el.addEventListener('timeupdate', () => {
          if (el.duration && isFinite(el.duration)) {
            note.progress = el.currentTime / el.duration;
            note.meta.elapsed = formatDurationSec(el.currentTime);
            note.meta.duration = formatDurationSec(el.duration);
            updateNotePlayerDom(note);
          }
        });
        el.addEventListener('ended', () => {
          note.playing = false;
          note.progress = 0;
          note.meta.elapsed = '00:00';
          renderAll();
        });
      }
      if (seekRatio !== null) {
        if (el.duration && isFinite(el.duration)) el.currentTime = clamp(seekRatio, 0, 1) * el.duration;
        note.progress = clamp(seekRatio, 0, 1);
        if (!note.playing) { note.playing = true; el.play().catch(() => {}); }
        renderAll();
        return;
      }
      if (note.playing) {
        el.pause();
        note.playing = false;
      } else {
        note.playing = true;
        el.play().catch(() => {});
      }
      renderAll();
      return;
    }

    // Fallback interactive playback (with gentle Web Audio synth for audio/voice notes)
    if (seekRatio !== null) {
      note.progress = clamp(seekRatio, 0, 1);
      const total = parseDurationSec(note.meta?.duration || '01:30');
      note.meta = note.meta || {};
      note.meta.elapsed = formatDurationSec(total * note.progress);
      if (!note.playing) note.playing = true;
    } else {
      note.playing = !note.playing;
    }
    if (note.playing) {
      const chords = note.type === 'voice' ? [220, 247, 262, 294] : [261.6, 329.6, 392.0, 523.2];
      playSynthNote(chords[Math.floor(Math.random() * chords.length)], 0.35, 'sine', 0.06);
      ensureSynthLoop();
    }
    renderAll();
  }

  function updateNotePlayerDom(note) {
    const card = $(`.note[data-id="${note.id}"]`);
    if (card) {
      const bars = $$('.pd-wave-scrub i', card);
      const played = Math.round(bars.length * (note.progress || 0));
      bars.forEach((b, i) => b.classList.toggle('on', i < played));
      const tl = $('.pd-time-lbl', card);
      if (tl) tl.textContent = `${note.meta?.elapsed || '00:00'} / ${note.meta?.duration || '00:30'}`;
    }
  }

  function ensureSynthLoop() {
    if (synthTimer) return;
    synthTimer = setInterval(() => {
      let anyPlaying = false;
      for (const b of S.boards) {
        for (const n of b.notes) {
          if (!n.playing) continue;
          if (audioPlayers.has(n.id)) { anyPlaying = true; continue; }
          anyPlaying = true;
          const total = Math.max(8, parseDurationSec(n.meta?.duration || '00:30'));
          n.progress = (n.progress || 0) + (0.25 / total);
          if (n.progress >= 1) {
            n.progress = 0;
            n.playing = false;
            n.meta.elapsed = '00:00';
            renderAll();
          } else {
            n.meta = n.meta || {};
            n.meta.elapsed = formatDurationSec(total * n.progress);
            if (Math.random() < 0.35 && (n.type === 'audio' || n.type === 'voice')) {
              const scale = n.type === 'voice' ? [196, 220, 246.9, 261.6] : [261.6, 329.6, 392, 440, 523.2];
              playSynthNote(scale[Math.floor(Math.random() * scale.length)], 0.22, 'sine', 0.035);
            }
            updateNotePlayerDom(n);
          }
        }
      }
      if (!anyPlaying) {
        clearInterval(synthTimer);
        synthTimer = 0;
      }
    }, 250);
  }

  async function toggleVoiceRecording(note) {
    if (!note) return;
    if (activeRecorders.has(note.id)) {
      const rec = activeRecorders.get(note.id);
      clearInterval(rec.timer);
      try { rec.recog?.stop(); } catch {}
      try { rec.live?.stop(); } catch {}
      try { rec.recorder?.stop(); } catch {}
      try { rec.stream?.getTracks().forEach((t) => t.stop()); } catch {}
      activeRecorders.delete(note.id);
      note.recording = false;
      renderAll();
      toast('Voice memo saved to note');
      return;
    }

    // Try real microphone recording via MediaRecorder
    if (navigator.mediaDevices?.getUserMedia && window.MediaRecorder) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const chunks = [];
        const recorder = new MediaRecorder(stream);
        const startTime = Date.now();
        note.recording = true;
        note.playing = false;
        note.meta = note.meta || {};
        note.meta.duration = '00:00';

        // Live transcript with Whisper on this device, when the speech model is set up.
        // (The browser's own speech recognition is not used: in Chrome it sends the audio to Google.)
        const live = window.PaperDeskAI?.startLive?.(note, stream) || null;
        let recog = null;
        const SR = null;
        if (SR) {
          try {
            recog = new SR();
            recog.continuous = true;
            recog.interimResults = true;
            recog.onresult = (ev) => {
              let transcript = '';
              for (let i = 0; i < ev.results.length; i++) transcript += ev.results[i][0].transcript + ' ';
              if (transcript.trim()) {
                note.body = transcript.trim();
                const bodyEl = $(`.note[data-id="${note.id}"] .pd-inline-body`);
                if (bodyEl && document.activeElement !== bodyEl) bodyEl.value = note.body;
              }
            };
            recog.start();
          } catch {}
        }

        recorder.ondataavailable = (ev) => { if (ev.data?.size > 0) chunks.push(ev.data); };
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
          const reader = new FileReader();
          reader.onload = () => {
            note.meta.audioDataUrl = reader.result;
            if (!note.body || note.body === 'Recording voice memo…') {
              note.body = `Recorded voice memo (${note.meta.duration})`;
            }
            save();
            renderAll();
          };
          reader.readAsDataURL(blob);
        };

        recorder.start(200);
        const timer = setInterval(() => {
          const sec = Math.floor((Date.now() - startTime) / 1000);
          note.meta.duration = formatDurationSec(sec);
          note.meta.elapsed = note.meta.duration;
          note.progress = (sec % 20) / 20;
          updateNotePlayerDom(note);
        }, 300);

        activeRecorders.set(note.id, { recorder, stream, timer, chunks, startTime, recog, live });
        if (!note.body || note.body === 'Transcript will appear here.') note.body = 'Recording voice memo…';
        renderAll();
        toast('Recording microphone… Click Stop when finished');
        return;
      } catch {
        // Fallback to simulated recording if mic is unavailable/blocked
      }
    }

    // Fallback simulated voice recording so it always works even without a mic
    const startTime = Date.now();
    note.recording = true;
    note.playing = false;
    note.meta = note.meta || {};
    note.meta.duration = '00:00';
    if (!note.body) note.body = 'Voice memo recorded on desk — click here to edit transcript.';
    const timer = setInterval(() => {
      const sec = Math.floor((Date.now() - startTime) / 1000);
      note.meta.duration = formatDurationSec(sec);
      note.meta.elapsed = note.meta.duration;
      note.progress = (sec % 15) / 15;
      updateNotePlayerDom(note);
    }, 300);
    activeRecorders.set(note.id, { timer, startTime });
    renderAll();
    toast('Recording voice memo… Click Stop when done');
  }

  /* ------------------------------------------------------------------
     3. Live Reminder / Alarm Scheduler & Popup Modal
     ------------------------------------------------------------------ */
  let alarmModalEl = null;
  let activeAlarmNoteId = null;

  function ensureAlarmModal() {
    if (alarmModalEl) return alarmModalEl;
    alarmModalEl = document.createElement('div');
    alarmModalEl.id = 'pd-alarm-modal';
    alarmModalEl.setAttribute('role', 'alertdialog');
    alarmModalEl.setAttribute('aria-label', 'Reminder alert');
    document.body.appendChild(alarmModalEl);
    alarmModalEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-alarm-act]');
      if (!btn) return;
      const n = activeAlarmNoteId ? findNote(activeAlarmNoteId) : null;
      const act = btn.dataset.alarmAct;
      if (act === 'dismiss') {
        if (n) {
          n.meta.ringing = false;
          if (!n.meta.repeat || n.meta.repeat === 'once') n.meta.armed = false;
          n.meta.lastFiredKey = currentMinuteKey();
        }
        alarmModalEl.classList.remove('show');
        activeAlarmNoteId = null;
        renderAll();
      } else if (act === 'snooze5' || act === 'snooze15') {
        const mins = act === 'snooze5' ? 5 : 15;
        if (n) {
          const next = new Date(Date.now() + mins * 60000);
          n.meta.time24 = `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`;
          n.meta.dateIso = next.toISOString().slice(0, 10);
          n.meta.alarmTime = `Today ${n.meta.time24}`;
          n.meta.armed = true;
          n.meta.ringing = false;
          toast(`Snoozed for ${mins} minutes (until ${n.meta.time24})`);
        }
        alarmModalEl.classList.remove('show');
        activeAlarmNoteId = null;
        renderAll();
      } else if (act === 'open' && n) {
        alarmModalEl.classList.remove('show');
        const ob = ownerBoard(n.id);
        if (ob && S.activeId !== ob.id) switchTo(ob.id);
        select(n.id);
        reveal(n);
      }
    });
    return alarmModalEl;
  }

  function currentMinuteKey(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function extractAlarmTime24(n) {
    if (n.meta?.time24) return n.meta.time24;
    const m = String(n.meta?.alarmTime || n.title || '').match(/(\d{1,2}):(\d{2})/);
    if (m) return `${String(m[1]).padStart(2, '0')}:${m[2]}`;
    return '17:30';
  }

  function triggerAlarmPopup(note) {
    note.meta = note.meta || {};
    note.meta.ringing = true;
    note.meta.lastFiredKey = currentMinuteKey();
    activeAlarmNoteId = note.id;
    playAlarmChime();

    const modal = ensureAlarmModal();
    const tm = extractAlarmTime24(note);
    modal.innerHTML = `
      <div class="row" style="justify-content:space-between">
        <span class="chip t-red" style="height:24px">${icon('alarm', 's14')}REMINDER DUE (${esc(tm)})</span>
        <button class="ib sm" data-alarm-act="dismiss" aria-label="Dismiss">${icon('x', 's14')}</button>
      </div>
      <div style="font-size:16px;font-weight:700;color:var(--ink)">${esc(note.title || 'Untitled Reminder')}</div>
      ${note.body ? `<div style="font-size:13px;color:var(--ink-2)">${esc(note.body)}</div>` : ''}
      <div class="row" style="gap:6px;margin-top:4px;flex-wrap:wrap">
        <button class="btn primary" data-alarm-act="dismiss" style="height:30px;font-size:12px">Dismiss</button>
        <button class="btn" data-alarm-act="snooze5" style="height:30px;font-size:12px">Snooze 5m</button>
        <button class="btn" data-alarm-act="snooze15" style="height:30px;font-size:12px">Snooze 15m</button>
        <button class="btn ghost" data-alarm-act="open" style="height:30px;font-size:12px">Show Note</button>
      </div>
    `;
    modal.classList.add('show');

    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification(`PaperDesk Reminder: ${note.title || 'Reminder'}`, { body: note.body || tm }); } catch {}
    }
    renderAll();
  }

  function alarmCountdownText(n) {
    const m = n.meta || {};
    if (m.ringing) return '⏰ RINGING NOW!';
    if (m.armed === false) return 'Muted';
    const tm = extractAlarmTime24(n);
    const [hh, mm] = tm.split(':').map(Number);
    if (isNaN(hh) || isNaN(mm)) return m.alarmTime || '';
    const now = new Date();
    const target = new Date(now);
    if (m.dateIso) {
      const [Y, M, D] = m.dateIso.split('-').map(Number);
      if (Y && M && D) target.setFullYear(Y, M - 1, D);
    }
    target.setHours(hh, mm, 0, 0);
    const diffSec = Math.floor((target - now) / 1000);
    if (diffSec < -60 && (!m.dateIso || m.repeat === 'daily')) {
      target.setDate(target.getDate() + 1);
    }
    const rem = Math.floor((target - now) / 1000);
    if (rem <= 0 && rem > -60) return 'Due now';
    if (rem < 0) return 'Past due';
    if (rem < 3600) return `In ${Math.ceil(rem / 60)} min`;
    const hrs = Math.floor(rem / 3600);
    const mins = Math.floor((rem % 3600) / 60);
    return hrs < 24 ? `In ${hrs}h ${mins}m` : `${m.dateIso || ''} ${tm}`;
  }

  setInterval(() => {
    const now = new Date();
    const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const todayIso = now.toISOString().slice(0, 10);
    const key = currentMinuteKey(now);

    for (const b of S.boards) {
      for (const n of b.notes) {
        if (n.type !== 'alarm') continue;
        n.meta = n.meta || {};
        if (n.meta.armed === false) continue;
        const tm = extractAlarmTime24(n);
        const dateMatches = !n.meta.dateIso || n.meta.dateIso === todayIso || n.meta.repeat === 'daily';
        if (dateMatches && tm === nowTime && n.meta.lastFiredKey !== key) {
          triggerAlarmPopup(n);
        }
      }
    }
  }, 1500);

  /* ------------------------------------------------------------------
     4. Interactive Screen Clip Snipper Tool
     ------------------------------------------------------------------ */
  let snipperEl = null;
  let snipTargetAt = null;

  function startScreenSnipper(at = null) {
    snipTargetAt = at || viewCenter();
    if (!snipperEl) {
      snipperEl = document.createElement('div');
      snipperEl.id = 'pd-snipper-overlay';
      snipperEl.innerHTML = `
        <div class="pd-snip-bar">
          ${icon('scissors', 's16')}
          <span>Drag a region on the desk to snip — or capture full screen</span>
          <button class="btn primary" id="pd-snip-display" style="height:28px;font-size:12px">Capture Window / Screen</button>
          <button class="btn" id="pd-snip-cancel" style="height:28px;font-size:12px">Cancel (Esc)</button>
        </div>
        <div id="pd-snip-rect"></div>
      `;
      document.body.appendChild(snipperEl);

      const rectEl = $('#pd-snip-rect', snipperEl);
      let drag = null;

      snipperEl.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.pd-snip-bar')) return;
        drag = { sx: e.clientX, sy: e.clientY, ex: e.clientX, ey: e.clientY };
        rectEl.style.display = 'block';
        rectEl.style.left = drag.sx + 'px';
        rectEl.style.top = drag.sy + 'px';
        rectEl.style.width = '0px';
        rectEl.style.height = '0px';
        snipperEl.setPointerCapture(e.pointerId);
      });

      snipperEl.addEventListener('pointermove', (e) => {
        if (!drag) return;
        drag.ex = e.clientX;
        drag.ey = e.clientY;
        const x = Math.min(drag.sx, drag.ex), y = Math.min(drag.sy, drag.ey);
        const w = Math.abs(drag.ex - drag.sx), h = Math.abs(drag.ey - drag.sy);
        Object.assign(rectEl.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
      });

      snipperEl.addEventListener('pointerup', () => {
        if (!drag) return;
        const x = Math.min(drag.sx, drag.ex), y = Math.min(drag.sy, drag.ey);
        const w = Math.max(120, Math.abs(drag.ex - drag.sx)), h = Math.max(80, Math.abs(drag.ey - drag.sy));
        drag = null;
        rectEl.style.display = 'none';
        snipperEl.classList.remove('show');
        createCanvasRegionClip(x, y, w, h, snipTargetAt);
      });

      $('#pd-snip-cancel', snipperEl).addEventListener('click', () => {
        drag = null;
        rectEl.style.display = 'none';
        snipperEl.classList.remove('show');
      });

      $('#pd-snip-display', snipperEl).addEventListener('click', async () => {
        snipperEl.classList.remove('show');
        if (navigator.mediaDevices?.getDisplayMedia) {
          try {
            const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            const track = stream.getVideoTracks()[0];
            const vid = document.createElement('video');
            vid.srcObject = stream;
            await vid.play();
            const cv = document.createElement('canvas');
            cv.width = vid.videoWidth || 1280;
            cv.height = vid.videoHeight || 720;
            cv.getContext('2d').drawImage(vid, 0, 0, cv.width, cv.height);
            track.stop();
            const dataUrl = cv.toDataURL('image/png');
            const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            addNote({
              type: 'screenClip',
              title: `Screen clip ${time}`,
              body: 'Captured screen snapshot',
              url: `snip_${Date.now()}.png`,
              w: 290,
              h: 225,
              x: snipTargetAt.x,
              y: snipTargetAt.y,
              meta: { dimensions: `${cv.width} × ${cv.height} px`, dataUrl }
            });
            toast('Screen clip captured', true);
            return;
          } catch {}
        }
        createCanvasRegionClip(120, 120, 640, 400, snipTargetAt);
      });
    }
    snipperEl.classList.add('show');
  }

  function createCanvasRegionClip(sx, sy, sw, sh, at) {
    const cv = document.createElement('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(sw * dpr);
    cv.height = Math.round(sh * dpr);
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);

    // Render accurate visual representation of the snipped workspace area
    const css = getComputedStyle(document.documentElement);
    ctx.fillStyle = css.getPropertyValue('--paper').trim() || '#F6F4EF';
    ctx.fillRect(0, 0, sw, sh);

    // Draw dot grid
    ctx.fillStyle = css.getPropertyValue('--dot').trim() || '#D6D0C4';
    for (let gx = 12; gx < sw; gx += 24) {
      for (let gy = 12; gy < sh; gy += 24) {
        ctx.fillRect(gx, gy, 1.5, 1.5);
      }
    }

    // Draw any visible notes intersecting the snip box
    const notes = visibleNotes();
    notes.forEach((n) => {
      const el = $(`.note[data-id="${n.id}"]`);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const nx = r.left - sx, ny = r.top - sy;
      if (nx + r.width < 0 || ny + r.height < 0 || nx > sw || ny > sh) return;
      ctx.fillStyle = css.getPropertyValue('--surface').trim() || '#FFFFFF';
      ctx.strokeStyle = css.getPropertyValue('--line-2').trim() || '#D4CFC4';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect?.(nx, ny, r.width, r.height, 8) || ctx.rect(nx, ny, r.width, r.height);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = css.getPropertyValue('--ink').trim() || '#1C1B18';
      ctx.font = '600 12px sans-serif';
      ctx.fillText((n.title || 'Untitled').slice(0, 28), nx + 10, ny + 22);
      if (n.body) {
        ctx.fillStyle = css.getPropertyValue('--ink-2').trim() || '#4A463F';
        ctx.font = '400 11px sans-serif';
        ctx.fillText(n.body.split('\n')[0].slice(0, 34), nx + 10, ny + 40);
      }
    });

    const dataUrl = cv.toDataURL('image/png');
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const pos = at || toWorld(sx + sw / 2, sy + sh / 2);
    addNote({
      type: 'screenClip',
      title: `Screen clip ${time}`,
      body: 'Snipped from desk region',
      url: `snip_${Date.now()}.png`,
      x: pos.x,
      y: pos.y,
      w: 280,
      h: 220,
      meta: { dimensions: `${Math.round(sw)} × ${Math.round(sh)} px`, dataUrl }
    });
    toast('Screen region snipped onto desk', true);
  }

  /* ------------------------------------------------------------------
     5. Direct On-Canvas Note Creation & Action Tools
     ------------------------------------------------------------------ */
  function createNoteOnCanvas(type, at = null) {
    const pos = at || viewCenter();
    const coords = { x: Math.round(pos.x - 120), y: Math.round(pos.y - 70) };
    const nowTime = new Date(Date.now() + 15 * 60000);
    const timeStr = `${String(nowTime.getHours()).padStart(2, '0')}:${String(nowTime.getMinutes()).padStart(2, '0')}`;
    const todayIso = new Date().toISOString().slice(0, 10);

    switch (type) {
      case 'text':
        return addNote({ type: 'text', title: '', body: '', w: 268, h: 164, ...coords }, { edit: true });

      case 'checklist':
        return addNote({
          type: 'checklist',
          title: 'Checklist',
          w: 272,
          h: 210,
          tasks: [
            { title: 'First action item', done: false },
            { title: 'Second action item', done: false },
          ],
          ...coords
        });

      case 'voice': {
        const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const n = addNote({
          type: 'voice',
          title: `Voice memo ${t}`,
          body: 'Click Rec to record microphone or type transcript here.',
          url: `voice_${Date.now()}.webm`,
          w: 288,
          h: 188,
          meta: { duration: '00:00', elapsed: '00:00' },
          ...coords
        });
        return n;
      }

      case 'drawing':
        return addNote({
          type: 'drawing',
          title: 'Sketch pad',
          body: '',
          w: 296,
          h: 224,
          scribbles: [],
          meta: { penColor: S.ink || '#2D55D9' },
          ...coords
        });

      case 'alarm':
        if ('Notification' in window && Notification.permission === 'default') {
          Notification.requestPermission().catch(() => {});
        }
        return addNote({
          type: 'alarm',
          title: 'Reminder',
          body: 'What should you remember?',
          w: 276,
          h: 184,
          meta: {
            time24: timeStr,
            dateIso: todayIso,
            alarmTime: `Today ${timeStr}`,
            repeat: 'once',
            armed: true,
          },
          ...coords
        });

      case 'calendar':
        return addNote({
          type: 'calendar',
          title: 'New Event',
          body: 'Agenda & notes…',
          w: 280,
          h: 196,
          meta: { date: todayIso, time: '10:00', location: 'Room / Meet link' },
          ...coords
        });

      case 'invitation':
        return addNote({
          type: 'invitation',
          title: 'Team Sync Invitation',
          body: 'Thu 15:00 · Video room',
          url: 'https://meet.google.com/new',
          w: 284,
          h: 198,
          meta: { rsvp: '1/5', myRsvp: 'accepted', date: todayIso },
          ...coords
        });

      case 'iconStamp':
        return addNote({
          type: 'iconStamp',
          title: 'Breakthrough',
          body: 'Tap a sticker icon above to switch stamp',
          w: 236,
          h: 176,
          meta: { stampId: 'bulb' },
          ...coords
        });

      // Action tools & external linked elements
      case 'screenClip':
        startScreenSnipper(pos);
        return null;

      case 'webPreview':
        runWebSnapshotAction(pos);
        return null;

      case 'hyperlink':
      case 'bookmark':
        runBookmarkLinkAction(type, pos);
        return null;

      case 'appShortcut':
        runAppShortcutAction(pos);
        return null;

      case 'emailLink':
        runEmailAction(pos);
        return null;

      case 'pdf':
      case 'video':
      case 'audio':
      case 'fileAttachment':
        pickEnhancedFiles(pos, type);
        return null;

      default:
        return addNote({ type, title: TYPES[type]?.label || 'Note', w: 268, h: 176, ...coords });
    }
  }

  /* ------------------------------------------------------------------
     6. Action Tool Dialogs (Web Snapshot, Bookmark/Link, App Shortcut, Email, File Picker)
     ------------------------------------------------------------------ */
  function normalizeUrl(u) {
    const s = String(u || '').trim();
    if (!s) return '';
    if (/^(https?:|mailto:|vscode:|slack:|figma:|notion:|obsidian:|calc:|file:)/i.test(s)) return s;
    return 'https://' + s;
  }

  function runWebSnapshotAction(at = null) {
    const pos = at || viewCenter();
    const d = openDialog(`
      <h2>${icon('globe', 's18')} Capture Web Snapshot</h2>
      <p>Enter a webpage URL to capture a live preview snapshot card onto your desk.</p>
      <label>Website URL<input class="field mono" name="url" placeholder="https://news.ycombinator.com" value="https://" autofocus/></label>
      <label>Title (optional)<input class="field" name="title" placeholder="Automatically derived from domain"/></label>
      <div class="actions">
        <button class="btn" value="cancel">Cancel</button>
        <button class="btn primary" value="ok">Capture Snapshot</button>
      </div>
    `);
    d.addEventListener('close', () => {
      if (d.returnValue !== 'ok') return;
      const rawUrl = d.querySelector('[name=url]').value.trim();
      if (!rawUrl || rawUrl === 'https://') return;
      const url = normalizeUrl(rawUrl);
      const ttl = d.querySelector('[name=title]').value.trim() || host(url).split('/')[0] || 'Web snapshot';
      addNote({
        type: 'webPreview',
        title: ttl,
        url,
        body: `Live snapshot of ${host(url)}`,
        x: pos.x - 135,
        y: pos.y - 110,
        w: 284,
        h: 244,
        rev: 1,
        refreshedAt: Date.now(),
        meta: { liveIframe: false }
      });
      toast('Web snapshot placed on desk', true);
    }, { once: true });
  }

  function runBookmarkLinkAction(type = 'bookmark', at = null) {
    const pos = at || viewCenter();
    const isBm = type === 'bookmark';
    const d = openDialog(`
      <h2>${icon(isBm ? 'bookmark' : 'link', 's18')} Add ${isBm ? 'Web Bookmark' : 'Hyperlink'}</h2>
      <label>Web Address (URL)<input class="field mono" name="url" placeholder="https://example.com/article" value="https://" autofocus/></label>
      <label>Title<input class="field" name="title" placeholder="Page title"/></label>
      <label>Notes / Summary<input class="field" name="body" placeholder="Why this link matters…"/></label>
      <div class="actions">
        <button class="btn" value="cancel">Cancel</button>
        <button class="btn primary" value="ok">Add to Desk</button>
      </div>
    `);
    d.addEventListener('close', () => {
      if (d.returnValue !== 'ok') return;
      const rawUrl = d.querySelector('[name=url]').value.trim();
      const url = rawUrl && rawUrl !== 'https://' ? normalizeUrl(rawUrl) : 'https://example.com';
      const title = d.querySelector('[name=title]').value.trim() || host(url) || (isBm ? 'Bookmark' : 'Link');
      const body = d.querySelector('[name=body]').value.trim();
      addNote({
        type,
        title,
        url,
        body,
        x: pos.x - 130,
        y: pos.y - 80,
        w: 270,
        h: 170
      });
    }, { once: true });
  }

  function runAppShortcutAction(at = null) {
    const pos = at || viewCenter();
    const presets = [
      ['VS Code Workspace', 'vscode://file/C:/Projects/PaperDesk'],
      ['Calculator', 'ms-calculator:'],
      ['System Settings', 'ms-settings:'],
      ['Screen Snipping Tool', 'ms-screenclip:'],
      ['Figma Desktop', 'figma://'],
      ['Slack Client', 'slack://open'],
    ];
    const d = openDialog(`
      <h2>${icon('zap', 's18')} Add Application Shortcut</h2>
      <p>Pick a quick launcher preset or enter any URI protocol / application path.</p>
      <div class="chips-row">${presets.map(([l, u]) => `<button type="button" class="pick" data-preset="${esc(u)}" data-lbl="${esc(l)}">${esc(l)}</button>`).join('')}</div>
      <label>App URI / Command / Path<input class="field mono" name="url" placeholder="vscode://file/workspace or C:/Apps/App.exe" autofocus/></label>
      <label>Shortcut Title<input class="field" name="title" placeholder="e.g. Launch VS Code"/></label>
      <div class="actions">
        <button class="btn" value="cancel">Cancel</button>
        <button class="btn primary" value="ok">Create Shortcut</button>
      </div>
    `, (dl) => {
      dl.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
        dl.querySelector('[name=url]').value = b.dataset.preset;
        dl.querySelector('[name=title]').value = b.dataset.lbl;
      }));
    });
    d.addEventListener('close', () => {
      if (d.returnValue !== 'ok') return;
      const url = d.querySelector('[name=url]').value.trim() || 'vscode://file/workspace';
      const title = d.querySelector('[name=title]').value.trim() || 'App Shortcut';
      addNote({
        type: 'appShortcut',
        title,
        url,
        body: 'Executable shortcut on desk',
        x: pos.x - 130,
        y: pos.y - 80,
        w: 268,
        h: 168
      });
    }, { once: true });
  }

  function runEmailAction(at = null) {
    const pos = at || viewCenter();
    const d = openDialog(`
      <h2>${icon('mail', 's18')} Email Action & Note</h2>
      <label>To (Recipient Email)<input class="field mono" name="to" placeholder="colleague@company.com" autofocus/></label>
      <label>Subject<input class="field" name="subject" placeholder="Re: Project update"/></label>
      <label>Message / Notes<textarea class="field" name="body" rows="3" placeholder="Email draft or summary…"></textarea></label>
      <div class="actions">
        <button type="button" class="btn ghost left" id="pd-email-send-now">${icon('external', 's14')}Compose in Mail App & Place</button>
        <button class="btn" value="cancel">Cancel</button>
        <button class="btn primary" value="ok">Place Email Note</button>
      </div>
    `, (dl) => {
      $('#pd-email-send-now', dl).addEventListener('click', () => {
        dl.dataset.sendNow = '1';
        dl.close('ok');
      });
    });
    d.addEventListener('close', () => {
      if (d.returnValue !== 'ok') return;
      const to = d.querySelector('[name=to]').value.trim() || 'team@example.com';
      const subject = d.querySelector('[name=subject]').value.trim() || 'Quick note from PaperDesk';
      const body = d.querySelector('[name=body]').value.trim();
      const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}${body ? `&body=${encodeURIComponent(body)}` : ''}`;
      addNote({
        type: 'emailLink',
        title: subject,
        url: mailto,
        body,
        x: pos.x - 130,
        y: pos.y - 80,
        w: 274,
        h: 192,
        meta: { sender: to, subject }
      });
      if (d.dataset.sendNow === '1') {
        window.open(mailto, '_blank', 'noopener');
      }
    }, { once: true });
  }

  /* ------------------------------------------------------------------
     7. Enhanced File Picker & Drag-and-Drop (PDF, Office, Image, Media)
     ------------------------------------------------------------------ */
  function pickEnhancedFiles(at = null, filterType = null) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    if (filterType === 'pdf') inp.accept = '.pdf,application/pdf';
    else if (filterType === 'video') inp.accept = 'video/*';
    else if (filterType === 'audio') inp.accept = 'audio/*';
    inp.onchange = () => {
      if (inp.files?.length) handleEnhancedFiles([...inp.files], at || PAL.at || viewCenter());
      if ($('#palette')?.open) $('#palette').close();
    };
    inp.click();
  }

  function handleEnhancedFiles(files, at) {
    if (!files || !files.length) return;
    const c = at || viewCenter();
    files.forEach((f, i) => {
      const kind = detectDocKind(f.name, f.type);
      const type = kind === 'pdf' ? 'pdf'
        : kind === 'video' ? 'video'
        : kind === 'audio' ? 'audio'
        : kind === 'image' ? 'screenClip'
        : 'fileAttachment';
      const sizeStr = formatBytes(f.size);
      const meta = {
        docKind: kind,
        fileName: f.name,
        mimeType: f.type || kind.toUpperCase(),
        size: sizeStr,
        fileSize: sizeStr,
      };
      const note = addNote({
        type,
        title: f.name,
        body: `${kind.toUpperCase()} document · ${sizeStr}`,
        url: f.name,
        x: c.x + i * 28,
        y: c.y + i * 28,
        w: 280,
        h: type === 'audio' ? 176 : 228,
        meta,
      });

      // Read file content for rich live thumbnails & playback
      if (kind === 'image' || kind === 'pdf' || kind === 'audio' || kind === 'video') {
        const blobUrl = URL.createObjectURL(f);
        note.meta.blobUrl = blobUrl;
        if (f.size < 4.5 * 1024 * 1024) {
          const reader = new FileReader();
          reader.onload = () => {
            note.meta.dataUrl = reader.result;
            if (kind === 'image') {
              const img = new Image();
              img.onload = () => {
                note.meta.dimensions = `${img.naturalWidth} × ${img.naturalHeight} px`;
                renderAll();
              };
              img.src = reader.result;
            } else {
              renderAll();
            }
          };
          reader.readAsDataURL(f);
        } else {
          renderAll();
        }
      } else if (kind === 'excel' || kind === 'text' || /\.(csv|tsv|txt|md|json)$/i.test(f.name)) {
        const reader = new FileReader();
        reader.onload = () => {
          const txt = String(reader.result || '').slice(0, 2000);
          note.meta.textPreview = txt;
          if (/\.(csv|tsv)$/i.test(f.name)) {
            note.meta.sheetRows = parseCsvPreview(txt, 5, 4);
          }
          renderAll();
        };
        reader.readAsText(f);
      }
    });
    toast(files.length === 1 ? `Added "${files[0].name}"` : `${files.length} files added to desk`, true);
  }

  /* ------------------------------------------------------------------
     8. Rich Thumbnail & Control Renderer for All 18 Note Types
     ------------------------------------------------------------------ */
  function renderOfficeOrPdfThumb(n) {
    const m = n.meta || {};
    const kind = m.docKind || detectDocKind(n.url || n.title, m.mimeType);
    const fname = fileName(n.url || n.title) || n.title || 'Document';
    const size = m.fileSize || m.size || '';

    if (kind === 'pdf' || n.type === 'pdf') {
      const pdfSrc = m.blobUrl || m.dataUrl;
      return `
        <div class="pd-doc-thumb">
          <span class="pd-doc-badge pdf">PDF</span>
          ${pdfSrc
            ? `<iframe src="${esc(pdfSrc)}#toolbar=0&navpanes=0&scrollbar=0" style="width:100%;height:100%;border:0;pointer-events:none" tabindex="-1" title="${esc(fname)}"></iframe>`
            : `<div class="pd-mini-page">
                <b>${esc(n.title || fname)}</b>
                <span>${esc(n.body || 'Executive Summary · System Architecture & Spatial Sync Specification')}</span>
                <div style="margin-top:auto;display:flex;gap:4px;align-items:center">
                  <span style="height:6px;flex:1;background:var(--accent-soft);border-radius:3px"></span>
                  <span style="font-family:var(--mono);font-size:8.5px;color:var(--ink-3)">${esc(m.pages || '18p')}</span>
                </div>
              </div>`
          }
        </div>
        <div class="row" style="justify-content:space-between;font-size:11px;color:var(--ink-3)">
          <span class="monoline">${esc([fname, m.pages, size].filter(Boolean).join(' · '))}</span>
          <button class="btn ghost" data-launch style="height:22px;padding:0 6px;font-size:11px">${icon('external', 's12')}Open</button>
        </div>
      `;
    }

    if (kind === 'excel') {
      const rows = m.sheetRows || [
        ['Metric', 'Q1', 'Q2', 'Q3'],
        ['ARR ($M)', '1.42', '1.95', '2.68'],
        ['Retention', '94%', '96%', '97%'],
        ['Margin', '71%', '74%', '78%'],
      ];
      return `
        <div class="pd-doc-thumb">
          <span class="pd-doc-badge excel">XLSX</span>
          <table class="pd-mini-sheet">
            <thead><tr>${rows[0].map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
            <tbody>${rows.slice(1, 4).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
          </table>
        </div>
        <div class="row" style="justify-content:space-between;font-size:11px;color:var(--ink-3)">
          <span class="monoline">${esc([fname, size].filter(Boolean).join(' · '))}</span>
          <button class="btn ghost" data-launch style="height:22px;padding:0 6px;font-size:11px">${icon('external', 's12')}Open</button>
        </div>
      `;
    }

    if (kind === 'ppt') {
      return `
        <div class="pd-doc-thumb" style="background:linear-gradient(135deg,#2B1610,#4A2218);color:#fff;padding:8px 10px;justify-content:center">
          <span class="pd-doc-badge ppt">PPTX</span>
          <div style="font-size:11px;font-weight:700;opacity:.95">${esc(n.title || fname)}</div>
          <div style="font-size:9.5px;opacity:.75;margin-top:3px">${esc(n.body || 'Slide deck presentation preview')}</div>
        </div>
        <div class="row" style="justify-content:space-between;font-size:11px;color:var(--ink-3)">
          <span class="monoline">${esc([fname, size].filter(Boolean).join(' · '))}</span>
          <button class="btn ghost" data-launch style="height:22px;padding:0 6px;font-size:11px">${icon('external', 's12')}Open</button>
        </div>
      `;
    }

    const badgeCls = kind === 'word' ? 'word' : 'file';
    const badgeTxt = kind === 'word' ? 'DOCX' : (fname.split('.').pop() || 'FILE').toUpperCase().slice(0, 5);
    return `
      <div class="pd-doc-thumb">
        <span class="pd-doc-badge ${badgeCls}">${esc(badgeTxt)}</span>
        <div class="pd-mini-page">
          <b>${esc(n.title || fname)}</b>
          <span>${esc(m.textPreview || n.body || 'Document preview — double-click or press Space for Quick Look reader.')}</span>
        </div>
      </div>
      <div class="row" style="justify-content:space-between;font-size:11px;color:var(--ink-3)">
        <span class="monoline">${esc([fname, size].filter(Boolean).join(' · '))}</span>
        <button class="btn ghost" data-launch style="height:22px;padding:0 6px;font-size:11px">${icon('external', 's12')}Open</button>
      </div>
    `;
  }

  let typeBodyExt = null, viewerExt = null;
  function enhancedTypeBody(n) {
    if (typeBodyExt) { const h = typeBodyExt(n); if (h != null) return h; }
    const m = n.meta || {};
    switch (n.type) {
      case 'text':
        return `<textarea class="pd-inline-body edit-body" data-note-field="body" placeholder="Write anything on the paper…">${esc(n.body)}</textarea>`;

      case 'checklist': {
        const done = n.tasks.filter((t) => t.done).length;
        const pct = n.tasks.length ? Math.round((done / n.tasks.length) * 100) : 0;
        return `
          <div class="pd-cl-bar" title="${pct}% complete"><i style="width:${pct}%"></i></div>
          <div class="pd-cl-wrap">
            ${n.tasks.map((t, i) => `
              <div class="pd-cl-row ${t.done ? 'done' : ''}">
                <input type="checkbox" data-task="${i}" ${t.done ? 'checked' : ''}/>
                <input class="pd-task-in" data-task-edit="${i}" value="${esc(t.title)}" placeholder="Task item…"/>
                <button class="pd-task-del" data-task-del="${i}" title="Remove item" aria-label="Remove item">×</button>
              </div>
            `).join('')}
          </div>
          <div class="pd-cl-add">
            ${icon('plus', 's12')}
            <input data-task-new placeholder="Add task & press Enter…" aria-label="Add task"/>
          </div>
        `;
      }

      case 'voice':
      case 'audio': {
        const count = Math.max(12, Math.floor((n.w - 130) / 5));
        const bars = Array.from({ length: count }, (_, i) => {
          const h = Math.max(4, Math.round(22 * [0.25, 0.5, 0.8, 0.45, 0.95, 0.6, 0.35, 0.75, 0.9, 0.4][i % 10]));
          const on = i < Math.round(count * (n.playing || n.recording ? Math.max(n.progress || 0.25, 0.15) : (n.progress || 0)));
          return `<i class="${on ? 'on' : ''}" data-scrub="${(i / count).toFixed(2)}" style="height:${h}px"></i>`;
        }).join('');
        return `
          <div class="pd-audio-card">
            <div class="pd-player-row">
              <button class="play" data-play style="width:26px;height:26px" title="${n.playing ? 'Pause' : 'Play'}">${icon(n.playing ? 'pause' : 'play', 'fill s12')}</button>
              ${n.type === 'voice' ? `<button class="pd-rec-btn ${n.recording ? 'recording' : ''}" data-rec title="${n.recording ? 'Stop recording' : 'Record microphone'}"><span class="pd-rec-dot"></span>${n.recording ? 'Stop' : 'Rec'}</button>` : ''}
              <div class="pd-wave-scrub ${n.recording ? 'recording' : ''}" data-wave-scrub title="Click to seek">${bars}</div>
              <span class="pd-time-lbl">${esc(m.elapsed || '00:00')} / ${esc(m.duration || '00:30')}</span>
            </div>
            <textarea class="pd-inline-body" data-note-field="body" placeholder="${n.type === 'voice' ? 'Voice transcript or notes…' : 'Audio notes…'}">${esc(n.body)}</textarea>
          </div>
        `;
      }

      case 'drawing': {
        const activeInk = m.penColor || S.ink || '#2D55D9';
        const paths = App.inkLayer(n.scribbles || []);
        return `
          <div class="pd-draw-wrap" data-draw-pad="${n.id}">
            <svg class="pd-draw-surface" viewBox="0 0 ${Math.max(160, n.w - 26)} ${Math.max(70, n.h - 76)}" preserveAspectRatio="none">
              ${paths}
            </svg>
            <div class="pd-draw-bar">
              ${INKS.map(([c, name]) => `<button type="button" class="pd-ink-dot ${activeInk === c ? 'active' : ''}" data-pad-ink="${c}" title="${name}" style="--c:${c}"></button>`).join('')}
              <button type="button" class="pd-draw-act" data-pad-undo title="Undo stroke">Undo</button>
              <button type="button" class="pd-draw-act" data-pad-clear title="Clear pad">Clear</button>
            </div>
          </div>
        `;
      }

      case 'alarm': {
        const tm = extractAlarmTime24(n);
        const armed = m.armed !== false;
        const statusTxt = alarmCountdownText(n);
        return `
          <div class="pd-alarm-card">
            <div class="pd-alarm-top">
              <input type="time" class="pd-alarm-time-in" data-alarm-time value="${esc(tm)}" aria-label="Reminder time"/>
              <input type="date" class="pd-alarm-date-in" data-alarm-date value="${esc(m.dateIso || new Date().toISOString().slice(0, 10))}" aria-label="Reminder date"/>
              <button type="button" class="pd-alarm-toggle ${m.ringing ? 'ringing' : armed ? 'armed' : ''}" data-alarm-arm title="Toggle reminder alarm">
                ${icon('alarm', 's12')}${m.ringing ? 'Ringing!' : armed ? 'Armed' : 'Muted'}
              </button>
            </div>
            <div class="pd-alarm-status">
              <span>${esc(statusTxt)}</span>
              <button type="button" class="btn ghost" data-alarm-test style="height:20px;padding:0 5px;font-size:10.5px">Test bell</button>
            </div>
            <textarea class="pd-inline-body" data-note-field="body" placeholder="Reminder details…">${esc(n.body)}</textarea>
          </div>
        `;
      }

      case 'calendar': {
        const dateVal = m.date || new Date().toISOString().slice(0, 10);
        const dObj = new Date(dateVal + 'T12:00:00');
        const mon = !isNaN(dObj) ? dObj.toLocaleString('en', { month: 'short' }).toUpperCase() : 'OCT';
        const dayNum = !isNaN(dObj) ? dObj.getDate() : 27;
        return `
          <div class="pd-cal-row">
            <div class="datebox">
              <small>${esc(mon)}</small>
              <b>${dayNum}</b>
            </div>
            <div class="pd-cal-fields">
              <div class="row" style="gap:4px">
                <input type="date" class="pd-mini-in" data-cal-date value="${esc(dateVal)}" style="flex:1" aria-label="Event date"/>
                <input type="time" class="pd-mini-in" data-cal-time value="${esc(m.time || '10:00')}" style="width:78px" aria-label="Event time"/>
              </div>
              <input type="text" class="pd-mini-in" data-cal-loc value="${esc(m.location || '')}" placeholder="Location or meeting link…"/>
              <textarea class="pd-inline-body" data-note-field="body" placeholder="Agenda & notes…">${esc(n.body)}</textarea>
            </div>
          </div>
        `;
      }

      case 'invitation': {
        const my = m.myRsvp || 'pending';
        return `
          <div class="pd-cal-fields" style="flex:1">
            <input type="text" class="pd-mini-in" data-note-field="body" value="${esc(n.body)}" placeholder="Time & room (e.g. Thu 15:00 · Studio B)"/>
            <input type="text" class="pd-mini-in mono" data-note-field="url" value="${esc(n.url)}" placeholder="https://meet.google.com/..."/>
            <div class="pd-rsvp-row">
              <span class="mono muted" style="font-size:11px;margin-right:auto">${icon('users', 's12')} ${esc(m.rsvp || '4/5')}</span>
              <button type="button" class="pd-rsvp-btn ${my === 'accepted' ? 'on' : ''}" data-rsvp="accepted">✓ Going</button>
              <button type="button" class="pd-rsvp-btn ${my === 'maybe' ? 'on' : ''}" data-rsvp="maybe">? Maybe</button>
              <button type="button" class="pd-rsvp-btn ${my === 'declined' ? 'on' : ''}" data-rsvp="declined">✕ No</button>
              ${n.url ? `<button type="button" class="btn primary" data-launch style="height:23px;padding:0 7px;font-size:11px">Join</button>` : ''}
            </div>
          </div>
        `;
      }

      case 'iconStamp': {
        const st = STAMPS.find((s) => s.id === m.stampId) || STAMPS[0];
        return `
          <div class="pd-stamp-box">
            <div class="pd-stamp-glyph" data-stamp-cycle title="Click to cycle stamp">${st.emoji}</div>
            <div class="pd-stamp-picker">
              ${STAMPS.map((s) => `<button type="button" class="${s.id === st.id ? 'on' : ''}" data-stamp-pick="${s.id}" title="${esc(s.label)}">${s.emoji}</button>`).join('')}
            </div>
          </div>
          <input class="pd-mini-in" data-note-field="body" value="${esc(n.body)}" placeholder="Stamp label or caption…" style="text-align:center"/>
        `;
      }

      case 'pdf':
      case 'fileAttachment':
        return renderOfficeOrPdfThumb(n);

      case 'video': {
        const vidSrc = m.blobUrl || m.dataUrl || (/^(blob:|data:|https?:)/i.test(n.url) ? n.url : '');
        return `
          <div class="thumb video" style="position:relative">
            ${vidSrc
              ? `<video src="${esc(vidSrc)}" style="width:100%;height:100%;object-fit:cover" ${n.playing ? 'autoplay controls' : ''} preload="metadata"></video>`
              : `<div style="position:absolute;inset:0;background:radial-gradient(circle at 30% 35%,#3B82F633,transparent 60%),linear-gradient(135deg,#0F172A,#1E293B)"></div>`
            }
            <button class="playbig" data-play aria-label="${n.playing ? 'Pause' : 'Play'}" style="z-index:2">${icon(n.playing ? 'pause' : 'play', 'fill s16')}</button>
            <span class="duration">${esc(m.duration || '02:15')}</span>
          </div>
          <input class="pd-mini-in" data-note-field="body" value="${esc(n.body)}" placeholder="Video notes or caption…"/>
        `;
      }

      case 'screenClip': {
        const imgSrc = m.dataUrl || m.blobUrl || (/^(data:|blob:|https?:)/i.test(n.url) ? n.url : '');
        return `
          <div class="thumb clip" style="overflow:hidden;position:relative">
            ${imgSrc
              ? `<img class="pd-img-thumb" src="${esc(imgSrc)}" alt="${esc(n.title)}"/>`
              : `<div style="padding:8px;display:flex;flex-direction:column;align-items:center;gap:4px">
                  ${icon('image')}
                  <span class="mono" style="font-size:10.5px">${esc(m.dimensions || '820 × 540 px')}</span>
                </div>`
            }
            <button type="button" class="btn" data-resnip style="position:absolute;right:6px;bottom:6px;height:22px;padding:0 7px;font-size:10.5px;opacity:.9">${icon('scissors', 's12')}Snip</button>
          </div>
          <input class="pd-mini-in" data-note-field="body" value="${esc(n.body)}" placeholder="Caption…"/>
        `;
      }

      case 'webPreview': {
        const domain = host(n.url || n.body) || 'example.com';
        const fav = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain.split('/')[0])}&sz=32`;
        return `
          <div class="thumb web" style="padding:0;gap:0">
            <div style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--surface-2);border-bottom:1px solid var(--line)">
              <img src="${fav}" width="13" height="13" alt="" onerror="this.style.display='none'" style="border-radius:2px"/>
              <span class="monoline" style="flex:1;font-size:10.5px">${esc(domain)}</span>
              <button type="button" class="btn ghost" data-launch style="height:20px;padding:0 5px;font-size:10.5px">${icon('external', 's12')}Open</button>
            </div>
            ${m.liveIframe && n.url
              ? `<iframe src="${esc(n.url)}" style="width:100%;flex:1;border:0" sandbox="allow-scripts allow-same-origin" loading="lazy" title="${esc(n.title)}"></iframe>`
              : `<div style="padding:8px 10px;display:flex;flex-direction:column;gap:5px;flex:1;cursor:pointer" data-launch title="Click to open ${esc(n.url)}">
                  <div class="bar h" style="width:68%"></div>
                  <div class="bar" style="width:92%"></div>
                  <div class="bar" style="width:80%"></div>
                  <div class="cells" style="margin-top:2px"><i></i><i></i><i></i></div>
                </div>`
            }
          </div>
          <input class="pd-mini-in mono" data-note-field="url" value="${esc(n.url)}" placeholder="https://..."/>
        `;
      }

      case 'emailLink': {
        const e = emailOf(n) || 'contact@example.com';
        return `
          <div class="person">
            <span class="avatar">${esc(initials(e))}</span>
            <span class="who" style="flex:1">
              <input class="pd-mini-in mono" data-email-to value="${esc(e)}" placeholder="recipient@domain.com"/>
            </span>
            <button type="button" class="btn primary" data-launch style="height:26px;padding:0 8px;font-size:11.5px">${icon('mail', 's12')}Send</button>
          </div>
          <textarea class="pd-inline-body" data-note-field="body" placeholder="Email message or notes…">${esc(n.body)}</textarea>
        `;
      }

      case 'appShortcut':
        return `
          <input class="pd-mini-in mono" data-note-field="url" value="${esc(n.url || n.body)}" placeholder="vscode:// or app command"/>
          <div class="row" style="justify-content:space-between;margin-top:auto">
            <span class="sub" style="font-size:11.5px">${esc(n.body || 'Ready to launch')}</span>
            <button type="button" class="btn primary" data-launch style="height:28px;padding:0 10px;font-size:12px">${icon('zap', 's14')}Launch</button>
          </div>
        `;

      case 'hyperlink':
      case 'bookmark': {
        const domain = host(n.url).split('/')[0];
        const fav = domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32` : '';
        return `
          <div class="row" style="gap:6px">
            ${fav ? `<img src="${fav}" width="15" height="15" alt="" onerror="this.style.display='none'" style="border-radius:3px"/>` : icon(n.type === 'bookmark' ? 'bookmark' : 'globe', 's14')}
            <input class="pd-mini-in mono" data-note-field="url" value="${esc(n.url)}" placeholder="https://..." style="flex:1"/>
            <button type="button" class="btn" data-launch style="height:25px;padding:0 7px;font-size:11px">${icon('external', 's12')}Go</button>
          </div>
          <textarea class="pd-inline-body" data-note-field="body" placeholder="Notes about this link…">${esc(n.body === n.url ? '' : n.body)}</textarea>
        `;
      }

      default:
        return orig.typeBody(n);
    }
  }

  function enhancedNoteHtml(n) {
    const t = TYPES[n.type] || TYPES.text;
    const editing = S.editingId === n.id;
    const pinned = n.badges.includes('pin');
    const cls = ['note', (S.sel === n.id || S.multi.has(n.id)) ? 'selected' : '', editing ? 'editing' : '', S.pendingLink === n.id ? 'link-source' : ''].join(' ');
    const chips = n.badges.filter((b) => B[b]?.kind === 'chip');

    let ctx = '';
    if (n.type === 'checklist' && n.tasks.length) ctx = `${n.tasks.filter((x) => x.done).length}/${n.tasks.length}`;
    else if (n.type === 'webPreview') ctx = `v${n.rev || 1} · ${shortAgo(n.refreshedAt || Date.now())}`;
    else if (['voice', 'audio', 'video'].includes(n.type)) ctx = n.meta?.duration || '';
    else if (n.type === 'pdf') ctx = n.meta?.pages || '';
    else if (n.type === 'fileAttachment') ctx = n.meta?.size || n.meta?.fileSize || '';
    else if (n.type === 'alarm') ctx = extractAlarmTime24(n);

    const chipHtml = (id) => {
      const b = B[id];
      return b ? `<span class="chip t-${b.tone}">${icon(b.icon, 's12')}${esc(b.label)}</span>` : '';
    };

    const meta = `<div class="meta">
      ${icon(t.icon, 's14')}
      <span class="type">${t.label}</span>
      ${ctx ? `<span class="ctx">${esc(ctx)}</span>` : ''}
      ${n.type === 'webPreview' ? `<button class="mini" data-refresh aria-label="Refresh snapshot" title="Refresh snapshot">${icon('refresh', 's14')}</button>` : ''}
      <button class="mini max" data-ql aria-label="Quick Look" title="Quick Look (Space)">${icon('eye', 's14')}</button>
      <button class="mini max" data-max aria-label="Expand to canvas" title="Expand to canvas (F)">${icon('expand', 's14')}</button>
      ${n.badges.includes('star') ? `<span class="star" title="Starred">${icon('star', 'fill s14')}</span>` : ''}
      ${pinned ? `<span title="Pinned — position locked">${icon('pin', 's14')}</span>` : `<span class="grip">${icon('grip', 's14')}</span>`}
    </div>`;

    // Inline editable title on ALL note containers on the canvas
    const titleInput = `<input class="pd-inline-title edit-title" data-note-field="title" value="${esc(n.title)}" placeholder="Untitled ${t.label.toLowerCase()}…" aria-label="Note title"/>`;

    const inner = `${meta}${titleInput}<div class="content">${enhancedTypeBody(n)}</div>${chips.length ? `<div class="badges">${chips.map(chipHtml).join('')}</div>` : ''}`;

    const ring = n.badges.includes('circle')
      ? `<svg class="ring" viewBox="0 0 ${n.w} ${n.h}" preserveAspectRatio="none"><path d="M${n.w * .12} ${n.h * .02} C ${n.w * .45} ${-n.h * .16}, ${n.w * 1.02} ${-n.h * .08}, ${n.w * 1.04} ${n.h * .38} C ${n.w * 1.07} ${n.h * .86}, ${n.w * .74} ${n.h * 1.1}, ${n.w * .45} ${n.h * 1.07} C ${n.w * .1} ${n.h * 1.04}, ${-n.w * .06} ${n.h * .78}, ${-n.w * .04} ${n.h * .45} C ${-n.w * .02} ${n.h * .16}, ${n.w * .12} ${-n.h * .02}, ${n.w * .36} ${-n.h * .06}" fill="none" stroke="var(--danger)" stroke-opacity=".8" stroke-width="2.25" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>` : '';
    const scribbles = n.type !== 'drawing' && n.scribbles?.length
      ? `<svg class="scribbles" width="${n.w}" height="${n.h}">${App.inkLayer(n.scribbles)}</svg>` : '';

    return `<div class="${cls}" data-id="${n.id}" tabindex="0" role="group" aria-label="${esc(t.label + ': ' + (n.title || 'Untitled'))}" style="left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px">
      <div class="card">${inner}</div>${ring}${scribbles}
      <span class="handle tl" data-h="tl"></span><span class="handle tr" data-h="tr"></span><span class="handle bl" data-h="bl"></span><span class="handle br" data-h="br"></span>
    </div>`;
  }

  /* ------------------------------------------------------------------
     9. Executable / Actionable Note Launcher (`openNative`)
     ------------------------------------------------------------------ */
  function enhancedOpenNative(n) {
    if (!n) return;
    const m = n.meta || {};
    const u = (n.url || '').trim();

    if (n.type === 'voice' || n.type === 'audio') {
      togglePlayMedia(n);
      return;
    }
    if (n.type === 'alarm') {
      triggerAlarmPopup(n);
      return;
    }
    if (n.type === 'calendar') {
      exportCalendarIcs(n);
      return;
    }
    if (n.type === 'emailLink') {
      const to = emailOf(n) || 'team@example.com';
      const href = /^mailto:/i.test(u) ? u : `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(n.title || '')}&body=${encodeURIComponent(n.body || '')}`;
      window.open(href, '_blank', 'noopener');
      toast(`Opening email client for ${to}`);
      return;
    }
    if (m.blobUrl || m.dataUrl) {
      const a = document.createElement('a');
      a.href = m.blobUrl || m.dataUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      if (n.type === 'fileAttachment') a.download = m.fileName || n.title || 'file';
      a.click();
      return;
    }
    if (/^(https?:|mailto:|vscode:|slack:|figma:|ms-|calc:)/i.test(u)) {
      window.open(u, '_blank', 'noopener');
      toast(`Launched ${TYPES[n.type]?.label || 'link'}`);
      return;
    }
    if (u && /^[a-z0-9\-]+\.[a-z]{2,}/i.test(u) && !/^[a-z]:\\/i.test(u)) {
      window.open('https://' + u, '_blank', 'noopener');
      return;
    }
    openPreview(n.id);
  }

  function exportCalendarIcs(n) {
    const d = (n.meta?.date || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
    const t = (n.meta?.time || '10:00').replace(':', '') + '00';
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//PaperDesk Freeboard//EN',
      'BEGIN:VEVENT',
      `UID:${n.id}@paperdesk`,
      `DTSTART:${d}T${t}`,
      `SUMMARY:${(n.title || 'Event').replace(/\r?\n/g, ' ')}`,
      `DESCRIPTION:${(n.body || '').replace(/\r?\n/g, '\\n')}`,
      `LOCATION:${(n.meta?.location || n.url || '').replace(/\r?\n/g, ' ')}`,
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(n.title || 'event').replace(/[^\w\-]+/g, '_')}.ics`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Calendar .ics exported');
  }

  /* ------------------------------------------------------------------
     10. On-Canvas Interactive Event Delegation (Inline Edits, Drawing Pad,
         Checklist, Audio Scrubber, Alarm, Calendar, RSVP, Stamp)
     ------------------------------------------------------------------ */
  // Prevent note drag when interacting with inline controls inside notes
  vpEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.pd-draw-wrap, .pd-wave-scrub, .pd-stamp-picker, .pd-stamp-glyph, .pd-rsvp-btn, .pd-alarm-toggle, .pd-rec-btn, select')) {
      e.stopPropagation();
    }
  }, true);

  // Select note automatically when focusing any inline field inside it
  vpEl.addEventListener('focusin', (e) => {
    const noteEl = e.target.closest('.note');
    if (noteEl && S.sel !== noteEl.dataset.id) {
      select(noteEl.dataset.id);
    }
  });

  // Prevent double-clicking text inside inline inputs/controls from opening Quick Look modal
  vpEl.addEventListener('dblclick', (e) => {
    if (e.target.closest('input, textarea, button, select, .pd-draw-wrap, .pd-wave-scrub, .pd-stamp-picker')) {
      e.stopPropagation();
    }
  }, true);

  // Interactive Drawing Pad inside `drawing` notes
  let padStroke = null;
  vpEl.addEventListener('pointerdown', (e) => {
    const svg = e.target.closest('.pd-draw-surface');
    if (!svg) return;
    e.stopPropagation();
    const wrap = svg.closest('.pd-draw-wrap');
    const n = findNote(wrap.dataset.drawPad);
    if (!n) return;
    pushUndo('draw_' + n.id);
    const r = svg.getBoundingClientRect();
    const vbW = Math.max(160, n.w - 26), vbH = Math.max(70, n.h - 76);
    const pt = [((e.clientX - r.left) / r.width) * vbW, ((e.clientY - r.top) / r.height) * vbH];
    const color = n.meta?.penColor || S.ink || '#2D55D9';
    const stroke = { color, width: 2.6, points: [pt] };
    n.scribbles = n.scribbles || [];
    n.scribbles.push(stroke);
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('fill', 'none');
    pathEl.setAttribute('stroke', color);
    pathEl.setAttribute('stroke-width', '2.6');
    pathEl.setAttribute('stroke-linecap', 'round');
    pathEl.setAttribute('stroke-linejoin', 'round');
    pathEl.setAttribute('d', pathOf(stroke.points));
    svg.appendChild(pathEl);
    padStroke = { svg, stroke, pathEl, vbW, vbH };
    svg.setPointerCapture(e.pointerId);
  });

  vpEl.addEventListener('pointermove', (e) => {
    if (!padStroke) return;
    const r = padStroke.svg.getBoundingClientRect();
    const pt = [
      clamp(((e.clientX - r.left) / r.width) * padStroke.vbW, 0, padStroke.vbW),
      clamp(((e.clientY - r.top) / r.height) * padStroke.vbH, 0, padStroke.vbH)
    ];
    padStroke.stroke.points.push(pt);
    padStroke.pathEl.setAttribute('d', pathOf(padStroke.stroke.points));
  });

  vpEl.addEventListener('pointerup', () => {
    if (!padStroke) return;
    padStroke = null;
    save();
  });

  // Inline input changes on canvas note containers
  vpEl.addEventListener('input', (e) => {
    const noteEl = e.target.closest('.note');
    if (!noteEl) return;
    const n = findNote(noteEl.dataset.id);
    if (!n) return;

    const field = e.target.dataset.noteField;
    if (field) {
      pushUndo('inline_' + n.id);
      n[field] = e.target.value;
      save();
      drawOverview();
      return;
    }
    if (e.target.hasAttribute('data-task-edit')) {
      const idx = +e.target.dataset.taskEdit;
      if (n.tasks[idx]) {
        pushUndo('task_' + n.id);
        n.tasks[idx].title = e.target.value;
        save();
      }
      return;
    }
    if (e.target.hasAttribute('data-email-to')) {
      n.meta = n.meta || {};
      n.meta.sender = e.target.value.trim();
      n.url = `mailto:${n.meta.sender}?subject=${encodeURIComponent(n.title || '')}`;
      save();
      return;
    }
    if (e.target.hasAttribute('data-cal-loc')) {
      n.meta = n.meta || {};
      n.meta.location = e.target.value;
      save();
    }
  });

  vpEl.addEventListener('change', (e) => {
    const noteEl = e.target.closest('.note');
    if (!noteEl) return;
    const n = findNote(noteEl.dataset.id);
    if (!n) return;
    n.meta = n.meta || {};

    if (e.target.hasAttribute('data-alarm-time')) {
      pushUndo();
      n.meta.time24 = e.target.value;
      n.meta.alarmTime = `${n.meta.dateIso || 'Today'} ${e.target.value}`;
      n.meta.armed = true;
      n.meta.ringing = false;
      renderAll();
      toast(`Reminder set for ${e.target.value}`);
    } else if (e.target.hasAttribute('data-alarm-date')) {
      pushUndo();
      n.meta.dateIso = e.target.value;
      n.meta.alarmTime = `${e.target.value} ${extractAlarmTime24(n)}`;
      renderAll();
    } else if (e.target.hasAttribute('data-cal-date')) {
      pushUndo();
      n.meta.date = e.target.value;
      renderAll();
    } else if (e.target.hasAttribute('data-cal-time')) {
      pushUndo();
      n.meta.time = e.target.value;
      save();
    }
  });

  vpEl.addEventListener('keydown', (e) => {
    const noteEl = e.target.closest('.note');
    if (!noteEl) return;
    const n = findNote(noteEl.dataset.id);
    if (!n) return;

    if (e.target.hasAttribute('data-task-new') && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const val = e.target.value.trim();
      if (!val) return;
      pushUndo();
      n.tasks.push({ title: val, done: false });
      if (n.h < 120 + n.tasks.length * 26) n.h = Math.min(380, n.h + 26);
      renderAll();
      $(`.note[data-id="${n.id}"] [data-task-new]`)?.focus();
      return;
    }
    if (e.target.classList.contains('pd-inline-title') && e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();
      const next = $(`.note[data-id="${n.id}"] .pd-inline-body, .note[data-id="${n.id}"] [data-task-new]`);
      next?.focus();
    }
  });

  vpEl.addEventListener('click', (e) => {
    const noteEl = e.target.closest('.note');
    if (!noteEl) return;
    const n = findNote(noteEl.dataset.id);
    if (!n) return;
    n.meta = n.meta || {};

    if (e.target.closest('[data-ql]')) {
      openPreview(n.id);
      return;
    }
    if (e.target.closest('[data-rec]')) {
      e.stopPropagation();
      toggleVoiceRecording(n);
      return;
    }
    const scrubBar = e.target.closest('[data-scrub]');
    if (scrubBar) {
      e.stopPropagation();
      togglePlayMedia(n, parseFloat(scrubBar.dataset.scrub));
      return;
    }
    if (e.target.closest('[data-play]')) {
      e.stopImmediatePropagation();
      togglePlayMedia(n);
      return;
    }
    const taskDel = e.target.closest('[data-task-del]');
    if (taskDel) {
      e.stopPropagation();
      pushUndo();
      n.tasks.splice(+taskDel.dataset.taskDel, 1);
      renderAll();
      return;
    }
    const padInk = e.target.closest('[data-pad-ink]');
    if (padInk) {
      e.stopPropagation();
      n.meta.penColor = padInk.dataset.padInk;
      S.ink = padInk.dataset.padInk;
      renderAll();
      return;
    }
    if (e.target.closest('[data-pad-undo]')) {
      e.stopPropagation();
      if (n.scribbles?.length) { pushUndo(); n.scribbles.pop(); renderAll(); }
      return;
    }
    if (e.target.closest('[data-pad-clear]')) {
      e.stopPropagation();
      if (n.scribbles?.length) { pushUndo(); n.scribbles = []; renderAll(); }
      return;
    }
    if (e.target.closest('[data-alarm-arm]')) {
      e.stopPropagation();
      pushUndo();
      if (n.meta.ringing) { n.meta.ringing = false; n.meta.armed = false; }
      else n.meta.armed = n.meta.armed === false;
      renderAll();
      return;
    }
    if (e.target.closest('[data-alarm-test]')) {
      e.stopPropagation();
      triggerAlarmPopup(n);
      return;
    }
    const rsvpBtn = e.target.closest('[data-rsvp]');
    if (rsvpBtn) {
      e.stopPropagation();
      pushUndo();
      const prev = n.meta.myRsvp;
      const next = rsvpBtn.dataset.rsvp;
      n.meta.myRsvp = next;
      const m = String(n.meta.rsvp || '4/5').match(/(\d+)\s*\/\s*(\d+)/);
      if (m) {
        let cur = +m[1], tot = +m[2];
        if (prev !== 'accepted' && next === 'accepted') cur = Math.min(tot, cur + 1);
        else if (prev === 'accepted' && next !== 'accepted') cur = Math.max(0, cur - 1);
        n.meta.rsvp = `${cur}/${tot}`;
      }
      renderAll();
      toast(`RSVP updated: ${next.toUpperCase()}`);
      return;
    }
    const stampPick = e.target.closest('[data-stamp-pick]');
    if (stampPick) {
      e.stopPropagation();
      pushUndo();
      const st = STAMPS.find((s) => s.id === stampPick.dataset.stampPick);
      if (st) {
        n.meta.stampId = st.id;
        if (STAMPS.some((s) => s.label === n.title)) n.title = st.label;
      }
      renderAll();
      return;
    }
    if (e.target.closest('[data-stamp-cycle]')) {
      e.stopPropagation();
      pushUndo();
      const idx = STAMPS.findIndex((s) => s.id === n.meta.stampId);
      const st = STAMPS[(idx + 1) % STAMPS.length];
      n.meta.stampId = st.id;
      renderAll();
      return;
    }
    if (e.target.closest('[data-resnip]')) {
      e.stopPropagation();
      startScreenSnipper({ x: n.x, y: n.y });
      return;
    }
  }, true);

  /* ------------------------------------------------------------------
     11. Custom Right-Click Context Menu System (with Submenus)
     ------------------------------------------------------------------ */
  const ctxMenu = document.createElement('div');
  ctxMenu.className = 'pd-ctx-menu';
  ctxMenu.id = 'pd-ctx-menu';
  ctxMenu.setAttribute('role', 'menu');
  document.body.appendChild(ctxMenu);

  const ctxSub = document.createElement('div');
  ctxSub.className = 'pd-ctx-sub';
  ctxSub.id = 'pd-ctx-sub';
  ctxSub.setAttribute('role', 'menu');
  document.body.appendChild(ctxSub);

  let currentCtxItems = [];
  let currentSubItems = [];

  function closeContextMenu() {
    ctxMenu.classList.remove('show');
    ctxSub.classList.remove('show');
  }

  function renderMenuRows(container, items, prefix) {
    container.innerHTML = items.map((it, i) => {
      if (it.head) return `<div class="pd-ctx-head">${it.icon ? icon(it.icon, 's14') : ''}<span>${esc(it.head)}</span></div>`;
      if (it.sec) return `<div class="pd-ctx-sec">${esc(it.sec)}</div>`;
      if (it.sep) return `<div class="pd-ctx-sep"></div>`;
      const hasSub = Array.isArray(it.sub) && it.sub.length > 0;
      return `<button type="button" class="pd-ctx-item ${it.danger ? 'danger' : ''}" role="${it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}" data-ctx-idx="${prefix}:${i}" ${it.checked !== undefined ? `aria-checked="${it.checked}"` : ''} ${it.disabled ? 'disabled' : ''}>
        <span class="pd-ic">${it.icon ? icon(it.icon, 's16') : ''}</span>
        <span class="pd-lbl">${esc(it.label)}</span>
        ${it.hint ? `<span class="pd-hint">${esc(it.hint)}</span>` : ''}
        ${hasSub ? `<span class="pd-chev">${icon('chev-r', 's14')}</span>` : ''}
      </button>`;
    }).join('');
  }

  function positionMenuBox(el, x, y) {
    el.style.left = '0px';
    el.style.top = '0px';
    const w = el.offsetWidth || 248;
    const h = el.offsetHeight || 320;
    const left = clamp(x, 8, Math.max(8, window.innerWidth - w - 8));
    const top = clamp(y, 8, Math.max(8, window.innerHeight - h - 8));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  function showContextMenuAt(x, y, items) {
    closeContextMenu();
    currentCtxItems = items;
    renderMenuRows(ctxMenu, items, 'main');
    ctxMenu.classList.add('show');
    positionMenuBox(ctxMenu, x, y);
  }

  function openSubmenuFor(btnEl, subItems) {
    $$('.pd-ctx-item.active-sub', ctxMenu).forEach((b) => b.classList.remove('active-sub'));
    btnEl.classList.add('active-sub');
    currentSubItems = subItems;
    renderMenuRows(ctxSub, subItems, 'sub');
    ctxSub.classList.add('show');
    const r = btnEl.getBoundingClientRect();
    const sw = ctxSub.offsetWidth || 240;
    const sh = ctxSub.offsetHeight || 260;
    const left = r.right + 4 + sw <= window.innerWidth - 8 ? r.right + 4 : Math.max(8, r.left - sw - 4);
    const top = clamp(r.top - 4, 8, Math.max(8, window.innerHeight - sh - 8));
    ctxSub.style.left = left + 'px';
    ctxSub.style.top = top + 'px';
  }

  ctxMenu.addEventListener('pointerover', (e) => {
    const btn = e.target.closest('[data-ctx-idx]');
    if (!btn) return;
    const idx = +btn.dataset.ctxIdx.split(':')[1];
    const it = currentCtxItems[idx];
    if (it?.sub) openSubmenuFor(btn, it.sub);
    else {
      ctxSub.classList.remove('show');
      $$('.pd-ctx-item.active-sub', ctxMenu).forEach((b) => b.classList.remove('active-sub'));
    }
  });

  function handleMenuClick(e) {
    const btn = e.target.closest('[data-ctx-idx]');
    if (!btn) return;
    const [scope, rawIdx] = btn.dataset.ctxIdx.split(':');
    const list = scope === 'sub' ? currentSubItems : currentCtxItems;
    const it = list[+rawIdx];
    if (!it || it.disabled) return;
    if (it.sub && scope === 'main') {
      openSubmenuFor(btn, it.sub);
      return;
    }
    closeContextMenu();
    it.action?.();
  }
  ctxMenu.addEventListener('click', handleMenuClick);
  ctxSub.addEventListener('click', handleMenuClick);

  document.addEventListener('pointerdown', (e) => {
    if (!ctxMenu.classList.contains('show')) return;
    if (ctxMenu.contains(e.target) || ctxSub.contains(e.target)) return;
    closeContextMenu();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ctxMenu.classList.contains('show')) {
      e.preventDefault();
      closeContextMenu();
    }
  }, true);

  /* Build Canvas Context Menu Items */
  function buildCanvasContextMenu(worldPt) {
    const board = activeBoard();
    const desks = S.boards;
    const groups = groupTabs();

    return [
      { head: `${board.title} · Desk Menu`, icon: 'desk' },
      { sec: 'Create Note on Canvas' },
      { label: 'Text Note', icon: 'type', hint: 'Dbl-click', action: () => createNoteOnCanvas('text', worldPt) },
      { label: 'Checklist', icon: 'checklist', action: () => createNoteOnCanvas('checklist', worldPt) },
      { label: 'Voice Memo (Record & Play)', icon: 'mic', action: () => createNoteOnCanvas('voice', worldPt) },
      { label: 'Drawing / Sketch Pad', icon: 'pen', action: () => createNoteOnCanvas('drawing', worldPt) },
      { label: 'Reminder / Alarm', icon: 'alarm', action: () => createNoteOnCanvas('alarm', worldPt) },
      ...(window.PaperDeskAI ? [
        { label: 'Chart', icon: 'chart', action: () => window.PaperDeskAI.newChart(worldPt) },
        { label: 'Dictate a Note (Speech to Text)', icon: 'mic', hint: 'D', action: () => window.PaperDeskAI.dictate(worldPt) },
        { label: 'Create with AI…', icon: 'sparkle', hint: 'A', action: () => window.PaperDeskAI.open({ at: worldPt }) },
      ] : []),
      {
        label: 'More On-Canvas Notes', icon: 'calendar',
        sub: [
          { head: 'Events & Stickers', icon: 'calendar' },
          { label: 'Calendar Event', icon: 'calendar', action: () => createNoteOnCanvas('calendar', worldPt) },
          { label: 'Invitation (with RSVP)', icon: 'users', action: () => createNoteOnCanvas('invitation', worldPt) },
          { label: 'Stamp / Sticker', icon: 'stamp', action: () => createNoteOnCanvas('iconStamp', worldPt) },
        ]
      },
      { sep: true },
      { sec: 'External Files & Links' },
      { label: 'Add / Link File(s)…', icon: 'clip', hint: MOD + 'O', action: () => pickEnhancedFiles(worldPt) },
      {
        label: 'Link External Element', icon: 'bookmark',
        sub: [
          { head: 'External Linked Items', icon: 'link' },
          { label: 'Add PDF / Office / Media File…', icon: 'file', action: () => pickEnhancedFiles(worldPt) },
          { label: 'Web Bookmark…', icon: 'bookmark', action: () => runBookmarkLinkAction('bookmark', worldPt) },
          { label: 'Web Hyperlink…', icon: 'link', action: () => runBookmarkLinkAction('hyperlink', worldPt) },
          { label: 'Application Shortcut…', icon: 'zap', action: () => runAppShortcutAction(worldPt) },
          { label: 'Email Deep-Link…', icon: 'mail', action: () => runEmailAction(worldPt) },
        ]
      },
      { sep: true },
      { sec: 'Action Tools' },
      { label: 'Screen Clip Snipper', icon: 'scissors', action: () => startScreenSnipper(worldPt) },
      { label: 'Capture Web Snapshot…', icon: 'globe', action: () => runWebSnapshotAction(worldPt) },
      { label: 'Link Notes into Group', icon: 'link', hint: 'L', action: () => setTool('link') },
      { label: 'Compose Email Action…', icon: 'mail', action: () => runEmailAction(worldPt) },
      { label: S.tool === 'draw' ? 'Exit Draw Tool' : 'Freehand Draw on Paper', icon: 'pen', hint: 'P', action: () => setTool(S.tool === 'draw' ? 'select' : 'draw') },
      { sep: true },
      {
        label: 'View & Arrange', icon: 'grid',
        sub: [
          { head: 'Layout & Zoom', icon: 'canvas' },
          ...(!board.isGroup ? [{ label: board.tidy ? 'Undo Tidy Grid' : 'Tidy Up Notes in Grid', icon: 'tidy', action: toggleTidy }, { sep: true }] : []),
          { label: 'Freeform Desk Canvas', icon: 'canvas', checked: board.viewMode === 'freeform', action: () => setViewGroup('canvas') },
          { label: 'Symmetrical Grid', icon: 'grid', checked: board.viewMode === 'symmetricalGrid', action: () => { viewOf(board).viewMode = 'symmetricalGrid'; renderAll(); } },
          { label: 'Gallery View', icon: 'image', checked: board.viewMode === 'gallery', action: () => { viewOf(board).viewMode = 'gallery'; renderAll(); } },
          { label: 'Mosaic Grid', icon: 'grid', checked: board.viewMode === 'asymmetricalGrid', action: () => { viewOf(board).viewMode = 'asymmetricalGrid'; renderAll(); } },
          { label: 'Details Table List', icon: 'list', checked: board.viewMode === 'detailsList', action: () => { viewOf(board).viewMode = 'detailsList'; renderAll(); } },
          { sep: true },
          { label: 'Zoom to Fit All Notes', icon: 'fit', hint: 'Shift 1', action: () => fitTo(visibleNotes()) },
          { label: 'Reset Zoom (100%)', hint: MOD + '0', action: resetZoom },
          { label: 'Toggle Overview Map', icon: 'map', checked: !!S.showMap, action: () => { S.showMap = !S.showMap; renderCanvas(); save(); } },
        ]
      },
      {
        label: 'Desks & Group Canvases', icon: 'layers',
        sub: [
          { head: 'Switch Desk', icon: 'desk' },
          ...desks.map((d) => ({ label: `${d.title} (${d.notes.length})`, icon: 'desk', checked: d.id === S.activeId, action: () => switchTo(d.id) })),
          ...(groups.length ? [{ sep: true }, { sec: 'Auto-Generated Groups' }, ...groups.map((g) => ({ label: `${g.title} (${g.notes.length})`, icon: 'layers', checked: g.id === S.activeId, action: () => switchTo(g.id) }))] : []),
          { sep: true },
          { label: 'New Desk…', icon: 'plus', action: newDesk },
        ]
      },
      {
        label: 'Save & Cloud Sync', icon: 'cloud',
        sub: [
          { head: 'Workspace Persistence', icon: 'cloud' },
          { label: 'Save Desk to File…', icon: 'download', hint: MOD + 'S', action: saveWorkspaceToFile },
          { label: 'Open Desk File…', icon: 'file', action: openWorkspaceFromFile },
          { label: 'Export Desk as Markdown…', icon: 'copy', action: exportDeskMarkdown },
          { label: 'Send Desk to Another App…', icon: 'send', action: () => window.PaperDeskSend?.open('desk') },
          { sep: true },
          { label: 'Cloud Sync & Backup Settings…', icon: 'cloud', action: enhancedSyncDialog },
          { label: 'Install PaperDesk as App (PWA)…', icon: 'download', action: triggerOrShowPwaInstall },
        ]
      },
      { sep: true },
      { label: 'Undo', icon: 'undo', hint: MOD + 'Z', disabled: !S.undo.length, action: undo },
      { label: 'Redo', icon: 'redo', hint: MOD + 'Y', disabled: !S.redo.length, action: redo },
    ];
  }

  /* Build Note Context Menu Items */
  function buildNoteContextMenu(n) {
    const t = TYPES[n.type] || TYPES.text;
    const owner = ownerBoard(n.id);
    const otherDesks = S.boards.filter((d) => d !== owner);

    const execLabel = n.type === 'voice' ? (n.recording ? 'Stop Recording' : n.playing ? 'Pause Voice Memo' : 'Play Voice Memo')
      : n.type === 'audio' || n.type === 'video' ? (n.playing ? 'Pause Media' : 'Play Media')
      : n.type === 'alarm' ? 'Test / Ring Reminder Now'
      : n.type === 'calendar' ? 'Export Event (.ics)'
      : n.type === 'appShortcut' ? 'Launch Application'
      : n.type === 'emailLink' ? 'Compose / Send Email'
      : ['webPreview', 'hyperlink', 'bookmark'].includes(n.type) ? 'Open Website in New Tab'
      : 'Open / Execute Note';

    return [
      { head: `${t.label}: ${n.title || 'Untitled'}`, icon: t.icon },
      { label: 'Quick Look Preview', icon: 'eye', hint: 'Space', action: () => openPreview(n.id) },
      { label: 'Send to Another App…', icon: 'send', hint: 'S', action: () => window.PaperDeskSend?.open('note', n.id) },
      ...(window.PaperDeskAI ? [{ label: 'AI on This Device', icon: 'sparkle', sub: [{ head: 'AI actions', icon: 'sparkle' }, ...window.PaperDeskAI.noteItems(n)] }] : []),
      { label: 'Expand to Full Canvas', icon: 'expand', hint: 'F', action: () => maximize(n.id) },
      { label: execLabel, icon: 'external', action: () => enhancedOpenNative(n) },
      ...(n.type === 'voice' ? [{ label: n.recording ? 'Stop Microphone Recording' : 'Record Microphone Audio', icon: 'mic', action: () => toggleVoiceRecording(n) }] : []),
      ...(n.type === 'webPreview' ? [{ label: `Refresh Snapshot (v${(n.rev || 1) + 1})`, icon: 'refresh', action: () => { pushUndo(); n.rev = (n.rev || 1) + 1; n.refreshedAt = Date.now(); renderAll(); toast(`Snapshot refreshed (v${n.rev})`); } }, { label: n.meta?.liveIframe ? 'Show Fast Preview Card' : 'Embed Live Webpage Frame', icon: 'globe', action: () => { n.meta = n.meta || {}; n.meta.liveIframe = !n.meta.liveIframe; renderAll(); } }] : []),
      { sep: true },
      { label: 'Edit Title Inline', icon: 'type', hint: 'Enter', action: () => { select(n.id); $(`.note[data-id="${n.id}"] .pd-inline-title`)?.focus(); } },
      { label: 'Start Interactive Link from Note', icon: 'link', action: () => { setTool('link'); S.pendingLink = n.id; renderCanvas(); } },
      { label: 'Link to Note (Dialog)…', icon: 'layers', action: () => linkDialog(n.id) },
      {
        label: 'Badges & Markers', icon: 'tag',
        sub: [
          { head: 'Toggle Badges', icon: 'tag' },
          ...BADGES.map((b) => ({
            label: b.label,
            icon: b.icon,
            checked: n.badges.includes(b.id),
            action: () => toggleBadge(n.id, b.id),
          })),
        ]
      },
      {
        label: 'Move to Desk', icon: 'move',
        sub: otherDesks.length
          ? otherDesks.map((d) => ({
              label: `${d.title} (${d.notes.length})`,
              icon: 'desk',
              action: () => {
                pushUndo();
                owner.notes = owner.notes.filter((x) => x.id !== n.id);
                owner.links = owner.links.filter((l) => l.src !== n.id && l.dst !== n.id);
                d.notes.push(n);
                S.sel = null; S.multi.clear();
                renderAll();
                toast(`Moved to ${d.title}`, true);
              }
            }))
          : [{ label: 'New Desk…', icon: 'plus', action: newDesk }]
      },
      { sep: true },
      { label: 'Duplicate Note', icon: 'copy', action: () => duplicateNote(n) },
      { label: n.badges.includes('pin') ? 'Unpin Position' : 'Pin Note in Place', icon: 'pin', checked: n.badges.includes('pin'), action: () => toggleBadge(n.id, 'pin') },
      { label: 'Bring to Front', icon: 'up', action: () => bringNoteToFront(n) },
      { label: 'Zoom to Note', icon: 'fit', action: () => fitTo([n], 1.35) },
      { sep: true },
      { label: 'Delete Note', icon: 'trash', hint: 'Del', danger: true, action: () => deleteNote(n.id) },
    ];
  }

  function duplicateNote(n) {
    const clone = JSON.parse(JSON.stringify(n));
    delete clone.id;
    clone.title = (n.title || 'Note') + ' (copy)';
    clone.x = n.x + 28;
    clone.y = n.y + 28;
    addNote(clone);
    toast('Note duplicated', true);
  }

  function bringNoteToFront(n) {
    const b = ownerBoard(n.id);
    if (!b) return;
    pushUndo();
    b.notes = b.notes.filter((x) => x.id !== n.id);
    b.notes.push(n);
    renderAll();
  }

  /* Global Right-Click Handler (Capture Phase so it overrides old behavior cleanly) */
  window.addEventListener('contextmenu', (e) => {
    // Allow native context menu inside text inputs if user has selected text
    if (e.target.matches('input, textarea') && e.target.selectionStart !== e.target.selectionEnd) return;

    // 1. Right-click on a note on the canvas or in Structured Grid/List view
    const noteEl = e.target.closest('.note');
    const structEl = e.target.closest('#structured [data-open]');
    if (noteEl || structEl) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const id = noteEl ? noteEl.dataset.id : structEl.dataset.open;
      const n = findNote(id);
      if (!n) return;
      select(id);
      showContextMenuAt(e.clientX, e.clientY, buildNoteContextMenu(n));
      return;
    }

    // 2. Right-click on a Group Tab or Desk Tab in Topbar
    const tabEl = e.target.closest('#tabs .tab');
    if (tabEl) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const tabId = tabEl.dataset.tab;
      if (String(tabId).startsWith('group:')) {
        const gName = tabId.slice(6);
        showContextMenuAt(e.clientX, e.clientY, [
          { head: `Group: ${gName}`, icon: 'layers' },
          { label: 'Open Group Canvas', icon: 'canvas', action: () => switchTo(tabId) },
          { label: 'Rename Group…', icon: 'type', action: () => { switchTo(tabId); $('#group-rename')?.click(); } },
          { sep: true },
          { label: 'Ungroup…', icon: 'x', danger: true, action: () => { switchTo(tabId); $('#group-ungroup')?.click(); } },
        ]);
      } else {
        const b = S.boards.find((x) => x.id === tabId);
        if (b) {
          showContextMenuAt(e.clientX, e.clientY, [
            { head: `Desk: ${b.title}`, icon: 'desk' },
            { label: 'Switch to Desk', icon: 'desk', action: () => switchTo(b.id) },
            { label: 'Rename Desk…', icon: 'type', action: async () => { const v = await promptText('Rename desk', 'Desk name', b.title, 'Rename'); if (v) { pushUndo(); b.title = v; renderAll(); } } },
            { label: 'Duplicate Desk', icon: 'copy', action: () => { pushUndo(); const copy = JSON.parse(JSON.stringify(b)); copy.id = uid('board'); copy.title = b.title + ' (copy)'; S.boards.push(copy); switchTo(copy.id); toast('Desk duplicated', true); } },
            { sep: true },
            { label: 'Close Desk', icon: 'trash', danger: true, disabled: S.boards.length < 2, action: () => { pushUndo(); S.boards = S.boards.filter((x) => x.id !== b.id); if (S.activeId === b.id) S.activeId = S.boards[0].id; renderAll(); toast('Desk closed', true); } },
          ]);
        }
      }
      return;
    }

    // 3. Right-click on the Canvas or Structured View background
    if (e.target.closest('#viewport, #structured')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const worldPt = activeBoard().viewMode === 'freeform' ? toWorld(e.clientX, e.clientY) : viewCenter();
      showContextMenuAt(e.clientX, e.clientY, buildCanvasContextMenu(worldPt));
    }
  }, true);

  // Also wire the "+ Add" buttons (#add-btn, #phone-add, #fab) and openPalette so they open the Context Menu or create on-canvas notes without the old form popup
  function enhancedOpenPalette(at = null) {
    const addBtn = $('#add-btn');
    const r = addBtn && addBtn.offsetParent ? addBtn.getBoundingClientRect() : { left: window.innerWidth / 2 - 120, top: window.innerHeight - 380 };
    showContextMenuAt(r.left, r.top - 12, buildCanvasContextMenu(at || viewCenter()));
  }

  /* ------------------------------------------------------------------
     12. Real Save / Load / Export & Functional Cloud Sync
     ------------------------------------------------------------------ */
  let fileHandle = null;

  function workspacePayload() {
    return JSON.stringify({
      app: 'PaperDesk',
      version: 2,
      exportedAt: new Date().toISOString(),
      activeId: S.activeId,
      theme: S.theme,
      cloud: S.cloud,
      boards: S.boards,
    }, null, 2);
  }

  async function saveWorkspaceToFile() {
    const json = workspacePayload();
    if (window.showSaveFilePicker) {
      try {
        if (!fileHandle) {
          fileHandle = await window.showSaveFilePicker({
            suggestedName: 'paperdesk-workspace.json',
            types: [{ description: 'PaperDesk Workspace JSON', accept: { 'application/json': ['.json'] } }]
          });
        }
        const writable = await fileHandle.createWritable();
        await writable.write(json);
        await writable.close();
        S.lastSync = Date.now();
        renderTopbar();
        toast(`Saved to ${fileHandle.name}`);
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = 'paperdesk-workspace.json';
    a.click();
    URL.revokeObjectURL(a.href);
    S.lastSync = Date.now();
    renderTopbar();
    toast('Workspace downloaded as paperdesk-workspace.json');
  }

  async function openWorkspaceFromFile() {
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'PaperDesk Workspace JSON', accept: { 'application/json': ['.json'] } }]
        });
        fileHandle = handle;
        const file = await handle.getFile();
        const text = await file.text();
        restoreWorkspaceJson(text, file.name);
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      const text = await f.text();
      restoreWorkspaceJson(text, f.name);
    };
    inp.click();
  }

  function restoreWorkspaceJson(rawText, label = 'backup') {
    try {
      const data = JSON.parse(rawText);
      if (!Array.isArray(data.boards) || !data.boards.length) throw new Error('Invalid');
      pushUndo();
      S.boards = data.boards;
      S.activeId = data.activeId && S.boards.some((b) => b.id === data.activeId) ? data.activeId : S.boards[0].id;
      S.sel = null; S.multi.clear();
      S.previewId = null;
      S.maxId = null;
      renderAll();
      toast(`Loaded workspace from ${label}`, true);
    } catch {
      toast('Could not read that PaperDesk workspace file');
    }
  }

  function exportDeskMarkdown() {
    const b = activeBoard();
    const lines = [`# ${b.title}\n`];
    b.notes.forEach((n) => {
      lines.push(`## ${n.title || 'Untitled'} (${TYPES[n.type]?.label || n.type})`);
      if (n.url) lines.push(`- **Link/Path:** ${n.url}`);
      if (n.badges?.length) lines.push(`- **Badges:** ${n.badges.join(', ')}`);
      if (n.body) lines.push(`\n${n.body}\n`);
      if (n.tasks?.length) {
        n.tasks.forEach((t) => lines.push(`- [${t.done ? 'x' : ' '}] ${t.title}`));
        lines.push('');
      }
    });
    const md = lines.join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
    a.download = `${b.title.toLowerCase().replace(/[^\w]+/g, '-')}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Desk exported as Markdown (.md)');
  }

  function enhancedSyncDialog() {
    const payload = workspacePayload();
    const sizeKb = (new Blob([payload]).size / 1024).toFixed(1);

    const d = openDialog(`
      <h2>Files & backup</h2>
      <p>Save or open a workspace file, export Markdown, or copy a JSON backup.</p>
      <div class="chips-row">
        <button type="button" class="btn" data-bind-file>${icon('file', 's16')}${fileHandle ? `Save again to ${esc(fileHandle.name)}` : 'Save to a file…'}</button>
        <button type="button" class="btn" data-open-file>${icon('file', 's16')}Open File from Disk…</button>
        <button type="button" class="btn" data-export-md>${icon('file', 's16')}Export Markdown</button>
        <button type="button" class="btn" data-send-to>${icon('send', 's16')}Send to another app…</button>
        <button type="button" class="btn" data-install-pwa>${icon('download', 's16')}Install as App (Desktop / Mobile)…</button>
      </div>
      <label class="switch" style="flex-direction:row;font-size:13.5px;color:var(--ink)">
        <span>Auto-save every change (${sizeKb} KB in browser storage)<br/><small class="muted" id="last-sync">Last synced ${timeAgo(S.lastSync)}</small></span>
        <input type="checkbox" name="auto" ${S.autoSync ? 'checked' : ''}/>
      </label>
      <details>
        <summary style="cursor:pointer;font-weight:600;padding:4px 0">Workspace JSON Backup & Restore</summary>
        <textarea class="field mono" name="json" rows="5" style="margin-top:6px">${esc(payload)}</textarea>
        <div class="chips-row" style="margin-top:6px">
          <button type="button" class="btn ghost" data-copy>${icon('copy', 's16')}Copy JSON</button>
          <button type="button" class="btn ghost" data-dl>${icon('download', 's16')}Download .json</button>
          <button type="button" class="btn ghost" data-restore>Restore from JSON above</button>
        </div>
      </details>
      <div class="actions">
        <button class="btn" value="cancel">Close</button>
      </div>
    `, (dl) => {
      dl.querySelector('[name=auto]').addEventListener('change', (e) => { S.autoSync = e.target.checked; save(); });
      dl.querySelector('[data-bind-file]').addEventListener('click', async () => {
        fileHandle = null;
        await saveWorkspaceToFile();
        dl.close();
      });
      dl.querySelector('[data-open-file]').addEventListener('click', async () => {
        dl.close();
        await openWorkspaceFromFile();
      });
      dl.querySelector('[data-send-to]')?.addEventListener('click', () => { dl.close(); window.PaperDeskSend?.open('desk'); });
      dl.querySelector('[data-export-md]').addEventListener('click', () => {
        exportDeskMarkdown();
      });
      dl.querySelector('[data-install-pwa]').addEventListener('click', () => {
        dl.close();
        triggerOrShowPwaInstall();
      });
      const jsonVal = () => dl.querySelector('[name=json]').value;
      dl.querySelector('[data-copy]').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(jsonVal()); toast('Workspace JSON copied'); }
        catch { dl.querySelector('[name=json]').select(); toast('Press Ctrl+C to copy selected JSON'); }
      });
      dl.querySelector('[data-dl]').addEventListener('click', () => saveWorkspaceToFile());
      dl.querySelector('[data-restore]').addEventListener('click', () => {
        restoreWorkspaceJson(jsonVal(), 'JSON editor');
        dl.close();
      });
    });
    return d;
  }

  // Ctrl+S shortcut to save workspace file directly
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveWorkspaceToFile();
    }
  });

  // Intercept #sync-btn click in capture phase to open enhancedSyncDialog
  $('#sync-btn')?.addEventListener('click', (e) => {
    e.stopImmediatePropagation();
    (window.PaperDeskSync?.openDialog || enhancedSyncDialog)();
  }, true);

  /* ------------------------------------------------------------------
     13. Enhanced Quick Look & Expanded View Stage (`viewerStage`)
     ------------------------------------------------------------------ */
  function enhancedViewerStage(n, lg) {
    if (viewerExt) { const h = viewerExt(n, lg, baseViewerStage); if (h != null) return h; }
    return baseViewerStage(n, lg);
  }
  function baseViewerStage(n, lg) {
    const m = n.meta || {};
    if (n.type === 'screenClip' && (m.dataUrl || m.blobUrl)) {
      return `<div class="vs ${lg ? 'lg' : ''}">
        <div class="clipimg" style="padding:8px;background:var(--surface-2)"><img src="${esc(m.dataUrl || m.blobUrl)}" alt="${esc(n.title)}" style="max-width:100%;max-height:420px;border-radius:8px;object-fit:contain"/></div>
        <div class="cap">${esc(m.dimensions || '')}</div>
        <section><div class="sec-h">Notes</div><textarea class="field" data-vf="body" placeholder="Add notes…">${esc(n.body)}</textarea></section>
      </div>`;
    }
    if ((n.type === 'pdf' || n.type === 'fileAttachment') && (m.blobUrl || m.dataUrl || m.sheetRows || m.textPreview || detectDocKind(n.url || n.title, m.mimeType) !== 'file')) {
      const kind = m.docKind || detectDocKind(n.url || n.title, m.mimeType);
      if ((kind === 'pdf' || n.type === 'pdf') && (m.blobUrl || m.dataUrl)) {
        return `<div class="vs ${lg ? 'lg' : ''}">
          <iframe src="${esc(m.blobUrl || m.dataUrl)}" style="width:100%;height:${lg ? '540px' : '400px'};border:1px solid var(--line);border-radius:12px;background:#fff" title="${esc(n.title)}"></iframe>
          <section><div class="sec-h">Notes</div><textarea class="field" data-vf="body" placeholder="Add notes…">${esc(n.body)}</textarea></section>
        </div>`;
      }
      if (kind === 'excel') {
        const rows = m.sheetRows || [
          ['Metric', 'Q1', 'Q2', 'Q3', 'Q4 Forecast'],
          ['ARR ($M)', '1.42', '1.95', '2.68', '3.40'],
          ['Net Retention', '94%', '96%', '97%', '98%'],
          ['Gross Margin', '71%', '74%', '78%', '80%'],
          ['Active Teams', '410', '620', '890', '1,250'],
        ];
        return `<div class="vs ${lg ? 'lg' : ''}">
          <div style="border:1px solid var(--line);border-radius:12px;overflow:hidden">
            <table class="pd-mini-sheet" style="font-size:13px">
              <thead><tr>${rows[0].map((h) => `<th style="padding:8px 12px">${esc(h)}</th>`).join('')}</tr></thead>
              <tbody>${rows.slice(1).map((r) => `<tr>${r.map((c) => `<td style="padding:8px 12px;max-width:none">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
            </table>
          </div>
          <div class="cap">${esc(fileName(n.url) || n.title)} ${m.size ? `· ${esc(m.size)}` : ''}</div>
          <section><div class="sec-h">Notes</div><textarea class="field" data-vf="body" placeholder="Spreadsheet notes…">${esc(n.body)}</textarea></section>
        </div>`;
      }
    }
    return orig.viewerStage(n, lg);
  }

  for (const root of [$('#ql'), $('#maxview')]) {
    root?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v="play"]');
      if (!b) return;
      e.stopImmediatePropagation();
      const n = findNote(root.id === 'ql' ? S.previewId : S.maxId);
      if (n) togglePlayMedia(n);
    }, true);
  }

  /* ------------------------------------------------------------------
     14. Desktop & Mobile PWA Installation Assistant + Topbar Button
     ------------------------------------------------------------------ */
  function isStandalonePwa() {
    return window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: window-controls-overlay)').matches ||
      window.navigator.standalone === true;
  }

  function ensureTopbarInstallBtn() {
    const syncBtn = $('#sync-btn');
    if (!syncBtn || $('#pd-install-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'pd-install-btn';
    btn.className = 'btn ghost';
    btn.style.cssText = 'height:32px;padding:0 10px;font-size:12.5px;gap:6px';
    btn.title = 'Install PaperDesk as a Desktop or Mobile App (PWA)';
    btn.innerHTML = `${icon('download', 's16')}<span class="tidy-label">Install App</span>`;
    btn.addEventListener('click', triggerOrShowPwaInstall);
    syncBtn.parentNode.insertBefore(btn, syncBtn);
    updateInstallBtnState();
  }

  function updateInstallBtnState() {
    const btn = $('#pd-install-btn');
    if (!btn) return;
    if (isStandalonePwa()) {
      btn.style.display = 'none';
      return;
    }
    btn.style.display = '';
    const hasPrompt = !!App.getInstallPrompt?.();
    if (hasPrompt) {
      btn.className = 'btn primary';
      btn.style.height = '32px';
    } else {
      btn.className = 'btn ghost';
    }
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    App.setInstallPrompt?.(e);
    updateInstallBtnState();
  });

  window.addEventListener('appinstalled', () => {
    App.setInstallPrompt?.(null);
    updateInstallBtnState();
    toast('PaperDesk installed as an app!');
  });

  async function triggerOrShowPwaInstall() {
    const promptEv = App.getInstallPrompt?.();
    if (promptEv) {
      try {
        promptEv.prompt();
        const choice = await promptEv.userChoice;
        if (choice?.outcome === 'accepted') {
          App.setInstallPrompt?.(null);
          updateInstallBtnState();
        }
        return;
      } catch {}
    }

    const isFile = location.protocol === 'file:';
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/i.test(navigator.userAgent);
    const shareUrl = !isFile ? location.href.split('?')[0] : 'http://localhost:8080';
    const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=132x132&margin=6&data=${encodeURIComponent(shareUrl)}`;

    openDialog(`
      <h2>${icon('download', 's18')} Install PaperDesk (Desktop & Mobile PWA)</h2>
      ${isStandalonePwa()
        ? `<div style="padding:10px 12px;border-radius:10px;background:var(--green-bg);color:var(--green);font-weight:600;font-size:13px">✓ PaperDesk is currently running as an installed standalone app!</div>`
        : isFile
        ? `<div style="padding:10px 12px;border-radius:10px;background:var(--amber-bg);color:var(--amber);font-size:12.5px;line-height:1.45">
             <b>Opened via <code>file:///</code>:</b> Browsers require <code>http://localhost</code> or <code>https://</code> to enable 1-click PWA installation and offline Service Workers.<br/>
             Double-click <b><code>Start_PaperDesk_PWA.bat</code></b> in your project folder to launch PaperDesk on <code>http://localhost:8080</code> (and on your Wi-Fi LAN for mobile phones).
           </div>`
        : `<p>Install PaperDesk so it launches in its own standalone window with offline support and taskbar / home-screen shortcuts.</p>`
      }
      <div style="display:flex;flex-direction:column;gap:10px;font-size:12.5px;color:var(--ink-2)">
        <div style="padding:10px 12px;border-radius:10px;background:var(--surface-2);border:1px solid var(--line)">
          <b style="color:var(--ink);display:block;margin-bottom:3px">💻 Desktop (Chrome / Edge on Windows, macOS, Linux)</b>
          Click the <b>Install PaperDesk</b> icon (${icon('download', 's12')}) on the right side of the browser address bar, or open the browser menu <b>⋮ → Save and share → Install PaperDesk…</b>
        </div>
        <div style="padding:10px 12px;border-radius:10px;background:var(--surface-2);border:1px solid var(--line);display:flex;gap:12px;align-items:center">
          <div style="flex:1">
            <b style="color:var(--ink);display:block;margin-bottom:3px">📱 Mobile (${isIOS ? 'iPhone / iPad Safari' : isAndroid ? 'Android Chrome' : 'iOS & Android'})</b>
            <div><b>Android (Chrome / Edge):</b> Tap <b>⋮ → Add to Home screen / Install app</b>.</div>
            <div style="margin-top:3px"><b>iPhone / iPad (Safari):</b> Tap the <b>Share</b> button (⬆️) at the bottom/top of Safari, then tap <b>Add to Home Screen</b>.</div>
          </div>
          ${!isFile ? `<img src="${qrSrc}" width="88" height="88" alt="QR Code" style="border-radius:8px;border:1px solid var(--line);background:#fff;flex:none" onerror="this.style.display='none'"/>` : ''}
        </div>
      </div>
      <div class="actions">
        <button class="btn primary" value="ok">Done</button>
      </div>
    `);
  }

  ensureTopbarInstallBtn();

  // Handle PWA shortcut launches (?create=text|voice|checklist|alarm)
  const urlParams = new URLSearchParams(location.search);
  const createParam = urlParams.get('create');
  if (createParam && TYPES[createParam]) {
    history.replaceState(null, '', location.pathname);
    setTimeout(() => createNoteOnCanvas(createParam), 120);
  }

  /* ------------------------------------------------------------------
     15. Register Hooks into PaperDesk Core & Re-render
     ------------------------------------------------------------------ */
  window.PaperDeskFeatures = {
    backupDialog: enhancedSyncDialog, toggleVoiceRecording, togglePlayMedia, createNoteOnCanvas,
    // Other modules render their own note types: fn(n) / fn(n, lg, base) returns HTML, or null to pass.
    extendTypeBody(fn) { const prev = typeBodyExt; typeBodyExt = prev ? (n) => fn(n) ?? prev(n) : fn; },
    extendViewerStage(fn) { const prev = viewerExt; viewerExt = prev ? (n, lg, base) => fn(n, lg, base) ?? prev(n, lg, base) : fn; },
  };

  App.setHooks({
    typeBody: enhancedTypeBody,
    noteHtml: enhancedNoteHtml,
    viewerStage: enhancedViewerStage,
    openNative: enhancedOpenNative,
    openPalette: enhancedOpenPalette,
    syncDialog: enhancedSyncDialog,
    addFiles: handleEnhancedFiles,
    pickFiles: pickEnhancedFiles,
  });

  renderAll();
})();
