//! 存档的导入导出与合并。
//!
//! ## 合并的优先级规则
//!
//! 同一个 `id` 在两端都存在时，按下面的顺序裁决：
//!
//! 1. **`updatedAt` 新的赢。** 不管两边删没删——「删了之后又在另一端改过」
//!    意味着使用者显然还想要这条，应当复活；「改完之后又删了」则删除生效。
//! 2. **`updatedAt` 打平时，删除方赢。** 删除是一条不可逆的意图，
//!    而「复活一条已删的记录」比「少一条记录」更难被发现。
//!    这就是决策表里的「删除优先」。
//! 3. **`updatedAt` 打平且两边都没删时，保留本地。** 本地是使用者
//!    此刻正看着的那份，覆盖它会让人莫名其妙。
//!
//! 注：决策表原文写的是「删除优先 + `lastModifiedBy` 辅助；updatedAt 相同保留修改」。
//! 「删除优先」与「updatedAt 相同保留修改」在第 2/3 条上有歧义，
//! 上面这套是本实现的取舍，已由 `merge` 模块的测试逐条钉住。

use crate::model::*;
use crate::storage::{self, DataPaths};
use std::path::Path;

/// 合并结束后告诉使用者发生了什么——静默合并会让人不敢用。
#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeStats {
    /// 新增到本地的条数
    pub added: usize,
    /// 被对方版本覆盖的条数
    pub updated: usize,
    /// 因对方已删除而从本地移除的条数
    pub deleted: usize,
    /// 因本地更新而在对方删过的情况下保留的条数（复活）
    pub resurrected: usize,
    /// 完全没动的条数
    pub unchanged: usize,
    /// 计划单独计数：和日程混在一个数字里，「新增 3 条」就说不清是
    /// 三件事还是三条计划，出问题时无从判断。
    #[serde(default)]
    pub plan_added: usize,
    #[serde(default)]
    pub plan_updated: usize,
    #[serde(default)]
    pub plan_deleted: usize,
    #[serde(default)]
    pub plan_resurrected: usize,
    #[serde(default)]
    pub plan_unchanged: usize,
}

/// 谁赢。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Winner {
    Local,
    Remote,
}

/// 单条记录的裁决。规则见模块头注释。
///
/// 事件与计划共用：两者都有 `updatedAt` / `deleted`，合并语义没有区别，
/// 各写一遍迟早会在改规则时漏掉一边。
fn resolve(
    local_updated: chrono::DateTime<chrono::FixedOffset>,
    local_deleted: bool,
    remote_updated: chrono::DateTime<chrono::FixedOffset>,
    remote_deleted: bool,
) -> Winner {
    if local_updated > remote_updated {
        return Winner::Local;
    }
    if remote_updated > local_updated {
        return Winner::Remote;
    }
    // 时间戳打平：删除方优先
    match (local_deleted, remote_deleted) {
        (true, false) => Winner::Local,
        (false, true) => Winner::Remote,
        // 都没删或都删了——保留本地正在看的那份
        _ => Winner::Local,
    }
}

fn resolve_event(local: &Event, remote: &Event) -> Winner {
    resolve(
        local.updated_at,
        local.deleted,
        remote.updated_at,
        remote.deleted,
    )
}

fn resolve_plan(local: &Plan, remote: &Plan) -> Winner {
    resolve(
        local.updated_at,
        local.deleted,
        remote.updated_at,
        remote.deleted,
    )
}

