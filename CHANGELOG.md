# Changelog

Changes to the gloss website and server. The browser extension and the
desktop app have their own changelogs in
[extension/CHANGELOG.md](extension/CHANGELOG.md) and
[desktop/CHANGELOG.md](desktop/CHANGELOG.md).

## 1.0.0 — First public release

### Features

* **Editor.** Write in English and get grammar and punctuation checks right in
  your browser; your text is not uploaded for these.
* **AI checks.** After a short pause, sentences that need a fix are flagged.
  The **AI** tab, or **Check with AI**, shows corrections and up to three
  expressions worth learning, each with a one-line meaning.
* **Dictation in the editor.** Speak instead of typing; punctuation is added
  and fillers are dropped, but your own words are kept.
* **Keep this expression.** Accepting an expression lets you add it to your
  practice list and say how well you already know it.
* **Practice rounds.** Short rounds that move from recognition to recall:
  choose the meaning, choose the expression that fits, fill the gap, then type
  the expression from memory for a situation. A hint is there when you need it.
* **Spoken answers.** Answer a practice task by voice and confirm the
  transcript before it is judged. Recordings are never stored.
* **Spaced review.** A correct answer from memory without a hint schedules the
  next review later; other answers bring the word back sooner.
* **My words.** Every saved word or expression with its evidence: used with
  help, written and spoken attempts, from memory and hint used. Words can be
  played aloud, with their US pronunciation where it is known.
* **Getting started.** Pick your English level, take a short word check, and
  start with a set of words chosen for you.
* **No sign-in.** The first visit starts a guest workspace with a daily
  allowance. Invite links raise it, and adding your own OpenRouter key in
  **Settings** removes the usage quotas.
* **Browser extension and desktop app support.** The server saves words from
  the browser extension and gives the desktop app its own guest workspace.
* **Self-hosting.** One Docker image with a SQLite database, daily and period
  spend caps, and optional Telegram alerts when spending nears the cap.
