/**
 * 月视图：6×7 的网格，每格列出当天的头几件事。
 *
 * 固定 6 行而不是按月份算行数——翻月时网格高度不跳动，
 * 视觉上稳得多，代价是偶尔多出一整行空行。
 */

import { useMemo } from "react";

import type { Tag } from "../types";
import type { OccurrenceView } from "../lib/useArchive";
import { addDays, fmtTime, parseTime, startOfWeek, toDateKey } from "../lib/time";

/** 每格最多列几条，超出用「+N」收起来。 */
const MAX_CHIPS = 3;

interface MonthViewProps {
  month: Date;
  today: Date;
  weekStart: number;
  occurrences: OccurrenceView[];
  tagMap: Map<string, Tag>;
  onOpenEvent: (occ: OccurrenceView) => void;
  onCreateAt: (start: Date) => void;
}

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

export function MonthView({
  month,
  today,
  weekStart,
  occurrences,
  tagMap,
  onOpenEvent,
  onCreateAt,
}: MonthViewProps) {
  const cells = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const gridStart = startOfWeek(first, weekStart);
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  }, [month, weekStart]);

  const headers = useMemo(
    () =>
      Array.from(
        { length: 7 },
        (_, i) => WEEKDAY_LABELS[(weekStart + i) % 7] as string,
      ),
    [weekStart],
  );

  /** 按天归拢。跨天事件在它覆盖的每一天都出现。 */
  const byDay = useMemo(() => {
    const map = new Map<string, OccurrenceView[]>();
    for (const occ of occurrences) {
      const s = parseTime(occ.start).getTime();
      const e = parseTime(occ.end).getTime();
      for (const d of cells) {
        const key = toDateKey(d);
        const dayStart = parseTime(key).getTime();
        if (s < dayStart + 86_400_000 && e > dayStart) {
          const list = map.get(key) ?? [];
          list.push(occ);
          map.set(key, list);
        }
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.event.allDay !== b.event.allDay) return a.event.allDay ? -1 : 1;
        return a.start.localeCompare(b.start);
      });
    }
    return map;
  }, [cells, occurrences]);

  const todayKey = toDateKey(today);
  const monthIndex = month.getMonth();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-7 border-b border-white/10">
        {headers.map((h) => (
          <div
            key={h}
            className="py-1.5 text-center text-[10px] text-slate-500"
          >
            {h}
          </div>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        {cells.map((d) => {
          const key = toDateKey(d);
          const list = byDay.get(key) ?? [];
          const inMonth = d.getMonth() === monthIndex;
          const isToday = key === todayKey;

          return (
            <div
              key={key}
              onClick={() => onCreateAt(new Date(d.getTime() + 9 * 3_600_000))}
              className={[
                "flex min-h-0 flex-col gap-0.5 overflow-hidden border-b border-r border-white/5 p-1",
                inMonth ? "" : "bg-black/20",
                isToday ? "bg-sky-500/[0.06]" : "",
              ].join(" ")}
            >
              <div
                className={[
                  "flex shrink-0 items-center justify-center rounded-full text-[11px] tabular-nums",
                  isToday
                    ? "size-5 bg-sky-600 font-medium text-white"
                    : inMonth
                      ? "size-5 text-slate-300"
                      : "size-5 text-slate-600",
                ].join(" ")}
              >
                {d.getDate()}
              </div>

              {list.slice(0, MAX_CHIPS).map((occ) => {
                const color =
                  occ.event.tags.length > 0
                    ? tagMap.get(occ.event.tags[0]!)?.color
                    : undefined;
                return (
                  <button
                    key={occ.key}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenEvent(occ);
                    }}
                    title={occ.event.title}
                    className={[
                      "flex w-full shrink-0 items-center gap-1 truncate rounded px-1 text-left text-[10px] leading-4",
                      occ.event.done ? "opacity-50 line-through" : "",
                    ].join(" ")}
                    style={{
                      backgroundColor: `${color ?? "#475569"}26`,
                      color: "#e2e8f0",
                    }}
                  >
                    <span
                      className="size-1 shrink-0 rounded-full"
                      style={{ backgroundColor: color ?? "#64748b" }}
                    />
                    {!occ.event.allDay ? (
                      <span className="shrink-0 tabular-nums opacity-70">
                        {fmtTime(occ.start)}
                      </span>
                    ) : null}
                    <span className="truncate">{occ.event.title}</span>
                  </button>
                );
              })}

              {list.length > MAX_CHIPS ? (
                <div className="shrink-0 px-1 text-[10px] text-slate-500">
                  +{list.length - MAX_CHIPS}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
