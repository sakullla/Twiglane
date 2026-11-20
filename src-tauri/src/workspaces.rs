//! Shared project-workspace-v1 file boundary. Private runtime state stays in state.json.
use crate::error::AppError;
use crate::state::{AppStore, Persisted};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{atomic::Ordering, Arc};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const MAX_REVISION: u64 = 9_007_199_254_740_991;
const MAX_MANIFEST: u64 = 8 * 1024 * 1024;
const MAX_WORKSPACE_URL_LEN: usize = 16_384;
const WORKSPACE_HOST: &str = "workspace";
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestLocation {
    pub host_id: String,
    pub path: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestRepository {
    pub id: String,
    pub name: String,
    pub locations: Vec<ManifestLocation>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub workspace_id: String,
    pub name: String,
    pub revision: u64,
    pub repositories: Vec<ManifestRepository>,
}
fn text(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "目录名称无法用当前系统文字编码表示".into())
}
fn name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 160 || value.chars().any(char::is_control) {
        return Err("名称需为 1 至 160 个非控制字符".into());
    }
    Ok(value.into())
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn private_file(file: &File) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = file;
    Ok(())
}
struct ManifestLock(File);
impl Drop for ManifestLock {
    fn drop(&mut self) {
        // Unlock explicitly: a concurrent fork may temporarily inherit the open file
        // description, so closing only our descriptor need not release its flock yet.
        let _ = self.0.unlock();
    }
}
fn lock_file(path: &Path) -> Result<ManifestLock, String> {
    let mut lock_name = path.as_os_str().to_os_string();
    lock_name.push(".lock");
    let lock_path = PathBuf::from(lock_name);
    if fs::symlink_metadata(&lock_path).is_ok_and(|metadata| !metadata.file_type().is_file()) {
        return Err("项目清单锁不是普通文件，未打开".into());
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(|e| format!("无法锁定项目清单：{e}"))?;
    private_file(&file)?;
    match file.try_lock() {
        Ok(()) => Ok(ManifestLock(file)),
        Err(std::fs::TryLockError::WouldBlock) => {
            Err("项目清单正在其他窗口更新，请稍后重试".into())
        }
        Err(std::fs::TryLockError::Error(error)) => Err(format!("项目清单锁定失败：{error}")),
    }
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("文件没有父目录")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    private_file(temp.as_file())?;
    temp.write_all(bytes).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}
/// Shared only between local products; never export this token as a credential.
/// The token marks path provenance, it does not authorize filesystem access.
#[cfg_attr(test, allow(dead_code))]
pub fn local_host_id() -> Result<String, String> {
    // Serialize this process's brief identity initialization/read; another application's lock remains retryable busy.
    static HOST_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _gate = HOST_GATE.lock().unwrap_or_else(|e| e.into_inner());
    let root = dirs::data_local_dir()
        .ok_or("无法确定本机数据目录")?
        .join("sakullla")
        .join("workspace-identity");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    host_id_at(&root.join("host-id"))
}
fn host_id_at(path: &Path) -> Result<String, String> {
    let _lock = lock_file(path)?;
    match fs::read_to_string(path) {
        Ok(value) => {
            let value = value.trim();
            Uuid::parse_str(value).map_err(|_| "本机项目身份文件损坏，原文件已保留")?;
            Ok(value.into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let id = Uuid::new_v4().to_string();
            atomic_write(path, id.as_bytes())?;
            Ok(id)
        }
        Err(error) => Err(error.to_string()),
    }
}
fn absolute_location_path(path: &str) -> bool {
    fn drive(path: &str) -> bool {
        let bytes = path.as_bytes();
        bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\')
    }
    fn unc(tail: &str) -> bool {
        let mut parts = tail.split(['/', '\\']);
        let server = parts.next().unwrap_or_default();
        let share = parts.next().unwrap_or_default();
        let valid = |value: &str| {
            !value.is_empty() && !matches!(value, "." | ".." | "?") && !value.contains(':')
        };
        valid(server) && valid(share)
    }
    // Rust's Windows canonicalize returns these extended disk path forms.
    if let Some(tail) = path.strip_prefix(r"\\?\") {
        return tail
            .strip_prefix(r"UNC\")
            .map(unc)
            .unwrap_or_else(|| drive(tail));
    }
    if let Some(tail) = path.strip_prefix(r"\\").or_else(|| path.strip_prefix("//")) {
        return unc(tail);
    }
    path.starts_with('/') || drive(path)
}

pub fn validate_manifest(value: &Manifest) -> Result<(), String> {
    if value.schema_version != 1 {
        return Err("项目清单版本不受支持，请更新应用；原文件已保留".into());
    }
    Uuid::parse_str(&value.workspace_id).map_err(|_| "项目 ID 无效")?;
    name(&value.name)?;
    if value.revision == 0 || value.revision > MAX_REVISION {
        return Err("项目清单版本号无效".into());
    }
    let mut ids = HashSet::new();
    let mut positions = HashSet::new();
    for repo in &value.repositories {
        Uuid::parse_str(&repo.id).map_err(|_| "仓库 ID 无效")?;
        name(&repo.name)?;
        if !ids.insert(&repo.id) {
            return Err("项目清单含重复仓库 ID".into());
        }
        for location in &repo.locations {
            Uuid::parse_str(&location.host_id).map_err(|_| "工作位置的主机 ID 无效")?;
            if location.path.is_empty()
                || location.path.chars().any(char::is_control)
                || location.path.len() > 16_384
            {
                return Err("工作位置路径无效".into());
            }
            // Foreign-platform absolute hints are valid data, never implicitly local paths.
            if !absolute_location_path(&location.path) {
                return Err("工作位置必须为完整绝对路径".into());
            }
            if !positions.insert((&location.host_id, &location.path)) {
                return Err("项目清单含重复工作位置".into());
            }
        }
    }
    Ok(())
}
fn read_manifest(path: &Path) -> Result<(Manifest, String), String> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| !metadata.file_type().is_file()) {
        return Err("项目清单来源已变化，需重新选择普通文件".into());
    }
    let mut file = File::open(path).map_err(|e| format!("项目清单无法读取：{e}"))?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_MANIFEST {
        return Err("项目清单过大，未读取或覆盖".into());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_MANIFEST + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_MANIFEST {
        return Err("项目清单过大，未读取或覆盖".into());
    }
    let value: Manifest =
        serde_json::from_slice(&bytes).map_err(|e| format!("项目清单格式无效：{e}"))?;
    validate_manifest(&value)?;
    Ok((value, digest(&bytes)))
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub manifest: Manifest,
    pub source_path: Option<String>,
    pub digest: Option<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub favorites: HashSet<String>,
    /// Verified canonical checkout -> Git common directory; never exported to the shared file.
    #[serde(default)]
    pub bindings: BTreeMap<String, String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preview {
    pub manifest: Manifest,
    pub path: String,
    pub digest: String,
    pub conflict: bool,
    /// 深链指定的来源仓库；普通“打开项目清单”为 None。
    #[serde(default)]
    pub source_repository_id: Option<String>,
    /// 本机名单已与这份内容一致：不必再确认关联，可直接续接来源仓库。
    #[serde(default)]
    pub attached: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Projects {
    pub host_id: String,
    pub projects: Vec<Project>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub path: String,
    pub name: String,
    pub common_directory: Option<String>,
    pub repository_id: Option<String>,
    pub error: Option<String>,
}
#[derive(Default)]
pub struct Discovery(pub std::sync::atomic::AtomicBool);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryResult {
    pub candidates: Vec<Candidate>,
    pub cancelled: bool,
    pub partial: bool,
}
fn failure(message: impl Into<String>) -> AppError {
    AppError::new("workspace", message)
}
fn conflict() -> AppError {
    AppError::new(
        "workspace_conflict",
        "项目名单已变化，请刷新或重新预览；未覆盖任何文件。",
    )
}
fn canonical_source(path: &str, new: bool) -> Result<PathBuf, AppError> {
    let path = Path::new(path);
    if !path.is_absolute()
        || path.extension().is_none_or(|ext| ext != "json")
        || !path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().ends_with(".dev-workspace.json"))
    {
        return Err(failure("请选择绝对路径的 *.dev-workspace.json 项目清单"));
    }
    if new {
        let parent = dunce::canonicalize(path.parent().ok_or_else(|| failure("文件没有父目录"))?)
            .map_err(|e| failure(e.to_string()))?;
        Ok(parent.join(path.file_name().ok_or_else(|| failure("文件名无效"))?))
    } else {
        dunce::canonicalize(path).map_err(|e| failure(format!("项目清单无法读取：{e}")))
    }
}
#[cfg(not(test))]
fn host_id_for(_store: &AppStore) -> Result<String, String> {
    local_host_id()
}
#[cfg(test)]
fn host_id_for(store: &AppStore) -> Result<String, String> {
    // Each fixture owns its provenance boundary; parallel tests must never lock the user's token.
    host_id_at(&store.path().parent().unwrap().join("test-host-id"))
}
pub fn list(store: &AppStore) -> Result<Projects, AppError> {
    Ok(Projects {
        host_id: host_id_for(store).map_err(failure)?,
        projects: store.snapshot().workspaces,
    })
}
pub fn create(store: &AppStore, title: &str) -> Result<Projects, AppError> {
    let title = name(title).map_err(failure)?;
    store.update(|state| {
        state.workspaces.push(Project {
            manifest: Manifest {
                schema_version: 1,
                workspace_id: Uuid::new_v4().to_string(),
                name: title,
                revision: 1,
                repositories: Vec::new(),
            },
            source_path: None,
            digest: None,
            error: None,
            favorites: HashSet::new(),
            bindings: BTreeMap::new(),
        });
        Ok(())
    })?;
    list(store)
}
pub fn delete(store: &AppStore, id: &str) -> Result<Projects, AppError> {
    store.update(|state| {
        let index = project_index(state, id)?;
        state.workspaces.remove(index);
        Ok(())
    })?;
    list(store)
}
fn decode_percent(raw: &str) -> Result<String, AppError> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes
                .get(index + 1..index + 3)
                .ok_or_else(|| failure("项目清单链接里的百分号编码不完整"))?;
            let text = std::str::from_utf8(hex)
                .map_err(|_| failure("项目清单链接里的百分号编码不完整"))?;
            let byte = u8::from_str_radix(text, 16)
                .map_err(|_| failure("项目清单链接里的百分号编码不合法"))?;
            out.push(byte);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).map_err(|_| failure("项目清单链接里的百分号编码不是合法 UTF-8"))
}
fn encode_percent(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
/// Forward-compatible workspace deep link v2+: an absolute `file` and a member `repository` UUID
/// are required exactly once; `v` must be an integer of at least 2. Unknown query parameters are
/// ignored so a newer sender can add fields without breaking an older receiver. A v1 project link
/// and a missing or repeated required field are rejected before anything is read.
pub struct WorkspaceLink {
    pub file: String,
    pub repository_id: String,
}
fn parse_workspace_link_with_scheme(
    url: &str,
    expected_scheme: &str,
) -> Result<WorkspaceLink, AppError> {
    if url.len() > MAX_WORKSPACE_URL_LEN {
        return Err(failure("项目清单链接超过长度上限"));
    }
    if url.chars().any(|ch| ch.is_control() || ch.is_whitespace()) {
        return Err(failure("项目清单链接含控制字符或未编码空格"));
    }
    if url.contains('#') {
        return Err(failure("项目清单链接不接受 fragment"));
    }
    let rest = url
        .strip_prefix(expected_scheme)
        .and_then(|tail| tail.strip_prefix("://"))
        .ok_or_else(|| failure("项目清单链接协议不受支持"))?;
    let (host, query) = rest
        .split_once('?')
        .ok_or_else(|| failure("项目清单链接缺少查询参数"))?;
    if host.strip_suffix('/').unwrap_or(host) != WORKSPACE_HOST || query.contains('?') {
        return Err(failure("项目清单链接目标不是 workspace 或格式无效"));
    }
    let mut version: Option<String> = None;
    let mut file: Option<String> = None;
    let mut repository: Option<String> = None;
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let Some((raw_key, raw_value)) = pair.split_once('=') else {
            if matches!(pair, "v" | "file" | "repository") {
                return Err(failure("项目清单链接查询参数缺少键值分隔"));
            }
            // A newer sender may add bare or free-form parameters; they carry no meaning here.
            continue;
        };
        match raw_key {
            "v" => {
                if version.is_some() {
                    return Err(failure("项目清单链接含重复参数 v"));
                }
                version = Some(decode_percent(raw_value)?);
            }
            "file" => {
                if file.is_some() {
                    return Err(failure("项目清单链接含重复参数 file"));
                }
                file = Some(decode_percent(raw_value)?);
            }
            "repository" => {
                if repository.is_some() {
                    return Err(failure("项目清单链接含重复参数 repository"));
                }
                repository = Some(decode_percent(raw_value)?);
            }
            // Unknown parameters are ignored for forward compatibility.
            _ => {}
        }
    }
    // v1 carries no source repository; later versions keep the same required fields and
    // preview semantics, so an older receiver can accept them without guessing.
    let supported = version
        .as_deref()
        .and_then(|value| value.parse::<u32>().ok())
        .is_some_and(|value| value >= 2);
    if !supported {
        return Err(failure(
            "仅支持 v=2 及更新的项目清单链接，旧版项目链接请重新发起",
        ));
    }
    let file = file.filter(|value| !value.is_empty()).ok_or_else(|| {
        failure("项目清单链接缺少 file 参数")
    })?;
    if file.len() > MAX_WORKSPACE_URL_LEN
        || file.chars().any(char::is_control)
        || file.starts_with('~')
        || !absolute_location_path(&file)
        || !Path::new(&file).is_absolute()
    {
        return Err(failure("项目清单链接里的文件路径必须是本机绝对路径"));
    }
    let repository_id = repository
        .filter(|value| !value.is_empty())
        .ok_or_else(|| failure("项目清单链接缺少 repository 参数"))?;
    if Uuid::parse_str(&repository_id).is_err() {
        return Err(failure("项目清单链接里的 repository 不是有效仓库 ID"));
    }
    Ok(WorkspaceLink {
        file,
        repository_id,
    })
}
pub fn parse_workspace_url(url: &str) -> Result<WorkspaceLink, AppError> {
    parse_workspace_link_with_scheme(url, "twiglane")
}
/// Preview-only deep-link entry
/// (`twiglane://workspace?v=2&file=<abs-path>&repository=<member-uuid>`).
/// Never auto-adopts a manifest or executes Git; a repository outside this manifest is refused.
pub fn preview_link(store: &AppStore, url: &str) -> Result<Preview, AppError> {
    let link = parse_workspace_url(url)?;
    let mut observed = preview(store, &link.file)?;
    if !observed
        .manifest
        .repositories
        .iter()
        .any(|repo| repo.id == link.repository_id)
    {
        return Err(failure("项目清单里没有链接指定的仓库，未打开任何项目"));
    }
    observed.source_repository_id = Some(link.repository_id);
    Ok(observed)
}
pub fn build_cliora_workspace_url(path: &str, repository_id: &str) -> Result<String, AppError> {
    let canonical = canonical_source(path, false)?;
    if fs::symlink_metadata(&canonical).is_ok_and(|metadata| !metadata.file_type().is_file()) {
        return Err(failure("项目清单来源已变化，需重新选择普通文件"));
    }
    // Only a current member is a source repository: read the shared file before building a link,
    // so the other product never receives a repository id this manifest does not carry.
    let (manifest, _) = read_manifest(&canonical).map_err(failure)?;
    if !manifest
        .repositories
        .iter()
        .any(|repo| repo.id == repository_id)
    {
        return Err(failure("这份共享清单没有该仓库，请刷新项目成员后重试"));
    }
    let file = text(&canonical).map_err(failure)?;
    let url = format!(
        "cliora://workspace?v=2&file={}&repository={}",
        encode_percent(&file),
        encode_percent(repository_id)
    );
    parse_workspace_link_with_scheme(&url, "cliora")?;
    Ok(url)
}
pub fn open_in_cliora<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    path: &str,
    repository_id: &str,
) -> Result<(), AppError> {
    let url = build_cliora_workspace_url(path, repository_id)?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|error| AppError::new("cliora_unavailable", format!("无法唤起 cliora：{error}")))
}
pub fn preview(store: &AppStore, path: &str) -> Result<Preview, AppError> {
    let path = canonical_source(path, false)?;
    let (manifest, digest) = read_manifest(&path).map_err(failure)?;
    let conflict = store.snapshot().workspaces.iter().any(|project| {
        project.manifest.workspace_id == manifest.workspace_id && project.manifest != manifest
    });
    let attached = store.snapshot().workspaces.iter().any(|project| {
        project.manifest.workspace_id == manifest.workspace_id && project.manifest == manifest
    });
    Ok(Preview {
        manifest,
        digest,
        path: text(&path).map_err(failure)?,
        conflict,
        source_repository_id: None,
        attached,
    })
}
/// Read identity using the same on-disk Git layout as the existing HEAD/worktree reader.
/// Actual status/open commands still revalidate via GitScheduler before any Git operation.
fn identity(path: &str) -> Option<(String, String)> {
    let input = Path::new(path);
    if !input.is_absolute() {
        return None;
    }
    let root = dunce::canonicalize(input).ok()?;
    let git = crate::git::heads::resolve_git_dir(&root)?;
    let common = match fs::read_to_string(git.join("commondir")) {
        Ok(value) => dunce::canonicalize(git.join(value.trim())).ok()?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => dunce::canonicalize(git).ok()?,
        Err(_) => return None,
    };
    Some((text(&root).ok()?, text(&common).ok()?))
}
fn project_index(state: &Persisted, id: &str) -> Result<usize, AppError> {
    state
        .workspaces
        .iter()
        .position(|p| p.manifest.workspace_id == id)
        .ok_or_else(|| failure("项目不存在"))
}
/// Called while the private-store writer mutex is held, before shared-file publication.
/// Only live memberships reserve paths. Replacing/removing a membership retires its old claims.
fn bindings_for(
    state: &Persisted,
    manifest: &Manifest,
    host: &str,
) -> Result<BTreeMap<String, String>, AppError> {
    let mut claimed: BTreeMap<String, String> = BTreeMap::new();
    let mut commons: BTreeMap<String, String> = BTreeMap::new();
    for project in &state.workspaces {
        if project.manifest.workspace_id == manifest.workspace_id {
            continue;
        }
        for repo in &project.manifest.repositories {
            for location in repo.locations.iter().filter(|l| l.host_id == host) {
                let Some((path, common)) = identity(&location.path) else {
                    continue;
                };
                claimed.insert(path, repo.id.clone());
                commons.insert(common, repo.id.clone());
            }
        }
    }
    let mut bindings = BTreeMap::new();
    let previous = state
        .workspaces
        .iter()
        .find(|p| p.manifest.workspace_id == manifest.workspace_id);
    for repo in &manifest.repositories {
        for location in repo.locations.iter().filter(|l| l.host_id == host) {
            let Some((path, common)) = identity(&location.path) else {
                continue;
            };
            if claimed.get(&path).is_some_and(|id| id != &repo.id)
                || commons.get(&common).is_some_and(|id| id != &repo.id)
            {
                return Err(failure(format!(
                    "仓库关联冲突：{path} 已关联另一仓库身份，请修复目录关联"
                )));
            }
            if let Some(old) = previous.and_then(|p| p.bindings.get(&path)) {
                if old != &common {
                    return Err(failure(format!(
                        "目录的 Git 身份已变化：{path}，请重新预览并修复关联"
                    )));
                }
            }
            claimed.insert(path.clone(), repo.id.clone());
            commons.insert(common.clone(), repo.id.clone());
            bindings.insert(path, common);
        }
    }
    Ok(bindings)
}
fn install(
    state: &mut Persisted,
    manifest: Manifest,
    path: Option<String>,
    digest: Option<String>,
    host: &str,
) -> Result<(), AppError> {
    let bindings = bindings_for(state, &manifest, host)?;
    if let Some(project) = state
        .workspaces
        .iter_mut()
        .find(|p| p.manifest.workspace_id == manifest.workspace_id)
    {
        project
            .favorites
            .retain(|id| manifest.repositories.iter().any(|r| &r.id == id));
        project.manifest = manifest;
        project.source_path = path;
        project.digest = digest;
        project.error = None;
        project.bindings = bindings;
    } else {
        state.workspaces.push(Project {
            manifest,
            source_path: path,
            digest,
            error: None,
            favorites: HashSet::new(),
            bindings,
        });
    }
    Ok(())
}
pub fn attach(store: &AppStore, observed: Preview, adopt: bool) -> Result<Projects, AppError> {
    let path = canonical_source(&observed.path, false)?;
    let _lock = lock_file(&path).map_err(failure)?;
    let (manifest, digest) = read_manifest(&path).map_err(failure)?;
    if digest != observed.digest || manifest != observed.manifest {
        return Err(conflict());
    }
    let host = host_id_for(store).map_err(failure)?;
    store.update(|state| {
        if state
            .workspaces
            .iter()
            .any(|p| p.manifest.workspace_id == manifest.workspace_id && p.manifest != manifest)
            && !adopt
        {
            return Err(conflict());
        }
        install(
            state,
            manifest,
            Some(text(&path).map_err(failure)?),
            Some(digest),
            &host,
        )
    })?;
    list(store)
}
pub fn refresh(store: &AppStore, id: &str) -> Result<Projects, AppError> {
    let host = host_id_for(store).map_err(failure)?;
    store.update(|state| {
        let index = project_index(state, id)?;
        let previous = state.workspaces[index].clone();
        let Some(path) = previous.source_path else {
            return Ok(());
        };
        let result = (|| {
            let source = canonical_source(&path, false)?;
            // A replaced symlink/path requires explicit preview, not implicit provenance change.
            if text(&source).map_err(failure)? != path {
                return Err(conflict());
            }
            let _lock = lock_file(&source).map_err(failure)?;
            let (manifest, digest) = read_manifest(&source).map_err(failure)?;
            if manifest.workspace_id != id
                || manifest.revision < previous.manifest.revision
                || (manifest.revision == previous.manifest.revision
                    && previous.digest.as_deref() != Some(&digest))
            {
                return Err(conflict());
            }
            install(state, manifest, Some(path), Some(digest), &host)
        })();
        if let Err(error) = result {
            state.workspaces[index].error = Some(error.message);
        }
        Ok(())
    })?;
    list(store)
}
pub fn favorite(
    store: &AppStore,
    id: &str,
    repository_id: &str,
    enabled: bool,
) -> Result<Projects, AppError> {
    store.update(|state| {
        let index = project_index(state, id)?;
        let p = &mut state.workspaces[index];
        if !p
            .manifest
            .repositories
            .iter()
            .any(|r| r.id == repository_id)
        {
            return Err(failure("仓库不存在"));
        }
        if enabled {
            p.favorites.insert(repository_id.to_owned());
        } else {
            p.favorites.remove(repository_id);
        }
        Ok(())
    })?;
    list(store)
}
pub fn update(
    store: &AppStore,
    mut manifest: Manifest,
    expected_revision: u64,
) -> Result<Projects, AppError> {
    validate_manifest(&manifest).map_err(failure)?;
    let host = host_id_for(store).map_err(failure)?;
    let mut published = false;
    let mut publication_lock = None;
    let result = store.update(|state| {
        let index = project_index(state, &manifest.workspace_id)?;
        let previous = state.workspaces[index].clone();
        if previous.manifest.revision != expected_revision || manifest.revision != expected_revision
        {
            return Err(conflict());
        }
        if previous.error.is_some() {
            return Err(failure("清单来源需要处理，请刷新或重新预览后再编辑"));
        }
        if expected_revision >= MAX_REVISION {
            return Err(failure("项目版本号已达上限"));
        }
        manifest.revision += 1;
        // All predictable local conflicts are checked before shared bytes change.
        bindings_for(state, &manifest, &host)?;
        if let Some(path) = previous.source_path {
            let source = canonical_source(&path, false)?;
            if text(&source).map_err(failure)? != path {
                return Err(conflict());
            }
            publication_lock = Some(lock_file(&source).map_err(failure)?);
            let (current, digest) = read_manifest(&source).map_err(failure)?;
            if current != previous.manifest || previous.digest.as_deref() != Some(&digest) {
                return Err(conflict());
            }
            let bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| failure(e.to_string()))?;
            atomic_write(&source, &bytes).map_err(failure)?;
            published = true;
            // The source lock stays held until install has finished; state writer stays held through persistence.
            install(
                state,
                manifest,
                Some(path),
                Some(crate::workspaces::digest(&bytes)),
                &host,
            )?;
        } else {
            install(state, manifest, None, None, &host)?;
        }
        Ok(())
    });
    drop(publication_lock);
    result.map_err(|e| {
        if published {
            AppError::new(
                "workspace_projection_pending",
                format!(
                    "清单已保存，本机投影待刷新；请刷新项目，不要重复修改。{}",
                    e.message
                ),
            )
        } else {
            e
        }
    })?;
    list(store)
}
pub fn publish(
    store: &AppStore,
    id: &str,
    expected_revision: u64,
    path: &str,
) -> Result<Projects, AppError> {
    let path = canonical_source(path, true)?;
    let host = host_id_for(store).map_err(failure)?;
    let mut published = false;
    let mut publication_lock = None;
    let result = store.update(|state| {
        let index = project_index(state, id)?;
        let project = state.workspaces[index].clone();
        if project.manifest.revision != expected_revision || project.source_path.is_some() {
            return Err(conflict());
        }
        publication_lock = Some(lock_file(&path).map_err(failure)?);
        if path.exists() {
            return Err(failure(
                "目标文件已存在，请打开并预览该清单，或选择新文件名",
            ));
        }
        validate_manifest(&project.manifest).map_err(failure)?;
        bindings_for(state, &project.manifest, &host)?;
        let bytes =
            serde_json::to_vec_pretty(&project.manifest).map_err(|e| failure(e.to_string()))?;
        atomic_write(&path, &bytes).map_err(failure)?;
        published = true;
        install(
            state,
            project.manifest,
            Some(text(&path).map_err(failure)?),
            Some(digest(&bytes)),
            &host,
        )
    });
    drop(publication_lock);
    result.map_err(|e| {
        if published {
            AppError::new(
                "workspace_projection_pending",
                format!(
                    "清单已保存至 {}，请打开此文件恢复本机关联：{}",
                    path.display(),
                    e.message
                ),
            )
        } else {
            e
        }
    })?;
    list(store)
}

