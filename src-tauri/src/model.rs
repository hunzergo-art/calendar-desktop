//! 存档数据结构。字段与设计文档第七节的 JSON 一一对应，两端必须逐字一致。
//!
//! 时间约定（贯穿全项目，不要在任何地方读系统时区）：
//!   * 事件时间 `start` / `end` —— 不带时区的本地时间，如 `2026-09-19T15:00:00`
//!   * 时间戳 `createdAt` / `updatedAt` / `exportedAt` / `snoozedUntil` —— 带 `+08:00` 偏移
//!
//! 两者都固定在中国时区。因为中国不实行夏令时，本地时间不会出现
//! 重复或缺失的小时，所以「不带偏移的本地时间」在这里是安全的。

use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};

/// 存档格式版本。改动任何不兼容字段时 +1，导入时据此判断能否读取。
///
/// v2：加入 `plans`。带 `serde(default)` 的字段对新读方是兼容的，但**旧读方
/// 读新存档会静默丢掉 `plans`**（serde 默认忽略未知字段），导回去就是数据丢失。
/// 所以按「改动不兼容字段」处理，让旧端在 `check_version` 直接拒绝。
pub const SCHEMA_VERSION: u32 = 2;

/// 全项目唯一时区：UTC+8。
pub fn tz() -> FixedOffset {
    // 8 小时 = 28800 秒，恒为合法偏移，unwrap 不会触发。
    FixedOffset::east_opt(8 * 3600).expect("UTC+8 是合法偏移")
}

/// 当前时刻，带 +08:00 偏移。
pub fn now() -> DateTime<FixedOffset> {
    chrono::Utc::now().with_timezone(&tz())
}

/// 数据最后来自哪一端。合并时 `updatedAt` 打平的话用它兜底。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Device {
    Pc,
    Android,
}

impl Device {
    pub fn as_str(self) -> &'static str {
        match self {
            Device::Pc => "pc",
            Device::Android => "android",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    High,
    #[default]
    Normal,
    Low,
}

/// 重复规则。存 RRULE 原文 + 例外日期，**不展开成实例**。
///
/// 展开的代价很高：一条「每天重复」的事件会变成几千条记录塞进存档，
/// 合并时还要逐条比对。存规则则两端只需各自按规则渲染。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepeatRule {
    /// iCalendar RRULE 原文，如 `FREQ=WEEKLY;BYDAY=WE`
    pub rrule: String,
    /// 被排除的发生时间（EXDATE），匹配的是各次发生的 `start` 原值
    #[serde(default)]
    pub exdates: Vec<NaiveDateTime>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subtask {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    /// UUID。两端合并全靠它认亲，绝不能用标题或时间做键。
    pub id: String,
    pub title: String,
    pub start: NaiveDateTime,
    pub end: NaiveDateTime,
    #[serde(default)]
    pub all_day: bool,
    /// `None` 表示单次事件
    #[serde(default)]
    pub repeat_rule: Option<RepeatRule>,
    /// 引用 `Tag.id`
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub priority: Priority,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub subtasks: Vec<Subtask>,
    /// 提前多少分钟提醒，如 `[5, 30]`。重复事件对每次发生都生效。
    #[serde(default)]
    pub reminders: Vec<i32>,
    /// 稍后提醒（snooze）推迟到的时刻。持久化，否则重启就丢。
    #[serde(default)]
    pub snoozed_until: Option<DateTime<FixedOffset>>,
    #[serde(default)]
    pub done: bool,
    pub created_at: DateTime<FixedOffset>,
    pub updated_at: DateTime<FixedOffset>,
    #[serde(default = "default_device")]
    pub last_modified_by: Device,
    /// 软删除。合并时删除优先于修改，见 `merge` 模块。
    #[serde(default)]
    pub deleted: bool,
}

fn default_device() -> Device {
    Device::Pc
}

impl Event {
    /// 新建一条事件，补齐 id 与时间戳。
    pub fn new(title: impl Into<String>, start: NaiveDateTime, end: NaiveDateTime) -> Self {
        let ts = now();
        Event {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.into(),
            start,
            end,
            all_day: false,
            repeat_rule: None,
            tags: Vec::new(),
            priority: Priority::default(),
            notes: String::new(),
            subtasks: Vec::new(),
            reminders: Vec::new(),
            snoozed_until: None,
            done: false,
            created_at: ts,
            updated_at: ts,
            last_modified_by: Device::Pc,
            deleted: false,
        }
    }

