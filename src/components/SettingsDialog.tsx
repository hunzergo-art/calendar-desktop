/**
 * 设置面板。
 *
 * 三块：通用（每周起始日、默认提醒）、启动（开机自启）、数据（导入导出、恢复备份）。
 *
 * ## 为什么没有「保存」按钮
 *
 * 所有设置项都是低风险且即时可见的——改了每周起始日，背后的日历当场就跟着转。
 * 多一个保存按钮只会多一个「改完忘了点保存」的坑，不如改完立刻生效。
 * 有破坏性的两处（覆盖导入、恢复备份）各自另有二次确认，不靠保存按钮兜底。
 *
 * ## 为什么值从属性读、不存本地副本
 *
 * 后端落盘后会广播存档，`settings` 属性随之更新。如果这里再存一份本地副本，
 * 保存失败时界面会停在那个假的「已开启」上——而实际上注册表压根没写成功。
 * 从属性读就自动回弹到真实值了。
 */

import { useEffect, useState, type ReactNode } from "react";

import type {
  BackupEntry,
  ImportMode,
  ImportPreview,
  MergeStats,
  Settings,
} from "../types";
import { api, pickOpenPath, pickSavePath } from "../lib/ipc";
import { fmtRelativeDay, fmtTime } from "../lib/time";

/** 默认提醒的可选分钟数，和 EventEditor 里的预设一致。 */
const REMINDER_PRESETS = [0, 5, 10, 30, 60, 1440];

/** 和 EventEditor 里同一套说法，免得两个地方对同一个值叫法不同。 */
function remindLabel(minutes: number): string {
  if (minutes === 0) return "不提醒";
  if (minutes === 1440) return "提前 1 天";
  if (minutes >= 60 && minutes % 60 === 0) return `提前 ${minutes / 60} 小时`;
  return `提前 ${minutes} 分钟`;
}

/**
 * 下拉里要显示的选项。
 *
 * 存档是从手机拷过来的，`defaultReminder` 可能是预设外的值（比如 15）。
 * 那种值如果不在选项里，`<select>` 会渲染成一片空白——看着像没设，
 * 实际却是有值的，一碰就被改掉。所以把当前值补进列表。
 */
function reminderOptions(current: number): number[] {
  return REMINDER_PRESETS.includes(current)
    ? REMINDER_PRESETS
    : [...REMINDER_PRESETS, current].sort((a, b) => a - b);
}

type View = "main" | "import" | "backups";

interface Props {
  settings: Settings;
  onClose: () => void;
}

