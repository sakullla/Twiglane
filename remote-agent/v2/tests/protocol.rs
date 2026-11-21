//! v2 协议的黑盒回归：真实 Git 仓库 + 真实进程，只通过标准输入输出对话。
//!
//! 这些用例覆盖 T1 的验收：打开一次拿到完整状态摘要、差异按当前文件和游标续页、
//! stage/unstage/按块写入/commit 在真实仓库上成功并留下可查询回执，以及陈旧状态、
//! 跨进程写锁和未知结果都不会被当成成功。

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};
use tempfile::TempDir;

struct Agent {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Agent {
    fn start(state_home: &Path, config: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_twiglane-agent-v2"))
            .arg("--stdio")
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
        let stdout = BufReader::new(child.stdout.take().expect("stdout"));
        Self {
            child,
            stdin,
            stdout,
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
            let mut line = String::new();
            let read = self.stdout.read_line(&mut line).expect("读响应");
            assert!(read > 0, "agent 在回答之前关闭了输出");
            let value: Value = serde_json::from_str(&line).expect("响应必须是 JSON 行");
            assert_eq!(value["v"], json!(2), "响应必须声明 v2");
            if value["id"] == json!(id) {
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
        let base = std::fs::canonicalize(root.path()).unwrap();
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
    for expected in ["open", "status", "diff", "stage", "unstage", "patch", "commit", "receipt"] {
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
    let mut line = String::new();
    agent.stdout.read_line(&mut line).unwrap();
    let rejected: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(rejected["ok"], json!(false));
    assert_eq!(rejected["error"]["code"], json!("unsupported_protocol"));
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
    assert_eq!(opened["watchDegraded"], json!(true));

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
        let mut line = String::new();
        assert!(agent.stdout.read_line(&mut line).unwrap() > 0);
        let value: Value = serde_json::from_str(&line).unwrap();
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
}




