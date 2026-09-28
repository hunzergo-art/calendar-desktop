/**
 * 前后端之间的唯一通道。
 *
 * 界面的任何代码都不该直接 `import { invoke }`——一律经过这里，
 * 这样「跑在真应用里」和「跑在浏览器里」的差别只在这一个文件里。
 *
 * 浏览器降级见 `mock.ts`。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  Archive,
  BackupEntry,
  CalendarEvent,
  EventDraft,
  ImportMode,
  ImportPreview,
  MergeStats,
  Occurrence,
  Plan,
  PlanDraft,
  Settings,
} from "../types";
import { createMockBackend } from "./mock";

/** 后端广播的存档变更事件名，与 `commands.rs` 的常量对应。 */
export const EVENT_ARCHIVE_CHANGED = "archive-changed";

/**
 * 是否运行在 Tauri 里。
 *
 * Tauri v2 会往 window 上挂 `__TAURI_INTERNALS__`；纯浏览器里没有，
 * 于是走 mock。用能力探测而不是环境变量，是因为打包后的前端
 * 和开发时是同一份产物，没法靠构建标志区分。
 */
export const IN_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const mock = IN_TAURI ? null : createMockBackend();

if (!IN_TAURI && import.meta.env.DEV) {
  console.info(
    "%c[日历] 浏览器预览模式：数据是假的，只存在 localStorage 里。",
    "color:#3b82f6",
  );
}

/** 把后端抛出的错误统一成 Error，避免上层拿到裸字符串。 */
function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((e: unknown) => {
    throw e instanceof Error ? e : new Error(String(e));
  });
}

export const api = {
  getArchive: (): Promise<Archive> =>
    wrap(mock ? mock.getArchive() : invoke<Archive>("get_archive")),

  /** `from` / `to` 是 `"2026-09-19"` 形式的日期，含两端。 */
  occurrencesInRange: (from: string, to: string): Promise<Occurrence[]> =>
    wrap(
      mock
        ? mock.occurrencesInRange(from, to)
        : invoke<Occurrence[]>("occurrences_in_range", { from, to }),
    ),

  createEvent: (draft: EventDraft): Promise<CalendarEvent> =>
    wrap(
      mock
        ? mock.createEvent(draft)
        : invoke<CalendarEvent>("create_event", { draft }),
    ),

  updateEvent: (id: string, draft: EventDraft): Promise<CalendarEvent> =>
    wrap(
      mock
        ? mock.updateEvent(id, draft)
        : invoke<CalendarEvent>("update_event", { id, draft }),
    ),

  deleteEvent: (id: string): Promise<void> =>
    wrap(mock ? mock.deleteEvent(id) : invoke<void>("delete_event", { id })),

  toggleEventDone: (id: string): Promise<CalendarEvent> =>
    wrap(
      mock
        ? mock.toggleEventDone(id)
        : invoke<CalendarEvent>("toggle_event_done", { id }),
    ),

  /** 返回是否真的撤销了——栈空时前端不该弹 Toast。 */
  undoLast: (): Promise<boolean> =>
    wrap(mock ? mock.undoLast() : invoke<boolean>("undo_last")),

  // -------------------------------------------------------------- 长期计划

  createPlan: (draft: PlanDraft): Promise<Plan> =>
    wrap(mock ? mock.createPlan(draft) : invoke<Plan>("create_plan", { draft })),

  updatePlan: (id: string, draft: PlanDraft): Promise<Plan> =>
    wrap(
      mock ? mock.updatePlan(id, draft) : invoke<Plan>("update_plan", { id, draft }),
    ),

  deletePlan: (id: string): Promise<void> =>
    wrap(mock ? mock.deletePlan(id) : invoke<void>("delete_plan", { id })),

  togglePlanDone: (id: string): Promise<Plan> =>
    wrap(
      mock ? mock.togglePlanDone(id) : invoke<Plan>("toggle_plan_done", { id }),
    ),

  updateSettings: (settings: Settings): Promise<void> =>
    wrap(
      mock
        ? mock.updateSettings(settings)
        : invoke<void>("update_settings", { settings }),
    ),

  /** 数据目录的绝对路径。存档、备份都在里面。 */
  dataDir: (): Promise<string> =>
    wrap(mock ? mock.dataDir() : invoke<string>("data_dir")),

  openDataDir: (): Promise<void> =>
    wrap(mock ? mock.openDataDir() : invoke<void>("open_data_dir")),

  exportArchive: (path: string): Promise<void> =>
    wrap(
      mock ? mock.exportArchive(path) : invoke<void>("export_archive", { path }),
    ),

  inspectImport: (path: string): Promise<ImportPreview> =>
    wrap(
      mock
        ? mock.inspectImport(path)
        : invoke<ImportPreview>("inspect_import", { path }),
    ),

  applyImport: (path: string, mode: ImportMode): Promise<MergeStats> =>
    wrap(
      mock
        ? mock.applyImport(path, mode)
        : invoke<MergeStats>("apply_import", { path, mode }),
    ),

  listBackups: (): Promise<BackupEntry[]> =>
    wrap(mock ? mock.listBackups() : invoke<BackupEntry[]>("list_backups")),

  restoreBackup: (name: string): Promise<void> =>
    wrap(
      mock
        ? mock.restoreBackup(name)
        : invoke<void>("restore_backup", { name }),
    ),

  showMain: (): Promise<void> =>
    wrap(mock ? mock.showMain() : invoke<void>("show_main")),

  togglePanel: (): Promise<void> =>
    wrap(mock ? mock.togglePanel() : invoke<void>("toggle_panel")),

  hidePanel: (): Promise<void> =>
    wrap(mock ? mock.hidePanel() : invoke<void>("hide_panel")),

  /**
   * 报告鼠标进入了/离开了悬浮块。
   *
   * 移到面板上、以及离开面板，都靠这两个把状态告诉后端——面板的
   * 显示与否由 Rust 侧统一裁决（见 `window::set_panel_hover`），
   * 因为悬浮块和面板是两个独立的前端实例，互相看不见对方的鼠标。
   */
  panelHoverFloat: (over: boolean): Promise<void> =>
    wrap(
      mock
        ? mock.panelHoverFloat(over)
        : invoke<void>("panel_hover_float", { over }),
    ),

  panelHoverPanel: (over: boolean): Promise<void> =>
    wrap(
      mock
        ? mock.panelHoverPanel(over)
        : invoke<void>("panel_hover_panel", { over }),
    ),

  quitApp: (): Promise<void> =>
    wrap(mock ? mock.quitApp() : invoke<void>("quit_app")),

  /** 拖动悬浮块。由悬浮块的 mousedown 触发。 */
  dragFloat: (): Promise<void> =>
    wrap(mock ? mock.dragFloat() : invoke<void>("drag_float")),

  today: (): Promise<string> =>
    wrap(mock ? mock.today() : invoke<string>("today")),
};

