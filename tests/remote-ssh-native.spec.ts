import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/* ------------------------------------------------------------------ *
 * 远程 SSH 原生契约：前端只经这些命令读写；命令必须在 build.rs 与主窗口
 * capability 中登记；秘密只走钥匙串；Askpass、快照与安装脚本的边界写死在
 * 源码里，改掉任何一条都会在这里失败。
 * 真正的行为断言在 Rust 侧（src-tauri/src/remote_ssh/tests.rs）。
 * ------------------------------------------------------------------ */

const read = (path: string) => readFileSync(path, "utf8");

const COMMANDS = [
  "remote_ssh_settings",
  "set_remote_ssh_enabled",
  "remote_ssh_save_target",
  "remote_ssh_delete_target",
  "remote_ssh_set_password",
  "remote_ssh_delete_password",
  "remote_ssh_test",
  "remote_ssh_cancel",
  "remote_ssh_install_agent",
];

describe("远程 SSH 的命令边界", () => {
  it("前端每个动作只经一条命令，参数保持 camelCase", () => {
    const api = read("src/lib/api.ts");
    expect(api).toContain('invoke<RemoteSshSettings>("remote_ssh_settings")');
    expect(api).toContain('invoke<void>("set_remote_ssh_enabled", { enabled })');
    expect(api).toContain('invoke<SshTarget>("remote_ssh_save_target", { target })');
    expect(api).toContain('invoke<void>("remote_ssh_delete_target", { targetId })');
    expect(api).toContain('invoke<void>("remote_ssh_set_password", { targetId, password })');
    expect(api).toContain('invoke<void>("remote_ssh_delete_password", { targetId })');
    expect(api).toContain('invoke<SshProbe>("remote_ssh_test", { requestId, targetId })');
    expect(api).toContain('invoke<void>("remote_ssh_cancel", { requestId })');
    expect(api).toContain('call<SshInstallOutcome>("remote_ssh_install_agent", { request, onProgress })');
  });

  it("DTO 只有布尔 hasPassword，没有秘密字段", () => {
    const types = read("src/lib/types.ts");
    expect(types).toContain("hasPassword?: boolean;");
    const start = types.indexOf("export interface SshTarget {");
    const end = types.indexOf("}", start);
    const block = types.slice(start, end);
    expect(block).not.toMatch(/password\s*:/);
    expect(block).not.toMatch(/secret\s*:/);
    expect(block).toContain("revision: number;");
    expect(block).toContain("sharedHostId: string | null;");
  });

  it("命令在 build.rs 与主窗口 capability 中登记", () => {
    const build = read("src-tauri/build.rs");
    for (const command of COMMANDS) expect(build).toContain(`"${command}"`);
    const capabilities = read("src-tauri/capabilities/default.json");
    for (const command of COMMANDS) {
      expect(capabilities).toContain(`allow-${command.replace(/_/g, "-")}`);
    }
  });

  it("总开关在设置里缺省关闭，主机记录不含密码字段", () => {
    const state = read("src-tauri/src/state.rs");
    expect(state).toContain("pub struct RemoteSsh");
    expect(state).toMatch(/#\[serde\(default\)\]\n\s+pub enabled: bool,/);
    const start = state.indexOf("pub struct SshTarget {");
    const end = state.indexOf("}", start);
    const block = state.slice(start, end);
    for (const field of [
      "display_name",
      "host",
      "port",
      "user",
      "auth_method",
      "identity_file",
      "ssh_config",
      "default_path",
      "enabled",
      "shared_host_id",
      "revision",
    ]) {
      expect(block).toContain(field);
    }
    expect(block).not.toMatch(/password/);
    expect(block).not.toMatch(/secret/);
  });

  it("SSH 密码用独立钥匙串命名空间，不复用 MR/PR 条目", () => {
    const credential = read("src-tauri/src/change_request/credential.rs");
    expect(credential).toContain('pub const KEYRING_SERVICE: &str = "twiglane.change-request";');
    expect(credential).toContain('pub const REMOTE_SSH_SERVICE: &str = "twiglane.remote-ssh";');
    expect(credential).toContain("pub fn remote_ssh()");
    const ssh = read("src-tauri/src/remote_ssh/mod.rs");
    expect(ssh).toContain("KeyringStore::remote_ssh()");
  });
});

describe("直接 OpenSSH 连接的边界", () => {
  it("连接配置来自 ssh -G 快照并冻结信任与跳板", () => {
    const config = read("src-tauri/src/remote_ssh/config.rs");
    expect(config).toContain('command.arg("-G")');
    expect(config).toContain("userknownhostsfile");
    expect(config).toContain("revokedhostkeys");
    expect(config).toContain("proxyjump");
    expect(config).toContain("StrictHostKeyChecking yes");
    expect(config).toContain("UpdateHostKeys no");
    expect(config).toContain("MAX_HOPS");
  });

  it("不查找也不调用 Cliora 连接器", () => {
    for (const path of [
      "src-tauri/src/remote_ssh/mod.rs",
      "src-tauri/src/remote_ssh/config.rs",
      "src-tauri/src/remote_ssh/transport.rs",
    ]) {
      const source = read(path);
      expect(source).not.toContain("--twiglane-remote-v1");
      expect(source).not.toContain("cliora-twiglane-connector");
      expect(source).not.toContain("CLIORA_TWIGLANE_TEST_DB");
    }
  });

  it("askpass 只回答密码与口令提示，绝不回答主机密钥问题", () => {
    const password = read("src-tauri/src/remote_ssh/password.rs");
    expect(password).toContain("TWIGLANE_SSH_ASKPASS_SECRET");
    expect(password).toContain("authenticity");
    expect(password).toContain("fingerprint");
    expect(password).toContain("yes/no");
    expect(password).toContain("0o600");
  });

  it("安装脚本先写临时文件、核对摘要、再原子替换", () => {
    const transport = read("src-tauri/src/remote_ssh/transport.rs");
    expect(transport).toContain(".incoming.$$");
    expect(transport).toContain("agent_digest_mismatch");
    expect(transport).toContain('"mv -f ');
    expect(transport).toContain("twiglane-agent-v2");
    expect(transport).toContain("agent/v2");
    // 只有校验过的十六进制摘要可以拼进远端命令。
    expect(transport).toContain("fn checked_hex");
  });

  it("按 system/architecture 选择签名产物，没有匹配项就明确失败", () => {
    const artifact = read("src-tauri/src/remote_ssh/artifact.rs");
    expect(artifact).toContain("pub(crate) fn normalize");
    expect(artifact).toContain("agent_artifact_unavailable");
    expect(artifact).toContain("agent_digest_mismatch");
    expect(artifact).toContain("agent_artifact_signature");
    expect(artifact).toContain("manifest.json");
    expect(artifact).toContain("MAX_ARTIFACT_BYTES");
    const ssh = read("src-tauri/src/remote_ssh/mod.rs");
    // 复用已安装组件前先握手；不兼容才进入确认安装。
    expect(ssh).toContain("agent_compatible");
    expect(ssh).toContain("install_required");
    expect(ssh).toContain("confirmationId");
  });
});
