//! 远端边界适配：agent 没有「项目工作区」功能。
//!
//! 共享的 `state` 模块只为设置文件留了一个 `workspaces` 字段，桌面侧的 Project 类型依赖
//! Tauri 打开链接（`open_in_cliora`），不能进入远端进程。这里提供同字段名的最小占位：
//! agent 只写自己的设置文件（`<XDG_STATE_HOME>/twiglane/agent/v2/settings.json`），
//! 从不读取桌面设置，也不会创建或修改工作区项目；未知字段在解析时被忽略。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    #[serde(default)]
    pub manifest: Manifest,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(default)]
    pub repositories: Vec<Repository>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub locations: Vec<Location>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    #[serde(default)]
    pub host_id: String,
    #[serde(default)]
    pub path: String,
}

/// 与桌面同名入口保持签名一致的占位：远端进程不发现、不绑定、不导出工作区。
#[allow(dead_code)]
pub type Bindings = BTreeMap<String, String>;