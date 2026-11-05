//! Checking as the learner types in another app.
//!
//! The app watches the focused text field of the frontmost application with
//! an Accessibility observer: a focus change re-arms the watcher, a value
//! change starts a debounce, and once typing pauses the text is checked with
//! the same `POST /api/proofread` call as the shortcut. A small badge near the
//! field shows how many fixes are waiting; clicking it opens the usual panel,
//! which applies the fixes straight into the field.
//!
//! The state machine below is free of AppKit so it can be tested: the macOS
//! module feeds it notifications and timers and performs the side effects.

#[cfg(target_os = "macos")]
pub mod runtime;
pub mod underlines;

use std::time::{Duration, Instant};

/// Typing pauses this long before the text is checked.
pub const DEBOUNCE: Duration = Duration::from_millis(1200);
/// Longer text is not checked automatically (the shortcut has no such limit).
pub const MAX_CHARS: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    /// The field's text at the last read.
    pub value: String,
    /// Text the last finished check was about; a check repeats only after
    /// the text changed again.
    pub checked: Option<String>,
    /// Fixes found for `checked`.
    pub fixes: usize,
    /// Registered accessibility handle of the field element.
    pub token: u64,
    /// The badge has the keyboard focus (its click is being handled).
    pub badge_focused: bool,
}

impl Field {
    pub fn new(value: String, token: u64) -> Self {
        Self { value, checked: None, fixes: 0, token, badge_focused: false }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// The field changed; call `due()` after this debounce.
    Arm(Duration),
    /// Read the field and check when it is worth it.
    Check,
    /// Hide the badge (field gone, empty, too long or no fixes).
    HideBadge,
    /// Show the badge with this many fixes and this field token.
    ShowBadge { fixes: usize, token: u64 },
}

#[derive(Debug, Default)]
pub struct Watcher {
    pub field: Option<Field>,
    due_at: Option<Instant>,
}

impl Watcher {
    /// Focus moved to `value`, or to no text field (`None`).
    pub fn focus(&mut self, field: Option<(String, u64)>, now: Instant) -> Vec<Action> {
        self.due_at = None;
        let mut actions = vec![Action::HideBadge];
        match field {
            Some((value, token)) => {
                // Focus that lands on the same text is not a new check (an app
                // re-posted the notification); new text counts only after the
                // learner changed it, which `typed` reports.
                let same = self.field.as_ref().is_some_and(|field| field.value == value);
                self.field = Some(Field::new(value, token));
                if !same && self.worth_checking() {
                    self.due_at = Some(now + DEBOUNCE);
                    actions.push(Action::Arm(DEBOUNCE));
                }
            }
            None => self.field = None,
        }
        actions
    }

    /// The field's value changed to `value`.
    pub fn typed(&mut self, value: String, now: Instant) -> Vec<Action> {
        let Some(field) = self.field.as_mut() else { return Vec::new() };
        if field.value == value {
            return Vec::new();
        }
        field.value = value;
        // A new edit makes the previous result stale; the badge goes away
        // until the next check answers.
        field.fixes = 0;
        if !self.worth_checking() {
            self.due_at = None;
            return vec![Action::HideBadge];
        }
        self.due_at = Some(now + DEBOUNCE);
        vec![Action::HideBadge, Action::Arm(DEBOUNCE)]
    }

    fn worth_checking(&self) -> bool {
        self.field.as_ref().is_some_and(|field| {
            !field.value.trim().is_empty()
                && field.value.chars().count() <= MAX_CHARS
                && field.checked.as_deref() != Some(field.value.as_str())
        })
    }

    /// True once the debounce has passed with nothing newer.
    pub fn due(&self, now: Instant) -> bool {
        self.due_at.is_some_and(|due| now >= due)
    }

    /// The debounce is over: starts a check for the current text.
    pub fn take_due(&mut self, now: Instant) -> Option<Action> {
        if !self.due(now) {
            return None;
        }
        self.due_at = None;
        let field = self.field.as_mut()?;
        field.checked = Some(field.value.clone());
        let _ = now;
        Some(Action::Check)
    }

    /// A check answered for the text `value` it was asked about. Late answers
    /// for older text are dropped.
    pub fn answered(&mut self, value: &str, fixes: usize) -> Vec<Action> {
        let Some(field) = self.field.as_mut() else { return Vec::new() };
        if field.value != value {
            return Vec::new();
        }
        field.checked = Some(value.to_owned());
        field.fixes = fixes;
        if fixes == 0 {
            vec![Action::HideBadge]
        } else {
            vec![Action::ShowBadge { fixes, token: field.token }]
        }
    }