/// 把 `remote` 合并进 `local`（就地修改 `local`）。
///
/// 按 `id` 对齐；`id` 只在一端存在的直接取并集。
pub fn merge(local: &mut Archive, remote: Archive) -> MergeStats {
    let mut stats = MergeStats::default();

    for incoming in remote.events {
        match local.events.iter_mut().find(|e| e.id == incoming.id) {
            None => {
                // 对方独有的记录直接收下
                stats.added += 1;
                local.events.push(incoming);
            }
            Some(existing) => match resolve_event(existing, &incoming) {
                Winner::Local => {
                    if existing.deleted && !incoming.deleted {
                        // 本地删除赢了，对方的修改被丢弃
                        stats.deleted += 1;
                    } else {
                        stats.unchanged += 1;
                    }
                }
                Winner::Remote => {
                    let was_deleted = existing.deleted;
                    *existing = incoming;
                    if was_deleted && !existing.deleted {
                        stats.resurrected += 1;
                    } else if existing.deleted {
                        stats.deleted += 1;
                    } else {
                        stats.updated += 1;
                    }
                }
            },
        }
    }

    // 长期计划与事件同一套裁决规则，只是计数器分开。
    for incoming in remote.plans {
        match local.plans.iter_mut().find(|p| p.id == incoming.id) {
            None => {
                stats.plan_added += 1;
                local.plans.push(incoming);
            }
            Some(existing) => match resolve_plan(existing, &incoming) {
                Winner::Local => {
                    if existing.deleted && !incoming.deleted {
                        stats.plan_deleted += 1;
                    } else {
                        stats.plan_unchanged += 1;
                    }
                }
                Winner::Remote => {
                    let was_deleted = existing.deleted;
                    *existing = incoming;
                    if was_deleted && !existing.deleted {
                        stats.plan_resurrected += 1;
                    } else if existing.deleted {
                        stats.plan_deleted += 1;
                    } else {
                        stats.plan_updated += 1;
                    }
                }
            },
        }
    }

    // 标签按 id 取并集，同 id 以对方为准（标签冲突的代价很低）。
    for incoming in remote.tags {
        match local.tags.iter_mut().find(|t| t.id == incoming.id) {
            None => local.tags.push(incoming),
            Some(existing) => *existing = incoming,
        }
    }

    // 习惯定义与事件一样有软删除语义。
    for incoming in remote.habits {
        match local.habits.iter_mut().find(|h| h.id == incoming.id) {
            None => local.habits.push(incoming),
            Some(existing) => {
                if resolve_event_like(
                    existing.deleted,
                    existing.created_at,
                    incoming.deleted,
                    incoming.created_at,
                ) {
                    *existing = incoming;
                }
            }
        }
    }

    // 打卡与专注记录是只增不改的流水，按 id 去重后并集即可。
    for log in remote.habit_logs {
        if !local.habit_logs.iter().any(|l| l.id == log.id) {
            local.habit_logs.push(log);
        }
    }
    for session in remote.focus_sessions {
        if !local.focus_sessions.iter().any(|s| s.id == session.id) {
            local.focus_sessions.push(session);
        }
    }

    // settings 是「这台机器的偏好」，不参与同步——
    // 没人希望手机上切了深色模式，PC 的窗口跟着变。
    stats
}

/// 习惯没有 updatedAt（打卡是独立的流水），退化成用 createdAt 比，
/// 删除方优先的规则保持一致。
fn resolve_event_like(
    local_deleted: bool,
    local_at: chrono::DateTime<chrono::FixedOffset>,
    remote_deleted: bool,
    remote_at: chrono::DateTime<chrono::FixedOffset>,
) -> bool {
    if remote_at > local_at {
        return true;
    }
    if local_at > remote_at {
        return false;
    }
    // 打平：删除方优先
    remote_deleted && !local_deleted
}

/// 导出：把当前存档写到一个使用者选定的路径。
///
/// 导出的是**完整存档**（含软删除的记录），这样另一端才能知道
/// 「这条是被删掉的」，而不是误以为从没存在过。
pub fn export_to(paths: &DataPaths, target: &Path, device_note: Device) -> storage::Result<()> {
    let mut archive = storage::read_archive(&paths.archive())?;
    archive.version = SCHEMA_VERSION;
    archive.exported_at = now();
    archive.device = device_note;

    let contents = serde_json::to_string_pretty(&archive)?;
    storage::write_atomic(target, &contents)?;
    Ok(())
}

/// 导入策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    /// 整体覆盖本地存档
    Replace,
    /// 按 id 合并，规则见模块头
    Merge,
}

/// 导入前先读懂并校验文件，但**先不落盘**——
/// 让使用者能在确认框里看到「会新增多少条」再决定。
pub fn inspect(path: &Path) -> storage::Result<Archive> {
    let archive = storage::read_archive(path)?;
    Ok(archive)
}

