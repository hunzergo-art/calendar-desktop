//! IPC 命令。前端 `invoke` 的每一个入口都在这里。
//!
//! 约定：
//!   * 返回值直接给前端；错误统一转成 `String`（Tauri 要求可序列化）。
//!   * **任何改动内存的写操作，最后都要 `persist()`**，否则改的只是内存，
//!     关掉程序就没了。
//!   * 写操作成功后 `emit` 一次 `archive-changed`，三个窗口各自刷新。

use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::import_export::{self, ImportMode, MergeStats};
use crate::model::*;
use crate::storage::{self, BackupEntry};
use crate::{window, AppState, UndoEntry};

/// 存档变更后广播的事件名。三个窗口都监听它。
pub const EVENT_ARCHIVE_CHANGED: &str = "archive-changed";

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// 广播最新存档。前端拿到的是完整快照——数据量在个人使用的规模下
/// 只有几百 KB，全量推送比设计增量补丁省事得多，也不容易出不一致。
fn broadcast(app: &AppHandle, state: &AppState) {
    let archive = state.archive().clone();
    let _ = app.emit(EVENT_ARCHIVE_CHANGED, archive);
}

// ---------------------------------------------------------------- 读取

#[tauri::command]
pub fn get_archive(state: State<AppState>) -> Archive {
    state.archive().clone()
}

/// 渲染用的展开结果。
///
/// 只带 id 与时间——标题、标签这些前端从存档里自己取。
/// 重复事件在区间内可能发生几十次，把完整字段复制几十份传过去不值得。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Occurrence {
    pub event_id: String,
    pub start: NaiveDateTime,
    pub end: NaiveDateTime,
}

/// 把 `[from, to]` 区间内所有事件展开成具体发生时间。
///
/// 重复规则的解析只在 Rust 侧有一份实现（`recurrence.rs`），
/// 前端调这个命令而不是自己解析 RRULE——两边各写一遍必然会对不上。
#[tauri::command]
pub fn occurrences_in_range(
    state: State<AppState>,
    from: NaiveDate,
    to: NaiveDate,
) -> Vec<Occurrence> {
    let archive = state.archive();
    let from_dt = from.and_hms_opt(0, 0, 0).unwrap_or_default();
    let to_dt = to.and_hms_opt(23, 59, 59).unwrap_or_default();

    let mut out = Vec::new();
    for event in archive.live_events() {
        // 重复发生的时长与首次一致，按首次的差值推算即可。
        let duration = event.end - event.start;
        for start in crate::recurrence::occurrences(event, from_dt, to_dt) {
            out.push(Occurrence {
                event_id: event.id.clone(),
                start,
                end: start + duration,
            });
        }
    }

    out.sort_by_key(|o| o.start);
    out
}

// ---------------------------------------------------------------- 事件增删改

/// 新建事件时的入参。id 与时间戳由后端生成，前端不参与。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventDraft {
    pub title: String,
    pub start: NaiveDateTime,
    pub end: NaiveDateTime,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub priority: Priority,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub subtasks: Vec<Subtask>,
    #[serde(default)]
    pub reminders: Vec<i32>,
    #[serde(default)]
    pub repeat_rule: Option<RepeatRule>,
}

#[tauri::command]
pub fn create_event(
    app: AppHandle,
    state: State<AppState>,
    draft: EventDraft,
) -> Result<Event, String> {
    // 结束早于开始是最常见的手滑，直接挡住而不是存进去再让人自己发现。
    if draft.end < draft.start {
        return Err("结束时间不能早于开始时间".into());
    }
    if draft.title.trim().is_empty() {
        return Err("标题不能为空".into());
    }

    let mut event = Event::new(draft.title.trim(), draft.start, draft.end);
    event.all_day = draft.all_day;
    event.tags = draft.tags;
    event.priority = draft.priority;
    event.notes = draft.notes;
    event.subtasks = draft.subtasks;
    event.reminders = draft.reminders;
    event.repeat_rule = draft.repeat_rule;
    event.last_modified_by = Device::Pc;

    state.push_undo(UndoEntry::Created {
        id: event.id.clone(),
    });
    state.archive().events.push(event.clone());
    state.persist().map_err(err)?;

    broadcast(&app, &state);
    Ok(event)
}

