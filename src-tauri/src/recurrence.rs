//! 重复规则展开。
//!
//! 存档里存的是 RRULE 原文（决策表第 2 条：不展开成实例），
//! 视图渲染和提醒调度都需要把它「按需展开」成具体发生时间，就是这里。
//!
//! ## 支持的子集
//!
//! * `FREQ` = `DAILY` / `WEEKLY` / `MONTHLY` / `YEARLY`
//! * `INTERVAL=n`（默认 1）
//! * `BYDAY=MO,TU,...`（仅对 `WEEKLY` 有意义）
//! * `COUNT=n` / `UNTIL=20260930T235959`
//!
//! 未支持的部分（`BYMONTHDAY`、`BYSETPOS`、`BYWEEKNO` 等）会被**忽略**，
//! 而不是报错——个人使用几乎不会碰到，真需要时再补。
//! 忽略而非报错是刻意的：一个读不懂的字段不该让整个日程显示不出来。

use crate::model::Event;
use chrono::{Datelike, Duration, Months, NaiveDate, NaiveDateTime, Weekday};

/// 展开时的迭代上限。防止 `COUNT` 极大或规则写错导致死循环。
const MAX_ITERATIONS: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Debug, Clone)]
pub struct Rule {
    pub freq: Freq,
    pub interval: u32,
    /// 仅 `WEEKLY` 使用；为空时取起始日所在的星期几
    pub byday: Vec<Weekday>,
    pub count: Option<u32>,
    pub until: Option<NaiveDateTime>,
}

impl Rule {
    /// 解析 RRULE 原文。`FREQ` 缺失或不认识则返回 `None`。
    pub fn parse(raw: &str) -> Option<Rule> {
        let mut freq = None;
        let mut interval = 1u32;
        let mut byday = Vec::new();
        let mut count = None;
        let mut until = None;

        for part in raw.split(';') {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }
            let Some((key, value)) = part.split_once('=') else {
                continue;
            };
            match key.to_ascii_uppercase().as_str() {
                "FREQ" => {
                    freq = match value.to_ascii_uppercase().as_str() {
                        "DAILY" => Some(Freq::Daily),
                        "WEEKLY" => Some(Freq::Weekly),
                        "MONTHLY" => Some(Freq::Monthly),
                        "YEARLY" => Some(Freq::Yearly),
                        _ => None,
                    };
                }
                "INTERVAL" => {
                    // 0 或非法值会让步进卡住，退回 1。
                    interval = value.parse().ok().filter(|&n| n > 0).unwrap_or(1);
                }
                "BYDAY" => {
                    byday = value.split(',').filter_map(parse_weekday).collect();
                }
                "COUNT" => {
                    count = value.parse().ok().filter(|&n| n > 0);
                }
                "UNTIL" => {
                    until = parse_until(value);
                }
                _ => {}
            }
        }

        Some(Rule {
            freq: freq?,
            interval,
            byday,
            count,
            until,
        })
    }

    /// 第 `n` 次发生的全部候选时间（从 0 计）。
    ///
    /// 返回空 Vec 有两种含义，调用方不必区分：这次没有有效日期（如
    /// `FREQ=MONTHLY` 从 1 月 31 日出发遇到 2 月），或者已经算到了日期范围之外。
    /// **无效日期必须跳过而不是顺延**——RFC 5545 明确要求这类实例
    /// 「MUST be ignored and MUST NOT be counted」。顺延会让 1/31 变成
    /// 2/28，此后每月都是 28 号，整个日程表悄悄漂移。
    fn expand_nth(&self, base: NaiveDateTime, n: u32) -> Vec<NaiveDateTime> {
        // 用饱和乘法：INTERVAL 是从存档里读来的、没有上界，
        // 一个手改出来的 INTERVAL=4000000000 会让 `n * interval`
        // 在调试模式下直接 panic。饱和之后算出来的日期必然越界，
        // 由下面各分支的日期构造自然返回空。
        let step = n.saturating_mul(self.interval);

        match self.freq {
            Freq::Daily => base
                .checked_add_signed(Duration::days(step as i64))
                .into_iter()
                .collect(),

            Freq::Weekly if self.byday.is_empty() => base
                .checked_add_signed(Duration::weeks(step as i64))
                .into_iter()
                .collect(),

            Freq::Weekly => {
                // 先定位到那一周的周一，再按 BYDAY 逐天取。
                let week_start = base
                    .date()
                    .week(Weekday::Mon)
                    .first_day()
                    .and_time(base.time());

                let Some(week_start) =
                    week_start.checked_add_signed(Duration::weeks(step as i64))
                else {
                    return Vec::new();
                };

                let mut days = self.byday.clone();
                days.sort_by_key(|d| d.num_days_from_monday());
                days.into_iter()
                    .map(|d| week_start + Duration::days(d.num_days_from_monday() as i64))
                    .collect()
            }

            // 注意不能用 `checked_add_months`：它会把 1 月 31 日 +1 月
            // 夹成 2 月 28 日，那正是我们要避免的顺延行为。
            // 这里显式构造日期，不存在就返回空。
            Freq::Monthly => {
                let (year, month0) = shift_month(base.year(), base.month0(), step);
                NaiveDate::from_ymd_opt(year, month0 + 1, base.day())
                    .map(|d| d.and_time(base.time()))
                    .into_iter()
                    .collect()
            }

            // 走 i64 再收窄：`step as i32` 在 step 超过 i32::MAX 时会回绕成负数，
            // 算出个"公元前"的年份。超出 chrono 能表示的范围就当作没有。
            Freq::Yearly => {
                let year = base.year() as i64 + step as i64;
                if !(1..=9999).contains(&year) {
                    return Vec::new();
                }
                NaiveDate::from_ymd_opt(year as i32, base.month(), base.day())
                    .map(|d| d.and_time(base.time()))
                    .into_iter()
                    .collect()
            }
        }
    }

    /// 这一次的「下界」时间，只用于判断是否已经越过查询区间的右端。
    ///
    /// 取候选里**最早**的那个而不是最晚的：`FREQ=WEEKLY;BYDAY=MO,WE` 的
    /// 一周里周一在前，用最晚的（周三）当界会把整周提前判出局，
    /// 周一那次就丢了。反过来，若这次是无效日期（拿不到候选），
    /// 就退回「夹到月末」的值，否则循环会在那一格卡死。
    fn nth_lower_bound(&self, base: NaiveDateTime, n: u32) -> Option<NaiveDateTime> {
        self.expand_nth(base, n).into_iter().min().or_else(|| {
            let step = n.saturating_mul(self.interval);
            match self.freq {
                Freq::Monthly => base.checked_add_months(Months::new(step)),
                Freq::Yearly => base.checked_add_months(Months::new(step * 12)),
                _ => None,
            }
        })
    }
}

