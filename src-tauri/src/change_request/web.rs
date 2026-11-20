//! 保守网页回退：只有适配器明确证明当前实例不支持创建时才走到这里。
//!
//! 网页地址来自已确认实例的仓库网页基址，路径段和 query 值分别百分号编码，
//! 分支名里的斜杠、空格和 Unicode 不改变 URL 结构。超过网页地址长度上限时
//! 先省略标题与描述，仍超限则报错而不是打开截断地址。

use crate::error::AppError;

use super::provider::Provider;

/// 与 validate_web_url 的既有上限一致：超过就不打开。
const MAX_URL_BYTES: usize = 8192;

#[derive(Debug)]
pub(crate) struct FallbackPage {
    pub url: String,
    /// 是否把标题和描述带进网页。GitLab 只有一个官方可核验的来源分支参数，
    /// 因此只预填来源，不声称目标、标题或描述已带入。
    pub prefilled: bool,
}

/// 打开系统浏览器的最小接口。lib.rs 用 tauri-plugin-opener 实现，测试用 fake。
pub trait WebOpener: Send + Sync {
    fn open(&self, url: &str) -> Result<(), AppError>;
}

pub(crate) fn fallback_page(
    provider: Provider,
    repo_web: &str,
    source: &str,
    target: &str,
    title: &str,
    body: &str,
) -> Result<FallbackPage, AppError> {
    let base = repo_web.trim_end_matches('/');
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err(fallback_url_error());
    }
    let encoded_target = encode_component(target);
    let encoded_source = encode_component(source);
    let page = match provider {
        Provider::GitHub => format!(
            "{base}/compare/{encoded_target}...{encoded_source}?quick_pull=1&title={}&body={}",
            encode_component(title),
            encode_component(body)
        ),
        Provider::Gitea => format!(
            "{base}/compare/{encoded_target}...{encoded_source}?expand=1&title={}&body={}",
            encode_component(title),
            encode_component(body)
        ),
        Provider::GitLab => format!(
            "{base}/-/merge_requests/new?merge_request%5Bsource_branch%5D={encoded_source}"
        ),
    };
    if page.len() <= MAX_URL_BYTES {
        return Ok(FallbackPage {
            url: page,
            prefilled: !matches!(provider, Provider::GitLab),
        });
    }
    // 超长时先去掉标题与描述，保留分支和新建表单参数。
    let shortened = match provider {
        Provider::GitHub => format!(
            "{base}/compare/{encoded_target}...{encoded_source}?quick_pull=1"
        ),
        Provider::Gitea => {
            format!("{base}/compare/{encoded_target}...{encoded_source}?expand=1")
        }
        Provider::GitLab => String::new(),
    };
    if !shortened.is_empty() && shortened.len() <= MAX_URL_BYTES {
        return Ok(FallbackPage {
            url: shortened,
            prefilled: false,
        });
    }
    Err(fallback_url_error())
}

fn fallback_url_error() -> AppError {
    AppError::new(
        "change_request_fallback_url",
        "无法构造可信的新建网页地址，未打开浏览器，也未创建 MR/PR。",
    )
}

/// 打开网页前重新按既有网页地址规则校验；打开失败返回 browser_open，
/// 不显示创建成功，也不把回退当作已创建。
pub(crate) fn open_page(opener: &dyn WebOpener, page: &FallbackPage) -> Result<(), AppError> {
    crate::git::document::validate_web_url(&page.url)
        .map_err(|_| fallback_url_error())?;
    opener.open(&page.url)
}

/// RFC 3986 非保留字符之外的字节全部百分号编码。斜杠也编码，
/// 保证分支名里的 / 只改变参数值而不改变 URL 结构。
pub(crate) fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}
