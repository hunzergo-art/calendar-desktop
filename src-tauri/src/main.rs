// 发布构建时不带控制台窗口；调试时保留，方便看日志。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    open_calendar_lib::run()
}
