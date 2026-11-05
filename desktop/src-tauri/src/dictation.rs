//! Push-to-talk dictation: hold the shortcut and speak, release to send the
//! audio to `POST /api/speech/dictate`, and the cleaned-up text is pasted
//! into the focused field. A quick tap starts hands-free recording instead;
//! the next press ends it. The focused app keeps focus throughout, and the
//! tray shows what is happening.

use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::audio::{AudioError, Recorder};
use crate::check::{self, PanelAction};
use crate::selection;
use crate::state::{self, AppState, lock};
use crate::tray::{self, Activity};
use crate::wav;
use crate::windows;

// A press shorter than this is a tap that latches recording on.
const TAP: Duration = Duration::from_millis(350);
const LIMIT: Duration = Duration::from_secs(60);
// Below this peak level the microphone delivered silence.
const SILENCE: f32 = 0.002;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Recording { started: Instant, latched: bool },
    Sending,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Start,
    Stop,
    Nothing,
}

/// The shortcut's state machine, kept free of side effects so it can be tested.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PushToTalk {
    pub phase: Phase,
}

impl Default for PushToTalk {
    fn default() -> Self {
        Self { phase: Phase::Idle }
    }
}

impl PushToTalk {
    pub fn press(&mut self, now: Instant) -> Step {
        match self.phase {
            Phase::Idle => {
                self.phase = Phase::Recording { started: now, latched: false };
                Step::Start
            }
            Phase::Recording { latched: true, .. } => {
                self.phase = Phase::Sending;
                Step::Stop
            }
            // Key repeat while held, or busy sending.
            Phase::Recording { latched: false, .. } | Phase::Sending => Step::Nothing,
        }
    }

    pub fn release(&mut self, now: Instant) -> Step {
        match self.phase {
            Phase::Recording { started, latched: false } if now.duration_since(started) < TAP => {
                self.phase = Phase::Recording { started, latched: true };
                Step::Nothing
            }
            Phase::Recording { latched: false, .. } => {
                self.phase = Phase::Sending;
                Step::Stop
            }
            _ => Step::Nothing,
        }
    }

    /// The time limit or a menu click ends a recording.
    pub fn stop(&mut self) -> Step {
        match self.phase {
            Phase::Recording { .. } => {
                self.phase = Phase::Sending;
                Step::Stop
            }
            _ => Step::Nothing,
        }
    }

    pub fn failed_to_start(&mut self) {
        self.phase = Phase::Idle;
    }

    pub fn finish(&mut self) {
        self.phase = Phase::Idle;
    }
}

#[derive(Default)]
pub struct DictationSession {
    machine: PushToTalk,
    recorder: Option<Recorder>,
    // Identifies one recording, so a stale time-limit timer does nothing.
    take: u64,
}

pub fn is_recording(state: &AppState) -> bool {
    matches!(lock(&state.dictation).machine.phase, Phase::Recording { .. })
}

pub fn on_press(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut changed = false;
    state.update_account(|account| {
        if !account.shortcut_pressed {
            account.shortcut_pressed = true;
            changed = true;
        }
    });
    if changed {
        // The settings window can now show that the key is being heard.
        state::publish(app);
    }
    let step = lock(&state.dictation).machine.press(Instant::now());
    perform(app, step);
}

pub fn on_release(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut changed = false;
    state.update_account(|account| {
        if account.shortcut_pressed {
            account.shortcut_pressed = false;
            changed = true;
        }
    });
    if changed {
        state::publish(app);
    }
    let step = lock(&state.dictation).machine.release(Instant::now());
    perform(app, step);
}

/// The tray menu item: starts hands-free recording, or ends it.
pub fn toggle(app: &AppHandle) {
    let state = app.state::<AppState>();
    let step = {
        let mut session = lock(&state.dictation);
        match session.machine.phase {
            Phase::Idle => {
                let step = session.machine.press(Instant::now());
                session.machine.phase = Phase::Recording { started: Instant::now(), latched: true };
                step
            }
            _ => session.machine.stop(),
        }
    };
    perform(app, step);
}

fn perform(app: &AppHandle, step: Step) {
    match step {
        Step::Start => start(app),
        Step::Stop => stop(app),
        Step::Nothing => {}
    }
}

fn start(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.session().is_none() {
        lock(&state.dictation).machine.failed_to_start();
        check::standalone_notice(
            app,
            "gloss is not set up yet",
            "Open gloss settings to connect to the server.",
            Some(PanelAction::OpenSettings),
        );
        return;
    }
    // The text goes to the focused field, which must not be the panel.
    if windows::panel_visible(app) {
        check::dismiss(app, true);
    }
    match Recorder::start(LIMIT) {
        Ok(recorder) => {
            let take = {
                let mut session = lock(&state.dictation);
                session.recorder = Some(recorder);
                session.take += 1;
                session.take
            };
            tray::set_activity(app, Activity::Listening);
            // Ends a forgotten hands-free recording at the server's limit.
            let app = app.clone();
            thread::spawn(move || {
                thread::sleep(LIMIT);
                let state = app.state::<AppState>();
                let step = {
                    let mut session = lock(&state.dictation);
                    if session.take != take { Step::Nothing } else { session.machine.stop() }
                };
                perform(&app, step);
            });
        }
        Err(error) => {
            lock(&state.dictation).machine.failed_to_start();
            let detail = match error {
                AudioError::NoDevice => "No microphone was found. Connect one and try again.",
                AudioError::Unavailable => {
                    "The microphone could not be opened. Check that gloss may use it in your system's privacy settings."
                }
            };
            check::standalone_notice(
                app,
                "Can't use the microphone",
                detail,
                Some(PanelAction::OpenMicrophoneSettings),
            );
        }
    }
}

