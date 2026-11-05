# gloss desktop

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
  "Check as I type" switch and the server address under **Advanced**. There is
  no sign-in.

The app is built with [Tauri 2](https://tauri.app): a Rust core with two small
web views (settings and the panel). It talks to the same gloss server as the
web editor and uses its existing API; it has no server code of its own.

> **Status.** The macOS build compiles, runs from the menu bar and its
> Accessibility, shortcut and clipboard paths are exercised on a real Mac;
> the microphone path still needs a manual check. See
> [What has been tested](#what-has-been-tested).

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

3. **No sign-in.** On first launch the app creates its own guest workspace on
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

The desktop app uses the web app's guest sessions; there is no separate
account and no sign-in screen.

- On first launch it calls `POST /api/access/guest/desktop` and keeps the
  session cookie the server sets in memory and an owner-only guest session
  file in the app config directory. The route creates the same guest learner the
  website gives a first visitor, without Turnstile, which a native app cannot
  show; the per-IP daily limit and the owner spend caps still apply.
- **Start a new workspace** under **Advanced** ends the session and creates a
  fresh guest, for example after today's free demo is used up. If the server
  refuses the stored session (an expired guest, a server that renamed its
  cookie), the app quietly starts a new guest and repeats the request once.

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
        ├── credentials.rs        per-server guest sessions in an owner-only file
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

A live test talks to a running gloss server with a session cookie from a
guest browser window (open the site, then copy `glossy_session_<port>` from the
developer tools; never commit it):

```bash
GLOSS_TEST_SERVER=http://localhost:3000 \
GLOSS_TEST_INVITE=guest \
GLOSS_TEST_COOKIE="glossy_session_3000=<value>" \
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

- macOS (Apple silicon, the debug app run from a terminal with real
  permissions): shortcut registration, the Accessibility-granted path, the
  settings window with the icon set, and the gate commands
  (`cargo test`, `npm run typecheck`, `npm run build`, `npm run tauri build`).
  A synthesized Control+Option+G from another process still needs a manual
  pass, because macOS only accepts synthetic keystrokes from a process the
  owner has allowed to control the computer.
- Linux (Ubuntu 24.04, a virtual X display, the gloss dev server with stand-in
  model endpoints):

- `cargo check`, `cargo clippy` and `cargo test` (43 unit tests: text ranges,
  edit application, server address rules, cookie and invite parsing, error
  mapping, WAV encoding and resampling, the push-to-talk state machine and its
  right Option key classification, and the clipboard save-and-restore logic
  against a fake platform), plus the frontend build and type check.
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