    /// Test hook: the field's text is `text` although the app did not report
    /// a change; arms the same debounce a keystroke does.
    #[doc(hidden)]
    pub fn focused_for_test(&mut self, text: &str, field: &crate::platform::TextField, now: Instant) -> Vec<Action> {
        let mut actions = self.focus(Some((text.to_owned(), field.token)), now);
        if let Some(current) = self.field.as_mut() {
            current.value = text.to_owned();
        }
        if actions.is_empty() || !actions.contains(&Action::Arm(DEBOUNCE)) {
            if self.worth_checking() {
                self.due_at = Some(now + DEBOUNCE);
                actions.push(Action::Arm(DEBOUNCE));
            }
        }
        actions
    }

    /// Whether the watcher's field is the element `token`.
    pub fn shows(&self, token: u64) -> bool {
        self.field.as_ref().is_some_and(|field| field.token == token)
    }

    /// What the badge says: the number of fixes, nothing else.
    pub fn badge_text(&self) -> Option<String> {
        self.field.as_ref().filter(|field| field.fixes > 0).map(|field| field.fixes.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waits_for_a_pause_in_typing() {
        let mut watcher = Watcher::default();
        let t0 = Instant::now();
        assert_eq!(watcher.focus(Some(("He go".into(), 7)), t0), vec![Action::HideBadge, Action::Arm(DEBOUNCE)]);
        assert!(!watcher.due(t0 + Duration::from_millis(500)));
        // Each keystroke restarts the wait.
        let _ = watcher.typed("He go home".into(), t0 + Duration::from_millis(1000));
        assert!(!watcher.due(t0 + Duration::from_millis(1900)));
        assert!(watcher.due(t0 + Duration::from_millis(2200)));
        assert_eq!(watcher.take_due(t0 + Duration::from_millis(2200)), Some(Action::Check));
        assert_eq!(watcher.take_due(t0 + Duration::from_millis(2300)), None, "one check per pause");
    }

    #[test]
    fn the_badge_shows_fixes_and_hides_for_a_clean_text_or_new_typing() {
        let mut watcher = Watcher::default();
        let t0 = Instant::now();
        watcher.focus(Some(("He go".into(), 7)), t0);
        watcher.take_due(t0 + DEBOUNCE);
        assert_eq!(
            watcher.answered("He go", 2),
            vec![Action::ShowBadge { fixes: 2, token: 7 }],
            "two fixes show a badge"
        );
        assert_eq!(watcher.badge_text().as_deref(), Some("2"));
        assert_eq!(watcher.answered("He go", 0), vec![Action::HideBadge]);
        assert_eq!(watcher.badge_text(), None);
        // Typing hides the old badge and arms a new check.
        let actions = watcher.typed("He go home".into(), t0 + Duration::from_secs(3));
        assert_eq!(actions, vec![Action::HideBadge, Action::Arm(DEBOUNCE)]);
    }

    #[test]
    fn a_late_answer_for_older_text_is_dropped() {
        let mut watcher = Watcher::default();
        let t0 = Instant::now();
        watcher.focus(Some(("old".into(), 1)), t0);
        watcher.typed("new".into(), t0 + Duration::from_millis(10));
        assert!(watcher.answered("old", 3).is_empty());
    }

    #[test]
    fn empty_long_and_unchanged_texts_are_not_checked() {
        let mut watcher = Watcher::default();
        let t0 = Instant::now();
        assert_eq!(watcher.focus(Some(("   ".into(), 1)), t0), vec![Action::HideBadge]);
        assert!(watcher.take_due(t0 + DEBOUNCE).is_none());
        let long = "a".repeat(MAX_CHARS + 1);
        watcher.focus(Some((long, 2)), t0);
        assert!(watcher.take_due(t0 + DEBOUNCE).is_none());
        // A finished check does not repeat while the text stays the same.
        watcher.focus(Some(("He go".into(), 3)), t0);
        watcher.take_due(t0 + DEBOUNCE);
        watcher.answered("He go", 1);
        watcher.focus(Some(("He go".into(), 4)), t0 + Duration::from_secs(5));
        assert!(watcher.take_due(t0 + Duration::from_secs(9)).is_none(), "same text, no second check");
    }

    #[test]
    fn the_badge_only_shows_for_the_field_with_fixes() {
        let mut watcher = Watcher::default();
        let t0 = Instant::now();
        watcher.focus(Some(("He go".into(), 1)), t0);
        assert!(watcher.shows(1) && !watcher.shows(2));
        assert_eq!(watcher.badge_text(), None);
        watcher.answered("He go", 1);
        assert_eq!(watcher.badge_text().as_deref(), Some("1"));
    }
}
