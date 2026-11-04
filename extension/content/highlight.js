// "Highlight my words": marks the learner's saved words in the page's text
// with the CSS Custom Highlight API. The page's DOM is never changed, so
// pages that manage their own DOM (React and the like) are not disturbed.
// Hovering a marked word shows its saved meaning.
(() => {
  const { buildWordMatcher, findWordMatches, isSkippedTag } = globalThis.glossWords;
  const ui = globalThis.glossUi;
  const NAME = "gloss-word";
  // Bounds for very long pages: highlighting stops growing, the page does not slow down.
  const MAX_RANGES = 5000;
  const MAX_NODE_LENGTH = 100_000;
  const SETTLE_MS = 500;

  const supported = typeof Highlight === "function" && typeof CSS !== "undefined" && Boolean(CSS.highlights);

  let on = false;
  let error = null;
  let matcher = null;
  let highlight = null;
  let count = 0;
  const marks = new Map();
  let observer = null;
  const pending = new Set();
  let settleTimer = 0;
  let frame = 0;
  let pointer = null;
  let shown = null;

  function skipElement(element) {
    return isSkippedTag(element.tagName) || element.isContentEditable || ui.isOwnNode(element);
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
    for (const mark of list) highlight.delete(mark.range);
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
      highlight.add(range);
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
  }

  function observe(records) {
    for (const record of records) {
      if (record.type === "characterData") pending.add(record.target);
      else record.addedNodes.forEach((node) => pending.add(node));
    }
    if (!settleTimer) settleTimer = setTimeout(settle, SETTLE_MS);
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
  }

  function reset() {
    clearTimeout(settleTimer);
    settleTimer = 0;
    pending.clear();
    marks.clear();
    count = 0;
    highlight?.clear();
  }

  function stop() {
    on = false;
    matcher = null;
    observer?.disconnect();
    observer = null;
    document.removeEventListener("mousemove", onPointerMove, true);
    window.removeEventListener("scroll", onScroll, true);
    reset();
    if (highlight) CSS.highlights.delete(NAME);
    highlight = null;
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
    if (!highlight) {
      highlight = new Highlight();
      CSS.highlights.set(NAME, highlight);
    }
    if (!on) {
      on = true;
      observer = new MutationObserver(observe);
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      document.addEventListener("mousemove", onPointerMove, { capture: true, passive: true });
      window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    }
    if (matcher && document.body) scan(document.body);
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
