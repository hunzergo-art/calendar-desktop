//! 三个窗口的定位与显示逻辑。
//!
//! * `float`  —— 右下角常驻悬浮块，无边框透明，贴着工作区右下角
//! * `panel`  —— 鼠标移到悬浮块上时从它旁边弹出的小面板
//! * `main`   —— 完整视图，关闭时收进托盘而不是退出

use std::time::Duration;

use tauri::{
    AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use crate::AppState;

/// 悬浮块距屏幕边缘的留白。
const MARGIN: i32 = 12;
/// 小面板与悬浮块之间的间隙。
const PANEL_GAP: i32 = 8;

/// 鼠标离开后多久才真的收起面板。
///
/// 悬浮块和面板是**两个独立窗口**，中间还隔着 `PANEL_GAP` 像素的空隙。
/// 鼠标从悬浮块挪到面板时，必然先经过「已经离开悬浮块、还没进入面板」的一瞬间。
/// 不留这个缓冲，面板会在半路上收掉，根本点不到上面的东西。
const HIDE_DELAY: Duration = Duration::from_millis(220);

/// 鼠标悬停在哪个窗口上。两个是独立的事件来源。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HoverSource {
    Float,
    Panel,
}

/// 创建三个窗口。**必须在 `app.manage(AppState)` 之后调用。**
///
/// 为什么窗口不写在 `tauri.conf.json` 的 `windows` 里：配置里的窗口是在
/// `setup()` **之前**就建好并开始加载前端的，而 `manage(AppState)` 在
/// `setup()` 里才轮到。前端一挂载就调 `get_archive`，于是存在一个
/// 「窗口已经在跑、状态却还没注册」的空当期，表现就是启动后界面上
/// 挂着一行 `state not managed for field ...`。靠加延迟或让前端重试都只是
/// 把概率压小；把建窗口挪到 manage 之后，这个空当期在结构上才不存在。
pub fn build_all(app: &AppHandle) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("日历日程")
        .inner_size(1100.0, 720.0)
        .min_inner_size(880.0, 560.0)
        .center()
        // 先不显示，等 setup 走完再亮，避免闪一个空壳。
        .visible(false)
        .build()?;

    WebviewWindowBuilder::new(app, "float", WebviewUrl::App("float.html".into()))
        .title("悬浮块")
        .inner_size(84.0, 64.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .focused(false)
        .build()?;

    WebviewWindowBuilder::new(app, "panel", WebviewUrl::App("panel.html".into()))
        .title("小面板")
        // 三块内容（今日/明日/长期计划）比原来的单一列表高，给足高度；
        // 超出仍然靠面板内部滚动。
        .inner_size(340.0, 500.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        // 不抢焦点：面板现在是鼠标悬停展开的，抢走焦点会打断使用者
        // 正在打字的窗口，也会让「移开就收」变得莫名其妙。
        .focused(false)
        .build()?;

    Ok(())
}

/// 把系统里的开机自启状态对齐到设置里的意图。
///
/// 开关打开时**每次都重新注册**，而不是「已经开着就跳过」：
/// 注册表里那条入口记的是 exe 的绝对路径，而使用者可能换过 exe 的位置
/// （比如从 `target/release/` 换到安装版），此时 `is_enabled()` 仍是 true，
/// 但开机拉起来的其实是旧的、可能已经不存在的那个。重注册一次既幂等又能修好路径。
///
/// 反过来说，如果使用者在「任务管理器 → 启动」里手动关掉了，下次启动会被
/// 重新打开——这是刻意的：设置里开着就该是开着的，想永久关掉请关掉这个开关。
pub fn apply_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;

    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch.enable().map_err(|e| e.to_string())
    } else if autolaunch.is_enabled().map_err(|e| e.to_string())? {
        autolaunch.disable().map_err(|e| e.to_string())
    } else {
        // 本来就是关的，不必多写一次注册表。
        Ok(())
    }
}

/// 把悬浮块停到右下角。
///
/// 用工作区（`work_area`）而不是整块屏幕，这样不会被任务栏压住；
/// 多显示器时以悬浮块当前所在的那块屏为准。
pub fn park_float_bottom_right(win: &WebviewWindow) -> tauri::Result<()> {
    let monitor = win.current_monitor()?.or(win.primary_monitor()?);
    let Some(monitor) = monitor else {
        return Ok(());
    };

    let size = win.outer_size()?;
    let area = monitor.work_area();

    let x = area.position.x + area.size.width as i32 - size.width as i32 - MARGIN;
    let y = area.position.y + area.size.height as i32 - size.height as i32 - MARGIN;

    win.set_position(PhysicalPosition::new(x, y))
}

