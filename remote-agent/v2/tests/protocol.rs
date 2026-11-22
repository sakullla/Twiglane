//! v2 协议的黑盒回归：真实 Git 仓库 + 真实进程，只通过标准输入输出对话。
//!
//! 这些用例覆盖 T1 的验收：打开一次拿到完整状态摘要、差异按当前文件和游标续页、
//! stage/unstage/按块写入/commit 在真实仓库上成功并留下可查询回执，以及陈旧状态、
//! 跨进程写锁和未知结果都不会被当成成功。

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};
use tempfile::TempDir;

/// 单条回答的最长等待。agent 卡住（比如请求永远不回答）时用例必须失败而不是挂死。
const REPLY_TIMEOUT: Duration = Duration::from_secs(30);

struct Agent {
    child: Child,
    stdin: ChildStdin,
    /// 输出由独立线程切成行送进来：阻塞读换成 `recv_timeout`，因此「agent 不再回答」
    /// 会变成有时限的失败，而不是把整条用例挂死（溢出 panic 之类正是这种表现）。
    lines: mpsc::Receiver<String>,
}

impl Agent {
    fn start(state_home: &Path, config: &Path) -> Self {
        Self::start_with(state_home, config, &[])
    }

    /// 带额外环境变量的启动：终端用例固定 `SHELL`，降级用例显式关掉 watch。
    fn start_with(state_home: &Path, config: &Path, extra: &[(&str, &str)]) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_twiglane-agent-v2"));
        command.arg("--stdio");
        for (key, value) in extra {
            command.env(key, value);
        }
        let mut child = command
            .env("XDG_STATE_HOME", state_home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", config)
            .env("GIT_AUTHOR_NAME", "Twiglane Test")
            .env("GIT_AUTHOR_EMAIL", "twiglane-test@example.com")
            .env("GIT_COMMITTER_NAME", "Twiglane Test")
            .env("GIT_COMMITTER_EMAIL", "twiglane-test@example.com")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("agent 进程应能启动");
        let stdin = child.stdin.take().expect("stdin");
        let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));
        let (sender, lines) = mpsc::channel::<String>();
        std::thread::spawn(move || loop {
            let mut line = String::new();
            match stdout.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if sender.send(line).is_err() {
                        break;
                    }
                }
            }
        });
        Self {
            child,
            stdin,
            lines,
        }
    }

    /// 只发请求、不等回答：验证取消这类「提问时请求还在途」的行为需要它。
    fn send(&mut self, id: &str, op: &str, fields: Value) {
        let mut body = fields;
        let object = body.as_object_mut().expect("字段必须是对象");
        object.insert("v".into(), json!(2));
        object.insert("id".into(), json!(id));
        object.insert("op".into(), json!(op));
        let frame = body.to_string();
        self.stdin.write_all(frame.as_bytes()).expect("写请求");
        self.stdin.write_all(b"\n").expect("写换行");
        self.stdin.flush().expect("刷新请求");
    }

    /// 读到指定 id 的响应；通道是多路的，其他 id 的响应被丢弃。
    fn read_id(&mut self, id: &str) -> Value {
        loop {
            let value = self.next_line();
            assert_eq!(value["v"], json!(2), "响应必须声明 v2");
            if value["id"] == json!(id) {
                return value;
            }
        }
    }

    /// 读一行并解析：响应或事件都可能是下一行（终端与变化通知会和响应交错）。
    ///
    /// 超过 `REPLY_TIMEOUT` 没有新行就失败：agent 不回答比回答错误更难诊断，
    /// 不允许把它表现成「用例一直跑」。
    fn next_line(&mut self) -> Value {
        let line = match self.lines.recv_timeout(REPLY_TIMEOUT) {
            Ok(line) => line,
            Err(mpsc::RecvTimeoutError::Timeout) => panic!(
                "agent 在 {} 秒内没有回答也没有关闭输出",
                REPLY_TIMEOUT.as_secs()
            ),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                panic!("agent 在回答之前关闭了输出")
            }
        };
        serde_json::from_str(&line).expect("通道里的每一行都必须是 JSON")
    }

    /// 读下一条事件帧（不带 `id` 的帧）：变化通知与终端输出都走这条路。
    fn read_event(&mut self, kind: &str) -> Value {
        loop {
            let value = self.next_line();
            assert_eq!(value["v"], json!(2), "事件必须声明 v2");
            if value["event"] == json!(kind) {
                return value;
            }
        }
    }

    /// 发一条请求并读到同一 id 的响应。
    fn call(&mut self, id: &str, op: &str, fields: Value) -> Value {
        self.send(id, op, fields);
        self.read_id(id)
    }

    fn ok(&mut self, id: &str, op: &str, fields: Value) -> Value {
        let response = self.call(id, op, fields);
        assert_eq!(response["ok"], json!(true), "{op} 应成功：{response}");
        response["result"].clone()
    }

    fn error_code(&mut self, id: &str, op: &str, fields: Value) -> String {
        let response = self.call(id, op, fields);
        assert_eq!(response["ok"], json!(false), "{op} 应失败：{response}");
        response["error"]["code"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn write_config(dir: &Path) -> PathBuf {
    let path = dir.join("gitconfig");
    std::fs::write(&path, "[init]\n\tdefaultBranch = main\n").unwrap();
    path
}

fn git(dir: &Path, config: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(dir)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", config)
        .env("GIT_AUTHOR_NAME", "Twiglane Test")
        .env("GIT_AUTHOR_EMAIL", "twiglane-test@example.com")
        .env("GIT_COMMITTER_NAME", "Twiglane Test")
        .env("GIT_COMMITTER_EMAIL", "twiglane-test@example.com")
        .output()
        .expect("git 应能运行");
    assert!(
        output.status.success(),
        "git {args:?} 失败：{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).to_string()
}

struct Fixture {
    root: TempDir,
    state: PathBuf,
    config: PathBuf,
    repo: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let root = TempDir::new().unwrap();
        // macOS 的 /var 是 /private/var 的符号链接；仓库键用规范路径，夹具也统一用它。
        let base = dunce::canonicalize(root.path()).unwrap();
        let state = base.join(format!("state-{label}"));
        std::fs::create_dir_all(&state).unwrap();
        let config = write_config(&base);
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        Self {
            root,
            state,
            config,
            repo,
        }
    }

    fn agent(&self) -> Agent {
        Agent::start(&self.state, &self.config)
    }

    fn init(&self) {
        git(&self.repo, &self.config, &["init", "-b", "main"]);
    }

    fn commit_all(&self, message: &str) {
        git(&self.repo, &self.config, &["add", "-A"]);
        git(&self.repo, &self.config, &["commit", "-m", message]);
    }

    fn write(&self, name: &str, body: &str) {
        let path = self.repo.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, body).unwrap();
    }

    fn repo_str(&self) -> String {
        self.repo.to_string_lossy().into_owned()
    }
}

fn open(agent: &mut Agent, repo: &str) -> Value {
    agent.ok("open-1", "open", json!({ "path": repo }))
}

#[test]
fn handshake_reports_v2_capabilities_and_rejects_v1_frames() {
    let fixture = Fixture::new("handshake");
    let mut agent = fixture.agent();

    let hello = agent.ok("hello-1", "hello", json!({ "client": "test" }));
    assert_eq!(hello["protocol"], json!(2));
    assert_eq!(hello["agent"], json!("twiglane-agent/2"));
    assert_eq!(hello["generation"], json!("numeric"));
    assert_eq!(hello["stateToken"], json!("opaque"));
    let capabilities = hello["capabilities"].as_array().unwrap();
    for expected in [
        "open",
        "status",
        "diff",
        "stage",
        "unstage",
        "patch",
        "commit",
        "receipt",
        "journalIdentity",
        "taskReview",
        "reviewIdentity",
    ] {
        assert!(
            capabilities.contains(&json!(expected)),
            "capabilities 缺少 {expected}"
        );
    }

    // v1 帧在 v2 通道上必须被明确拒绝，而不是被当成 v2 执行。
    let raw = "{\"v\":1,\"id\":\"v1\",\"op\":\"hello\"}\n";
    agent
        .stdin
        .write_all(raw.as_bytes())
        .expect("写 v1 帧");
    agent.stdin.flush().unwrap();
    let rejected = agent.next_line();
    assert_eq!(rejected["ok"], json!(false));
    assert_eq!(rejected["error"]["code"], json!("unsupported_protocol"));
}

#[test]
fn journal_identity_survives_concurrent_start_and_forwarded_environment_changes() {
    let fixture = Fixture::new("journal-identity");
    let mut first = fixture.agent();
    let mut second = fixture.agent();
    first.send("first", "hello", json!({}));
    second.send("second", "hello", json!({}));
    let first_reply = first.read_id("first");
    let second_reply = second.read_id("second");
    assert_eq!(first_reply["ok"], true);
    assert_eq!(second_reply["ok"], true);
    let identity = &first_reply["result"]["journalIdentity"];
    assert_eq!(identity.as_str().unwrap().len(), 64);
    assert_eq!(second_reply["result"]["journalIdentity"], *identity);
    drop(first);
    drop(second);

    let mut reopened = fixture.agent();
    assert_eq!(reopened.ok("reconnect", "hello", json!({}))["journalIdentity"], *identity);
    let forwarded = Fixture::new("forwarded-state");
    let decoy_profile = forwarded.state.to_str().unwrap();
    let mut redirected = Agent::start_with(&forwarded.state, &forwarded.config, &[
        ("HOME", decoy_profile),
        ("USERPROFILE", decoy_profile),
        ("LOCALAPPDATA", decoy_profile),
        ("APPDATA", decoy_profile),
        ("HOMEPATH", decoy_profile),
        ("USER", "twiglane-test-forwarded-user"),
    ]);
    assert_eq!(redirected.ok("forwarded", "hello", json!({}))["journalIdentity"], *identity);
    assert!(!forwarded.state.join("twiglane").join("agent").join("v2")
        .join("journal").join("journal-identity").exists());
}

#[test]
fn open_returns_the_full_snapshot_and_diff_pages_by_cursor() {
    let fixture = Fixture::new("open-diff");
    fixture.init();
    fixture.write("note.txt", "one\ntwo\nthree\n");
    fixture.commit_all("init");
    fixture.write("note.txt", "one\ntwo\nthree\nfour\nfive\n");

    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    assert_eq!(opened["repo"], json!(fixture.repo_str()));
    assert!(opened["generation"].as_u64().unwrap() >= 1);
    assert_eq!(opened["stateToken"].as_str().unwrap().len(), 64);
    assert_eq!(opened["snapshot"]["branch"]["name"], json!("main"));
    let files = opened["snapshot"]["files"].as_array().unwrap();
    assert!(files.iter().any(|file| file["path"] == json!("note.txt")));
    // 打开一次就带完整状态摘要：行统计随快照一起返回，不再逐文件补读。
    let note = files
        .iter()
        .find(|file| file["path"] == json!("note.txt"))
        .unwrap();
    assert_eq!(note["unstagedLines"]["additions"], json!(2));
    // T3 起远端真的推送变化事件，watch 可用时必须如实报告（不可用时才是 true）。
    assert_eq!(opened["watchDegraded"], json!(false));

    let repo = fixture.repo_str();
    let token = opened["stateToken"].as_str().unwrap().to_string();
    let first = agent.ok(
        "diff-1",
        "diff",
        json!({
            "repo": repo,
            "path": "note.txt",
            "view": "unstaged",
            "offset": 0,
            "limit": 1,
            "stateToken": token,
        }),
    );
    assert_eq!(first["diff"]["generation"], opened["generation"]);
    assert_eq!(first["diff"]["lines"].as_array().unwrap().len(), 1);
    assert!(first["diff"]["totalLines"].as_u64().unwrap() > 1);
    let cursor = first["nextCursor"].as_str().expect("应给出续页游标").to_string();

    let second = agent.ok(
        "diff-2",
        "diff",
        json!({
            "repo": repo,
            "path": "note.txt",
            "view": "unstaged",
            "offset": first["diff"]["lines"].as_array().unwrap().len() as u64,
            "limit": 1,
            "cursor": cursor,
            "stateToken": token,
        }),
    );
    assert_eq!(second["diff"]["offset"], json!(1));

    // 游标绑定选择：换一个文件再续页必须被拒绝，而不是把上一页接到新文件。
    fixture.write("other.txt", "x\n");
    let mismatch = agent.error_code(
        "diff-3",
        "diff",
        json!({
            "repo": repo,
            "path": "other.txt",
            "view": "unstaged",
            "offset": 1,
            "limit": 1,
            "cursor": first["nextCursor"],
            "stateToken": token,
        }),
    );
    assert_eq!(mismatch, "cursor_expired");
    let _ = fixture.root.path();
}

#[test]
fn stage_and_commit_write_real_git_state_and_leave_queryable_receipts() {
    let fixture = Fixture::new("write");
    fixture.init();
    fixture.write("note.txt", "one\n");
    fixture.commit_all("init");
    fixture.write("note.txt", "one\ntwo\n");
    fixture.write("added.txt", "new\n");

    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();
    let token = opened["stateToken"].as_str().unwrap().to_string();

    let staged = agent.ok(
        "stage-1",
        "stage",
        json!({
            "repo": repo,
            "operationId": "op-stage-0001",
            "stateToken": token,
            "paths": ["note.txt", "added.txt"],
        }),
    );
    // 写入一次返回新的状态快照，客户端不必再串行补读。
    let files = staged["snapshot"]["files"].as_array().unwrap();
    assert!(files
        .iter()
        .any(|file| file["path"] == json!("note.txt") && file["staged"] == json!("modified")));
    assert_eq!(staged["receipt"]["state"], json!("completed"));
    assert_eq!(staged["receipt"]["op"], json!("stage"));
    let new_token = staged["stateToken"].as_str().unwrap().to_string();
    assert_ne!(new_token, token, "写入后令牌必须变化");

    // 真实 Git 状态：两个文件都进了索引。
    let cached = git(&fixture.repo, &fixture.config, &["diff", "--cached", "--name-only"]);
    assert!(cached.contains("note.txt"));
    assert!(cached.contains("added.txt"));

    // 同一个操作 ID 重放只返回原回执，不会再次执行。
    let replayed = agent.ok(
        "stage-2",
        "stage",
        json!({
            "repo": repo,
            "operationId": "op-stage-0001",
            "stateToken": token,
            "paths": ["note.txt", "added.txt"],
        }),
    );
    assert_eq!(replayed["replayed"], json!(true));

    let receipt = agent.ok(
        "receipt-1",
        "receipt",
        json!({ "repo": repo, "operationId": "op-stage-0001" }),
    );
    assert_eq!(receipt["receipt"]["state"], json!("completed"));

    let committed = agent.ok(
        "commit-1",
        "commit",
        json!({
            "repo": repo,
            "operationId": "op-commit-0001",
            "stateToken": new_token,
            "message": "feat: 提交两个文件",
        }),
    );
    let head = git(&fixture.repo, &fixture.config, &["rev-parse", "HEAD"]);
    assert_eq!(committed["commit"]["oid"], json!(head.trim()));
    assert_eq!(committed["receipt"]["head"], json!(head.trim()));
    assert_eq!(committed["commit"]["branch"], json!("main"));

    // 未记录的写入必须是 unknown，不能伪造成功。
    let unknown = agent.ok(
        "receipt-2",
        "receipt",
        json!({ "repo": repo, "operationId": "op-missing-9999" }),
    );
    assert_eq!(unknown["state"], json!("unknown"));
    assert_eq!(unknown["reason"], json!("not_recorded"));

    // 回执落在 common Git dir 内，与仓库身份绑定，重启后仍然可读。
    let receipts = fixture
        .repo
        .join(".git")
        .join("twiglane-agent-v2")
        .join("receipts");
    assert!(receipts.join("op-commit-0001.json").is_file());
    let restarted = {
        let mut second = fixture.agent();
        let opened = open(&mut second, &fixture.repo_str());
        let receipt = second.ok(
            "receipt-3",
            "receipt",
            json!({ "repo": fixture.repo_str(), "operationId": "op-commit-0001" }),
        );
        assert_eq!(receipt["receipt"]["state"], json!("completed"));
        opened
    };
    assert_eq!(restarted["snapshot"]["files"].as_array().unwrap().len(), 0);
}

#[test]
fn stale_state_token_is_rejected_without_writing_the_index() {
    let fixture = Fixture::new("stale");
    fixture.init();
    fixture.write("note.txt", "one\n");
    fixture.commit_all("init");

    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();
    let stale_token = opened["stateToken"].as_str().unwrap().to_string();

    // 读取之后工作树又变了：令牌不再匹配。
    fixture.write("note.txt", "one\ntwo\n");
    let code = agent.error_code(
        "stage-1",
        "stage",
        json!({
            "repo": repo,
            "operationId": "op-stale-0001",
            "stateToken": stale_token,
            "paths": ["note.txt"],
        }),
    );
    assert_eq!(code, "state_mismatch");
    // 暂存区没有被改动：文件仍然只在工作树一侧有变化。
    let cached = git(&fixture.repo, &fixture.config, &["diff", "--cached", "--name-only"]);
    assert!(cached.trim().is_empty());
    // 失败也留下回执，后续查询得到明确失败而不是未知。
    let receipt = agent.ok(
        "receipt-1",
        "receipt",
        json!({ "repo": repo, "operationId": "op-stale-0001" }),
    );
    assert_eq!(receipt["receipt"]["state"], json!("failed"));
    assert_eq!(receipt["receipt"]["reason"], json!("state_mismatch"));
}

#[test]
fn patch_stages_only_the_selected_hunk_and_unstage_restores_the_index() {
    let fixture = Fixture::new("patch");
    fixture.init();
    let mut body = String::new();
    for index in 1..=30 {
        body.push_str(&format!("line {index}\n"));
    }
    fixture.write("big.txt", &body);
    fixture.commit_all("init");
    let mut body = String::new();
    for index in 1..=30 {
        if index == 2 {
            body.push_str("line 2 changed\n");
        } else if index == 26 {
            body.push_str("line 26 changed\n");
        } else {
            body.push_str(&format!("line {index}\n"));
        }
    }
    fixture.write("big.txt", &body);

    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();
    let token = opened["stateToken"].as_str().unwrap().to_string();

    let diff = agent.ok(
        "diff-1",
        "diff",
        json!({
            "repo": repo,
            "path": "big.txt",
            "view": "unstaged",
            "offset": 0,
            "limit": 500,
            "stateToken": token,
        }),
    );
    let hunks = diff["diff"]["hunks"].as_array().unwrap();
    assert!(hunks.len() >= 2, "示例文件应产生两个独立的块：{diff}");
    let first_hunk = hunks[0]["index"].as_u64().unwrap();
    let snapshot = diff["diff"]["snapshot"].as_str().unwrap().to_string();

    let staged = agent.ok(
        "patch-1",
        "patch",
        json!({
            "repo": repo,
            "operationId": "op-patch-0001",
            "stateToken": token,
            "path": "big.txt",
            "staged": false,
            "snapshot": snapshot,
            "hunks": [first_hunk],
        }),
    );
    assert_eq!(staged["receipt"]["state"], json!("completed"));
    let cached = git(&fixture.repo, &fixture.config, &["diff", "--cached"]);
    assert!(cached.contains("line 2 changed"), "第一块应已暂存：{cached}");
    assert!(
        !cached.contains("line 26 changed"),
        "第二块不应被暂存：{cached}"
    );

    let unstaged = agent.ok(
        "unstage-1",
        "unstage",
        json!({
            "repo": repo,
            "operationId": "op-unstage-0001",
            "stateToken": staged["stateToken"],
            "paths": ["big.txt"],
        }),
    );
    assert_eq!(unstaged["receipt"]["state"], json!("completed"));
    let cached = git(&fixture.repo, &fixture.config, &["diff", "--cached", "--name-only"]);
    assert!(cached.trim().is_empty(), "取消暂存后索引应为空");
}

/// 按行写入：一段多行改动里只把选中的那一行放进索引，兄弟行留在工作树；
/// 取消暂存后索引回到 HEAD，工作树内容不动。
#[test]
fn patch_stages_only_the_selected_line_and_unstage_restores_the_index() {
    let fixture = Fixture::new("patch-lines");
    fixture.init();
    let mut committed = String::new();
    for index in 1..=20 {
        committed.push_str(&format!("line {index}\n"));
    }
    fixture.write("rows.txt", &committed);
    fixture.commit_all("init");
    // 同一个块里三行纯新增：一次真实的多行改动。
    let mut changed = committed.clone();
    changed.push_str("tail one\ntail two\ntail three\n");
    fixture.write("rows.txt", &changed);

    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();
    let token = opened["stateToken"].as_str().unwrap().to_string();

    let diff = agent.ok(
        "diff-1",
        "diff",
        json!({
            "repo": repo,
            "path": "rows.txt",
            "view": "unstaged",
            "offset": 0,
            "limit": 500,
            "stateToken": token,
        }),
    );
    let lines = diff["diff"]["lines"].as_array().unwrap();
    let adds: Vec<&Value> = lines.iter().filter(|line| line["kind"] == json!("add")).collect();
    assert_eq!(adds.len(), 3, "夹具应产生三行新增：{diff}");
    // 取中间那一行：两侧的兄弟行必须留在工作树，否则就不是按行写入。
    let picked = adds[1].clone();
    assert!(
        picked["text"].as_str().unwrap().contains("tail two"),
        "选中的应是中间那一行：{picked}"
    );
    let selection = json!({
        "hunkIndex": picked["hunkIndex"],
        "kind": picked["kind"],
        "oldNo": picked["oldNo"],
        "newNo": picked["newNo"],
    });
    let snapshot = diff["diff"]["snapshot"].as_str().unwrap().to_string();

    let staged = agent.ok(
        "patch-1",
        "patch",
        json!({
            "repo": repo,
            "operationId": "op-patch-line-0001",
            "stateToken": token,
            "path": "rows.txt",
            "staged": false,
            "snapshot": snapshot,
            "lines": [selection],
        }),
    );
    assert_eq!(staged["receipt"]["state"], json!("completed"));

    let cached = git(&fixture.repo, &fixture.config, &["diff", "--cached"]);
    assert!(cached.contains("+tail two"), "选中的行应已进入索引：{cached}");
    assert!(
        !cached.contains("+tail one"),
        "未选中的兄弟行不应进入索引：{cached}"
    );
    assert!(
        !cached.contains("+tail three"),
        "未选中的兄弟行不应进入索引：{cached}"
    );

    let worktree_diff = git(&fixture.repo, &fixture.config, &["diff"]);
    assert!(
        worktree_diff.contains("+tail one"),
        "未选中的行应留在工作树：{worktree_diff}"
    );
    assert!(
        worktree_diff.contains("+tail three"),
        "未选中的行应留在工作树：{worktree_diff}"
    );
    assert!(
        !worktree_diff.contains("+tail two"),
        "已暂存的行不该再出现在工作树差异里：{worktree_diff}"
    );
    let worktree = std::fs::read_to_string(fixture.repo.join("rows.txt")).unwrap();
    assert_eq!(worktree, changed, "按行暂存不应改动工作树内容");

    let unstaged = agent.ok(
        "unstage-1",
        "unstage",
        json!({
            "repo": repo,
            "operationId": "op-patch-line-unstage-0001",
            "stateToken": staged["stateToken"],
            "paths": ["rows.txt"],
        }),
    );
    assert_eq!(unstaged["receipt"]["state"], json!("completed"));
    let cached = git(&fixture.repo, &fixture.config, &["diff", "--cached", "--name-only"]);
    assert!(cached.trim().is_empty(), "取消暂存后索引应为空：{cached}");
    let worktree = std::fs::read_to_string(fixture.repo.join("rows.txt")).unwrap();
    assert_eq!(worktree, changed, "取消暂存只复原索引，不碰工作树");
}

/// 崩溃窗口：进程在 registered 之后、completed 之前退出。重连后同一个操作只能查询，
/// 不能重放执行；换了请求摘要则按冲突拒绝（docs/integrations/remote-agent-v2.md 的写入顺序）。
#[test]
fn a_registered_receipt_left_by_a_crash_is_never_replayed() {
    let fixture = Fixture::new("crash");
    fixture.init();
    fixture.write("note.txt", "one\n");
    fixture.commit_all("init");
    fixture.write("note.txt", "one\ntwo\n");

    let repo = fixture.repo_str();
    let request = |token: &str| {
        json!({
            "repo": repo,
            "operationId": "op-crash-0001",
            "stateToken": token,
            "paths": ["note.txt"],
        })
    };

    // 先做一次真实写入，拿到本次请求的规范摘要：同一个操作 ID 只匹配同一份摘要。
    let (token, completed_receipt) = {
        let mut agent = fixture.agent();
        let opened = open(&mut agent, &fixture.repo_str());
        let token = opened["stateToken"].as_str().unwrap().to_string();
        let staged = agent.ok("stage-1", "stage", request(&token));
        assert_eq!(staged["receipt"]["state"], json!("completed"));
        (token, staged["receipt"].clone())
    };
    let digest = completed_receipt["requestDigest"]
        .as_str()
        .expect("回执应带请求摘要")
        .to_string();

    // 索引复原、工作树不动：模拟那次写入没有真正落地。
    git(&fixture.repo, &fixture.config, &["reset", "-q", "HEAD", "--", "note.txt"]);

    // agent 启动前，把回执改回 registered，也就是崩溃后留在盘上的现场。
    let common = git(&fixture.repo, &fixture.config, &["rev-parse", "--git-common-dir"]);
    let receipts = fixture
        .repo
        .join(common.trim())
        .join("twiglane-agent-v2")
        .join("receipts");
    std::fs::create_dir_all(&receipts).unwrap();
    let pending = json!({
        "operationId": "op-crash-0001",
        "repo": repo,
        "op": "stage",
        "requestDigest": digest,
        "state": "registered",
        "generation": completed_receipt["generation"],
        "atMs": completed_receipt["atMs"],
    });
    std::fs::write(receipts.join("op-crash-0001.json"), pending.to_string()).unwrap();

    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());

    // 客户端拿原来的请求原样重发：摘要相同，结果待确认，绝不再次执行。
    let code = agent.error_code("stage-2", "stage", request(&token));
    assert_eq!(code, "operation_pending", "待确认的操作不能被重发");
    let cached = git(&fixture.repo, &fixture.config, &["diff", "--cached", "--name-only"]);
    assert!(cached.trim().is_empty(), "索引不能被改动：{cached}");
    let worktree = std::fs::read_to_string(fixture.repo.join("note.txt")).unwrap();
    assert_eq!(worktree, "one\ntwo\n", "工作树不能被改动");

    // 同一个操作 ID 换一份请求：按冲突拒绝，而不是拿旧回执重放。
    let conflict = agent.error_code(
        "stage-3",
        "stage",
        json!({
            "repo": repo,
            "operationId": "op-crash-0001",
            "stateToken": opened["stateToken"],
            "paths": ["note.txt", "rows.txt"],
        }),
    );
    assert_eq!(conflict, "operation_conflict");
    let cached = git(&fixture.repo, &fixture.config, &["diff", "--cached", "--name-only"]);
    assert!(cached.trim().is_empty(), "冲突拒绝也不能写索引：{cached}");

    // 待确认的回执原样留着，只能靠 receipt 查询核对；查询不会替它补一个结果。
    let receipt = agent.ok(
        "receipt-1",
        "receipt",
        json!({ "repo": repo, "operationId": "op-crash-0001" }),
    );
    assert_eq!(
        receipt["receipt"]["state"],
        json!("registered"),
        "崩溃留下的回执必须停在 registered：{receipt}"
    );
    // 只有完全没有记录的 operation ID 才是 unknown（server.rs 的 receipt 分支）；
    // 把崩溃窗口里的操作当成 unknown 就给了重发的理由，所以两者必须分开。
    let unknown = agent.ok(
        "receipt-2",
        "receipt",
        json!({ "repo": repo, "operationId": "op-crash-0002" }),
    );
    assert_eq!(unknown["state"], json!("unknown"));
    assert_eq!(unknown["reason"], json!("not_recorded"));
}

