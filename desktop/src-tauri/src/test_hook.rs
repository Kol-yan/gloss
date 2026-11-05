//! Authentication for the debug-only loopback helper. The marker must contain
//! a freshly generated 32-byte random token encoded as 64 hexadecimal digits.

pub fn marker_token(bytes: &[u8]) -> Option<String> {
    let marker: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let token = marker.get("token")?.as_str()?;
    (token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit())).then(|| token.to_owned())
}

pub fn authorized(request: &str, token: &str) -> bool {
    let Some((headers, _)) = request.split_once("\r\n\r\n") else { return false };
    let mut supplied = None;
    for line in headers.split("\r\n").skip(1) {
        let Some((name, value)) = line.split_once(':') else { return false };
        if name.trim().eq_ignore_ascii_case("origin") {
            return false;
        }
        if name.trim().eq_ignore_ascii_case("x-gloss-test-token") {
            if supplied.is_some() {
                return false;
            }
            supplied = Some(value.trim());
        }
    }
    supplied == Some(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn requires_a_well_formed_marker_token() {
        assert_eq!(marker_token(format!(r#"{{"token":"{TOKEN}"}}"#).as_bytes()).as_deref(), Some(TOKEN));
        for marker in [b"{}".as_slice(), br#"{"token":""}"#, br#"{"token":"short"}"#, b"invalid"] {
            assert_eq!(marker_token(marker), None);
        }
    }

    #[test]
    fn rejects_browser_origins_even_with_the_token() {
        for origin in ["Origin: https://example.com", "oRiGiN: null", "Origin:"] {
            assert!(!authorized(
                &format!("POST /simulate_typing HTTP/1.1\r\nX-Gloss-Test-Token: {TOKEN}\r\n{origin}\r\n\r\n"),
                TOKEN
            ));
        }
    }

    #[test]
    fn requires_exact_token_and_complete_unambiguous_headers() {
        assert!(authorized(&format!("POST /simulate_typing HTTP/1.1\r\nx-gloss-test-token: {TOKEN}\r\n\r\n"), TOKEN));
        for request in [
            "POST /simulate_typing HTTP/1.1\r\n\r\n".to_owned(),
            "POST /simulate_typing HTTP/1.1\r\nX-Gloss-Test-Token: wrong\r\n\r\n".to_owned(),
            format!("POST /simulate_typing HTTP/1.1\r\nX-Gloss-Test-Token: {TOKEN}\r\n"),
            format!(
                "POST /simulate_typing HTTP/1.1\r\nX-Gloss-Test-Token: {TOKEN}\r\nX-Gloss-Test-Token: {TOKEN}\r\n\r\n"
            ),
        ] {
            assert!(!authorized(&request, TOKEN));
        }
    }
}
