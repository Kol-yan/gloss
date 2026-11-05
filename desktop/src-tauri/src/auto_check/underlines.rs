//! Red underlines under the fixes found while typing (layer B).
//!
//! Each suggestion covers a range of the field's text (UTF-16). The macOS side
//! asks Accessibility for that range's rectangles, one per line, converts them
//! from the field's coordinate space to the screen, and this module decides
//! where the 2 px underlines go, when to redraw, and which underline a click
//! hits. Everything here is pure data so it can be tested without AppKit.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::{Duration, Instant};

/// Thickness of the line below the text, in points.
pub const THICKNESS: f64 = 2.0;
/// About 2.5 px down from the baseline of a typical line, measured from the
/// bottom of the line box returned by Accessibility.
pub const BASELINE_GAP: f64 = 1.5;
/// Longer text is checked by hand; underlines are not drawn for it.
pub const MAX_CHARS: usize = 2000;
/// The frame is re-read this often, so scrolling and resizing redraw.
pub const FRAME_POLL: Duration = Duration::from_millis(300);
/// How far from a line a click still counts as a hit, in points.
pub const HIT_SLOP: f64 = 3.0;

/// One text range that should be underlined, in UTF-16 units.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fix {
    pub start: usize,
    pub end: usize,
}

impl Fix {
    pub fn new(start: usize, end: usize) -> Option<Self> {
        (end > start).then_some(Self { start, end })
    }
}

/// A rectangle on screen, in points, with the origin at the top left like the
/// window coordinates Tauri positions windows with. The macOS side converts
/// from Cocoa's bottom-left origin before anything reaches this type.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// One line box of a fix, already on screen.
#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub fix: usize,
    pub rect: Rect,
}

/// The lines to draw, and their bounding box for the overlay window.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Layout {
    pub lines: Vec<Line>,
    pub bounds: Option<Rect>,
}

/// Everything a redraw depends on: where the field is and what it holds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameKey {
    pub field_token: u64,
    pub frame: Option<(f64, f64, f64, f64)>,
    pub scroll: Option<(f64, f64)>,
    pub text_hash: u64,
}

