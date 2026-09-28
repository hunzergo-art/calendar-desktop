//! 托盘图标。
//!
//! 关闭主窗口后程序仍驻留托盘——这是提醒能按时弹出的前提。
//! 真正的退出只能从这里走，避免使用者误以为「关了窗口还在后台跑」。

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle,
};

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开主窗口", true, None::<&str>)?;
    let panel = MenuItem::with_id(app, "panel", "今日面板", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&open, &panel, &quit])?;

    let mut builder = TrayIconBuilder::with_id("tray")
        .tooltip("日历日程")
        .menu(&menu);

    // 图标来自 tauri.conf.json 的 bundle.icon。拿不到就退回系统默认，
    // 托盘仍然可用——不该因为一张图让整个程序起不来。
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder
        // 左键留给「打开主窗口」，菜单只在右键弹，
        // 否则每次点托盘都糊一脸菜单。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => crate::window::show_main(app),
            "panel" => {
                let _ = crate::window::toggle_panel(app);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::window::show_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}
