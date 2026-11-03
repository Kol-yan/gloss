# gloss browser extension

A small Manifest V3 extension that opens selected English text in the gloss web
editor. It does not check text itself or call a model.

## Load the unpacked extension

1. Open `chrome://extensions` in Chrome and turn on Developer mode.
2. Choose **Load unpacked** and select this `extension` folder.
3. Open the extension's **Details → Extension options** and save your editor
   address. The default is `https://gloss.li`. For a private local test, use the
   loopback address where your editor is available, such as
   `http://localhost:13320`.
4. Sign in to that editor in the same browser first.
5. Select text on an ordinary web page, open its context menu, and choose
   **Check with gloss**. Review the imported text before choosing a cloud check.

Selections over 6,000 UTF-16 code units open an explanatory editor state without
the text. The extension never silently cuts a selection short. Line endings and
Unicode composition are normalized; the remaining text is preserved.

## Permissions and privacy

- `contextMenus` adds the selection action; `storage` saves only the editor
  origin locally. There are no host permissions, content scripts, or browsing
  history permissions.
- Opening a new tab with `chrome.tabs.create` does not require the `tabs`
  permission. The extension does not read existing tab URLs or titles.
- Selected text is placed in a URL fragment (`#text=...`), not a query. Fragments
  are not sent in HTTP requests, but the target page can read them and the browser
  may retain the URL in history. Use an editor address you trust. The editor
  removes the capture fragment after importing it.
- No provider keys, page URL, page title, selected text, or transcript is stored
  by the extension. It makes no model request and writes no selection logs.
- A storage or invalid-address failure opens settings instead of falling back
  to another destination.

The web application must support the capture fragment contract for this draft
to import text. Browser installation and manual integration testing have not yet
been performed; Chrome behavior and support on other browsers are unverified.
No extension-store package has been published.

## Capture contract

The worker normalizes the selection to NFC and `\n` line endings, preserving
surrounding whitespace. An empty or whitespace-only selection does nothing.

- Up to 6,000 UTF-16 code units: `/#text=<URLSearchParams-encoded selection>`.
- Longer selection: `/#capture=too-long`, with no text included.

The destination must be an HTTPS origin or HTTP loopback origin (`localhost` or
`127.0.0.1`). Paths, queries, fragments and embedded sign-in details are rejected.

API references: [context menus](https://developer.chrome.com/docs/extensions/reference/api/contextMenus),
[tabs permissions](https://developer.chrome.com/docs/extensions/reference/api/tabs),
[local storage](https://developer.chrome.com/docs/extensions/reference/api/storage),
[options pages](https://developer.chrome.com/docs/extensions/develop/ui/options-page).
