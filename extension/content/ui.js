// Everything gloss draws on a page lives in one closed shadow root: page
// styles cannot restyle it and page scripts cannot reach into it. Text from
// the server or the learner is only ever set with textContent.
(() => {
  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel {
      position: fixed; pointer-events: auto; z-index: 1;
      font: 14px/1.45 "Avenir Next", "Segoe UI", "Helvetica Neue", system-ui, sans-serif;
      color: #203139; background: #fffdf9; border: 1px solid #d6cec1; border-radius: 14px;
      box-shadow: 0 18px 40px -22px rgb(32 49 57 / 0.45), 0 2px 8px rgb(32 49 57 / 0.12);
    }
    p { margin: 0; }
    button {
      font: inherit; font-weight: 650; border-radius: 999px; padding: 6px 12px; cursor: pointer;
      border: 1px solid #0a665f; background: #0a665f; color: #fff;
    }
    button.quiet { background: transparent; color: #0a665f; border-color: #d6cec1; }
    button.close { border: 0; background: transparent; color: #51656e; padding: 2px 6px; font-size: 18px; line-height: 1; }
    button:focus-visible, input:focus-visible { outline: 3px solid #0d7a72; outline-offset: 2px; }
    .toast { right: 16px; bottom: 16px; width: min(380px, calc(100vw - 32px)); padding: 12px 12px 12px 14px; display: grid; gap: 8px; }
    .toast .row { display: flex; gap: 10px; align-items: flex-start; }
    .toast .msg { flex: 1; padding-top: 2px; }
    .toast .dot { flex: none; width: 10px; height: 10px; margin-top: 7px; border-radius: 50%; background: #0a665f; }
    .toast.error .dot { background: #b8402a; }
    .toast.info .dot { background: #3b78b5; }
    .toast .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .toast form { display: flex; gap: 8px; }
    .toast input {
      flex: 1; min-width: 0; font: inherit; color: inherit; background: #fff;
      border: 1px solid #7d8a8f; border-radius: 10px; padding: 6px 10px;
    }
    .tip { pointer-events: none; max-width: min(300px, calc(100vw - 16px)); padding: 8px 12px; }
    .tip .word { font-weight: 700; }
    .tip .label { color: #51656e; font-size: 12px; margin-top: 2px; }
    .card { width: min(340px, calc(100vw - 16px)); padding: 12px 14px; display: grid; gap: 8px; }
    .card .kind { font-size: 12px; font-weight: 700; letter-spacing: 0.02em; color: #a03a26; }
    .card.style .kind { color: #2b5a8a; }
    .card .change { font-size: 15px; overflow-wrap: anywhere; }
    .card del { color: #a03a26; text-decoration-thickness: 2px; }
    .card ins { text-decoration: none; font-weight: 700; color: #0b5a43; background: #e3f5ec; border-radius: 4px; padding: 0 3px; }
    .card .reason { color: #51656e; }
    .card .warn { color: #7a4708; background: #fbefd9; border-radius: 8px; padding: 4px 8px; }
    .card .actions { display: flex; gap: 8px; }
    .line { position: fixed; height: 2px; border-radius: 1px; pointer-events: none; background: #b8402a; }
    .line.style { background: #3b78b5; }
    @media (prefers-color-scheme: dark) {
      .panel { color: #e9efef; background: #1f282b; border-color: #35444a; }
      button { background: #3fb8aa; border-color: #3fb8aa; color: #10201f; }
      button.quiet { background: transparent; color: #8fd9cf; border-color: #526462; }
      button.close, .tip .label, .card .reason { color: #9fb1b7; }
      .toast input { background: #14191b; border-color: #7f9298; }
      .card .kind, .card del { color: #f0a493; }
      .card.style .kind { color: #9cc3ec; }
      .card ins { color: #b6ead2; background: #173a2e; }
      .card .warn { color: #f5d29b; background: #3b2a10; }
    }
  `;

  let host = null;
  let shadow = null;

  // Fixed children use viewport coordinates. A stacking layer keeps solid
  // underlines above page surfaces without intercepting the page's input.
  function root() {
    if (host?.isConnected) return shadow;
    if (!host) {
      host = document.createElement("gloss-ui");
      host.setAttribute("style", "all: initial !important; display: block !important; position: fixed !important; top: 0 !important; left: 0 !important; pointer-events: none !important; width: 0 !important; height: 0 !important; overflow: visible !important; z-index: 2147483647 !important;");
      shadow = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = STYLE;
      shadow.append(style);
    }
    // A page that re-renders <html> may drop the host; put it back.
    document.documentElement.append(host);
    return shadow;
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "text") node.textContent = value;
      else if (key === "className") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
      else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
  }

  // Keeps a panel next to its anchor (below when there is room) and inside the viewport.
  function place(panel, anchor) {
    const margin = 8;
    const box = panel.getBoundingClientRect();
    const below = anchor.bottom + 6;
    const top = below + box.height + margin <= window.innerHeight ? below : Math.max(margin, anchor.top - box.height - 6);
    const left = Math.min(Math.max(margin, anchor.left), Math.max(margin, window.innerWidth - box.width - margin));
    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;
  }

  // --- Toast -------------------------------------------------------------

  let toast = null;
  let toastTimer = 0;

  function hideToast() {
    clearTimeout(toastTimer);
    toast?.remove();
    toast = null;
  }

  function scheduleHide(ms) {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toast && !toast.matches(":hover") && !toast.contains(shadow.activeElement)) hideToast();
      else if (toast) scheduleHide(1500);
    }, ms);
  }

  const ACTION_LABELS = { options: "Open settings", app: "Open gloss" };

  // `handlers.open(target)` opens a gloss page or the settings;
  // `handlers.saveMeaning(word, meaning)` resolves to true when saved.
  function showToast(data, handlers) {
    hideToast();
    const tone = ["success", "info", "error"].includes(data.tone) ? data.tone : "info";
    const message = el("p", { className: "msg", text: String(data.text ?? "") });
    const actions = el("div", { className: "actions" });
    toast = el("div", { className: `panel toast ${tone}`, role: tone === "error" ? "alert" : "status" }, [
      el("div", { className: "row" }, [
        el("span", { className: "dot", "aria-hidden": "true" }),
        message,
        el("button", { className: "close", type: "button", "aria-label": "Close", text: "×", onClick: hideToast }),
      ]),
      actions,
    ]);

    if (ACTION_LABELS[data.action]) {
      actions.append(el("button", {
        className: "quiet",
        type: "button",
        text: ACTION_LABELS[data.action],
        onClick: () => { handlers.open(data.action); hideToast(); },
      }));
    }
    if (data.canAddMeaning && typeof data.word === "string") {
      actions.append(el("button", {
        className: "quiet",
        type: "button",
        text: "Add a meaning",
        onClick: () => showMeaningForm(data.word, message, actions, handlers),
      }));
    }
    if (!actions.childElementCount) actions.remove();
    root().append(toast);
    scheduleHide(5000);
  }

  function showMeaningForm(word, message, actions, handlers) {
    const input = el("input", {
      type: "text",
      maxlength: "200",
      placeholder: "Short meaning, in your words",
      "aria-label": `Meaning of ${word}`,
    });
    const save = el("button", { type: "submit", text: "Save" });
    const form = el("form", {
      onSubmit: async (event) => {
        event.preventDefault();
        const meaning = input.value.replace(/\s+/gu, " ").trim();
        if (!meaning) {
          input.focus();
          return;
        }
        save.disabled = true;
        const saved = await handlers.saveMeaning(word, meaning);
        message.textContent = saved ? "Meaning saved." : "Could not save the meaning. Please try again.";
        form.remove();
        scheduleHide(2500);
      },
    }, [input, save]);
    actions.replaceWith(form);
    input.focus();
  }

  // --- Word tip ----------------------------------------------------------

  let tip = null;

  function showTip(anchor, word) {
    hideTip();
    tip = el("div", { className: "panel tip", role: "tooltip" }, [
      el("p", { className: "word", text: word.text }),
      el("p", { text: word.meaning || "No meaning saved yet." }),
      el("p", { className: "label", text: "In My words" }),
    ]);
    root().append(tip);
    place(tip, anchor);
  }

  function hideTip() {
    tip?.remove();
    tip = null;
  }

  // --- Suggestion card ---------------------------------------------------

  let card = null;

  // `handlers`: apply(), dismiss(), hover(inside) for keeping the card open.
  function showCard(anchor, suggestion, handlers) {
    hideCard();
    const keepFocus = (event) => event.preventDefault();
    const style = suggestion.category === "style";
    const change = el("p", { className: "change" });
    if (suggestion.original) change.append(el("del", { text: suggestion.original }), " → ");
    change.append(el("ins", { text: suggestion.replacement || "(remove)" }));
    card = el("div", {
      className: `panel card${style ? " style" : ""}`,
      role: "dialog",
      "aria-label": "Writing suggestion",
      onMouseenter: () => handlers.hover(true),
      onMouseleave: () => handlers.hover(false),
    }, [
      el("p", { className: "kind", text: style ? "Style" : "Correction" }),
      change,
      ...(suggestion.reason ? [el("p", { className: "reason", text: suggestion.reason })] : []),
      ...(suggestion.meaningChange
        ? [el("p", { className: "warn", text: "This may change what you mean. Check it before applying." })]
        : []),
      el("div", { className: "actions" }, [
        // Pressing a button must not move focus out of the field being edited.
        el("button", { type: "button", text: "Apply", onMousedown: keepFocus, onClick: handlers.apply }),
        el("button", { className: "quiet", type: "button", text: "Dismiss", onMousedown: keepFocus, onClick: handlers.dismiss }),
      ]),
    ]);
    root().append(card);
    place(card, anchor);
  }

  function hideCard() {
    card?.remove();
    card = null;
  }

  // --- Underlines and measuring -----------------------------------------

  const lines = new Map();

  // Draws underlines for one field: `marks` are [{ rect, category }] in
  // viewport coordinates, where rect is the line box of the marked text.
  function setLines(owner, marks) {
    const old = lines.get(owner) ?? [];
    const next = [];
    marks.forEach((mark, i) => {
      const line = old[i] ?? el("div");
      line.className = mark.category === "style" ? "line style" : "line";
      line.style.left = `${mark.rect.left}px`;
      line.style.top = `${mark.rect.bottom - 2}px`;
      line.style.width = `${Math.max(6, mark.rect.width)}px`;
      if (!line.isConnected) root().append(line);
      next.push(line);
    });
    for (const line of old.slice(marks.length)) line.remove();
    if (next.length) lines.set(owner, next);
    else lines.delete(owner);
  }

  // Keep measurement text inside the isolated shadow tree so page CSS cannot
  // change its font or spans. Subtract its origin when mapping to the field.
  let mirror = null;

  function mirrorElement() {
    if (!mirror) {
      mirror = el("div", { className: "mirror", "aria-hidden": "true" });
      mirror.style.setProperty("all", "initial");
      mirror.style.setProperty("position", "fixed", "important");
      // Still inside the viewport: a placed box far to the left is not laid
      // out the same way as the field's lines.
      mirror.style.setProperty("top", "0", "important");
      mirror.style.setProperty("left", "0", "important");
      mirror.style.setProperty("visibility", "hidden", "important");
      mirror.style.setProperty("pointer-events", "none", "important");
      mirror.style.setProperty("border", "0", "important");
      mirror.style.setProperty("margin", "0", "important");
      mirror.style.setProperty("z-index", "-1", "important");
      mirror.style.setProperty("opacity", "0", "important");
    }
    // A page that re-renders <html> may drop it; put it back.
    if (!mirror.isConnected) root().append(mirror);
    return mirror;
  }

  // Explain skipped code editors when their keyboard sink gains focus.
  let notice = null;

  function setNotice(kind) {
    const text = kind === "writing"
      ? "This kind of editor is not supported yet"
      : null;
    if (!text) {
      notice?.remove();
      notice = null;
      return;
    }
    if (!notice) {
      notice = el("p", { className: "notice", role: "status" });
      notice.style.setProperty("position", "fixed", "important");
      notice.style.setProperty("left", "16px", "important");
      notice.style.setProperty("bottom", "16px", "important");
      notice.style.setProperty("max-width", "min(420px, calc(100vw - 32px))", "important");
      notice.style.setProperty("padding", "10px 12px", "important");
      notice.style.setProperty("border-radius", "10px", "important");
      notice.style.setProperty("font", "13px/1.45 system-ui, sans-serif", "important");
      notice.style.setProperty("background", "#fffdf9", "important");
      notice.style.setProperty("color", "#203139", "important");
      notice.style.setProperty("border", "1px solid #d6cec1", "important");
      notice.style.setProperty("z-index", "2", "important");
    }
    if (notice.textContent !== text) notice.textContent = text;
    if (!notice.isConnected) root().append(notice);
  }

  globalThis.glossUi = Object.freeze({
    hideCard,
    hideTip,
    isOwnNode: (node) => node === host,
    mirrorElement,
    setLines,
    showCard,
    setNotice,
    showTip,
    showToast,
    cardContains: (node) => Boolean(card && node && card.contains(node)),
  });
})();
