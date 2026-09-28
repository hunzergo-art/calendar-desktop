//! 存档的落盘与备份。
//!
//! 纯离线软件最大的风险是数据丢失，所以这一层的两条铁律：
//!   1. **原子写入**——先写临时文件再重命名。中途断电/崩溃时，
//!      `calendar.json` 要么是旧的完整内容，要么是新的完整内容，
//!      绝不会是写了一半的残缺 JSON。
//!   2. **写前备份**——每次写入前把当前文件复制成 `.bak`，
//!      写入后再往 `backups/` 存一份快照。任何一次误操作都能回退。

use crate::model::{Archive, Device, SCHEMA_VERSION};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// 每次写入都存一份快照，只保留最近这么多份。
const SNAPSHOT_KEEP: usize = 10;
/// 每天额外存一份，保留这么多天。
const DAILY_KEEP: i64 = 30;
/// 软删除的记录保留多久后物理清除。
const SOFT_DELETE_TTL_DAYS: i64 = 90;

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("读写文件失败：{0}")]
    Io(#[from] std::io::Error),
    #[error("存档 JSON 解析失败：{0}")]
    Parse(#[from] serde_json::Error),
    #[error("存档版本不兼容：{0}")]
    Version(String),
    #[error("找不到文件：{0}")]
    NotFound(String),
}

pub type Result<T> = std::result::Result<T, StorageError>;

/// 应用的全部数据路径。集中在一处，避免各模块自己拼路径。
#[derive(Debug, Clone)]
pub struct DataPaths {
    pub root: PathBuf,
    pub data_dir: PathBuf,
    pub backups_dir: PathBuf,
    pub logs_dir: PathBuf,
}

impl DataPaths {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let data_dir = app_data_dir.join("data");
        let backups_dir = app_data_dir.join("backups");
        let logs_dir = app_data_dir.join("logs");
        DataPaths {
            root: app_data_dir,
            data_dir,
            backups_dir,
            logs_dir,
        }
    }

    pub fn archive(&self) -> PathBuf {
        self.data_dir.join("calendar.json")
    }

    /// 主存档的「上一版」。比 backups/ 里的更近，是最后一道保险。
    pub fn archive_bak(&self) -> PathBuf {
        self.data_dir.join("calendar.json.bak")
    }

    pub fn config(&self) -> PathBuf {
        self.root.join("config.json")
    }

    pub fn log(&self) -> PathBuf {
        self.logs_dir.join("app.log")
    }

    /// 建齐所有目录。幂等，启动时调一次即可。
    pub fn ensure_dirs(&self) -> Result<()> {
        for dir in [&self.data_dir, &self.backups_dir, &self.logs_dir] {
            fs::create_dir_all(dir)?;
        }
        Ok(())
    }
}

/// 读存档。文件不存在时返回一份空存档，让首次启动直接可用。
pub fn read_archive(path: &Path) -> Result<Archive> {
    if !path.exists() {
        return Ok(Archive::default());
    }
    let text = fs::read_to_string(path)?;
    let archive: Archive = serde_json::from_str(&text)?;
    archive
        .check_version()
        .map_err(StorageError::Version)?;
    Ok(archive)
}

/// 原子写入：临时文件 → fsync → 重命名覆盖。
///
/// 关键在最后一步：Windows 上 `fs::rename` 走的是
/// `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`，对文件是原子替换，
/// 所以不会出现「读到半个文件」的窗口。
pub fn write_atomic(path: &Path, contents: &str) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(contents.as_bytes())?;
        // 不 fsync 的话，重命名可能先于数据落盘，掉电后文件是空的。
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

/// 把当前存档写成 `.bak`。写之前调，用来兜住「刚写坏一次」的情况。
fn copy_to_bak(paths: &DataPaths) -> Result<()> {
    let src = paths.archive();
    if src.exists() {
        fs::copy(&src, paths.archive_bak())?;
    }
    Ok(())
}

