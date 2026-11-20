"""Black-box JSONL tests against disposable Git worktrees and separate processes."""
import base64
import concurrent.futures
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid
from pathlib import Path

AGENT = Path(__file__).resolve().parents[2] / "remote-agent" / "agent"


class Client:
    def __init__(self, env):
        self.process = subprocess.Popen([str(AGENT), "--stdio"], env=env, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE)
        self.seq = 0

    def send(self, op, **fields):
        self.seq += 1
        message = {"id": str(self.seq), "op": op, "v": 1, **fields}
        self.process.stdin.write(json.dumps(message).encode() + b"\n")
        self.process.stdin.flush()
        return message["id"]

    def receive(self):
        return json.loads(self.process.stdout.readline())

    def call(self, op, **fields):
        request_id = self.send(op, **fields)
        response = self.receive()
        assert response["id"] == request_id
        return response

    def result(self, op, **fields):
        reply = self.call(op, **fields)
        assert reply["ok"], reply
        return reply["result"]

    def close(self):
        self.process.stdin.close()
        self.process.wait(timeout=10)
        self.process.stdout.close()


class AgentTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.env = dict(os.environ, HOME=str(self.tmp), XDG_STATE_HOME=str(self.tmp / "state"),
                        GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
        self.root = self.tmp / "repo with spaces"
        self.root.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Twiglane Test")
        self.git("config", "user.email", "test@example.invalid")
        (self.root / "tracked").write_text("start\n")
        self.git("add", "--", "tracked")
        self.git("commit", "-qm", "initial")
        self.client = self.connect()

    def connect(self):
        client = Client(self.env)
        self.addCleanup(client.close)
        return client

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args], env=self.env).decode().strip()

    def open(self, **kwargs):
        return self.client.result("open", path=str(self.root), **kwargs)

    def meta(self, client=None):
        snapshot = (client or self.client).result("open", path=str(self.root))
        return {key: snapshot[key] for key in ("repo", "generation")}

    def test_unborn_linked_and_invalid_worktrees(self):
        empty = self.tmp / "empty"
        subprocess.run(["git", "init", "-q", str(empty)], check=True)
        state = self.client.result("open", path=str(empty))
        self.assertIsNone(state["head"])
        (empty / "-file").write_text("one")
        snap = self.client.result("status", repo=state["repo"])
        for op in ("stage", "unstage"):
            result = self.client.result(op, repo=snap["repo"], generation=snap["generation"],
                                        paths=["-file"], operationId=str(uuid.uuid4()))
            self.assertEqual(result["state"], "completed")
            snap = self.client.result("status", repo=snap["repo"])
        self.assertEqual(snap["files"], [{"xy": "??", "path": "-file"}])
        root_state = self.open()
        linked = self.tmp / "linked"
        self.git("worktree", "add", "-qb", "linked", str(linked))
        linked_state = self.client.result("open", path=str(linked))
        self.assertNotEqual(root_state["repo"], linked_state["repo"])
        self.assertEqual(self.client.call("status", repo=root_state["repo"])["error"]["code"], "target_changed")
        self.assertFalse(self.client.call("open", path=str(self.tmp))["ok"])
        self.assertEqual(self.client.call("status", repo=linked_state["repo"])["error"]["code"], "no_worktree")

    def test_snapshot_task_net_diff_and_literal_paths(self):
        initial = self.git("rev-parse", "HEAD")
        path = "file :[a]* 空.txt"
        (self.root / path).write_text("selected only\n")
        (self.root / "tracked").write_text("committed delta\n")
        self.git("commit", "-qam", "secondary")
        snap = self.open(baseline=initial)
        self.assertEqual(set(snap["reviewFiles"]), {path, "tracked"})
        for selected, expected in [(path, "selected only"), ("tracked", "committed delta")]:
            patch = self.client.result("diff", repo=snap["repo"], generation=snap["generation"],
                                       view="task", path=selected, baseline=initial)
            self.assertIn(expected, base64.b64decode(patch["data"]).decode())
        bad = self.client.call("diff", repo=snap["repo"], generation=snap["generation"],
                               view="unstaged", path="../secret")
        self.assertEqual(bad["error"]["code"], "invalid_path")
        self.assertFalse(self.client.call("open", path=str(self.root), baseline="HEAD:tracked")["ok"])

    def test_baseline_compares_recreated_untracked_file_to_its_original_blob(self):
        initial = self.git("rev-parse", "HEAD")
        self.git("rm", "--quiet", "tracked")
        self.git("commit", "-qm", "remove")
        (self.root / "tracked").write_text("replacement\n")
        snap = self.open(baseline=initial)
        self.assertEqual(snap["reviewFiles"], ["tracked"])
        page = self.client.result("diff", repo=snap["repo"], generation=snap["generation"],
                                  view="task", path="tracked", baseline=initial)
        patch = base64.b64decode(page["data"]).decode()
        self.assertIn("-start\n+replacement", patch)
        (self.root / "tracked").write_text("start\n")
        self.assertEqual(self.open(baseline=initial)["reviewFiles"], [])
        self.assertEqual(self.git("status", "--porcelain"), "?? tracked")

    def test_new_selection_supersedes_diff_while_git_is_computing(self):
        tools = self.tmp / "tools"
        tools.mkdir()
        git_path = shutil.which("git")
        marker = self.tmp / "slow-start"
        # Delay only one real Git diff process. First request must complete as
        # superseded without waiting for the blocked process or its first byte.
        wrapper = tools / "git"
        wrapper.write_text("#!/usr/bin/env python3\nimport os,sys,time\n"
                           "if '--no-index' in sys.argv and sys.argv[-1]=='large':\n"
                           f"    open({str(marker)!r},'w').close()\n    time.sleep(20)\n"
                           f"os.execv({git_path!r}, [{git_path!r}, *sys.argv[1:]])\n")
        wrapper.chmod(0o755)
        (self.root / "large").write_text("slow diff\n")
        (self.root / "small").write_text("fast diff\n")
        self.env["PATH"] = str(tools) + os.pathsep + self.env["PATH"]
        client = self.connect()
        fields = self.meta(client)
        slow = client.send("diff", **fields, path="large", view="unstaged")
        deadline = time.monotonic() + 5
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(marker.exists())
        start = time.monotonic()
        fast = client.send("diff", **fields, path="small", view="unstaged")
        first, second = client.receive(), client.receive()
        self.assertLess(time.monotonic() - start, 5)
        self.assertEqual((first["id"], first["error"]["code"]), (slow, "superseded"))
        self.assertEqual(second["id"], fast)
        self.assertIn(b"+fast diff", base64.b64decode(second["result"]["data"]))

    def test_paged_diff_invalidated_on_switch_or_external_change(self):
        (self.root / "large").write_text("a line of output\n" * 5000)
        (self.root / "small").write_text("tiny\n")
        current = self.meta()
        args = {**current, "view": "unstaged", "path": "large"}
        first = self.client.result("diff", **args)
        data = base64.b64decode(first["data"])
        self.assertEqual(len(data), 16384)
        second = self.client.result("diff", **args, cursor=first["nextCursor"])
        self.assertNotEqual(second["nextCursor"], first["nextCursor"])
        self.client.result("diff", **current, path="small", view="unstaged")
        self.assertEqual(self.client.call("diff", **args, cursor=second["nextCursor"])["error"]["code"], "stale_cursor")
        first = self.client.result("diff", **args)
        (self.root / "large").write_text("replacement\n")
        self.assertEqual(self.client.call("diff", **args, cursor=first["nextCursor"])["error"]["code"], "stale_state")

    def test_write_receipt_reconnect_and_external_changes(self):
        (self.root / "tracked").write_text("committed\n")
        (self.root / ":*[odd]").write_text("unstaged\n")
        snap = self.meta()
        for op, paths in [("stage", ["tracked", ":*[odd]"]), ("unstage", [":*[odd]"])]:
            receipt = self.client.result(op, **snap, operationId=str(uuid.uuid4()), paths=paths)
            self.assertEqual(receipt["state"], "completed")
            snap["generation"] = receipt["generation"]
        operation = str(uuid.uuid4())
        # Discard the output pipe before any reply is observed. The process
        # still receives the complete request, executes it and persists a receipt.
        detached = subprocess.Popen([str(AGENT)], env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            detached.stdin.write((json.dumps({"v": 1, "id": "open", "op": "open", "path": str(self.root)}) + "\n").encode())
            detached.stdin.flush()
            self.assertTrue(json.loads(detached.stdout.readline())["ok"])
            detached.stdout.close()
            commit = {"message": "intended", "operationId": operation, **snap}
            detached.stdin.write((json.dumps({"v": 1, "id": "lost", "op": "commit", **commit}) + "\n").encode())
            detached.stdin.close()
            detached.wait(10)
        finally:
            if detached.poll() is None:
                detached.kill()
                detached.wait()
        fresh = self.connect()
        reopened = self.meta(fresh)
        recorded = fresh.result("receipt", repo=reopened["repo"], operationId=operation)
        self.assertEqual(recorded["state"], "completed", recorded)
        self.assertEqual(recorded["head"], self.git("rev-parse", "HEAD"))
        self.assertEqual(self.git("show", "--format=", "--name-only", "HEAD"), "tracked")
        self.assertEqual(fresh.result("commit", **commit), recorded)
        self.assertEqual(self.git("rev-list", "--count", "HEAD"), "2")
        self.assertEqual(fresh.call("commit", **{**commit, "message": "different"})["error"]["code"], "operation_conflict")
        self.git("commit", "--allow-empty", "-qm", "external")
        self.assertEqual(fresh.result("receipt", repo=reopened["repo"], operationId=operation)["state"], "unknown")

    def test_concurrent_clients_only_one_can_use_original_generation(self):
        (self.root / "tracked").write_text("pending\n")
        self.git("add", "--", "tracked")
        other = self.connect()
        meta = self.meta()
        self.assertEqual(meta, self.meta(other))
        def commit(client):
            return client.call("commit", **meta, message="one", operationId=str(uuid.uuid4()))
        with concurrent.futures.ThreadPoolExecutor() as pool:
            results = list(pool.map(commit, [self.client, other]))
        self.assertEqual(sorted(result["ok"] for result in results), [False, True])
        self.assertEqual(next(r for r in results if not r["ok"])["error"]["code"], "stale_state")
        self.assertEqual(self.git("rev-list", "--count", "HEAD"), "2")

    def test_record_without_completion_stays_unknown(self):
        (self.root / "tracked").write_text("new\n")
        self.git("add", "--", "tracked")
        self.git("config", "core.logAllRefUpdates", "false")
        shutil.rmtree(self.root / ".git" / "logs")
        operation = str(uuid.uuid4())
        meta = self.meta()
        receipt = self.client.result("commit", **meta, operationId=operation, message="no proof")
        self.assertEqual(receipt["state"], "unknown")
        retry = self.connect()
        self.meta(retry)
        self.assertEqual(retry.result("commit", **meta, operationId=operation, message="no proof")["state"], "unknown")
        self.assertEqual(self.git("rev-list", "--count", "HEAD"), "2")


if __name__ == "__main__":
    unittest.main()
