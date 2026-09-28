/**
 * 事件编辑弹窗。新建和编辑共用一套表单。
 *
 * 表单里用的是 `<input type="date">` 和 `<input type="time">`，
 * 拼装与拆解都经过 `lib/time.ts`，不自己做时区换算。
 */

import { useEffect, useMemo, useState } from "react";

import type {
  CalendarEvent,
  EventDraft,
  Priority,
  RepeatRule,
  Subtask,
  Tag,
} from "../types";
import { api } from "../lib/ipc";
import { parseTime, toDateKey, toLocalIso } from "../lib/time";

/** 提醒的预设档位（分钟）。多选。 */
const REMINDER_PRESETS = [0, 5, 10, 30, 60, 1440];

const PRIORITIES: { value: Priority; label: string }[] = [
  { value: "high", label: "高" },
  { value: "normal", label: "中" },
  { value: "low", label: "低" },
];

type RepeatKind = "none" | "daily" | "weekly" | "monthly" | "yearly";

const REPEAT_LABELS: { value: RepeatKind; label: string }[] = [
  { value: "none", label: "不重复" },
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "monthly", label: "每月" },
  { value: "yearly", label: "每年" },
];

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** RRULE → 下拉框选项。只认得出我们生成的那几种，其余归到「不重复」并原样保留。 */
function repeatKindOf(rule: RepeatRule | null): RepeatKind {
  if (!rule) return "none";
  const freq = rule.rrule.match(/FREQ=(\w+)/)?.[1]?.toUpperCase();
  switch (freq) {
    case "DAILY":
      return "daily";
    case "WEEKLY":
      return "weekly";
    case "MONTHLY":
      return "monthly";
    case "YEARLY":
      return "yearly";
    default:
      return "none";
  }
}

function ruleOf(kind: RepeatKind, startDate: Date): RepeatRule | null {
  switch (kind) {
    case "none":
      return null;
    case "daily":
      return { rrule: "FREQ=DAILY", exdates: [] };
    case "weekly":
      // 固定按开始日所在的星期几重复，这是最符合直觉的默认。
      return {
        rrule: `FREQ=WEEKLY;BYDAY=${WEEKDAY_CODES[startDate.getDay()]}`,
        exdates: [],
      };
    case "monthly":
      return { rrule: "FREQ=MONTHLY", exdates: [] };
    case "yearly":
      return { rrule: "FREQ=YEARLY", exdates: [] };
  }
}

/** `"2026-09-19"` + `"15:00"` → `"2026-09-19T15:00:00"` */
function combine(dateKey: string, time: string): string {
  return `${dateKey}T${time.length === 5 ? `${time}:00` : time}`;
}

interface EventEditorProps {
  /** null 表示新建 */
  event: CalendarEvent | null;
  /** 新建时的默认开始时间 */
  defaultStart: Date;
  tags: Tag[];
  defaultReminder: number;
  onClose: () => void;
  onSaved: () => void;
}

