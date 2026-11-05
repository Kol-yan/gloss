# gloss desktop

Status: macOS beta; microphone dictation still needs a manual check.

A menu-bar app (tray icon on Windows and Linux) that brings gloss to every app
on your computer:

- **Check selected text.** Select text anywhere and press **⌃⌥G**
  (Control+Option+G; Ctrl+Alt+G on Windows and Linux). A small panel shows the
  suggestions from your gloss server; **Apply** pastes the corrected text over
  your selection.
- **Push-to-talk dictation.** Hold the **right Option** key (`⌥` on the right
  of the keyboard), speak, and let go. The cleaned-up text (punctuation added,
  fillers removed, your words unchanged) is pasted where you are typing. A
  quick tap starts hands-free recording; tap again to stop. Recordings end at
  60 seconds. On Windows and Linux, hold **Ctrl+Alt+D** instead.
- **Check as you type.** While you type in another app, gloss checks after a
  short pause and shows a small badge with the number of fixes beside the
  field; click it to open the suggestions and apply them in place.
- **Settings** with the two shortcuts, the permission status, the
  "Check as I type" switch and the server address under **Advanced**. A guest
  workspace is created automatically.

The app is built with [Tauri 2](https://tauri.app): a Rust core with three small
web views (settings, panel and badge). It talks to the same gloss server as the
web editor and uses its existing API; it has no server code of its own.

## Run it on macOS

You need macOS 11 or later, the Xcode command line tools
(`xcode-select --install`), [Rust](https://rustup.rs) and Node.js 22.12 or
later (the repository uses Node 26), plus a gloss server.

1. **Start a gloss server** from the repository root (see the main
   [README](../README.md)):

   ```bash
   npm install
   cp .env.example .env.local   # fill in your keys
   npm run dev
   ```

2. **Start the desktop app** in development mode:

   ```bash
   cd desktop
   npm install
   npm run tauri dev
   ```

   The first build compiles the Rust dependencies and takes a few minutes. A
   **g** icon appears in the menu bar and the settings window opens.

3. **Guest workspace.** On first launch the app creates its own guest workspace on
   the server, the same guest a first visit to the website gets, under the
   same per-IP limit and spend caps. A development build uses
   `http://localhost:3000`; change it under **Advanced** if yours runs
   elsewhere.

4. **Allow Accessibility.** gloss reads your selection and pastes text back
   through the Accessibility API. Open **System Settings → Privacy & Security →
   Accessibility** (the settings window has a button for it) and turn on:
   - the terminal you ran `npm run tauri dev` from, while developing (macOS
     gives a process started from a terminal the terminal's permissions), or
   - **gloss**, for the bundled app.

   The settings window has a link to this pane.

5. **Try it.** Select a sentence in any app, for example *He go to school
   yesterday.* in TextEdit or Notes, and press **⌃⌥G**. In the panel, tick the
   changes you want and choose **Apply** (or press **⌘↩**). **Copy** puts the
   corrected text on the clipboard instead; **Esc** closes the panel and returns
   you to your app.

6. **Dictate.** Click into a text field, hold the **right Option** key, speak,
   and let go. The menu bar shows *Listening…* and then *Transcribing…*.
   macOS asks for microphone access the first time.

### Build a bundle

```bash
cd desktop
npm run tauri build -- --bundles app,dmg
```

The app is in `src-tauri/target/release/bundle/macos/gloss.app` and the disk
image in `src-tauri/target/release/bundle/dmg/`. For one bundle that runs on
both Apple silicon and Intel:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin --bundles app,dmg
```

### Use the build from GitHub Actions

The **Desktop app (macOS)** workflow (`.github/workflows/desktop-macos.yml`)
builds a universal bundle on every change under `desktop/` and can be started
by hand. Download the `gloss-macos-universal` artifact from the run, unzip it
and move `gloss.app` to **Applications**.

Without signing secrets the app is only ad-hoc signed, so macOS refuses to
open it at first. Either Control-click it and choose **Open**, or remove the
download quarantine:

```bash
xattr -dr com.apple.quarantine /Applications/gloss.app
```

macOS ties the Accessibility permission to the app's signature, and every
ad-hoc build has a new one: after installing a new build, turn gloss off and
on again in the Accessibility list. To sign and notarize instead, add the
repository secrets `APPLE_CERTIFICATE` (base64 `.p12`),
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
`APPLE_PASSWORD` (an app-specific password) and `APPLE_TEAM_ID`.

## Workspace and permissions

The desktop app creates a guest workspace automatically through the web app's guest sessions.

- On first launch it calls `POST /api/access/guest/desktop` and keeps the
  session cookie the server sets in memory and a user-only guest session
  file in the app config directory. The route creates the same guest learner the
  website gives a first visitor, without Turnstile, which a native app cannot
  show; the per-IP daily limit and the server spend caps still apply.
- A stored session is reused. Only a server refusal of that session starts a
  replacement guest; running out of daily checks never resets the workspace.
- **Check as I type** is on by default and can be switched off in Settings.

Assets the app needs on macOS (System Settings → Privacy & Security):

- **Accessibility**: read the selection and paste the corrected text back, and
  notice the right Option key.
- **Microphone**: dictation.

Visitor workspaces that use their own OpenRouter key are not supported yet:
the app does not send that key.

The server address must be `https://…`, or `http://` on this computer
(`localhost`, `127.0.0.1`, `[::1]`), because the session travels with every
request. Sessions are stored per server address, so a session is never sent
to a server that did not issue it.

## Privacy

- Guest session tokens are stored per server in `guest-sessions.json` in the
  app config directory, atomically replaced with Unix permissions `0600`.
  macOS attempts one silent migration of each old Keychain session, skipping
  anything that requires a prompt. Normal use never reads or writes Keychain.
  If the file cannot be saved, the workspace lasts only until the app quits.
- With **Check as I type** enabled, the focused editable field is sent to
  your gloss server after a typing pause. The check shortcut sends the selected
  text. Applied suggestions are recorded as accepted, as in the web editor.
- To read a selection that an app does not expose through Accessibility, gloss
  sends Copy, reads the clipboard and puts your previous clipboard back. To
  insert text it does the same with Paste. On macOS every representation on
  the clipboard (text, rich text, images, files) is restored, and the temporary
  text is marked so clipboard history tools skip it.
- Audio is recorded only while dictation runs, kept in memory, sent to your
  server as a WAV file (16 kHz mono) and never written to disk.
- Logs (in the app's log folder and the terminal) never contain selected text,
  transcripts or tokens.

## How it works

```text
desktop/
├── settings.html, panel.html, badge.html  the three windows (Vite + TypeScript, no framework)
├── src/                          window code; bridge.ts wraps window.__TAURI__
└── src-tauri/
    ├── tauri.conf.json           windows, bundle, CSP
    ├── Info.plist                microphone purpose, no Dock icon
    ├── capabilities/             what the windows may call
    └── src/
        ├── lib.rs                plugins, tray, shortcuts, window events
        ├── api.rs                gloss API client (mirrors src/shared/contracts.ts)
        ├── check.rs              selection → /api/proofread → panel → paste
        ├── dictation.rs          push-to-talk state machine → /api/speech/dictate
        ├── selection.rs          read the selection, paste text, restore the clipboard
        ├── platform/             operating-system services behind small traits
        │   ├── mod.rs            Platform and Clipboard traits
        │   ├── macos.rs          Accessibility API, Quartz events, NSPasteboard
        │   └── portable.rs       Windows and Linux: clipboard copy and paste
        ├── audio.rs, wav.rs      microphone capture and the WAV the server accepts
        ├── text.rs               NFC normalization and UTF-16 ranges, as in src/lib/text
        ├── credentials.rs        per-server guest sessions in a user-only file
        ├── settings.rs           settings file and server address rules
        ├── shortcuts.rs          global shortcuts and their labels
        ├── tray.rs, windows.rs   menu-bar icon and window placement
        └── state.rs, commands.rs app state and the commands the windows call
```

- **Checking.** The selection is normalized like the web editor does (NFC,
  `\n` line endings) and sent to `POST /api/proofread` (at most 6,000 UTF-16
  units, like the editor). Suggestions carry UTF-16 ranges; the Rust core
  applies only edits whose original fragment still matches, never overlapping
  ones, and never chooses an edit flagged as changing the meaning. Before
  pasting, the app returns focus to the app you came from and, where the
  Accessibility API can tell, checks that the same text is still selected.
- **Dictation.** The default microphone is recorded at its own rate, mixed
  to mono, resampled to 16 kHz and sent to `POST /api/speech/dictate`, the
  route that adds the word-preserving clean-up. (`/api/speech/transcribe` is
  the practice route: it needs a practice attempt and returns the raw
  transcript.) Silence is caught before upload; macOS delivers silence while
  microphone access is denied.
- **Platforms.** `Platform` covers focus tracking, reading the selection,
  sending Copy and Paste, the clipboard and permissions. macOS implements all
  of it natively. Windows and Linux use the portable fallback (clipboard copy
  and paste through synthesized Ctrl+C and Ctrl+V, plain text only); their
  native implementations (UI Automation, AT-SPI, foreground-window tracking)
  can replace it piece by piece. Linux needs an X11 session or XWayland for
  global shortcuts and synthesized keys.

## Development

```bash
cd desktop
npm install
npm run build                # type-check and build the three windows
cd src-tauri
cargo test                   # unit tests
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

`npm run tauri dev` runs the app with the Vite dev server; `npm run tauri
build` makes a release bundle for the current platform.

On Linux, Tauri needs the WebKitGTK development packages; on Debian or
Ubuntu:

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libasound2-dev
```

The repository's root checks (`npm run lint`, `npm run typecheck`) include the
TypeScript in `desktop/src`, which is why it uses no npm runtime packages. After
a local desktop build, the root lint also reports warnings for a file Tauri
generates under `desktop/src-tauri/target`; `cargo clean` removes it.


### Debug loopback helper

Debug builds enable the loopback helper only when the app config directory
contains `test-hook.json` with a `token` field containing a freshly generated
32-byte random token as 64 hexadecimal digits. Generate it locally with a
cryptographic random generator. Send the token in the `X-Gloss-Test-Token`
header for each request to `127.0.0.1:4211`. Requests with an `Origin`
header are refused, including requests with a valid token. The helper and
its simulation IPC commands are excluded from release builds. Remove the
marker when finished.