pub async fn candidates(
    backend: &crate::git::ops::Backend,
    paths: Vec<String>,
    request_id: u64,
    discovery: Option<Arc<Discovery>>,
) -> Result<Vec<Candidate>, AppError> {
    let cancelled = || {
        discovery
            .as_ref()
            .is_some_and(|scan| scan.0.load(Ordering::Relaxed))
    };
    if paths.is_empty() || cancelled() {
        return Ok(Vec::new());
    }
    backend
        .scheduler
        .read_batch(request_id, async {
            let git = crate::git::ops::require_git(backend).await?;
            let host = host_id_for(&backend.store).map_err(failure)?;
            let locations = backend.store.workspace_locations(&host);
            let scan = discovery.clone();
            let ids = tokio::task::spawn_blocking(move || {
                let mut ids = HashMap::new();
                for (path, id) in locations {
                    if scan
                        .as_ref()
                        .is_some_and(|scan| scan.0.load(Ordering::Relaxed))
                    {
                        break;
                    }
                    if let Some((_, common)) = identity(&path) {
                        ids.entry(common).or_insert(id);
                    }
                }
                ids
            })
            .await
            .map_err(|_| failure("读取项目仓库身份时中断"))?;

            let mut paths = paths.into_iter();
            let mut seen = HashSet::new();
            let mut result = Vec::new();
            while !cancelled() {
                let Some(path) = paths.next() else { break };
                let first = inspect_candidate(backend, &git.path, path, &ids);
                let pair = if let Some(path) = paths.next() {
                    let (first, second) =
                        tokio::join!(first, inspect_candidate(backend, &git.path, path, &ids));
                    [Some(first), Some(second)]
                } else {
                    [Some(first.await), None]
                };
                for mut candidate in pair.into_iter().flatten() {
                    if candidate.error.is_none() && !seen.insert(candidate.path.clone()) {
                        candidate.error = Some("重复工作目录，未再次添加".into());
                    }
                    result.push(candidate);
                }
            }
            Ok(result)
        })
        .await
}

