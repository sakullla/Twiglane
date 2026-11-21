"""Disposable Linux SSH targets with distinct keys and the same worktree path."""
import contextlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import time

base = Path(__file__).resolve().parent
repo = base / "worktree"
repo.mkdir()
os.chmod(base, 0o755)
sshd = shutil.which("sshd") or "/usr/sbin/sshd"
test_accounts = [("twgitkey", 49861), ("twgitpass", 49862)]
users = Path("/etc/passwd").read_text()
if any(line.split(":")[0] in {name for name, _ in test_accounts} or
       line.split(":")[2].isdigit() and int(line.split(":")[2]) in {uid for _, uid in test_accounts}
       for line in users.splitlines()):
    raise RuntimeError("Verification account identities are already in use")
passwd = base / "passwd"
shadow = base / "shadow"
groups = base / "group"
password = secrets.token_urlsafe(24)
password_hash = subprocess.run(["openssl", "passwd", "-6", "-stdin"], input=password + "\n",
                               text=True, capture_output=True, check=True).stdout.strip()
password_file_mode = 0o600
shadow.touch(mode=password_file_mode, exist_ok=False)
users += "".join(f"{name}:x:{uid}:{uid}:Twiglane fixture:{base / name}:/bin/sh\n" for name, uid in test_accounts)
passwd.write_text(users)
shadow.write_text(f"twgitkey:{password_hash}:19700:0:99999:7:::\ntwgitpass:{password_hash}:19700:0:99999:7:::\n")
groups.write_text(Path("/etc/group").read_text() + "".join(f"{name}:x:{uid}:\n" for name, uid in test_accounts))

def git(cwd, *args):
    return subprocess.check_output(["git", "-C", str(cwd), *args], text=True).strip()

peers = []
with contextlib.ExitStack() as cleanup:
    for (username, uid), label in zip(test_accounts, ("a", "b")):
        space = base / ("fixture-" + label)
        home = base / username
        home.mkdir(mode=0o700)
        space.mkdir()
        git(space, "init", "-q", "-b", "main")
        git(space, "config", "user.name", "Twiglane verification")
        git(space, "config", "user.email", "twiglane-fixture@example.invalid")
        (space / "small.txt").write_text("unchanged\n")
        git(space, "add", "--", "small.txt")
        git(space, "commit", "-qm", "fixture baseline")
        (space / "small.txt").write_text(f"fixture {label}\n")
        (space / "second.txt").write_text("leave unstaged\n")
        for parent, dirs, files in os.walk(space):
            os.chown(parent, uid, uid)
            for file in files:
                os.chown(Path(parent) / file, uid, uid)
        os.chown(home, uid, uid)

        with socket.socket() as pick:
            pick.bind(("127.0.0.1", 0))
            port = pick.getsockname()[1]
        key = base / ("host-key-" + label)
        subprocess.run(["ssh-keygen", "-qt", "ed25519", "-N", "", "-f", key], check=True)
        keyfile = base / "client.pub"
        force = base / "force-command"
        force.write_text('#!/bin/sh\nexec /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n')
        force.chmod(0o755)
        config = base / ("sshd-" + label)
        config.write_text(f"""ListenAddress 127.0.0.1
Port {port}
HostKey {key}
PidFile {base}/sshd-{label}.pid
AuthorizedKeysFile {keyfile}
StrictModes no
PasswordAuthentication {'yes' if label == 'b' else 'no'}
PubkeyAuthentication {'no' if label == 'b' else 'yes'}
KbdInteractiveAuthentication no
UsePAM no
AllowUsers {username}
ForceCommand {force}
AllowTcpForwarding no
""")
        with (base / ("log-" + label)).open("wb") as log:
            process = subprocess.Popen(
                ["unshare", "--mount", "--propagation", "private", "/bin/sh", "-ec",
                 'mount --bind "$1" "$2"; mount --bind "$3" /etc/passwd; '
                 'mount --bind "$4" /etc/shadow; mount --bind "$5" /etc/group; exec "$6" -D -e -f "$7"',
                 "fixture", str(space), str(repo), str(passwd), str(shadow), str(groups), sshd, str(config)],
                stdout=subprocess.DEVNULL, stderr=log
            )
        def stop(child):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
        cleanup.callback(stop, process)
        for _ in range(100):
            if process.poll() is not None:
                raise RuntimeError((base / ("log-" + label)).read_text(errors="replace")[-1200:])
            with socket.socket() as probe:
                probe.settimeout(0.2)
                if not probe.connect_ex(("127.0.0.1", port)):
                    break
            time.sleep(0.05)
        else:
            raise RuntimeError("Verification sshd did not open the loopback port")
        peers.append(dict(label=label, user=username, port=port, worktree=str(repo), hostKey=key.with_suffix(".pub").read_text().strip()))
    print(json.dumps({"peers": peers, "fixturePassword": password}), flush=True)
    sys.stdin.buffer.read(1)
