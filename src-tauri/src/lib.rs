//! 应用装配：全局状态、插件、启动流程。
//!
//! 分层是「前端 → IPC → Rust → Windows」，这个文件是 Rust 侧的根。

pub mod commands;
pub mod import_export;
pub mod model;
pub mod recurrence;
pub mod reminder;
pub mod storage;
pub mod tray;
pub mod window;

use std::collections::VecDeque;
use std::sync::Mutex;

use model::Archive;
use storage::DataPaths;
use tauri::{Manager, WindowEvent};

/// 撤销栈深度。决策表定为 20，且**不跨重启**——
/// 重启后还能撤销上辈子的事，比不能撤销更让人困惑。
pub const UNDO_DEPTH: usize = 20;

/// 一次可撤销的操作。存事件快照而不是反向指令，
/// 因为事件字段多，反向指令写起来容易漏字段。
#[derive(Debug, Clone)]
pub enum UndoEntry {
    /// 新建了一条，撤销 = 删掉它
    Created { id: String },
    /// 删了一条（软删除），撤销 = 把快照放回去
    Deleted { before: Box<model::Event> },
    /// 改了一条，撤销 = 用快照覆盖回去
    Updated { before: Box<model::Event> },
    PlanCreated { id: String },
    PlanDeleted { before: Box<model::Plan> },
    PlanUpdated { before: Box<model::Plan> },
}

/// 鼠标此刻悬停在小面板相关的哪个窗口上。
///
/// 放在 Rust 里而不是各前端窗口里：悬浮块和面板是两个独立的前端实例，
/// 谁也看不见谁的鼠标，判据只有集中到一处才不会互相打架。
#[derive(Debug, Default)]
pub struct PanelHover {
    pub over_float: bool,
    pub over_panel: bool,
    /// 已经排了一次「延迟收起」，避免鼠标在边界抖动时开出一堆线程。
    pub hide_pending: bool,
}

/// 全局状态。由 Tauri 的 `State` 注入到各个 command。
pub struct AppState {
    pub paths: DataPaths,
    /// 内存里的那份存档。所有读都走它，避免频繁读盘。
    pub archive: Mutex<Archive>,
    pub undo: Mutex<VecDeque<UndoEntry>>,
    pub hover: Mutex<PanelHover>,
}

impl AppState {
    /// 取存档的锁。用 `into_inner` 兜住毒化——某个 command panic 过
    /// 不该让整个程序从此打不开自己的数据。
    pub fn archive(&self) -> std::sync::MutexGuard<'_, Archive> {
        self.archive.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn undo(&self) -> std::sync::MutexGuard<'_, VecDeque<UndoEntry>> {
        self.undo.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn hover(&self) -> std::sync::MutexGuard<'_, PanelHover> {
        self.hover.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 压入一条撤销记录，超出深度就丢最旧的。
    pub fn push_undo(&self, entry: UndoEntry) {
        let mut stack = self.undo();
        stack.push_back(entry);
        while stack.len() > UNDO_DEPTH {
            stack.pop_front();
        }
    }

    /// 落盘。所有改动内存的 command 最后都要调它。
    pub fn persist(&self) -> storage::Result<()> {
        let mut archive = self.archive();
        storage::save_archive(&self.paths, &mut archive)
    }
}

pub fn run() {
    // 单实例必须第一个注册：第二个实例的进程连窗口都不该建起来。
    // 不做的话两个进程会同时写 calendar.json，互相覆盖。
    let single_instance = tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        window::show_main(app);
    });

    tauri::Builder::default()
        .plugin(single_instance)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            // 数据目录由 Tauri 解析，避免我们自己拼 %APPDATA% 拼错。
            let root = app.path().app_data_dir()?;
            let paths = DataPaths::new(root);
            paths.ensure_dirs()?;

            let archive = storage::read_archive(&paths.archive()).unwrap_or_else(|e| {
                // 存档读坏了不能直接崩——先让程序起来，使用者才能用
                //「历史版本恢复」自救。这里只记日志。
                eprintln!("[启动] 存档读取失败，以空存档启动：{e}");
                Archive::default()
            });

            let state = AppState {
                paths,
                archive: Mutex::new(archive),
                undo: Mutex::new(VecDeque::new()),
                hover: Mutex::new(PanelHover::default()),
            };

            // 顺序不能换：先把状态注册好，再建窗口。
            // 窗口一建出来前端就开始加载，反过来的话前端会在状态就绪前
            // 调用 `get_archive`，报 `state not managed`。
            app.manage(state);
            window::build_all(app.handle())?;

            let float = app.get_webview_window("float");
            let panel = app.get_webview_window("panel");

            tray::build(app.handle())?;

            // 把系统里的自启状态对齐到设置（默认开）。
            //
            // **只在 release 构建下做**：dev 跑的是 `target/debug` 里的 exe，
            // 自动把「开机运行 target/debug/…」写进注册表，会在系统里留一条
            // 指向构建产物的入口——而构建产物随时会被清掉，那条入口就成了
            // 每次开机报一次错的垃圾。手动在设置里拨开关仍然照常生效，
            // 所以功能本身在 dev 下照样能验。
            if !cfg!(debug_assertions) {
                let want = app.state::<AppState>().archive().settings.autostart;
                if let Err(e) = window::apply_autostart(app.handle(), want) {
                    eprintln!("[启动] 同步开机自启失败：{e}");
                }
            }

            // 主窗口必须显式显示：三个窗口都是先以 `visible: false` 建出来的
            // （避免启动时闪一个空壳再跳成最终尺寸），不显式 show 的话
            // 屏幕上就只有悬浮块和托盘，没有主窗口。
            window::show_main(app.handle());

            // 悬浮块贴右下角并显示。失败不致命——主窗口照样能用。
            if let Some(float) = float {
                if let Err(e) = window::park_float_bottom_right(&float) {
                    eprintln!("[启动] 悬浮块定位失败：{e}");
                }
                let _ = float.show();
            }
            if let Some(panel) = panel {
                let _ = panel.hide();
            }

            reminder::spawn(app.handle().clone());

            Ok(())
        })
        .on_window_event(|window, event| {
            // 关主窗口 = 收进托盘，而不是退出程序。
            // 退出只能从托盘菜单走，否则提醒会跟着一起没了。
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_archive,
            commands::occurrences_in_range,
            commands::create_event,
            commands::update_event,
            commands::delete_event,
            commands::toggle_event_done,
            commands::create_plan,
            commands::update_plan,
            commands::delete_plan,
            commands::toggle_plan_done,
            commands::undo_last,
            commands::update_settings,
            commands::data_dir,
            commands::open_data_dir,
            commands::export_archive,
            commands::inspect_import,
            commands::apply_import,
            commands::list_backups,
            commands::restore_backup,
            commands::show_main,
            commands::toggle_panel,
            commands::hide_panel,
            commands::panel_hover_float,
            commands::panel_hover_panel,
            commands::quit_app,
            commands::drag_float,
            commands::today,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
