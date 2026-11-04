//! Client for the gloss server API. The types mirror the parts of
//! `src/shared/contracts.ts` this app uses; a response that does not parse is
//! treated as a bad response, never guessed.
//!
//! Signing in reuses the web app's own session: the invite link is redeemed
//! through `POST /join/{token}/continue`, exactly like the Continue button on
//! the invite page, and the `glossy_session` (or `glossy_session_<port>` on a
//! development server) cookie it sets is the credential for every later
//! request.

use std::collections::HashMap;
use std::time::Duration;

use reqwest::header::{CONTENT_TYPE, COOKIE, LOCATION, SET_COOKIE};
use reqwest::{StatusCode, redirect};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::credentials::looks_like_token;

pub const SESSION_COOKIE: &str = "glossy_session";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SuggestionCategory {
    Error,
    Style,
    Expression,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub id: String,
    pub source: String,
    pub category: SuggestionCategory,
    pub start: usize,
    pub end: usize,
    pub original: String,
    pub replacement: String,
    pub reason: String,
    pub meaning_change: bool,
    pub meaning: Option<String>,
    #[serde(default)]
    pub ipa: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct QuotaState {
    pub used: f64,
    pub limit: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofreadResponse {
    pub text_hash: String,
    pub suggestions: Vec<Suggestion>,
    pub quota: QuotaState,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeLearner {
    pub display_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeResponse {
    pub learner: MeLearner,
    pub access_mode: String,
    pub ai_enabled: bool,
    pub quotas: HashMap<String, QuotaState>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationResponse {
    /// Punctuated, fillers removed, the learner's words unchanged; equal to
    /// the raw transcript when the clean-up step was unavailable.
    pub text: String,
}

#[derive(Debug, Deserialize)]
struct ApiErrorBody {
    error: ApiErrorDetail,
}

#[derive(Debug, Deserialize)]
struct ApiErrorDetail {
    code: String,
    message: String,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum ApiError {
    /// The server answered with its own error code and learner-safe message.
    #[error("{message}")]
    Server { code: String, message: String },
    #[error("network")]
    Network,
    #[error("bad response")]
    BadResponse,
    #[error("invalid invite")]
    InvalidInvite,
}

impl ApiError {
    pub fn is_unauthorized(&self) -> bool {
        matches!(self, ApiError::Server { code, .. } if code == "unauthorized")
    }

    /// A short sentence for the learner. Server messages are already written
    /// for learners; everything else gets a fixed sentence, never raw details.
    pub fn learner_message(&self, origin: &str) -> String {
        match self {
            ApiError::Server { code, .. } if code == "unauthorized" => {
                "Your session has ended. Sign in again in gloss settings.".into()
            }
            ApiError::Server { message, .. } => message.clone(),
            ApiError::Network => format!("Can't reach gloss at {origin}. Check that the server is running."),
            ApiError::BadResponse => {
                "gloss sent an answer this app does not understand. Is the server up to date?".into()
            }
            ApiError::InvalidInvite => "This invite link is not valid any more. Ask for a new one.".into(),
        }
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

/// Where requests go and who makes them.
#[derive(Clone)]
pub struct Session {
    pub server: Url,
    pub token: String,
    /// The cookie name the server issued. Development servers include their
    /// port in the name so several local workspaces keep separate sessions.
    pub cookie_name: String,
    /// Created by this app from an invite (see `credentials::StoredSession`).
    pub owned: bool,
}

impl Session {
    fn url(&self, path: &str) -> ApiResult<Url> {
        self.server.join(path).map_err(|_| ApiError::BadResponse)
    }

    fn cookie(&self) -> ApiResult<String> {
        // Never place anything but a well-formed token in a header.
        if !looks_like_token(&self.token) || !is_session_cookie_name(&self.cookie_name) {
            return Err(ApiError::Server { code: "unauthorized".into(), message: String::new() });
        }
        Ok(format!("{}={}", self.cookie_name, self.token))
    }
}

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
}

const USER_AGENT: &str = concat!("gloss-desktop/", env!("CARGO_PKG_VERSION"));
// Model calls can take a while; the server bounds them itself.
const MODEL_TIMEOUT: Duration = Duration::from_secs(90);
const QUICK_TIMEOUT: Duration = Duration::from_secs(15);

impl Client {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(10))
            // Redirects are read, not followed: the invite flow answers 303
            // and must not carry the session anywhere else.
            .redirect(redirect::Policy::none())
            .build()
            .expect("HTTP client configuration is static");
        Self { http }
    }

    /// Redeems an invite exactly like the invite page's Continue button and
    /// returns the cookie name and session token the server sets.
    pub async fn redeem_invite(&self, server: &Url, invite_token: &str) -> ApiResult<(String, String)> {
        if !looks_like_token(invite_token) {
            return Err(ApiError::InvalidInvite);
        }
        let url = server.join(&format!("join/{invite_token}/continue")).map_err(|_| ApiError::InvalidInvite)?;
        let response = self
            .http
            .post(url)
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body("")
            .timeout(QUICK_TIMEOUT)
            .send()
            .await
            .map_err(|_| ApiError::Network)?;

        let status = response.status();
        if status == StatusCode::SEE_OTHER {
            let location = response.headers().get(LOCATION).and_then(|v| v.to_str().ok()).unwrap_or("");
            if location.contains("invite=invalid") {
                return Err(ApiError::InvalidInvite);
            }
            return session_from_set_cookie(
                response.headers().get_all(SET_COOKIE).iter().filter_map(|v| v.to_str().ok()),
            )
            .ok_or(ApiError::BadResponse);
        }
        Err(error_from_response(response).await)
    }

    pub async fn me(&self, session: &Session) -> ApiResult<MeResponse> {
        let response = self
            .http
            .get(session.url("api/me")?)
            .header(COOKIE, session.cookie()?)
            .timeout(QUICK_TIMEOUT)
            .send()
            .await
            .map_err(|_| ApiError::Network)?;
        parse(response).await
    }

    pub async fn proofread(&self, session: &Session, text: &str) -> ApiResult<ProofreadResponse> {
        // The id lets the server answer a retried request from its record.
        let body = serde_json::json!({ "requestId": uuid::Uuid::new_v4().to_string(), "text": text });
        let response = self
            .http
            .post(session.url("api/proofread")?)
            .header(COOKIE, session.cookie()?)
            .json(&body)
            .timeout(MODEL_TIMEOUT)
            .send()
            .await
            .map_err(|_| ApiError::Network)?;
        parse(response).await
    }

    /// Records that the learner accepted a suggestion; this is what turns an
    /// applied fix into assisted use on the server.
    pub async fn record_decision(
        &self,
        session: &Session,
        suggestion_id: &str,
        decision: &str,
        text_hash: &str,
    ) -> ApiResult<()> {
        let mut url = session.url("api/suggestions/")?;
        url.path_segments_mut().map_err(|_| ApiError::BadResponse)?.pop_if_empty().push(suggestion_id);
        let response = self
            .http
            .post(url)
            .header(COOKIE, session.cookie()?)
            .json(&serde_json::json!({ "decision": decision, "textHash": text_hash }))
            .timeout(QUICK_TIMEOUT)
            .send()
            .await
            .map_err(|_| ApiError::Network)?;
        parse::<serde_json::Value>(response).await.map(|_| ())
    }

    /// `wav` must be RIFF/WAVE mono 16-bit PCM at 16 kHz (see `wav.rs`).
    pub async fn dictate(&self, session: &Session, wav: Vec<u8>) -> ApiResult<DictationResponse> {
        let part = reqwest::multipart::Part::bytes(wav)
            .file_name("dictation.wav")
            .mime_str("audio/wav")
            .map_err(|_| ApiError::BadResponse)?;
        let form = reqwest::multipart::Form::new().part("audio", part);
        let response = self
            .http
            .post(session.url("api/speech/dictate")?)
            .header(COOKIE, session.cookie()?)
            .multipart(form)
            .timeout(MODEL_TIMEOUT)
            .send()
            .await
            .map_err(|_| ApiError::Network)?;
        parse(response).await
    }

    /// Ends the session on the server. The access routes accept only an empty
    /// JSON object.
    pub async fn sign_out(&self, session: &Session) -> ApiResult<()> {
        let response = self
            .http
            .post(session.url("api/access/signout")?)
            .header(COOKIE, session.cookie()?)
            .json(&serde_json::json!({}))
            .timeout(QUICK_TIMEOUT)
            .send()
            .await
            .map_err(|_| ApiError::Network)?;
        parse::<serde_json::Value>(response).await.map(|_| ())
    }
}

async fn parse<T: for<'de> Deserialize<'de>>(response: reqwest::Response) -> ApiResult<T> {
    if !response.status().is_success() {
        return Err(error_from_response(response).await);
    }
    let bytes = response.bytes().await.map_err(|_| ApiError::Network)?;
    serde_json::from_slice(&bytes).map_err(|_| ApiError::BadResponse)
}

async fn error_from_response(response: reqwest::Response) -> ApiError {
    let status = response.status();
    let body = response.bytes().await.ok();
    error_from_body(status, body.as_deref())
}

fn error_from_body(status: StatusCode, body: Option<&[u8]>) -> ApiError {
    match body.and_then(|b| serde_json::from_slice::<ApiErrorBody>(b).ok()) {
        Some(parsed) => ApiError::Server { code: parsed.error.code, message: parsed.error.message },
        None if status == StatusCode::UNAUTHORIZED => {
            ApiError::Server { code: "unauthorized".into(), message: String::new() }
        }
        None => ApiError::BadResponse,
    }
}

/// Whether `name` is the session cookie name the server uses. Production
/// keeps `glossy_session`; a development server adds its port.
fn is_session_cookie_name(name: &str) -> bool {
    if name == SESSION_COOKIE {
        return true;
    }
    name.strip_prefix(SESSION_COOKIE)
        .and_then(|rest| rest.strip_prefix('_'))
        .is_some_and(|port| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()))
}

/// Finds a non-empty, well-formed session cookie among `Set-Cookie` headers
/// and keeps its name so later requests send it back unchanged.
fn session_from_set_cookie<'a>(headers: impl Iterator<Item = &'a str>) -> Option<(String, String)> {
    for header in headers {
        let pair = header.split(';').next().unwrap_or("").trim();
        if let Some((name, value)) = pair.split_once('=') {
            let name = name.trim();
            let value = value.trim();
            if is_session_cookie_name(name) && looks_like_token(value) {
                return Some((name.to_owned(), value.to_owned()));
            }
        }
    }
    None
}

/// Accepts a bare session token or a `name=value` pair copied from the
/// browser's cookie list. The session cookie name is preserved when present.
pub fn session_from_input(input: &str) -> Option<(String, String)> {
    let trimmed = input.trim();
    let (name, value) = match trimmed.split_once('=') {
        Some((name, value)) if is_session_cookie_name(name.trim()) => (name.trim(), value.trim()),
        _ => (SESSION_COOKIE, trimmed),
    };
    looks_like_token(value).then(|| (name.to_owned(), value.to_owned()))
}

/// Accepts an invite link (`https://host/join/<token>`) or the bare token.
/// A link for another server is refused so a session is never created on a
/// server the learner did not choose.
pub fn invite_token_from_input(input: &str, server: &Url) -> Result<String, String> {
    let trimmed = input.trim();
    if looks_like_token(trimmed) {
        return Ok(trimmed.to_owned());
    }
    let url = Url::parse(trimmed).map_err(|_| "Paste the whole invite link, starting with http.".to_string())?;
    if url.origin() != server.origin() {
        return Err(format!(
            "This invite is for {}. Change the server address to it first.",
            url.origin().ascii_serialization()
        ));
    }
    let mut segments = url.path_segments().into_iter().flatten().filter(|s| !s.is_empty());
    match (segments.next(), segments.next(), segments.next()) {
        (Some("join"), Some(token), None) if looks_like_token(token) => Ok(token.to_owned()),
        _ => Err("That is not an invite link. It should look like …/join/abc123….".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_Q";

    #[test]
    fn reads_the_session_cookie() {
        let headers = [
            "other=1; Path=/",
            "glossy_session=abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_Q; Path=/; HttpOnly; SameSite=lax",
        ];
        assert_eq!(session_from_set_cookie(headers.into_iter()), Some(("glossy_session".to_owned(), TOKEN.to_owned())));
        assert_eq!(session_from_set_cookie(["glossy_session=; Max-Age=0"].into_iter()), None);
    }

    #[test]
    fn reads_a_port_scoped_session_cookie() {
        let headers = ["glossy_session_3621=abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_Q; Path=/"];
        assert_eq!(
            session_from_set_cookie(headers.into_iter()),
            Some(("glossy_session_3621".to_owned(), TOKEN.to_owned()))
        );
    }

    #[test]
    fn rejects_cookie_names_that_only_look_like_sessions() {
        for name in ["glossy_session_", "glossy_session_abc", "glossy_session_12x", "session_3000"] {
            assert!(!is_session_cookie_name(name), "{name}");
        }
        assert!(is_session_cookie_name("glossy_session"));
        assert!(is_session_cookie_name("glossy_session_3000"));
    }

    #[test]
    fn reads_a_session_from_browser_input() {
        assert_eq!(session_from_input(TOKEN), Some((SESSION_COOKIE.to_owned(), TOKEN.to_owned())));
        assert_eq!(
            session_from_input(&format!("glossy_session_3000={TOKEN}")),
            Some(("glossy_session_3000".to_owned(), TOKEN.to_owned()))
        );
        assert_eq!(session_from_input("short"), None);
        assert_eq!(session_from_input("other=abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_Q"), None);
    }

    #[test]
    fn sends_the_cookie_back_under_the_name_it_was_issued_with() {
        let server = Url::parse("http://localhost:3000").unwrap();
        let session =
            Session { server, token: TOKEN.to_owned(), cookie_name: "glossy_session_3000".to_owned(), owned: true };
        assert_eq!(session.cookie().unwrap(), format!("glossy_session_3000={TOKEN}"));
    }

    #[test]
    fn parses_invite_links_for_the_chosen_server_only() {
        let server = Url::parse("http://localhost:3000").unwrap();
        assert_eq!(invite_token_from_input(&format!("http://localhost:3000/join/{TOKEN}"), &server).unwrap(), TOKEN);
        assert_eq!(invite_token_from_input(&format!("  {TOKEN} "), &server).unwrap(), TOKEN);
        assert!(invite_token_from_input(&format!("https://gloss.example/join/{TOKEN}"), &server).is_err());
        assert!(invite_token_from_input("http://localhost:3000/join/short", &server).is_err());
        assert!(invite_token_from_input(&format!("http://localhost:3000/x/join/{TOKEN}"), &server).is_err());
        assert!(invite_token_from_input("not a link", &server).is_err());
    }

    #[test]
    fn maps_server_errors_to_their_codes() {
        let body = br#"{"error":{"code":"quota_exceeded","message":"You have used today's allowance."}}"#;
        match error_from_body(StatusCode::TOO_MANY_REQUESTS, Some(body)) {
            ApiError::Server { code, message } => {
                assert_eq!(code, "quota_exceeded");
                assert_eq!(message, "You have used today's allowance.");
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(error_from_body(StatusCode::UNAUTHORIZED, Some(b"<html>")).is_unauthorized());
        assert!(matches!(error_from_body(StatusCode::BAD_GATEWAY, None), ApiError::BadResponse));
    }

    /// Talks to a running gloss server:
    /// `GLOSS_TEST_SERVER=http://localhost:3000 GLOSS_TEST_INVITE=<link> cargo test -- --ignored`
    /// The invite is spent. Cloud calls may answer `ai_disabled` on a server
    /// without model keys; the test then checks the error mapping instead.
    #[test]
    #[ignore = "needs a running gloss server and an invite link"]
    fn live_server_round_trip() {
        let server = Url::parse(&std::env::var("GLOSS_TEST_SERVER").expect("GLOSS_TEST_SERVER")).unwrap();
        let link = std::env::var("GLOSS_TEST_INVITE").expect("GLOSS_TEST_INVITE");
        let origin = server.origin().ascii_serialization();
        tauri::async_runtime::block_on(async {
            let client = Client::new();
            let invite = invite_token_from_input(&link, &server).unwrap();
            let (cookie_name, token) = client.redeem_invite(&server, &invite).await.expect("redeem");
            let session = Session { server: server.clone(), token, cookie_name, owned: true };

            let me = client.me(&session).await.expect("me");
            println!("signed in as {} ({}), AI enabled: {}", me.learner.display_name, me.access_mode, me.ai_enabled);

            // A spent single-use invite reports the invalid-invite state.
            match client.redeem_invite(&server, &invite).await {
                Err(ApiError::InvalidInvite) | Ok(_) => {}
                Err(other) => panic!("unexpected {other:?}"),
            }

            match client.proofread(&session, "He go to school yesterday.").await {
                Ok(result) => {
                    println!("{} suggestion(s)", result.suggestions.len());
                    for s in &result.suggestions {
                        client.record_decision(&session, &s.id, "accepted", &result.text_hash).await.expect("decision");
                    }
                }
                Err(error) => println!("proofread: {}", error.learner_message(&origin)),
            }

            let silence = crate::wav::encode_pcm16(&vec![0.0; 16_000], crate::wav::TARGET_RATE);
            match client.dictate(&session, silence).await {
                Ok(result) => println!("dictation: {:?}", result.text),
                Err(error) => println!("dictate: {}", error.learner_message(&origin)),
            }

            client.sign_out(&session).await.expect("sign out");
            assert!(client.me(&session).await.unwrap_err().is_unauthorized());
        });
    }

    #[test]
    fn parses_contract_shaped_responses() {
        let proofread = r#"{"checkRunId":"r1","textHash":"h","quota":{"used":1,"limit":20},
          "suggestions":[{"id":"s1","source":"ai","category":"error","start":3,"end":5,"original":"go",
          "replacement":"went","reason":"Past tense.","meaningChange":false,"meaning":null}]}"#;
        let parsed: ProofreadResponse = serde_json::from_str(proofread).unwrap();
        assert_eq!(parsed.suggestions[0].category, SuggestionCategory::Error);
        assert_eq!(parsed.suggestions[0].ipa, None);

        let me = r#"{"learner":{"id":"l1","displayName":"Judges 1"},"accessMode":"hosted","aiEnabled":true,
          "quotas":{"proofread":{"used":0,"limit":20},"asrSeconds":{"used":12.5,"limit":600}}}"#;
        let parsed: MeResponse = serde_json::from_str(me).unwrap();
        assert_eq!(parsed.learner.display_name, "Judges 1");
        assert_eq!(parsed.quotas["asrSeconds"].used, 12.5);
    }
}
