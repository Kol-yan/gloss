// "Highlight my words": marks the learner's saved words in the page's text
// with overlay boxes drawn inside a closed shadow root owned by the extension.
// The page's DOM text is never changed and nothing about the matches is
// registered anywhere the page can read (no CSS.highlights, no attributes).
// Hovering a marked word shows its saved meaning.
(() => {
  const { buildWordMatcher, findWordMatches, isSkippedTag } = globalThis.glossWords;
  const ui = globalThis.glossUi;
  const STYLE = `
    :host { all: initial; }
    .layer { position: fixed; top: 0; left: 0; width: 0; height: 0; pointer-events: none; }
    .box {
      position: fixed; box-sizing: border-box; pointer-events: none;
      background: rgb(13 122 114 / 0.18);
      border-bottom: 1px dotted rgb(13 122 114 / 0.9);
    }
  `;
  // Bounds for very long pages: highlighting stops growing, the page does not slow down.
  const MAX_RANGES = 5000;
  const MAX_NODE_LENGTH = 100_000;
  const SETTLE_MS = 500;

  const supported = typeof document.createRange === "function" && typeof Element.prototype.attachShadow === "function";

  let on = false;
  let error = null;
  let matcher = null;
  let host = null;
  let layer = null;
  let drawFrame = 0;
  let count = 0;
  const marks = new Map();
  let observer = null;
  const pending = new Set();
  let settleTimer = 0;
  let frame = 0;
  let pointer = null;
  let shown = null;

  function skipElement(element) {
    return isSkippedTag(element.tagName) || element.isContentEditable || ui.isOwnNode(element) || element === host;
  }

  function insideSkipped(node) {
    for (let element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement; element; element = element.parentElement) {
      if (skipElement(element)) return true;
    }
    return false;
  }

  function unmark(node) {
    const list = marks.get(node);
    if (!list) return;
    count -= list.length;
    marks.delete(node);
  }

  function mark(node) {
    unmark(node);
    const text = node.data;
    if (count >= MAX_RANGES || text.length < 2 || text.length > MAX_NODE_LENGTH) return;
    const list = [];
    for (const match of findWordMatches(matcher, text, MAX_RANGES - count)) {
      const range = document.createRange();
      range.setStart(node, match.start);
      range.setEnd(node, match.end);
      list.push({ ...match, range });
    }
    if (list.length) {
      marks.set(node, list);
      count += list.length;
    }
  }

  function scan(root) {
    if (!matcher || !root?.isConnected) return;
    if (root.nodeType === Node.TEXT_NODE) {
      if (!insideSkipped(root)) mark(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE || insideSkipped(root)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => node.nodeType === Node.TEXT_NODE
        ? NodeFilter.FILTER_ACCEPT
        : skipElement(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP,
    });
    for (let node = walker.nextNode(); node && count < MAX_RANGES; node = walker.nextNode()) mark(node);
  }

  // Pages keep changing; new and edited text is marked once things settle.
  function settle() {
    settleTimer = 0;
    for (const node of [...marks.keys()]) if (!node.isConnected) unmark(node);
    const roots = [...pending];
    pending.clear();
    for (const root of roots) scan(root);
    scheduleDraw();
  }

  function observe(records) {
    for (const record of records) {
      if (record.type === "characterData") pending.add(record.target);
      else record.addedNodes.forEach((node) => pending.add(node));
    }
    if (!settleTimer) settleTimer = setTimeout(settle, SETTLE_MS);
    scheduleDraw();
  }

  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      const position = document.caretPositionFromPoint(x, y);
      return position ? { node: position.offsetNode, offset: position.offset } : null;
    }
    const range = document.caretRangeFromPoint?.(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }

  function hitTest(x, y) {
    const caret = caretAt(x, y);
    const list = caret && marks.get(caret.node);
    if (!list) return null;
    for (const item of list) {
      if (caret.offset < item.start || caret.offset > item.end) continue;
      for (const rect of item.range.getClientRects()) {
        if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1) return { item, rect };
      }
    }
    return null;
  }

  function ensureLayer() {
    if (!host) {
      host = document.createElement("gloss-marks");
      host.setAttribute("style", "all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; pointer-events: none !important; z-index: 2147483646 !important;");
      const shadow = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = STYLE;
      layer = document.createElement("div");
      layer.className = "layer";
      shadow.append(style, layer);
    }
    // A page that re-renders <html> may drop the host; put it back.
    if (!host.isConnected) document.documentElement.append(host);
  }

  function draw() {
    drawFrame = 0;
    if (!on || !layer) return;
    ensureLayer();
    const width = window.innerWidth;
    const height = window.innerHeight;
    const boxes = document.createDocumentFragment();
    for (const list of marks.values()) {
      for (const item of list) {
        for (const rect of item.range.getClientRects()) {
          if (rect.width <= 0 || rect.height <= 0) continue;
          if (rect.bottom < 0 || rect.top > height || rect.right < 0 || rect.left > width) continue;
          const box = document.createElement("div");
          box.className = "box";
          box.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
          boxes.append(box);
        }
      }
    }
    layer.replaceChildren(boxes);
  }

  function scheduleDraw() {
    if (on && !drawFrame) drawFrame = requestAnimationFrame(draw);
  }

  function updateTip() {
    frame = 0;
    if (!pointer) return;
    const hit = hitTest(pointer.x, pointer.y);
    if (hit?.item === shown) return;
    shown = hit?.item ?? null;
    if (hit) ui.showTip(hit.rect, hit.item.word);
    else ui.hideTip();
  }

  function onPointerMove(event) {
    pointer = { x: event.clientX, y: event.clientY };
    if (!frame) frame = requestAnimationFrame(updateTip);
  }

  function onScroll() {
    shown = null;
    ui.hideTip();
    scheduleDraw();
  }

  function reset() {
    clearTimeout(settleTimer);
    settleTimer = 0;
    pending.clear();
    marks.clear();
    count = 0;
    layer?.replaceChildren();
  }

  function stop() {
    on = false;
    matcher = null;
    observer?.disconnect();
    observer = null;
    document.removeEventListener("mousemove", onPointerMove, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onScroll);
    cancelAnimationFrame(drawFrame);
    drawFrame = 0;
    reset();
    host?.remove();
    host = null;
    layer = null;
    shown = null;
    ui.hideTip();
  }

  // `loadWords(force)` asks the background for the learner's word list.
  async function start(loadWords, force = false) {
    error = null;
    if (!supported) {
      error = "unsupported";
      stop();
      return state();
    }
    const result = await loadWords(force);
    if (!result?.ok) {
      error = result?.error ?? "unavailable";
      stop();
      return state();
    }
    reset();
    matcher = buildWordMatcher(result.words);
    if (!on) {
      on = true;
      ensureLayer();
      observer = new MutationObserver(observe);
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      document.addEventListener("mousemove", onPointerMove, { capture: true, passive: true });
      window.addEventListener("scroll", onScroll, { capture: true, passive: true });
      window.addEventListener("resize", onScroll, { passive: true });
    }
    if (matcher && document.body) scan(document.body);
    scheduleDraw();
    return state();
  }

  function state() {
    return { on, error, matches: count, words: matcher?.size ?? 0, supported };
  }

  globalThis.glossHighlight = Object.freeze({
    start,
    stop,
    state,
    // Picks up a word just added to My words.
    refresh: (loadWords) => (on ? start(loadWords, true) : Promise.resolve(state())),
  });
})();