/// 在「年 + 月」上做加法，月份以 0 起算。返回 `(年, 月0)`。
fn shift_month(year: i32, month0: u32, step: u32) -> (i32, u32) {
    let total = year as i64 * 12 + month0 as i64 + step as i64;
    (
        total.div_euclid(12) as i32,
        total.rem_euclid(12) as u32,
    )
}

fn parse_weekday(token: &str) -> Option<Weekday> {
    // 允许 "MO" 和带序数的 "2MO"（序数部分被忽略）。
    let token = token.trim().to_ascii_uppercase();
    let code = token
        .trim_start_matches(|c: char| c.is_ascii_digit() || c == '-' || c == '+')
        .to_string();
    match code.as_str() {
        "MO" => Some(Weekday::Mon),
        "TU" => Some(Weekday::Tue),
        "WE" => Some(Weekday::Wed),
        "TH" => Some(Weekday::Thu),
        "FR" => Some(Weekday::Fri),
        "SA" => Some(Weekday::Sat),
        "SU" => Some(Weekday::Sun),
        _ => None,
    }
}

fn parse_until(value: &str) -> Option<NaiveDateTime> {
    let v = value.trim().trim_end_matches('Z');
    NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S")
        .ok()
        // 只给到日期的写法（20260930）也要能认。
        .or_else(|| {
            NaiveDate::parse_from_str(v, "%Y%m%d")
                .ok()
                .and_then(|d| d.and_hms_opt(23, 59, 59))
        })
}

/// 展开出 `[from, to]` 区间内的所有发生时间（含端点）。
///
/// 单次事件（`repeat_rule` 为 `None`）退化成「起点落在区间内就返回它」。
pub fn occurrences(event: &Event, from: NaiveDateTime, to: NaiveDateTime) -> Vec<NaiveDateTime> {
    let Some(repeat) = event.repeat_rule.as_ref() else {
        return if event.start >= from && event.start <= to {
            vec![event.start]
        } else {
            Vec::new()
        };
    };

    let Some(rule) = Rule::parse(&repeat.rrule) else {
        // 规则读不懂时退化成单次事件，至少不会让这条日程凭空消失。
        return if event.start >= from && event.start <= to {
            vec![event.start]
        } else {
            Vec::new()
        };
    };

    let excluded: std::collections::HashSet<NaiveDateTime> =
        repeat.exdates.iter().copied().collect();

    let mut out = Vec::new();
    let push = |t: NaiveDateTime, out: &mut Vec<NaiveDateTime>| {
        if t >= from && t <= to && !excluded.contains(&t) {
            out.push(t);
        }
    };

    // 已产出的有效次数。RFC 5545 规定 `COUNT` 数的是「重复集合」里的
    // 成员数，被跳过的无效日期不计入，所以不能用序号 n 代替。
    let mut emitted: u32 = 0;

    'expand: for n in 0..MAX_ITERATIONS as u32 {
        // 用下界判断是否已整段越过右端。下界算不出来说明日期范围到头了。
        let Some(bound) = rule.nth_lower_bound(event.start, n) else {
            break;
        };
        if bound > to {
            break;
        }

        for candidate in rule.expand_nth(event.start, n) {
            // 早于起始时刻的那几次不算数（如 BYDAY 覆盖到了起始日之前的那天）
            if candidate < event.start {
                continue;
            }

            if let Some(count) = rule.count {
                if emitted >= count {
                    break 'expand;
                }
            }
            if let Some(until) = rule.until {
                if candidate > until {
                    break 'expand;
                }
            }

            emitted += 1;
            push(candidate, &mut out);
        }
    }

    out.sort();
    out.dedup();
    out
}