async fn inspect_candidate(
    backend: &crate::git::ops::Backend,
    git: &Path,
    path: String,
    ids: &HashMap<String, String>,
) -> Candidate {
    use crate::git::{
        command::toplevel_command,
        ops::{canonical_existing, repo_key, run_git, validate_input_path},
        schedule::{internal_request_id, JobKind},
    };
    let found = async {
        let root = canonical_existing(&validate_input_path(&path)?)?;
        let (program, args) = toplevel_command(git, &root);
        let output = run_git(
            backend,
            &repo_key(&root),
            JobKind::Read,
            internal_request_id(),
            program,
            args,
            None,
        )
        .await?;
        if output.output.exit_code != 0 {
            return Err(failure("不是可读取的 Git 仓库"));
        }
        let top = std::str::from_utf8(&output.output.stdout)
            .map_err(|_| failure("仓库路径编码无法读取"))?
            .trim_end_matches(['\n', '\r']);
        identity(top).ok_or_else(|| failure("无法确认 Git common directory"))
    }
    .await;
    let (path, common_directory, repository_id, error) = match found {
        Ok((root, common)) => {
            let id = ids.get(&common).cloned();
            (root, Some(common), id, None)
        }
        Err(error) => (path, None, None, Some(error.message)),
    };
    Candidate {
        name: Path::new(&path)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path,
        common_directory,
        repository_id,
        error,
    }
}

