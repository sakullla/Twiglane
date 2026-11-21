"""Verify actual Cliora SSH and Twiglane agent against two Linux worktrees."""
import hashlib
import io
import json
import os
from pathlib import Path
import selectors
import shlex
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import uuid

if len(sys.argv) != 3:
    raise SystemExit("Usage: python3 scripts/remote-worktree/verify-live.py <cliora-debug-binary> <root@host>")
source = Path(__file__).resolve().parent
connector = Path(sys.argv[1]).resolve(strict=True)
target = sys.argv[2]
if target.startswith("-") or any(char.isspace() for char in target):
    raise ValueError("Expected an SSH destination")
ssh = ["/usr/bin/ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
       "-o", "ConnectTimeout=15", "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no"]
agent = Path("remote-agent/agent").read_bytes()
digest = hashlib.sha256(agent).hexdigest()

def archive(items):
    memory = io.BytesIO()
    with tarfile.open(fileobj=memory, mode="w") as tar:
        for name, contents in items:
            entry = tarfile.TarInfo(name)
            entry.size = len(contents)
            entry.mode = 0o644
            tar.addfile(entry, io.BytesIO(contents))
    return memory.getvalue()

def line(pipe, seconds=30):
    with selectors.DefaultSelector() as wait:
        wait.register(pipe, selectors.EVENT_READ)
        if not wait.select(seconds):
            raise TimeoutError("Waiting for verification response")
    result = pipe.readline()
    if not result:
        raise EOFError("Verification process closed its pipe")
    return json.loads(result)

