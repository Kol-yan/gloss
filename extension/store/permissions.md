# Permission justifications

Answers for the **Privacy practices** tab of the developer dashboard. Each
block is short enough to paste into its field. They describe the store build
made by `npm run extension:zip`, whose manifest has the same permissions as
`extension/manifest.json` (it only drops the Firefox-only
`browser_specific_settings` block).

Manifest entries covered:

| Entry | Where | Justified below |
|---|---|---|
| `contextMenus` | `permissions` | yes |
| `storage` | `permissions` | yes |
| `http://*/*`, `https://*/*` | `host_permissions` | yes (one field in the form) |
| `http://*/*`, `https://*/*` | `content_scripts.matches` | same field as the host permissions |

The extension asks for nothing else: no `tabs`, `activeTab`, `scripting`,
`cookies`, `history`, `webRequest` or `<all_urls>`.

## contextMenus

```text
Adds two items to the right-click menu when text is selected: "Add to My words", which saves the selected word or short phrase to the user's gloss word list, and "Check with gloss", which opens the selected text in the gloss editor. The items appear only for a text selection and do nothing until the user clicks one.
```

## storage

```text
Stores the extension's own settings on this device with chrome.storage.local: the gloss server address (https://gloss.li by default), whether writing checks are on, and the list of sites where the user turned checks off. No page text, typed text, word list or page address is stored.
```

## Host permissions (`http://*/*`, `https://*/*`)

```text
The extension's single purpose is to check English writing in text fields on any website the user writes on, so its content script must run on every http and https page: users write emails, comments, forms and chat messages on sites we cannot list in advance. The content script stays idle until the user types in a text field; after a typing pause it sends that field's text to the gloss server for suggestions and underlines them in place. It also marks the user's saved words on a page, but only after the user switches highlighting on in the popup, and it shows the confirmation after "Add to My words". The same access lets the background service worker call the gloss server (https://gloss.li by default, or a self-hosted gloss server the user enters in settings) with the user's gloss session. The extension never sends page addresses, page titles or page text other than the field being checked. Checks can be turned off per site in the popup or for all sites in the settings. Password fields, fields with autocomplete hints (names, emails, card numbers, one-time codes), read-only fields and fields that opt out are never read.
```

### Why `http://*/*` stays, and why there is no separate localhost entry

There is no localhost entry in the manifest. `http://*/*` covers localhost,
but it is there for ordinary sites:

- **Checks on HTTP pages.** People still write on plain-HTTP sites (intranets,
  older forums, router and NAS admin pages). Dropping `http://*/*` would turn
  checks off there without telling the user, against the single purpose.
- **Self-hosted servers on this computer.** The settings accept an HTTPS
  server, or HTTP only on `localhost`/`127.0.0.1` (`parseAppOrigin` in
  `capture.mjs`). The extension calls a server only after
  `chrome.permissions.contains` confirms access to it.

The store build therefore keeps the host permissions unchanged, and nothing
localhost-specific needs to be removed from it. A narrower store build would
need code changes (see "Possible narrowing" below).

### Possible narrowing (not done)

The background only needs host access to the configured server. A later
version could request `https://gloss.li/*` as the only required host
permission, make other servers optional host permissions requested from the
settings page with `chrome.permissions.request`, and keep the all-sites content
script. The install warning would stay the same ("Read and change all your
data on all websites") because of the content script, so this would not
shorten review; it would only reduce what the background can reach.

## Remote code

Answer: **No, I am not using remote code.**

```text
All JavaScript the extension runs is in the package: the service worker (background.js and its ES module imports), the content scripts listed in the manifest, and the popup and options pages, which load only their own packaged scripts. The extension does not load scripts from any server, does not use eval or new Function, and does not inject code into pages from strings. The gloss server returns JSON data only (suggestions, word lists, account status), which the extension validates and renders as text.
```

## Notes for the reviewer (optional "Additional information" or test instructions)

```text
No account is needed. Open https://gloss.li once in the same browser; it starts a free guest workspace automatically and sets the session cookie the extension uses. Then type a sentence with a mistake (for example "Yesterday I go to the shop and buy two apple.") in any textarea and pause for two seconds; underlines appear, and hovering one shows Apply and Dismiss. To save a word, select it, right-click and choose gloss > Add to My words.
```
