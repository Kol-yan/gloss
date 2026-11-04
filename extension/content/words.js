// Word matching for "Highlight my words". Pure functions only, published as
// globalThis.glossWords for the content scripts loaded after this one; the
// tests load this file on its own.
(() => {
  // A word is a run of letters, marks, digits or underscores, joined across
  // inner apostrophes, so "don't" is one word and "don" never matches inside it.
  const TOKEN = /[\p{L}\p{M}\p{N}_]+(?:['’ʼ][\p{L}\p{M}\p{N}_]+)*/gu;
  const APOSTROPHES = /['’ʼ]/gu;
  const MAX_WORDS = 5000;
  const MAX_WORD_LENGTH = 80;
  const MAX_TOKENS = 12;

  // Text inside these elements is not prose a learner reads: scripts, styles,
  // form controls, code and embedded documents.
  const SKIPPED_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT", "OPTION",
    "IFRAME", "OBJECT", "EMBED", "CANVAS", "SVG", "MATH", "CODE", "PRE", "KBD", "SAMP", "VAR",
  ]);

  function isSkippedTag(tagName) {
    return typeof tagName === "string" && SKIPPED_TAGS.has(tagName.toUpperCase());
  }

  function normalizeToken(token) {
    return token.replace(APOSTROPHES, "'").toLowerCase();
  }

  // What separates two words, compared loosely: any run of whitespace is one space.
  function normalizeGap(gap) {
    return gap.replace(APOSTROPHES, "'").replace(/\s+/gu, " ");
  }

  function tokensOf(text) {
    return Array.from(text.matchAll(TOKEN), (m) => ({ start: m.index, end: m.index + m[0].length, value: m[0] }));
  }

  // Builds an index from the first word of each entry to the entries that
  // start with it, longest first, so "get the ball rolling" wins over "get".
  function buildWordMatcher(words) {
    const index = new Map();
    const seen = new Set();
    let size = 0;
    for (const word of Array.isArray(words) ? words : []) {
      if (!word || typeof word.text !== "string") continue;
      const text = word.text.normalize("NFC").replace(/\s+/gu, " ").trim();
      const key = normalizeGap(text).toLowerCase();
      if (!key || key.length > MAX_WORD_LENGTH || seen.has(key)) continue;
      const tokens = tokensOf(key);
      if (tokens.length === 0 || tokens.length > MAX_TOKENS || !/\p{L}/u.test(key)) continue;
      seen.add(key);
      const entry = {
        tokens: tokens.map((t) => normalizeToken(t.value)),
        gaps: tokens.slice(1).map((t, i) => normalizeGap(key.slice(tokens[i].end, t.start))),
        word: { text, meaning: typeof word.meaning === "string" ? word.meaning.trim() : "" },
      };
      const list = index.get(entry.tokens[0]) ?? [];
      list.push(entry);
      index.set(entry.tokens[0], list);
      if (++size >= MAX_WORDS) break;
    }
    if (size === 0) return null;
    for (const list of index.values()) list.sort((a, b) => b.tokens.length - a.tokens.length);
    return { index, size };
  }

  // Whole-word, case-insensitive matches of the learner's words in one piece
  // of text, as UTF-16 ranges into that text. Matches never overlap.
  function findWordMatches(matcher, text, limit = 500) {
    if (!matcher || typeof text !== "string" || !text) return [];
    const tokens = tokensOf(text);
    const matches = [];
    for (let i = 0; i < tokens.length && matches.length < limit; i += 1) {
      const candidates = matcher.index.get(normalizeToken(tokens[i].value));
      if (!candidates) continue;
      for (const entry of candidates) {
        const last = i + entry.tokens.length - 1;
        if (last >= tokens.length) continue;
        let same = true;
        for (let j = 1; same && j < entry.tokens.length; j += 1) {
          same = normalizeToken(tokens[i + j].value) === entry.tokens[j]
            && normalizeGap(text.slice(tokens[i + j - 1].end, tokens[i + j].start)) === entry.gaps[j - 1];
        }
        if (!same) continue;
        matches.push({ start: tokens[i].start, end: tokens[last].end, word: entry.word });
        i = last;
        break;
      }
    }
    return matches;
  }

  globalThis.glossWords = Object.freeze({ buildWordMatcher, findWordMatches, isSkippedTag });
})();