/// 按 `mode` 把 `incoming` 应用进本地存档。
///
/// 无论哪种模式，落盘前 `save_archive` 都会先备份，
/// 所以导入这一步本身永远是可回退的。
pub fn apply(
    paths: &DataPaths,
    incoming: Archive,
    mode: ImportMode,
) -> storage::Result<(Archive, MergeStats)> {
    let mut local = storage::read_archive(&paths.archive())?;

    let stats = match mode {
        ImportMode::Replace => {
            let stats = MergeStats {
                added: incoming.events.len(),
                plan_added: incoming.plans.len(),
                ..Default::default()
            };
            // `settings` 是**这台机器的**偏好，跟合并模式一样不该被对方覆盖。
            // 覆盖导入连它一起换掉的话，从手机导一次就会把 PC 的开机自启、
            // 每周起始日重置成手机上的值——而这几项跟「谁的日程更新」毫无关系。
            let mine = local.settings.clone();
            local = incoming;
            local.settings = mine;
            stats
        }
        ImportMode::Merge => merge(&mut local, incoming),
    };

    storage::save_archive(paths, &mut local)?;
    Ok((local, stats))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Days;

    fn ev(id: &str, title: &str, age_days: i64) -> Event {
        let mut e = Event::new(
            title,
            "2026-09-19T09:00:00".parse().unwrap(),
            "2026-09-19T10:00:00".parse().unwrap(),
        );
        e.id = id.to_string();
        e.updated_at = now() - Days::new(age_days as u64);
        e.created_at = e.updated_at;
        e
    }

    #[test]
    fn 对方独有的记录会被收下() {
        let mut local = Archive::default();
        local.events.push(ev("a", "本地的", 1));

        let mut remote = Archive::default();
        remote.events.push(ev("b", "对方的", 1));

        let stats = merge(&mut local, remote);
        assert_eq!(stats.added, 1);
        assert_eq!(local.events.len(), 2);
    }

    #[test]
    fn 时间戳新的赢() {
        let mut local = Archive::default();
        local.events.push(ev("a", "旧标题", 5));

        let mut remote = Archive::default();
        remote.events.push(ev("a", "新标题", 1));

        let stats = merge(&mut local, remote);
        assert_eq!(stats.updated, 1);
        assert_eq!(local.events[0].title, "新标题");
    }

    #[test]
    fn 本地更新时不会被对方的旧版本覆盖() {
        let mut local = Archive::default();
        local.events.push(ev("a", "本地较新", 1));

        let mut remote = Archive::default();
        remote.events.push(ev("a", "对方较旧", 5));

        merge(&mut local, remote);
        assert_eq!(local.events[0].title, "本地较新");
    }

    #[test]
    fn 删除之后没再被动过则删除生效() {
        let mut local = Archive::default();
        local.events.push(ev("a", "还活着", 5));

        let mut remote = Archive::default();
        let mut gone = ev("a", "还活着", 1);
        gone.deleted = true;
        remote.events.push(gone);

        let stats = merge(&mut local, remote);
        assert_eq!(stats.deleted, 1);
        assert!(local.events[0].deleted);
    }

    #[test]
    fn 删除之后又在另一端改过则该事件复活() {
        let mut local = Archive::default();
        let mut gone = ev("a", "已删", 5);
        gone.deleted = true;
        local.events.push(gone);

        let mut remote = Archive::default();
        remote.events.push(ev("a", "重新编辑过", 1)); // 更新且未删

        let stats = merge(&mut local, remote);
        assert_eq!(stats.resurrected, 1);
        assert!(!local.events[0].deleted);
        assert_eq!(local.events[0].title, "重新编辑过");
    }

    #[test]
    fn 时间戳打平时删除方优先() {
        // `now()` 每次调用都不同，两次调用永远差着微秒、永远打不平。
        // 要比平局就必须让"两边"共用同一个时刻，这里显式钉死。
        let tie = now() - Days::new(1);

        let mut local = Archive::default();
        let mut alive = ev("a", "活着", 1);
        alive.updated_at = tie;
        local.events.push(alive);

        let mut remote = Archive::default();
        let mut gone = ev("a", "活着", 1);
        gone.updated_at = tie;
        gone.deleted = true;
        remote.events.push(gone);

        merge(&mut local, remote);
        assert!(local.events[0].deleted, "打平时删除应当赢");
    }

    #[test]
    fn 时间戳打平且都没删时保留本地() {
        let tie = now() - Days::new(1);

        let mut local = Archive::default();
        let mut mine = ev("a", "本地版", 1);
        mine.updated_at = tie;
        local.events.push(mine);

        let mut remote = Archive::default();
        let mut theirs = ev("a", "对方版", 1);
        theirs.updated_at = tie;
        remote.events.push(theirs);

        merge(&mut local, remote);
        assert_eq!(local.events[0].title, "本地版");
    }

    #[test]
    fn 打卡流水按id去重后取并集() {
        let mut local = Archive::default();
        local.habit_logs.push(HabitLog {
            id: "l1".into(),
            habit_id: "h1".into(),
            date: "2026-09-18".parse().unwrap(),
            created_at: now(),
        });

        let mut remote = Archive::default();
        remote.habit_logs.push(HabitLog {
            id: "l1".into(), // 重复
            habit_id: "h1".into(),
            date: "2026-09-18".parse().unwrap(),
            created_at: now(),
        });
        remote.habit_logs.push(HabitLog {
            id: "l2".into(), // 新的
            habit_id: "h1".into(),
            date: "2026-09-19".parse().unwrap(),
            created_at: now(),
        });

        merge(&mut local, remote);
        assert_eq!(local.habit_logs.len(), 2);
    }

    // ------------------------------------------------------------ 长期计划

    fn pl(id: &str, title: &str, age_days: i64) -> Plan {
        let mut p = Plan::new(title);
        p.id = id.to_string();
        p.updated_at = now() - Days::new(age_days as u64);
        p.created_at = p.updated_at;
        p
    }

    #[test]
    fn 计划与事件各走各的计数() {
        let mut local = Archive::default();
        local.events.push(ev("a", "本地日程", 1));

        let mut remote = Archive::default();
        remote.plans.push(pl("p1", "对方的计划", 1));

        let stats = merge(&mut local, remote);

        // 计划不该混进事件的「新增 N 条」里，否则「新增 3 条」说不清是
        // 三件事还是三条计划
        assert_eq!(stats.added, 0);
        assert_eq!(stats.plan_added, 1);
        assert_eq!(local.plans.len(), 1);
    }

    #[test]
    fn 计划的合并规则与事件一致() {
        let mut local = Archive::default();
        local.plans.push(pl("p1", "旧标题", 5));

        let mut remote = Archive::default();
        remote.plans.push(pl("p1", "新标题", 1));

        let stats = merge(&mut local, remote);
        assert_eq!(stats.plan_updated, 1);
        assert_eq!(local.plans[0].title, "新标题");
    }

    #[test]
    fn 计划的删除之后又在另一端改过则复活() {
        let mut local = Archive::default();
        let mut gone = pl("p1", "已删", 5);
        gone.deleted = true;
        local.plans.push(gone);

        let mut remote = Archive::default();
        remote.plans.push(pl("p1", "重新编辑过", 1));

        let stats = merge(&mut local, remote);
        assert_eq!(stats.plan_resurrected, 1);
        assert!(!local.plans[0].deleted);
    }

    #[test]
    fn 计划的时间戳打平时删除方优先() {
        let tie = now() - Days::new(1);

        let mut local = Archive::default();
        let mut alive = pl("p1", "活着", 1);
        alive.updated_at = tie;
        local.plans.push(alive);

        let mut remote = Archive::default();
        let mut gone = pl("p1", "活着", 1);
        gone.updated_at = tie;
        gone.deleted = true;
        remote.plans.push(gone);

        merge(&mut local, remote);
        assert!(local.plans[0].deleted, "打平时删除应当赢");
    }

    #[test]
    fn 设置不参与合并() {
        let mut local = Archive::default();
        local.settings.theme = "dark".into();

        let mut remote = Archive::default();
        remote.settings.theme = "light".into();

        merge(&mut local, remote);
        assert_eq!(local.settings.theme, "dark", "本机偏好不该被对方覆盖");
    }

    #[test]
    fn 覆盖导入也不该带走本机偏好() {
        let paths = crate::storage::DataPaths::new(
            std::env::temp_dir().join(format!("cal-test-replace-{}", uuid::Uuid::new_v4())),
        );
        paths.ensure_dirs().unwrap();

        // 本机：自启开着，周起始日是周一
        let mut local = Archive::default();
        local.settings.autostart = true;
        local.settings.week_start = 1;
        crate::storage::save_archive(&paths, &mut local).unwrap();

        // 对方（手机）：同样是「设置」，但自启关着、周起始日是周日，
        // 另外带一条本机没有的日程
        let mut incoming = Archive::default();
        incoming.settings.autostart = false;
        incoming.settings.week_start = 0;
        incoming.events.push(ev("from-phone", "手机上加的", 1));

        let (result, _) = apply(&paths, incoming, ImportMode::Replace).unwrap();

        // 覆盖导入的本意是「日程以文件为准」，事件确实整个换掉了
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].id, "from-phone");

        // 但本机偏好得留下——否则从手机导一次就把 PC 的开机自启关掉了，
        // 而这件事和「谁的日程更新」没有任何关系
        assert!(result.settings.autostart, "覆盖导入不该把本机的开机自启改掉");
        assert_eq!(result.settings.week_start, 1, "每周起始日也该是本机的");
    }
}
