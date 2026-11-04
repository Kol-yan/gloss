# gloss browser extension

A Manifest V3 extension for Chrome that brings gloss to the pages you read and
the fields you write in:

- **Add to gloss**: select a word or a short phrase on any site, right-click,
  and choose **Add to gloss**. It is saved to My words, and a small toast
  confirms it and lets you add a meaning in your own words.
- **Highlight my words**: a switch in the toolbar popup marks the words from
  My words on the current page (whole words, any case). Hover a marked word to
  see its meaning.
- **Writing checks**: in text fields on every site, gloss underlines mistakes
  after you pause typing. Hover or click an underline for a card with
  **Apply** and **Dismiss**. Turn checks off for one site in the popup, or for
  all sites in the settings.
- **Check with gloss** (kept from the first draft): opens the selected text in
  the gloss editor.

The extension talks only to your own gloss server. It has no server address
built in other than a local development default.

## Install

Start the gloss server first (for example `npm run dev` in the repository
root, which serves `http://localhost:3000`), then load the extension.

**Chrome, Edge and other Chromium browsers**

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select this `extension` folder.

**Firefox** (128 or later)

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on…** and select `extension/manifest.json`.
3. In `about:addons` → gloss → **Permissions**, allow access to websites if
   Firefox has not granted it. Highlighting and checks need it.

A temporary Firefox add-on is removed when Firefox quits.

Firefox support is a follow-up: this manifest carries Chrome's
`background.service_worker` only. A Firefox build needs its own manifest with a
`background.scripts` entry.

## Set up

1. **Open gloss**: click the toolbar button and choose **Open gloss**, or
   visit [gloss.li](https://gloss.li). The site starts a workspace for a new
   visitor automatically; there is no sign-in screen. The popup shows
   "Open gloss" whenever this browser has no gloss session yet.
2. **Server address** (only for a self-hosted server): open the extension's
   settings (popup → **Settings**) → **Advanced**. The default is
   `https://gloss.li`; an unpacked development build defaults to
   `http://localhost:3000`. Enter the origin (HTTPS, or HTTP on
   `localhost`/`127.0.0.1`) and choose **Save address**. The browser then asks
   to let gloss reach that address.
3. Choose **Check connection** under the same panel. It should say
   "Signed in as …" with the number of checks left today.

Pages that were open before the extension was installed or updated need a
reload before highlighting and checks work there.

## Using it

**Add to gloss.** The selection is trimmed to one line without surrounding
punctuation ("serendipity," becomes "serendipity") and may be up to 80
characters. Saving the same word again, in any case, does not create a
duplicate. A word saved from a page starts without a meaning; choose
**Add a meaning** in the toast to give it one. Chrome and Firefox show the two
gloss menu items under a "gloss" submenu.

**Highlight my words.** The switch applies to the current page until it is
switched off or the page is reloaded. Text in inputs, editable areas, scripts,
styles, code blocks and similar elements is never marked. A word added while
highlighting is on appears right away.

**Writing checks.** After about two seconds without typing, the text of the
field you are in (up to 6,000 characters) is checked on your server. Each
check counts toward your daily allowance, so the extension waits at least
eight seconds between checks of one field, sends at most six checks a minute
in total, and reuses the answer for text it checked recently. When the allowance is used up,
when you are signed out, or when cloud checks are paused, checks stop quietly
and you are told once.

Checks work in textareas, single-line text inputs and rich text editors
(contenteditable). They are never run in password fields, fields with an
autocomplete hint (names, emails, card numbers, one-time codes and so on),
fields marked `spellcheck="false"`, read-only fields, fields that opt out with
`data-gloss="off"`, `data-gramm="false"` or `data-enable-grammarly="false"`,
or on your gloss server's own pages, which have their own checks.

Corrections are underlined in red, style notes in blue. **Apply** changes the
text through the browser's own editing command, so the site sees a normal edit
and Ctrl+Z undoes it. **Dismiss** hides the suggestion for that field. Both
decisions are recorded on the server like decisions in the editor.

## Permissions

| Permission | Why |
|---|---|
| `contextMenus` | The **Add to gloss** and **Check with gloss** items. |
| `storage` | Your settings, on this device only. |
| Host access to `http://localhost/*` | Calls to the default local server with your session cookie. |
| Optional host access (`https://*/*`, `http://127.0.0.1/*`) | Asked for only for the one server address you save; access to a previous custom address is given back when you change it. |
| Content scripts on `http://*/*` and `https://*/*` | Writing checks run on every site by default, and highlighting needs to read the page. Top frames only. |

There is no `tabs`, `history`, `cookies`, `scripting` or `webRequest`
permission, and no file is exposed to web pages.

## Privacy

- **Stored on this device**: the server address, whether writing checks are
  on, and the host names where you turned them off. Nothing else: no text, no
  word list, no page address.
- **Sent to your server**: the word you add; the text of the field you are
  typing in, while writing checks are on for that site; your decisions on
  suggestions. Requests use `fetch` with your session cookie and no referrer.
  No page address or title is ever sent, and nothing lands in browser history.
- **Not sent anywhere**: page text. Highlighting runs on the page; it only
  downloads your word list.
- Everything the extension draws lives in a closed shadow root. Highlights use
  the CSS Custom Highlight API and do not change the page, but a page's own
  scripts can still tell which of its words are highlighted. That is why
  highlighting is off until you switch it on for a page.
- **Check with gloss** puts the selection in the editor's URL fragment, which
  the browser may keep in history. Use **Add to gloss** or the in-field checks
  to avoid that.

Firefox lists the extension as transmitting website content and personal
communications (`data_collection_permissions`), because typed text goes to your
gloss server for checking.

## How it works

Only the background worker talks to the server. Content scripts run inside web
pages, where the page's CORS rules would apply to their requests, so they send
messages to the background instead. The background answers only messages from
this extension, checks their shape, caches the word list for two minutes and
check results by text, and pauses after errors whose answer would not change.

| Server route | Used for |
|---|---|
| `GET /api/me` | Popup and settings: who is signed in, checks left today. |
| `GET /api/expressions` | The word list for highlighting. |
| `POST /api/expressions/capture` | **Add to gloss** and **Add a meaning**. |
| `POST /api/proofread` | Writing checks. |
| `POST /api/suggestions/{id}` | Apply (`accepted`) and Dismiss (`rejected`). |

Files:

| File | Role |
|---|---|
| `manifest.json` | Chrome service worker and Firefox background script, both `background.js`. |
| `background.js` | Context menus, toasts, message routing. |
| `capture.mjs` | Server address rules, words for **Add to gloss**, the editor capture URL. |
| `lib/api.mjs` | Requests to the server and reading their answers. |
| `lib/router.mjs` | Background message handling, caches, pauses, toast wording. |
| `lib/settings.mjs` | Stored settings and per-site checks. |
| `lib/status.mjs` | Popup and settings status lines. |
| `content/*.js` | Content scripts. `words.js` and `edits.js` are pure; `ui.js` draws; `highlight.js` and `checks.js` are the two features; `main.js` wires them up. |
| `popup.*`, `options.*` | Toolbar popup and settings page. |

Content scripts cannot be ES modules, so each one publishes a single
`globalThis.gloss…` object for the scripts loaded after it.

## Development

There is no build step: the folder is loaded as it is. From the repository
root:

```bash
npm test
```

The extension's pure logic (server address rules, word matching, suggestion
positions, message routing, settings, status wording) is covered by
`tests/extension-*.test.ts`, which load the content scripts in a separate
context the way the browser does. The capture route has its own tests in
`tests/server/expressions-capture.test.ts`.

