use std::sync::LazyLock;

use regex::Regex;

use crate::error::AppError;

static URL_USERINFO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b([a-z][a-z0-9+.-]*)://([^/\s:@]+):([^/\s@]+)@").expect("url regex")
});
static BEARER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._\-]{8,}").expect("bearer regex"));
static GH_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b").expect("gh token regex")
});
static GH_PAT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b").expect("github pat regex")
});
static GL_PAT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bglpat-[A-Za-z0-9_\-]{20,}\b").expect("gitlab pat regex"));
static PEM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----")
        .expect("pem regex")
});
static PEM_HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----").expect("pem header regex")
});
static ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(password|passwd|token|secret|api[_-]?key|authorization)\b(\s*[:=]\s*)(\S+)",
    )
    .expect("assignment regex")
});

pub fn redact(input: &str) -> String {
    let mut text = PEM.replace_all(input, "[redacted-private-key]").into_owned();
    text = PEM_HEADER
        .replace_all(&text, "[redacted-private-key]")
        .into_owned();
    text = URL_USERINFO
        .replace_all(&text, "$1://[redacted]@")
        .into_owned();
    text = BEARER.replace_all(&text, "Bearer [redacted]").into_owned();
    text = GH_TOKEN
        .replace_all(&text, "[redacted-token]")
        .into_owned();
    text = GH_PAT
        .replace_all(&text, "[redacted-token]")
        .into_owned();
    text = GL_PAT
        .replace_all(&text, "[redacted-token]")
        .into_owned();
    ASSIGNMENT
        .replace_all(&text, "$1$2[redacted]")
        .into_owned()
}

pub fn contains_secret(input: &str) -> bool {
    PEM.is_match(input)
        || PEM_HEADER.is_match(input)
        || URL_USERINFO.is_match(input)
        || BEARER.is_match(input)
        || GH_TOKEN.is_match(input)
        || GH_PAT.is_match(input)
        || GL_PAT.is_match(input)
        || ASSIGNMENT.is_match(input)
}

pub fn redact_error_text(input: &str) -> String {
    let redacted = redact(input);
    const MAX: usize = 400;
    if redacted.chars().count() <= MAX {
        return redacted;
    }
    let truncated: String = redacted.chars().take(MAX).collect();
    format!("{truncated}…")
}

pub fn reject_secret_draft(message: &str) -> Result<(), AppError> {
    if contains_secret(message) {
        return Err(AppError::new(
            "draft_secret",
            "草稿包含疑似凭据或私钥，未写入应用数据。",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_url_userinfo_tokens_and_keys() {
        let raw = "failed https://user:ghp_abcdefghijklmnopqrstuvwxyz1234@github.com/acme/app token=supersecret Authorization: Bearer abc.def.ghi\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
        let cleaned = redact(raw);
        assert!(!cleaned.contains("user:ghp_"));
        assert!(!cleaned.contains("ghp_abcdefghijklmnopqrstuvwxyz1234"));
        assert!(!cleaned.contains("supersecret"));
        assert!(!cleaned.contains("abc.def.ghi"));
        assert!(!cleaned.contains("BEGIN OPENSSH"));
        assert!(cleaned.contains("https://[redacted]@github.com/acme/app"));
        assert!(cleaned.contains("[redacted-private-key]"));
    }

    #[test]
    fn leaves_ordinary_paths_and_sentences() {
        let raw = "pathspec 'src/app.ts' did not match /Users/me/project";
        assert_eq!(redact(raw), raw);
        assert!(!contains_secret("修正 token 解析逻辑"));
    }
}
