// Wires the content scripts to the background and the toolbar popup. Runs in
// every http(s) page's top frame. Nothing here reads or sends page text
// except a field the learner is typing in while writing checks are on, and
// highlighting reads the page only after the learner switches it on.
(() => {
  if (globalThis.glossStarted) return;
  globalThis.glossStarted = true;

  const ext = globalThis.browser ?? globalThis.chrome;
  const ui = globalThis.glossUi;
  const highlight = globalThis.glossHighlight;
  const checks = globalThis.glossChecks;
  let pageChecks = { on: false, offHere: false, globalOff: false, isApp: false };

  async function send(message) {
    try {
      return (await ext.runtime.sendMessage(message)) ?? { ok: false, error: "unavailable" };
    } catch {
      // The extension was reloaded or removed; this page's copy is orphaned.
      if (!ext.runtime?.id) {
        checks.setEnabled(false);
        highlight.stop();
      }
      return { ok: false, error: "unavailable" };
    }
  }

  const loadWords = (force) => send({ type: "words", force });

  const handlers = {
    open: (target) => void send({ type: "open", target }),
    saveMeaning: async (word, meaning) => (await send({ type: "save", text: word, meaning })).ok === true,
  };

  async function refreshChecks() {
    const answer = await send({ type: "page", host: location.hostname, origin: location.origin });
    pageChecks = answer.ok ? answer.checks : { ...pageChecks, on: false };
    checks.setEnabled(pageChecks.on, send, handlers);
  }

  ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender?.id !== ext.runtime.id || !message || typeof message.type !== "string") return false;
    if (message.type === "toast") {
      ui.showToast(message.toast ?? {}, handlers);
      if (message.toast?.tone === "success") void highlight.refresh(loadWords);
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "page-state") {
      sendResponse({
        ok: true,
        host: location.hostname,
        highlight: highlight.state(),
        checks: pageChecks,
        editor: checks.unsupportedEditorOnPage(),
      });
      return false;
    }
    if (message.type === "highlight") {
      if (message.on !== true) {
        highlight.stop();
        sendResponse({ ok: true, highlight: highlight.state() });
        return false;
      }
      highlight.start(loadWords).then(
        (state) => sendResponse({ ok: true, highlight: state }),
        () => sendResponse({ ok: false }),
      );
      return true;
    }
    return false;
  });

  ext.storage.onChanged.addListener((_changes, area) => {
    if (area === "local") void refreshChecks();
  });

  void refreshChecks();
})();
