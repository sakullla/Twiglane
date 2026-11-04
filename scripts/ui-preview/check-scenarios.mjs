// 预览的异常 / 大规模参数自检：确认 mock 预览仍能进入异常与大数据场景，
// 而不是只有“正常起始页”能看。用法：node scripts/ui-preview/check-scenarios.mjs [--base ...]
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const baseIndex = args.indexOf("--base");
const base = baseIndex >= 0 && args[baseIndex + 1] ? args[baseIndex + 1] : "http://127.0.0.1:1430";
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
];

const SCENARIOS = [
  {
    name: "大规模最近仓库",
    url: "/?recent=many",
    ready: "Boolean(document.querySelector('.welcome-recent button'))",
    check: "document.body.textContent.includes('共 500 个')",
    detail: "document.querySelector('.welcome-recent-head, .welcome-head')?.textContent?.trim().slice(0, 60) || document.querySelectorAll('.welcome-recent button').length + ' 行渲染'",
  },
  {
    name: "空最近仓库",
    url: "/?recent=empty",
    ready: "Boolean(document.querySelector('.welcome-empty'))",
    check: "document.body.textContent.includes('还没有最近仓库')",
    detail: "document.querySelector('.welcome-empty').textContent.trim()",
  },
  {
    name: "Git 缺失",
    url: "/?git=missing",
    ready: "Boolean(document.querySelector('.welcome-diagnostic'))",
    check: "Boolean(document.querySelector('.welcome-diagnostic')) && document.body.textContent.includes('Git')",
    detail: "document.querySelector('.welcome-diagnostic')?.textContent?.trim().slice(0, 60) || ''",
  },
  {
    name: "默认起始页",
    url: "/",
    ready: "Boolean(document.querySelector('.welcome-recent button'))",
    check: "document.querySelectorAll('.welcome-recent button').length === 5",
    detail: "document.querySelector('.welcome-recent-head, .welcome-head')?.textContent?.trim().slice(0, 60) || document.querySelectorAll('.welcome-recent button').length + ' 行渲染'",
  },
];

function chromePath() {
  const found = CHROME_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) throw new Error("找不到 Chrome/Edge，请用 CHROME_PATH 指定");
  return found;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: urlPath }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  });
}

async function main() {
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "twiglane-scenarios-"));
  const browser = spawn(
    chromePath(),
    ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"],
    { stdio: "ignore" },
  );
  let socket;
  try {
    let version;
    for (let attempt = 0; attempt < 60 && !version; attempt += 1) {
      try {
        version = await getJson(port, "/json/version");
      } catch {
        await pause(200);
      }
    }
    if (!version) throw new Error("无法连接 Chrome 调试端口");

    socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP 连接失败")), { once: true });
    });
    let nextId = 1;
    const pending = new Map();
    const events = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else {
        events.push(message);
      }
    });
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    const evaluate = async (expression, sessionId) => {
      const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (reply.result.exceptionDetails) throw new Error(reply.result.exceptionDetails.text);
      return reply.result.result.value;
    };

    const results = [];
    for (const scenario of SCENARIOS) {
      const { result: created } = await send("Target.createTarget", { url: "about:blank" });
      const { result: attached } = await send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
      const sessionId = attached.sessionId;
      await send("Page.enable", {}, sessionId);
      await send("Runtime.enable", {}, sessionId);
      await send("Page.navigate", { url: base + scenario.url }, sessionId);

      let ready = false;
      for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
        try {
          ready = await evaluate(scenario.ready, sessionId);
        } catch {
          ready = false;
        }
        if (!ready) await pause(120);
      }
      const passed = ready ? Boolean(await evaluate(scenario.check, sessionId)) : false;
      const detail = ready ? await evaluate(scenario.detail, sessionId) : "(未就绪)";
      const errors = events
        .filter((event) => event.method === "Runtime.consoleAPICalled" && event.params.type === "error")
        .map((event) => event.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
      results.push({ name: scenario.name, url: scenario.url, passed, detail, errors });
      console.log((passed ? "PASS" : "FAIL") + "  " + scenario.name + "  " + JSON.stringify(detail));
      events.length = 0;
      await send("Target.closeTarget", { targetId: created.targetId });
    }

    const failed = results.filter((item) => !item.passed);
    console.log("场景自检：" + (results.length - failed.length) + "/" + results.length + " 通过");
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    socket?.close();
    browser.kill();
    await pause(400);
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      console.warn("临时 profile 未清理:", error.message);
    }
  }
}

main().catch((error) => {
  console.error("场景自检失败:", error.message);
  process.exit(1);
});
