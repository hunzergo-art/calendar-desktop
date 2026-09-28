//! 提醒调度。
//!
//! 一个每 30 秒醒一次的后台线程，扫出「此刻该响」的提醒并发系统通知。
//!
//! 为什么不用「为每条提醒注册一个定时器」：事件会被增删改，
//! 定时器要跟着不停地注册/注销，漏掉一次就是提醒不响。
//! 轮询扫描没有状态同步问题——改完存档，下一轮自然就是新的了。
//!
//! 掉电/休眠期间错过的提醒不会补响，但会随下一轮扫描一起发出——
//! 因为判据是「提醒时刻已过 且 事件还没开始」，不是一个精确时刻。

use crate::model::{now, Archive, Event, Plan};
use crate::recurrence;
use crate::AppState;
use chrono::{Duration, NaiveDateTime};
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration as StdDuration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

/// 扫描间隔。
const TICK: StdDuration = StdDuration::from_secs(30);
/// 向后看多远。要覆盖得住最大的提醒提前量（这里按 24 小时算）。
const LOOKAHEAD_MINUTES: i64 = 24 * 60;

/// 计划的提醒时刻：提醒日期当天的 09:00。
///
/// 计划的提醒只到「天」，必须补一个具体时刻才能判「到点了没」。
/// 固定 09:00 而不是写成设置项，是因为长期计划本来就不需要精确到分钟——
/// 加一个设置项只会让它更难解释；真需要的话再说。
const PLAN_REMIND_HOUR: u32 = 9;

/// 已响过的提醒，用来去重。
/// 键是 (事件 id, 发生时刻, 提前分钟数)——同一个事件重复触发时
/// 每次发生的 start 不同，天然区分得开。
type FiredKey = (String, NaiveDateTime, i32);

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let fired: Mutex<HashSet<FiredKey>> = Mutex::new(HashSet::new());

        loop {
            std::thread::sleep(TICK);

            // 每轮都重新取 state：Tauri 的 manage 可能晚于线程启动完成。
            let Some(state) = app.try_state::<AppState>() else {
                continue;
            };
            let archive = state.archive().clone();

            match scan(&app, &archive, &fired) {
                Ok(fired_plans) if !fired_plans.is_empty() => {
                    // 把「已播报」落盘。**必须落盘**：计划的提醒日期不会自己
                    // 走开，只记在内存里的话每次重启都会重响一遍。
                    {
                        let mut live = state.archive();
                        for id in &fired_plans {
                            if let Some(plan) = live.plan_mut(id) {
                                plan.reminded = true;
                            }
                        }
                    }
                    if let Err(e) = state.persist() {
                        eprintln!("[提醒] 记录计划提醒状态失败：{e}");
                    }
                    // 广播，让已经开着的计划页/面板立刻把这条挪走。
                    let _ = app.emit(crate::commands::EVENT_ARCHIVE_CHANGED, state.archive().clone());
                }
                Ok(_) => {}
                Err(e) => eprintln!("[提醒] 扫描出错：{e}"),
            }
        }
    });
}

/// 扫一轮，发掉该发的通知。
///
/// 返回这一轮播报过的计划 id——调用方负责把它们标记成「已提醒」并落盘。
/// 不在这里直接改存档，是为了让 `scan` 保持「只读快照 + 发通知」的单一职责，
/// 也免得在持锁状态下调发通知这种可能失败的外部调用。
fn scan(
    app: &AppHandle,
    archive: &Archive,
    fired: &Mutex<HashSet<FiredKey>>,
) -> Result<Vec<String>, String> {
    let now_dt = now();
    let now_local = now_dt.naive_local();
    let horizon = now_local + Duration::minutes(LOOKAHEAD_MINUTES);

    let mut to_fire: Vec<(String, String)> = Vec::new();

    for event in archive.live_events() {
        if event.done {
            continue;
        }

        // 稍后提醒：到点了就再响一次，且这一轮跳过常规提醒。
        if let Some(snooze_until) = event.snoozed_until {
            let snooze_local = snooze_until.naive_local();
            if snooze_local > now_local {
                continue;
            }
            let key = (event.id.clone(), snooze_local, -1);
            if fired.lock().map(|mut f| f.insert(key)).unwrap_or(false) {
                let body = format!("（稍后提醒）{}", time_range(event));
                to_fire.push((event.title.clone(), body));
            }
            continue;
        }

        for occurrence in recurrence::occurrences(event, now_local, horizon) {
            for &lead in &event.reminders {
                let remind_at = occurrence - Duration::minutes(lead as i64);

                // 该响但还没开始：提醒时刻已过，事件尚未开始。
                // 用「未开始」而不是「未结束」做上界，是为了避免
                // 一个正在进行中的会议每隔 30 秒被反复提醒。
                if remind_at > now_local || occurrence <= now_local {
                    continue;
                }

                let key = (event.id.clone(), occurrence, lead);
                let inserted = fired.lock().map(|mut f| f.insert(key)).unwrap_or(false);
                if inserted {
                    to_fire.push((event.title.clone(), format!("{} 分钟后 · {}", lead, time_range(event))));
                }
            }
        }
    }

    // 长期计划：提醒日期当天 09:00 响一次。
    //
    // 刻意**没有下界**——不像事件那样要求「此刻之前不久才响」。事件的提醒
    // 有「事件开始时刻」兜底，错过了本来就毫无意义；计划的提醒没有这个上界，
    // 电脑关几天就会把提醒日期整个跨过去。既然每条只会响一次
    //（`reminded` 落盘，见上面的调用方），宁可晚一次也不要静默丢掉。
    let mut fired_plans: Vec<String> = Vec::new();
    for plan in archive.live_plans() {
        if !plan_reminder_due(plan, now_local) {
            continue;
        }
        to_fire.push((plan.title.clone(), plan_body(plan)));
        fired_plans.push(plan.id.clone());
    }

    for (title, body) in to_fire {
        if let Err(e) = app
            .notification()
            .builder()
            .title(&title)
            .body(&body)
            .show()
        {
            eprintln!("[提醒] 发通知失败：{e}");
        }
    }

    Ok(fired_plans)
}

