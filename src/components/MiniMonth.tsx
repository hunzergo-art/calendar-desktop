/**
 * 左侧的迷你月历。
 *
 * 只负责「翻月 + 选日子 + 一眼看出哪几天有事」，
 * 不显示事件内容——那是右边周视图和详情栏的事。
 */

import { useMemo } from "react";

import { addDays, startOfDay, startOfWeek, toDateKey } from "../lib/time";

interface MiniMonthProps {
  /** 当前显示的月份（取该月任意一天即可） */
  month: Date;
  selected: Date;
  today: Date;
  weekStart: number;
  /** 每个日期各有几件事，键是 `"2026-09-19"` */
  counts: Map<string, number>;
  onSelect: (d: Date) => void;
  onMonthChange: (d: Date) => void;
}

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

export function MiniMonth({
  month,
  selected,
  today,
  weekStart,
  counts,
  onSelect,
  onMonthChange,
}: MiniMonthProps) {
  const { cells, monthLabel } = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const gridStart = startOfWeek(first, weekStart);

    // 固定 6 行 × 7 列，这样翻月时高度不跳动。
    const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));

    const monthLabel = new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "long",
      timeZone: "Asia/Shanghai",
    }).format(first);

    return { cells, monthLabel };
  }, [month, weekStart]);

  // 表头按 weekStart 轮转，而不是固定从周日开始。
  const headers = useMemo(
    () =>
      Array.from(
        { length: 7 },
        (_, i) => WEEKDAY_LABELS[(weekStart + i) % 7] as string,
      ),
    [weekStart],
  );

  const monthOf = (d: Date) => d.getMonth() === month.getMonth();
  const todayKey = toDateKey(today);
  const selectedKey = toDateKey(selected);

  return (
    <div className="select-none">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] font-medium text-slate-300">
          {monthLabel}
        </span>
        <div className="flex gap-0.5">
          <button
            type="button"
            aria-label="上个月"
            onClick={() =>
              onMonthChange(new Date(month.getFullYear(), month.getMonth() - 1, 1))
            }
            className="rounded px-1.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-100"
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="下个月"
            onClick={() =>
              onMonthChange(new Date(month.getFullYear(), month.getMonth() + 1, 1))
            }
            className="rounded px-1.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-100"
          >
            ›
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-y-0.5 text-center">
        {headers.map((h) => (
          <div key={h} className="pb-1 text-[10px] text-slate-500">
            {h}
          </div>
        ))}

        {cells.map((d) => {
          const key = toDateKey(d);
          const count = counts.get(key) ?? 0;
          const inMonth = monthOf(d);
          const isToday = key === todayKey;
          const isSelected = key === selectedKey;

          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelect(startOfDay(d))}
              className={[
                "relative mx-auto flex size-6 items-center justify-center rounded-md text-[11px] tabular-nums transition-colors",
                isSelected
                  ? "bg-sky-600 font-medium text-white"
                  : isToday
                    ? "text-sky-400 hover:bg-white/10"
                    : inMonth
                      ? "text-slate-300 hover:bg-white/10"
                      : "text-slate-600 hover:bg-white/5",
              ].join(" ")}
            >
              {d.getDate()}
              {/* 有事的日子打点。3 件以上用更亮的点，避免堆一排看不清。 */}
              {count > 0 && !isSelected ? (
                <span
                  className={[
                    "absolute bottom-0.5 size-1 rounded-full",
                    count >= 3 ? "bg-sky-400" : "bg-slate-400",
                  ].join(" ")}
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