with tempfile.TemporaryDirectory(prefix="twiglane-linux-fixtures-") as work:
    work = Path(work)
    client = work / "client-key"
    subprocess.run(["ssh-keygen", "-qt", "ed25519", "-N", "", "-f", client], check=True)
    body = archive([("fixture.py", (source / "fixture-remote.py").read_bytes()),
                    ("client.pub", client.with_suffix(".pub").read_bytes())])
    supervisor = """set -eu
root=$(mktemp -d /tmp/twiglane-verify.XXXXXX)
trap 'rm -rf -- "$root"' EXIT
head -c %d | tar -xf - -C "$root"
python3 "$root/fixture.py"
""" % len(body)
    with (work / "supervisor.stderr").open("w+b") as log:
        process = subprocess.Popen(ssh + [target, supervisor], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=log)
        try:
            process.stdin.write(body)
            process.stdin.flush()
            try:
                fixture = line(process.stdout)
            except (EOFError, TimeoutError):
                log.seek(0)
                raise RuntimeError(log.read().decode(errors="replace")[-2500:]) from None
            askpass = work / "askpass"
            private = work / "verification-password"
            private.touch(mode=0o600)
            private.write_text(fixture.pop("fixturePassword") + "\n")
            askpass.write_text(f"""#!/bin/sh
case "$1" in
  *assword*) exec cat {shlex.quote(str(private))} ;;
  *) exit 1 ;;
esac
""")
            askpass.chmod(0o700)
            dbpath = work / "cliora.db"
            conf = work / "ssh_config"
            known = work / "known_hosts"
            with sqlite3.connect(dbpath) as db:
                db.executescript("""
                    CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT);
                    CREATE TABLE remote_targets(id,name,host,port,user_name,auth_method,identity_file,ssh_config,default_path,enabled,created_at,updated_at);
                """)
                db.execute("INSERT INTO app_settings VALUES(?,?)", ("preferences", json.dumps({
                    "managed_tools": [], "theme": "light", "schema_version": 1, "remote_ssh_enabled": True,
                })))
                for peer in fixture["peers"]:
                    label = peer["label"]
                    alias = "twiglane-fixture-" + label
                    peer["id"] = alias + "-" + uuid.uuid4().hex
                    proxy = [*ssh, "-o", "ControlMaster=no", "-o", "ControlPath=none",
                             "-W", f"127.0.0.1:{peer['port']}", "--", target]
                    with known.open("a") as hosts:
                        hosts.write(f"{alias} {peer['hostKey']}\n")
                    with conf.open("a") as config:
                        config.write(f"Host {alias}\n HostName 127.0.0.1\n HostKeyAlias {alias}\n "
                                     f"UserKnownHostsFile {known}\n GlobalKnownHostsFile none\n "
                                     "ProxyCommand " + shlex.join(proxy) + "\n")
                    db.execute("INSERT INTO remote_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (
                        peer["id"], alias, alias, peer["port"], peer["user"],
                        "key" if label == "a" else "password", str(client) if label == "a" else None,
                        str(conf), peer["worktree"], 1, 1, 1))
            env = {**os.environ, "CLIORA_TWIGLANE_TEST_DB": str(dbpath), "CLIORA_SSH_PROXY": "off",
                   "SSH_ASKPASS": str(askpass), "SSH_ASKPASS_REQUIRE": "force", "DISPLAY": "twiglane:0"}
            args = [str(connector), "--twiglane-remote-v1"]
            def helper(op, *fields, content=None):
                result = subprocess.run(args + [op,*fields], input=content, env=env,
                                        capture_output=True, timeout=35)
                if result.returncode:
                    raise RuntimeError(f"{op} failed: {result.stderr.decode(errors='replace')[-1500:]}")
                return [json.loads(line) for line in result.stdout.splitlines()]
            catalog = {item["targetId"]:item for item in helper("list")[0]["targets"]}
            sessions = []
            platform = None
            try:
                for peer in fixture["peers"]:
                    id = peer["id"]
                    selector = catalog[id]["targetRevision"]
                    pre = helper("probe", id, selector)[0]
                    assert pre["system"] == "Linux" and pre["agentSha256"] is None
                    observed_platform = f'{pre["system"]} {pre["architecture"]}'
                    assert platform is None or platform == observed_platform
                    platform = observed_platform
                    partial = subprocess.run(
                        args + ["install", id, pre["peerRevision"], digest, "development"],
                        input=agent[:len(agent)//2], env=env, capture_output=True, timeout=35,
                    )
                    assert partial.returncode != 0 and helper("probe", id, selector)[0]["agentSha256"] is None
                    installed = helper("install", id, pre["peerRevision"], digest, "development", content=agent)
                    assert installed[-1]["installed"] and installed[-1]["agentSha256"] == digest
                    after = helper("probe", id, selector)[0]
                    assert after["peerRevision"] == pre["peerRevision"] and after["agentSha256"] == digest
                    peer["selector"] = after["peerRevision"]
                    child = subprocess.Popen(args + ["connect", id, after["peerRevision"], digest, "development"],
                                             stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                             stderr=subprocess.PIPE, env=env, start_new_session=True)
                    sessions.append(child)
                def rpc(session, op, **fields):
                    frame_id = uuid.uuid4().hex
                    session.stdin.write((json.dumps(dict(v=1,id=frame_id,op=op,**fields))+"\n").encode())
                    session.stdin.flush()
                    response = line(session.stdout)
                    assert response["id"] == frame_id and response["ok"], response
                    return response["result"]
                snapshots = [rpc(session, "open", path=peer["worktree"])
                             for session, peer in zip(sessions, fixture["peers"])]
                a, b = snapshots
                assert a["root"] == b["root"] and a["repo"] != b["repo"]
                cliora_root = Path(os.environ.get("TWIGLANE_VERIFY_CLIORA", "../cliora"))
                metadata = (cliora_root / "src-tauri/src/remote/twiglane_review_metadata.py").read_text()
                remote_session = "cliora-fixture-" + uuid.uuid4().hex
                socket_a = fixture["peers"][0]
                direct = ssh + ["-F", str(conf), "-i", str(client), "-p", str(socket_a["port"]),
                                "-l", socket_a["user"], "--", "twiglane-fixture-a"]
                program = "python3 -I -c " + shlex.quote(metadata)
                cwd = shlex.quote(socket_a["worktree"])
                subprocess.run(direct + [f"cd {cwd} && {program} record {remote_session}"],
                               check=True, stdout=subprocess.DEVNULL, timeout=30)
                def source_snapshot():
                    result = subprocess.run(direct + [program + " inspect"],
                                            input=json.dumps({"session":remote_session,"directory":socket_a["worktree"]})+"\n",
                                            text=True, capture_output=True, timeout=30, check=True)
                    hello, data = result.stdout.splitlines()
                    assert hello == "cliora-review/1"
                    return json.loads(data)
                baseline = source_snapshot()
                assert baseline["worktreeIdentity"] == a["repo"] and baseline["baseline"] == a["head"]
                stage = rpc(sessions[0], "stage", repo=a["repo"], generation=a["generation"],
                            operationId=str(uuid.uuid4()), paths=["small.txt","second.txt"])
                unstage = rpc(sessions[0], "unstage", repo=a["repo"], generation=stage["generation"],
                              operationId=str(uuid.uuid4()), paths=["second.txt"])
                original = sessions[0]
                operation = str(uuid.uuid4())
                request = dict(v=1,id="commit-with-lost-reply",op="commit",repo=a["repo"],
                               generation=unstage["generation"],operationId=operation,message="Verify A only")
                original.stdin.write((json.dumps(request)+"\n").encode())
                original.stdin.flush()

                import re, signal, time
                fixture_path = str(Path(a["root"]).parent / "fixture-a")
                assert re.fullmatch(r"/tmp/twiglane-verify\.[A-Za-z0-9]+/fixture-a", fixture_path)
                prove = f"git -c safe.directory={fixture_path} -C {fixture_path}"
                before = time.monotonic()
                actual = None
                while time.monotonic() - before < 15:
                    actual = subprocess.check_output(ssh + [target, prove + " rev-parse HEAD"], text=True).strip()
                    if actual != a["head"]:
                        break
                    time.sleep(0.1)
                assert actual and actual != a["head"]
                # This intentional transport loss happens after Git published HEAD,
                # before the test client consumes any bytes of the commit reply.
                os.killpg(original.pid, signal.SIGKILL)
                original.wait(timeout=8)
                original.stdin.close()
                sessions.pop(0)
                peer = fixture["peers"][0]
                reconnected = subprocess.Popen(args + ["connect", peer["id"], peer["selector"], digest, "development"],
                                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                               stderr=subprocess.PIPE, env=env, start_new_session=True)
                sessions.insert(0, reconnected)
                after_a = rpc(reconnected, "open", path=peer["worktree"])
                receipt = rpc(reconnected, "receipt", repo=a["repo"], operationId=operation)
                after_b = rpc(sessions[1], "status", repo=b["repo"])
                count = subprocess.check_output(ssh + [target, prove + " rev-list --count HEAD"], text=True).strip()
                assert receipt["state"] == "completed" and after_a["head"] == receipt["head"] == actual
                assert count == "2" and after_a["files"] == [{"path":"second.txt","xy":"??"}]
                assert after_b["head"] == b["head"] and after_b["files"] == b["files"]
                verified = source_snapshot()
                assert verified["worktreeIdentity"] == a["repo"] and verified["headOid"] == receipt["head"]
                assert verified["baseline"] == baseline["baseline"] and verified["uncommitted"] == 1
                print(json.dumps({"platform":platform,"authenticatedKey":True,"authenticatedPassword":True,
                                  "ordinaryAccounts":True,"sameCanonicalPath":True,"isolatedCommit":True,
                                  "remoteAgentInstalledAndReused":True,"interruptedInstallRetried":True,
                                  "lostReceiptRecoveredExactlyOnce":True,
                                  "independentReviewBaselineAndHead":True,"gui":False}), flush=True)
            finally:
                for child in sessions:
                    child.stdin.close()
                for child in sessions:
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=12)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