export function EventEditor({
  event,
  defaultStart,
  tags,
  defaultReminder,
  onClose,
  onSaved,
}: EventEditorProps) {
  const isNew = event === null;

  const [title, setTitle] = useState(event?.title ?? "");
  // 用 parseTime 而不是 new Date()：`start` 是没有偏移的本地串，
  // 在非 UTC+8 的机器上 new Date() 会解析成另一个时刻，日期可能差一天。
  const [dateKey, setDateKey] = useState(() =>
    toDateKey(event ? parseTime(event.start) : defaultStart),
  );
  const [startTime, setStartTime] = useState(() =>
    event ? event.start.slice(11, 16) : toLocalIso(defaultStart).slice(11, 16),
  );
  const [endTime, setEndTime] = useState(() => {
    if (event) return event.end.slice(11, 16);
    const end = new Date(defaultStart.getTime() + 3_600_000);
    return toLocalIso(end).slice(11, 16);
  });
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  const [priority, setPriority] = useState<Priority>(
    event?.priority ?? "normal",
  );
  const [notes, setNotes] = useState(event?.notes ?? "");
  const [selectedTags, setSelectedTags] = useState<string[]>(
    event?.tags ?? [],
  );
  const [reminders, setReminders] = useState<number[]>(
    event?.reminders ?? (isNew ? [defaultReminder] : []),
  );
  const [repeatKind, setRepeatKind] = useState<RepeatKind>(() =>
    repeatKindOf(event?.repeatRule ?? null),
  );
  const [subtasks, setSubtasks] = useState<Subtask[]>(event?.subtasks ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Esc 关闭。弹窗是有焦点的窗口，所以这个监听会正常触发。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const draft = useMemo((): EventDraft => {
    // 全天事件存成当天的 00:00 到次日 00:00，这样「是否跨天」的判定才一致。
    if (allDay) {
      const start = combine(dateKey, "00:00");
      const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
      const nextDay = new Date(Date.UTC(y, m - 1, d + 1))
        .toISOString()
        .slice(0, 10);
      return {
        title: title.trim(),
        start,
        end: combine(nextDay ?? dateKey, "00:00"),
        allDay: true,
        tags: selectedTags,
        priority,
        notes,
        subtasks,
        reminders,
        repeatRule: ruleOf(repeatKind, new Date(`${dateKey}T00:00:00`)),
      };
    }

    return {
      title: title.trim(),
      start: combine(dateKey, startTime),
      end: combine(dateKey, endTime),
      allDay: false,
      tags: selectedTags,
      priority,
      notes,
      subtasks,
      reminders,
      repeatRule: ruleOf(repeatKind, new Date(`${dateKey}T00:00:00`)),
    };
  }, [
    allDay,
    dateKey,
    endTime,
    notes,
    priority,
    reminders,
    repeatKind,
    selectedTags,
    startTime,
    subtasks,
    title,
  ]);

  // 结束早于开始是最常见的手滑，实时提示而不是等到保存才报错。
  const invalidRange = !allDay && draft.end <= draft.start;

  const submit = async () => {
    if (draft.title === "") {
      setError("标题不能为空");
      return;
    }
    if (invalidRange) {
      setError("结束时间不能早于开始时间");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (isNew) await api.createEvent(draft);
      else await api.updateEvent(event.id, draft);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!event) return;
    if (!window.confirm(`删除「${event.title}」？`)) return;

    setSaving(true);
    try {
      await api.deleteEvent(event.id);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleTag = (id: string) =>
    setSelectedTags((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    );

  const toggleReminder = (m: number) =>
    setReminders((prev) =>
      prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m].sort((a, b) => a - b),
    );

  const addSubtask = () =>
    setSubtasks((prev) => [
      ...prev,
      { id: crypto.randomUUID(), title: "", done: false },
    ]);

  const fieldClass =
    "w-full rounded-lg border border-white/10 bg-slate-800/60 px-2.5 py-1.5 text-[13px] text-slate-100 outline-none transition-colors focus:border-sky-500";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={(e) => {
        // 点遮罩关闭，点弹窗本身不关
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full w-[440px] flex-col overflow-hidden rounded-xl border border-white/10 bg-slate-900 shadow-2xl">
        <header className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
          <h2 className="text-[13px] font-medium text-slate-200">
            {isNew ? "新建日程" : "编辑日程"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded px-1.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-100"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) void submit();
            }}
            placeholder="要做什么？"
            className={`${fieldClass} text-[15px]`}
          />

          <div className="flex gap-2">
            <input
              type="date"
              value={dateKey}
              onChange={(e) => setDateKey(e.target.value)}
              className={fieldClass}
            />
            {!allDay ? (
              <>
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className={fieldClass}
                />
                <span className="self-center text-slate-500">–</span>
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className={fieldClass}
                />
              </>
            ) : null}
          </div>

          {invalidRange ? (
            <p className="text-[11px] text-rose-400">结束时间早于开始时间</p>
          ) : null}

          <label className="flex items-center gap-2 text-[12px] text-slate-300">
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)}
              className="accent-sky-500"
            />
            全天
          </label>

          {/* 重复 */}
          <div>
            <label className="mb-1 block text-[11px] text-slate-400">重复</label>
            <select
              value={repeatKind}
              onChange={(e) => setRepeatKind(e.target.value as RepeatKind)}
              className={fieldClass}
            >
              {REPEAT_LABELS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            {repeatKind !== "none" ? (
              <p className="mt-1 text-[11px] text-slate-500">
                拖动重复日程只改单次的功能还没做，需要时请在这里改。
              </p>
            ) : null}
          </div>

          {/* 优先级 */}
          <div>
            <label className="mb-1 block text-[11px] text-slate-400">优先级</label>
            <div className="flex gap-1">
              {PRIORITIES.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setPriority(p.value)}
                  className={[
                    "flex-1 rounded-lg px-2 py-1 text-[12px] transition-colors",
                    priority === p.value
                      ? "bg-sky-600 text-white"
                      : "bg-white/5 text-slate-300 hover:bg-white/10",
                  ].join(" ")}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* 标签 */}
          {tags.length > 0 ? (
            <div>
              <label className="mb-1 block text-[11px] text-slate-400">标签</label>
              <div className="flex flex-wrap gap-1">
                {tags.map((t) => {
                  const on = selectedTags.includes(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => toggleTag(t.id)}
                      className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors"
                      style={{
                        borderColor: on ? t.color : "rgba(255,255,255,0.12)",
                        backgroundColor: on ? `${t.color}33` : "transparent",
                        color: on ? "#f1f5f9" : "#94a3b8",
                      }}
                    >
                      <span
                        className="size-1.5 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      {t.name}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* 提醒 */}
          <div>
            <label className="mb-1 block text-[11px] text-slate-400">
              提醒（可多选）
            </label>
            <div className="flex flex-wrap gap-1">
              {REMINDER_PRESETS.map((m) => {
                const on = reminders.includes(m);
                const label =
                  m === 0
                    ? "准时"
                    : m === 1440
                      ? "提前 1 天"
                      : m >= 60
                        ? `提前 ${m / 60} 小时`
                        : `提前 ${m} 分钟`;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => toggleReminder(m)}
                    className={[
                      "rounded-full px-2 py-0.5 text-[11px] transition-colors",
                      on
                        ? "bg-sky-600 text-white"
                        : "bg-white/5 text-slate-400 hover:bg-white/10",
                    ].join(" ")}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 子任务 */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-[11px] text-slate-400">子任务</label>
              <button
                type="button"
                onClick={addSubtask}
                className="text-[11px] text-sky-400 hover:text-sky-300"
              >
                + 添加
              </button>
            </div>
            {subtasks.length === 0 ? (
              <p className="text-[11px] text-slate-600">暂无</p>
            ) : (
              <ul className="space-y-1">
                {subtasks.map((s, i) => (
                  <li key={s.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={s.done}
                      onChange={(e) =>
                        setSubtasks((prev) =>
                          prev.map((x, j) =>
                            j === i ? { ...x, done: e.target.checked } : x,
                          ),
                        )
                      }
                      className="accent-sky-500"
                    />
                    <input
                      value={s.title}
                      onChange={(e) =>
                        setSubtasks((prev) =>
                          prev.map((x, j) =>
                            j === i ? { ...x, title: e.target.value } : x,
                          ),
                        )
                      }
                      placeholder="子任务"
                      className={`${fieldClass} py-1 text-[12px]`}
                    />
                    <button
                      type="button"
                      aria-label="删除子任务"
                      onClick={() =>
                        setSubtasks((prev) => prev.filter((_, j) => j !== i))
                      }
                      className="shrink-0 rounded px-1 text-slate-500 hover:text-rose-400"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <label className="mb-1 block text-[11px] text-slate-400">备注</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className={`${fieldClass} resize-none`}
            />
          </div>

          {error ? <p className="text-[12px] text-rose-400">{error}</p> : null}
        </div>

        <footer className="flex gap-2 border-t border-white/10 px-4 py-2.5">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving || draft.title === "" || invalidRange}
            className="flex-1 rounded-lg bg-sky-600 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "保存中…" : "保存"}
          </button>
          {!isNew ? (
            <button
              type="button"
              onClick={() => void remove()}
              disabled={saving}
              className="rounded-lg bg-rose-600/20 px-3 py-1.5 text-[12px] text-rose-300 transition-colors hover:bg-rose-600/30 disabled:opacity-40"
            >
              删除
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-white/5 px-3 py-1.5 text-[12px] text-slate-300 transition-colors hover:bg-white/10"
          >
            取消
          </button>
        </footer>
      </div>
    </div>
  );
}
