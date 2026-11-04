// T4 观察脚本的 CDP 小工具：起一个 headless Chrome，连上 flattened session，
// 提供 evaluate / waitFor / 截图所需的最小接口。不引入新依赖（只用 node 内置模块）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
];

export function chromePath() {
  const found = CHROME_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) throw new Error("找不到 Chrome/Edge，请用 CHROME_PATH 指定浏览器可执行文件");
  return found;
}

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function waitForJson(port, urlPath, attempts = 80) {
  return new Promise((resolve, reject) => {
    const tick = (left) => http.get({ host: "127.0.0.1", port, path: urlPath }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); }
      });
    }).on("error", (error) => {
      if (left <= 0) reject(error); else setTimeout(() => tick(left - 1), 150);
    });
    tick(attempts);
  });
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      this.events.push(message);
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")), { once: true });
    });
    return new Cdp(socket);
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error("CDP 超时: " + method));
      }, 30_000);
    });
  }
  close() { this.socket.close(); }
}

export async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "页面脚本异常");
  return result.result?.value;
}

export async function waitFor(cdp, sessionId, expression, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, sessionId, expression)) return;
    await pause(120);
  }
  throw new Error("等待超时：" + what);
}

export function consoleErrors(cdp, sessionId) {
  return cdp.events
    .filter((event) => event.sessionId === sessionId && event.method === "Runtime.consoleAPICalled" && event.params.type === "error")
    .map((event) => event.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(" "));
}

/** 未捕获的运行时异常：只统计 console.error 会把没有打印错误的失败当成通过。 */
export function exceptions(cdp, sessionId) {
  return cdp.events
    .filter((event) => event.sessionId === sessionId && event.method === "Runtime.exceptionThrown")
    .map((event) => String(event.params.exceptionDetails?.exception?.description ?? event.params.exceptionDetails?.text ?? "?").split(">")[0].split("\n")[0]);
}

export async function withBrowser(fn) {
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "twiglane-t4-"));
  const browser = spawn(chromePath(), [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
    "--no-default-browser-check", "--force-device-scale-factor=1",
    "--remote-debugging-port=" + port, "--user-data-dir=" + profile, "about:blank",
  ], { stdio: "ignore" });
  let cdp;
  try {
    const version = await waitForJson(port, "/json/version");
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    return await fn(cdp);
  } finally {
    cdp?.close();
    browser.kill();
    await pause(400);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch (error) { console.warn("临时 profile 未清理:", error.message); }
  }
}

export async function openSession(cdp, { url, theme = "dark", width = 1280, height = 840 }) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: 'try { localStorage.setItem("preview-theme", ' + JSON.stringify(theme) + '); } catch (error) {}' }, sessionId);
  await cdp.send("Page.navigate", { url }, sessionId);
  return { targetId, sessionId };
}