#[test]
fn a_second_process_holding_the_repo_lock_blocks_writes() {
    let fixture = Fixture::new("lock");
    fixture.init();
    fixture.write("note.txt", "one\n");
    fixture.commit_all("init");
    fixture.write("note.txt", "one\ntwo\n");

    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();
    let token = opened["stateToken"].as_str().unwrap().to_string();

    // 另一个进程（这里直接放一个新鲜锁文件）正在写同一个 common Git dir。
    let lock = fixture.repo.join(".git").join("twiglane-agent-v2.lock");
    std::fs::write(&lock, b"999999\t0\n").unwrap();
    let code = agent.error_code(
        "stage-1",
        "stage",
        json!({
            "repo": repo,
            "operationId": "op-locked-0001",
            "stateToken": token,
            "paths": ["note.txt"],
        }),
    );
    assert_eq!(code, "write_locked");
    assert!(lock.exists(), "别人的锁不能被我们删掉");
    let cached = git(&fixture.repo, &fixture.config, &["diff", "--cached", "--name-only"]);
    assert!(cached.trim().is_empty());

    std::fs::remove_file(&lock).unwrap();
    let staged = agent.ok(
        "stage-2",
        "stage",
        json!({
            "repo": repo,
            "operationId": "op-locked-0002",
            "stateToken": token,
            "paths": ["note.txt"],
        }),
    );
    assert_eq!(staged["receipt"]["state"], json!("completed"));
}

#[test]
fn agent_state_stays_apart_from_v1_install_and_desktop_settings() {
    let fixture = Fixture::new("isolation");
    fixture.init();
    fixture.write("note.txt", "one\n");
    fixture.commit_all("init");

    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();
    agent.ok(
        "stage-1",
        "stage",
        json!({
            "repo": repo,
            "operationId": "op-isolation-0001",
            "stateToken": opened["stateToken"],
            "paths": ["note.txt"],
        }),
    );

    // v2 自己的设置目录：<XDG_STATE_HOME>/twiglane/agent/v2。
    let v2 = fixture.state.join("twiglane").join("agent").join("v2");
    assert!(v2.join("settings.json").is_file(), "agent 应只写自己的设置文件");
    // 不创建、也不读取 v1 的安装或记录目录。
    assert!(!fixture.state.join("twiglane").join("agent").join("v1").exists());
    // 回执跟随仓库身份，位于 common Git dir 内，而不是用户家目录。
    assert!(fixture
        .repo
        .join(".git")
        .join("twiglane-agent-v2")
        .join("receipts")
        .join("op-isolation-0001.json")
        .is_file());
}

#[test]
fn two_requests_in_flight_are_answered_by_id() {
    let fixture = Fixture::new("multiplex");
    fixture.init();
    fixture.write("a.txt", "a1\n");
    fixture.write("b.txt", "b1\n");
    fixture.commit_all("init");
    fixture.write("a.txt", "a1\na2\n");
    fixture.write("b.txt", "b1\nb2\n");

    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();
    let token = opened["stateToken"].as_str().unwrap().to_string();

    // 两条差异请求同时发出：不等待第一条就写第二条，验证多路响应按 id 匹配。
    let requests = [
        ("multi-a", "a.txt"),
        ("multi-b", "b.txt"),
    ];
    for (id, path) in requests {
        let frame = json!({
            "v": 2,
            "id": id,
            "op": "diff",
            "repo": repo,
            "path": path,
            "view": "unstaged",
            "offset": 0,
            "limit": 50,
            "stateToken": token,
        });
        agent.stdin.write_all(frame.to_string().as_bytes()).unwrap();
        agent.stdin.write_all(b"\n").unwrap();
    }
    agent.stdin.flush().unwrap();

    // 两条请求同时在途时响应必须按 id 各自归还。协议文档写明「新的选择可抢占旧读取」，
    // 所以较早的那条允许以 superseded 结束；这不动摇多路复用，也不允许别的失败原因。
    let mut succeeded: Vec<(String, String)> = Vec::new();
    let mut superseded = 0;
    for _ in 0..2 {
        let value = agent.next_line();
        let id = value["id"].as_str().unwrap().to_string();
        assert!(
            id == "multi-a" || id == "multi-b",
            "响应 id 必须匹配在途请求：{value}"
        );
        if value["ok"] == json!(true) {
            succeeded.push((id, value["result"]["path"].as_str().unwrap().to_string()));
        } else {
            assert_eq!(
                value["error"]["code"], "superseded",
                "并发读取只允许被新选择抢占：{value}"
            );
            superseded += 1;
        }
    }
    assert!(!succeeded.is_empty(), "最新的一次读取必须完成");
    for (id, path) in &succeeded {
        let expected = if id == "multi-a" { "a.txt" } else { "b.txt" };
        assert_eq!(path, expected, "响应 id 与结果文件必须对应");
    }
    assert_eq!(succeeded.len() + superseded, 2);

    // 抢占只作用于并发中的旧读取：随后顺序请求同一个文件必须正常返回。
    let again = agent.ok(
        "after",
        "diff",
        json!({
            "repo": repo,
            "path": "a.txt",
            "view": "unstaged",
            "offset": 0,
            "limit": 50,
        }),
    );
    assert_eq!(again["diff"]["path"], "a.txt");
    let _ = fixture.root.path();
}

// ===== T2：历史与搜索、分支标签、同步、stash、合并与修订撤销、worktree =====

/// 写入结果里的令牌是下一次写入的预期状态；每个用例都必须沿用它，不能复用旧值。
fn token_of(result: &Value) -> String {
    result["stateToken"]
        .as_str()
        .expect("写入结果必须带 stateToken")
        .to_string()
}

fn base_of(fixture: &Fixture) -> PathBuf {
    std::fs::canonicalize(fixture.root.path()).unwrap()
}