/// 往 `backups/` 存一份快照（含当日的一份），并清理超期的旧备份。
fn snapshot(paths: &DataPaths, contents: &str, stamp: chrono::DateTime<chrono::FixedOffset>) -> Result<()> {
    fs::create_dir_all(&paths.backups_dir)?;

    // 1) 每次写入都存，保留最近 SNAPSHOT_KEEP 份
    let name = format!("calendar-{}.json", stamp.format("%Y%m%d-%H%M%S"));
    fs::write(paths.backups_dir.join(name), contents)?;
    prune_pattern(&paths.backups_dir, "calendar-", Some(SNAPSHOT_KEEP), None)?;

    // 2) 当天第一份额外留档，保留 DAILY_KEEP 天。
    //    「按次」的快照几小时就被冲掉了，按天的才能回溯到上周。
    let daily = format!("daily-{}.json", stamp.format("%Y%m%d"));
    let daily_path = paths.backups_dir.join(daily);
    if !daily_path.exists() {
        fs::write(&daily_path, contents)?;
        prune_pattern(&paths.backups_dir, "daily-", None, Some(DAILY_KEEP))?;
    }

    Ok(())
}

/// 按文件名前缀清理旧备份。`keep_count` 限制份数，`keep_days` 限制天数。
fn prune_pattern(
    dir: &Path,
    prefix: &str,
    keep_count: Option<usize>,
    keep_days: Option<i64>,
) -> Result<()> {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(prefix) && n.ends_with(".json"))
        })
        .collect();

    // 文件名里带时间戳，字典序即时间序。
    entries.sort();

    let mut doomed: Vec<PathBuf> = Vec::new();

    if let Some(keep) = keep_count {
        if entries.len() > keep {
            doomed.extend(entries.drain(..entries.len() - keep));
        }
    }

    if let Some(days) = keep_days {
        let cutoff = crate::model::now().date_naive() - chrono::Days::new(days as u64);
        for path in entries {
            // daily-YYYYMMDD.json
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let Some(date_part) = stem.strip_prefix(prefix) else {
                continue;
            };
            if let Ok(d) = chrono::NaiveDate::parse_from_str(date_part, "%Y%m%d") {
                if d < cutoff {
                    doomed.push(path);
                }
            }
        }
    }

    for path in doomed {
        // 删不掉不影响主流程（可能被杀软占用），忽略即可。
        let _ = fs::remove_file(path);
    }
    Ok(())
}

/// 保存存档：备份 → 原子写 → 快照。
///
/// 顺序不能换。先备份再写，才能保证 `.bak` 里是「这次修改之前」的完整状态。
pub fn save_archive(paths: &DataPaths, archive: &mut Archive) -> Result<()> {
    paths.ensure_dirs()?;

    archive.version = SCHEMA_VERSION;
    archive.exported_at = crate::model::now();
    archive.device = Device::Pc;

    cleanup_soft_deleted(archive);

    let contents = serde_json::to_string_pretty(archive)?;

    copy_to_bak(paths)?;
    write_atomic(&paths.archive(), &contents)?;
    snapshot(paths, &contents, crate::model::now())?;

    Ok(())
}

/// 物理清除超过保留期的软删除记录。
///
/// 不清理的话，删掉的会议会永远躺在存档里，文件只增不减。
/// 90 天足够长——真要恢复三个月前删的东西，也该去翻 backups/。
fn cleanup_soft_deleted(archive: &mut Archive) {
    let cutoff = crate::model::now() - chrono::Days::new(SOFT_DELETE_TTL_DAYS as u64);
    archive
        .events
        .retain(|e| !e.deleted || e.updated_at > cutoff);
    // 计划同理。漏掉这一句的话，删掉的计划会永远躺在存档里。
    archive
        .plans
        .retain(|p| !p.deleted || p.updated_at > cutoff);
}

/// 列出现有备份，新的在前。
pub fn list_backups(paths: &DataPaths) -> Result<Vec<BackupEntry>> {
    if !paths.backups_dir.exists() {
        return Ok(Vec::new());
    }
    let mut out: Vec<BackupEntry> = fs::read_dir(&paths.backups_dir)?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_str()?.to_string();
            if !name.ends_with(".json") {
                return None;
            }
            let meta = e.metadata().ok()?;
            Some(BackupEntry {
                name,
                size: meta.len(),
                modified: meta.modified().ok().map(|t| {
                    // SystemTime → DateTime<Utc> → 固定时区。
                    // 不走 SystemTimeExt，免得依赖 chrono 的可选 trait。
                    chrono::DateTime::<chrono::Utc>::from(t)
                        .with_timezone(&crate::model::tz())
                }),
            })
        })
        .collect();
    out.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(out)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub name: String,
    pub size: u64,
    pub modified: Option<chrono::DateTime<chrono::FixedOffset>>,
}

