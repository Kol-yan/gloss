# Data usage disclosure

Answers for the **Privacy practices → Data usage** section of the developer
dashboard, checked against the code of version 0.3.0. "The server" is the gloss
server the extension is configured for: `https://gloss.li` unless the user
enters a self-hosted address in the settings.

## What the extension does with data, in one table

| Data | When | Where it goes | Kept |
|---|---|---|---|
| Text of the text field the user is typing in (8 to 6,000 characters, at least two words) | About two seconds after the user stops typing, while checks are on for that site; at most one check per field every eight seconds and six per minute in total (`content/checks.js`, `lib/router.mjs`) | `POST /api/proofread` on the server, which sends it to a third-party AI model provider to get suggestions | Server: a SHA-256 hash of the text, its length, the model and timing, and each suggestion (the short original fragment, the replacement, the reason). The full text is not stored. Extension: the last 40 answers in the service worker's memory, gone when the worker stops |
| A selected word or phrase (up to 80 characters) and an optional meaning the user types | Only when the user chooses **Add to My words** / **Add a meaning** | `POST /api/expressions/capture` | Server: in the user's My words until the workspace is deleted |
| The user's Apply or Dismiss choice on a suggestion | When the user clicks it | `POST /api/suggestions/{id}` (suggestion id, decision, text hash; no text) | Server: the decision on that suggestion |
| The user's word list | When highlighting is switched on or a word is added | Downloaded from `GET /api/expressions` | Extension: service worker memory for two minutes |
| Account status | When the popup opens, or **Check connection** is clicked in the settings | Downloaded from `GET /api/me` | Not kept |
| Selected text for **Check with gloss** | Only when the user chooses it | Opens a new tab at `<server>/#text=…`. The text is in the URL fragment, which is not sent to the server; the gloss editor reads it in the page. The browser may keep that URL in history | Browser history, as with any page |
| Settings: server address, checks on or off, sites where checks are off | When the user changes them | `chrome.storage.local`, this device only | Until changed or the extension is removed |
| Page host name and origin | When a page loads | Content script → service worker only, to decide whether checks run there. Never sent to the server | Not kept |

Every request goes from the service worker with `fetch`, `credentials:
"include"` (the user's gloss session cookie, set by the gloss website),
`referrerPolicy: "no-referrer"` and `redirect: "error"`. No request carries
the page address, the page title or other page text. Highlighting reads the
page in the browser only.

Never read: password fields, inputs with an autocomplete hint other than
`on`/`off` (names, emails, addresses, card numbers, one-time codes), fields
whose name, id, label or placeholder suggests a password, token, key, PIN or
card, read-only and disabled fields, fields marked `data-gloss="off"`,
`data-gramm="false"` or `data-enable-grammarly="false"`, single-line inputs
with `spellcheck="false"`, code editors (Ace, Monaco, CodeMirror), iframes,
and the gloss website's own pages (`content/edits.js`, `lib/settings.mjs`).

## Form answers

"What user data do you plan to collect from users now or in the future?"
Tick:

| Category | Tick | Why |
|---|---|---|
| Personally identifiable information | No | The extension asks for no name, email, address or ID. Typed text may happen to contain such details; it is declared under website content and personal communications below. |
| Health information | No | — |
| Financial and payment information | No | Card-number and payment fields are skipped. |
| Authentication information | No | Password, one-time-code and similar fields are never read. The extension uses the gloss session cookie that the gloss website sets, but it does not read, store or send it anywhere other than the gloss server that issued it. |
| Personal communications | **Yes** | The text field being checked can be an email, a chat message or a comment. Its text is sent to the gloss server for checking. |
| Location | No | No location or IP address is collected by the extension. |
| Web history | No | No page address, title or list of visited pages is sent or stored. The list of sites where the user turned checks off stays on the device. |
| User activity | No | Keystrokes, clicks, mouse movement and scrolling are not recorded or sent. The extension waits for a pause in typing and then sends the field's resulting text (declared above). An Apply or Dismiss click on a gloss suggestion is sent as a decision on that suggestion. |
| Website content | **Yes** | The text the user types in a field and the words they choose to save. |

Certifications (tick all three):

- **I do not sell or transfer user data to third parties, outside of the approved use cases.** Text sent for checking is passed to third-party AI model providers only to produce the suggestions the user asked for; it is not sold, shared for advertising or passed to data brokers.
- **I do not use or transfer user data for purposes that are unrelated to my item's single purpose.** The data is used only to check the user's writing and keep their word list.
- **I do not use or transfer user data to determine creditworthiness or for lending purposes.**

Privacy policy URL: `https://gloss.li/privacy`

## What the server keeps, for reference

From the extension's requests, the server stores, per workspace:

- each check: an id, a hash and the length of the checked text, the model and
  provider, status, latency and cost;
- each suggestion: the original fragment, the replacement, the reason, its
  category and the user's decision;
- My words entries: the word or phrase, the meaning, and practice progress;
- usage counters for the daily allowance.

The full text of a checked field is not stored. Model requests through
OpenRouter ask for providers that do not collect data
(`data_collection: "deny"` in `src/server/models/openrouter.ts`); that is a
routing request, not an independent guarantee of zero retention. Server logs
leave out learner text.

Workspaces have no sign-in. A guest workspace lasts as long as its session
cookie (renewed on use, up to 365 days without use); there is no automatic
deletion of old workspaces and no self-service delete button yet. The privacy
policy tells users how to ask for deletion.
