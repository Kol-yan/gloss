// Writing checks in text fields. After a typing pause the field's text goes to
// the learner's gloss server (through the background) for a cloud check, and
// each suggestion is underlined in place. Hovering or clicking an underline
// opens a card with Apply and Dismiss.
//
// Two kinds of fields share one flow and differ only in how text is read,
// measured and changed:
// - Textareas and single-line text inputs keep their text out of the DOM, so
//   positions are measured on an invisible copy (a "mirror") with the same
//   box and font, and fixes go through the field's selection.
// - Rich text editors (contenteditable) are read from their text nodes, with
//   block boundaries and <br> as line breaks, and measured with DOM ranges.
// Either way underlines are drawn over the page and the page is not changed
// except by an applied fix, which goes through the browser's own editing
// command so the site sees a normal edit and undo works.
(() => {
  const E = globalThis.glossEdits;
  const ui = globalThis.glossUi;
  const PAUSE_MS = 2000;
  // Each check spends one of the learner's daily cloud checks.
  const MIN_INTERVAL_MS = 8000;
  const BUSY_RETRY_MS = 10_000;
  const MAX_FIELDS = 20;
  const HIDE_DELAY_MS = 300;
  const NOTICE_ACTIONS = { signed_out: "app", not_allowed: "options", settings: "options" };
  const COPIED_STYLES = [
    "direction", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize", "fontFamily",
    "fontFeatureSettings", "fontKerning", "fontVariantLigatures", "lineHeight", "letterSpacing",
    "wordSpacing", "textTransform", "textIndent", "textAlign", "tabSize", "wordBreak",
    "overflowWrap", "hyphens",
  ];
  const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TBODY|TD|TH|TR|UL)$/;

  let enabled = false;
  let send = async () => ({ ok: false, error: "unavailable" });
  let handlers = { open: () => undefined };
  const fields = new Map();
  let frame = 0;
  let pointer = null;
  let hoverFrame = 0;
  let card = null;
  let hideTimer = 0;
  const resizes = typeof ResizeObserver === "function" ? new ResizeObserver(() => requestRender()) : null;

  function targetOf(event) {
    // A field inside an open shadow root reaches the document retargeted to its host.
    const target = event.composedPath?.()[0] ?? event.target;
    return target instanceof Element ? target : target?.parentElement ?? null;
  }

  // The element writing checks attach to: the field itself, or the root of
  // the rich text editor the target is in.
  function fieldOf(target) {
    if (!(target instanceof HTMLElement) || ui.isOwnNode(target)) return null;
    if (!target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return target;
    let root = target;
    while (root.parentElement?.isContentEditable) root = root.parentElement;
    return root;
  }

  function describe(element) {
    const attributes = {};
    for (const name of ["spellcheck", "autocomplete", "data-gloss", "data-gramm", "data-enable-grammarly"]) {
      const value = element.getAttribute(name);
      if (value !== null) attributes[name] = value;
    }
    if (element.closest('[data-gloss="off"]')) attributes["data-gloss"] = "off";
    return {
      tag: element.tagName,
      type: element.getAttribute("type") ?? "text",
      readOnly: element.readOnly === true,
      disabled: element.disabled === true,
      isContentEditable: element.isContentEditable,
      attributes,
    };
  }

  // --- Reading text ------------------------------------------------------

  // Text of a rich text editor, and where each text node starts in it.
  function readEditable(root) {
    let text = "";
    const segments = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.nodeType === Node.ELEMENT_NODE && /^(SCRIPT|STYLE|TEMPLATE)$/.test(node.tagName)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT),
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) {
        segments.push({ node, start: text.length, length: node.data.length });
        text += node.data;
      } else if (node.tagName === "BR") {
        text += "\n";
      } else if (BLOCK.test(node.tagName) && text && !text.endsWith("\n")) {
        text += "\n";
      }
    }
    return { text, segments };
  }

  function readText(state) {
    return state.kind === "editable" ? readEditable(state.element).text : state.element.value;
  }

  function rangeFor(segments, start, end) {
    const from = E.locateOffset(segments, start, "start");
    const to = E.locateOffset(segments, end, end === start ? "start" : "end");
    if (!from || !to) return null;
    const range = document.createRange();
    range.setStart(segments[from.index].node, from.offset);
    range.setEnd(segments[to.index].node, to.offset);
    return range;
  }

  // --- Tracking fields ---------------------------------------------------

  function track(target) {
    const element = fieldOf(target);
    if (!element) return null;
    const existing = fields.get(element);
    if (existing) return existing;
    const kind = E.fieldKind(describe(element));
    if (!kind) return null;
    if (fields.size >= MAX_FIELDS) untrack(fields.values().next().value);
    const state = {
      element,
      kind,
      text: "",
      checked: null,
      textHash: null,
      suggestions: [],
      marks: [],
      dismissed: new Set(),
      timer: 0,
      lastCheckAt: 0,
      busy: false,
    };
    state.text = readText(state);
    fields.set(element, state);
    resizes?.observe(element);
    return state;
  }

  function untrack(state) {
    clearTimeout(state.timer);
    resizes?.unobserve(state.element);
    ui.setLines(state, []);
    if (card?.state === state) closeCard();
    fields.delete(state.element);
  }

  // Moves suggestions along with whatever the learner (or the page) changed.
  function sync(state) {
    const next = readText(state);
    if (next === state.text) return false;
    state.suggestions = E.rebaseSuggestions(state.suggestions, state.text, next);
    state.text = next;
    if (card?.state === state && !state.suggestions.includes(card.suggestion)) closeCard();
    requestRender();
    return true;
  }

  function schedule(state, delay = PAUSE_MS) {
    clearTimeout(state.timer);
    if (!enabled) return;
    if (!E.checkableText(state.text)) {
      if (state.suggestions.length) {
        state.suggestions = [];
        requestRender();
      }
      return;
    }
    if (state.text === state.checked) return;
    const wait = Math.max(delay, state.lastCheckAt + MIN_INTERVAL_MS - Date.now());
    state.timer = setTimeout(() => void runCheck(state), wait);
  }

  async function runCheck(state) {
    const text = state.text;
    if (!enabled || !fields.has(state.element) || text === state.checked || !E.checkableText(text)) return;
    if (state.busy) {
      schedule(state);
      return;
    }
    state.busy = true;
    state.lastCheckAt = Date.now();
    let result;
    try {
      result = await send({ type: "check", text });
    } finally {
      state.busy = false;
    }
    if (!enabled || !fields.has(state.element)) return;

    if (!result?.ok) {
      if (result?.notice) ui.showToast({ tone: "info", text: result.notice, action: NOTICE_ACTIONS[result.error] }, handlers);
      if (result?.error === "busy") schedule(state, BUSY_RETRY_MS);
      // A text the server could not check is not sent again until it changes.
      else if (result?.error === "invalid" || result?.error === "unavailable") state.checked = text;
      return;
    }
    state.checked = text;
    state.textHash = result.textHash;
    // The learner may have kept typing while the check ran.
    sync(state);
    const current = E.rebaseSuggestions(result.suggestions, text, state.text);
    state.suggestions = E.visibleSuggestions(current, state.dismissed);
    requestRender();
    if (state.text !== text) schedule(state);
  }

  function onInput(event) {
    const target = targetOf(event);
    if (!enabled || !target) return;
    const state = track(target);
    if (state && sync(state)) schedule(state);
  }

  function onFocus(event) {
    const target = targetOf(event);
    if (!enabled || !target) return;
    const state = track(target);
    if (!state) return;
    sync(state);
    schedule(state);
  }

  // --- Measuring and drawing --------------------------------------------

  function requestRender() {
    if (!frame) frame = requestAnimationFrame(render);
  }

  function render() {
    frame = 0;
    for (const state of [...fields.values()]) {
      if (!state.element.isConnected) {
        untrack(state);
        continue;
      }
      state.marks = enabled ? measure(state) : [];
      ui.setLines(state, state.marks.flatMap((m) => m.rects.map((rect) => ({ rect, category: m.suggestion.category }))));
    }
    if (card && !card.state.marks.some((m) => m.suggestion === card.suggestion)) closeCard();
  }

  // The field's visible inner box: underlines outside it would float over
  // other content.
  function visibleBox(element) {
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0 || box.bottom < 0 || box.top > window.innerHeight) return null;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") return null;
    const left = box.left + element.clientLeft;
    const top = box.top + element.clientTop;
    return { box, style, left, top, right: left + element.clientWidth, bottom: top + element.clientHeight };
  }

  function clip(rect, area) {
    const left = Math.max(rect.left, area.left);
    const right = Math.min(rect.left + rect.width, area.right);
    if (rect.top + rect.height < area.top || rect.top > area.bottom || right < left) return null;
    return { left, top: rect.top, width: right - left, height: rect.height, right, bottom: rect.top + rect.height };
  }

  function measure(state) {
    if (!state.suggestions.length) return [];
    const area = visibleBox(state.element);
    if (!area) return [];
    return state.kind === "editable" ? measureEditable(state, area) : measureField(state, area);
  }

  function measureField(state, area) {
    const { element } = state;
    if (element.value !== state.text) return [];
    const { style } = area;
    const mirror = ui.mirrorElement();
    for (const name of COPIED_STYLES) mirror.style[name] = style[name];
    mirror.style.boxSizing = "border-box";
    mirror.style.width = `${element.clientWidth}px`;
    if (state.kind === "input") {
      // Inputs center their single line vertically and never wrap.
      const inner = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      mirror.style.whiteSpace = "pre";
      mirror.style.lineHeight = `${Math.max(inner, 0)}px`;
    } else {
      mirror.style.whiteSpace = style.whiteSpace === "normal" ? "pre-wrap" : style.whiteSpace;
    }

    const spans = [];
    let at = 0;
    for (const suggestion of state.suggestions) {
      if (suggestion.start > at) mirror.append(state.text.slice(at, suggestion.start));
      const span = document.createElement("span");
      // An insertion has no text of its own; a word joiner gives it a position.
      span.textContent = suggestion.end > suggestion.start ? state.text.slice(suggestion.start, suggestion.end) : "⁠";
      mirror.append(span);
      spans.push({ suggestion, span });
      at = suggestion.end;
    }
    mirror.append(state.text.slice(at));

    const origin = mirror.getBoundingClientRect();
    const marks = [];
    for (const { suggestion, span } of spans) {
      const rects = [];
      for (const r of span.getClientRects()) {
        const rect = clip({
          left: area.left + r.left - origin.left - element.scrollLeft,
          top: area.top + r.top - origin.top - element.scrollTop,
          width: r.width,
          height: r.height,
        }, area);
        if (rect) rects.push(rect);
      }
      if (rects.length) marks.push({ suggestion, rects });
    }
    // The mirror keeps no learner text between renders.
    mirror.replaceChildren();
    return marks;
  }

  function measureEditable(state, area) {
    const { text, segments } = readEditable(state.element);
    if (text !== state.text) return [];
    const viewport = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const marks = [];
    for (const suggestion of state.suggestions) {
      const range = rangeFor(segments, suggestion.start, suggestion.end);
      if (!range) continue;
      const rects = [];
      const boxes = range.collapsed ? [range.getBoundingClientRect()] : range.getClientRects();
      for (const r of boxes) {
        const rect = clip({ left: r.left, top: r.top, width: r.width, height: r.height }, area);
        const shown = rect && clip(rect, viewport);
        if (shown && (shown.width > 0 || range.collapsed)) rects.push(shown);
      }
      if (rects.length) marks.push({ suggestion, rects });
    }
    return marks;
  }

  // --- Suggestion card ----------------------------------------------------

  function hitTest(x, y) {
    for (const state of fields.values()) {
      for (const mark of state.marks) {
        for (const rect of mark.rects) {
          if (x >= rect.left - 2 && x <= rect.left + Math.max(rect.width, 6) + 2 && y >= rect.top - 2 && y <= rect.bottom + 3) {
            return { state, suggestion: mark.suggestion, rect };
          }
        }
      }
    }
    return null;
  }

  function openCard(state, suggestion, rect) {
    clearTimeout(hideTimer);
    if (card?.suggestion === suggestion) return;
    card = { state, suggestion, overCard: false };
    ui.showCard(rect, suggestion, {
      apply: () => apply(state, suggestion),
      dismiss: () => dismiss(state, suggestion),
      hover: (inside) => {
        if (!card) return;
        card.overCard = inside;
        if (inside) clearTimeout(hideTimer);
        else closeSoon();
      },
    });
  }

  function closeCard() {
    clearTimeout(hideTimer);
    card = null;
    ui.hideCard();
  }

  function closeSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (card && !card.overCard) closeCard();
    }, HIDE_DELAY_MS);
  }

  function updateHover() {
    hoverFrame = 0;
    if (!pointer) return;
    const hit = hitTest(pointer.x, pointer.y);
    if (hit) openCard(hit.state, hit.suggestion, hit.rect);
    else if (card && !card.overCard) closeSoon();
  }

  function onPointerMove(event) {
    if (!fields.size) return;
    pointer = { x: event.clientX, y: event.clientY };
    if (!hoverFrame) hoverFrame = requestAnimationFrame(updateHover);
  }

  // Where the caret is in the field's text, or null for a selection.
  function caretOffset(state) {
    if (state.kind !== "editable") {
      const { selectionStart, selectionEnd } = state.element;
      return selectionStart === selectionEnd ? selectionStart : null;
    }
    const selection = getSelection();
    if (!selection?.isCollapsed || !selection.anchorNode) return null;
    const segment = readEditable(state.element).segments.find((s) => s.node === selection.anchorNode);
    return segment ? segment.start + selection.anchorOffset : null;
  }

  // A click that puts the caret inside an underlined fragment opens its card.
  function onPointerUp(event) {
    const target = targetOf(event);
    const element = target && fieldOf(target);
    const state = element && fields.get(element);
    if (!state) return;
    const offset = caretOffset(state);
    const suggestion = offset === null ? null : E.suggestionAt(state.suggestions, offset);
    const mark = suggestion && state.marks.find((m) => m.suggestion === suggestion);
    if (mark) openCard(state, suggestion, mark.rects[0]);
  }

  function onKeyDown(event) {
    if (event.key === "Escape" && card) closeCard();
  }

  // The card is placed once; after a scroll it would point at the wrong text.
  function onScroll() {
    if (card) closeCard();
    requestRender();
  }

  // insertText keeps the field's undo history and goes through the page's own
  // input handling, which rich text editors need to keep their state.
  function insert(replacement) {
    try {
      return replacement
        ? document.execCommand("insertText", false, replacement)
        : document.execCommand("delete", false);
    } catch {
      return false;
    }
  }

  function selectForApply(state, suggestion) {
    const { element } = state;
    element.focus({ preventScroll: true });
    if (state.kind !== "editable") {
      element.setSelectionRange(suggestion.start, suggestion.end);
      return true;
    }
    const range = rangeFor(readEditable(element).segments, suggestion.start, suggestion.end);
    if (!range) return false;
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function apply(state, suggestion) {
    const { element } = state;
    sync(state);
    const before = state.text;
    const expected = E.applySuggestion(before, suggestion);
    closeCard();
    if (expected === null || !state.suggestions.includes(suggestion) || !selectForApply(state, suggestion)) {
      state.suggestions = state.suggestions.filter((s) => s !== suggestion);
      requestRender();
      return;
    }
    const inserted = insert(suggestion.replacement);
    if (state.kind !== "editable" && (!inserted || element.value === before)) {
      element.setRangeText(suggestion.replacement, suggestion.start, suggestion.end, "end");
      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertReplacementText",
        data: suggestion.replacement,
      }));
    }
    // Some editors update their text a moment later, through their own model.
    setTimeout(() => {
      sync(state);
      if (state.text === expected) {
        // The fix came from this check, so the result is not sent for another one.
        state.checked = expected;
        clearTimeout(state.timer);
      } else if (state.text === before) {
        ui.showToast({ tone: "info", text: "This editor did not accept the change. You can make it by hand." }, handlers);
      }
    }, 60);
    if (state.textHash) void send({ type: "decide", id: suggestion.id, decision: "accepted", textHash: state.textHash });
  }

  function dismiss(state, suggestion) {
    state.dismissed.add(E.dismissKey(suggestion));
    state.suggestions = state.suggestions.filter((s) => s !== suggestion);
    closeCard();
    requestRender();
    if (state.textHash) void send({ type: "decide", id: suggestion.id, decision: "rejected", textHash: state.textHash });
  }

  // --- On and off -----------------------------------------------------------

  const listeners = [
    [document, "input", onInput, true],
    [document, "focusin", onFocus, true],
    [document, "scroll", onScroll, { capture: true, passive: true }],
    [document, "mousemove", onPointerMove, { capture: true, passive: true }],
    [document, "mouseup", onPointerUp, true],
    [document, "keydown", onKeyDown, true],
    [window, "resize", requestRender, { passive: true }],
  ];

  // `sendMessage` reaches the background; `toastHandlers` serve notices.
  function setEnabled(next, sendMessage, toastHandlers) {
    if (sendMessage) send = sendMessage;
    if (toastHandlers) handlers = toastHandlers;
    if (next === enabled) return;
    enabled = next;
    for (const [target, type, listener, options] of listeners) {
      if (enabled) target.addEventListener(type, listener, options);
      else target.removeEventListener(type, listener, options);
    }
    if (!enabled) {
      closeCard();
      for (const state of [...fields.values()]) untrack(state);
      return;
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement) onFocus({ target: active });
  }

  globalThis.glossChecks = Object.freeze({ setEnabled, isEnabled: () => enabled });
})();
