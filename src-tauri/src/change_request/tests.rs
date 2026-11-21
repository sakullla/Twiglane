//! T2 的可控开发验证：远程解析、平台发现、三平台请求、错误分类、网页回退、
//! 钥匙串隔离与开关门禁。HTTP 全部指向 127.0.0.1 上的可控服务，不触真实平台；
//! 钥匙串用 trait fake，不读写系统凭据，因此这些测试不构成实机平台证据。

mod create_cases;
mod local_cases;
mod prepare_cases;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::credential::{CredentialFailure, CredentialStore};
use super::http::{Http, HttpSettings};
use super::*;
use crate::git::ops::Backend;

// ------------------------------------------------------------ 可控 HTTP 服务

struct Reply {
    status: u16,
    body: String,
    delay: Duration,
}

fn reply(status: u16, body: &str) -> Reply {
    Reply {
        status,
        body: body.to_string(),
        delay: Duration::ZERO,
    }
}

impl Reply {
    fn slow(mut self, delay_ms: u64) -> Self {
        self.delay = Duration::from_millis(delay_ms);
        self
    }
}

#[derive(Debug)]
struct Recorded {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl Recorded {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body).unwrap_or(serde_json::Value::Null)
    }
}

fn http_response(status: u16, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

fn read_request(stream: &mut std::net::TcpStream) -> Recorded {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut raw = Vec::new();
    let mut buffer = [0u8; 4096];
    while !raw.windows(4).any(|window| window == b"\r\n\r\n") {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => raw.extend_from_slice(&buffer[..count]),
        }
    }
    let head_end = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
        .unwrap_or(raw.len());
    let head = String::from_utf8_lossy(&raw[..head_end]).into_owned();
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or_default().to_string();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let mut headers = Vec::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
    }
    let length = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = raw[head_end..].to_vec();
    while body.len() < length {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => body.extend_from_slice(&buffer[..count]),
        }
    }
    Recorded {
        method,
        path,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    }
}

/// 先占住端口再构造依赖 base 的应答。
fn bind_server() -> (TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    (listener, base)
}

fn serve(responses: Vec<Reply>) -> (String, JoinHandle<(Vec<Recorded>, usize)>) {
    let (listener, base) = bind_server();
    (base, serve_on(listener, responses))
}

/// 顺序应答固定数量的请求；返回记录。多出来的连接说明客户端重试了。
/// 客户端没有发起预期的请求时，等待最多 5 秒后返回，测试不会因此挂死。
fn serve_on(
    listener: TcpListener,
    responses: Vec<Reply>,
) -> JoinHandle<(Vec<Recorded>, usize)> {
    std::thread::spawn(move || {
        let mut records = Vec::new();
        for reply in responses {
            let deadline = Instant::now() + Duration::from_secs(5);
            let stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break Some(stream),
                    Err(_) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break None,
                }
            };
            let Some(mut stream) = stream else { break };
            stream.set_nonblocking(false).unwrap();
            let request = read_request(&mut stream);
            records.push(request);
            if !reply.delay.is_zero() {
                std::thread::sleep(reply.delay);
                // 超时路径：不回任何字节就断开，模拟请求已发出但结果未知。
                continue;
            }
            let _ = stream.write_all(&http_response(reply.status, &reply.body));
            let _ = stream.flush();
        }
        let deadline = Instant::now() + Duration::from_millis(200);
        let mut extra = 0;
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    extra += 1;
                    let _ = stream.write_all(&http_response(500, "{}"));
                }
                Err(_) => std::thread::sleep(Duration::from_millis(10)),
            }
        }
        (records, extra)
    })
}

fn http_with(limit: usize, timeout_ms: u64) -> Http {
    Http::new(HttpSettings {
        timeout: Duration::from_millis(timeout_ms),
        connect_timeout: Duration::from_millis(timeout_ms),
        body_limit: limit,
    })
    .unwrap()
}

// ------------------------------------------------------------ 钥匙串 fake

#[derive(Default)]
struct FakeStore {
    entries: Mutex<HashMap<String, String>>,
    loads: AtomicUsize,
    saves: AtomicUsize,
    deletes: AtomicUsize,
    fail: AtomicBool,
}

impl FakeStore {
    fn with_token(key: &str, secret: &str) -> Arc<Self> {
        let store = FakeStore::default();
        store
            .entries
            .lock()
            .unwrap()
            .insert(key.to_string(), secret.to_string());
        Arc::new(store)
    }

    fn failing() -> Arc<Self> {
        let store = FakeStore::default();
        store.fail.store(true, Ordering::SeqCst);
        Arc::new(store)
    }

    fn loads(&self) -> usize {
        self.loads.load(Ordering::SeqCst)
    }

    fn saves(&self) -> usize {
        self.saves.load(Ordering::SeqCst)
    }

