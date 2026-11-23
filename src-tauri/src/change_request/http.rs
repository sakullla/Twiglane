//! 平台创建请求的限界 HTTP 边界。
//!
//! 与文档图片一致：rustls ring provider、显式总超时与连接超时、不使用代理、
//! 不自动跟随重定向（避免把令牌带到别的来源），响应体在读取过程中限界。
//! 这里只返回状态、头和限界后的字节，不记录请求头或响应原文。

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::Value;

use crate::error::AppError;

/// 默认上限：20 秒总超时、10 秒连接超时、512 KiB 响应体。
/// 用户操作是显式的一次创建，不需要长连接或大响应。
#[derive(Debug, Clone, Copy)]
pub struct HttpSettings {
    pub timeout: Duration,
    pub connect_timeout: Duration,
    pub body_limit: usize,
}

impl Default for HttpSettings {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(20),
            connect_timeout: Duration::from_secs(10),
            body_limit: 512 * 1024,
        }
    }
}

#[derive(Clone)]
pub struct Http {
    client: reqwest::Client,
    body_limit: usize,
    pub(crate) timeout: Duration,
}

/// 一次 HTTP 往返的结果。状态码之外的原文只作为分类输入，不直接进界面。
pub(crate) struct HttpReply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpReply {
    pub(crate) fn json(&self) -> Option<Value> {
        serde_json::from_slice(&self.body).ok()
    }

    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

impl Http {
    pub fn new(settings: HttpSettings) -> Result<Self, AppError> {
        // 与文档图片、updater 共用一个 ring provider，不引入第二个 TLS 后端。
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(settings.connect_timeout)
            .pool_max_idle_per_host(1)
            .pool_idle_timeout(Duration::from_secs(30))
            .no_proxy()
            .build()
            .map_err(|_| AppError::new("change_request_network", "无法初始化平台请求。"))?;
        Ok(Self {
            client,
            body_limit: settings.body_limit,
            timeout: settings.timeout,
        })
    }

    pub fn default_app() -> Result<Self, AppError> {
        static APP: OnceLock<Http> = OnceLock::new();
        if let Some(http) = APP.get() {
            return Ok(http.clone());
        }
        let http = Self::new(HttpSettings::default())?;
        Ok(APP.get_or_init(|| http).clone())
    }

    /// 不带认证的读取：只用于平台发现。认证头不会出现在这里。
    pub(crate) async fn probe(&self, url: &str, deadline: tokio::time::Instant) -> Result<HttpReply, AppError> {
        if tokio::time::Instant::now() >= deadline {
            return Err(AppError::new("change_request_network", "平台自动识别已超时。"));
        }
        self.request("GET", url, Vec::new(), None, true).await
    }

    /// 发送一次请求。json 有值时按 JSON 序列化并附带 content-type。
    pub(crate) async fn send(
        &self,
        method: &str,
        url: &str,
        headers: Vec<(&str, String)>,
        json: Option<&Value>,
    ) -> Result<HttpReply, AppError> {
        self.request(method, url, headers, json, false).await
    }

    async fn request(
        &self,
        method: &str,
        url: &str,
        headers: Vec<(&str, String)>,
        json: Option<&Value>,
        probe: bool,
    ) -> Result<HttpReply, AppError> {
        let parsed = reqwest::Url::parse(url)
            .map_err(|_| AppError::new("change_request_unknown", "平台请求地址无效。"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(AppError::new(
                "change_request_unknown",
                "平台请求只允许 HTTP(S) 地址。",
            ));
        }
        let method = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|_| AppError::new("change_request_unknown", "平台请求方法无效。"))?;
        let mut request = self
            .client
            .request(method.clone(), parsed)
            .header(reqwest::header::USER_AGENT, "Twiglane")
            .header(reqwest::header::ACCEPT, "application/json");
        // 发现流程由同一个 deadline 取消。避免单请求超时先唤醒发现流程并启动下一探针。
        if !probe {
            request = request.timeout(self.timeout);
        }
        for (name, value) in headers {
            request = request.header(name, value);
        }
        if let Some(value) = json {
            request = request.json(value);
        }
        let mut response = request
            .send()
            .await
            .map_err(|error| transport_error(&error, &method))?;
        let status = response.status().as_u16();
        let mut headers = Vec::new();
        if probe && status != 200 {
            return Ok(HttpReply { status, headers, body: Vec::new() });
        }
        if !probe {
            for name in ["retry-after", "x-ratelimit-remaining"] {
                if let Some(value) = response.headers().get(name).and_then(|value| value.to_str().ok()) {
                    headers.push((name.to_owned(), value.to_owned()));
                }
            }
        }
        if response
            .content_length()
            .is_some_and(|size| size > self.body_limit as u64)
        {
            return Err(body_too_large());
        }
        let mut body = Vec::new();
        loop {
            let chunk = response
                .chunk()
                .await
                .map_err(|error| transport_error(&error, &method))?;
            let Some(chunk) = chunk else { break };
            if body.len().saturating_add(chunk.len()) > self.body_limit {
                return Err(body_too_large());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(HttpReply {
            status,
            headers,
            body,
        })
    }
}

fn body_too_large() -> AppError {
    AppError::new(
        "change_request_unknown",
        "平台响应超过读取上限，已停止读取，未当作创建结果。",
    )
}

/// 传输层错误分成两类：连接没有建立，请求肯定没有发出；POST 的超时或中断
/// 则无法证明平台是否已经处理，必须如实标记为「结果未知」。
fn transport_error(error: &reqwest::Error, method: &reqwest::Method) -> AppError {
    if error.is_connect() {
        return AppError::new(
            "change_request_network",
            "无法连接平台实例，请检查网络、地址或代理；没有创建 MR/PR。",
        );
    }
    if method == reqwest::Method::POST {
        return AppError::new(
            "change_request_unknown",
            "请求已发出但未拿到完整响应，创建结果未知。请先在平台核对，不要直接重复创建。",
        );
    }
    AppError::new(
        "change_request_network",
        "平台请求超时或中断，没有拿到响应；没有创建 MR/PR。",
    )
}
