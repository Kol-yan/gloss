# gloss desktop

A menu-bar app (tray icon on Windows and Linux) that brings gloss to every app
on your computer:

- **Check selected text.** Select text anywhere and press **⌃⌥G**
  (Control+Option+G; Ctrl+Alt+G on Windows and Linux). A small panel shows the
  suggestions from your gloss server; **Apply** pastes the corrected text over
  your selection.
- **Push-to-talk dictation.** Hold **⌃⌥D**, speak, and let go. The cleaned-up
  text (punctuation added, fillers removed, your words unchanged) is pasted
  where you are typing. A quick tap starts hands-free recording; tap again to
  stop. Recordings end at 60 seconds.
- **Settings** for the server address, sign-in and both shortcuts.

The app is built with [Tauri 2](https://tauri.app): a Rust core with two small
web views (settings and the panel). It talks to the same gloss server as the
web editor and uses its existing API; it has no server code of its own.

> **Status.** macOS gets the first polish, but this code has **not yet been run
> on a real Mac**. Everything macOS-specific type-checks against the macOS
> target and has a GitHub Actions build, but the Accessibility, pasteboard,
> keystroke and microphone paths have only been exercised through their
> Linux counterparts. See [What has been tested](#what-has-been-tested).

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

   and create an invite for the desktop app:

   ```bash
   npm run invite -- --label desktop --uses 1 --profile owner
   ```

2. **Start the desktop app** in development mode:

   ```bash
   cd desktop
   npm install
   npm run tauri dev
   ```

   The first build compiles the Rust dependencies and takes a few minutes. A
   **g** icon appears in the menu bar and the settings window opens.

3. **Sign in.** Paste the invite link into **Invite link** and choose
   **Sign in**. The server address defaults to `http://localhost:3000`; change
   it under **Server** if yours runs elsewhere.

4. **Allow Accessibility.** gloss reads your selection and pastes text back
   through the Accessibility API. Open **System Settings → Privacy & Security →
   Accessibility** (the settings window has a button for it) and turn on:
   - the terminal you ran `npm run tauri dev` from, while developing (macOS
     gives a process started from a terminal the terminal's permissions), or
   - **gloss**, for the bundled app.

   The settings window shows **Allowed** once it is on.

5. **Try it.** Select a sentence in any app, for example *He go to school
   yesterday.* in TextEdit or Notes, and press **⌃⌥G**. In the panel, tick the
   changes you want and choose **Apply** (or press **⌘↩**). **Copy** puts the
   corrected text on the clipboard instead; **Esc** closes the panel and returns
   you to your app.

6. **Dictate.** Click into a text field, hold **⌃⌥D**, speak, and let go.
   The menu bar shows *Listening…* and then *Transcribing…*. macOS asks for
   microphone access the first time.

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

## Signing in

The desktop app uses the web app's own sessions; there is no separate account.

- **Invite link** (recommended). The app redeems the link exactly like the
  **Continue** button on the invite page (`POST /join/{token}/continue`) and
  keeps the session cookie the server sets. This starts a new gloss workspace
  for the desktop app, and spends one use of the invite. **Sign out** ends that
  session on the server.
- **Session from your browser.** To share one workspace with the web editor,
  open the developer tools in the browser where you are signed in to gloss,
  copy the value of the `glossy_session` cookie for your server, and paste it
  under **Use the session from your browser instead**. Signing out of the
  desktop app then only forgets the session on this computer, so the browser
  stays signed in.

Visitor workspaces that use their own OpenRouter key are not supported yet:
the app does not send that key.

The server address must be `https://…`, or `http://` on this computer
(`localhost`, `127.0.0.1`, `[::1]`), because the session travels with every
request. Sessions are stored per server address, so a session is never sent
to a server that did not issue it.

## Privacy

- The session token is stored in the macOS Keychain (Credential Manager on
  Windows, Secret Service on Linux), never in a file or a log. Without a
  usable credential store it is kept in memory until the app quits, and the
  settings window says so.
- Selected text leaves your computer only when you press the check shortcut,
  and goes only to your gloss server. Applied suggestions are recorded as
  accepted, as in the web editor.
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
├── settings.html, panel.html     the two windows (Vite + TypeScript, no framework)
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
        ├── credentials.rs        per-server sessions in the system credential store
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
npm run build                # type-check and build the two windows
cd src-tauri
cargo test                   # unit tests
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

`npm run tauri dev` runs the app with the Vite dev server; `npm run tauri
build` makes a release bundle for the current platform.

A live test talks to a running gloss server and spends one invite:

```bash
GLOSS_TEST_SERVER=http://localhost:3000 \
GLOSS_TEST_INVITE="http://localhost:3000/join/<token>" \
cargo test live_server_round_trip -- --ignored --nocapture
```

On Linux, Tauri needs the WebKitGTK development packages; on Debian or
Ubuntu:

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libasound2-dev
```

The repository's root checks (`npm run lint`, `npm run typecheck`) include the
TypeScript in `desktop/src`, which is why it uses no npm runtime packages. After
a local desktop build, the root lint also reports warnings for a file Tauri
generates under `desktop/src-tauri/target`; `cargo clean` removes it.

## What has been tested

On Linux (Ubuntu 24.04, a virtual X display, the gloss dev server with stand-in
model endpoints):

- `cargo check`, `cargo clippy` and `cargo test` (35 unit tests: text ranges,
  edit application, server address rules, cookie and invite parsing, error
  mapping, WAV encoding and resampling, the push-to-talk state machine, and the
  clipboard save-and-restore logic against a fake platform), plus the frontend
  build and type check.
- `cargo check` and `cargo clippy` for `aarch64-apple-darwin`, which compiles
  every macOS-only line against the real macOS bindings.
- The live API test above against the dev server: invite redemption, `/api/me`,
  a spent invite, error mapping, upload format and sign-out.
- The whole app, end to end: signing in through the settings window, selecting
  text in a browser and pressing the check shortcut (selection copied through
  the clipboard, `/api/proofread` called, the panel showing the server's
  answer), and holding the dictation shortcut with a file-fed microphone
  (a valid 16 kHz mono WAV uploaded, the cleaned transcript pasted into the
  browser's text field).

Not tested yet:

- **Anything on a real Mac**: the menu-bar icon, Accessibility selection
  reading, Quartz Copy and Paste, pasteboard restore, focus return, the
  microphone and its permission prompt, panel placement, and the bundle built
  by GitHub Actions (the workflow has not run yet).
- A real proofreading answer in the panel with the app running: the test server
  had no model key for proofreading, so the panel showed the server's
  *switched off* message; the suggestion view was checked in a browser with the
  same data shape.
- Windows, and Linux under Wayland.

## Next steps

- Run through the steps above on a Mac and tune the timings in
  `selection.rs` (copy timeout, paste settle time) for slow apps.
- Native selection access for Windows (UI Automation) and Linux (AT-SPI), and
  focus tracking on both.
- Show the panel next to the selection rather than the pointer, using the
  Accessibility bounds of the selected range.
- Turn an accepted *Expression* suggestion into practice from the panel, as the
  web editor does.
- Start at login, Developer ID signing and notarization, and updates.
- Support visitor workspaces that bring their own OpenRouter key.
