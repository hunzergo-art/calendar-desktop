/**
 * 时间解析与格式化。
 *
 * **所有时间字符串的解析都必须走这里**，原因是 JS 的 `new Date()` 有一处
 * 著名的坑：带时间的串按本地时区解析，但只有日期的串（`"2026-09-19"`）
 * 按 UTC 解析。在中国时区下后者会差 8 小时，正好跨过零点时日期就错一天。
 *
 * 本项目固定 UTC+8，不读系统时区。
 */

/** 项目固定时区偏移（分钟）。与 Rust 侧 `model::tz()` 对应。 */
const TZ_OFFSET_MINUTES = 8 * 60;

/**
 * 解析任一存档时间串。
 *
 * * `"2026-09-19T15:00:00"` —— 事件时间，无偏移，按 UTC+8 理解
 * * `"2026-09-18T09:00:00+08:00"` —— 时间戳，带偏移，按原样解析
 * * `"2026-09-18"` —— 只到日期，补成当天 00:00（**不按 UTC 解释**）
 */
export function parseTime(value: string): Date {
  const s = value.trim();

  // 纯日期：补零点，按固定时区换算。
  // 直接 new Date("2026-09-18") 会被当成 UTC 零点，是最容易踩的那一脚。
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - TZ_OFFSET_MINUTES * 60_000);
  }

  // 已带偏移（Z 或 ±hh:mm）：交给 Date 按标准解析。
  if (/[Zz]$|[+-]\d{2}:\d{2}$/.test(s)) {
    return new Date(s);
  }

  // 无偏移的日期时间：视为 UTC+8 的墙上时间。
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const [, y, mo, d, h, mi, sec] = m;
    return new Date(
      Date.UTC(
        Number(y),
        Number(mo) - 1,
        Number(d),
        Number(h),
        Number(mi),
        Number(sec ?? 0),
      ) -
        TZ_OFFSET_MINUTES * 60_000,
    );
  }

  // 认不出来就交给 Date 兜底，总比抛异常让整个视图白屏好。
  return new Date(s);
}

/** 把 Date 转成存档用的本地时间串 `"2026-09-19T15:00:00"`（无偏移）。 */
export function toLocalIso(d: Date): string {
  const shifted = new Date(d.getTime() + TZ_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 19);
}

/** 只取日期部分 `"2026-09-19"`。 */
export function toDateKey(d: Date): string {
  return toLocalIso(d).slice(0, 10);
}

/** 从 `"2026-09-19"` 造一个固定时区的 Date。 */
export function fromDateKey(key: string): Date {
  return parseTime(key);
}

/** `"15:00"` */
export function fmtTime(value: string | Date): string {
  const d = typeof value === "string" ? parseTime(value) : value;
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(d);
}

/** `"9月19日"` */
export function fmtMonthDay(value: string | Date): string {
  const d = typeof value === "string" ? parseTime(value) : value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    timeZone: "Asia/Shanghai",
  }).format(d);
}

/** `"9月19日 周五"` */
export function fmtDateWithWeekday(value: string | Date): string {
  const d = typeof value === "string" ? parseTime(value) : value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
    timeZone: "Asia/Shanghai",
  }).format(d);
}

/** `"15:00 - 16:00"`；全天事件返回 `"全天"`。 */
export function fmtRange(start: string, end: string, allDay = false): string {
  if (allDay) return "全天";
  return `${fmtTime(start)} - ${fmtTime(end)}`;
}

/** 相对今天的说法，用于小面板和列表：`"今天"` / `"明天"` / `"9月21日"`。 */
export function fmtRelativeDay(value: string | Date, today = new Date()): string {
  const d = typeof value === "string" ? parseTime(value) : value;
  const diff = Math.round(
    (startOfDay(d).getTime() - startOfDay(today).getTime()) / 86_400_000,
  );
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === -1) return "昨天";
  if (diff > 1 && diff < 7) {
    return new Intl.DateTimeFormat("zh-CN", {
      weekday: "long",
      timeZone: "Asia/Shanghai",
    }).format(d);
  }
  return fmtMonthDay(d);
}

/** 当天零点（固定时区）。 */
export function startOfDay(d: Date): Date {
  const key = toDateKey(d);
  return parseTime(key);
}

/** 加天数，返回新对象。 */
export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

/** 一周的起点。`weekStart`：0 = 周日，1 = 周一。 */
export function startOfWeek(d: Date, weekStart: number): Date {
  // 把时刻平移到 UTC 再取星期几：这样读到的就是 UTC+8 下的星期，
  // 不受运行机器所在时区影响。
  const shifted = new Date(d.getTime() + TZ_OFFSET_MINUTES * 60_000);
  const dow = shifted.getUTCDay();
  const delta = (dow - weekStart + 7) % 7;
  return startOfDay(addDays(d, -delta));
}

/** 固定时区下的小时与分钟。用 `getHours()` 会读成系统时区，必须避开。 */
export function hourMinute(d: Date): { hour: number; minute: number } {
  const shifted = new Date(d.getTime() + TZ_OFFSET_MINUTES * 60_000);
  return { hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() };
}

/** 从某天起连续 `count` 天。 */
export function daysFrom(start: Date, count: number): Date[] {
  return Array.from({ length: count }, (_, i) => addDays(start, i));
}

/** 两个时间是否同一天（按固定时区）。 */
export function isSameDay(a: Date, b: Date): boolean {
  return toDateKey(a) === toDateKey(b);
}

/** 时间段与某天有没有重叠——跨天事件靠它才能在每一天都显示出来。 */
export function overlapsDay(start: string, end: string, day: Date): boolean {
  const s = parseTime(start);
  const e = parseTime(end);
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  return s < dayEnd && e > dayStart;
}

/** 一天里的分钟偏移，用于时间轴定位。 */
export function minutesIntoDay(value: string | Date): number {
  const d = typeof value === "string" ? parseTime(value) : value;
  const { hour, minute } = hourMinute(d);
  return hour * 60 + minute;
}