/// 这条计划的提醒此刻该不该响。
///
/// 注意判据里**没有下界**：只要提醒日期已到（哪怕已过去很久）且还没播报过，
/// 就该响。理由见 `scan` 里那段注释。
fn plan_reminder_due(plan: &Plan, now_local: NaiveDateTime) -> bool {
    if plan.done || plan.reminded {
        return false;
    }
    // `target_date` 不参与——只有明确设了提醒日期才提醒。
    let Some(date) = plan.reminder_date else {
        return false;
    };
    let Some(at) = date.and_hms_opt(PLAN_REMIND_HOUR, 0, 0) else {
        return false;
    };
    at <= now_local
}

/// 计划提醒的正文：有目标日期就带上，剩几天由界面去算，
/// 通知里只说清楚「这是哪条计划的目标」。
fn plan_body(plan: &Plan) -> String {
    match plan.target_date {
        // NaiveDate 的 Display 就是 ISO 的 `2026-12-31`。
        Some(d) => format!("目标 {d}"),
        None => "长期计划提醒".to_string(),
    }
}

/// "15:00 - 16:00"，全天事件直接标出来。
fn time_range(event: &Event) -> String {
    if event.all_day {
        return "全天".to_string();
    }
    format!(
        "{} - {}",
        event.start.format("%H:%M"),
        event.end.format("%H:%M")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Event;

    #[test]
    fn 全天的时段文案() {
        let mut e = Event::new(
            "放假",
            "2026-09-19T00:00:00".parse().unwrap(),
            "2026-09-20T00:00:00".parse().unwrap(),
        );
        e.all_day = true;
        assert_eq!(time_range(&e), "全天");
    }

    #[test]
    fn 普通事件的时段文案() {
        let e = Event::new(
            "开会",
            "2026-09-19T15:00:00".parse().unwrap(),
            "2026-09-19T16:00:00".parse().unwrap(),
        );
        assert_eq!(time_range(&e), "15:00 - 16:00");
    }

    // ------------------------------------------------------------ 长期计划

    fn plan_with(reminder: Option<&str>) -> Plan {
        let mut p = Plan::new("学完数据库");
        p.reminder_date = reminder.map(|d| d.parse().unwrap());
        p
    }

    #[test]
    fn 没设提醒日期的计划不会响() {
        // 只设了目标日期：不该因为「顺手定了个截止日」就收到通知
        let mut p = Plan::new("读一本书");
        p.target_date = Some("2020-01-01".parse().unwrap());
        assert!(!plan_reminder_due(&p, "2026-09-22T10:00:00".parse().unwrap()));
    }

    #[test]
    fn 提醒日期当天九点之前不响九点之后响() {
        let p = plan_with(Some("2026-09-22"));
        assert!(!plan_reminder_due(&p, "2026-09-22T08:59:59".parse().unwrap()));
        assert!(plan_reminder_due(&p, "2026-09-22T09:00:00".parse().unwrap()));
        assert!(plan_reminder_due(&p, "2026-09-22T23:00:00".parse().unwrap()));
    }

    #[test]
    fn 错过的提醒日期不会静默丢掉() {
        // 电脑关了几天，回来时提醒日期已经过去——事件那种「过了就不响」
        // 在这里会造成永远收不到，所以计划要照响。
        let p = plan_with(Some("2026-09-18"));
        assert!(plan_reminder_due(&p, "2026-09-22T10:00:00".parse().unwrap()));
    }

    #[test]
    fn 已播报或已完成的计划不再响() {
        let now = "2026-09-22T10:00:00".parse().unwrap();

        let mut fired = plan_with(Some("2026-09-22"));
        fired.reminded = true;
        assert!(!plan_reminder_due(&fired, now), "响过就不该再响");

        let mut done = plan_with(Some("2026-09-22"));
        done.done = true;
        assert!(!plan_reminder_due(&done, now), "完成的计划不该再提醒");
    }

    #[test]
    fn 改了提醒日期就重新可以响() {
        let now = "2026-09-22T10:00:00".parse().unwrap();

        let mut p = plan_with(Some("2026-09-01"));
        p.reminded = true;
        assert!(!plan_reminder_due(&p, now));

        // 改到另一个日期 = 一条新提醒，得能再响
        p.set_reminder_date(Some("2026-09-22".parse().unwrap()));
        assert!(!p.reminded, "换日期应当清掉已播报");
        assert!(plan_reminder_due(&p, now));
    }

    #[test]
    fn 重复设置同一个提醒日期不会重置已播报() {
        // 只改了标题、顺手又提交了一次同样的日期——不该因此再响一遍
        let mut p = plan_with(Some("2026-09-22"));
        p.reminded = true;
        p.set_reminder_date(Some("2026-09-22".parse().unwrap()));
        assert!(p.reminded, "日期没变就不该重置");
    }

    #[test]
    fn 计划提醒的正文() {
        let mut p = Plan::new("学完数据库");
        assert_eq!(plan_body(&p), "长期计划提醒");

        p.target_date = Some("2026-12-31".parse().unwrap());
        assert_eq!(plan_body(&p), "目标 2026-12-31");
    }
}