    pub fn is_repeating(&self) -> bool {
        self.repeat_rule.is_some()
    }

    /// 事件持续时长，供拖拽/拉伸时保持长度。
    pub fn duration(&self) -> chrono::Duration {
        self.end - self.start
    }
}

/// 一条长期计划。
///
/// 和 `Event` 是**两类数据**，不是一种数据的两种视图——这正是「计划不出现在
/// 日历时间格里」的实现方式：周/月视图只展开 `events`，计划天然进不去，
/// 不需要在渲染层写任何过滤。目标日期可以是几个月之后，塞进时间格只会
/// 把当天真正要做的事挤掉。
///
/// 提醒语义也和事件不同：事件是「开始前 N 分钟」，计划是「到某个日期那一天」。
/// 所以这里存的是日期而不是分钟数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// UUID。两端合并全靠它，与 `Event.id` 同一套规则。
    pub id: String,
    pub title: String,
    /// 目标/截止日期。可以很远，也可以不设（`None`）。
    pub target_date: Option<NaiveDate>,
    /// 自定义提醒日期。`None` 表示这条计划不提醒。
    ///
    /// 只有它触发提醒——`target_date` 本身不响，免得「顺手定了个截止日」
    /// 就莫名其妙收到通知。想要提醒就在设一次提醒日期。
    pub reminder_date: Option<NaiveDate>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub done: bool,
    /// 本次 `reminder_date` 是否已经响过。
    ///
    /// **必须持久化**，不能像事件那样只靠内存里的 `fired` 集合去重：
    /// 事件的提醒有「事件开始时刻」做上界，错过就不会再响；计划的提醒没有
    /// 这个上界，只要 `reminder_date` 还停在过去，每一轮扫描都会命中，
    /// 重启一次就再响一遍。改 `reminder_date` 时会被重置回 `false`。
    #[serde(default)]
    pub reminded: bool,
    pub created_at: DateTime<FixedOffset>,
    pub updated_at: DateTime<FixedOffset>,
    #[serde(default = "default_device")]
    pub last_modified_by: Device,
    /// 软删除，语义与 `Event.deleted` 一致。
    #[serde(default)]
    pub deleted: bool,
}

impl Plan {
    /// 新建一条计划，补齐 id 与时间戳。
    pub fn new(title: impl Into<String>) -> Self {
        let ts = now();
        Plan {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.into(),
            target_date: None,
            reminder_date: None,
            notes: String::new(),
            done: false,
            reminded: false,
            created_at: ts,
            updated_at: ts,
            last_modified_by: Device::Pc,
            deleted: false,
        }
    }

    /// 换一个提醒日期。**日期变了就重置「已播报」**——
    /// 否则把提醒从「上周」改到「今天」时，会因为曾经响过而永远不再响。
    pub fn set_reminder_date(&mut self, date: Option<NaiveDate>) {
        if self.reminder_date != date {
            self.reminded = false;
        }
        self.reminder_date = date;
    }

    /// 到期了没：有目标日期、已过、且还没完成。
    pub fn is_overdue(&self, today: NaiveDate) -> bool {
        !self.done && self.target_date.is_some_and(|d| d < today)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    /// 十六进制色值，如 `#3b82f6`
    pub color: String,
}

/// 习惯定义。打卡记录在 `HabitLog` 里，不混进 events。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Habit {
    pub id: String,
    pub name: String,
    /// 目标频次，如每周 5 次
    #[serde(default)]
    pub target_per_week: u32,
    pub created_at: DateTime<FixedOffset>,
    #[serde(default)]
    pub deleted: bool,
}

