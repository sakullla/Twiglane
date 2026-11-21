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

    /// 发一条请求并读到同一 id 的响应；通道是多路的，其他 id 的响应被丢弃。
    fn call(&mut self, id: &str, op: &str, fields: Value) -> Value {
        let mut body = fields;
        let object = body.as_object_mut().expect("字段必须是对象");
        object.insert("v".into(), json!(2));
        object.insert("id".into(), json!(id));
        object.insert("op".into(), json!(op));
        let frame = body.to_string();
        self.stdin.write_all(frame.as_bytes()).expect("写请求");
        self.stdin.write_all(b"\n").expect("写换行");
        self.stdin.flush().expect("刷新请求");
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