/// 从某个备份文件恢复。恢复前会先把当前状态存成快照，
/// 所以「恢复错了」本身也是可撤销的。
pub fn restore_backup(paths: &DataPaths, name: &str) -> Result<Archive> {
    // 防目录穿越：只接受纯文件名，不接受带路径分隔符的输入。
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(StorageError::NotFound(name.to_string()));
    }
    let path = paths.backups_dir.join(name);
    if !path.exists() {
        return Err(StorageError::NotFound(name.to_string()));
    }

    let restored = read_archive(&path)?;
    // 存回去时走正常保存流程，于是当前状态（恢复之前的那份）也会进 backups/，
    // 「恢复错了」因此同样可以再恢复回来。
    let mut to_save = restored.clone();
    save_archive(paths, &mut to_save)?;
    Ok(restored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Event;

    fn temp_paths(tag: &str) -> DataPaths {
        let root = std::env::temp_dir().join(format!("cal-test-{tag}-{}", uuid::Uuid::new_v4()));
        DataPaths::new(root)
    }

    #[test]
    fn 首次启动读到空存档而不是报错() {
        let paths = temp_paths("empty");
        let archive = read_archive(&paths.archive()).unwrap();
        assert!(archive.events.is_empty());
        assert_eq!(archive.version, SCHEMA_VERSION);
    }

    #[test]
    fn 写入后能原样读回() {
        let paths = temp_paths("roundtrip");
        let mut archive = Archive::default();
        archive.events.push(Event::new(
            "开会",
            "2026-09-19T15:00:00".parse().unwrap(),
            "2026-09-19T16:00:00".parse().unwrap(),
        ));
        save_archive(&paths, &mut archive).unwrap();

        let back = read_archive(&paths.archive()).unwrap();
        assert_eq!(back.events.len(), 1);
        assert_eq!(back.events[0].title, "开会");
        // 时间必须逐字往返，不能被时区转换动过
        assert_eq!(
            back.events[0].start.to_string(),
            "2026-09-19 15:00:00"
        );
    }

    #[test]
    fn 第二次写入会留下上一版的bak和一份快照() {
        let paths = temp_paths("backup");
        save_archive(&paths, &mut Archive::default()).unwrap();
        save_archive(&paths, &mut Archive::default()).unwrap();

        assert!(paths.archive_bak().exists(), "应留下 .bak");
        assert!(
            !list_backups(&paths).unwrap().is_empty(),
            "backups/ 应有快照"
        );
    }

    #[test]
    fn 超过保留期的软删除会被清掉() {
        let mut archive = Archive::default();
        let mut dead = Event::new(
            "很久以前删的",
            "2020-01-01T09:00:00".parse().unwrap(),
            "2020-01-01T10:00:00".parse().unwrap(),
        );
        dead.deleted = true;
        dead.updated_at = crate::model::now() - chrono::Days::new(200);

        let mut fresh = Event::new(
            "刚删的",
            "2026-09-19T09:00:00".parse().unwrap(),
            "2026-09-19T10:00:00".parse().unwrap(),
        );
        fresh.deleted = true;

        archive.events.push(dead);
        archive.events.push(fresh);

        cleanup_soft_deleted(&mut archive);

        assert_eq!(archive.events.len(), 1, "只该清掉过期的那条");
        assert_eq!(archive.events[0].title, "刚删的");
    }

    #[test]
    fn 超过保留期的软删除计划也会被清掉() {
        // 漏掉计划这一路的清理，删掉的计划会永远躺在存档里，只增不减
        let mut archive = Archive::default();

        let mut dead = crate::model::Plan::new("很久以前删的");
        dead.deleted = true;
        dead.updated_at = crate::model::now() - chrono::Days::new(200);

        let mut fresh = crate::model::Plan::new("刚删的");
        fresh.deleted = true;

        archive.plans.push(dead);
        archive.plans.push(fresh);

        cleanup_soft_deleted(&mut archive);

        assert_eq!(archive.plans.len(), 1, "只该清掉过期的那条");
        assert_eq!(archive.plans[0].title, "刚删的");
    }

    #[test]
    fn 恢复备份会拒绝带路径分隔符的文件名() {
        let paths = temp_paths("traversal");
        paths.ensure_dirs().unwrap();
        assert!(restore_backup(&paths, "../../config.json").is_err());
    }
}
