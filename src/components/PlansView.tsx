/**
 * 长期计划页：整页列出所有计划。
 *
 * 这是「计划单独显现」的落点——它不占用周/月视图的任何位置。
 * 计划的数据本身就和事件分开存放（`archive.plans` vs `archive.events`），
 * 周/月视图只展开 events，所以这里不需要在渲染层做任何过滤就达到了
 * 「不排挤其他任务」的效果；这个页面是它唯一的出口。
 */

import { useMemo, useState } from "react";

import type { Plan } from "../types";
import { api } from "../lib/ipc";
import { fmtMonthDay, parseTime, startOfDay } from "../lib/time";

interface PlansViewProps {
  /** 存档里的全部计划，含已软删除的——这里自己滤。 */
  plans: Plan[];
  today: Date;
  onOpen: (plan: Plan) => void;
  onNew: () => void;
}

/** 距今天还有几天。负数表示已经过去。 */
function daysUntil(dateKey: string, today: Date): number {
  const diff = parseTime(dateKey).getTime() - startOfDay(today).getTime();
  // 两端都是固定时区的零点，除以一天即可；四舍五入兜住理论上的边界。
  return Math.round(diff / 86_400_000);
}

/** `"12月21日"` + 还剩几天，供目标日期那一栏用。 */
function targetLabel(plan: Plan, today: Date): string {
  const key = plan.targetDate!;
  const d = daysUntil(key, today);
  const date = fmtMonthDay(key);

  if (plan.done) return date;
  if (d < 0) return `${date} · 已逾期 ${-d} 天`;
  if (d === 0) return `${date} · 今天到期`;
  if (d === 1) return `${date} · 明天到期`;
  return `${date} · 还剩 ${d} 天`;
}

/** 排序用的时间键：提醒日期优先，没有就退回目标日期。两者都没有则排最后。 */
function sortKey(plan: Plan): number {
  const key = plan.reminderDate ?? plan.targetDate;
  return key ? parseTime(key).getTime() : Infinity;
}

export function PlansView({ plans, today, onOpen, onNew }: PlansViewProps) {
  const [showDone, setShowDone] = useState(false);

  const live = useMemo(() => plans.filter((p) => !p.deleted), [plans]);

  const active = useMemo(
    () =>
      live
        .filter((p) => !p.done)
        .sort((a, b) => {
          const ka = sortKey(a);
          const kb = sortKey(b);
          if (ka !== kb) return ka - kb;
          return a.title.localeCompare(b.title, "zh-CN");
        }),
    [live],
  );

  const done = useMemo(
    () => live.filter((p) => p.done).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [live],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-3 py-2">
        <div className="text-[11px] text-slate-500">
          {active.length === 0 ? "没有进行中的计划" : `${active.length} 条进行中`}
        </div>
        <button
          type="button"
          onClick={onNew}
          className="rounded-lg bg-sky-600 px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-sky-500"
        >
          + 新建计划
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {active.length === 0 && done.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-slate-500">
            <p className="text-[13px]">还没有长期计划</p>
            <p className="text-[11px]">
              目标在几个月之后的事放这里——它不会挤占日历的时间格。
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {active.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                today={today}
                onOpen={() => onOpen(plan)}
              />
            ))}
          </ul>
        )}

        {done.length > 0 ? (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setShowDone((v) => !v)}
              className="text-[11px] text-slate-500 transition-colors hover:text-slate-300"
            >
              {showDone ? "▾" : "▸"} 已完成（{done.length}）
            </button>

            {showDone ? (
              <ul className="mt-2 space-y-2">
                {done.map((plan) => (
                  <PlanCard
                    key={plan.id}
                    plan={plan}
                    today={today}
                    onOpen={() => onOpen(plan)}
                  />
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PlanCard({
  plan,
  today,
  onOpen,
}: {
  plan: Plan;
  today: Date;
  onOpen: () => void;
}) {
  const overdue =
    !plan.done && plan.targetDate !== null && daysUntil(plan.targetDate, today) < 0;

  // 「提醒还没响过」。多数时候只是还没到那个日子；少数时候是到了但程序没开
  // （提醒没有下界，下次启动会补上）。两种都点亮，用法是一致的：
  // 亮着 = 这条提醒还没兑现。
  const reminderPending =
    !plan.done && plan.reminderDate !== null && !plan.reminded;

  return (
    <li>
      <div className="flex items-start gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 transition-colors hover:bg-white/[0.06]">
        <button
          type="button"
          aria-label={plan.done ? "标记为未完成" : "标记为已完成"}
          onClick={(e) => {
            e.stopPropagation();
            void api.togglePlanDone(plan.id);
          }}
          className={[
            "mt-0.5 size-4 shrink-0 rounded border transition-colors",
            plan.done
              ? "border-emerald-400 bg-emerald-400/90 text-slate-900"
              : "border-slate-500 hover:border-slate-300",
          ].join(" ")}
        >
          {plan.done ? (
            <svg viewBox="0 0 16 16" className="size-full p-0.5">
              <path
                d="M3 8.5l3 3 7-7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : null}
        </button>

        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 text-left"
        >
          <div
            className={[
              "truncate text-[13px]",
              plan.done ? "text-slate-500 line-through" : "text-slate-100",
            ].join(" ")}
          >
            {plan.title}
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
            {plan.reminderDate ? (
              <span
                className={
                  reminderPending ? "text-sky-400" : "text-slate-500"
                }
              >
                ⏰ 提醒 {fmtMonthDay(plan.reminderDate)}
              </span>
            ) : null}

            {plan.targetDate ? (
              <span
                className={
                  overdue
                    ? "text-rose-400"
                    : plan.done
                      ? "text-slate-600"
                      : "text-slate-400"
                }
              >
                目标 {targetLabel(plan, today)}
              </span>
            ) : null}

            {!plan.reminderDate && !plan.targetDate ? (
              <span className="text-slate-600">没有日期</span>
            ) : null}
          </div>

          {plan.notes ? (
            <div className="mt-1 line-clamp-2 text-[11px] whitespace-pre-wrap text-slate-500">
              {plan.notes}
            </div>
          ) : null}
        </button>
      </div>
    </li>
  );
}
