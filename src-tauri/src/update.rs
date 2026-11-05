//! 应用内更新：启动后的静默自动检查，以及更新可用事件的负载构造。
//!
//! 自动检查由 lib.rs 的 setup 延迟 20 秒触发；此处只负责静默边界与
//! `twiglane:update-available` 事件的 payload（camelCase，对齐 ipc 惯例）。

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_updater::UpdaterExt;

/// 自动检查发现新版本时发给前端的事件名。
const UPDATE_AVAILABLE_EVENT: &str = "twiglane:update-available";

/// 安装支持判定：仅 Linux 非 AppImage（例如 deb 安装）为 false。
fn install_supported_on(linux: bool, has_appimage: bool) -> bool {
    !linux || has_appimage
}

/// 当前进程的安装支持判定。AppImage 运行时才有 APPIMAGE 环境变量。
fn install_supported() -> bool {
    install_supported_on(
        cfg!(target_os = "linux"),
        std::env::var_os("APPIMAGE").is_some(),
    )
}

#[derive(Clone, Debug, Serialize)]
struct UpdateAvailable {
    version: String,
    notes: String,
    #[serde(rename = "installSupported")]
    install_supported: bool,
}

/// 静默自动检查：updater 不可用（密钥/端点未配置）或检查失败一律直接
/// 返回，不 emit 也不打断启动。
pub(crate) async fn auto_check_update<R: Runtime>(app: &AppHandle<R>) {
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(_) => return,
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) | Err(_) => return,
    };
    let notes = update.body.unwrap_or_default();
    emit_update_available(app, &update.version, notes);
}

fn emit_update_available<R: Runtime>(app: &AppHandle<R>, version: &str, notes: String) {
    let _ = app.emit(
        UPDATE_AVAILABLE_EVENT,
        UpdateAvailable {
            version: version.to_string(),
            notes,
            install_supported: install_supported(),
        },
    );
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    use tauri::Listener;

    use super::{auto_check_update, emit_update_available, install_supported,
                install_supported_on, UPDATE_AVAILABLE_EVENT};

    /// 注册 updater 插件的 mock app：插件配置只给最小必填 pubkey、无端点，
    /// `updater()` 会因端点缺失返回 Err，即真实“updater 不可用”路径，
    /// 且不会发起任何网络请求。
    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context
            .config_mut()
            .plugins
            .0
            .insert("updater".to_string(), serde_json::json!({ "pubkey": "" }));
        tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .expect("mock app")
    }

    /// 三种取值：linux 且无 APPIMAGE（deb）→ false；linux 且有 → true；非 linux → true。
    #[test]
    fn install_supported_covers_all_three_values() {
        assert!(!install_supported_on(true, false), "linux 非 AppImage");
        assert!(install_supported_on(true, true), "linux AppImage");
        assert!(install_supported_on(false, false), "非 linux");
        // 当前平台的实际取值与判定函数一致。
        assert_eq!(
            install_supported(),
            install_supported_on(
                cfg!(target_os = "linux"),
                std::env::var_os("APPIMAGE").is_some()
            )
        );
    }

    /// updater 不可用（未注册/密钥未配置）时静默返回：不 panic、不 emit。
    #[tokio::test]
    async fn auto_check_is_silent_when_updater_unavailable() {
        let app = mock_app();
        let emitted = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&emitted);
        app.listen_any(UPDATE_AVAILABLE_EVENT, move |_| {
            flag.store(true, Ordering::SeqCst);
        });
        auto_check_update(app.handle()).await;
        assert!(
            !emitted.load(Ordering::SeqCst),
            "updater 不可用时不应 emit"
        );
    }

    /// emit 的 payload 为 {version, notes, installSupported}。
    #[test]
    fn emit_payload_is_camel_case_with_install_supported() {
        let app = mock_app();
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = Arc::clone(&seen);
        app.listen_any(UPDATE_AVAILABLE_EVENT, move |event| {
            sink.lock().expect("payload sink").push(event.payload().to_string());
        });
        emit_update_available(app.handle(), "9.9.9", "修复若干问题".to_string());
        let payloads = seen.lock().expect("payloads");
        assert_eq!(payloads.len(), 1, "应恰好 emit 一次");
        let value: serde_json::Value = serde_json::from_str(&payloads[0]).expect("json payload");
        assert_eq!(value["version"], "9.9.9");
        assert_eq!(value["notes"], "修复若干问题");
        assert_eq!(
            value["installSupported"],
            serde_json::Value::Bool(install_supported())
        );
        assert!(
            value.get("install_supported").is_none(),
            "字段应为 camelCase"
        );
    }
}