#[tauri::command]
pub fn update_event(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    draft: EventDraft,
) -> Result<Event, String> {
    if draft.end < draft.start {
        return Err("结束时间不能早于开始时间".into());
    }

    let mut archive = state.archive();
    let Some(existing) = archive.event_mut(&id) else {
        return Err(format!("找不到事件 {id}"));
    };

    let before = existing.clone();

    existing.title = draft.title.trim().to_string();
    existing.start = draft.start;
    existing.end = draft.end;
    existing.all_day = draft.all_day;
    existing.tags = draft.tags;
    existing.priority = draft.priority;
    existing.notes = draft.notes;
    existing.subtasks = draft.subtasks;
    existing.reminders = draft.reminders;
    existing.repeat_rule = draft.repeat_rule;
    // 改过之后原来的 snooze 就不该再压着这条事件了。
    existing.snoozed_until = None;
    existing.updated_at = now();
    existing.last_modified_by = Device::Pc;

    let updated = existing.clone();
    drop(archive);

    state.push_undo(UndoEntry::Updated {
        before: Box::new(before),
    });
    state.persist().map_err(err)?;

    broadcast(&app, &state);
    Ok(updated)
}

/// 软删除。不真删，是为了让另一端能通过合并得知「这条被删了」。
#[tauri::command]
pub fn delete_event(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    let mut archive = state.archive();
    let Some(existing) = archive.event_mut(&id) else {
        return Err(format!("找不到事件 {id}"));
    };

    let before = existing.clone();
    existing.deleted = true;
    existing.updated_at = now();
    existing.last_modified_by = Device::Pc;
    drop(archive);

    state.push_undo(UndoEntry::Deleted {
        before: Box::new(before),
    });
    state.persist().map_err(err)?;

    broadcast(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn toggle_event_done(app: AppHandle, state: State<AppState>, id: String) -> Result<Event, String> {
    let mut archive = state.archive();
    let Some(existing) = archive.event_mut(&id) else {
        return Err(format!("找不到事件 {id}"));
    };

    let before = existing.clone();
    existing.done = !existing.done;
    existing.updated_at = now();
    existing.last_modified_by = Device::Pc;
    let updated = existing.clone();
    drop(archive);

    state.push_undo(UndoEntry::Updated {
        before: Box::new(before),
    });
    state.persist().map_err(err)?;

    broadcast(&app, &state);
    Ok(updated)
}

/// 撤销最近一次操作。返回是否真的撤销了什么——栈空时前端不该弹 Toast。
#[tauri::command]
pub fn undo_last(app: AppHandle, state: State<AppState>) -> Result<bool, String> {
    let Some(entry) = state.undo().pop_back() else {
        return Ok(false);
    };

    {
        let mut archive = state.archive();
        match entry {
            UndoEntry::Created { id } => {
                archive.events.retain(|e| e.id != id);
            }
            UndoEntry::Deleted { before } => {
                // 恢复时更新 updatedAt，否则会输给别处更晚的删除。
                let mut restored = *before;
                restored.deleted = false;
                restored.updated_at = now();
                match archive.events.iter_mut().find(|e| e.id == restored.id) {
                    Some(slot) => *slot = restored,
                    None => archive.events.push(restored),
                }
            }
            UndoEntry::Updated { before } => {
                let mut restored = *before;
                restored.updated_at = now();
                match archive.events.iter_mut().find(|e| e.id == restored.id) {
                    Some(slot) => *slot = restored,
                    None => archive.events.push(restored),
                }
            }
            UndoEntry::PlanCreated { id } => {
                archive.plans.retain(|p| p.id != id);
            }
            UndoEntry::PlanDeleted { before } => {
                let mut restored = *before;
                restored.deleted = false;
                restored.updated_at = now();
                match archive.plans.iter_mut().find(|p| p.id == restored.id) {
                    Some(slot) => *slot = restored,
                    None => archive.plans.push(restored),
                }
            }
            UndoEntry::PlanUpdated { before } => {
                let mut restored = *before;
                restored.updated_at = now();
                match archive.plans.iter_mut().find(|p| p.id == restored.id) {
                    Some(slot) => *slot = restored,
                    None => archive.plans.push(restored),
                }
            }
        }
    }

    state.persist().map_err(err)?;
    broadcast(&app, &state);
    Ok(true)
}

// ---------------------------------------------------------------- 长期计划

/// 新建/编辑计划时的入参。id 与时间戳由后端生成。
///
/// 注意没有 `reminded`：那是后端自己的状态（提醒响过没），不该由表单写。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanDraft {
    pub title: String,
    #[serde(default)]
    pub target_date: Option<NaiveDate>,
    #[serde(default)]
    pub reminder_date: Option<NaiveDate>,
    #[serde(default)]
    pub notes: String,
}

#[tauri::command]
pub fn create_plan(
    app: AppHandle,
    state: State<AppState>,
    draft: PlanDraft,
) -> Result<Plan, String> {
    if draft.title.trim().is_empty() {
        return Err("标题不能为空".into());
    }

    let mut plan = Plan::new(draft.title.trim());
    plan.target_date = draft.target_date;
    plan.reminder_date = draft.reminder_date;
    plan.notes = draft.notes;
    plan.last_modified_by = Device::Pc;

    state.push_undo(UndoEntry::PlanCreated {
        id: plan.id.clone(),
    });
    state.archive().plans.push(plan.clone());
    state.persist().map_err(err)?;

    broadcast(&app, &state);
    Ok(plan)
}

#[tauri::command]
pub fn update_plan(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    draft: PlanDraft,
) -> Result<Plan, String> {
    if draft.title.trim().is_empty() {
        return Err("标题不能为空".into());
    }

    let mut archive = state.archive();
    let Some(existing) = archive.plan_mut(&id) else {
        return Err(format!("找不到计划 {id}"));
    };

    let before = existing.clone();

    existing.title = draft.title.trim().to_string();
    existing.target_date = draft.target_date;
    // 内部会处理「日期变了就重置已播报」这件事，见 `Plan::set_reminder_date`。
    existing.set_reminder_date(draft.reminder_date);
    existing.notes = draft.notes;
    existing.updated_at = now();
    existing.last_modified_by = Device::Pc;

    let updated = existing.clone();
    drop(archive);

    state.push_undo(UndoEntry::PlanUpdated {
        before: Box::new(before),
    });
    state.persist().map_err(err)?;

    broadcast(&app, &state);
    Ok(updated)
}

/// 软删除，与事件同理——让另一端能通过合并得知「这条被删了」。
#[tauri::command]
pub fn delete_plan(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    let mut archive = state.archive();
    let Some(existing) = archive.plan_mut(&id) else {
        return Err(format!("找不到计划 {id}"));
    };

    let before = existing.clone();
    existing.deleted = true;
    existing.updated_at = now();
    existing.last_modified_by = Device::Pc;
    drop(archive);

    state.push_undo(UndoEntry::PlanDeleted {
        before: Box::new(before),
    });
    state.persist().map_err(err)?;

    broadcast(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn toggle_plan_done(app: AppHandle, state: State<AppState>, id: String) -> Result<Plan, String> {
    let mut archive = state.archive();
    let Some(existing) = archive.plan_mut(&id) else {
        return Err(format!("找不到计划 {id}"));
    };

    let before = existing.clone();
    existing.done = !existing.done;
    // 刻意不动 `reminded`：它只表示「这个提醒日期已经播报过」，与完成状态正交。
    // 「完成」由提醒扫描自己跳过（扫的候选里就滤掉了 done）。
    // 两者混在一起的话，勾完成再取消勾就会把已经响过的提醒又放出来响一遍。
    existing.updated_at = now();
    existing.last_modified_by = Device::Pc;
    let updated = existing.clone();
    drop(archive);

    state.push_undo(UndoEntry::PlanUpdated {
        before: Box::new(before),
    });
    state.persist().map_err(err)?;

    broadcast(&app, &state);
    Ok(updated)
}

// ---------------------------------------------------------------- 设置

#[tauri::command]
pub fn update_settings(
    app: AppHandle,
    state: State<AppState>,
    settings: Settings,
) -> Result<(), String> {
    // 自启先真正落到系统上，成功了再记进存档。
    // 反过来的话，注册表写失败时存档会记着一个没生效的开关——
    // 界面显示「已开启」，实际开机并不会起来。宁可整次保存失败。
    window::apply_autostart(&app, settings.autostart)?;

    state.archive().settings = settings;
    state.persist().map_err(err)?;
    broadcast(&app, &state);
    Ok(())
}

/// 数据目录的绝对路径。
///
/// 「纯离线 + 手动搬运存档」这个方案里，使用者得先知道文件在哪才能
/// 拷到手机上，所以路径要能直接看到，而不是让他自己去翻 %APPDATA%。
#[tauri::command]
pub fn data_dir(state: State<AppState>) -> String {
    state.paths.root.to_string_lossy().to_string()
}

/// 在文件资源管理器里打开数据目录。只实现了 Windows。
#[tauri::command]
pub fn open_data_dir(state: State<AppState>) -> Result<(), String> {
    let dir = state.paths.root.clone();

    #[cfg(target_os = "windows")]
    {
        // 用 explorer 而不是额外引一个 opener 插件：只是打开一个已知的本地
        // 目录，路径完全由我们自己拼，不经过使用者输入。
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("打开数据目录失败：{e}"))?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = dir;
        Err("目前只有 Windows 端支持打开数据目录".into())
    }
}

// ---------------------------------------------------------------- 导入导出

/// 导出到前端选定的路径。路径由 JS 侧的 save 对话框给出。
#[tauri::command]
pub fn export_archive(state: State<AppState>, path: String) -> Result<(), String> {
    import_export::export_to(&state.paths, std::path::Path::new(&path), Device::Pc).map_err(err)
}

/// 导入前的预览：读懂文件、校验版本，但**不落盘**。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub exported_at: DateTime<FixedOffset>,
    pub device: Device,
    pub event_count: usize,
    pub plan_count: usize,
    pub tag_count: usize,
    pub habit_count: usize,
    pub focus_count: usize,
}

#[tauri::command]
pub fn inspect_import(path: String) -> Result<ImportPreview, String> {
    let archive = import_export::inspect(std::path::Path::new(&path)).map_err(err)?;
    Ok(ImportPreview {
        exported_at: archive.exported_at,
        device: archive.device,
        event_count: archive.live_events().count(),
        plan_count: archive.live_plans().count(),
        tag_count: archive.tags.len(),
        habit_count: archive.habits.len(),
        focus_count: archive.focus_sessions.len(),
    })
}

/// 执行导入。`save_archive` 内部会先备份，所以这一步本身可回退。
#[tauri::command]
pub fn apply_import(
    app: AppHandle,
    state: State<AppState>,
    path: String,
    mode: ImportMode,
) -> Result<MergeStats, String> {
    let incoming = import_export::inspect(std::path::Path::new(&path)).map_err(err)?;
    let (archive, stats) = import_export::apply(&state.paths, incoming, mode).map_err(err)?;

    // 导入把整个存档换掉了，撤销栈里那些指向旧 id 的快照已经没意义。
    state.undo().clear();
    *state.archive() = archive;

    broadcast(&app, &state);
    Ok(stats)
}

#[tauri::command]
pub fn list_backups(state: State<AppState>) -> Result<Vec<BackupEntry>, String> {
    storage::list_backups(&state.paths).map_err(err)
}

#[tauri::command]
pub fn restore_backup(
    app: AppHandle,
    state: State<AppState>,
    name: String,
) -> Result<(), String> {
    let restored = storage::restore_backup(&state.paths, &name).map_err(err)?;
    state.undo().clear();
    *state.archive() = restored;

    broadcast(&app, &state);
    Ok(())
}

// ---------------------------------------------------------------- 窗口

#[tauri::command]
pub fn show_main(app: AppHandle) {
    window::show_main(&app);
}

#[tauri::command]
pub fn toggle_panel(app: AppHandle) -> Result<(), String> {
    window::toggle_panel(&app).map_err(err)
}

#[tauri::command]
pub fn hide_panel(app: AppHandle) {
    window::hide_panel(&app);
}

/// 鼠标进入/离开悬浮块。面板据此展开或收起。
#[tauri::command]
pub fn panel_hover_float(app: AppHandle, over: bool) {
    window::set_panel_hover(&app, window::HoverSource::Float, over);
}

/// 鼠标进入/离开面板本身。和上面是一对——鼠标跨过两者之间那条空隙时，
/// 靠这个把面板留住。
#[tauri::command]
pub fn panel_hover_panel(app: AppHandle, over: bool) {
    window::set_panel_hover(&app, window::HoverSource::Panel, over);
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

// ---------------------------------------------------------------- 供前端复用的辅助

/// 前端拖拽悬浮块时调用，让窗口跟着鼠标走。
#[tauri::command]
pub fn drag_float(app: AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("float")
        .ok_or_else(|| "找不到悬浮块窗口".to_string())?;
    window::start_drag(&win).map_err(err)
}

/// 今天的日期（按 UTC+8），前端据此渲染「今日」相关视图。
#[tauri::command]
pub fn today() -> NaiveDate {
    now().date_naive()
}
