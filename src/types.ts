/**
 * 存档结构的 TypeScript 镜像。
 *
 * **这份文件必须与 `src-tauri/src/model.rs` 逐字段对齐**，改动任何一边都要同步另一边。
 * 命名上 JSON 用 camelCase（Rust 侧靠 `#[serde(rename_all = "camelCase")]` 转换）。
 *
 * 时间格式有且只有两种，不要混：
 *   * 事件时间 `start` / `end` —— `"2026-09-19T15:00:00"`，**不带时区**，按 UTC+8 的本地时间理解
 *   * 时间戳 `createdAt` / `updatedAt` / `exportedAt` / `snoozedUntil` —— `"...+08:00"`，带偏移
 *
 * 解析一律走 `lib/time.ts`，别直接 `new Date()`——裸日期串会被当成 UTC。
 */

export type Device = "pc" | "android";
export type Priority = "high" | "normal" | "low";

/** iCalendar RRULE + 例外日期。存规则，不展开成实例。 */
export interface RepeatRule {
  /** 如 `"FREQ=WEEKLY;BYDAY=WE"` */
  rrule: string;
  /** 被排除的发生时间，匹配各次发生的 start 原值 */
  exdates: string[];
}

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

/**
 * 一条日程。
 *
 * 命名为 `CalendarEvent` 而不是 `Event`，是为了不和 DOM 的全局 `Event` 撞名——
 * 撞了之后 TS 会在一些隐蔽的地方选中错的类型。
 */
export interface CalendarEvent {
  /** UUID，两端合并全靠它 */
  id: string;
  title: string;
  /** `"2026-09-19T15:00:00"`，本地时间，无偏移 */
  start: string;
  end: string;
  allDay: boolean;
  repeatRule: RepeatRule | null;
  /** 引用 Tag.id */
  tags: string[];
  priority: Priority;
  notes: string;
  subtasks: Subtask[];
  /** 提前多少分钟提醒，如 `[5, 30]` */
  reminders: number[];
  /** 稍后提醒推迟到的时刻，带 +08:00；null 表示没在推迟 */
  snoozedUntil: string | null;
  done: boolean;
  createdAt: string;
  updatedAt: string;
  lastModifiedBy: Device;
  /** 软删除。不真删是为了让另一端能通过合并得知「这条被删了」 */
  deleted: boolean;
}

/**
 * 一条长期计划。
 *
 * 和 `CalendarEvent` 是**两类数据**，不是一种数据的两种视图。这正是
 * 「计划不出现在日历时间格里」的实现方式：周/月视图只展开 `events`，
 * 计划天然进不去，渲染层不需要任何过滤。目标日期可以是几个月之后，
 * 塞进时间格只会把当天真正要做的事挤掉。
 *
 * 提醒语义也和事件不同：事件是「开始前 N 分钟」（`reminders: number[]`），
 * 计划是「到某个日期那一天」。
 */
export interface Plan {
  /** UUID，两端合并全靠它 */
  id: string;
  title: string;
  /** 目标/截止日期 `"2026-12-31"`；null 表示没设 */
  targetDate: string | null;
  /** 自定义提醒日期；null 表示这条计划不提醒 */
  reminderDate: string | null;
  notes: string;
  done: boolean;
  /** 本次提醒日期是否已播报过。由后端维护，表单不要写它 */
  reminded: boolean;
  createdAt: string;
  updatedAt: string;
  lastModifiedBy: Device;
  deleted: boolean;
}

/** 新建/编辑计划时提交给后端的载荷。id 与时间戳由后端生成。 */
export interface PlanDraft {
  title: string;
  targetDate: string | null;
  reminderDate: string | null;
  notes: string;
}

export interface Tag {
  id: string;
  name: string;
  /** 十六进制色值，如 `"#3b82f6"` */
  color: string;
}

export interface Habit {
  id: string;
  name: string;
  targetPerWeek: number;
  createdAt: string;
  deleted: boolean;
}

export interface HabitLog {
  id: string;
  habitId: string;
  /** `"2026-09-18"`，只到天 */
  date: string;
  createdAt: string;
}

export interface FocusSession {
  id: string;
  eventId: string | null;
  start: string;
  seconds: number;
  completed: boolean;
}

export interface Settings {
  theme: string;
  /** 0 = 周日，1 = 周一 */
  weekStart: number;
  defaultReminder: number;
  /** 开机自启，默认开。本机偏好，不参与跨端合并。 */
  autostart: boolean;
}

/** 一个完整的存档文件。导出、导入、自动备份搬的都是它。 */
export interface Archive {
  version: number;
  exportedAt: string;
  device: Device;
  events: CalendarEvent[];
  plans: Plan[];
  tags: Tag[];
  habits: Habit[];
  habitLogs: HabitLog[];
  focusSessions: FocusSession[];
  settings: Settings;
}

/**
 * 一条展开后的发生记录，用于渲染。
 *
 * 重复事件在区间内会有多条，它们共享同一个 `eventId`——
 * 要拿标题、标签这些字段，用 `eventId` 回 `archive.events` 里查。
 * 展开由后端做（`occurrences_in_range`），前端不重复实现 RRULE 解析。
 */
export interface Occurrence {
  eventId: string;
  /** 本次发生的开始时间 */
  start: string;
  end: string;
}

/** 新建/编辑事件时提交给后端的载荷。id 与时间戳由后端生成。 */
export interface EventDraft {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  tags: string[];
  priority: Priority;
  notes: string;
  subtasks: Subtask[];
  reminders: number[];
  repeatRule: RepeatRule | null;
}

export interface MergeStats {
  added: number;
  updated: number;
  deleted: number;
  resurrected: number;
  unchanged: number;
  /** 计划单独计数：和日程混在一起就说不清「新增 3 条」是三件事还是三条计划 */
  planAdded: number;
  planUpdated: number;
  planDeleted: number;
  planResurrected: number;
  planUnchanged: number;
}

export interface BackupEntry {
  name: string;
  size: number;
  modified: string | null;
}

export interface ImportPreview {
  exportedAt: string;
  device: Device;
  eventCount: number;
  planCount: number;
  tagCount: number;
  habitCount: number;
  focusCount: number;
}

export type ImportMode = "replace" | "merge";

/** 当前支持的存档格式版本，需与 `model.rs` 的 `SCHEMA_VERSION` 一致。 */
export const SCHEMA_VERSION = 2;