fn stop(app: &AppHandle) {
    let state = app.state::<AppState>();
    let recorder = lock(&state.dictation).recorder.take();
    let Some(recorder) = recorder else {
        lock(&state.dictation).machine.finish();
        tray::set_activity(app, Activity::Idle);
        return;
    };
    tray::set_activity(app, Activity::Transcribing);
    let app = app.clone();
    thread::spawn(move || {
        let outcome = transcribe_and_insert(&app, recorder);
        let state = app.state::<AppState>();
        lock(&state.dictation).machine.finish();
        match outcome {
            Outcome::Inserted => tray::set_activity(&app, Activity::Idle),
            Outcome::Brief(message) => tray::flash(&app, message),
            Outcome::Notice { title, detail, action } => {
                tray::set_activity(&app, Activity::Idle);
                check::standalone_notice(&app, title, &detail, action);
            }
        }
    });
}

enum Outcome {
    Inserted,
    /// A short status in the tray; nothing went wrong.
    Brief(&'static str),
    Notice {
        title: &'static str,
        detail: String,
        action: Option<PanelAction>,
    },
}

fn transcribe_and_insert(app: &AppHandle, recorder: Recorder) -> Outcome {
    let state = app.state::<AppState>();
    let recording = recorder.stop();
    let samples = wav::resample(&recording.samples, recording.sample_rate, wav::TARGET_RATE);
    if wav::seconds(samples.len(), wav::TARGET_RATE) < wav::MIN_SECONDS {
        return Outcome::Brief("Hold the key while you speak");
    }
    if wav::peak(&samples) < SILENCE {
        return Outcome::Notice {
            title: "gloss heard only silence",
            detail: "Check the microphone, and that gloss may use it in your system's privacy settings.".into(),
            action: Some(PanelAction::OpenMicrophoneSettings),
        };
    }
    let Some(session) = state.session() else {
        return Outcome::Notice {
            title: "gloss is not set up yet",
            detail: "Open gloss settings to connect to the server.".into(),
            action: Some(PanelAction::OpenSettings),
        };
    };
    let audio = wav::encode_pcm16(&samples, wav::TARGET_RATE);
    let _ = &session;
    let result = tauri::async_runtime::block_on(async {
        let Some(session) = state::working_session(&state).await else {
            return Err(crate::api::ApiError::Unauthorized);
        };
        match state.client.dictate(&session, audio.clone()).await {
            Err(error) if error.is_unauthorized() => {
                log::info!("[gloss] dictation refused the session; starting a new guest and retrying once");
                state.credentials.delete(&state.origin());
                let Some(fresh) = state::working_session(&state).await else { return Err(error) };
                state.client.dictate(&fresh, audio).await
            }
            other => other,
        }
    });
    match result {
        Ok(result) if result.text.trim().is_empty() => Outcome::Brief("Nothing heard"),
        Ok(result) => match selection::insert(state.platform.as_ref(), &result.text) {
            Ok(()) => Outcome::Inserted,
            Err(_) => Outcome::Notice {
                title: "Couldn't paste the text",
                detail: format!("Here is what gloss heard: {}", result.text),
                action: None,
            },
        },
        Err(error) => {
            state::forget_session_if_unauthorized(app, &error);
            Outcome::Notice {
                title: "Dictation didn't work",
                detail: error.learner_message(&state.origin()),
                action: error.is_unauthorized().then_some(PanelAction::OpenSettings),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hold_records_until_release() {
        let t0 = Instant::now();
        let mut ptt = PushToTalk::default();
        assert_eq!(ptt.press(t0), Step::Start);
        // Key repeat while held does nothing.
        assert_eq!(ptt.press(t0 + Duration::from_millis(500)), Step::Nothing);
        assert_eq!(ptt.release(t0 + Duration::from_secs(2)), Step::Stop);
        assert_eq!(ptt.phase, Phase::Sending);
        assert_eq!(ptt.press(t0 + Duration::from_secs(3)), Step::Nothing, "busy while sending");
        ptt.finish();
        assert_eq!(ptt.phase, Phase::Idle);
    }

    #[test]
    fn a_tap_latches_until_the_next_press() {
        let t0 = Instant::now();
        let mut ptt = PushToTalk::default();
        assert_eq!(ptt.press(t0), Step::Start);
        assert_eq!(ptt.release(t0 + Duration::from_millis(120)), Step::Nothing);
        assert!(matches!(ptt.phase, Phase::Recording { latched: true, .. }));
        assert_eq!(ptt.release(t0 + Duration::from_secs(5)), Step::Nothing);
        assert_eq!(ptt.press(t0 + Duration::from_secs(10)), Step::Stop);
        assert_eq!(ptt.release(t0 + Duration::from_secs(10)), Step::Nothing);
    }

    #[test]
    fn the_time_limit_stops_a_recording_once() {
        let mut ptt = PushToTalk::default();
        ptt.press(Instant::now());
        assert_eq!(ptt.stop(), Step::Stop);
        assert_eq!(ptt.stop(), Step::Nothing);
    }

    #[test]
    fn a_failed_start_returns_to_idle() {
        let mut ptt = PushToTalk::default();
        ptt.press(Instant::now());
        ptt.failed_to_start();
        assert_eq!(ptt.phase, Phase::Idle);
        assert_eq!(ptt.press(Instant::now()), Step::Start);
    }
}