/**
 * 订阅存档变更。返回取消订阅的函数。
 *
 * 浏览器模式下没有后端推送，改用 storage 事件模拟——
 * 这样多开一个标签页也能看到彼此改动，和真应用的多窗口行为一致。
 */
export function onArchiveChanged(
  handler: (archive: Archive) => void,
): () => void {
  if (IN_TAURI) {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    // listen 是异步的，而调用方要的是同步的取消函数，
    // 所以先记下取消意图，等 Promise 落地再兑现。
    void listen<Archive>(EVENT_ARCHIVE_CHANGED, (e) => handler(e.payload)).then(
      (fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      },
    );

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }

  const onStorage = (e: StorageEvent) => {
    if (e.key === "calendar-mock-archive" && e.newValue) {
      try {
        handler(JSON.parse(e.newValue) as Archive);
      } catch {
        /* 忽略坏数据 */
      }
    }
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

/**
 * 弹系统文件对话框。只在 Tauri 里可用。
 *
 * 放在前端做（而不是 Rust 里调阻塞式对话框）是因为：
 * Rust 侧同步命令跑在主线程上，阻塞式文件对话框会和主线程互锁。
 */
export async function pickSavePath(
  defaultName: string,
): Promise<string | null> {
  if (!IN_TAURI) {
    throw new Error("浏览器预览模式不支持文件对话框");
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: "日历存档", extensions: ["json"] }],
  });
  return path;
}

export async function pickOpenPath(): Promise<string | null> {
  if (!IN_TAURI) {
    throw new Error("浏览器预览模式不支持文件对话框");
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "日历存档", extensions: ["json"] }],
  });
  return typeof path === "string" ? path : null;
}

/** 发一条系统通知。提醒以外的即时反馈（如撤销 Toast）不走这里。 */
export async function notify(title: string, body: string): Promise<void> {
  if (!IN_TAURI) return;
  const { isPermissionGranted, requestPermission, sendNotification } =
    await import("@tauri-apps/plugin-notification");

  let granted = await isPermissionGranted();
  if (!granted) {
    granted = (await requestPermission()) === "granted";
  }
  if (granted) sendNotification({ title, body });
}
