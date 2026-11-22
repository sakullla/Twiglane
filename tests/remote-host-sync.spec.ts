import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { hostSyncMessage, type HostSyncResult } from "../src/lib/remote-worktree";

/* ------------------------------------------------------------------ *
 * host-sync v1 的前端契约：deep link 只带会话引用，同步结果只描述状态；
 * 配置与密码都不经过 URL 或界面文案。真正的会话、关联与写入行为断言在
 * Rust 侧（src-tauri/src/remote_ssh_sync.rs）与 Cliora 的对应模块里。
 *
 * 本版本只有 helper 级入口（--host-sync-v1）：应用内 IPC 接收接线延后到 T6，
 * 因此这里不断言、也不 mock 任何 host-sync 的 IPC 命令。
 * ------------------------------------------------------------------ */

const read = (path: string) => readFileSync(path, "utf8");
const fixture = JSON.parse(read("tests/fixtures/remote-host-sync/v1.json"));

describe("host-sync v1 前端契约", () => {
  it("deep link 只携带一次性会话引用，链接里没有配置或秘密", () => {
    const url = new URL(fixture.deepLink);
    expect(url.protocol).toBe("twiglane:");
    const hostSync = url.searchParams.getAll("hostSync");
    expect(hostSync).toEqual([fixture.sessionRef]);
    expect(fixture.sessionRef).toMatch(/^[0-9a-f]{64}$/);
    // 链接里除了会话引用之外的字段都是审查身份，不含主机配置或密码。
    const forbidden = ["password", "secret", "identityFile", "defaultPath", "authMethod", "host=", "user="];
    for (const field of forbidden) expect(fixture.deepLink).not.toContain(field);
    expect(fixture.deepLink).not.toContain(fixture.secretSentinel);
  });

  it("前端不调用尚未接线的 host-sync IPC 命令", () => {
    // 本版本没有 host-sync 的应用内命令：前端源码里不能出现这两条 invoke，
    // 否则运行时会报 Command not found。
    const frontendFiles = ["src/lib/remote-worktree.ts", "src/App.svelte"];
    for (const path of frontendFiles) {
      const source = read(path);
      expect(source).not.toContain("remote_host_sync_begin");
      expect(source).not.toContain("remote_host_sync_receive");
    }
    // 解析结果仍然保留：审查来源上带可选的 hostSync 引用。
    expect(read("src/lib/remote-worktree.ts")).toContain("hostSync?: string | null;");
  });

  it("审查链接只把 hostSync 当作可选的 64 位十六进制引用", () => {
    const review = read("src-tauri/src/remote_worktree/review.rs");
    expect(review).toContain('values.remove("hostSync")');
    expect(review).toContain('result.host_sync.as_deref().is_some_and(|v| !hex(v, 64))');
    // 返回事件只回审查事实：同步引用不外溢。
    expect(review).not.toContain('.append_pair("hostSync"');
  });

  it("同步回执只描述状态，不把密码或配置回显到界面文案", () => {
    for (const item of fixture.cases) {
      const result = item.receive as HostSyncResult;
      const message = hostSyncMessage(result);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain(fixture.secretSentinel);
      expect(message).not.toMatch(/password|密码[:：]\s*\S/);
      // 回执本身也没有秘密字段：只有 state。
      for (const receipt of result.receipts) {
        expect(Object.keys(receipt).sort()).toEqual(["kind", "state"]);
      }
    }
  });

  it("一致时不声明任何写入，且会话立即关闭", () => {
    const consistent = fixture.cases.find((item: { name: string }) => item.name === "consistent").receive as HostSyncResult;
    expect(consistent.receipts).toEqual([
      { kind: "config", state: "unchanged" },
      { kind: "password", state: "unchanged" },
    ]);
    expect(consistent.sessionClosed).toBe(true);
    expect(hostSyncMessage(consistent)).toContain("没有取回或改写任何内容");
  });

  it("配置差异与仅密码差异各自只声明自己那一路写入", () => {
    const fetchConfig = fixture.cases.find((item: { name: string }) => item.name === "fetch-config").receive as HostSyncResult;
    expect(hostSyncMessage(fetchConfig)).toContain("配置已写入本机");
    expect(hostSyncMessage(fetchConfig)).not.toContain("密码已写入本机");
    const passwordOnly = fixture.cases.find((item: { name: string }) => item.name === "password-only").receive as HostSyncResult;
    expect(hostSyncMessage(passwordOnly)).toContain("密码已写入本机");
    expect(hostSyncMessage(passwordOnly)).not.toContain("配置已写入本机");
  });

  it("部分失败、未知与未关联冲突都必须说清下一步", () => {
    const partial = fixture.cases.find((item: { name: string }) => item.name === "partial").receive as HostSyncResult;
    expect(hostSyncMessage(partial)).toContain("配置已保存");
    expect(hostSyncMessage(partial)).toContain("原密码仍保留");
    expect(partial.sessionClosed).toBe(false);
    const unknown = fixture.cases.find((item: { name: string }) => item.name === "unknown").receive as HostSyncResult;
    expect(hostSyncMessage(unknown)).toContain("无法比较");
    const association = fixture.cases.find((item: { name: string }) => item.name === "association-required").receive as HostSyncResult;
    expect(hostSyncMessage(association)).toContain("需要先选定");
    expect(association.sessionClosed).toBe(false);
    // 同地址但已关联到别的共享标识：只报冲突，不声明任何写入。
    const conflict = fixture.cases.find((item: { name: string }) => item.name === "association-conflict").receive as HostSyncResult;
    expect(conflict.result).toBe("association_conflict");
    expect(conflict.receipts).toEqual([]);
    expect(conflict.sessionClosed).toBe(false);
    expect(hostSyncMessage(conflict)).toContain("另一个共享标识");
    expect(hostSyncMessage(conflict)).toContain("没有写入任何内容");
  });

  it("原生实现只把结构化结果写到 stdout，密码只以状态出现在回执里", () => {
    const native = read("src-tauri/src/remote_ssh_sync.rs");
    // helper 只打一行 JSON；错误只回错误码，不带诊断文本。
    expect(native).toContain('println!("{value}")');
    expect(native).toContain('eprintln!("{}", json!({ "error": failure.code }))');
    // 回执里的 password 字段是状态字符串，不是秘密本身。
    expect(native).toContain('"password": password_state.as_str()');
    expect(native).toContain('"password": { "state": state, "proof": proof_value }');
    // 会话文件里没有任何秘密字段。
    expect(native).not.toMatch(/struct Session[^}]*password\s*:/s);
    expect(native).not.toMatch(/struct HostConfig[^}]*password\s*:/s);
  });

  it("同步不改动其他主机，也不发起 SSH 连接", () => {
    const native = read("src-tauri/src/remote_ssh_sync.rs");
    // 宿主扫描只用本机主机簿与钥匙串，没有任何 ssh 调用。
    expect(native).not.toContain('Command::new("ssh")');
    expect(native).not.toContain("SshExec");
    // 接收侧只按关联 id 或显式选择写入单条记录。
    expect(native).toContain("save_remote_ssh_target");
  });
});
