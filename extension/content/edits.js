// Suggestion bookkeeping for writing checks in text fields. Pure functions
// only, published as globalThis.glossEdits; the tests load this file alone.
//
// Ranges are UTF-16 indices into the field's text, which must already be
// normalized (NFC, "\n" line endings) the way the server normalizes it.
(() => {
  const MAX_CHECK_LENGTH = 6000;
  const MIN_CHECK_LENGTH = 8;
  const WORD_CHAR = /[\p{L}\p{M}\p{N}_'’]/u;
  // Attributes with which a site says writing tools should leave a field alone.
  const SECRET_HINT = /(pass|token|secret|api[-_ ]?key|otp|2fa|one[-_ ]?time|verification|cvv|cvc|card|iban|ssn|pin\b)/;
  const OPT_OUT = [["data-gloss", "off"], ["data-gramm", "false"], ["data-enable-grammarly", "false"]];

  // The one edit that turns `before` into `after`: [start, oldEnd) of
  // `before` became [start, newEnd) of `after`. Null when nothing changed.
  function diffTexts(before, after) {
    if (before === after) return null;
    const max = Math.min(before.length, after.length);
    let start = 0;
    while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
    let oldEnd = before.length;
    let newEnd = after.length;
    while (oldEnd > start && newEnd > start && before.charCodeAt(oldEnd - 1) === after.charCodeAt(newEnd - 1)) {
      oldEnd -= 1;
      newEnd -= 1;
    }
    return { start, oldEnd, newEnd };
  }

  const isWordChar = (text, index) => index >= 0 && index < text.length && WORD_CHAR.test(text[index]);

  // Moves suggestions computed for `before` onto `after`. A suggestion the
  // edit touched is dropped, and so is one whose word grew: typing "x"
  // right after "teh" makes "tehx", which the "teh" fix no longer describes.
  function rebaseSuggestions(list, before, after) {
    const edit = diffTexts(before, after);
    if (!edit) return list.slice();
    const delta = edit.newEnd - edit.oldEnd;
    const kept = [];
    for (const s of list) {
      let start;
      if (edit.oldEnd <= s.start && edit.start >= s.end) continue;
      if (edit.oldEnd <= s.start) start = s.start + delta;
      else if (edit.start >= s.end) start = s.start;
      else continue;
      const end = start + (s.end - s.start);
      if (after.slice(start, end) !== s.original) continue;
      if (isWordChar(after, start - 1) !== isWordChar(before, s.start - 1)) continue;
      if (isWordChar(after, end) !== isWordChar(before, s.end)) continue;
      kept.push({ ...s, start, end });
    }
    return kept;
  }

  // The text after applying one suggestion, or null when the text no longer
  // reads what the suggestion was computed for.
  function applySuggestion(text, s) {
    if (s.end > text.length || text.slice(s.start, s.end) !== s.original) return null;
    return text.slice(0, s.start) + s.replacement + text.slice(s.end);
  }

  function dismissKey(s) {
    return `${s.original}\u0000${s.replacement}`;
  }

  // Corrections and style notes, in text order, without overlaps or
  // suggestions the learner dismissed. Expression suggestions belong to the
  // editor, where they can become practice.
  function visibleSuggestions(list, dismissed) {
    const sorted = list
      .filter((s) => s.category !== "expression" && !dismissed.has(dismissKey(s)))
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const visible = [];
    for (const s of sorted) {
      const last = visible[visible.length - 1];
      if (last && s.start < last.end) continue;
      visible.push(s);
    }
    return visible;
  }

  function suggestionAt(list, offset) {
    return list.find((s) => s.start <= offset && offset <= s.end) ?? null;
  }

  // Maps an offset in a rich text field's text to a text node. `segments`
  // are the text nodes in order as { start, length }; line breaks between
  // blocks belong to no segment. A range start at the boundary of two nodes
  // goes to the later node, a range end to the earlier one, so a range never
  // starts at the very end of a node or ends at the very start of one.
  function locateOffset(segments, offset, bias = "start") {
    let found = null;
    for (let index = 0; index < segments.length; index += 1) {
      const { start, length } = segments[index];
      if (offset < start) return found ?? { index, offset: 0 };
      if (offset <= start + length) {
        found = { index, offset: offset - start };
        if (bias === "end" || offset < start + length) return found;
      }
    }
    if (found) return found;
    const last = segments.length - 1;
    return last >= 0 ? { index: last, offset: segments[last].length } : null;
  }

  // Whether a field's text is worth a cloud check. Text the server would
  // normalize differently cannot be addressed by its ranges, so it is skipped.
  function checkableText(text) {
    if (typeof text !== "string") return false;
    // A long run without spaces looks like a key or token, not prose.
    if (/\S{32,}/.test(text) && !/\s/.test(text.trim())) return false;
    if (text.length < MIN_CHECK_LENGTH || text.length > MAX_CHECK_LENGTH) return false;
    if (text !== text.normalize("NFC") || text.includes("\r")) return false;
    return (text.match(/\p{L}+/gu) ?? []).length >= 2;
  }

  // Which kind of field, if any, writing checks attach to. `field` describes
  // an element: tag, type, readOnly, disabled, isContentEditable and
  // attribute values. Passwords, structured data (any autocomplete hint
  // other than on/off) and opted-out fields are never checked.
  //
  // `spellcheck="false"` is not an opt-out: sites that ship their own
  // proofreading (the bigger writing surfaces among them) switch the browser's
  // spelling off and used to be skipped silently, so learners saw nothing.
  // Editors that deliberately reserve a field are excluded by the rules below.
  function fieldKind(field) {
    if (!field || field.readOnly || field.disabled || field.inSeparateEditor === true) return null;
    const attr = (name) => (typeof field.attributes?.[name] === "string" ? field.attributes[name].trim().toLowerCase() : null);
    if (OPT_OUT.some(([name, value]) => attr(name) === value)) return null;
    const tag = typeof field.tag === "string" ? field.tag.toUpperCase() : "";
    const inputType = (field.type ?? "text").toLowerCase();
    // Structured fields (amounts, addresses, sign-in names) are not prose.
    const autocomplete = attr("autocomplete");
    if (autocomplete && autocomplete !== "on" && autocomplete !== "off") return null;
    // Fields that look like they hold credentials or codes are never read.
    if (["name", "id", "aria-label", "placeholder"].some((name) => SECRET_HINT.test(attr(name) ?? ""))) return null;
    // A single-line field with the browser's spelling off is usually a code,
    // key or identifier, not prose; only multi-line surfaces are checked then.
    if (tag === "INPUT" && attr("spellcheck") === "false") return null;
    if (tag === "TEXTAREA") return "textarea";
    if (tag === "INPUT") return inputType === "text" ? "input" : null;
    return field.isContentEditable ? "editable" : null;
  }

  globalThis.glossEdits = Object.freeze({
    applySuggestion,
    checkableText,
    diffTexts,
    dismissKey,
    fieldKind,
    locateOffset,
    rebaseSuggestions,
    suggestionAt,
    visibleSuggestions,
  });
})();
