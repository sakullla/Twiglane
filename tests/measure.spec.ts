import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cancelContentOk,
  feedbackContentOk,
  keyboardContentOk,
  largeSummaryContentOk,
} from "../src/lib/measure";
import { measureProtocol, remoteKind, resetSampleLog, startupTiming } from "../scripts/measure-delivery.mjs";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("测量口径", () => {
  it("大文件摘要必须留下每一次截断摘要，而不是一次未缓存耗时", () => {
    const once = [85];
    const thirty = Array.from({ length: 30 }, () => true);
    expect(largeSummaryContentOk(once, [true], 30)).toBe(false);
    expect(largeSummaryContentOk(Array.from({ length: 30 }, () => 85), thirty, 30)).toBe(true);
    expect(largeSummaryContentOk(Array.from({ length: 30 }, () => 85), [...thirty.slice(0, 29), false], 30)).toBe(false);
  });

  it("反馈必须真正启动克隆、同步和提交", () => {
    const samples = Array.from({ length: 30 }, () => 16);
    expect(feedbackContentOk({ samples, painted: true, operations: [], started: true }, 30)).toBe(false);
    expect(
      feedbackContentOk(
        {
          samples,
          painted: true,
          operations: Array.from({ length: 30 }, (_, index) => (["clone", "sync", "commit"] as const)[index % 3]),
          started: true,
        },
        30,
      ),
    ).toBe(true);
    expect(
      feedbackContentOk(
        { samples, painted: true, operations: ["clone", "sync", "commit"], started: false },
        30,
      ),
    ).toBe(false);
  });

  it("键盘成功要看到快捷键聚焦和方向键改变选择", () => {
    expect(keyboardContentOk({ theme: ["light", "dark"], shortcutFocused: false, selectionChanged: false })).toBe(false);
    expect(
      keyboardContentOk({
        theme: ["light", "dark"],
        shortcutFocused: true,
        selectionChanged: true,
        selectionBefore: "",
        selectionAfter: "unstaged:a.txt",
      }),
    ).toBe(false);
    expect(
      keyboardContentOk({
        theme: ["light", "dark"],
        shortcutFocused: true,
        selectionChanged: true,
        selectionBefore: "",
        selectionMoved: "unstaged:a.txt",
        selectionAfter: "unstaged:b.txt",
      }),
    ).toBe(true);
  });

  it("取消和切换必须发生在仓库读取已经开始之后", () => {
    expect(cancelContentOk({ cancelled: true, switched: true, keyboard: true })).toBe(false);
    expect(cancelContentOk({ cancelled: true, switched: true, keyboard: true, readStarted: true })).toBe(true);
  });

  it("启动计时使用本次进程，不使用会话里更早的样本", () => {
    const samples = [
      { name: "shell-ready", pid: 1, elapsedMs: 255, detail: { controls: true } },
      { name: "startup", pid: 1, elapsedMs: 300, detail: { launch: "first", contentOk: true, elapsedMs: 100 } },
      { name: "shell-ready", pid: 2, elapsedMs: 900, detail: { controls: true } },
      { name: "startup", pid: 2, elapsedMs: 1000, detail: { launch: "later", contentOk: true, elapsedMs: 120 } },
    ];
    expect(startupTiming(samples, 2)).toMatchObject({ controlsMs: 900, launch: "later", contentOk: true });
    expect(startupTiming(samples, 1).controlsMs).toBe(255);
    expect(startupTiming(samples, 3).contentOk).toBe(false);
  });

  it("新的启动会清掉旧样本文件", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "twiglane-samples-"));
    scratch.push(dir);
    const file = path.join(dir, "samples.jsonl");
    writeFileSync(file, "{\"name\":\"shell-ready\",\"pid\":1}\n");
    resetSampleLog(file);
    expect(() => readFileSync(file, "utf8")).toThrow();
  });

  it("未配置或本地路径不会被记成协议通过，配置齐全时会脱敏", async () => {
    let calls = 0;
    const missing = await measureProtocol("https", {}, async () => {
      calls += 1;
      return { status: 0, stdout: "", stderr: "" };
    });
    expect(missing.status).toBe("gap");
    expect(calls).toBe(0);
    expect(remoteKind("/tmp/repo.git")).toBe("local");
    const local = await measureProtocol(
      "ssh",
      { TWIGLANE_SSH_REMOTE: "/tmp/origin.git", TWIGLANE_SSH_DENY_REMOTE: "git@example.test:deny.git" },
      async () => {
        calls += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    );
    expect(local.status).toBe("gap");
    expect(local.evidence.localBare).toBe(true);
    expect(calls).toBe(0);
    const passed = await measureProtocol(
      "https",
      {
        TWIGLANE_HTTPS_REMOTE: "https://example.test/ok.git",
        TWIGLANE_HTTPS_DENY_REMOTE: "https://user:secret@example.test/deny.git",
      },
      async (url: string) => {
        calls += 1;
        if (String(url).includes("deny")) {
          return { status: 128, stdout: "", stderr: `fatal: Authentication failed for '${url}'` };
        }
        return { status: 0, stdout: "abc\trefs/heads/main\n", stderr: "" };
      },
    );
    expect(calls).toBe(2);
    expect(passed.status).toBe("pass");
    expect(passed.evidence.success).toBe(true);
    expect(passed.evidence.authFailure).toBe(true);
    expect(passed.evidence.redacted).toBe(true);
    expect(passed.evidence.transcript).not.toContain("secret");
    expect(passed.evidence.localBare).toBe(false);
  });
});
