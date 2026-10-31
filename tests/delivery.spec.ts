import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUDGETS,
  REQUIRED_CHECKS,
  judgeReport,
  p95,
  sha256File,
  sourceFingerprint,
  validateCheck,
  verifyDelivery,
} from "../scripts/delivery-lib.mjs";
import { generateFixture } from "../scripts/generate-fixture.mjs";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "twiglane-delivery-"));
  scratch.push(dir);
  return dir;
}

describe("交付测量", () => {
  it("用排序样本计算 p95", () => {
    expect(p95([])).toBeNull();
    expect(p95([5, 1, 4, 2, 3])).toBe(5);
    expect(p95([Number.NaN])).toBeNull();
  });

  it("小夹具的文件、提交和改动数量与声明一致", async () => {
    const dest = tempDir();
    const manifest = await generateFixture({
      dest,
      seed: "delivery-spec",
      plan: { files: 4, fileBytes: 64, commits: 2, modifications: 1, textBytes: 0, binaryBytes: 0 },
    });
    expect(manifest.verified).toBe(true);
    expect(manifest.files).toBe(4);
    expect(manifest.commits).toBe(2);
    expect(manifest.modifications).toBe(1);
    expect(manifest.sampleBytes).toBe(64);
    expect(manifest.repo.startsWith(dest)).toBe(true);
  });

  it("缺少报告时验收命令失败", () => {
    const root = tempDir();
    const result = verifyDelivery(root);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("missing-report");
  });

  it("缺口没有下一步时不能通过检查", () => {
    const reasons = validateCheck(
      { id: "protocol.https", status: "gap", summary: "没有远程", evidence: {} },
      { root: tempDir(), hostPlatform: "darwin" },
    );
    expect(reasons.some((reason: string) => reason.includes("下一步"))).toBe(true);
  });

  it("完整双平台记录与产物摘要一致时可以通过", () => {
    const root = tempDir();
    writeFileSync(
      path.join(root, "README.md"),
      "# Twiglane\n\n不捆绑 Git。\n\n## 支持范围\n\n## 安装与运行\n\n不计入\n\n## 恢复边界\n\n## 性能口径\n\n## 已知限制\n\n研发平台与 AI 聊天不在首版。\n",
    );
    mkdirSync(path.join(root, "src/lib"), { recursive: true });
    writeFileSync(path.join(root, "src/lib/labels.ts"), "不包含 Git\nWebView2\n");
    mkdirSync(path.join(root, "src-tauri/windows"), { recursive: true });
    writeFileSync(path.join(root, "src-tauri/tauri.conf.json"), '{"webviewInstallMode":{"type":"downloadBootstrapper"}}\n');
    writeFileSync(path.join(root, "src-tauri/windows/SimpChinese.nsh"), "这些下载不计入应用体积\n");
    const app = path.join(root, "bundle/Twiglane.app/Contents");
    mkdirSync(app, { recursive: true });
    const plist = path.join(app, "Info.plist");
    writeFileSync(plist, "<plist><string>Twiglane</string></plist>\n");
    const dmg = path.join(root, "bundle/Twiglane.dmg");
    const nsis = path.join(root, "bundle/Twiglane.exe");
    writeFileSync(dmg, "dmg");
    writeFileSync(nsis, "nsis");
    const samples = Array.from({ length: 30 }, () => 10);
    const base = {
      prerequisite: {
        release: true,
        ssd: true,
        acPower: true,
        memoryBytes: BUDGETS.referenceMemoryBytes,
        diskColdStart: false,
      },
      contentOk: true,
      browserMock: false,
      method: "gui-synthetic",
    };
    const both = (extra: Record<string, unknown>) => ({
      platforms: {
        darwin: { ...base, metric: "phys_footprint", ...extra },
        win32: { ...base, metric: "private-working-set", ...extra },
      },
    });
    const checks = [
      {
        id: "package.macos.app",
        status: "pass",
        summary: "app",
        evidence: { path: "bundle/Twiglane.app", sha256: sha256File(plist), productName: "Twiglane", bytes: 100 },
      },
      {
        id: "package.macos.dmg",
        status: "pass",
        summary: "dmg",
        evidence: { path: "bundle/Twiglane.dmg", sha256: sha256File(dmg), productName: "Twiglane", bytes: 3 },
      },
      {
        id: "package.windows.nsis",
        status: "pass",
        summary: "nsis",
        evidence: {
          path: "bundle/Twiglane.exe",
          sha256: sha256File(nsis),
          productName: "Twiglane",
          bytes: 4,
          runtimeVerified: false,
          hostPlatform: "darwin",
        },
      },
      {
        id: "package.signature",
        status: "pass",
        summary: "未公证",
        evidence: { notarized: false, trustedDistribution: false, codesign: "Signature=adhoc Authority=ad-hoc", statement: "ad-hoc 测试签名，未公证" },
      },
      {
        id: "package.webview2-cost",
        status: "pass",
        summary: "另行下载",
        evidence: { includedInInstaller: false, mode: "downloadBootstrapper", measuredDownloadBytes: null },
      },
      { id: "package.git-explained", status: "pass", summary: "Git 说明", evidence: {} },
      { id: "docs.support", status: "pass", summary: "支持范围", evidence: {} },
      { id: "perf.startup.s", status: "pass", summary: "启动", evidence: both({ firstMs: [100], laterMs: [80, 80, 80, 80] }) },
      { id: "perf.status.s", status: "pass", summary: "S", evidence: both({ samplesMs: samples }) },
      { id: "perf.status.m", status: "pass", summary: "M", evidence: both({ samplesMs: samples }) },
      { id: "perf.status.l", status: "pass", summary: "L", evidence: both({ samplesMs: samples }) },
      { id: "perf.diff.cached", status: "pass", summary: "缓存差异", evidence: both({ samplesMs: samples }) },
      { id: "perf.diff.uncached", status: "pass", summary: "未缓存差异", evidence: both({ samplesMs: samples }) },
      { id: "perf.diff.large", status: "pass", summary: "大文件", evidence: both({ samplesMs: samples, truncated: true }) },
      { id: "perf.feedback", status: "pass", summary: "反馈", evidence: both({ samplesMs: samples, tasks: ["clone", "sync", "commit"] }) },
      { id: "perf.scroll.m", status: "pass", summary: "滚动", evidence: both({ frameMs: samples }) },
      { id: "perf.interact.l", status: "pass", summary: "交互", evidence: both({ keyboard: true, cancelled: true, switched: true, readStarted: true }) },
      {
        id: "perf.memory.s",
        status: "pass",
        summary: "内存",
        evidence: {
          platforms: {
            darwin: { ...base, method: "gui-synthetic", metric: "phys_footprint", privateBytes: 1024 },
            win32: { ...base, method: "gui-synthetic", metric: "private-working-set", privateBytes: 1024 },
          },
        },
      },
      { id: "perf.cpu.s", status: "pass", summary: "CPU", evidence: both({ cpuPercent: 0.1 }) },
      { id: "perf.git-idle", status: "pass", summary: "Git", evidence: both({ lingeringGit: false }) },
      {
        id: "perf.stability",
        status: "pass",
        summary: "稳定",
        evidence: both({ growth: 0.01, fileSwitches: 100, repoSwitches: 20, lingeringProcesses: false }),
      },
      {
        id: "perf.native-git",
        status: "pass",
        summary: "原生 Git",
        evidence: {
          platforms: {
            darwin: { method: "git-cli", samplesMs: { S: samples, M: samples, L: samples } },
            win32: { method: "git-cli", samplesMs: { S: samples, M: samples, L: samples } },
          },
        },
      },
      {
        id: "accept.macos",
        status: "pass",
        summary: "macOS 验收",
        evidence: {
          method: "installed-app",
          hostPlatform: "darwin",
          browserMock: false,
          oids: ["a".repeat(40), "b".repeat(40)],
          partialCommit: true,
          pushed: true,
          mergeOid: "c".repeat(40),
          themes: ["light", "dark"],
          keyboard: true,
          shortcutFocused: true,
          selectionChanged: true,
          selectionBefore: "",
          selectionMoved: "unstaged:a.txt",
          selectionAfter: "unstaged:b.txt",
        },
      },
      {
        id: "accept.windows",
        status: "pass",
        summary: "Windows 验收",
        evidence: {
          method: "installed-app",
          hostPlatform: "win32",
          browserMock: false,
          oids: ["d".repeat(40), "e".repeat(40)],
          partialCommit: true,
          pushed: true,
          mergeOid: "f".repeat(40),
          themes: ["light", "dark"],
          keyboard: true,
          shortcutFocused: true,
          selectionChanged: true,
          selectionBefore: "unstaged:a.txt",
          selectionMoved: "unstaged:b.txt",
          selectionAfter: "unstaged:c.txt",
        },
      },
      {
        id: "protocol.https",
        status: "pass",
        summary: "HTTPS",
        evidence: { success: true, authFailure: true, redacted: true, localBare: false, transcript: "https ok and auth rejected" },
      },
      {
        id: "protocol.ssh",
        status: "pass",
        summary: "SSH",
        evidence: { success: true, authFailure: true, redacted: true, localBare: false, transcript: "ssh ok and auth rejected" },
      },
    ];
    expect(checks.map((check) => check.id).sort()).toEqual([...REQUIRED_CHECKS].sort());
    const report = {
      format: "twiglane-delivery-verification/v1",
      sourceFingerprint: sourceFingerprint(root),
      checks,
    };
    const judged = judgeReport(root, report, report.sourceFingerprint, "darwin");
    expect(judged.ok).toBe(true);
    report.checks = report.checks.map((check) =>
      check.id === "accept.windows" ? { ...check, status: "gap", nextStep: "在 Windows 11 x64 上安装后重跑验收。" } : check,
    );
    expect(judgeReport(root, report, report.sourceFingerprint, "darwin").ok).toBe(false);
  });

  it("只给状态文案、未开始的读取或未改变选择不能通过", () => {
    const root = tempDir();
    const base = {
      prerequisite: {
        release: true,
        ssd: true,
        acPower: true,
        memoryBytes: BUDGETS.referenceMemoryBytes,
        diskColdStart: false,
      },
      contentOk: true,
      browserMock: false,
      method: "gui-synthetic",
    };
    const samples = Array.from({ length: 30 }, () => 10);
    const both = (extra: Record<string, unknown>) => ({
      platforms: {
        darwin: { ...base, ...extra },
        win32: { ...base, metric: "private-working-set", ...extra },
      },
    });
    expect(
      validateCheck(
        { id: "perf.feedback", status: "pass", summary: "反馈", evidence: both({ samplesMs: samples }) },
        { root, hostPlatform: "darwin" },
      ).some((reason: string) => reason.includes("克隆")),
    ).toBe(true);
    expect(
      validateCheck(
        {
          id: "perf.interact.l",
          status: "pass",
          summary: "交互",
          evidence: both({ keyboard: true, cancelled: true, switched: true }),
        },
        { root, hostPlatform: "darwin" },
      ).some((reason: string) => reason.includes("尚未开始")),
    ).toBe(true);
    expect(
      validateCheck(
        {
          id: "perf.diff.large",
          status: "pass",
          summary: "大文件",
          evidence: both({ samplesMs: [85], truncated: true }),
        },
        { root, hostPlatform: "darwin" },
      ).some((reason: string) => reason.includes("样本不足")),
    ).toBe(true);
    expect(
      validateCheck(
        {
          id: "accept.macos",
          status: "pass",
          summary: "验收",
          evidence: {
            method: "installed-app",
            hostPlatform: "darwin",
            browserMock: false,
            oids: ["a".repeat(40), "b".repeat(40)],
            partialCommit: true,
            pushed: true,
            mergeOid: "c".repeat(40),
            themes: ["light", "dark"],
            keyboard: true,
          },
        },
        { root, hostPlatform: "darwin" },
      ).some((reason: string) => reason.includes("方向键")),
    ).toBe(true);
  });
});