pub fn text_hash(text: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

/// Whether the underlines need to be drawn again.
#[derive(Debug, Default)]
pub struct Redrawer {
    last: Option<FrameKey>,
    confirmed: Option<Instant>,
}

impl Redrawer {
    /// Checks at most every `FRAME_POLL`; two identical readings in a row
    /// mean nothing moved, so no redraw is asked for.
    pub fn poll(&mut self, key: FrameKey, now: Instant) -> bool {
        if now < self.confirmed.unwrap_or(now) {
            return false;
        }
        if self.last == Some(key) {
            self.confirmed = Some(now + FRAME_POLL);
            return false;
        }
        self.last = Some(key);
        self.confirmed = Some(now + FRAME_POLL);
        true
    }
}

/// Underlines for `fixes`, each split into line boxes by `line_box`, which maps
/// a UTF-16 range to the rectangles it occupies (one per visual line, in the
/// field's coordinate space). `to_screen` moves a field rectangle onto the
/// screen. Ranges outside the text or with empty/zero bounds are skipped.
pub fn layout(
    fixes: &[Fix],
    text: &str,
    frame: Option<(f64, f64, f64, f64)>,
    to_screen: impl Fn(Rect) -> Rect,
    mut line_box: impl FnMut(Fix) -> Vec<Rect>,
) -> Layout {
    let Some((field_x, field_y, field_width, field_height)) = frame else {
        return Layout::default();
    };
    let field = Rect { x: field_x, y: field_y, width: field_width, height: field_height };
    let units = text.encode_utf16().count();
    let mut lines = Vec::new();
    for (index, fix) in fixes.iter().enumerate() {
        if fix.end > units || fix.start >= fix.end {
            continue;
        }
        for rect in line_box(*fix) {
            if rect.width <= 0.0 || rect.height <= 0.0 {
                continue;
            }
            // Only what is visible inside the field's own frame is drawn.
            let clipped = clip(rect, field);
            if clipped.is_none() {
                continue;
            }
            let mut rect = clipped.expect("checked above");
            // The line sits under the text: 2 px tall, 1.5 px below the box.
            let y = rect.y + rect.height - THICKNESS + BASELINE_GAP;
            rect.y = y;
            rect.height = THICKNESS;
            lines.push(Line { fix: index, rect: to_screen(rect) });
        }
    }
    let bounds = bounding_box(&lines);
    Layout { lines, bounds }
}

fn clip(rect: Rect, field: Rect) -> Option<Rect> {
    let left = rect.x.max(field.x);
    let right = (rect.x + rect.width).min(field.x + field.width);
    let top = rect.y.max(field.y);
    let bottom = (rect.y + rect.height).min(field.y + field.height);
    if right - left <= 0.5 || bottom - top <= 0.5 {
        return None;
    }
    Some(Rect { x: left, y: top, width: right - left, height: bottom - top })
}

fn bounding_box(lines: &[Line]) -> Option<Rect> {
    let first = lines.first()?.rect;
    let mut left = first.x;
    let mut top = first.y;
    let mut right = first.x + first.width;
    let mut bottom = first.y + first.height;
    for line in &lines[1..] {
        left = left.min(line.rect.x);
        top = top.min(line.rect.y);
        right = right.max(line.rect.x + line.rect.width);
        bottom = bottom.max(line.rect.y + line.rect.height);
    }
    Some(Rect { x: left, y: top, width: right - left, height: bottom - top })
}

/// The fix under a click at `(x, y)` on screen, with a few points of slack.
pub fn hit_test(layout: &Layout, x: f64, y: f64) -> Option<usize> {
    layout.lines.iter().find_map(|line| {
        let rect = line.rect;
        let inside = x >= rect.x - HIT_SLOP
            && x <= rect.x + rect.width + HIT_SLOP
            && y >= rect.y - HIT_SLOP
            && y <= rect.y + rect.height + HIT_SLOP;
        inside.then_some(line.fix)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field() -> (f64, f64, f64, f64) {
        (100.0, 200.0, 400.0, 80.0)
    }

    fn identity(rect: Rect) -> Rect {
        rect
    }

    #[test]
    fn one_line_under_each_fix() {
        let text = "He go to school yesterday.";
        let fixes = [Fix::new(3, 5).unwrap(), Fix::new(6, 8).unwrap()];
        // "go" and "to" on the same line, 20 pt tall line box at the field top.
        let rects = [Rect { x: 100.0, y: 200.0, width: 18.0, height: 20.0 }, Rect { x: 123.0, y: 200.0, width: 14.0, height: 20.0 }];
        let mut index = 0;
        let layout = layout(&fixes, text, Some(field()), identity, |_| {
            let rect = rects[index];
            index += 1;
            vec![rect]
        });
        assert_eq!(layout.lines.len(), 2);
        assert_eq!(layout.lines[0].rect, Rect { x: 100.0, y: 200.0 + 20.0 - THICKNESS + BASELINE_GAP, width: 18.0, height: THICKNESS });
        assert_eq!(layout.lines[1].fix, 1);
        assert_eq!(layout.bounds, Some(Rect { x: 100.0, y: 219.5, width: 37.0, height: 2.0 }));
    }

    #[test]
    fn a_wrapped_fix_gets_one_line_per_visual_line() {
        let text = "a very long sentence that wraps over two lines";
        let fix = [Fix::new(2, 30).unwrap()];
        let layout = layout(&fix, text, Some(field()), identity, |_| {
            vec![
                Rect { x: 100.0, y: 200.0, width: 400.0, height: 20.0 },
                Rect { x: 100.0, y: 220.0, width: 120.0, height: 20.0 },
            ]
        });
        assert_eq!(layout.lines.len(), 2, "both visual lines");
        assert!(layout.lines[1].rect.y > layout.lines[0].rect.y, "the second line is below");
    }

    #[test]
    fn nothing_is_drawn_without_a_frame_or_for_empty_bounds() {
        let fixes = [Fix::new(0, 2).unwrap()];
        assert!(layout(&fixes, "abc", None, identity, |_| vec![]).lines.is_empty());
        // Zero or empty rectangles, the shapes apps return when unsupported.
        let zero = layout(&fixes, "abc", Some(field()), identity, |_| {
            vec![Rect { x: 0.0, y: 0.0, width: 0.0, height: 0.0 }]
        });
        assert!(zero.lines.is_empty());
        assert_eq!(zero.bounds, None);
        // A line entirely outside the field is clipped away.
        let outside = layout(&fixes, "abc", Some(field()), identity, |_| {
            vec![Rect { x: 100.0, y: 150.0, width: 10.0, height: 20.0 }]
        });
        assert!(outside.lines.is_empty());
    }

    #[test]
    fn part_of_a_line_outside_the_field_is_clipped() {
        let fixes = [Fix::new(0, 3).unwrap()];
        let layout = layout(&fixes, "abc", Some(field()), identity, |_| {
            vec![Rect { x: 450.0, y: 200.0, width: 100.0, height: 20.0 }]
        });
        let rect = layout.lines[0].rect;
        assert_eq!(rect.x, 450.0);
        assert_eq!(rect.width, 50.0, "clipped at the field's right edge");
    }

    #[test]
    fn ranges_outside_the_text_are_skipped() {
        let fixes = [Fix::new(0, 10).unwrap()];
        let layout = layout(&fixes, "abc", Some(field()), identity, |_| {
            vec![Rect { x: 100.0, y: 200.0, width: 10.0, height: 20.0 }]
        });
        assert!(layout.lines.is_empty());
    }

    #[test]
    fn a_click_hits_the_underline_under_the_pointer() {
        let text = "He go home.";
        let fixes = [Fix::new(3, 5).unwrap(), Fix::new(6, 10).unwrap()];
        let index = std::cell::Cell::new(0);
        let rects = [(100.0, 40.0), (200.0, 60.0)];
        let layout = layout(&fixes, text, Some(field()), identity, |_| {
            let (x, width) = rects[index.get()];
            index.set(index.get() + 1);
            vec![Rect { x, y: 200.0, width, height: 20.0 }]
        });
        assert_eq!(hit_test(&layout, 110.0, 219.5), Some(0));
        assert_eq!(hit_test(&layout, 220.0, 219.5), Some(1));
        assert_eq!(hit_test(&layout, 180.0, 219.5), None, "between the two words");
        assert_eq!(hit_test(&layout, 110.0, 260.0), None, "far below");
    }

    #[test]
    fn redraws_only_when_something_moved() {
        let mut redrawer = Redrawer::default();
        let t0 = Instant::now();
        let key = FrameKey { field_token: 1, frame: Some((0.0, 0.0, 10.0, 10.0)), scroll: Some((0.0, 0.0)), text_hash: 7 };
        assert!(redrawer.poll(key, t0), "first reading draws");
        assert!(!redrawer.poll(key, t0 + FRAME_POLL), "same frame, no redraw");
        let scrolled = FrameKey { scroll: Some((0.0, 12.0)), ..key };
        assert!(redrawer.poll(scrolled, t0 + FRAME_POLL * 2), "scrolling draws again");
        let other = FrameKey { field_token: 2, ..scrolled };
        assert!(redrawer.poll(other, t0 + FRAME_POLL * 3), "a new field draws");
        assert!(!redrawer.poll(other, t0 + FRAME_POLL * 3));
    }
}