#[test]
fn a_bound_task_keeps_history_and_files_available_and_pages_the_net_diff() {
    let fixture = Fixture::new("baseline");
    fixture.init();
    fixture.write("note.txt", "base\n");
    fixture.commit_all("first commit");
    let baseline = git(&fixture.repo, &fixture.config, &["rev-parse", "HEAD"]);
    let baseline = baseline.trim();
    fixture.write("note.txt", "base\ncommitted\n");
    fixture.commit_all("second commit");
    let head = git(&fixture.repo, &fixture.config, &["rev-parse", "HEAD"]);
    let head = head.trim();
    fixture.write("note.txt", "base\ncommitted\nstaged\n");
    git(&fixture.repo, &fixture.config, &["add", "note.txt"]);
    fixture.write("note.txt", "base\ncommitted\nstaged\nworking\n");
    fixture.write("new.txt", "untracked\n");

    let mut agent = fixture.agent();
    let normal = open(&mut agent, &fixture.repo_str());
    let repo = &normal["repo"];
    assert_eq!(normal["baseline"], Value::Null);
    assert_eq!(normal["reviewFiles"], Value::Null);
    assert_eq!(
        agent.error_code("task-none", "taskReview", json!({ "repo": repo })),
        "invalid_baseline",
    );
    let opened = agent.ok(
        "open-baseline",
        "open",
        json!({
            "path": fixture.repo_str(), "baseline": baseline,
            "worktreeIdentity": normal["worktreeIdentity"],
        }),
    );
    assert_eq!(opened["baseline"], json!(baseline));
    assert_eq!(opened["worktreeIdentity"], normal["worktreeIdentity"]);
    assert_eq!(opened["reviewFiles"], json!(["new.txt", "note.txt"]));
    assert_eq!(opened["reviewFilesTruncated"], json!(false));

    let history = agent.ok("task-history", "history", json!({ "repo": repo }));
    let commits = history["page"]["commits"].as_array().unwrap();
    assert_eq!(commits.len(), 2);
    assert_eq!(commits[0]["oid"], json!(head));
    assert_eq!(commits[1]["oid"], json!(baseline));
    let detail = agent.ok(
        "task-detail",
        "commitDetail",
        json!({ "repo": repo, "oid": baseline }),
    );
    assert_eq!(detail["commit"]["commit"]["summary"], json!("first commit"));
    let content = agent.ok(
        "task-file",
        "fileContent",
        json!({ "repo": repo, "relative": "note.txt" }),
    );
    assert_eq!(
        content["content"]["lines"],
        json!(["base", "committed", "staged", "working"])
    );

    let review = agent.ok("task-snapshot", "taskReview", json!({ "repo": repo }));
    assert_eq!(review["review"]["baselineOid"], json!(baseline));
    assert_eq!(review["review"]["headOid"], json!(head));
    assert_eq!(review["review"]["commitCount"], json!(1));
    assert_eq!(review["review"]["untrackedFiles"], json!(1));
    let first_token = agent.ok("task-token", "taskReviewToken", json!({
        "repo": repo, "baseline": baseline, "head": head, "path": "note.txt",
    }))["token"]["token"].clone();
    assert!(first_token.is_string());
    assert_eq!(
        agent.error_code("task-wrong-head", "diff", json!({
            "repo": repo, "view": "task", "baseline": baseline, "head": baseline, "path": "note.txt",
        })),
        "cursor_expired",
    );
    let mut pages = Vec::new();
    let mut cursor = Value::Null;
    let mut offset = 0;
    let mut first_cursor = Value::Null;
    loop {
        let mut request = json!({ "repo": repo, "view": "task", "path": "note.txt", "offset": offset, "limit": 2 });
        if !cursor.is_null() {
            request["cursor"] = cursor;
        }
        let page = agent.ok(&format!("task-page-{offset}"), "diff", request);
        assert_eq!(page["view"], json!("task"));
        assert_eq!(page["diff"]["offset"], json!(offset));
        assert!(page["diff"]["hunks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|hunk| hunk["stageable"] == json!(false)));
        let lines = page["diff"]["lines"].as_array().unwrap();
        pages.extend(lines.iter().cloned());
        cursor = page["nextCursor"].clone();
        if offset == 0 {
            first_cursor = cursor.clone();
            assert!(first_cursor.is_string());
        }
        if cursor.is_null() {
            assert_eq!(
                pages.len() as u64,
                page["diff"]["totalLines"].as_u64().unwrap()
            );
            break;
        }
        assert!(!lines.is_empty());
        offset += lines.len();
    }
    let added: Vec<_> = pages
        .iter()
        .filter(|line| line["kind"] == json!("add"))
        .map(|line| line["text"].as_str().unwrap().trim_start_matches('+'))
        .collect();
    assert_eq!(added, ["committed", "staged", "working"]);

    assert_eq!(
        agent.error_code("task-wrong-view", "diff", json!({
            "repo": repo, "view": "unstaged", "path": "note.txt", "offset": 2, "limit": 2, "cursor": first_cursor,
        })),
        "cursor_expired",
    );
    fixture.write(
        "note.txt",
        "base\ncommitted\nstaged\nchanged after first page\n",
    );
    assert_eq!(
        agent.error_code("task-stale-page", "diff", json!({
            "repo": repo, "view": "task", "path": "note.txt", "offset": 2, "limit": 2, "cursor": first_cursor,
        })),
        "cursor_expired",
    );
    let refreshed = agent.ok("task-status", "status", json!({ "repo": repo }));
    assert_eq!(refreshed["baseline"], json!(baseline));
    assert_eq!(refreshed["reviewFiles"], opened["reviewFiles"]);
    let changed = agent.ok("task-token-updated", "taskReviewToken", json!({
        "repo": repo, "baseline": baseline, "head": head, "path": "note.txt",
    }));
    assert!(changed["token"]["token"].is_string());
    assert_ne!(changed["token"]["token"], first_token);
}

#[test]
fn review_binding_rejects_bad_baselines_and_a_different_worktree() {
    let fixture = Fixture::new("baseline-binding");
    fixture.init();
    fixture.write("note.txt", "base\n");
    fixture.commit_all("first commit");
    let path = fixture.repo_str();
    let mut agent = fixture.agent();
    let opened = open(&mut agent, &path);
    let identity = &opened["worktreeIdentity"];
    assert_eq!(identity.as_str().unwrap().len(), 64);
    let reported = agent.ok(
        "identity",
        "reviewIdentity",
        json!({ "repo": opened["repo"] }),
    );
    assert_eq!(reported["worktreeIdentity"], *identity);
    assert_eq!(reported["worktreePath"], opened["worktreePath"]);

    for (id, baseline, expected) in [
        ("invalid", json!("HEAD"), "invalid_baseline"),
        ("bad-shape", json!(1), "invalid_baseline"),
        ("missing", json!("0".repeat(40)), "task_baseline_missing"),
    ] {
        assert_eq!(
            agent.error_code(id, "open", json!({ "path": path, "baseline": baseline })),
            expected
        );
    }
    let tree = git(
        &fixture.repo,
        &fixture.config,
        &["rev-parse", "HEAD^{tree}"],
    );
    let unrelated = git(
        &fixture.repo,
        &fixture.config,
        &["commit-tree", tree.trim(), "-m", "unrelated"],
    );
    assert_eq!(
        agent.error_code(
            "unrelated",
            "open",
            json!({ "path": path, "baseline": unrelated.trim() })
        ),
        "task_baseline_not_ancestor",
    );
    let baseline = git(&fixture.repo, &fixture.config, &["rev-parse", "HEAD"]);
    agent.ok(
        "bind-before-switch",
        "open",
        json!({ "path": path, "baseline": baseline.trim() }),
    );
    git(
        &fixture.repo,
        &fixture.config,
        &["update-ref", "refs/heads/unrelated", unrelated.trim()],
    );
    git(&fixture.repo, &fixture.config, &["switch", "unrelated"]);
    let switched = agent.ok("switched", "status", json!({ "repo": opened["repo"] }));
    assert_eq!(
        switched["snapshot"]["branch"]["headOid"],
        json!(unrelated.trim())
    );
    assert_eq!(switched["reviewFiles"], Value::Null);
    assert_eq!(
        switched["reviewError"]["code"],
        json!("task_baseline_not_ancestor")
    );
    let history = agent.ok(
        "switched-history",
        "history",
        json!({ "repo": opened["repo"] }),
    );
    assert_eq!(
        history["page"]["commits"][0]["oid"],
        json!(unrelated.trim())
    );

    let linked = fixture.repo.parent().unwrap().join("联动 worktree 🐚");
    git(
        &fixture.repo,
        &fixture.config,
        &["worktree", "add", "--detach", linked.to_str().unwrap()],
    );
    assert_eq!(
        agent.error_code(
            "different-tree",
            "open",
            json!({ "path": linked, "worktreeIdentity": identity })
        ),
        "target_changed",
    );
    let linked_open = agent.ok("linked-open", "open", json!({ "path": linked }));
    assert_ne!(linked_open["worktreeIdentity"], *identity);
    assert!(linked_open["worktreePath"]
        .as_str()
        .unwrap()
        .ends_with("/联动 worktree 🐚"));
    let mut restarted = fixture.agent();
    let reopened = restarted.ok(
        "reopened",
        "open",
        json!({
            "path": linked, "worktreeIdentity": linked_open["worktreeIdentity"],
        }),
    );
    assert_eq!(
        reopened["worktreeIdentity"],
        linked_open["worktreeIdentity"]
    );
}

#[test]
#[cfg(unix)]
fn requests_reject_replacing_an_open_worktree_at_the_same_path() {
    for with_baseline in [false, true] {
        let fixture = Fixture::new("original-identity");
        fixture.init();
        fixture.write("note.txt", "original working tree\n");
        fixture.commit_all("original history");
        let replacement = Fixture::new("replacement-identity");
        replacement.init();
        replacement.write("note.txt", "replacement working tree\n");
        replacement.commit_all("replacement history");

        let mut agent = fixture.agent();
        let opened = open(&mut agent, &fixture.repo_str());
        let repo = &opened["repo"];
        if with_baseline {
            let head = &opened["snapshot"]["branch"]["headOid"];
            agent.ok(
                "bound-open",
                "open",
                json!({ "path": fixture.repo_str(), "baseline": head,
                    "worktreeIdentity": opened["worktreeIdentity"] }),
            );
        }
        std::fs::rename(&fixture.repo, fixture.repo.with_file_name("moved")).unwrap();
        std::fs::rename(&replacement.repo, &fixture.repo).unwrap();

        for (op, request) in [
            ("status", json!({ "repo": repo })),
            ("history", json!({ "repo": repo })),
            ("fileContent", json!({ "repo": repo, "relative": "note.txt" })),
            ("receipt", json!({ "repo": repo, "operationId": "old-action" })),
        ] {
            assert_eq!(agent.error_code("replacement", op, request), "target_changed");
        }
        let cancelled = agent.ok("cancel-after-move", "cancel", json!({ "targetId": "old-request" }));
        assert_eq!(cancelled["cancelled"], json!(false));
        let closed = agent.ok(
            "close-after-move",
            "terminalClose",
            json!({ "repo": repo, "sessionId": "already-closed" }),
        );
        assert_eq!(closed["closed"], json!(true));

        agent.ok("direct-reopen", "open", json!({ "path": fixture.repo_str() }));
        let current = agent.ok("current-file", "fileContent", json!({ "repo": repo, "relative": "note.txt" }));
        assert_eq!(current["content"]["lines"], json!(["replacement working tree"]));
    }
}

#[test]
fn requests_verify_git_identity_when_the_worktree_root_stays_in_place() {
    let fixture = Fixture::new("original-gitdir");
    fixture.init();
    fixture.write("note.txt", "original\n");
    fixture.commit_all("original");
    let replacement = Fixture::new("replacement-gitdir");
    replacement.init();
    replacement.write("note.txt", "replacement\n");
    replacement.commit_all("replacement");

    let linked = fixture.repo.with_file_name("linked");
    let linked_path = linked.to_str().unwrap();
    git(
        &fixture.repo,
        &fixture.config,
        &["worktree", "add", "--detach", linked_path],
    );
    let mut agent = fixture.agent();
    let opened = open(&mut agent, linked_path);
    let repo = &opened["repo"];
    std::fs::write(
        linked.join(".git"),
        format!("gitdir: {}\n", replacement.repo.join(".git").display()),
    )
    .unwrap();

    assert_eq!(
        agent.error_code("redirected-history", "history", json!({ "repo": repo })),
        "target_changed",
    );
    assert_eq!(
        agent.error_code("redirected-content", "fileContent", json!({ "repo": repo, "relative": "note.txt" })),
        "target_changed",
    );
}

#[test]
fn requests_reject_retargeting_the_common_git_directory() {
    let fixture = Fixture::new("original-common-dir");
    fixture.init();
    fixture.write("note.txt", "same content\n");
    fixture.commit_all("same commit");

    let replacement = Fixture::new("replacement-common-dir");
    git(
        &replacement.repo,
        &replacement.config,
        &["clone", "--no-hardlinks", &fixture.repo_str(), "."],
    );
    git(
        &replacement.repo,
        &replacement.config,
        &["branch", "replacement-only"],
    );
    let linked = fixture.repo.with_file_name("linked");
    let linked_path = linked.to_str().unwrap();
    git(
        &fixture.repo,
        &fixture.config,
        &["worktree", "add", "--detach", linked_path],
    );
    let mut agent = fixture.agent();
    let opened = open(&mut agent, linked_path);
    let linked_git_dir = git(&linked, &fixture.config, &["rev-parse", "--absolute-git-dir"]);
    let commondir = Path::new(linked_git_dir.trim_end_matches(['\r', '\n'])).join("commondir");
    let replacement_git_dir = replacement.repo.join(".git");
    std::fs::write(
        commondir,
        format!("{}\n", replacement_git_dir.display()),
    )
    .unwrap();

    let current_refs = git(
        &linked,
        &fixture.config,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    );
    assert!(current_refs.lines().any(|name| name == "replacement-only"));
    assert_eq!(
        agent.error_code("retargeted-read", "branchList", json!({ "repo": opened["repo"] })),
        "target_changed",
    );
    assert_eq!(
        agent.error_code(
            "retargeted-write",
            "branchCreate",
            json!({
                "repo": opened["repo"],
                "operationId": "op-retargeted-write",
                "stateToken": opened["stateToken"],
                "name": "must-not-create",
                "start": "main",
            }),
        ),
        "target_changed",
    );
    for repo in [&fixture.repo, &replacement.repo] {
        assert!(
            git(repo, &fixture.config, &["branch", "--list", "must-not-create"]).is_empty()
        );
    }
}

#[test]
#[cfg(unix)]
fn opens_a_worktree_whose_common_git_directory_ends_in_a_space() {
    let fixture = Fixture::new("common-dir-space");
    let metadata = fixture.repo.with_file_name("git metadata ");
    git(
        &fixture.repo,
        &fixture.config,
        &["init", "-b", "main", "--separate-git-dir", metadata.to_str().unwrap()],
    );
    fixture.write("note.txt", "visible content\n");
    fixture.commit_all("separate git directory");
    let reported = git(&fixture.repo, &fixture.config, &["rev-parse", "--git-common-dir"]);
    assert!(reported.ends_with("git metadata \n"));

    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    let history = agent.ok("space-history", "history", json!({ "repo": opened["repo"] }));
    assert_eq!(history["page"]["commits"][0]["summary"], json!("separate git directory"));
    let content = agent.ok(
        "space-file",
        "fileContent",
        json!({ "repo": opened["repo"], "relative": "note.txt" }),
    );
    assert_eq!(content["content"]["lines"], json!(["visible content"]));
}

#[test]
#[cfg(unix)]
fn task_diff_cursors_round_trip_with_a_long_path() {
    let fixture = Fixture::new("long-diff-path");
    fixture.init();
    let directory = vec!["a".repeat(218); 14].join("/");
    let path = format!("{directory}/note.txt");
    assert!(path.len() > 3000);
    fixture.write(&path, "old\n");
    fixture.commit_all("base");
    let head = git(&fixture.repo, &fixture.config, &["rev-parse", "HEAD"]);
    fixture.write(&path, "one\ntwo\nthree\n");

    let mut agent = fixture.agent();
    let opened = agent.ok(
        "long-open",
        "open",
        json!({ "path": fixture.repo_str(), "baseline": head.trim() }),
    );
    let mut request = json!({ "repo": opened["repo"], "path": path, "view": "task", "limit": 1 });
    let first = agent.ok("long-first", "diff", request.clone());
    let cursor = first["nextCursor"].as_str().expect("next page cursor");
    assert!(cursor.len() <= 256);
    request["offset"] = json!(1);
    request["cursor"] = json!(cursor);
    let second = agent.ok("long-next", "diff", request.clone());
    assert_eq!(second["diff"]["offset"], json!(1));
    assert_eq!(second["diff"]["lines"].as_array().unwrap().len(), 1);
    request["context"] = json!(0);
    assert_eq!(agent.error_code("changed-query", "diff", request.clone()), "cursor_expired");
    request["cursor"] = json!("x".repeat(257));
    assert_eq!(agent.error_code("oversized-cursor", "diff", request), "cursor_expired");
}

#[test]
fn history_search_file_history_and_commit_diff_page_the_selected_range() {
    let fixture = Fixture::new("history");
    fixture.init();
    fixture.write("note.txt", "one\n");
    fixture.commit_all("alpha one");
    fixture.write("note.txt", "one\ntwo\n");
    fixture.commit_all("beta two");
    fixture.write("note.txt", "one\ntwo\nthree\n");
    fixture.commit_all("gamma three");
    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();

    let page = agent.ok("history-1", "history", json!({ "repo": repo }))["page"].clone();
    assert_eq!(page["state"], json!("ok"));
    assert_eq!(page["offset"], json!(0));
    assert_eq!(page["scope"], json!("current"));
    assert_eq!(page["commits"].as_array().unwrap().len(), 3);
    assert_eq!(page["commits"][0]["summary"], json!("gamma three"));
    assert_eq!(page["hasMore"], json!(false));
    assert!(page["pageSize"].as_u64().unwrap() >= 3);
    assert_eq!(page["head"], opened["snapshot"]["branch"]["name"]);

    let search = agent.ok(
        "history-2",
        "history",
        json!({ "repo": repo, "query": "beta" }),
    )["page"]
        .clone();
    assert_eq!(search["commits"].as_array().unwrap().len(), 1);
    assert_eq!(search["commits"][0]["summary"], json!("beta two"));

    let missing = agent.ok(
        "history-3",
        "history",
        json!({ "repo": repo, "query": "no-such-commit" }),
    )["page"]
        .clone();
    assert_eq!(missing["state"], json!("no_match"));

    let oldest = page["commits"][2]["oid"].as_str().unwrap().to_string();
    let newest = page["commits"][0]["oid"].as_str().unwrap().to_string();
    let file_page = agent.ok(
        "file-history-1",
        "fileHistory",
        json!({ "repo": repo, "path": "note.txt" }),
    )["page"]
        .clone();
    assert_eq!(file_page["path"], json!("note.txt"));
    assert_eq!(file_page["state"], json!("ok"));
    assert_eq!(file_page["commits"].as_array().unwrap().len(), 3);

    let detail = agent.ok(
        "detail-1",
        "commitDetail",
        json!({ "repo": repo, "oid": oldest }),
    )["commit"]
        .clone();
    assert_eq!(detail["commit"]["summary"], json!("alpha one"));
    assert!(detail["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|file| file["path"] == json!("note.txt")));

    // 提交里的文件差异按页读取：limit=1 只回一行，同时报出总行数。
    let diff = agent.ok(
        "commit-diff-1",
        "commitDiff",
        json!({ "repo": repo, "oid": newest, "path": "note.txt", "limit": 1 }),
    )["diff"]
        .clone();
    assert_eq!(diff["lines"].as_array().unwrap().len(), 1);
    assert!(diff["totalLines"].as_u64().unwrap() > 1);

    let compare = agent.ok(
        "compare-1",
        "compare",
        json!({ "repo": repo, "base": oldest, "head": newest }),
    )["compare"]
        .clone();
    assert_eq!(compare["head"], json!(newest));
    assert!(compare["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|file| file["path"] == json!("note.txt")));
}

#[test]
fn branch_and_tag_writes_return_the_shared_state_and_replay_receipts() {
    let fixture = Fixture::new("branches");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");
    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();

    let created = agent.ok(
        "branch-create",
        "branchCreate",
        json!({
            "repo": repo,
            "operationId": "op-branch-create-1",
            "stateToken": opened["stateToken"],
            "name": "feature",
            "start": "main",
        }),
    );
    assert_eq!(created["receipt"]["state"], json!("completed"));
    assert_eq!(created["receipt"]["op"], json!("branchCreate"));
    assert!(created["branches"]["branches"]
        .as_array()
        .unwrap()
        .iter()
        .any(|branch| branch["name"] == json!("feature")));

    // 同一个操作 ID + 同一个请求摘要：直接重放完成结果，不新建第二次。
    let replay = agent.ok(
        "branch-create-replay",
        "branchCreate",
        json!({
            "repo": repo,
            "operationId": "op-branch-create-1",
            "stateToken": opened["stateToken"],
            "name": "feature",
            "start": "main",
        }),
    );
    assert_eq!(replay["replayed"], json!(true));

    let token = token_of(&created);
    let switched = agent.ok(
        "branch-switch",
        "branchSwitch",
        json!({
            "repo": repo,
            "operationId": "op-branch-switch-1",
            "stateToken": token,
            "name": "feature",
        }),
    );
    assert_eq!(switched["branches"]["snapshot"]["branch"]["name"], json!("feature"));

    let token = token_of(&switched);
    let renamed = agent.ok(
        "branch-rename",
        "branchRename",
        json!({
            "repo": repo,
            "operationId": "op-branch-rename-1",
            "stateToken": token,
            "old": "feature",
            "new": "feature-2",
        }),
    );
    assert!(renamed["branches"]["branches"]
        .as_array()
        .unwrap()
        .iter()
        .any(|branch| branch["name"] == json!("feature-2")));

    let token = token_of(&renamed);
    let back = agent.ok(
        "branch-switch-back",
        "branchSwitch",
        json!({
            "repo": repo,
            "operationId": "op-branch-switch-2",
            "stateToken": token,
            "name": "main",
        }),
    );

    let token = token_of(&back);
    let deleted = agent.ok(
        "branch-delete",
        "branchDelete",
        json!({
            "repo": repo,
            "operationId": "op-branch-delete-1",
            "stateToken": token,
            "name": "feature-2",
        }),
    );
    assert_eq!(deleted["receipt"]["state"], json!("completed"));
    assert!(!deleted["branches"]["branches"]
        .as_array()
        .unwrap()
        .iter()
        .any(|branch| branch["name"] == json!("feature-2")));

    let token = token_of(&deleted);
    let tagged = agent.ok(
        "tag-create",
        "tagCreate",
        json!({
            "repo": repo,
            "operationId": "op-tag-create-1",
            "stateToken": token,
            "name": "v1",
            "target": "HEAD",
            "message": "first release",
        }),
    );
    assert!(tagged["tags"]["tags"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tag| tag["name"] == json!("v1")));

    let token = token_of(&tagged);
    let untagged = agent.ok(
        "tag-delete",
        "tagDelete",
        json!({
            "repo": repo,
            "operationId": "op-tag-delete-1",
            "stateToken": token,
            "name": "v1",
            "confirm": true,
        }),
    );
    assert!(untagged["tags"]["tags"].as_array().unwrap().is_empty());

    // 每个写入都留下可查询的回执，并按 operationId 回答。
    let receipt = agent.ok(
        "receipt-tag",
        "receipt",
        json!({ "repo": repo, "operationId": "op-tag-delete-1" }),
    );
    assert_eq!(receipt["receipt"]["state"], json!("completed"));
    assert_eq!(receipt["operationId"], json!("op-tag-delete-1"));
}

#[test]
fn fetch_push_and_pull_run_real_git_on_the_remote_side() {
    let fixture = Fixture::new("sync");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");
    let base = base_of(&fixture);
    let bare = base.join("remote.git");
    git(&base, &fixture.config, &["init", "--bare", "remote.git"]);
    let bare_str = bare.to_string_lossy().into_owned();
    git(&fixture.repo, &fixture.config, &["remote", "add", "origin", &bare_str]);
    git(&fixture.repo, &fixture.config, &["push", "-u", "origin", "main"]);

    let mut agent = fixture.agent();
    open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();

    let remote_state = agent.ok(
        "remote-state",
        "remoteState",
        json!({ "repo": repo }),
    )["remote"]
        .clone();
    assert!(remote_state["remotes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|remote| remote["name"] == json!("origin")));

    // 提交由别人造成：先按 status 重新取令牌，再推送。远端 HEAD 必须真的前进。
    fixture.write("pushed.txt", "pushed\n");
    fixture.commit_all("pushed from agent");
    let state = agent.ok("status-1", "status", json!({ "repo": repo }));
    let token = state["stateToken"].as_str().unwrap().to_string();
    let pushed = agent.ok(
        "push",
        "push",
        json!({ "repo": repo, "operationId": "op-push-0001", "stateToken": token }),
    );
    assert_eq!(pushed["receipt"]["state"], json!("completed"));
    let local_head = git(&fixture.repo, &fixture.config, &["rev-parse", "HEAD"]);
    let remote_head = git(
        &base,
        &fixture.config,
        &["--git-dir", "remote.git", "rev-parse", "main"],
    );
    assert_eq!(local_head.trim(), remote_head.trim());

    // 别人往远端推了一个新提交，agent 在自己的工作树里把它拉下来。
    let other = base.join("other");
    git(&base, &fixture.config, &["clone", &bare_str, "other"]);
    std::fs::write(other.join("from-remote.txt"), "remote\n").unwrap();
    git(&other, &fixture.config, &["add", "-A"]);
    git(&other, &fixture.config, &["commit", "-m", "from other"]);
    git(&other, &fixture.config, &["push", "origin", "main"]);

    let token = token_of(&pushed);
    let fetched = agent.ok(
        "fetch",
        "fetch",
        json!({ "repo": repo, "operationId": "op-fetch-0001", "stateToken": token }),
    );
    assert_eq!(fetched["receipt"]["state"], json!("completed"));
    let token = token_of(&fetched);
    let pulled = agent.ok(
        "pull",
        "pull",
        json!({ "repo": repo, "operationId": "op-pull-0001", "stateToken": token }),
    );
    assert_eq!(pulled["receipt"]["state"], json!("completed"));
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("from-remote.txt"))
            .unwrap()
            .trim(),
        "remote"
    );
}

#[test]
fn stash_save_apply_and_delete_round_trip_through_the_agent() {
    let fixture = Fixture::new("stash");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");
    let mut agent = fixture.agent();
    open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();

    // 外部改动会改变状态令牌，写入前必须重新读取。
    fixture.write("a.txt", "a\nchange\n");
    let state = agent.ok("status-save", "status", json!({ "repo": repo }));
    let saved = agent.ok(
        "stash-save",
        "stashSave",
        json!({
            "repo": repo,
            "operationId": "op-stash-save-1",
            "stateToken": state["stateToken"],
            "includeUntracked": true,
            "message": "wip",
        }),
    );
    assert_eq!(saved["receipt"]["state"], json!("completed"));
    let records = saved["stash"]["state"]["records"].as_array().unwrap();
    assert_eq!(records.len(), 1);
    let oid = records[0]["oid"].as_str().unwrap().to_string();
    // 保存后工作树干净，改动确实进了 stash。
    assert!(saved["stash"]["state"]["snapshot"]["files"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("a.txt")).unwrap(),
        "a\n"
    );

    let token = token_of(&saved);
    let applied = agent.ok(
        "stash-apply",
        "stashApply",
        json!({ "repo": repo, "operationId": "op-stash-apply-1", "stateToken": token, "oid": oid }),
    );
    assert!(applied["stash"]["snapshot"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|file| file["path"] == json!("a.txt")));

    let token = token_of(&applied);
    let deleted = agent.ok(
        "stash-delete",
        "stashDelete",
        json!({
            "repo": repo,
            "operationId": "op-stash-delete-1",
            "stateToken": token,
            "oid": oid,
            "confirm": true,
        }),
    );
    assert!(deleted["stash"]["records"].as_array().unwrap().is_empty());
}

#[test]
fn merge_conflict_blocks_completion_until_the_conflict_is_resolved() {
    let fixture = Fixture::new("merge");
    fixture.init();
    fixture.write("a.txt", "base\n");
    fixture.commit_all("base");
    git(&fixture.repo, &fixture.config, &["checkout", "-b", "side"]);
    fixture.write("a.txt", "side\n");
    fixture.commit_all("side");
    git(&fixture.repo, &fixture.config, &["checkout", "main"]);
    fixture.write("a.txt", "main\n");
    fixture.commit_all("main");

    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();

    let preview = agent.ok(
        "merge-preview",
        "mergePreview",
        json!({ "repo": repo, "source": "side" }),
    )["preview"]
        .clone();
    assert_eq!(preview["source"], json!("side"));
    assert_eq!(preview["canStart"], json!(true));

    let started = agent.ok(
        "merge-start",
        "mergeStart",
        json!({
            "repo": repo,
            "operationId": "op-merge-start-1",
            "stateToken": opened["stateToken"],
            "source": "side",
        }),
    );
    assert_eq!(started["merge"]["operation"], json!("merge"));
    assert!(started["receipt"]["reviewOutcome"].is_null());
    assert_eq!(started["merge"]["unresolved"], json!(1));
    assert_eq!(started["merge"]["conflicts"][0]["path"], json!("a.txt"));
    assert_eq!(started["merge"]["canContinue"], json!(false));

    // 还有未解决冲突时不允许完成合并。
    let blocked = agent.call(
        "merge-complete-early",
        "mergeComplete",
        json!({
            "repo": repo,
            "operationId": "op-merge-complete-early",
            "stateToken": token_of(&started),
            "message": "merge side",
        }),
    );
    assert_eq!(blocked["ok"], json!(false), "冲突未解决时不应完成合并");

    let view = agent.ok(
        "conflict-view",
        "conflictView",
        json!({ "repo": repo, "path": "a.txt" }),
    )["conflict"]
        .clone();
    assert!(view["ours"]["text"]
        .as_str()
        .unwrap_or_default()
        .contains("main"));
    assert!(view["theirs"]["text"]
        .as_str()
        .unwrap_or_default()
        .contains("side"));

    let resolved = agent.ok(
        "resolve",
        "resolveConflict",
        json!({
            "repo": repo,
            "operationId": "op-resolve-1",
            "stateToken": token_of(&started),
            "path": "a.txt",
            "choice": "ours",
        }),
    );
    assert_eq!(resolved["merge"]["unresolved"], json!(0));
    assert_eq!(resolved["merge"]["canContinue"], json!(true));

    let completed = agent.ok(
        "merge-complete",
        "mergeComplete",
        json!({
            "repo": repo,
            "operationId": "op-merge-complete-1",
            "stateToken": token_of(&resolved),
            "message": "merge side",
        }),
    );
    assert_eq!(completed["merge"]["operation"], json!("merge"));
    assert_eq!(completed["receipt"]["reviewOutcome"], json!("merged"));
    let recovered = agent.ok("merge-receipt", "receipt", json!({
        "repo":repo, "operationId":"op-merge-complete-1",
    }));
    assert_eq!(recovered["receipt"]["reviewOutcome"], json!("merged"));
    assert_eq!(recovered["receipt"]["head"], completed["merge"]["oid"]);
    assert!(!completed["merge"]["oid"].as_str().unwrap().is_empty());
    assert!(completed["merge"]["snapshot"]["files"]
        .as_array()
        .unwrap()
        .is_empty());

    // 合并提交是真实写入：HEAD 前进到合并结果，工作树干净。
    assert_eq!(
        git(&fixture.repo, &fixture.config, &["rev-list", "--count", "HEAD"]).trim(),
        "4"
    );
}

#[test]
fn cherry_pick_undo_and_revert_write_real_commits() {
    let fixture = Fixture::new("pick");
    fixture.init();
    fixture.write("a.txt", "1\n");
    fixture.commit_all("one");
    fixture.write("a.txt", "1\n2\n");
    fixture.commit_all("two");
    let second = git(&fixture.repo, &fixture.config, &["rev-parse", "HEAD"])
        .trim()
        .to_string();
    git(&fixture.repo, &fixture.config, &["checkout", "-b", "topic"]);
    fixture.write("b.txt", "b\n");
    fixture.commit_all("topic work");
    let topic = git(&fixture.repo, &fixture.config, &["rev-parse", "HEAD"])
        .trim()
        .to_string();
    git(&fixture.repo, &fixture.config, &["checkout", "main"]);
    // 修订撤销需要且仅需要一个远程来核对传播范围：给夹具一个真实的裸仓库 origin。
    let base = base_of(&fixture);
    let bare = base.join("remote.git");
    let bare_str = bare.to_string_lossy().into_owned();
    git(&base, &fixture.config, &["init", "--bare", "remote.git"]);
    git(&fixture.repo, &fixture.config, &["remote", "add", "origin", &bare_str]);
    git(&fixture.repo, &fixture.config, &["push", "-u", "origin", "main"]);

    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();

    let picked = agent.ok(
        "cherry-pick",
        "cherryPick",
        json!({
            "repo": repo,
            "operationId": "op-cherry-pick-1",
            "stateToken": opened["stateToken"],
            "oids": [topic],
        }),
    );
    assert_eq!(picked["cherryPick"]["created"], json!(1));
    let picked_head = picked["cherryPick"]["headOid"].as_str().unwrap().to_string();
    assert_ne!(picked_head, second);

    let undone = agent.ok(
        "undo-pick",
        "undoCommit",
        json!({
            "repo": repo,
            "operationId": "op-undo-pick-1",
            "stateToken": token_of(&picked),
            "expectedHead": picked_head,
            "confirm": true,
        }),
    );
    assert_eq!(undone["undo"]["wrote"], json!(true));
    assert_eq!(
        git(&fixture.repo, &fixture.config, &["rev-parse", "HEAD"]).trim(),
        second
    );

    // 撤销把改动留在暂存区；先让工作树回到已提交状态，再演示还原一个已推送的提交。
    git(&fixture.repo, &fixture.config, &["reset", "--hard", "HEAD"]);
    let state = agent.ok("status-before-revert", "status", json!({ "repo": repo }));
    let reverted = agent.ok(
        "revert",
        "revert",
        json!({
            "repo": repo,
            "operationId": "op-revert-1",
            "stateToken": state["stateToken"],
            "oids": [second],
            "expectedHead": second,
            "confirm": true,
        }),
    );
    assert_eq!(reverted["revert"]["wrote"], json!(true));
    assert_eq!(reverted["revert"]["created"], json!(1));
    // 还原第二个提交之后，a.txt 回到第一个提交的内容。
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("a.txt")).unwrap(),
        "1\n"
    );
}

#[cfg(unix)]
#[test]
fn a_failing_hook_keeps_the_receipt_failed_and_is_never_reenacted() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = Fixture::new("hook");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");
    let hook = fixture.repo.join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut agent = fixture.agent();
    open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();

    fixture.write("b.txt", "b\n");
    let state = agent.ok("status-hook", "status", json!({ "repo": repo }));
    let staged = agent.ok(
        "stage",
        "stage",
        json!({
            "repo": repo,
            "operationId": "op-hook-stage-1",
            "stateToken": state["stateToken"],
            "paths": ["b.txt"],
        }),
    );
    let token = token_of(&staged);

    let failed = agent.call(
        "commit-hook",
        "commit",
        json!({
            "repo": repo,
            "operationId": "op-hook-commit-1",
            "stateToken": token,
            "message": "should be rejected by hook",
        }),
    );
    assert_eq!(failed["ok"], json!(false), "钩子失败时提交必须失败");
    let code = failed["error"]["code"].as_str().unwrap().to_string();
    assert!(!code.is_empty());

    let receipt = agent.ok(
        "receipt-hook",
        "receipt",
        json!({ "repo": repo, "operationId": "op-hook-commit-1" }),
    );
    assert_eq!(receipt["receipt"]["state"], json!("failed"));
    assert_eq!(receipt["receipt"]["reason"], json!(code));

    // 同一个操作 ID 重试只会回到原失败原因，绝不重新执行写入。
    let retried = agent.call(
        "commit-hook-retry",
        "commit",
        json!({
            "repo": repo,
            "operationId": "op-hook-commit-1",
            "stateToken": token,
            "message": "should be rejected by hook",
        }),
    );
    assert_eq!(retried["ok"], json!(false));
    assert_eq!(retried["error"]["code"], json!(code));
    assert_eq!(
        git(&fixture.repo, &fixture.config, &["rev-list", "--count", "HEAD"]).trim(),
        "1"
    );

    // 去掉钩子后用新的操作 ID 才能继续；失败尝试可能刷新了索引统计，先重读状态。
    std::fs::remove_file(&hook).unwrap();
    let state = agent.ok("status-after-hook", "status", json!({ "repo": repo }));
    let committed = agent.ok(
        "commit-after-hook",
        "commit",
        json!({
            "repo": repo,
            "operationId": "op-hook-commit-2",
            "stateToken": state["stateToken"],
            "message": "no hook now",
        }),
    );
    assert_eq!(committed["receipt"]["state"], json!("completed"));
}

#[test]
fn an_index_lock_is_reported_without_touching_the_repository() {
    let fixture = Fixture::new("index-lock");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");
    let mut agent = fixture.agent();
    open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();

    fixture.write("a.txt", "a\nchange\n");
    let state = agent.ok("status-lock", "status", json!({ "repo": repo }));
    let lock = fixture.repo.join(".git/index.lock");
    std::fs::write(&lock, b"").unwrap();
    let code = agent.error_code(
        "stash-save",
        "stashSave",
        json!({
            "repo": repo,
            "operationId": "op-index-lock-1",
            "stateToken": state["stateToken"],
            "includeUntracked": true,
            "message": "wip",
        }),
    );
    assert_eq!(code, "index_lock");
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("a.txt")).unwrap(),
        "a\nchange\n"
    );
    std::fs::remove_file(&lock).unwrap();

    // 锁清掉之后同一个仓库照常可用。
    let state = agent.ok("stash-state", "stashState", json!({ "repo": repo }));
    assert!(state["stash"]["records"].as_array().unwrap().is_empty());
}

#[test]
fn an_unreadable_receipt_blocks_a_repeat_write() {
    let fixture = Fixture::new("corrupt-receipt");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");
    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();

    let receipts = fixture.repo.join(".git/twiglane-agent-v2/receipts");
    std::fs::create_dir_all(&receipts).unwrap();
    let corrupt = receipts.join("op-corrupt-0001.json");
    std::fs::write(&corrupt, b"{ not a receipt").unwrap();

    fixture.write("b.txt", "b\n");
    let code = agent.error_code(
        "stage-corrupt",
        "stage",
        json!({
            "repo": repo,
            "operationId": "op-corrupt-0001",
            "stateToken": opened["stateToken"],
            "paths": ["b.txt"],
        }),
    );
    assert_eq!(code, "receipt_unreadable");
    // 回执文件不能被覆盖，仓库也不能被写。
    assert_eq!(std::fs::read(&corrupt).unwrap(), b"{ not a receipt");
    let status = git(&fixture.repo, &fixture.config, &["status", "--porcelain"]);
    assert!(status.contains("b.txt"));
    assert!(!status.lines().any(|line| line.starts_with("A ")));

    let query = agent.call(
        "receipt-corrupt",
        "receipt",
        json!({ "repo": repo, "operationId": "op-corrupt-0001" }),
    );
    assert_eq!(query["ok"], json!(false));
    assert_eq!(query["error"]["code"], json!("receipt_unreadable"));
}

#[test]
fn receipts_survive_reconnect_and_registered_ones_stay_pending() {
    let fixture = Fixture::new("reconnect");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");
    let repo = fixture.repo_str();

    let head = {
        let mut agent = fixture.agent();
        open(&mut agent, &repo);
        fixture.write("b.txt", "b\n");
        let state = agent.ok("status-before-stage", "status", json!({ "repo": repo }));
        let staged = agent.ok(
            "stage",
            "stage",
            json!({
                "repo": repo,
                "operationId": "op-reconnect-0001",
                "stateToken": state["stateToken"],
                "paths": ["b.txt"],
            }),
        );
        assert_eq!(staged["receipt"]["state"], json!("completed"));
        staged["receipt"]["head"].as_str().unwrap().to_string()
    };

    // 新进程、同一 Git 目录：回执仍然可查，且能核对到当时的 HEAD。
    let mut second = fixture.agent();
    open(&mut second, &repo);
    let receipt = second.ok(
        "receipt-after-restart",
        "receipt",
        json!({ "repo": repo, "operationId": "op-reconnect-0001" }),
    );
    assert_eq!(receipt["receipt"]["state"], json!("completed"));
    assert_eq!(receipt["receipt"]["head"], json!(head));

    // 人为留下一条 registered 回执：重连后只能查询，同一操作 ID 不能再写。
    let receipts = fixture.repo.join(".git/twiglane-agent-v2/receipts");
    let pending = receipts.join("op-pending-0001.json");
    let body = serde_json::json!({
        "operationId": "op-pending-0001",
        "repo": repo,
        "op": "stage",
        "requestDigest": "not-the-same-request",
        "state": "registered",
        "generation": 1,
        "atMs": 1,
    });
    std::fs::write(&pending, serde_json::to_vec(&body).unwrap()).unwrap();
    let query = second.ok(
        "receipt-pending",
        "receipt",
        json!({ "repo": repo, "operationId": "op-pending-0001" }),
    );
    assert_eq!(query["receipt"]["state"], json!("registered"));

    let token = second.ok("status-1", "status", json!({ "repo": repo }))["stateToken"]
        .as_str()
        .unwrap()
        .to_string();
    let code = second.error_code(
        "stage-pending",
        "stage",
        json!({
            "repo": repo,
            "operationId": "op-pending-0001",
            "stateToken": token,
            "paths": ["b.txt"],
        }),
    );
    assert_eq!(code, "operation_conflict");
}

#[test]
fn linked_worktrees_are_listed_and_removable_from_the_agent() {
    let fixture = Fixture::new("worktree");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");
    let base = base_of(&fixture);
    let linked = base.join("linked");
    let linked_str = linked.to_string_lossy().into_owned();
    git(
        &fixture.repo,
        &fixture.config,
        &["worktree", "add", &linked_str, "-b", "linked-branch"],
    );

    let mut agent = fixture.agent();
    let opened_main = open(&mut agent, &fixture.repo_str());
    let overview = agent.ok(
        "worktrees",
        "worktrees",
        json!({ "repo": fixture.repo_str(), "paths": [fixture.repo_str()] }),
    )["worktrees"]
        .clone();
    let items = overview["items"].as_array().unwrap();
    assert!(items.iter().any(|item| item["path"] == json!(linked_str)));

    // 附属工作区自己的会话才能删除它；主工作区始终拒绝。
    let mut second = fixture.agent();
    let opened_linked = open(&mut second, &linked_str);
    let removed = second.ok(
        "worktree-remove",
        "worktreeRemove",
        json!({
            "repo": linked_str,
            "operationId": "op-worktree-remove-1",
            "stateToken": opened_linked["stateToken"],
            "force": true,
        }),
    );
    assert_eq!(removed["receipt"]["state"], json!("completed"));
    assert!(!linked.exists());
    let receipt = second.ok(
        "removed-worktree-receipt",
        "receipt",
        json!({ "repo": linked_str, "operationId": "op-worktree-remove-1" }),
    );
    assert_eq!(receipt["receipt"], removed["receipt"]);

    let refused = agent.error_code(
        "worktree-remove-main",
        "worktreeRemove",
        json!({
            "repo": fixture.repo_str(),
            "operationId": "op-worktree-remove-2",
            "stateToken": opened_main["stateToken"],
            "force": true,
        }),
    );
    assert_eq!(refused, "not_worktree");
}

#[test]
fn cancel_reports_unknown_targets_and_leaves_the_repository_usable() {
    let fixture = Fixture::new("cancel");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");
    let mut agent = fixture.agent();
    open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();

    let unknown = agent.ok("cancel-1", "cancel", json!({ "targetId": "never-issued" }));
    assert_eq!(unknown["cancelled"], json!(false));

    // 取消一个已经结束的请求只是标记失败：仓库仍可读。
    let history = agent.ok("history-1", "history", json!({ "repo": repo }));
    assert!(!history["page"]["commits"].as_array().unwrap().is_empty());
    let late = agent.ok("cancel-2", "cancel", json!({ "targetId": "history-1" }));
    assert_eq!(late["cancelled"], json!(false));
    let again = agent.ok("history-2", "history", json!({ "repo": repo }));
    assert_eq!(again["page"]["state"], json!("ok"));
}

#[test]
fn every_advertised_capability_has_a_handler() {
    let fixture = Fixture::new("capabilities");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");
    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    let hello = agent.ok("hello-1", "hello", json!({ "client": "test" }));
    let capabilities = hello["capabilities"].as_array().unwrap().clone();
    // 能力面不能多报：每个声明过的 op 都必须有分派分支，缺字段时应答 invalid_request 一类错误，
    // 而不是 unsupported_op。
    for (index, capability) in capabilities.iter().enumerate() {
        let op = capability.as_str().expect("能力名必须是字符串");
        let response = agent.call(
            &format!("cap-{index}"),
            op,
            json!({ "repo": opened["repo"] }),
        );
        if response["ok"] == json!(true) {
            // 少数读取（如 status）可以只靠仓库标识完成，这同样说明有分派分支。
            continue;
        }
        assert_ne!(
            response["error"]["code"],
            json!("unsupported_op"),
            "{op} 已声明为能力但未实现"
        );
    }
    assert!(capabilities.contains(&json!("worktreeRemove")));
}

#[test]
fn the_window_read_entries_track_branches_tags_and_commit_membership() {
    let fixture = Fixture::new("read-parity");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");
    let base = base_of(&fixture);
    let bare = base.join("remote.git");
    git(&base, &fixture.config, &["init", "--bare", "remote.git"]);
    let bare_str = bare.to_string_lossy().into_owned();
    git(&fixture.repo, &fixture.config, &["remote", "add", "origin", &bare_str]);
    git(&fixture.repo, &fixture.config, &["push", "-u", "origin", "main"]);
    // feature 推上去后从远端删掉：本地仍配置上游，跟踪信息必须是 gone。
    git(&fixture.repo, &fixture.config, &["checkout", "-b", "feature"]);
    git(&fixture.repo, &fixture.config, &["push", "-u", "origin", "feature"]);
    git(&fixture.repo, &fixture.config, &["checkout", "main"]);
    git(&fixture.repo, &fixture.config, &["push", "origin", "--delete", "feature"]);
    fixture.write("b.txt", "b\n");
    fixture.commit_all("local ahead");
    git(&fixture.repo, &fixture.config, &["fetch", "--prune", "origin"]);

    let mut agent = fixture.agent();
    open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();

    let tracking = agent.ok("tracking-1", "branchTracking", json!({ "repo": repo }))["branchTracking"]
        .clone();
    let branches = tracking["branches"].as_array().unwrap();
    let main = branches
        .iter()
        .find(|item| item["name"] == json!("main"))
        .expect("main 必须在跟踪信息里");
    assert_eq!(main["upstream"], json!("origin/main"));
    assert_eq!(main["ahead"], json!(1), "本地比 origin/main 多一个提交");
    assert_eq!(main["behind"], json!(0));
    assert_eq!(main["gone"], json!(false));
    let feature = branches
        .iter()
        .find(|item| item["name"] == json!("feature"))
        .expect("feature 必须在跟踪信息里");
    assert_eq!(feature["gone"], json!(true), "远程分支已删除，跟踪引用是 gone");

    let state = agent.ok("branch-state-1", "branchState", json!({ "repo": repo }))["branchState"]
        .clone();
    assert_eq!(state["snapshot"]["branch"]["name"], json!("main"));
    assert!(state["branches"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["name"] == json!("feature")));

    // 远端标签是 ls-remote 的结果，与本地标签分开读。
    git(&fixture.repo, &fixture.config, &["tag", "v-parity"]);
    git(&fixture.repo, &fixture.config, &["push", "origin", "v-parity"]);
    let remote_tags = agent.ok(
        "tag-remote-1",
        "tagRemoteState",
        json!({ "repo": repo, "remote": "origin" }),
    )["tagRemoteState"]
        .clone();
    assert!(remote_tags
        .as_array()
        .unwrap()
        .iter()
        .any(|tag| tag["name"] == json!("v-parity")));

    // 含该提交的分支：当前分支命中，远端跟踪分支也算一条。
    let head = git(&fixture.repo, &fixture.config, &["rev-parse", "HEAD"])
        .trim()
        .to_string();
    let membership = agent.ok(
        "commit-branches-1",
        "commitBranches",
        json!({ "repo": repo, "oid": head }),
    )["commitBranches"]
        .clone();
    assert_eq!(membership["current"], json!("main"));
    let containing = membership["branches"].as_array().unwrap();
    assert!(containing
        .iter()
        .any(|item| item["name"] == json!("main") && item["current"] == json!(true)));
    assert_eq!(membership["total"], json!(1), "只有 main 还指向这个新提交：{membership}");

    // 更早的提交同时被 main 与 feature 包含：清单不能只看当前分支。
    let first = git(
        &fixture.repo,
        &fixture.config,
        &["rev-list", "--max-parents=0", "HEAD"],
    )
    .trim()
    .to_string();
    let older = agent.ok(
        "commit-branches-2",
        "commitBranches",
        json!({ "repo": repo, "oid": first }),
    )["commitBranches"]
        .clone();
    let older_branches = older["branches"].as_array().unwrap();
    assert!(older_branches
        .iter()
        .any(|item| item["name"] == json!("main")));
    assert!(
        older_branches
            .iter()
            .any(|item| item["name"] == json!("feature")),
        "更早的提交也被 feature 包含：{older}"
    );

    let diff = agent.ok(
        "compare-file-1",
        "compareFileDiff",
        json!({ "repo": repo, "base": first, "head": head, "path": "b.txt" }),
    )["compareFileDiff"]
        .clone();
    assert_eq!(diff["path"], json!("b.txt"));
    assert!(
        diff["lines"].as_array().unwrap().iter().any(|line| {
            line["kind"] == json!("add") && line["text"].as_str().unwrap_or_default().contains("b")
        }),
        "新增行必须来自真实差异：{diff}"
    );

    // 空 base 表示与空树比较：历史多选的最早提交没有父提交。
    let from_empty = agent.ok(
        "compare-file-2",
        "compareFileDiff",
        json!({ "repo": repo, "base": "", "head": head, "path": "a.txt" }),
    )["compareFileDiff"]
        .clone();
    assert!(from_empty["lines"]
        .as_array()
        .unwrap()
        .iter()
        .any(|line| line["kind"] == json!("add")));
}

#[test]
fn upstream_and_remote_branch_writes_go_through_shared_sync() {
    let fixture = Fixture::new("upstream");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");
    let base = base_of(&fixture);
    let bare = base.join("remote.git");
    git(&base, &fixture.config, &["init", "--bare", "remote.git"]);
    let bare_str = bare.to_string_lossy().into_owned();
    git(&fixture.repo, &fixture.config, &["remote", "add", "origin", &bare_str]);
    git(&fixture.repo, &fixture.config, &["push", "-u", "origin", "main"]);
    // work 已推到远端，但刻意清掉本地上游配置：这正是「关联上游」要处理的状态。
    git(&fixture.repo, &fixture.config, &["checkout", "-b", "work"]);
    git(&fixture.repo, &fixture.config, &["push", "-u", "origin", "work"]);
    git(&fixture.repo, &fixture.config, &["branch", "--unset-upstream"]);
    // 别人往远端推一条新分支：fetchBranches 之后本地应出现 origin/distant。
    let other = base.join("other");
    git(&base, &fixture.config, &["clone", &bare_str, "other"]);
    git(&other, &fixture.config, &["checkout", "-b", "distant"]);
    std::fs::write(other.join("d.txt"), "d\n").unwrap();
    git(&other, &fixture.config, &["add", "-A"]);
    git(&other, &fixture.config, &["commit", "-m", "distant"]);
    git(&other, &fixture.config, &["push", "origin", "distant"]);

    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();

    let fetched = agent.ok(
        "fetch-branches-1",
        "fetchBranches",
        json!({
            "repo": repo,
            "operationId": "op-fetch-branches-1",
            "stateToken": opened["stateToken"],
        }),
    );
    assert_eq!(fetched["receipt"]["state"], json!("completed"));
    assert!(
        fetched["branches"]["branches"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["name"] == json!("origin/distant")),
        "fetch 之后必须能看到远端跟踪分支：{fetched}"
    );

    // 关联上游：桌面端会带空远程名，由共享实现按现有远程决定。
    let associated = agent.ok(
        "associate-1",
        "associateUpstream",
        json!({
            "repo": repo,
            "operationId": "op-associate-upstream-1",
            "stateToken": token_of(&fetched),
            "remote": "",
        }),
    );
    assert_eq!(associated["receipt"]["state"], json!("completed"));
    assert_eq!(associated["snapshot"]["branch"]["upstream"], json!("origin/work"));

    // 改成另一条已有的远程分支：branch.<name>.merge 必须真的被改写。
    let switched = agent.ok(
        "set-upstream-1",
        "setUpstream",
        json!({
            "repo": repo,
            "operationId": "op-set-upstream-1",
            "stateToken": token_of(&associated),
            "upstream": "origin/main",
        }),
    );
    assert_eq!(
        switched["branches"]["snapshot"]["branch"]["upstream"],
        json!("origin/main")
    );
    let merge_ref = git(
        &fixture.repo,
        &fixture.config,
        &["config", "--get", "branch.work.merge"],
    );
    assert_eq!(merge_ref.trim(), "refs/heads/main");

    // 删除远端分支：远端真的少了一条，本地跟踪引用同步消失。
    let deleted = agent.ok(
        "delete-remote-1",
        "deleteRemoteBranch",
        json!({
            "repo": repo,
            "operationId": "op-delete-remote-branch-1",
            "stateToken": token_of(&switched),
            "remote": "origin",
            "name": "distant",
            "confirm": true,
        }),
    );
    assert_eq!(deleted["receipt"]["state"], json!("completed"));
    let remote_heads = git(
        &base,
        &fixture.config,
        &["--git-dir", "remote.git", "branch", "--list"],
    );
    assert!(
        !remote_heads.contains("distant"),
        "远端分支应已删除：{remote_heads}"
    );
    assert!(!deleted["branches"]["branches"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["name"] == json!("origin/distant")));
}

#[test]
fn cancel_stops_an_in_flight_fetch_and_leaves_the_result_unknown() {
    let fixture = Fixture::new("cancel-fetch");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");
    let base = base_of(&fixture);
    // 本机就能构造的「在途远程命令」：ext:: 传输先建标记文件再挂住 30 秒，
    // 不依赖弱网或外部主机，慢远端的行为是确定性的。
    let script = base.join("slow-remote.sh");
    let marker = base.join("remote-started");
    let body = format!(
        "#!/bin/sh\ntouch \"{}\"\nsleep 30\n",
        marker.display()
    );
    std::fs::write(&script, body).unwrap();
    git(
        &fixture.repo,
        &fixture.config,
        &["config", "protocol.ext.allow", "always"],
    );
    let url = format!("ext::sh {}", script.to_string_lossy());
    git(&fixture.repo, &fixture.config, &["remote", "add", "origin", &url]);

    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();

    agent.send(
        "fetch-slow",
        "fetch",
        json!({
            "repo": repo,
            "operationId": "op-fetch-slow-1",
            "stateToken": opened["stateToken"],
        }),
    );
    // 等到远程命令真的启动：只有这时取消才证明「能中止在途传输」。
    let mut started = false;
    for _ in 0..300 {
        if marker.exists() {
            started = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(started, "远程命令没有启动，用例无法证明取消生效");

    let cancelled = agent.ok("cancel-fetch", "cancel", json!({ "targetId": "fetch-slow" }));
    assert_eq!(cancelled["cancelled"], json!(true));
    assert_eq!(
        cancelled["remoteStopped"],
        json!(true),
        "访问远程的请求必须同时停掉共享 sync 层的远程命令"
    );

    let response = agent.read_id("fetch-slow");
    assert_eq!(response["ok"], json!(false));
    assert_eq!(response["error"]["code"], json!("cancelled"));

    // 结果未知：回执是 pending，不是 failed；同一个 operationId 不能重发。
    let receipt = agent.ok(
        "receipt-slow",
        "receipt",
        json!({ "repo": repo, "operationId": "op-fetch-slow-1" }),
    );
    assert_eq!(receipt["receipt"]["state"], json!("pending"));
    assert_eq!(receipt["receipt"]["reason"], json!("cancelled"));
    let again = agent.error_code(
        "fetch-slow-again",
        "fetch",
        json!({
            "repo": repo,
            "operationId": "op-fetch-slow-1",
            "stateToken": opened["stateToken"],
        }),
    );
    assert_eq!(again, "operation_pending");

    // 取消之后仓库仍然可用：读取照常，工作树没被动过。
    let status = agent.ok("status-after-cancel", "status", json!({ "repo": repo }));
    assert_eq!(status["snapshot"]["branch"]["name"], json!("main"));
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("a.txt")).unwrap(),
        "a\n"
    );
}

#[test]
fn worktree_remove_rejects_fields_it_does_not_understand() {
    let fixture = Fixture::new("worktree-fields");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");
    let base = base_of(&fixture);
    let linked = base.join("linked");
    let linked_str = linked.to_string_lossy().into_owned();
    git(
        &fixture.repo,
        &fixture.config,
        &["worktree", "add", &linked_str, "-b", "linked-branch"],
    );
    let mut agent = fixture.agent();
    let opened = open(&mut agent, &linked_str);
    // 多带一个 path 说明调用方按本地命令的形状在调用：必须拒绝，而不是按当前工作树删除。
    let code = agent.error_code(
        "worktree-remove-extra",
        "worktreeRemove",
        json!({
            "repo": linked_str.clone(),
            "operationId": "op-worktree-remove-extra",
            "stateToken": opened["stateToken"],
            "force": true,
            "path": linked_str,
        }),
    );
    assert_eq!(code, "invalid_request");
    assert!(linked.exists(), "被拒绝的请求不能删掉工作区");
}

/// 共享行为清单：`tests/fixtures/remote-parity/scenarios.json` 是本地与远端共用的场景表，
/// 这里直接用它里面的期望值驱动真实 Git，改期望只改那一份。
#[test]
fn shared_parity_scenarios_drive_the_remote_agent() {
    let raw: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/remote-parity/scenarios.json"
    ))
    .expect("共享场景清单必须是合法 JSON");
    let list = raw["scenarios"].as_array().expect("scenarios 必须是数组").clone();
    let find = |id: &str| {
        list.iter()
            .find(|scenario| scenario["id"] == json!(id))
            .unwrap_or_else(|| panic!("共享场景清单缺少 {id}"))
            .clone()
    };

    // 场景一：冲突合并必须挡住完成，直到冲突被显式解决。
    let scenario = find("merge-conflict-resolve");
    let expect = &scenario["expect"];
    let conflict_path = expect["conflictPath"].as_str().unwrap().to_string();
    let resolved_content = expect["resolvedContent"].as_str().unwrap().to_string();
    let blocked_before = expect["blockedBeforeResolve"].as_bool().unwrap();
    let increment = expect["commitCountIncrement"].as_u64().unwrap();

    let fixture = Fixture::new("parity-merge");
    fixture.init();
    fixture.write("a.txt", "base\n");
    fixture.commit_all("base");
    git(&fixture.repo, &fixture.config, &["checkout", "-b", "side"]);
    fixture.write("a.txt", "side\n");
    fixture.commit_all("side");
    git(&fixture.repo, &fixture.config, &["checkout", "main"]);
    fixture.write("a.txt", "main\n");
    fixture.commit_all("main");
    let before: u64 = git(&fixture.repo, &fixture.config, &["rev-list", "--count", "HEAD"])
        .trim()
        .parse()
        .unwrap();
    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();
    let started = agent.ok(
        "parity-merge-start",
        "mergeStart",
        json!({
            "repo": repo,
            "operationId": "op-parity-merge-start",
            "stateToken": opened["stateToken"],
            "source": "side",
        }),
    );
    assert_eq!(started["merge"]["conflicts"][0]["path"], json!(conflict_path));
    assert_eq!(started["merge"]["canContinue"], json!(false));
    let blocked = agent.call(
        "parity-merge-complete-early",
        "mergeComplete",
        json!({
            "repo": repo,
            "operationId": "op-parity-merge-complete-early",
            "stateToken": token_of(&started),
            "message": "merge side",
        }),
    );
    assert_eq!(
        blocked["ok"],
        json!(!blocked_before),
        "冲突未解决时不应完成合并：{blocked}"
    );
    let resolved = agent.ok(
        "parity-resolve",
        "resolveConflict",
        json!({
            "repo": repo,
            "operationId": "op-parity-resolve",
            "stateToken": token_of(&started),
            "path": conflict_path.clone(),
            "choice": "ours",
        }),
    );
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join(&conflict_path))
            .unwrap()
            .trim(),
        resolved_content,
        "冲突解决后的文件内容必须是被选中的那一侧"
    );
    let completed = agent.ok(
        "parity-merge-complete",
        "mergeComplete",
        json!({
            "repo": repo,
            "operationId": "op-parity-merge-complete",
            "stateToken": token_of(&resolved),
            "message": "merge side",
        }),
    );
    assert!(!completed["merge"]["oid"].as_str().unwrap().is_empty());
    let after: u64 = git(&fixture.repo, &fixture.config, &["rev-list", "--count", "HEAD"])
        .trim()
        .parse()
        .unwrap();
    assert_eq!(after, before + increment, "合并必须真的产生一个提交");

    // 场景二：stash 保存、应用、删除往返不丢改动。
    let scenario = find("stash-round-trip");
    let expect = &scenario["expect"];
    let message = expect["message"].as_str().unwrap().to_string();
    let changed_file = expect["changedFile"].as_str().unwrap().to_string();
    let restored_line = expect["restoredLine"].as_str().unwrap().to_string();
    let records_after_delete = expect["recordsAfterDelete"].as_u64().unwrap();

    let fixture = Fixture::new("parity-stash");
    fixture.init();
    fixture.write(&changed_file, "a\n");
    fixture.commit_all("init");
    let mut agent = fixture.agent();
    open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();
    fixture.write(&changed_file, "a\nchange\n");
    let state = agent.ok("parity-status", "status", json!({ "repo": repo }));
    let saved = agent.ok(
        "parity-stash-save",
        "stashSave",
        json!({
            "repo": repo,
            "operationId": "op-parity-stash-save",
            "stateToken": state["stateToken"],
            "includeUntracked": true,
            "message": message,
        }),
    );
    let records = saved["stash"]["state"]["records"].as_array().unwrap();
    assert_eq!(records.len(), 1, "保存后应有一条 stash 记录");
    let oid = records[0]["oid"].as_str().unwrap().to_string();
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join(&changed_file)).unwrap(),
        "a\n",
        "stash 保存后工作树必须回到已提交内容"
    );
    let applied = agent.ok(
        "parity-stash-apply",
        "stashApply",
        json!({
            "repo": repo,
            "operationId": "op-parity-stash-apply",
            "stateToken": token_of(&saved),
            "oid": oid,
        }),
    );
    assert!(
        std::fs::read_to_string(fixture.repo.join(&changed_file))
            .unwrap()
            .contains(&restored_line),
        "应用 stash 后改动必须回到工作树"
    );
    assert!(applied["stash"]["snapshot"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|file| file["path"] == json!(changed_file)));
    let removed = agent.ok(
        "parity-stash-delete",
        "stashDelete",
        json!({
            "repo": repo,
            "operationId": "op-parity-stash-delete",
            "stateToken": token_of(&applied),
            "oid": oid,
            "confirm": true,
        }),
    );
    assert_eq!(
        removed["stash"]["records"].as_array().unwrap().len() as u64,
        records_after_delete
    );

    // 场景三：附属工作区可列出并只由自己删除，主工作区始终拒绝。
    let scenario = find("worktree-add-remove");
    let expect = &scenario["expect"];
    let linked_branch = expect["linkedBranch"].as_str().unwrap().to_string();
    let listed_count = expect["listedCount"].as_u64().unwrap();
    let refusal = expect["mainRefusalCode"].as_str().unwrap().to_string();

    let fixture = Fixture::new("parity-worktree");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");
    let base = base_of(&fixture);
    let linked = base.join("parity-linked");
    let linked_str = linked.to_string_lossy().into_owned();
    git(
        &fixture.repo,
        &fixture.config,
        &["worktree", "add", &linked_str, "-b", &linked_branch],
    );
    let mut main_agent = fixture.agent();
    let opened_main = open(&mut main_agent, &fixture.repo_str());
    let overview = main_agent.ok(
        "parity-worktrees",
        "worktrees",
        json!({ "repo": fixture.repo_str(), "paths": [fixture.repo_str()] }),
    )["worktrees"]
        .clone();
    assert_eq!(
        overview["items"].as_array().unwrap().len() as u64,
        listed_count,
        "两棵工作树都要出现在同一份总览里"
    );
    assert!(overview["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["path"] == json!(linked_str.clone())));

    let mut linked_agent = fixture.agent();
    let opened_linked = open(&mut linked_agent, &linked_str);
    let removed_worktree = linked_agent.ok(
        "parity-worktree-remove",
        "worktreeRemove",
        json!({
            "repo": linked_str.clone(),
            "operationId": "op-parity-worktree-remove",
            "stateToken": opened_linked["stateToken"],
            "force": true,
        }),
    );
    assert_eq!(removed_worktree["receipt"]["state"], json!("completed"));
    assert!(!linked.exists(), "附属工作区应被真的删除");

    let refused = main_agent.error_code(
        "parity-worktree-remove-main",
        "worktreeRemove",
        json!({
            "repo": fixture.repo_str(),
            "operationId": "op-parity-worktree-remove-main",
            "stateToken": opened_main["stateToken"],
            "force": true,
        }),
    );
    assert_eq!(refused, refusal, "主工作区不能删除自己");

    // 场景四：文件树、正文分页与保存回执（T3）。
    let scenario = find("file-tree-edit-version");
    let expect = &scenario["expect"];
    let file_name = expect["fileName"].as_str().unwrap().to_string();
    let page_lines = expect["pageLines"].as_u64().unwrap() as usize;
    let first_line = expect["firstLine"].as_str().unwrap().to_string();
    let saved_line = expect["savedLine"].as_str().unwrap().to_string();
    let stale_code = expect["staleSaveCode"].as_str().unwrap().to_string();
    let receipt_state = expect["receiptState"].as_str().unwrap().to_string();

    let fixture = Fixture::new("parity-io");
    fixture.init();
    fixture.write(&file_name, "alpha\nsecond\n");
    fixture.commit_all("init");
    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();
    let token = opened["stateToken"].as_str().unwrap().to_string();

    let tree = agent.ok(
        "parity-io-dir",
        "directory",
        json!({ "repo": repo, "relative": "" }),
    );
    // directory 只列一层：仓库根下应当出现该文件的顶层目录。
    let top = file_name.split('/').next().unwrap_or_default().to_string();
    assert!(tree["directory"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["name"] == json!(top)));

    let page = agent.ok(
        "parity-io-page",
        "fileContent",
        json!({ "repo": repo, "relative": file_name, "offset": 0, "limit": page_lines }),
    );
    assert_eq!(
        page["content"]["lines"].as_array().unwrap().len(),
        page_lines,
        "每页行数必须按 limit 生效"
    );
    assert_eq!(page["content"]["lines"][0], json!(first_line));
    assert_eq!(page["content"]["hasMore"], json!(true));

    let snapshot = agent.ok(
        "parity-io-snapshot",
        "editSnapshot",
        json!({ "repo": repo, "relative": file_name }),
    );
    let digest = snapshot["edit"]["digest"].as_str().unwrap().to_string();
    let stale = agent.error_code(
        "parity-io-stale",
        "editSave",
        json!({
            "repo": repo,
            "operationId": "op-parity-io-stale",
            "stateToken": token,
            "path": file_name,
            "expectedDigest": "0".repeat(64),
            "content": "nope\n",
        }),
    );
    assert_eq!(stale, stale_code);
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join(&file_name)).unwrap(),
        "alpha\nsecond\n",
        "版本不符时不能覆盖文件"
    );
    let saved = agent.ok(
        "parity-io-save",
        "editSave",
        json!({
            "repo": repo,
            "operationId": "op-parity-io-save",
            "stateToken": token,
            "path": file_name,
            "expectedDigest": digest,
            "content": format!("{first_line}\n{saved_line}\n"),
        }),
    );
    assert_eq!(saved["receipt"]["state"], json!(receipt_state));
    assert!(std::fs::read_to_string(fixture.repo.join(&file_name))
        .unwrap()
        .contains(&saved_line));

    // 场景五：远端 PTY 往返（T3）。
    let scenario = find("remote-pty-round-trip");
    let expect = &scenario["expect"];
    let echoed = expect["echoed"].as_str().unwrap().to_string();
    let resize_rows = expect["resizeRows"].as_u64().unwrap();
    let unknown_code = expect["unknownCode"].as_str().unwrap().to_string();

    let mut agent = Agent::start_with(&fixture.state, &fixture.config, &[("SHELL", "/bin/sh")]);
    open(&mut agent, &repo);
    let profiles = agent.ok("parity-pty-profiles", "terminalProfiles", json!({ "repo": repo }));
    assert!(!profiles["profiles"].as_array().unwrap().is_empty());
    let profile = profiles["profiles"][0]["id"].as_str().unwrap().to_string();
    let created = agent.ok(
        "parity-pty-create",
        "terminalCreate",
        json!({ "repo": repo, "profile": profile }),
    );
    let session = created["terminal"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    agent.ok(
        "parity-pty-input",
        "terminalInput",
        json!({ "repo": repo, "sessionId": session, "data": format!("echo {echoed}\n") }),
    );
    let mut replayed = false;
    for _ in 0..100 {
        let attached = agent.ok(
            "parity-pty-attach",
            "terminalAttach",
            json!({ "repo": repo, "sessionId": session }),
        );
        if attached["terminal"]["output"]
            .as_str()
            .unwrap()
            .contains(&echoed)
        {
            replayed = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(replayed, "PTY 重放必须包含刚输入命令的输出");
    let resized = agent.ok(
        "parity-pty-resize",
        "terminalResize",
        json!({ "repo": repo, "sessionId": session, "rows": resize_rows, "cols": 100 }),
    );
    assert_eq!(resized["rows"], json!(resize_rows));
    let closed = agent.ok(
        "parity-pty-close",
        "terminalClose",
        json!({ "repo": repo, "sessionId": session }),
    );
    assert_eq!(closed["closed"], json!(true));
    let unknown = agent.error_code(
        "parity-pty-attach-closed",
        "terminalAttach",
        json!({ "repo": repo, "sessionId": session }),
    );
    assert_eq!(unknown, unknown_code);
}

// ---------- T3：文件树、正文、搜索、文档与保存回执 ----------

/// 文件树 / 正文 / 路径搜索 / 全文搜索必须返回与桌面同名的 DTO，
/// 并且按当前文件与当前页读取，二进制内容不冒充文本。
#[test]
fn file_tree_content_and_search_reuse_the_local_dtos() {
    let fixture = Fixture::new("io-read");
    fixture.init();
    fixture.write("notes/a.txt", "alpha\nneedle here\nthird\n");
    fixture.write("notes/b.txt", "beta\n");
    std::fs::create_dir_all(fixture.repo.join("assets")).unwrap();
    std::fs::write(fixture.repo.join("assets/logo.png"), [0x89, b'P', b'N', b'G', 0, 1, 2]).unwrap();
    fixture.commit_all("init");
    fixture.write("notes/a.txt", "alpha\nneedle here\nthird\nfourth\n");

    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();

    let tree = agent.ok("io-dir", "directory", json!({ "repo": repo, "relative": "" }));
    let entries = tree["directory"]["entries"].as_array().unwrap();
    assert!(entries
        .iter()
        .any(|entry| entry["name"] == json!("notes") && entry["kind"] == json!("directory")));
    assert_eq!(tree["directory"]["generation"], opened["generation"]);

    let first = agent.ok(
        "io-file",
        "fileContent",
        json!({ "repo": repo, "relative": "notes/a.txt", "offset": 0, "limit": 2 }),
    );
    assert_eq!(first["content"]["kind"], json!("text"));
    assert_eq!(first["content"]["lines"], json!(["alpha", "needle here"]));
    assert_eq!(first["content"]["hasMore"], json!(true));
    assert!(
        first["content"]["version"].as_str().is_some(),
        "正文必须带内容版本：{first}"
    );
    let next = first["content"]["nextOffset"].as_u64().unwrap();
    assert_eq!(next, 2);

    let second = agent.ok(
        "io-file-2",
        "fileContent",
        json!({ "repo": repo, "relative": "notes/a.txt", "offset": next, "limit": 2 }),
    );
    assert_eq!(second["content"]["lines"], json!(["third", "fourth"]));
    assert_eq!(second["content"]["hasMore"], json!(false));

    // 二进制文件不进文本页：类型必须明确，而不是给一段替换字符。
    let png = agent.ok(
        "io-png",
        "fileContent",
        json!({ "repo": repo, "relative": "assets/logo.png" }),
    );
    assert_ne!(png["content"]["kind"], json!("text"));
    assert!(png["content"]["lines"].as_array().unwrap().is_empty());

    let paths = agent.ok("io-path", "pathSearch", json!({ "repo": repo, "query": "b.txt" }));
    assert!(paths["search"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["path"] == json!("notes/b.txt")));

    let text = agent.ok(
        "io-text",
        "contentSearch",
        json!({ "repo": repo, "query": "needle", "scope": { "kind": "repository" } }),
    );
    assert!(
        text["search"]["matches"]
            .as_array()
            .unwrap()
            .iter()
            .any(|hit| hit["path"] == json!("notes/a.txt") && hit["line"] == json!(2)),
        "全文搜索必须给出行号：{text}"
    );

    // 审阅令牌只对当前内容给出 token，并带上内容版本。
    let review = agent.ok(
        "io-review",
        "reviewToken",
        json!({ "repo": repo, "relative": "notes/a.txt" }),
    );
    assert_eq!(review["token"]["state"], json!("current"));
    assert!(review["token"]["contentVersion"].as_str().is_some());
}

/// 1x1 透明 PNG：资源预览必须真的能识别成图片，而不是「二进制」。
const ONE_PIXEL_PNG: [u8; 67] = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
];

/// 资源预览、Markdown 来源与文档内嵌资源：同一份 `git::preview`/`git::document` 实现，
/// 版本不符按 stale 拒绝，外链只放行 http(s)。
#[test]
fn previews_and_markdown_sources_reuse_the_local_dtos() {
    let fixture = Fixture::new("io-document");
    fixture.init();
    fixture.write("README.md", "# Title\n\n![logo](assets/logo.png)\n");
    std::fs::create_dir_all(fixture.repo.join("assets")).unwrap();
    std::fs::write(fixture.repo.join("assets/logo.png"), ONE_PIXEL_PNG).unwrap();
    fixture.commit_all("init");

    let mut agent = fixture.agent();
    open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();

    let preview = agent.ok(
        "io-preview",
        "filePreview",
        json!({
            "repo": repo,
            "source": { "revision": "HEAD", "path": "assets/logo.png" },
        }),
    );
    assert_eq!(preview["preview"]["kind"], json!("image"));
    assert!(preview["preview"]["dataUrl"]
        .as_str()
        .unwrap()
        .starts_with("data:image/png"));

    let document = agent.ok(
        "io-doc",
        "document",
        json!({
            "repo": repo,
            "source": { "revision": "HEAD", "path": "README.md" },
            "mode": "document",
        }),
    );
    assert_eq!(document["document"]["kind"], json!("text"));
    let version = document["document"]["version"].as_str().unwrap().to_string();
    assert!(document["document"]["text"]
        .as_str()
        .unwrap()
        .contains("Title"));

    // 预期版本不符：必须拒绝，而不是把另一份内容当成这一份。
    let stale = agent.error_code(
        "io-doc-stale",
        "document",
        json!({
            "repo": repo,
            "source": { "revision": "HEAD", "path": "README.md" },
            "mode": "source",
            "expectedVersion": "0".repeat(64),
        }),
    );
    assert_eq!(stale, "stale");

    // 源码模式按页读取，仍然带同一个版本。
    let source = agent.ok(
        "io-doc-source",
        "document",
        json!({
            "repo": repo,
            "source": { "revision": "HEAD", "path": "README.md" },
            "mode": "source",
            "expectedVersion": version,
            "limit": 1,
        }),
    );
    assert_eq!(source["document"]["kind"], json!("text"));
    assert_eq!(source["document"]["lines"].as_array().unwrap().len(), 1);

    // 文档内嵌资源走同一份资源预览 DTO。
    let resource = agent.ok(
        "io-doc-resource",
        "documentResource",
        json!({
            "repo": repo,
            "source": { "revision": "HEAD", "path": "assets/logo.png" },
        }),
    );
    assert_eq!(resource["resource"]["kind"], json!("image"));

    // 外链图片只接受 http(s)：本机路径与其它协议一律拒绝。
    let refused = agent.error_code(
        "io-remote-image",
        "documentRemoteImage",
        json!({ "repo": repo, "url": "file:///etc/passwd" }),
    );
    assert_eq!(refused, "document_url");
}

/// 保存必须带预期内容版本：版本不符时一个字都不写；吻合时留 completed 回执，
/// 同一 operationId 重放只回原回执。
#[test]
fn saving_a_file_requires_the_expected_content_version() {
    let fixture = Fixture::new("io-save");
    fixture.init();
    fixture.write("notes/a.txt", "alpha\n");
    fixture.commit_all("init");

    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();
    let token = opened["stateToken"].as_str().unwrap().to_string();

    let snapshot = agent.ok(
        "io-edit",
        "editSnapshot",
        json!({ "repo": repo, "relative": "notes/a.txt" }),
    );
    assert_eq!(snapshot["edit"]["editable"], json!(true));
    let digest = snapshot["edit"]["digest"].as_str().unwrap().to_string();

    let stale = agent.error_code(
        "io-save-stale",
        "editSave",
        json!({
            "repo": repo,
            "operationId": "op-io-save-stale",
            "stateToken": token,
            "path": "notes/a.txt",
            "expectedDigest": "0".repeat(64),
            "content": "overwritten\n",
        }),
    );
    assert_eq!(stale, "edit_conflict");
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("notes/a.txt")).unwrap(),
        "alpha\n",
        "版本不符时不能覆盖原文件"
    );

    let saved = agent.ok(
        "io-save",
        "editSave",
        json!({
            "repo": repo,
            "operationId": "op-io-save-0001",
            "stateToken": token,
            "path": "notes/a.txt",
            "expectedDigest": digest,
            "content": "alpha\nsaved\n",
        }),
    );
    assert_eq!(saved["receipt"]["state"], json!("completed"));
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("notes/a.txt")).unwrap(),
        "alpha\nsaved\n"
    );
    let new_digest = saved["edit"]["digest"].as_str().unwrap().to_string();
    assert_ne!(new_digest, digest, "保存后必须给出新的内容版本");
    // 回执可核实：同一个操作 ID 再查一次仍是 completed，并带新的 HEAD 解释。
    let receipt = agent.ok(
        "io-save-receipt",
        "receipt",
        json!({ "repo": repo, "operationId": "op-io-save-0001" }),
    );
    assert_eq!(receipt["receipt"]["state"], json!("completed"));
    assert_eq!(receipt["receipt"]["op"], json!("editSave"));

    let replay = agent.ok(
        "io-save-replay",
        "editSave",
        json!({
            "repo": repo,
            "operationId": "op-io-save-0001",
            // 重放必须逐字段相同（含 stateToken）：摘要不同就是另一个请求。
            "stateToken": token,
            "path": "notes/a.txt",
            "expectedDigest": digest,
            "content": "alpha\nsaved\n",
        }),
    );
    assert_eq!(replay["replayed"], json!(true));
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("notes/a.txt")).unwrap(),
        "alpha\nsaved\n",
        "重放不能再写一次"
    );
}