/// Bounded to the explicit root; never follow directory symlinks or enter .git metadata.
pub fn discover_paths(
    root: &str,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<(Vec<String>, Vec<Candidate>, bool), AppError> {
    const DIRECTORY_LIMIT: usize = 50_000;
    let root = dunce::canonicalize(crate::git::ops::validate_input_path(root)?)
        .map_err(|e| failure(e.to_string()))?;
    let mut queue = std::collections::VecDeque::from([root]);
    let mut visited = 0;
    let mut paths = Vec::new();
    let mut issues = Vec::new();
    let mut partial = false;
    while let Some(path) = queue.pop_front() {
        if cancel.load(Ordering::Relaxed) {
            return Ok((paths, issues, true));
        }
        visited += 1;
        let mut has_marker = false;
        let mut exact_marker = false;
        let mut case_variants = Vec::new();
        let mut saw_case_variant = false;
        let entries = match fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(error) => {
                if path.join(".git").exists() {
                    paths.push(text(&path).map_err(failure)?);
                }
                partial = true;
                issues.push(Candidate {
                    path: text(&path).map_err(failure)?,
                    name: path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    common_directory: None,
                    repository_id: None,
                    error: Some(format!("目录无法读取：{error}")),
                });
                continue;
            }
        };
        for entry in entries {
            if cancel.load(Ordering::Relaxed) {
                return Ok((paths, issues, true));
            }
            let Ok(entry) = entry else {
                partial = true;
                has_marker |= path.join(".git").exists();
                continue;
            };
            let name = entry.file_name();
            // Confirm only potential markers, including alternate casing on
            // case-insensitive volumes. Never descend into Git metadata.
            if name == ".git" {
                exact_marker = path.join(".git").exists();
                has_marker |= exact_marker;
                continue;
            }
            if name.eq_ignore_ascii_case(".git") && path.join(".git").exists() {
                saw_case_variant = true;
                if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    case_variants.push(entry.path());
                }
                continue;
            }
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => {
                    if visited + queue.len() >= DIRECTORY_LIMIT {
                        partial = true;
                        has_marker |= path.join(".git").exists();
                        break;
                    }
                    queue.push_back(entry.path());
                }
                Err(_) => partial = true,
                _ => {}
            }
        }
        // Both spellings can coexist on a case-sensitive volume. In that case
        // only the exact .git entry is metadata and the others are searchable.
        if exact_marker {
            for variant in case_variants {
                if visited + queue.len() == DIRECTORY_LIMIT {
                    partial = true;
                    break;
                }
                queue.push_back(variant);
            }
        } else if saw_case_variant {
            has_marker = true;
        }
        if has_marker {
            paths.push(text(&path).map_err(failure)?);
        }
    }
    Ok((paths, issues, partial))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    fn manifest() -> Manifest {
        serde_json::from_str(include_str!(
            "../../tests/fixtures/workspaces/valid-v1.json"
        ))
        .unwrap()
    }
    fn store(dir: &TempDir) -> AppStore {
        AppStore::open(dir.path().join("state.json"))
    }
    fn write_source(dir: &TempDir, value: &Manifest) -> PathBuf {
        let path = dir.path().join("project.dev-workspace.json");
        fs::write(&path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
        path
    }
    #[test]
    fn shared_contract_fixtures_and_absolute_paths_match_cliora() {
        let value = manifest();
        validate_manifest(&value).unwrap();
        assert_eq!(
            serde_json::from_slice::<Manifest>(&serde_json::to_vec(&value).unwrap()).unwrap(),
            value
        );
        let future: Manifest = serde_json::from_str(include_str!(
            "../../tests/fixtures/workspaces/invalid-version.json"
        ))
        .unwrap();
        assert!(validate_manifest(&future).is_err());
        let paths: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/workspaces/path-cases-v1.json"
        ))
        .unwrap();
        for path in paths["valid"].as_array().unwrap() {
            assert!(absolute_location_path(path.as_str().unwrap()), "{path}");
        }
        for path in paths["invalid"].as_array().unwrap() {
            assert!(!absolute_location_path(path.as_str().unwrap()), "{path}");
        }
        let mut unknown = serde_json::to_value(&value).unwrap();
        unknown["credentials"] = "not allowed".into();
        assert!(serde_json::from_value::<Manifest>(unknown).is_err());
        let mut invalid = value;
        invalid.revision = MAX_REVISION + 1;
        assert!(validate_manifest(&invalid).is_err());
        invalid.revision = 1;
        invalid.repositories[0].locations[0].path = "C:relative".into();
        assert!(validate_manifest(&invalid).is_err());
    }
    #[test]
    fn shared_host_token_is_atomic_locked_and_never_recreated_when_corrupt() {
        let dir = TempDir::new("workspace-host");
        let path = dir.path().join("host-id");
        let id = host_id_at(&path).unwrap();
        assert_eq!(host_id_at(&path).unwrap(), id);
        let lock = lock_file(&path).unwrap();
        assert!(host_id_at(&path).unwrap_err().contains("其他窗口"));
        drop(lock);
        assert_eq!(host_id_at(&path).unwrap(), id);
        fs::write(&path, "corrupt").unwrap();
        assert!(host_id_at(&path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "corrupt");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn preview_digest_attach_is_idempotent_and_refresh_retains_error_snapshot() {
        let dir = TempDir::new("workspace-attach");
        let store = store(&dir);
        let initial = manifest();
        let path = write_source(&dir, &initial);
        let observed = preview(&store, path.to_str().unwrap()).unwrap();
        attach(&store, observed.clone(), false).unwrap();
        attach(&store, observed, false).unwrap();
        assert_eq!(store.snapshot().workspaces.len(), 1);
        fs::write(&path, b"invalid json").unwrap();
        let current = refresh(&store, &initial.workspace_id).unwrap();
        assert_eq!(current.projects[0].manifest, initial);
        assert!(current.projects[0].error.is_some());
        assert!(update(&store, initial.clone(), initial.revision).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"invalid json");
        fs::remove_file(&path).unwrap();
        assert!(refresh(&store, &initial.workspace_id).unwrap().projects[0]
            .error
            .as_ref()
            .unwrap()
            .contains("无法读取"));
    }
    #[test]
    fn stale_preview_same_revision_change_and_rollback_need_explicit_adoption() {
        let dir = TempDir::new("workspace-stale");
        let store = store(&dir);
        let mut value = manifest();
        let path = write_source(&dir, &value);
        let old = preview(&store, path.to_str().unwrap()).unwrap();
        value.name = "peer edit".into();
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(
            attach(&store, old, false).unwrap_err().code,
            "workspace_conflict"
        );
        let fresh = preview(&store, path.to_str().unwrap()).unwrap();
        attach(&store, fresh, false).unwrap();
        value.name = "same revision different content".into();
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(refresh(&store, &value.workspace_id).unwrap().projects[0]
            .error
            .is_some());
        let replacement = preview(&store, path.to_str().unwrap()).unwrap();
        assert!(replacement.conflict);
        assert!(attach(&store, replacement.clone(), false).is_err());
        attach(&store, replacement, true).unwrap();
        assert!(store.snapshot().workspaces[0].error.is_none());
        value.revision += 1;
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        refresh(&store, &value.workspace_id).unwrap();
        value.revision -= 1;
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(refresh(&store, &value.workspace_id).unwrap().projects[0]
            .error
            .is_some());
    }
    #[test]
    fn compare_and_swap_lock_and_atomic_source_edits() {
        let dir = TempDir::new("workspace-cas");
        let store = store(&dir);
        let initial = manifest();
        let path = write_source(&dir, &initial);
        attach(
            &store,
            preview(&store, path.to_str().unwrap()).unwrap(),
            false,
        )
        .unwrap();
        let before = fs::read(&path).unwrap();
        let lock = lock_file(&path).unwrap();
        let mut changed = initial.clone();
        changed.name = "new title".into();
        assert!(update(&store, changed.clone(), initial.revision).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        drop(lock);
        update(&store, changed.clone(), initial.revision).unwrap();
        let (saved, _) = read_manifest(&path).unwrap();
        assert_eq!(saved.revision, initial.revision + 1);
        assert_eq!(saved.name, "new title");
        assert!(update(&store, changed, initial.revision).is_err());
        assert_eq!(read_manifest(&path).unwrap().0, saved);
        assert!(path.with_extension("json.lock").exists());
    }
    #[test]
    fn publish_never_overwrites_existing_source_and_projection_can_recover() {
        let dir = TempDir::new("workspace-publish");
        let store = store(&dir);
        let data = create(&store, "local").unwrap();
        let project = &data.projects[0];
        let id = &project.manifest.workspace_id;
        let path = dir.path().join("local.dev-workspace.json");
        fs::write(&path, b"existing").unwrap();
        assert!(publish(&store, id, 1, path.to_str().unwrap()).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"existing");
        fs::remove_file(&path).unwrap();
        publish(&store, id, 1, path.to_str().unwrap()).unwrap();
        // A real private-store replacement failure after publication must say what was saved.
        let state_path = store.path().to_path_buf();
        fs::remove_file(&state_path).unwrap();
        fs::create_dir(&state_path).unwrap();
        let mut next = project.manifest.clone();
        next.name = "published but projection pending".into();
        let error = update(&store, next, 1).unwrap_err();
        assert_eq!(error.code, "workspace_projection_pending");
        assert_eq!(read_manifest(&path).unwrap().0.revision, 2);
        assert_eq!(store.snapshot().workspaces[0].manifest.revision, 1);
        fs::remove_dir(&state_path).unwrap();
        refresh(&store, id).unwrap();
        assert_eq!(store.snapshot().workspaces[0].manifest.revision, 2);
        assert_eq!(
            AppStore::open(state_path).snapshot().workspaces[0]
                .manifest
                .revision,
            2
        );
    }
    #[test]
    fn live_memberships_reject_identity_conflicts_before_publication_and_removal_retires_claims() {
        let dir = TempDir::new("workspace-bindings");
        let root = dir.path().join("repo");
        fs::create_dir_all(root.join(".git")).unwrap();
        let store = store(&dir);
        let host = host_id_for(&store).unwrap();
        let mut first = manifest();
        first.repositories.truncate(1);
        first.repositories[0].locations = vec![ManifestLocation {
            host_id: host.clone(),
            path: text(&root).unwrap(),
        }];
        let path = write_source(&dir, &first);
        attach(
            &store,
            preview(&store, path.to_str().unwrap()).unwrap(),
            false,
        )
        .unwrap();
        let second_data = create(&store, "other project").unwrap();
        let mut second = second_data.projects[1].manifest.clone();
        second.repositories = first.repositories.clone();
        second.repositories[0].id = Uuid::new_v4().to_string();
        assert!(update(&store, second.clone(), 1).is_err());
        // A predictable identity conflict in an attached manifest cannot change its source bytes.
        let mut changed = first.clone();
        changed.repositories[0].id = Uuid::new_v4().to_string();
        second.repositories[0].id = first.repositories[0].id.clone();
        update(&store, second, 1).unwrap();
        let before = fs::read(&path).unwrap();
        assert!(update(&store, changed.clone(), first.revision).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        let mut second = store.snapshot().workspaces[1].manifest.clone();
        second.repositories.clear();
        update(&store, second.clone(), second.revision).unwrap();
        update(&store, changed.clone(), changed.revision).unwrap();
        assert!(root.exists());
        assert_eq!(
            read_manifest(&path).unwrap().0.repositories[0].id,
            changed.repositories[0].id
        );
    }
    fn git(root: &Path, args: &[&str]) -> Vec<u8> {
        let output = std::process::Command::new(crate::test_support::system_git())
            .current_dir(root)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                crate::test_support::isolated_gitconfig(),
            )
            .env("GIT_AUTHOR_NAME", "Twiglane Test")
            .env("GIT_COMMITTER_NAME", "Twiglane Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    }
    #[test]
    fn discovery_ignores_metadata_with_the_volumes_actual_casing() {
        let fixture = TempDir::new("discovery-case");
        let upper = fixture.path().join(".GIT");
        fs::create_dir_all(upper.join("inner/.git")).unwrap();
        let marker = fixture.path().join(".git");
        let insensitive = marker.exists();
        if !insensitive {
            fs::create_dir_all(marker.join("hidden/.git")).unwrap();
        }
        let (mut found, issues, partial) = discover_paths(
            fixture.path().to_str().unwrap(),
            &std::sync::atomic::AtomicBool::new(false),
        ).unwrap();
        assert!(issues.is_empty() && !partial);
        let mut expected = vec![text(fixture.path()).unwrap()];
        if !insensitive {
            expected.push(text(&upper.join("inner")).unwrap());
        }
        found.sort();
        expected.sort();
        assert_eq!(found, expected);
    }

    #[tokio::test]
    async fn thirty_five_real_repositories_keep_members_and_isolate_selected_git_writes() {
        use crate::git::{changes, ops};
        let fixture = crate::test_support::git_fixture("project-many-real-git");
        let backend = fixture.backend();
        let mut paths = Vec::new();
        for index in 0..35 {
            let root = fixture.repo(if index < 2 { "demo" } else { "service" });
            git(&root, &["init", "-b", "main"]);
            fs::write(root.join("app.txt"), format!("base {index}\n")).unwrap();
            git(&root, &["add", "."]);
            git(&root, &["commit", "-m", "base"]);
            paths.push(text(&root).unwrap());
        }
        let a = PathBuf::from(&paths[0]);
        let b = PathBuf::from(&paths[1]);
        fs::create_dir(a.join("src")).unwrap();
        let from_subdir = candidates(
            &backend,
            vec![text(&a.join("src")).unwrap(), paths[0].clone()],
            100,
            None,
        )
        .await
        .unwrap();
        assert_eq!(from_subdir[0].path, paths[0]);
        assert!(from_subdir[1].error.is_some());
        let linked = fixture.path().join("linked-worktree");
        git(
            &a,
            &["worktree", "add", "-b", "feature", linked.to_str().unwrap()],
        );
        git(
            &a,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                b.to_str().unwrap(),
                "modules/child",
            ],
        );
        let locations = candidates(
            &backend,
            vec![
                paths[0].clone(),
                text(&linked).unwrap(),
                text(&a.join("modules/child")).unwrap(),
            ],
            200,
            None,
        )
        .await
        .unwrap();
        assert_eq!(locations[0].common_directory, locations[1].common_directory);
        assert_ne!(locations[0].common_directory, locations[2].common_directory);
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        let (discovered, issues, partial) =
            discover_paths(fixture.path().to_str().unwrap(), &cancelled).unwrap();
        assert!(!partial);
        assert!(issues.is_empty());
        assert_eq!(discovered.len(), 37);
        let data = create(&backend.store, "35 repositories").unwrap();
        let mut definition = data.projects[0].manifest.clone();
        definition.repositories = paths
            .iter()
            .map(|path| ManifestRepository {
                id: Uuid::new_v4().to_string(),
                name: "independent".into(),
                locations: vec![ManifestLocation {
                    host_id: data.host_id.clone(),
                    path: path.clone(),
                }],
            })
            .collect();
        let main_id = definition.repositories[0].id.clone();
        update(&backend.store, definition, 1).unwrap();
        let checked = candidates(&backend, discovered, 250, None).await.unwrap();
        assert_eq!(checked.len(), 37);
        assert!(checked.iter().all(|candidate| candidate.error.is_none()));
        assert_eq!(checked.iter().filter(|candidate| candidate.repository_id.is_some()).count(), 36);
        let linked_candidate = checked.iter().find(|candidate| Path::new(&candidate.path) == linked).unwrap();
        assert_eq!(linked_candidate.repository_id.as_deref(), Some(main_id.as_str()));
        for path in &paths {
            backend
                .store
                .touch_recent("independent".into(), path.clone())
                .unwrap();
        }
        backend
            .store
            .save_draft(&paths[0], "A draft survives recent cap")
            .unwrap();
        let reopened = AppStore::open(backend.store.path().to_path_buf());
        assert_eq!(reopened.snapshot().recent.len(), 30);
        assert_eq!(
            reopened.snapshot().workspaces[0]
                .manifest
                .repositories
                .len(),
            35
        );
        assert_eq!(reopened.draft(&paths[0]), "A draft survives recent cap");
        let overview = crate::git::heads::worktree_overview(&backend, &paths, 300)
            .await
            .unwrap();
        assert!(overview
            .items
            .iter()
            .any(|item| item.path == paths[0] && item.status == "ready"));
        assert!(overview.items.iter().any(|item| item.linked));
        let before_index = fs::read(b.join(".git/index")).unwrap();
        let before_head = git(&b, &["rev-parse", "HEAD"]);
        let before_status = git(&b, &["status", "--porcelain"]);
        let before_file = fs::read(b.join("app.txt")).unwrap();
        fs::write(a.join("app.txt"), "only A changed\n").unwrap();
        let opened = ops::open_repository(&backend, &paths[0], 400)
            .await
            .unwrap();
        let staged = changes::stage_files(
            &backend,
            &paths[0],
            &["app.txt".into()],
            opened.generation,
            401,
        )
        .await
        .unwrap();
        changes::commit_index(&backend, &paths[0], "only A", staged.generation, 402)
            .await
            .unwrap();
        assert_eq!(fs::read(b.join(".git/index")).unwrap(), before_index);
        assert_eq!(git(&b, &["rev-parse", "HEAD"]), before_head);
        assert_eq!(git(&b, &["status", "--porcelain"]), before_status);
        assert_eq!(fs::read(b.join("app.txt")).unwrap(), before_file);
        cancelled.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(
            discover_paths(fixture.path().to_str().unwrap(), &cancelled)
                .unwrap()
                .2
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn posix_literal_backslash_and_nested_paths_are_distinct_real_repositories() {
        let fixture = crate::test_support::git_fixture("workspace-posix-backslash");
        let backend = fixture.backend();
        let literal = fixture.path().join(r"team\service");
        let nested = fixture.path().join("team/service");
        let mut paths = Vec::new();
        for root in [&literal, &nested] {
            fs::create_dir_all(root).unwrap();
            git(root, &["init", "-b", "main"]);
            fs::write(root.join("app.txt"), "base\n").unwrap();
            git(root, &["add", "."]);
            git(root, &["commit", "-m", "base"]);
            paths.push(text(root).unwrap());
        }
        let found = candidates(&backend, paths.clone(), 800, None).await.unwrap();
        assert!(found.iter().all(|candidate| candidate.error.is_none()));
        assert_ne!(found[0].path, found[1].path);
        assert_ne!(found[0].common_directory, found[1].common_directory);
        let projects = create(&backend.store, "literal and nested").unwrap();
        let mut definition = projects.projects[0].manifest.clone();
        definition.repositories = paths
            .iter()
            .map(|path| ManifestRepository {
                id: Uuid::new_v4().to_string(),
                name: "service".into(),
                locations: vec![ManifestLocation {
                    host_id: projects.host_id.clone(),
                    path: path.clone(),
                }],
            })
            .collect();
        update(&backend.store, definition, 1).unwrap();
        backend
            .store
            .save_draft(&paths[0], "literal draft")
            .unwrap();
        backend.store.save_draft(&paths[1], "nested draft").unwrap();
        for (path, expected) in paths.iter().zip(["literal draft", "nested draft"]) {
            let opened = crate::git::ops::open_repository(&backend, path, 900)
                .await
                .unwrap();
            assert_eq!(opened.summary.path, *path);
            assert_eq!(opened.draft, expected);
        }
        assert_eq!(
            backend.store.snapshot().workspaces[0]
                .manifest
                .repositories
                .len(),
            2
        );
    }
    #[test]
    fn delete_removes_only_target_workspace_and_preserves_manifest_repo_and_drafts() {
        let dir = TempDir::new("workspace-delete");
        let store = store(&dir);
        let root = dir.path().join("repo");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("README.md"), "keep\n").unwrap();
        let host = host_id_for(&store).unwrap();
        let mut shared = manifest();
        shared.repositories.truncate(1);
        shared.repositories[0].locations = vec![ManifestLocation {
            host_id: host.clone(),
            path: text(&root).unwrap(),
        }];
        let source = write_source(&dir, &shared);
        let source_bytes = fs::read(&source).unwrap();
        attach(
            &store,
            preview(&store, source.to_str().unwrap()).unwrap(),
            false,
        )
        .unwrap();
        let after_local = create(&store, "keep-local").unwrap();
        let local_id = after_local.projects[1].manifest.workspace_id.clone();
        store
            .save_draft(&text(&root).unwrap(), "preserved commit draft")
            .unwrap();

        assert!(delete(&store, "missing-workspace-id").is_err());
        let remaining = delete(&store, &shared.workspace_id).unwrap();
        assert_eq!(remaining.projects.len(), 1);
        assert_eq!(remaining.projects[0].manifest.workspace_id, local_id);
        assert_eq!(fs::read(&source).unwrap(), source_bytes);
        assert_eq!(fs::read_to_string(root.join("README.md")).unwrap(), "keep\n");
        assert_eq!(store.draft(&text(&root).unwrap()), "preserved commit draft");

        // Removing the workspace retires its binding claim so another workspace can adopt a new ID for that checkout.
        let mut rebound = remaining.projects[0].manifest.clone();
        rebound.repositories = vec![ManifestRepository {
            id: Uuid::new_v4().to_string(),
            name: "rebound".into(),
            locations: vec![ManifestLocation {
                host_id: host,
                path: text(&root).unwrap(),
            }],
        }];
        update(&store, rebound, 1).unwrap();
    }
    #[test]
    fn workspace_preview_link_validates_required_fields_never_auto_adopts_and_builds_cliora_url() {
        let dir = TempDir::new("workspace-link");
        let store = store(&dir);
        let initial = manifest();
        let member = initial.repositories[0].id.clone();
        let plus_dir = dir.path().join("c++ team");
        fs::create_dir_all(&plus_dir).unwrap();
        let path = plus_dir.join("shared+v1.dev-workspace.json");
        fs::write(&path, serde_json::to_vec_pretty(&initial).unwrap()).unwrap();
        let canonical = dunce::canonicalize(&path).unwrap();
        let encoded = encode_percent(canonical.to_str().unwrap());

        for valid in [
            format!("twiglane://workspace?v=2&file={encoded}&repository={member}"),
            format!("twiglane://workspace/?file={encoded}&v=2&repository={member}"),
            // Unknown parameters and later versions keep the required-field contract.
            format!("twiglane://workspace?v=2&file={encoded}&repository={member}&adopt=1"),
            format!("twiglane://workspace?v=3&file={encoded}&future=1&repository={member}"),
            format!("twiglane://workspace?v=2&&file={encoded}&repository={member}&"),
        ] {
            let observed = preview_link(&store, &valid).unwrap();
            assert_eq!(observed.manifest, initial);
            assert_eq!(observed.path, canonical.to_str().unwrap());
            assert_eq!(observed.source_repository_id.as_deref(), Some(member.as_str()));
            assert!(!observed.attached, "仅预览时本机还没有这份名单");
            assert!(
                store.snapshot().workspaces.is_empty(),
                "preview_link must never auto-adopt"
            );
        }

        // Literal '+' in query stays '+' when unencoded.
        let literal_plus = encoded.replace("%2B", "+").replace("%2b", "+");
        let observed_plus = preview_link(
            &store,
            &format!("twiglane://workspace?v=2&file={literal_plus}&repository={member}"),
        )
        .unwrap();
        assert_eq!(observed_plus.path, canonical.to_str().unwrap());

        let outsider = Uuid::new_v4().to_string();
        for invalid in [
            format!("cliora://workspace?v=2&file={encoded}&repository={member}"),
            format!("https://workspace?v=2&file={encoded}&repository={member}"),
            format!("twiglane://review?v=2&file={encoded}&repository={member}"),
            format!("twiglane://workspace/extra?v=2&file={encoded}&repository={member}"),
            format!("twiglane://user@workspace?v=2&file={encoded}&repository={member}"),
            format!("twiglane://workspace:8080?v=2&file={encoded}&repository={member}"),
            // 旧版 v1 项目链接不再被接受，也不能退化成没有来源仓库的预览。
            format!("twiglane://workspace?v=1&file={encoded}"),
            format!("twiglane://workspace?v=1&file={encoded}&repository={member}"),
            format!("twiglane://workspace?v=two&file={encoded}&repository={member}"),
            format!("twiglane://workspace?file={encoded}&repository={member}"),
            format!("twiglane://workspace?v=2&repository={member}"),
            format!("twiglane://workspace?v=2&file={encoded}"),
            format!("twiglane://workspace?v=2&file={encoded}&repository={outsider}"),
            format!("twiglane://workspace?v=2&file={encoded}&repository=not-a-uuid"),
            format!("twiglane://workspace?v=2&file={encoded}&repository="),
            "twiglane://workspace?v=2".to_string(),
            format!("twiglane://workspace?v=2&v=2&file={encoded}&repository={member}"),
            format!("twiglane://workspace?v=2&file={encoded}&file={encoded}&repository={member}"),
            format!("twiglane://workspace?v=2&file={encoded}&repository={member}&repository={member}"),
            format!("twiglane://workspace?v=2&file={encoded}&repository={member}#frag"),
            format!("twiglane://workspace?v=2&file={} raw&repository={member}", encoded),
            format!("twiglane://workspace?v=2&file={encoded}&repository={member}\n"),
            format!("twiglane://workspace?v=2&file=relative.dev-workspace.json&repository={member}"),
            format!("twiglane://workspace?v=2&file=~/shared.dev-workspace.json&repository={member}"),
            format!("twiglane://workspace?v=2&file=%ZZ&repository={member}"),
            format!("twiglane://workspace?v=2&file={}&repository={member}", "a".repeat(16_385)),
        ] {
            assert!(preview_link(&store, &invalid).is_err(), "{invalid}");
        }
        assert!(store.snapshot().workspaces.is_empty(), "失败的链接不写入任何状态");

        let outbound = build_cliora_workspace_url(path.to_str().unwrap(), &member).unwrap();
        assert!(outbound.starts_with("cliora://workspace?v=2&file="));
        assert!(outbound.ends_with(&format!("&repository={member}")));
        let parsed = parse_workspace_link_with_scheme(&outbound, "cliora").unwrap();
        assert_eq!(parsed.file, canonical.to_str().unwrap());
        assert_eq!(parsed.repository_id, member);
        // 非成员仓库不能被包装成来源仓库直达。
        assert!(build_cliora_workspace_url(path.to_str().unwrap(), &outsider).is_err());
        let non_manifest = plus_dir.join("notes.json");
        fs::write(&non_manifest, "{}").unwrap();
        assert!(build_cliora_workspace_url(non_manifest.to_str().unwrap(), &member).is_err());
    }

    #[test]
    fn workspace_link_reports_a_linked_project_once_and_keeps_membership_untouched() {
        let dir = TempDir::new("workspace-link-attached");
        let store = store(&dir);
        let initial = manifest();
        let member = initial.repositories[0].id.clone();
        let path = write_source(&dir, &initial);
        let canonical = dunce::canonicalize(&path).unwrap();
        let encoded = encode_percent(canonical.to_str().unwrap());
        let link = format!("twiglane://workspace?v=2&file={encoded}&repository={member}");

        let observed = preview_link(&store, &link).unwrap();
        assert!(!observed.attached);
        attach(&store, observed, false).unwrap();
        let again = preview_link(&store, &link).unwrap();
        // 已关联且内容一致：接收端可直接续接，不必再次确认。
        assert!(again.attached);
        assert!(!again.conflict);
        assert_eq!(again.source_repository_id.as_deref(), Some(member.as_str()));
        assert_eq!(store.snapshot().workspaces.len(), 1);
    }
}
