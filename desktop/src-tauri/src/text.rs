//! Text rules shared with the web app (`src/lib/text`): text is normalized to
//! NFC with `\n` line endings before it is checked, and suggestion ranges are
//! UTF-16 indices into that normalized text.

use unicode_normalization::UnicodeNormalization;

/// Same limit as `MAX_TEXT_LENGTH` in `src/shared/contracts.ts`.
pub const MAX_TEXT_UTF16: usize = 6000;

pub fn normalize(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n").nfc().collect()
}

pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// One replacement, addressed the way the server addresses it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edit<'a> {
    pub start: usize,
    pub end: usize,
    pub original: &'a str,
    pub replacement: &'a str,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ApplyError {
    /// The range does not hold the fragment it was computed for, so the text
    /// changed since the check. Such an edit is stale and must not be guessed.
    #[error("a suggestion no longer matches the text")]
    Stale,
    #[error("two suggestions overlap")]
    Overlap,
}

/// Applies non-overlapping edits in one pass. Every edit must still match its
/// original fragment exactly; otherwise nothing is applied.
pub fn apply_edits(text: &str, edits: &[Edit<'_>]) -> Result<String, ApplyError> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut sorted: Vec<&Edit<'_>> = edits.iter().collect();
    sorted.sort_by_key(|edit| (edit.start, edit.end));

    let mut out: Vec<u16> = Vec::with_capacity(units.len());
    let mut cursor = 0;
    for edit in sorted {
        if edit.start > edit.end || edit.end > units.len() {
            return Err(ApplyError::Stale);
        }
        if edit.start < cursor {
            return Err(ApplyError::Overlap);
        }
        // A range that splits a surrogate pair cannot decode, so a match also
        // proves the edit starts and ends on character boundaries.
        match String::from_utf16(&units[edit.start..edit.end]) {
            Ok(found) if found == edit.original => {}
            _ => return Err(ApplyError::Stale),
        }
        out.extend_from_slice(&units[cursor..edit.start]);
        out.extend(edit.replacement.encode_utf16());
        cursor = edit.end;
    }
    out.extend_from_slice(&units[cursor..]);
    String::from_utf16(&out).map_err(|_| ApplyError::Stale)
}

/// A short single-line preview for status text, cut on a character boundary.
pub fn preview(text: &str, max_chars: usize) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max_chars {
        return flat;
    }
    let cut: String = flat.chars().take(max_chars.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit<'a>(start: usize, end: usize, original: &'a str, replacement: &'a str) -> Edit<'a> {
        Edit { start, end, original, replacement }
    }

    #[test]
    fn normalizes_line_endings_and_composition() {
        assert_eq!(normalize("a\r\nb\rc\n"), "a\nb\nc\n");
        // "e" + combining acute accent becomes the precomposed character.
        assert_eq!(normalize("cafe\u{301}"), "caf\u{e9}");
    }

    #[test]
    fn counts_utf16_units_like_javascript() {
        assert_eq!(utf16_len("abc"), 3);
        assert_eq!(utf16_len("é"), 1);
        assert_eq!(utf16_len("😀"), 2);
    }

    #[test]
    fn applies_edits_in_any_order() {
        let text = "He go to school yesterday and buy a apple.";
        let edits = [edit(34, 35, "a", "an"), edit(3, 5, "go", "went"), edit(30, 33, "buy", "bought")];
        assert_eq!(apply_edits(text, &edits).unwrap(), "He went to school yesterday and bought an apple.");
    }

    #[test]
    fn uses_utf16_indices_after_astral_characters() {
        // The emoji takes two UTF-16 units, so "teh" starts at index 3.
        let text = "😀 teh end";
        assert_eq!(apply_edits(text, &[edit(3, 6, "teh", "the")]).unwrap(), "😀 the end");
    }

    #[test]
    fn rejects_stale_and_out_of_range_edits() {
        assert_eq!(apply_edits("hello", &[edit(0, 5, "world", "x")]), Err(ApplyError::Stale));
        assert_eq!(apply_edits("hello", &[edit(3, 9, "lo", "x")]), Err(ApplyError::Stale));
        assert_eq!(apply_edits("hello", &[edit(4, 2, "", "x")]), Err(ApplyError::Stale));
    }

    #[test]
    fn rejects_ranges_that_split_a_surrogate_pair() {
        assert_eq!(apply_edits("😀", &[edit(0, 1, "\u{fffd}", "x")]), Err(ApplyError::Stale));
    }

    #[test]
    fn rejects_overlapping_edits() {
        let edits = [edit(0, 4, "abcd", "x"), edit(2, 5, "cde", "y")];
        assert_eq!(apply_edits("abcdef", &edits), Err(ApplyError::Overlap));
    }

    #[test]
    fn keeps_text_unchanged_without_edits() {
        assert_eq!(apply_edits("same", &[]).unwrap(), "same");
    }

    #[test]
    fn previews_on_character_boundaries() {
        assert_eq!(preview("short\ntext", 20), "short text");
        assert_eq!(preview("ééééééééé", 5), "éééé…");
    }
}