/// 区间内第一次发生，没有则 `None`。列表视图与提醒调度常用。
pub fn next_occurrence(event: &Event, after: NaiveDateTime) -> Option<NaiveDateTime> {
    occurrences(
        event,
        after,
        after + Duration::days(366 * 5),
    )
    .into_iter()
    .next()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Event, RepeatRule};

    fn dt(s: &str) -> NaiveDateTime {
        s.parse().unwrap()
    }

    fn repeating(start: &str, rrule: &str) -> Event {
        let mut e = Event::new("测试", dt(start), dt(start) + Duration::hours(1));
        e.repeat_rule = Some(RepeatRule {
            rrule: rrule.to_string(),
            exdates: Vec::new(),
        });
        e
    }

    #[test]
    fn 单次事件只在区间内出现一次() {
        let e = Event::new("单次", dt("2026-09-19T09:00:00"), dt("2026-09-19T10:00:00"));
        assert_eq!(occurrences(&e, dt("2026-09-01T00:00:00"), dt("2026-09-30T00:00:00")).len(), 1);
        assert_eq!(occurrences(&e, dt("2026-10-01T00:00:00"), dt("2026-10-31T00:00:00")).len(), 0);
    }

    #[test]
    fn 每天重复能数对次数() {
        let e = repeating("2026-09-01T09:00:00", "FREQ=DAILY");
        let got = occurrences(&e, dt("2026-09-01T00:00:00"), dt("2026-09-07T23:59:59"));
        assert_eq!(got.len(), 7);
    }

    #[test]
    fn interval_生效() {
        let e = repeating("2026-09-01T09:00:00", "FREQ=DAILY;INTERVAL=3");
        let got = occurrences(&e, dt("2026-09-01T00:00:00"), dt("2026-09-10T23:59:59"));
        // 9/1, 9/4, 9/7, 9/10
        assert_eq!(got.len(), 4);
    }

    #[test]
    fn 每周指定星期几() {
        // 2026-09-02 是周三，BYDAY 取周一和周三
        let e = repeating("2026-09-02T09:00:00", "FREQ=WEEKLY;BYDAY=MO,WE");
        let got = occurrences(&e, dt("2026-09-01T00:00:00"), dt("2026-09-15T00:00:00"));
        // 9/2(三), 9/7(一), 9/9(三), 9/14(一)
        assert_eq!(got.len(), 4);
        assert_eq!(got[0], dt("2026-09-02T09:00:00"));
        assert_eq!(got[1], dt("2026-09-07T09:00:00"));
    }

    #[test]
    fn count_限制总次数() {
        let e = repeating("2026-09-01T09:00:00", "FREQ=DAILY;COUNT=3");
        let got = occurrences(&e, dt("2026-09-01T00:00:00"), dt("2026-09-30T00:00:00"));
        assert_eq!(got.len(), 3);
    }

    #[test]
    fn until_限制截止() {
        let e = repeating("2026-09-01T09:00:00", "FREQ=DAILY;UNTIL=20260903T235959");
        let got = occurrences(&e, dt("2026-09-01T00:00:00"), dt("2026-09-30T00:00:00"));
        assert_eq!(got.len(), 3);
    }

    #[test]
    fn exdate_排除掉指定的一次() {
        let mut e = repeating("2026-09-01T09:00:00", "FREQ=DAILY;COUNT=3");
        if let Some(r) = e.repeat_rule.as_mut() {
            r.exdates.push(dt("2026-09-02T09:00:00"));
        }
        let got = occurrences(&e, dt("2026-09-01T00:00:00"), dt("2026-09-30T00:00:00"));
        assert_eq!(got.len(), 2);
        assert!(!got.contains(&dt("2026-09-02T09:00:00")));
    }

    #[test]
    fn 每月31日遇到短月跳过而不是顺延() {
        let e = repeating("2026-01-31T09:00:00", "FREQ=MONTHLY");
        let got = occurrences(&e, dt("2026-01-01T00:00:00"), dt("2026-05-01T00:00:00"));
        // 1/31, 3/31 —— 2 月和 4 月没有 31 日
        assert_eq!(got.len(), 2);
    }

    #[test]
    fn 读不懂的规则退化成单次事件() {
        let e = repeating("2026-09-01T09:00:00", "这不是RRULE");
        let got = occurrences(&e, dt("2026-09-01T00:00:00"), dt("2026-09-30T00:00:00"));
        assert_eq!(got.len(), 1, "至少不该凭空消失");
    }

    #[test]
    fn 找不到下一次时返回none() {
        let e = repeating("2026-09-01T09:00:00", "FREQ=DAILY;COUNT=1");
        assert!(next_occurrence(&e, dt("2026-09-02T00:00:00")).is_none());
    }
}