export function SettingsDialog({ settings, onClose }: Props) {
  const [view, setView] = useState<View>("main");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);

  const [dataPath, setDataPath] = useState<string | null>(null);

  // 导入：先读懂文件给使用者看过，再决定合还是覆盖
  const [importPath, setImportPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);

  const [backups, setBackups] = useState<BackupEntry[] | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .dataDir()
      .then((p) => alive && setDataPath(p))
      .catch(() => {
        /* 拿不到路径不影响其它设置，静默即可 */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Esc 关闭。导出/导入进行中不响应，免得误触把对话框关掉、
  // 而背后的写盘还在跑，让人以为操作没生效。
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  /** 统一的「执行 + 提示」包装：管住 busy、把异常变成可见的一行字。 */
  async function run(fn: () => Promise<string | null>) {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const ok = await fn();
      if (ok) setStatus({ kind: "ok", text: ok });
    } catch (e) {
      setStatus({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  /** 改一项设置。整份 Settings 送过去，后端写盘并广播。 */
  function save(patch: Partial<Settings>) {
    void run(async () => {
      await api.updateSettings({ ...settings, ...patch });
      return null; // 设置项改动不需要提示条——界面本身就会变
    });
  }

  function doExport() {
    void run(async () => {
      const path = await pickSavePath(`日历存档-${dateStamp()}.json`);
      if (!path) return null;
      await api.exportArchive(path);
      return `已导出到 ${path}`;
    });
  }

  function doPickImport() {
    void run(async () => {
      const path = await pickOpenPath();
      if (!path) return null;
      const info = await api.inspectImport(path);
      setImportPath(path);
      setPreview(info);
      setView("import");
      return null;
    });
  }

  function doApplyImport(mode: ImportMode) {
    if (!importPath) return;

    if (
      mode === "replace" &&
      !window.confirm(
        "覆盖导入会用文件里的内容整体替换本机存档。\n\n" +
          "导入前会自动存一份备份，事后可以从「历史版本」里恢复回来。要继续吗？",
      )
    ) {
      return;
    }

    void run(async () => {
      const stats = await api.applyImport(importPath, mode);
      setView("main");
      setImportPath(null);
      setPreview(null);
      return describeStats(stats);
    });
  }

  function doLoadBackups() {
    void run(async () => {
      setBackups(await api.listBackups());
      setView("backups");
      return null;
    });
  }

  function doRestore(name: string) {
    if (
      !window.confirm(
        `要恢复到 ${name} 吗？\n\n` +
          "当前状态会先被存成一份新备份，所以这一步本身也可以再恢复回来。",
      )
    ) {
      return;
    }

    void run(async () => {
      await api.restoreBackup(name);
      setView("main");
      setBackups(null);
      return `已恢复到 ${name}`;
    });
  }

  const title =
    view === "import" ? "导入存档" : view === "backups" ? "历史版本" : "设置";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="flex max-h-full w-[460px] flex-col overflow-hidden rounded-xl border border-white/10 bg-slate-900 shadow-2xl">
        <header className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
          <h2 className="text-[14px] font-medium text-slate-100">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-1.5 text-[15px] leading-none text-slate-500 transition-colors hover:text-slate-300 disabled:opacity-40"
            aria-label="关闭"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {view === "main" && (
            <MainView
              settings={settings}
              busy={busy}
              dataPath={dataPath}
              onSave={save}
              onExport={doExport}
              onPickImport={doPickImport}
              onLoadBackups={doLoadBackups}
              onOpenDataDir={() =>
                void run(async () => {
                  await api.openDataDir();
                  return null;
                })
              }
            />
          )}

          {view === "import" && preview && (
            <ImportView
              preview={preview}
              busy={busy}
              onApply={doApplyImport}
              onBack={() => {
                setView("main");
                setImportPath(null);
                setPreview(null);
              }}
            />
          )}

          {view === "backups" && (
            <BackupsView
              backups={backups}
              busy={busy}
              onRestore={doRestore}
              onBack={() => {
                setView("main");
                setBackups(null);
              }}
            />
          )}
        </div>

        {status && (
          <div
            className={`shrink-0 border-t px-4 py-2 text-[12px] break-all ${
              status.kind === "ok"
                ? "border-sky-500/20 bg-sky-500/10 text-sky-300"
                : "border-rose-500/20 bg-rose-500/10 text-rose-300"
            }`}
          >
            {status.text}
          </div>
        )}

        <footer className="flex shrink-0 justify-end border-t border-white/10 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg bg-white/5 px-3 py-1.5 text-[12px] text-slate-300 transition-colors hover:bg-white/10 disabled:opacity-40"
          >
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}

interface Status {
  kind: "ok" | "error";
  text: string;
}

// ---------------------------------------------------------------- 主视图

function MainView({
  settings,
  busy,
  dataPath,
  onSave,
  onExport,
  onPickImport,
  onLoadBackups,
  onOpenDataDir,
}: {
  settings: Settings;
  busy: boolean;
  dataPath: string | null;
  onSave: (patch: Partial<Settings>) => void;
  onExport: () => void;
  onPickImport: () => void;
  onLoadBackups: () => void;
  onOpenDataDir: () => void;
}) {
  return (
    <div className="space-y-5">
      <Section title="通用">
        <Row label="每周起始日">
          <Segmented
            value={settings.weekStart}
            disabled={busy}
            onChange={(v) => onSave({ weekStart: v })}
            options={[
              { value: 1, label: "周一" },
              { value: 0, label: "周日" },
            ]}
          />
        </Row>

        <Row label="新建事件的默认提醒">
          <select
            value={settings.defaultReminder}
            disabled={busy}
            onChange={(e) => onSave({ defaultReminder: Number(e.target.value) })}
            className="rounded-lg border border-white/10 bg-slate-800/60 px-2 py-1 text-[12px] text-slate-100 outline-none transition-colors focus:border-sky-500 disabled:opacity-40"
          >
            {reminderOptions(settings.defaultReminder).map((m) => (
              <option key={m} value={m}>
                {remindLabel(m)}
              </option>
            ))}
          </select>
        </Row>
      </Section>

      <Section title="启动">
        <Row label="开机自启动" hint="登录 Windows 后自动运行，提醒才不会漏掉">
          <Toggle
            checked={settings.autostart}
            disabled={busy}
            onChange={(v) => onSave({ autostart: v })}
          />
        </Row>
      </Section>

      <Section title="数据">
        <p className="mb-2 text-[11px] leading-relaxed text-slate-500">
          存档是一份纯 JSON 文件，把它拷到手机上就是一次同步。导入时会自动先备份，
          所以「导错了」也能从历史版本里退回来。
        </p>

        <div className="grid grid-cols-2 gap-2">
          <ActionButton onClick={onExport} disabled={busy}>
            导出存档…
          </ActionButton>
          <ActionButton onClick={onPickImport} disabled={busy}>
            导入存档…
          </ActionButton>
          <ActionButton onClick={onLoadBackups} disabled={busy}>
            历史版本…
          </ActionButton>
          <ActionButton onClick={onOpenDataDir} disabled={busy}>
            打开数据目录
          </ActionButton>
        </div>

        {dataPath && (
          <p className="mt-2 text-[11px] break-all text-slate-600">{dataPath}</p>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------- 导入预览

function ImportView({
  preview,
  busy,
  onApply,
  onBack,
}: {
  preview: ImportPreview;
  busy: boolean;
  onApply: (mode: ImportMode) => void;
  onBack: () => void;
}) {
  const rows: [string, string][] = [
    ["导出于", `${fmtRelativeDay(preview.exportedAt)} ${fmtTime(preview.exportedAt)}`],
    ["来自", preview.device === "android" ? "Android" : "PC"],
    ["日程", `${preview.eventCount} 条`],
    ["长期计划", `${preview.planCount} 条`],
    ["标签", `${preview.tagCount} 个`],
    ["习惯", `${preview.habitCount} 个`],
    ["专注记录", `${preview.focusCount} 条`],
  ];

  return (
    <div className="space-y-4">
      <p className="text-[11px] leading-relaxed text-slate-500">
        文件读出来了，还没写进本机。先确认一下这是不是你要的那份。
      </p>

      <dl className="space-y-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 text-[12px]">
            <dt className="text-slate-500">{k}</dt>
            <dd className="text-slate-200">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="space-y-2">
        <button
          type="button"
          onClick={() => onApply("merge")}
          disabled={busy}
          className="w-full rounded-lg bg-sky-600 px-3 py-2 text-left text-[12px] font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          合并进本机
          <span className="mt-0.5 block font-normal text-white/70">
            按 id 对齐，两边都有的按「谁改得晚谁赢」裁决，本机独有的原样保留
          </span>
        </button>

        <button
          type="button"
          onClick={() => onApply("replace")}
          disabled={busy}
          className="w-full rounded-lg bg-rose-600/20 px-3 py-2 text-left text-[12px] font-medium text-rose-300 transition-colors hover:bg-rose-600/30 disabled:opacity-40"
        >
          覆盖本机存档
          <span className="mt-0.5 block font-normal text-rose-300/70">
            用文件里的内容整体替换，本机独有的会消失
          </span>
        </button>
      </div>

      <BackButton onClick={onBack} disabled={busy} />
    </div>
  );
}

// ---------------------------------------------------------------- 历史版本

function BackupsView({
  backups,
  busy,
  onRestore,
  onBack,
}: {
  backups: BackupEntry[] | null;
  busy: boolean;
  onRestore: (name: string) => void;
  onBack: () => void;
}) {
  if (backups === null) {
    return <p className="text-[12px] text-slate-500">正在读取…</p>;
  }

  if (backups.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-[12px] text-slate-500">
          还没有历史版本。每次存档被改动前都会自动存一份，用一阵子就有了。
        </p>
        <BackButton onClick={onBack} disabled={busy} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-slate-500">
        每次改动存档前都会自动存一份。点一条恢复——恢复前当前状态也会被存一份，
        所以恢复错了还能再退回来。
      </p>

      <ul className="max-h-[300px] space-y-1 overflow-y-auto">
        {backups.map((b) => (
          <li key={b.name}>
            <button
              type="button"
              onClick={() => onRestore(b.name)}
              disabled={busy}
              className="flex w-full items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left transition-colors hover:bg-white/10 disabled:opacity-40"
            >
              <span className="min-w-0">
                <span className="block truncate text-[12px] text-slate-200">
                  {b.modified
                    ? `${fmtRelativeDay(b.modified)} ${fmtTime(b.modified)}`
                    : b.name}
                </span>
                <span className="block truncate text-[10px] text-slate-600">
                  {b.name}
                </span>
              </span>
              <span className="shrink-0 text-[11px] text-slate-500">
                {formatSize(b.size)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <BackButton onClick={onBack} disabled={busy} />
    </div>
  );
}

// ---------------------------------------------------------------- 小组件

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-medium tracking-wide text-slate-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-[13px] text-slate-200">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
        checked ? "bg-sky-600" : "bg-white/15"
      }`}
    >
      <span
        className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${
          checked ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

function Segmented({
  value,
  options,
  disabled,
  onChange,
}: {
  value: number;
  options: { value: number; label: string }[];
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex shrink-0 rounded-lg border border-white/10 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 text-[12px] transition-colors disabled:opacity-40 ${
            value === o.value
              ? "bg-white/10 text-slate-100"
              : "text-slate-400 hover:text-slate-200"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ActionButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[12px] text-slate-300 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function BackButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-[12px] text-slate-500 transition-colors hover:text-slate-300 disabled:opacity-40"
    >
      ← 返回
    </button>
  );
}

// ---------------------------------------------------------------- 工具

/** 导出文件名里的日期戳，按 UTC+8 算。 */
function dateStamp(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 日程和计划分开说——混成「新增 3 条」就分不清是三件事还是三条计划。 */
function describeStats(s: MergeStats): string {
  const parts = [
    s.added > 0 && `新增日程 ${s.added} 条`,
    s.updated > 0 && `更新日程 ${s.updated} 条`,
    s.deleted > 0 && `删除日程 ${s.deleted} 条`,
    s.resurrected > 0 && `恢复日程 ${s.resurrected} 条`,
    s.planAdded > 0 && `新增计划 ${s.planAdded} 条`,
    s.planUpdated > 0 && `更新计划 ${s.planUpdated} 条`,
    s.planDeleted > 0 && `删除计划 ${s.planDeleted} 条`,
    s.planResurrected > 0 && `恢复计划 ${s.planResurrected} 条`,
  ].filter(Boolean) as string[];

  return parts.length > 0
    ? `合并完成：${parts.join("、")}`
    : "合并完成：两边已经一致，没有改动";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
