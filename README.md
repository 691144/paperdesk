# PaperDesk

An infinite, borderless desk for dumping thoughts, files, voice memos, web snapshots and tasks. It is one installable web app (PWA) for desktop and mobile, works offline, and can sync between your devices through your own Google Drive or OneDrive. There are no PaperDesk accounts and no server of ours in between.

## Get started

1. Open **https://691144.github.io/paperdesk/** (once published).
2. Install it:
   - **Windows / Mac / Linux (Edge or Chrome):** click the install icon in the address bar, or **Install App** in the top bar.
   - **Android (Chrome):** menu → **Install app** / **Add to Home screen**.
   - **iPhone / iPad (Safari):** Share → **Add to Home Screen**.
3. To sync: click the cloud button in the top bar → pick **Google Drive** or **OneDrive** → **Connect**, and approve once. Do the same on each device with the same account.

## How sync works

- Every device keeps its own full copy and works offline.
- Sync runs about 2 seconds after a change, when the app opens or comes back to the front, every 45 seconds while it is open, and when the connection returns.
- Changes merge note by note and field by field: moving a note on one device and renaming it on another keeps both changes. If the **same text** was changed on two devices before they synced, the newer edit wins and the other version is kept as a **Conflict copy** note. An edit beats a delete.
- Saving uses the drive's "only if unchanged since I read it" check, so two devices saving at once re-merge instead of overwriting each other.
- Files stored: `paperdesk-sync.json`, plus one file per attachment (images, audio, PDFs), in Google Drive's hidden app-data folder or `Apps/PaperDesk` in OneDrive. PaperDesk cannot see anything else in your drive.
- Google's sign-in lasts an hour; PaperDesk renews it without a prompt when the app is opened or brought back to the front (the page briefly reloads). If that isn't possible, the cloud button shows **Reconnect**. Microsoft's sign-in renews in the background for about a day.
- Undo history is cleared when changes from another device arrive, so undo can't remove them by accident.
- **iPhone note:** Apple handles sign-in pages unreliably in home-screen apps. If connecting fails there, use PaperDesk in a Safari tab.

Privacy details: [web/privacy.html](web/privacy.html).

## One-time setup for whoever hosts PaperDesk

Sync needs one public client ID from Google and one from Microsoft. They are not secrets. Put them in [web/config.js](web/config.js). Until then, people can paste their own IDs under **Sync → Use your own client ID**.

The examples use the published address `https://691144.github.io/paperdesk/`; add `http://localhost:8080/` too for local testing.

**Google Drive** ([Google Cloud Console](https://console.cloud.google.com/))
1. Create a project, then **APIs & Services → Library → Google Drive API → Enable**.
2. **Google Auth Platform → Branding:** app name *PaperDesk*, support email, home page `https://691144.github.io/paperdesk/`, privacy policy `https://691144.github.io/paperdesk/privacy.html`.
3. **Audience:** *External*. While it says *Testing*, only the accounts you add as test users can connect (up to 100). Choose **Publish app** to open it to everyone; the only permission used is `drive.appdata`, which Google does not treat as sensitive.
4. **Data access → Add scopes:** `https://www.googleapis.com/auth/drive.appdata`.
5. **Clients → Create client → Web application.** Authorized JavaScript origins: `https://691144.github.io` and `http://localhost:8080`. Authorized redirect URIs: `https://691144.github.io/paperdesk/` and `http://localhost:8080/`.
6. Copy the client ID into `googleClientId` in `web/config.js`.

**OneDrive** ([Microsoft Entra admin center](https://entra.microsoft.com/) → App registrations; a free Azure account works if you only have a personal Microsoft account)
1. **New registration:** name *PaperDesk*; supported account types **Accounts in any organizational directory and personal Microsoft accounts**; redirect URI platform **Single-page application (SPA)**: `https://691144.github.io/paperdesk/`.
2. **Authentication:** add a second SPA redirect URI `http://localhost:8080/`.
3. **API permissions → Add → Microsoft Graph → Delegated:** `Files.ReadWrite.AppFolder`, `offline_access`, `openid`, `profile`.
4. Copy the **Application (client) ID** into `microsoftClientId` in `web/config.js`.
5. Optional: complete *publisher verification* to remove the "unverified" label people see when approving.

Push the change and the site updates in a minute or two.

## What's where

| Path | What it does |
| --- | --- |
| `web/index.html` | The app: desks, notes, links, badges, ink, views, keyboard shortcuts |
| `web/freeboard_features.js` / `.css` | Rich note types, context menus, voice recording, screen clips, files & backup dialog |
| `web/sync-core.js` | Three-way merge and the sync loop (no browser APIs; tested in Node) |
| `web/sync-cloud.js` | Google Drive and OneDrive sign-in and storage |
| `web/sync.js` | When to sync, applying changes, the Sync dialog and top-bar status |
| `web/config.js` | Public client IDs |
| `web/sw.js` | Offline support; app files load network-first so updates arrive on the next launch |
| `web/privacy.html` | Privacy page |
| `tests/` | `node --test tests/sync-core.test.js` |
| `.github/workflows/pages.yml` | Runs the tests and publishes `web/` to GitHub Pages on every push to `main` |
| `PaperDesk.vbs`, `serve_pwa.ps1`, … | Running the app locally from this folder (see below) |
| `_archive_flutter/` | The retired Flutter app (kept locally, not published) |

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `V` `H` `T` `P` `L` | Select · Pan · Text · Draw · Link |
| `B` | Badge tray |
| `N` | Add anything |
| `Ctrl/⌘ K` | Search |
| `Ctrl/⌘ V` | Paste onto the desk (links become web snapshots) |
| `Ctrl/⌘ Z`, `Ctrl/⌘ Shift Z` | Undo, redo |
| `Space` | Quick Look the selected note (Space again closes; ← → browse; `I` toggles info) |
| `F` | Expand the selected note to fill the canvas (`F` or `Esc` to go back) |
| `Ctrl/⌘ A` | Select every note on the desk |
| `Delete` | Delete the selected note or notes (undoable) |
| `Ctrl/⌘ +` `-` `0`, `Shift 1` | Zoom in, out, reset, fit all notes |
| `Esc` | Close Quick Look / back to desk / finish editing / back to Select |

Mouse and touch: the scroll wheel zooms around the cursor; drag on empty paper to draw a selection box around several notes (hold Shift to add to the selection; Shift-click toggles one note; drag any selected note to move them all; `Esc` clears); to pan, use the Pan tool, hold Alt while dragging, drag with the middle mouse button, or use one finger on touch screens; double-click (or double-tap) paper to write; right-click or long-press paper to add at that spot; drag notes to move (snaps to 8 px); drag corners to resize; pinch to zoom on touch screens and trackpads.

## Develop and run locally

```bash
node --test tests/sync-core.test.js
```

To run from this folder without the hosted site: double-click `PaperDesk.vbs` (starts a local server hidden, opens the app, stops the server when you close it), or `Start_PaperDesk_PWA.bat` to serve it on your Wi-Fi for a phone. Sign-in works locally at `http://localhost:8080/` once that address is registered as above. Data saved at a local address is separate from the hosted site's; move it with **Sync** or **Files & backup**.