/// 目录与文件的创建、复制、移动、删除都走同一套写入顺序，并各自留下回执。
#[test]
fn folder_writes_create_copy_move_and_delete_leave_receipts() {
    let fixture = Fixture::new("io-folder");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");

    let mut agent = fixture.agent();
    open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();
    let token = agent.ok("io-folder-open", "status", json!({ "repo": repo }))["stateToken"]
        .as_str()
        .unwrap()
        .to_string();

    let directory = agent.ok(
        "io-mkdir",
        "createEntry",
        json!({
            "repo": repo,
            "operationId": "op-io-mkdir-0001",
            "stateToken": token,
            "path": "docs",
            "kind": "directory",
        }),
    );
    assert!(fixture.repo.join("docs").is_dir());
    assert_eq!(directory["receipt"]["state"], json!("completed"));

    let created = agent.ok(
        "io-mkfile",
        "createEntry",
        json!({
            "repo": repo,
            "operationId": "op-io-mkfile-0001",
            "stateToken": token_of(&directory),
            "path": "docs/note.md",
            "kind": "file",
        }),
    );
    assert!(fixture.repo.join("docs/note.md").exists());
    assert!(created["snapshot"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|file| file["path"] == json!("docs/note.md")));

    let moved = agent.ok(
        "io-move",
        "moveEntry",
        json!({
            "repo": repo,
            "operationId": "op-io-move-0001",
            "stateToken": token_of(&created),
            "source": "docs/note.md",
            "target": "docs/moved.md",
        }),
    );
    assert!(!fixture.repo.join("docs/note.md").exists());
    assert!(fixture.repo.join("docs/moved.md").exists());

    let copied = agent.ok(
        "io-copy",
        "copyEntry",
        json!({
            "repo": repo,
            "operationId": "op-io-copy-0001",
            "stateToken": token_of(&moved),
            "source": "docs/moved.md",
            "target": "docs/copy.md",
        }),
    );
    assert!(fixture.repo.join("docs/copy.md").exists());

    // 显式永久删除：没有回收站时不谎报，也不隐式切换模式。
    let deleted = agent.ok(
        "io-delete",
        "deleteEntries",
        json!({
            "repo": repo,
            "operationId": "op-io-delete-0001",
            "stateToken": token_of(&copied),
            "relatives": ["docs/copy.md"],
            "permanent": true,
        }),
    );
    assert!(!fixture.repo.join("docs/copy.md").exists());
    assert_eq!(deleted["delete"]["deleted"], json!(["docs/copy.md"]));
    assert_eq!(deleted["receipt"]["state"], json!("completed"));
}