## Status

Verified: the unpacked extension in Chromium 153 against a local gloss server,
after signing in with an invite: saving words through the background, the
toast and **Add a meaning**, highlighting with hover meanings, underlines,
Apply (with undo) and Dismiss in a textarea, a text input and a
contenteditable editor, the popup switches, and that password and
`spellcheck="false"` fields are never sent. The model reply in that run was a
stand-in, not a real provider. Firefox passes `web-ext lint` with no errors.

Not yet verified:

- A real Chrome or Edge install, and any run in Firefox. In Firefox, whether
  the session cookie is sent with the extension's requests (the extension
  relies on it) still needs to be confirmed.
- The real right-click menu (automated browsers cannot open it); its handler
  is unit tested and shares the save and toast path checked above.
- Popular sites and editors (webmail, chat apps, ProseMirror, Lexical,
  Draft.js), HTTPS servers with the optional permission prompt, and
  visitor-funded (BYOK) workspaces.

## To do

1. **Meanings for saved words**: a word added from a page has no meaning until
   the learner types one. Add a budgeted server-side lookup, or suggest one.
2. **Contract and docs**: move the capture route's schemas into
   `src/shared/contracts.ts`, and describe the route and the extension's
   stored settings in `ARCHITECTURE.md`.
3. **Schema**: every expression must point at a suggestion, so a captured word
   gets a check run (provider `capture`, model `none`) and an accepted
   suggestion of its own. A migration with a nullable `suggestion_id` and a
   `source` column would be cleaner.
4. **Quota-friendly checks**: run the editor's local rule checker in the
   extension and use `POST /api/detect` to choose sentences before a
   proofreading call, as the editor does. Today every pause in a changed field
   costs one check, which a pilot allowance (20 a day) uses up quickly.
5. **Long fields**: text over 6,000 characters is not checked; check by
   paragraph instead.
6. **Frames and shadow DOM**: fields in iframes (some webmail and CMS editors)
   and inside closed shadow roots are not reached.
7. **Rich editors**: underlines are clipped to the editor box and the window,
   not to scrolled containers; editors that change text without input events
   hide underlines until the next edit. Canvas-based editors are not supported.
8. **Keyboard and screen readers**: a shortcut to open the card at the caret,
   focus handling inside the card, and announcements for new suggestions.
9. **Expression suggestions** from checks are hidden in fields; offer them with
   **Add to My words**, as the editor does.
10. **Stale decisions**: record `stale` when an edit invalidates a suggestion.
11. **Highlighting**: inflected forms ("run" for "running") and phrases split
    across elements are not matched; offer "always highlight on this site".
12. **Visitor (BYOK) workspaces**: checks need the visitor's own key, which
    stays in the editor tab; this needs a design.
13. **Sign-in**: a pairing token for the extension would not depend on how
    each browser treats cookies on extension requests.
14. **Packaging**: icons, a zip for store review, store listings.