    fn stored(&self, key: &str) -> Option<String> {
        self.entries.lock().unwrap().get(key).cloned()
    }
}

impl CredentialStore for FakeStore {
    fn load(&self, key: &str) -> Result<Option<String>, CredentialFailure> {
        self.loads.fetch_add(1, Ordering::SeqCst);
        if self.fail.load(Ordering::SeqCst) {
            return Err(CredentialFailure::Unavailable);
        }
        Ok(self.entries.lock().unwrap().get(key).cloned())
    }

    fn save(&self, key: &str, secret: &str) -> Result<(), CredentialFailure> {
        self.saves.fetch_add(1, Ordering::SeqCst);
        if self.fail.load(Ordering::SeqCst) {
            return Err(CredentialFailure::Unavailable);
        }
        self.entries
            .lock()
            .unwrap()
            .insert(key.to_string(), secret.to_string());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), CredentialFailure> {
        self.deletes.fetch_add(1, Ordering::SeqCst);
        if self.fail.load(Ordering::SeqCst) {
            return Err(CredentialFailure::Unavailable);
        }
        self.entries.lock().unwrap().remove(key);
        Ok(())
    }
}

// ------------------------------------------------------------ Git fixture

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new(crate::test_support::system_git())
        .current_dir(dir)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            crate::test_support::isolated_gitconfig(),
        )
        .env("GIT_AUTHOR_NAME", "Twiglane Test")
        .env("GIT_AUTHOR_EMAIL", "twiglane-test@example.com")
        .env("GIT_COMMITTER_NAME", "Twiglane Test")
        .env("GIT_COMMITTER_EMAIL", "twiglane-test@example.com")
        .status()
        .unwrap();
    assert!(status.success(), "{args:?} in {}", dir.display());
}

struct RepoOptions<'a> {
    branch: &'a str,
    remotes: Vec<(&'a str, String)>,
    tracked: bool,
    upstream: Option<&'a str>,
}

fn seed_repo(
    fixture: &crate::test_support::GitFixture,
    options: RepoOptions<'_>,
) -> std::path::PathBuf {
    let dir = fixture.repo("work");
    git(&dir, &["init", "-b", "main"]);
    std::fs::write(dir.join("file.txt"), "base\n").unwrap();
    git(&dir, &["add", "--", "file.txt"]);
    git(&dir, &["commit", "-m", "base"]);
    for (name, url) in &options.remotes {
        git(&dir, &["remote", "add", name, url]);
    }
    if options.branch != "main" {
        git(&dir, &["checkout", "-b", options.branch]);
    }
    if options.tracked {
        let remote_name = options.remotes[0].0;
        git(
            &dir,
            &[
                "update-ref",
                &format!("refs/remotes/{remote_name}/{}", options.branch),
                "HEAD",
            ],
        );
    }
    if let Some(upstream) = options.upstream {
        git(
            &dir,
            &["branch", "--set-upstream-to", upstream, options.branch],
        );
    }
    dir
}

fn enable(backend: &Backend) {
    backend.store.set_change_requests_enabled(true).unwrap();
}

fn repo_key(path: &Path) -> String {
    path.display().to_string()
}

// 平台发现应答：GitHub Enterprise 元数据 404、Gitea 版本 200。
fn gitea_discovery() -> Vec<Reply> {
    vec![
        reply(404, "{\"message\":\"Not Found\"}"),
        reply(200, "{\"version\":\"1.21.0\"}"),
    ]
}

fn github_enterprise_discovery() -> Vec<Reply> {
    vec![reply(
        200,
        "{\"installed_version\":\"3.9.0\",\"verifiable_password_authentication\":true}",
    )]
}

fn gitlab_discovery() -> Vec<Reply> {
    vec![
        reply(404, "{\"message\":\"Not Found\"}"),
        reply(404, "{\"message\":\"Not Found\"}"),
        reply(401, "{\"message\":\"401 Unauthorized\"}"),
        reply(
            200,
            "<html><head><meta content=\"GitLab\" property=\"og:site_name\" /></head></html>",
        ),
    ]
}

const GITEA_META: &str = "{\"html_url\":\"{base}/acme/app\",\"default_branch\":\"main\"}";
const GITEA_CREATED: &str = "{\"html_url\":\"{base}/acme/app/pulls/7\"}";
const GITHUB_CREATED: &str = "{\"html_url\":\"{base}/acme/app/pull/7\"}";
const GITLAB_META: &str = "{\"web_url\":\"{base}/acme/app\",\"default_branch\":\"main\"}";
const GITLAB_CREATED: &str = "{\"web_url\":\"{base}/acme/app/-/merge_requests/7\"}";

fn filled(template: &str, base: &str) -> String {
    template.replace("{base}", base)
}