/// 一次打卡。`date` 只到天，因为打卡是按天计的。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HabitLog {
    pub id: String,
    /// 引用 `Habit.id`
    pub habit_id: String,
    pub date: chrono::NaiveDate,
    pub created_at: DateTime<FixedOffset>,
}

/// 一次番茄钟/专注记录。分析页的「专注统计」读它。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusSession {
    pub id: String,
    /// 关联的事件；纯计时不关联任何事件时为 None
    #[serde(default)]
    pub event_id: Option<String>,
    pub start: DateTime<FixedOffset>,
    /// 实际专注秒数，可能短于计划（用户中途放弃）
    pub seconds: u32,
    #[serde(default)]
    pub completed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_theme")]
    pub theme: String,
    /// 0 = 周日，1 = 周一
    #[serde(default = "default_week_start")]
    pub week_start: u32,
    /// 新建事件时的默认提醒分钟数
    #[serde(default = "default_reminder")]
    pub default_reminder: i32,
    /// 开机自启，默认开。
    ///
    /// 和 `theme` / `week_start` 一样是**本机**偏好，不参与跨端合并——
    /// 手机上改这个不该影响 PC 的开机行为。
    #[serde(default = "default_autostart")]
    pub autostart: bool,
}

fn default_theme() -> String {
    "dark".to_string()
}

fn default_week_start() -> u32 {
    1
}

fn default_reminder() -> i32 {
    10
}

fn default_autostart() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: default_theme(),
            week_start: default_week_start(),
            default_reminder: default_reminder(),
            autostart: default_autostart(),
        }
    }
}

/// 一个完整的存档文件。导出、导入、自动备份搬运的都是这个结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Archive {
    pub version: u32,
    pub exported_at: DateTime<FixedOffset>,
    pub device: Device,
    #[serde(default)]
    pub events: Vec<Event>,
    #[serde(default)]
    pub plans: Vec<Plan>,
    #[serde(default)]
    pub tags: Vec<Tag>,
    #[serde(default)]
    pub habits: Vec<Habit>,
    #[serde(default)]
    pub habit_logs: Vec<HabitLog>,
    #[serde(default)]
    pub focus_sessions: Vec<FocusSession>,
    #[serde(default)]
    pub settings: Settings,
}

impl Default for Archive {
    fn default() -> Self {
        Archive {
            version: SCHEMA_VERSION,
            exported_at: now(),
            device: Device::Pc,
            events: Vec::new(),
            plans: Vec::new(),
            tags: Vec::new(),
            habits: Vec::new(),
            habit_logs: Vec::new(),
            focus_sessions: Vec::new(),
            settings: Settings::default(),
        }
    }
}

impl Archive {
    /// 只保留未删除的事件——渲染和分析都该用这个，别直接读 `events`。
    pub fn live_events(&self) -> impl Iterator<Item = &Event> {
        self.events.iter().filter(|e| !e.deleted)
    }

    /// 按 id 找事件。
    pub fn event(&self, id: &str) -> Option<&Event> {
        self.events.iter().find(|e| e.id == id)
    }

    pub fn event_mut(&mut self, id: &str) -> Option<&mut Event> {
        self.events.iter_mut().find(|e| e.id == id)
    }

    /// 只保留未删除的计划。与 `live_events` 同理，渲染计划页该用这个。
    pub fn live_plans(&self) -> impl Iterator<Item = &Plan> {
        self.plans.iter().filter(|p| !p.deleted)
    }

    pub fn plan(&self, id: &str) -> Option<&Plan> {
        self.plans.iter().find(|p| p.id == id)
    }

    pub fn plan_mut(&mut self, id: &str) -> Option<&mut Plan> {
        self.plans.iter_mut().find(|p| p.id == id)
    }

    /// 导入前的体检：版本不能比我们新，否则可能有读不懂的字段。
    pub fn check_version(&self) -> Result<(), String> {
        if self.version > SCHEMA_VERSION {
            return Err(format!(
                "存档版本 {} 高于本程序支持的 {}，请先升级程序",
                self.version, SCHEMA_VERSION
            ));
        }
        Ok(())
    }
}
