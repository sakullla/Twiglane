import asyncio, base64, io, json, pathlib, re, subprocess, sys, tarfile, time
SSH = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
       "-o", "ConnectTimeout=20", "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no"]
if len(sys.argv) != 2:
    raise SystemExit("Usage: python3 scripts/remote-worktree/verify-weak-link.py <user@host>")
HOST = sys.argv[1]
if not re.fullmatch(r"[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+", HOST) or HOST.startswith("-"):
    raise ValueError("Expected a user@host SSH destination")
HOSTNAME = HOST.rsplit("@", 1)[1]
async def profile(name, delay, rate, root):
    counts = [0, 0]
    active = set()
    async def proxy(local, to_local):
        away, to_away = await asyncio.open_connection(HOSTNAME, 22)
        async def pump(reader, writer, direction):
            buffer = asyncio.Queue(32)
            async def receive():
                while True:
                    data = await reader.read(4096)
                    await buffer.put((time.monotonic(), data))
                    if not data:
                        break
            recv = asyncio.create_task(receive())
            due = 0
            try:
                while True:
                    stamp, data = await buffer.get()
                    if not data:
                        if writer.can_write_eof():
                            writer.write_eof()
                        break
                    due = max(due, stamp + delay) + (len(data) / rate if rate else 0)
                    await asyncio.sleep(max(0, due - time.monotonic()))
                    writer.write(data)
                    await writer.drain()
                    counts[direction] += len(data)
            finally:
                recv.cancel()
                await asyncio.gather(recv, return_exceptions=True)
        tasks = [asyncio.create_task(pump(local, to_away, 0)), asyncio.create_task(pump(away, to_local, 1))]
        active.update(tasks)
        try:
            await asyncio.gather(*tasks)
        except (ConnectionError, asyncio.CancelledError):
            pass
        finally:
            for task in tasks:
                task.cancel()
                active.discard(task)
            for writer in (to_away, to_local):
                writer.close()
    server = await asyncio.start_server(proxy, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    cmd = SSH + ["-o", f"ProxyCommand=/usr/bin/nc 127.0.0.1 {port}", HOST,
                f"XDG_STATE_HOME={root}/state python3 {root}/agent --stdio"]
    process = await asyncio.create_subprocess_exec(*cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    async def push(i, op, **fields):
        process.stdin.write((json.dumps(dict(v=1, id=i, op=op, **fields)) + "\n").encode())
        await process.stdin.drain()
    async def read(i):
        line = await asyncio.wait_for(process.stdout.readline(), 20)
        if not line:
            raise RuntimeError((await process.stderr.read()).decode(errors="replace"))
        result = json.loads(line)
        assert result["id"] == i
        return result
    def ms(start):
        return round((time.monotonic()-start)*1000)
    try:
        await push("ready", "hello")
        assert (await read("ready"))["ok"]
        start = time.monotonic()
        await push("rtt", "hello")
        assert (await read("rtt"))["ok"]
        rtt = ms(start)
        durations = []
        for n in ["few", "many"]:
            start = time.monotonic()
            prev = counts[:]
            await push(n, "open", path=root + "/" + n)
            response = await read(n)
            assert response["ok"], response
            snapshot = response["result"]
            durations.append((len(snapshot["files"]), ms(start), counts[1] - prev[1]))
        fields = dict(repo=snapshot["repo"], generation=snapshot["generation"], view="unstaged")
        before = counts[:]
        start = time.monotonic()
        await push("small", "diff", path="small.txt", **fields)
        small = await read("small")
        assert b"+changed small" in base64.b64decode(small["result"]["data"])
        assert small["result"]["nextCursor"] is None
        small_ms, small_bytes = ms(start), counts[1] - before[1]
        await push("big", "diff", path="big.txt", **fields)
        big = await read("big")
        assert len(base64.b64decode(big["result"]["data"])) == 16*1024 and big["result"]["nextCursor"]
        start = time.monotonic()
        before = counts[:]
        await push("old", "diff", path="big.txt", cursor=big["result"]["nextCursor"], **fields)
        await push("new", "diff", path="small.txt", **fields)
        old = await read("old")
        new = await read("new")
        assert b"+changed small" in base64.b64decode(new["result"]["data"])
        assert counts[1] - before[1] < 64*1024
        print(json.dumps(dict(profile=name, configuredBytesPerSec=rate or None, observedRoundTripMs=rtt,
            lists=[dict(files=n,elapsedMs=t,downBytes=b,rpcCount=1) for n,t,b in durations],
            smallDiffMs=small_ms,smallDiffDownBytes=small_bytes,
            switchMs=ms(start),switchDownBytes=counts[1] - before[1],oldSuperseded=not old["ok"],
            sshUp=counts[0],sshDown=counts[1])),flush=True)
    finally:
        process.stdin.close()
        try:
            await asyncio.wait_for(process.wait(), 5)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
        server.close()
        await server.wait_closed()
        for task in list(active):
            task.cancel()
async def main(root):
    for name, delay, rate in [("baseline",0,0),("high-rtt",.4,0),("low-bw",0,32768),("combined",.4,32768),("stress",.9,8192)]:
        await profile(name,delay,rate,root)
setup = """
import hashlib, pathlib, subprocess
root=pathlib.Path(__file__).parent
for name,n in (('few',3),('many',250)):
    d=root/name
    d.mkdir()
    def git(*args): subprocess.run(['git','-C',str(d),*args], check=True, stdout=subprocess.DEVNULL)
    git('init','-q')
    git('config','user.name','Twiglane Test')
    git('config','user.email','test@example.invalid')
    (d/'big.txt').write_text('before\\n')
    (d/'small.txt').write_text('before\\n')
    git('add','--','big.txt','small.txt')
    git('commit','-qm','fixture')
    (d/'small.txt').write_text('changed small\\n')
    (d/'big.txt').write_text('\\n'.join(hashlib.sha256(str(i).encode()).hexdigest() for i in range(8000))+'\\n')
    for i in range(n): (d/f'f-{i}.txt').write_text(str(i))
"""
root = subprocess.check_output(SSH + [HOST, "mktemp -d /tmp/twiglane-weak.XXXXXX"], text=True).strip()
assert re.fullmatch(r"/tmp/twiglane-weak\.[A-Za-z0-9]+", root)
try:
    memory = io.BytesIO()
    with tarfile.open(fileobj=memory, mode="w") as tar:
        for name, contents in [("agent",pathlib.Path("remote-agent/agent").read_bytes()),("setup.py",setup.encode())]:
            info=tarfile.TarInfo(name)
            info.size=len(contents)
            info.mode=0o600
            tar.addfile(info,io.BytesIO(contents))
    subprocess.run(SSH + [HOST, f"tar -xf - -C {root} && python3 {root}/setup.py"],input=memory.getvalue(),check=True)
    asyncio.run(main(root))
finally:
    subprocess.run(SSH + [HOST, f"rm -rf -- {root}"],check=True)
