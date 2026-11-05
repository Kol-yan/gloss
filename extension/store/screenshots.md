# Store screenshots

Five screenshots, each exactly **1280×800** PNG (the store also accepts
640×400; use 1280×800). No device frames, no text overlays that promise more
than the extension does, no other brands' pages. Every shot uses the demo page
in this folder so the content is the same each time.

## Setup (once)

1. Use a fresh Chrome profile (avatar menu → **Add** → continue without an
   account), so no other extensions or bookmarks show. Language: English.
2. Build and install the store package:
   ```bash
   npm run extension:zip
   ```
   Unzip `dist/gloss-extension-<version>.zip` to a folder, then
   `chrome://extensions` → **Developer mode** → **Load unpacked** → that folder.
   Pin gloss to the toolbar (puzzle icon → pin).
3. Open `https://gloss.li` once in this profile so it starts the guest
   workspace. Close the tab.
4. Serve the demo page from the repository root:
   ```bash
   python3 -m http.server 8080 --directory extension/store
   ```
   Open `http://localhost:8080/demo.html`. (The page must be served over
   HTTP; gloss does not run on `file://` pages.)
5. Make the browser window 1280×800 points. On macOS:
   ```bash
   osascript -e 'tell application "Google Chrome" to set bounds of front window to {0, 25, 1280, 825}'
   ```
   Capture the window with **⌘⇧4**, **Space**, then **⌥-click** the window (no
   shadow). On a Retina screen the file is 2560×1600; scale it to exactly
   1280×800 in Preview (**Tools → Adjust Size**). For shot 3, where the menu is
   outside the window, use **⌘⇧5 → Capture Selected Portion** over the window
   area instead.
6. Light mode, zoom 100%, bookmarks bar hidden (**⌘⇧B**).

Model answers vary. If a shot does not show what is listed under "must be
visible", clear the field and type the text again, or wait a minute and retry.
Each check uses one of the day's free checks (30), so plan the session.

## 1. Mistakes underlined, fix card open

- **Page:** `http://localhost:8080/demo.html`
- **Type** in **Reply to the team**:
  ```text
  Hi all, yesterday I have went to the new office and it is more bigger than I expect. Can we meet on next Monday to discuss about the move?
  ```
- Wait about three seconds, then hover the underline on **have went**.
- **Must be visible:** at least three red underlines in the textarea; the card
  under **have went** with the replacement, its short reason and the **Apply**
  and **Dismiss** buttons; the gloss icon in the toolbar. No popup open.

## 2. Style note in a rich text field

- **Page:** same tab. Clear **Reply to the team** first (select all, delete)
  so its underlines are gone.
- **Type** in **Your notes**:
  ```text
  In my opinion I think the meeting was very very useful and we got a lot of good ideas.
  ```
- Wait about three seconds, then hover a **blue** underline.
- **Must be visible:** a blue underline (style note) in the notes field and its
  open card with **Apply** and **Dismiss**. If the answer has only red
  underlines, take the shot with the card of one of them and use it as shot 2
  only if shot 1 already shows a different sentence.

## 3. Add to My words from the right-click menu

- **Page:** same tab, fields empty.
- Double-click **serendipity** in the first paragraph, right-click it, point at
  **gloss**.
- **Must be visible:** the word selected; the context menu open with the
  **gloss** submenu showing **Add to My words** (highlighted) and **Check with
  gloss**.

## 4. Word saved, with a meaning

- **Page:** same tab. Choose **Add to My words** from shot 3.
- In the toast, choose **Add a meaning** and type:
  ```text
  a lucky discovery you were not looking for
  ```
  Take the shot before pressing Enter.
- **Must be visible:** the toast **Added “serendipity” to My words.** with the
  meaning field filled in; the selected word in the paragraph.
- Then press Enter to save the meaning.

## 5. My words highlighted on the page, popup open

- **Before the shot:** add **meticulous** and **keep track of** the same way
  as shot 4 (select, right-click, **Add to My words**, add a meaning: "very
  careful about every detail" and "keep a record of what happens"). Reload
  the page.
- **Page:** `http://localhost:8080/demo.html`, fields empty.
- Click the gloss toolbar button and turn on **Highlight My words**.
- **Must be visible:** the popup with **Connected to gloss · N of 30 checks
  left today**, the **Check writing on this site** switch on with `localhost`,
  **Highlight My words** on and the line **3 words from My words are marked on
  this page.**; behind it, serendipity, meticulous and keep track of marked in
  the paragraph.

## Optional sixth shot

The settings page (popup → **Settings**) with **Check my writing in text
fields on all sites** and the empty **Sites where checks are off** list, to show
the controls. Not needed for review.

## Small promo tile

The dashboard also asks for a 440×280 small promo tile. A plain tile works: the
icon from `extension/icons/icon-128.png` and the word gloss in the brand serif
on the paper colour `#f4efe7`, with the line "Check your English as you type".