/// 路径越界必须被共享的路径校验挡住，不能因为走远端就放过 `..`。
#[test]
fn file_writes_stay_inside_the_worktree() {
    let fixture = Fixture::new("io-boundary");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");

    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();
    let token = opened["stateToken"].as_str().unwrap().to_string();
    let code = agent.error_code(
        "io-escape",
        "editSave",
        json!({
            "repo": repo,
            "operationId": "op-io-escape-0001",
            "stateToken": token,
            "path": "../outside.txt",
            "expectedDigest": "0".repeat(64),
            "content": "x\n",
        }),
    );
    assert!(
        !code.is_empty(),
        "越界路径必须被拒绝，而不是写入工作树之外"
    );
    assert!(!fixture.root.path().join("outside.txt").exists());
}

// ---------- T3：远端变化事件 ----------

/// 变化事件带仓库键与单调序号，突发写入被合并，游标能对齐且不补发历史。
#[test]
fn change_events_carry_repo_and_merge_bursts() {
    let fixture = Fixture::new("io-events");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");

    let mut agent = fixture.agent();
    let opened = open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();
    assert_eq!(
        opened["watchDegraded"],
        json!(false),
        "本机夹具应能 watch：{opened}"
    );

    for index in 0..5 {
        fixture.write(&format!("burst-{index}.txt"), "x\n");
        std::thread::sleep(Duration::from_millis(10));
    }

    // 通知帧必须自己到达：不靠任何轮询请求，并且带仓库与序号。
    let frame = agent.read_event("change");
    assert_eq!(frame["repo"], json!(repo));
    let first_seq = frame["seq"].as_u64().expect("事件必须带序号");
    assert!(first_seq >= 1);

    let cursor = agent.ok("io-ev-cursor", "events", json!({ "repo": repo, "after": 0 }));
    assert_eq!(cursor["watchDegraded"], json!(false));
    let events = cursor["events"].as_array().unwrap();
    assert!(!events.is_empty(), "游标必须能读到已发生的失效事件");
    assert!(
        events.len() < 5,
        "一次突发写入必须被合并，实际 {} 条",
        events.len()
    );
    assert!(events
        .iter()
        .any(|event| event["seq"] == json!(first_seq)));
    for pair in events.windows(2) {
        assert!(
            pair[1]["seq"].as_u64().unwrap() > pair[0]["seq"].as_u64().unwrap(),
            "事件序号必须严格递增"
        );
    }

    let watermark = cursor["seq"].as_u64().unwrap();
    let drained = agent.ok(
        "io-ev-drained",
        "events",
        json!({ "repo": repo, "after": watermark }),
    );
    assert_eq!(drained["events"], json!([]));
    assert_eq!(drained["seq"], json!(watermark));
    // 未来的序号不补发历史：只说明当前水位。
    let ahead = agent.ok(
        "io-ev-ahead",
        "events",
        json!({ "repo": repo, "after": watermark + 10 }),
    );
    assert_eq!(ahead["events"], json!([]));
}