/// 显示主窗口（已存在则只是前置）。
pub fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 在悬浮块旁边显示小面板。**幂等**——已经显示就什么都不做。
///
/// 和 `toggle_panel` 的区别就在这：悬停展开会反复调用它，
/// 把「已经开着」当成「该关掉」会让面板疯狂闪烁。
///
/// 面板贴着悬浮块的左边显示并底对齐——悬浮块在右下角，
/// 面板往上/往左展开才不会顶出屏幕。
pub fn show_panel(app: &AppHandle) -> tauri::Result<()> {
    let Some(panel) = app.get_webview_window("panel") else {
        return Ok(());
    };

    if panel.is_visible().unwrap_or(false) {
        return Ok(());
    }

    if let Some(float) = app.get_webview_window("float") {
        let float_pos = float.outer_position()?;
        let float_size = float.outer_size()?;
        let panel_size = panel.outer_size()?;

        // 默认贴悬浮块左侧、底边对齐。
        let mut x = float_pos.x - panel_size.width as i32 - PANEL_GAP;
        let mut y = float_pos.y + float_size.height as i32 - panel_size.height as i32;

        // 左边放不下就改到悬浮块右侧，再不行就贴屏幕左缘。
        if let Some(monitor) = float.current_monitor()? {
            let area = monitor.work_area();
            let left_edge = area.position.x + MARGIN;
            let right_edge = area.position.x + area.size.width as i32 - MARGIN;
            let top_edge = area.position.y + MARGIN;
            let bottom_edge = area.position.y + area.size.height as i32 - MARGIN;

            if x < left_edge {
                x = float_pos.x + float_size.width as i32 + PANEL_GAP;
            }
            x = x.clamp(left_edge, (right_edge - panel_size.width as i32).max(left_edge));
            y = y.clamp(top_edge, (bottom_edge - panel_size.height as i32).max(top_edge));
        }

        panel.set_position(PhysicalPosition::new(x, y))?;
    }

    panel.show()?;
    // 刻意不 set_focus：面板是悬停展开的，抢焦点会打断使用者正在打字的窗口。
    Ok(())
}

/// 弹出/收起小面板。托盘菜单和快捷键用这个；悬停走 `show_panel`。
pub fn toggle_panel(app: &AppHandle) -> tauri::Result<()> {
    let Some(panel) = app.get_webview_window("panel") else {
        return Ok(());
    };

    if panel.is_visible().unwrap_or(false) {
        // 走 `hide_panel` 而不是直接 `panel.hide()`：它顺手把
        // 「鼠标还在面板上」清掉，否则悬停状态会卡在 true。
        hide_panel(app);
        return Ok(());
    }

    show_panel(app)
}

/// 真正调窗口 API 的那一步，不碰 `AppState`。
///
/// 拆出来是必须的：**不能在握着 `hover` 锁的时候调窗口 API**。
/// Tauri 的命令跑在主线程上，`panel_hide` 这类调用要回到窗口所在的线程去执行；
/// 如果主线程正卡在 `panel_hover_*` 里等这把锁，而握着锁的这边又在等主线程
/// 把窗口收起来，就是一次死锁。
fn hide_panel_raw(app: &AppHandle) {
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.hide();
    }
}

pub fn hide_panel(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        // 「面板收起来了」和「鼠标还在面板上」不可能同时成立。这一句是为
        // 托盘菜单那条路径准备的：鼠标停在面板上时从托盘关掉它，
        // 面板窗口藏起来之后**收不到 pointerleave**（它已经不是鼠标所在的那个
        // 窗口了），`over_panel` 就会永远停在 true，之后每次悬停都收不起来。
        //
        // 临时值在这一句结束时就把锁放掉了，下面的窗口调用是安全的。
        state.hover().over_panel = false;
    }
    hide_panel_raw(app);
}

/// 前端报告「鼠标进入/离开了悬浮块或面板」，由这里统一裁决面板的去留。
///
/// 为什么不放在前端各窗口里用定时器互相协调：两个窗口是独立的前端实例，
/// 谁也看不见谁的鼠标状态，跨窗口的 `setTimeout` 只能靠 IPC 拼凑，
/// 谁先谁后全看调度。状态放在 Rust 这一份，判据就只有一处。
///
/// 收起的延迟 + **重查**是关键：延迟到点后重新读一次两个标志，
/// 鼠标在这段时间里已经落到面板上就不会误收（也就是跨过那条 8px 空隙的场景）。
pub fn set_panel_hover(app: &AppHandle, source: HoverSource, over: bool) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };

    let anywhere = {
        let mut hover = state.hover();
        match source {
            HoverSource::Float => hover.over_float = over,
            HoverSource::Panel => hover.over_panel = over,
        }
        hover.over_float || hover.over_panel
    };

    if anywhere {
        // 锁已经放掉了再调窗口 API，原因见 `hide_panel_raw`。
        let _ = show_panel(app);
        return;
    }

    // 已经为「离开」排过一次队了，这次不必再排：到点的重查自然会看到
    // 最新的标志位。省掉的是鼠标在边界上抖动时开出一堆线程。
    {
        let mut hover = state.hover();
        if hover.hide_pending {
            return;
        }
        hover.hide_pending = true;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(HIDE_DELAY);

        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        {
            let mut hover = state.hover();
            hover.hide_pending = false;
            if hover.over_float || hover.over_panel {
                return;
            }
        }

        hide_panel_raw(&app);

        // 上面那句判断和这次 hide 之间没有锁，鼠标可能正好又移回来了
        //（`show_panel` 于是已经把它显示出来，却被这次 hide 盖掉，
        // 而且不会再有新事件叫它回来）。收完再查一次，还在悬停就补显示。
        // 宁可极端情况下闪一下，也不要留下一个「悬停着却没有面板」的僵局。
        let still_hovering = {
            let hover = state.hover();
            hover.over_float || hover.over_panel
        };
        if still_hovering {
            let _ = show_panel(&app);
        }
    });
}

/// 让某个窗口跟随鼠标拖动。悬浮块靠它实现「拖到哪儿停哪儿」。
pub fn start_drag(win: &WebviewWindow) -> tauri::Result<()> {
    win.start_dragging()
}
