/**
 * 长期计划编辑弹窗。新建和编辑共用一套表单。
 *
 * 骨架照 `EventEditor`：遮罩点击关闭、Esc 关闭、同一套字段样式。
 * 差别在字段本身——计划没有开始/结束时刻，只有「目标日期」和「提醒日期」
 * 两个**日期**（都只到天，可以留空）。
 *
 * 这里不碰 `done`：完成状态由列表上的勾选框负责，一个状态一个入口，
 * 免得两边都能改、还要处理「编辑器里改了没保存就关掉」这类中间态。
 */

import { useEffect, useMemo, useState } from "react";

import type { Plan, PlanDraft } from "../types";
import { api } from "../lib/ipc";
import { addDays, fmtMonthDay, parseTime, toDateKey } from "../lib/time";

interface PlanEditorProps {
  /** null 表示新建 */
  plan: Plan | null;
  onClose: () => void;
  onSaved: () => void;
}

/** 提醒日期相对目标日期提前几天——点一下就能填上的常用档位。 */
const LEAD_PRESETS = [1, 3, 7, 14];

export function PlanEditor({ plan, onClose, onSaved }: PlanEditorProps) {
  const isNew = plan === null;

  const [title, setTitle] = useState(plan?.title ?? "");
  const [targetDate, setTargetDate] = useState(plan?.targetDate ?? "");
  const [reminderDate, setReminderDate] = useState(plan?.reminderDate ?? "");
  const [notes, setNotes] = useState(plan?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const draft = useMemo(
    (): PlanDraft => ({
      title: title.trim(),
      // 空串在表单里表示「没设」，送到后端要变成 null——
      // 空字符串不是合法日期，会被 serde 直接拒掉。
      targetDate: targetDate === "" ? null : targetDate,
      reminderDate: reminderDate === "" ? null : reminderDate,
      notes,
    }),
    [title, targetDate, reminderDate, notes],
  );

  /** 提醒晚于目标日期通常是填错了，但不拦着——先提醒自己再定截止日也说得通。 */
  const reminderAfterTarget =
    draft.reminderDate !== null &&
    draft.targetDate !== null &&
    draft.reminderDate > draft.targetDate;

  const submit = async () => {
    if (draft.title === "") {
      setError("标题不能为空");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (isNew) await api.createPlan(draft);
      else await api.updatePlan(plan.id, draft);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!plan) return;
    if (!window.confirm(`删除计划「${plan.title}」？`)) return;

    setSaving(true);
    try {
      await api.deletePlan(plan.id);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  /** 按目标日期倒推一个提醒日期。刻意做成「点一下才填」而不是自动带出来：
   *  自动填等于替使用者定了一个会真的弹通知的日子，而他从没要求过。 */
  const fillLead = (days: number) => {
    // 走 `toDateKey` 而不是自己拆 Date 的字段：`parseTime` 返回的 Date
    // 是按 UTC+8 的零点算出来的，它的 `getUTCDate()` 会差一天。
    setReminderDate(toDateKey(addDays(parseTime(targetDate), -days)));
  };

  const fieldClass =
    "w-full rounded-lg border border-white/10 bg-slate-800/60 px-2.5 py-1.5 text-[13px] text-slate-100 outline-none transition-colors focus:border-sky-500";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full w-[440px] flex-col overflow-hidden rounded-xl border border-white/10 bg-slate-900 shadow-2xl">
        <header className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
          <h2 className="text-[13px] font-medium text-slate-200">
            {isNew ? "新建长期计划" : "编辑长期计划"}
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
            placeholder="想达成什么？"
            className={`${fieldClass} text-[15px]`}
          />

          <div>
            <label className="mb-1 block text-[11px] text-slate-400">
              目标日期
            </label>
            <div className="flex gap-2">
              <input
                type="date"
                value={targetDate}
                onChange={(e) => setTargetDate(e.target.value)}
                className={fieldClass}
              />
              {targetDate ? (
                <button
                  type="button"
                  onClick={() => setTargetDate("")}
                  className="shrink-0 rounded-lg bg-white/5 px-2.5 text-[12px] text-slate-400 transition-colors hover:bg-white/10"
                >
                  清除
                </button>
              ) : null}
            </div>
            <p className="mt-1 text-[11px] text-slate-600">
              可以留空。这个日期只是给你看还剩多久，不会自己弹提醒。
            </p>
          </div>

          <div>
            <label className="mb-1 block text-[11px] text-slate-400">
              提醒日期
            </label>
            <div className="flex gap-2">
              <input
                type="date"
                value={reminderDate}
                onChange={(e) => setReminderDate(e.target.value)}
                className={fieldClass}
              />
              {reminderDate ? (
                <button
                  type="button"
                  onClick={() => setReminderDate("")}
                  className="shrink-0 rounded-lg bg-white/5 px-2.5 text-[12px] text-slate-400 transition-colors hover:bg-white/10"
                >
                  清除
                </button>
              ) : null}
            </div>

            {/* 从目标日期倒推的常用档位。点一下才填，见 `fillLead` 的说明。 */}
            {targetDate && reminderDate === "" ? (
              <div className="mt-1.5 flex items-center gap-1.5">
                <span className="text-[11px] text-slate-600">
                  从目标日期倒数：
                </span>
                {LEAD_PRESETS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => fillLead(d)}
                    className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-200"
                  >
                    提前 {d} 天
                  </button>
                ))}
              </div>
            ) : null}

            <p className="mt-1 text-[11px] text-slate-600">
              {reminderDate === ""
                ? "留空就不提醒。填了的话，那天的 09:00 会收到一条通知。"
                : `${fmtMonthDay(reminderDate)} 09:00 提醒一次。`}
            </p>

            {reminderAfterTarget ? (
              <p className="mt-1 text-[11px] text-amber-400">
                提醒日期晚于目标日期，确认没填反？
              </p>
            ) : null}
          </div>

          <div>
            <label className="mb-1 block text-[11px] text-slate-400">备注</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              placeholder="想怎么推进、卡在哪一步…"
              className={`${fieldClass} resize-none`}
            />
          </div>

          {error ? <p className="text-[12px] text-rose-400">{error}</p> : null}
        </div>

        <footer className="flex gap-2 border-t border-white/10 px-4 py-2.5">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving || draft.title === ""}
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