/// watch 不可用时如实降级：没有事件，只有显式刷新能拿到新状态。
#[test]
fn watch_unavailable_degrades_to_explicit_refresh_only() {
    let fixture = Fixture::new("io-events-degraded");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");

    let mut agent =
        Agent::start_with(&fixture.state, &fixture.config, &[("TWIGLANE_AGENT_DISABLE_WATCH", "1")]);
    let opened = open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();
    assert_eq!(opened["watchDegraded"], json!(true));

    fixture.write("after.txt", "x\n");
    std::thread::sleep(Duration::from_millis(200));
    let cursor = agent.ok("io-deg-cursor", "events", json!({ "repo": repo, "after": 0 }));
    assert_eq!(cursor["watchDegraded"], json!(true));
    assert_eq!(cursor["events"], json!([]));
    assert_eq!(cursor["seq"], json!(0));

    // 降级时唯一的状态路径是显式刷新：它仍然要看到新文件。
    let state = agent.ok("io-deg-status", "status", json!({ "repo": repo }));
    assert!(state["snapshot"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|file| file["path"] == json!("after.txt")));
}

// ---------- T3：远端 PTY 会话 ----------

/// 创建 → 输入 → 输出帧（有界、带序号）→ 附着重放 → resize → 退出 → 重启 → 关闭。
#[test]
fn remote_pty_supports_create_attach_input_resize_restart_and_close() {
    let fixture = Fixture::new("io-pty");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");

    let mut agent = Agent::start_with(&fixture.state, &fixture.config, &[("SHELL", "/bin/sh")]);
    open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();

    let profiles = agent.ok("pty-profiles", "terminalProfiles", json!({ "repo": repo }));
    let profile = profiles["profiles"][0]["id"]
        .as_str()
        .expect("远端必须探测到至少一个终端类型")
        .to_string();
    let created = agent.ok(
        "pty-create",
        "terminalCreate",
        json!({ "repo": repo, "profile": profile }),
    );
    let session = created["terminal"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(created["terminal"]["running"], json!(true));
    assert_eq!(created["terminal"]["repoPath"], json!(repo));

    // 输入后读输出帧：每帧都带仓库、会话与单调序号，并且有大小上限。
    agent.send(
        "pty-input",
        "terminalInput",
        json!({ "repo": repo, "sessionId": session, "data": "echo parity-pty\n" }),
    );
    let mut seen = String::new();
    let mut largest = 0;
    let mut last_seq = 0;
    let mut frames = 0;
    loop {
        let value = agent.next_line();
        if value["event"] == json!("terminalOutput") {
            assert_eq!(value["repo"], json!(repo));
            assert_eq!(value["sessionId"], json!(session));
            let seq = value["seq"].as_u64().expect("输出帧必须带序号");
            assert!(seq >= last_seq, "输出序号必须单调不倒退");
            last_seq = seq;
            let data = value["data"].as_str().unwrap_or_default();
            largest = largest.max(data.len());
            seen.push_str(data);
            if seen.contains("parity-pty") {
                break;
            }
        }
        frames += 1;
        assert!(frames < 2000, "输出帧过多，可能没有合并且没有边界");
    }
    assert!(largest <= 64 * 1024, "单帧输出必须有界，实际 {largest}");

    let attached = agent.ok(
        "pty-attach",
        "terminalAttach",
        json!({ "repo": repo, "sessionId": session }),
    );
    assert!(attached["terminal"]["output"]
        .as_str()
        .unwrap()
        .contains("parity-pty"));
    assert_eq!(attached["terminal"]["replayTruncated"], json!(false));
    assert!(attached["terminal"]["seq"].as_u64().unwrap() >= 1);
    assert!(attached["terminal"]["output"].as_str().unwrap().len() <= 512 * 1024);

    let resized = agent.ok(
        "pty-resize",
        "terminalResize",
        json!({ "repo": repo, "sessionId": session, "rows": 30, "cols": 100 }),
    );
    assert_eq!(resized["rows"], json!(30));

    // 大量输出：帧仍然有界，且一个字节都不丢。
    agent.send(
        "pty-bulk",
        "terminalInput",
        json!({
            "repo": repo,
            "sessionId": session,
            "data": "i=0; while [ $i -lt 3000 ]; do echo line$i; i=$((i+1)); done; echo __PARITY_DONE__\n",
        }),
    );
    let mut bulk = String::new();
    let mut largest = 0;
    let mut guard = 0;
    loop {
        let value = agent.next_line();
        if value["event"] == json!("terminalOutput") {
            let data = value["data"].as_str().unwrap_or_default();
            largest = largest.max(data.len());
            bulk.push_str(data);
            // 只在最后一行真的到达时才收尾：命令本身的回显里也有这个标记。
            if bulk.contains("line2999") {
                break;
            }
        }
        guard += 1;
        assert!(guard < 5000, "大量输出时的帧数没有收敛");
    }
    assert!(largest <= 64 * 1024, "大量输出时单帧仍须有界");
    assert!(bulk.contains("line2999"), "终端输出不能静默丢字节");

    // 退出后会话保留输出但报告为已结束。
    agent.send(
        "pty-exit",
        "terminalInput",
        json!({ "repo": repo, "sessionId": session, "data": "exit\n" }),
    );
    let mut exited = false;
    for _ in 0..100 {
        let list = agent.ok("pty-list", "terminalList", json!({ "repo": repo }));
        let entry = list["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["sessionId"] == json!(session))
            .cloned()
            .expect("会话在退出后仍保留");
        if entry["running"] == json!(false) {
            exited = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(exited, "shell 退出后会话必须报告为已结束");

    let restarted = agent.ok(
        "pty-restart",
        "terminalRestart",
        json!({ "repo": repo, "sessionId": session }),
    );
    let replacement = restarted["terminal"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(replacement, session, "重启必须得到新的会话 id");
    assert_eq!(restarted["terminal"]["running"], json!(true));
    assert_eq!(restarted["terminal"]["output"], json!(""));

    let closed = agent.ok(
        "pty-close",
        "terminalClose",
        json!({ "repo": repo, "sessionId": replacement }),
    );
    assert_eq!(closed["closed"], json!(true));
    let gone = agent.error_code(
        "pty-attach-closed",
        "terminalAttach",
        json!({ "repo": repo, "sessionId": replacement }),
    );
    assert_eq!(gone, "terminal_unknown");
}

/// 断线后重连：旧 PTY 已经不存在，必须明确报未知，绝不假装还活着。
#[test]
fn a_reconnected_agent_reports_previous_pty_sessions_as_unknown() {
    let fixture = Fixture::new("io-pty-reconnect");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");
    let repo = fixture.repo_str();

    let session = {
        let mut agent =
            Agent::start_with(&fixture.state, &fixture.config, &[("SHELL", "/bin/sh")]);
        open(&mut agent, &repo);
        let created = agent.ok("re-create", "terminalCreate", json!({ "repo": repo }));
        created["terminal"]["sessionId"]
            .as_str()
            .unwrap()
            .to_string()
        // agent 在这里被终止：等同于连接断开。
    };

    let mut agent = Agent::start_with(&fixture.state, &fixture.config, &[("SHELL", "/bin/sh")]);
    open(&mut agent, &repo);
    let code = agent.error_code(
        "re-attach",
        "terminalAttach",
        json!({ "repo": repo, "sessionId": session }),
    );
    assert_eq!(code, "terminal_unknown", "重连不得假装原 PTY 仍存活");
}

/// 任何 op 都不接受执行字段：普通 RPC 不能执行程序，终端只接受 PTY 输入。
#[test]
fn every_op_rejects_execution_fields() {
    let fixture = Fixture::new("io-exec");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");

    let mut agent = fixture.agent();
    open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();
    let cases = [
        ("status", json!({ "repo": repo, "command": "sh -c id" })),
        ("open", json!({ "path": repo, "program": "/bin/sh" })),
        (
            "terminalInput",
            json!({ "repo": repo, "sessionId": "nope", "data": "x", "args": ["-l"] }),
        ),
        ("terminalCreate", json!({ "repo": repo, "shell": "/bin/zsh" })),
    ];
    for (index, (op, fields)) in cases.iter().enumerate() {
        let code = agent.error_code(&format!("exec-{index}"), op, fields.clone());
        assert_eq!(code, "invalid_request", "{op} 带执行字段必须被拒绝");
    }
    // 终端输入本身仍然可用（这里只验证它没被执行字段检查误伤）。
    let missing = agent.error_code(
        "exec-terminal-ok",
        "terminalInput",
        json!({ "repo": repo, "sessionId": "nope", "data": "x" }),
    );
    assert_eq!(missing, "terminal_unknown");
}

/// 单帧上限是硬边界：超过就整条拒绝，不执行也不截断。
#[test]
fn an_oversized_request_is_rejected_without_execution() {
    let fixture = Fixture::new("io-huge");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");

    let mut agent = fixture.agent();
    open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();
    let huge = "x".repeat(9 * 1024 * 1024);
    let frame = json!({
        "v": 2,
        "id": "huge-1",
        "op": "commit",
        "repo": repo,
        "operationId": "op-huge-0001",
        "stateToken": "0".repeat(64),
        "message": huge,
    })
    .to_string();
    agent.stdin.write_all(frame.as_bytes()).unwrap();
    agent.stdin.write_all(b"\n").unwrap();
    agent.stdin.flush().unwrap();
    // 超限行在解析前就被拒绝，按占位符 `0` 找到响应，跳过仓库事件。
    let response = agent.read_id("0");
    assert_eq!(response["ok"], json!(false));
    assert_eq!(response["error"]["code"], json!("request_too_large"));
    assert_eq!(response["id"], json!("0"));

    // 读取侧的围栏必须只丢掉这一行：后面的正常请求照常执行。
    // 超限行和紧随其后的请求写在同一次写入里，覆盖「换行处恢复切行」这条路径。
    let follow = json!({ "v": 2, "id": "after-huge", "op": "status", "repo": repo }).to_string();
    let mut burst = Vec::with_capacity(frame.len() + follow.len() + 2);
    burst.extend_from_slice(frame.as_bytes());
    burst.push(b'\n');
    burst.extend_from_slice(follow.as_bytes());
    burst.push(b'\n');
    agent.stdin.write_all(&burst).unwrap();
    agent.stdin.flush().unwrap();
    let mut rejected = 0;
    let mut answered = false;
    for _ in 0..8 {
        let value = agent.next_line();
        if value["error"]["code"] == json!("request_too_large") {
            rejected += 1;
        }
        if value["id"] == json!("after-huge") && value["ok"] == json!(true) {
            answered = true;
        }
        if rejected >= 1 && answered {
            break;
        }
    }
    assert_eq!(rejected, 1, "超限行只应产生一条拒绝");
    assert!(answered, "超限行之后的正常请求必须照常执行");
}

/// 游标是客户端给的整数：`u64::MAX` 只能得到「没有可补发的事件」，不能让进程算崩。
///
/// 旧实现在 `after + 1` 处溢出：调试构建直接 panic，release 的 `panic = "abort"` 会让
/// 整个 agent 退出，一次越界游标就能断开所有人的连接。
#[test]
fn an_out_of_range_event_cursor_is_answered_without_panicking() {
    let fixture = Fixture::new("io-cursor-max");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");

    let mut agent = fixture.agent();
    open(&mut agent, &fixture.repo_str());
    let repo = fixture.repo_str();

    // 先制造一条真实事件：让游标查询真的走到「有保留事件」的分支，而不是空窗口。
    // watch 的首次投递有延迟，这里轮询水位而不是赌一个固定睡眠。
    let mut first = Value::Null;
    for index in 0..40 {
        fixture.write(&format!("b-{index}.txt"), "b\n");
        std::thread::sleep(Duration::from_millis(50));
        let reply = agent.ok("cursor-0", "events", json!({ "repo": repo, "after": 0 }));
        if reply["seq"].as_u64().unwrap() >= 1 {
            first = reply;
            break;
        }
    }
    assert!(
        first["seq"].as_u64().unwrap() >= 1,
        "应至少记录一条变化事件"
    );
    assert_eq!(first["resync"], json!(false));
    assert!(
        !first["events"].as_array().unwrap().is_empty(),
        "游标应读到失效事件"
    );

    for (id, after) in [
        ("cursor-max", u64::MAX),
        ("cursor-max-minus-one", u64::MAX - 1),
    ] {
        let reply = agent.ok(id, "events", json!({ "repo": repo, "after": after }));
        // 游标跑到水位之前等于一代无效序号：只能整体重读，不能补发。
        assert_eq!(reply["resync"], json!(true), "after={after} 应回 resync");
        assert_eq!(reply["events"], json!([]), "after={after} 不应补发历史");
        assert_eq!(reply["seq"], first["seq"], "水位不该被游标查询改动");
    }

    // 进程仍然活着：后续请求照常可用（abort 会让这里读不到回答）。
    let state = agent.ok("cursor-max-status", "status", json!({ "repo": repo }));
    assert!(state["snapshot"]["files"].is_array());
}

/// 关闭是跨仓库可达的破坏性操作：用另一个仓库的 `repo` 关不掉这里的 shell。
#[test]
fn terminal_close_cannot_reach_a_session_from_another_repository() {
    let fixture = Fixture::new("io-pty-cross");
    fixture.init();
    fixture.write("a.txt", "a\n");
    fixture.commit_all("init");

    let repo_a = fixture.repo_str();
    let base = std::fs::canonicalize(fixture.root.path()).unwrap();
    let other = base.join("repo-b");
    std::fs::create_dir_all(&other).unwrap();
    git(&other, &fixture.config, &["init", "-b", "main"]);
    let repo_b = other.to_string_lossy().into_owned();
    assert_ne!(repo_a, repo_b);

    let mut agent = Agent::start_with(&fixture.state, &fixture.config, &[("SHELL", "/bin/sh")]);
    open(&mut agent, &repo_a);
    let session = agent.ok("cross-create", "terminalCreate", json!({ "repo": repo_a }))["terminal"]
        ["sessionId"]
        .as_str()
        .expect("创建会话应返回 id")
        .to_string();

    // 切到另一个仓库：A 的会话不该再从 B 的视角被操作。
    open(&mut agent, &repo_b);
    let refused = agent.error_code(
        "cross-close",
        "terminalClose",
        json!({ "repo": repo_b, "sessionId": session }),
    );
    assert_eq!(refused, "unknown_repo", "跨仓库关闭必须被拒绝");
    for (op, fields) in [
        (
            "terminalAttach",
            json!({ "repo": repo_b, "sessionId": session }),
        ),
        (
            "terminalInput",
            json!({ "repo": repo_b, "sessionId": session, "data": "echo hijack\n" }),
        ),
        (
            "terminalResize",
            json!({ "repo": repo_b, "sessionId": session, "rows": 20, "cols": 60 }),
        ),
        (
            "terminalRestart",
            json!({ "repo": repo_b, "sessionId": session }),
        ),
    ] {
        assert_eq!(
            agent.error_code("cross-op", op, fields),
            "unknown_repo",
            "{op} 不得跨仓库命中会话"
        );
    }

    // 回到 A：误用之后会话仍然存活，输入与输出都还在。
    open(&mut agent, &repo_a);
    let attached = agent.ok(
        "cross-attach-a",
        "terminalAttach",
        json!({ "repo": repo_a, "sessionId": session }),
    );
    assert_eq!(
        attached["terminal"]["running"],
        json!(true),
        "会话不能被跨仓库关掉"
    );
    let input = agent.ok(
        "cross-input-a",
        "terminalInput",
        json!({ "repo": repo_a, "sessionId": session, "data": "echo still-alive\n" }),
    );
    assert_eq!(input["accepted"], json!(true));

    // A 自己仍然关得掉：拒绝针对的是归属，不是关闭本身。
    let closed = agent.ok(
        "cross-close-a",
        "terminalClose",
        json!({ "repo": repo_a, "sessionId": session }),
    );
    assert_eq!(closed["closed"], json!(true));
}
