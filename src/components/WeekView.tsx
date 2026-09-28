/**
 * 周视图：7 列时间轴，事件块可拖拽改时间。
 *
 * 重叠的事件会并排分列显示，不然一个 10:00 的会和另一个 10:00 的完全盖住。
 *
 * 拖拽只对**单次事件**生效。重复事件拖一次要回答「只改这一次还是整个系列」，
 * 那是个需要 UI 的决策，等编辑弹窗做好了再一起处理——现在拖动重复事件会提示。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CalendarEvent, Tag } from "../types";
import type { OccurrenceView } from "../lib/useArchive";
import { api } from "../lib/ipc";
import {
  addDays,
  fmtTime,
  minutesIntoDay,
  parseTime,
  toDateKey,
  toLocalIso,
} from "../lib/time";

/** 每小时的高度（像素）。48 是能放下 15 分钟刻度又不至于太高。 */
const HOUR_HEIGHT = 48;
/** 拖拽吸附粒度（分钟）。 */
const SNAP_MINUTES = 15;
/** 多久算「马上开始」，给个高亮。 */
const SOON_MINUTES = 15;

interface WeekViewProps {
  days: Date[];
  occurrences: OccurrenceView[];
  tagMap: Map<string, Tag>;
  today: Date;
  onOpenEvent: (e: CalendarEvent) => void;
  onCreateAt: (start: Date) => void;
}

/** 一天之内的事件排布：算好每个块占第几列、共几列。 */
interface Laid {
  occ: OccurrenceView;
  col: number;
  cols: number;
}

/**
 * 把重叠的事件分到不同列。
 *
 * 做法是经典的「扫描线」：按开始时间排序后依次放入，
 * 只和「尚未结束」的那组比较。同一组内共用一个列数，
 * 这样一组里的块宽度一致，看起来才齐。
 */
function layoutDay(list: OccurrenceView[]): Laid[] {
  const sorted = [...list].sort(
    (a, b) => parseTime(a.start).getTime() - parseTime(b.start).getTime(),
  );

  const out: Laid[] = [];
  let group: OccurrenceView[] = [];
  let groupEnd = -Infinity;

  const flush = () => {
    if (group.length === 0) return;

    const columns: number[] = []; // 每列当前的结束时间
    const placed: { occ: OccurrenceView; col: number }[] = [];

    for (const occ of group) {
      const start = parseTime(occ.start).getTime();
      const end = parseTime(occ.end).getTime();

      // 找一个已经空出来的列
      let col = columns.findIndex((c) => c <= start);
      if (col === -1) {
        col = columns.length;
        columns.push(end);
      } else {
        columns[col] = end;
      }
      placed.push({ occ, col });
    }

    const cols = columns.length;
    for (const p of placed) out.push({ ...p, cols });
  };

  for (const occ of sorted) {
    const start = parseTime(occ.start).getTime();
    if (start >= groupEnd && group.length > 0) {
      flush();
      group = [];
      groupEnd = -Infinity;
    }
    group.push(occ);
    groupEnd = Math.max(groupEnd, parseTime(occ.end).getTime());
  }
  flush();

  return out;
}

interface DragState {
  occ: OccurrenceView;
  originX: number;
  originY: number;
  /** 已经吸附过的位移，用于实时预览 */
  minutesDelta: number;
  daysDelta: number;
  moved: boolean;
}

export function WeekView({
  days,
  occurrences,
  tagMap,
  today,
  onOpenEvent,
  onCreateAt,
}: WeekViewProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [now, setNow] = useState(() => new Date());

  // 「当前时刻」那条红线，每分钟挪一次
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const todayKey = toDateKey(today);

  /** 按天分组，并按天算出列布局。 */
  const byDay = useMemo(() => {
    const map = new Map<string, Laid[]>();
    for (const d of days) map.set(toDateKey(d), []);

    const grouped = new Map<string, OccurrenceView[]>();
    for (const occ of occurrences) {
      // 跨天事件在它覆盖的每一天都要出现。
      for (const d of days) {
        const key = toDateKey(d);
        const dayStart = parseTime(key).getTime();
        const dayEnd = dayStart + 86_400_000;
        const s = parseTime(occ.start).getTime();
        const e = parseTime(occ.end).getTime();
        if (s < dayEnd && e > dayStart) {
          const list = grouped.get(key) ?? [];
          list.push(occ);
          grouped.set(key, list);
        }
      }
    }

    for (const [key, list] of grouped) {
      map.set(key, layoutDay(list));
    }
    return map;
  }, [days, occurrences]);

  const allDayByDay = useMemo(() => {
    const map = new Map<string, OccurrenceView[]>();
    for (const d of days) map.set(toDateKey(d), []);
    for (const occ of occurrences) {
      if (!occ.event.allDay) continue;
      for (const d of days) {
        const key = toDateKey(d);
        if (toDateKey(parseTime(occ.start)) === key) {
          map.get(key)?.push(occ);
        }
      }
    }
    return map;
  }, [days, occurrences]);

  const hasAllDay = [...allDayByDay.values()].some((v) => v.length > 0);

  // ------------------------------------------------------------ 拖拽

  const onBlockPointerDown = useCallback(
    (e: React.PointerEvent, occ: OccurrenceView) => {
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setDrag({
        occ,
        originX: e.clientX,
        originY: e.clientY,
        minutesDelta: 0,
        daysDelta: 0,
        moved: false,
      });
    },
    [],
  );

  const onBlockPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag) return;

      const dx = e.clientX - drag.originX;
      const dy = e.clientY - drag.originY;

      // 每列宽度从网格实时量，避免依赖固定宽度（列宽随窗口变化）。
      const gridWidth = gridRef.current?.clientWidth ?? 0;
      const colWidth = gridWidth / days.length;

      const rawMinutes = (dy / HOUR_HEIGHT) * 60;
      const minutesDelta =
        Math.round(rawMinutes / SNAP_MINUTES) * SNAP_MINUTES;
      const daysDelta =
        colWidth > 0 ? Math.round(dx / colWidth) : 0;

      // 至少挪动一格才算拖，否则只是抖动
      const moved = Math.abs(dx) > 3 || Math.abs(dy) > 3;
      setDrag({ ...drag, minutesDelta, daysDelta, moved });
    },
    [drag, days.length],
  );

  const onBlockPointerUp = useCallback(
    async (e: React.PointerEvent) => {
      if (!drag) return;
      const { occ, minutesDelta, daysDelta, moved } = drag;
      setDrag(null);

      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);

      if (!moved || (minutesDelta === 0 && daysDelta === 0)) {
        onOpenEvent(occ.event);
        return;
      }

      if (occ.event.repeatRule) {
        // 重复事件的一次发生不能直接落成新时间——需要先问清楚。
        // 在这里静默改掉会连带影响整个系列，是更糟的结果。
        window.alert(
          "这是重复日程。拖动只改单次还是整个系列，等编辑弹窗做好了再支持。",
        );
        return;
      }

      const start = parseTime(occ.start);
      const end = parseTime(occ.end);
      const durationMs = end.getTime() - start.getTime();
      const newStart = new Date(
        start.getTime() + minutesDelta * 60_000 + daysDelta * 86_400_000,
      );

      // 拖动只改时间，其余字段原样带回去。
      await api.updateEvent(occ.event.id, {
        title: occ.event.title,
        start: toLocalIso(newStart),
        end: toLocalIso(new Date(newStart.getTime() + durationMs)),
        allDay: occ.event.allDay,
        tags: occ.event.tags,
        priority: occ.event.priority,
        notes: occ.event.notes,
        subtasks: occ.event.subtasks,
        reminders: occ.event.reminders,
        repeatRule: occ.event.repeatRule,
      });
    },
    [drag, onOpenEvent],
  );

  /** 点空白处：以落点所在的时间新建。 */
  const onGridClick = useCallback(
    (e: React.MouseEvent, day: Date) => {
      // 只有点在网格本身（而不是事件块上）才触发
      if (e.target !== e.currentTarget) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const minutes = ((e.clientY - rect.top) / HOUR_HEIGHT) * 60;
      const snapped = Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;
      void onCreateAt(new Date(day.getTime() + snapped * 60_000));
    },
    [onCreateAt],
  );

  const hours = useMemo(() => Array.from({ length: 24 }, (_, i) => i), []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 日期表头 */}
      <div className="flex border-b border-white/10 pr-3">
        <div className="w-11 shrink-0" />
        {days.map((d) => {
          const key = toDateKey(d);
          const isToday = key === todayKey;
          return (
            <div
              key={key}
              className="flex-1 py-1.5 text-center"
            >
              <div className="text-[10px] text-slate-500">
                {new Intl.DateTimeFormat("zh-CN", {
                  weekday: "short",
                  timeZone: "Asia/Shanghai",
                }).format(d)}
              </div>
              <div
                className={[
                  "mx-auto mt-0.5 flex size-6 items-center justify-center rounded-full text-[12px] tabular-nums",
                  isToday
                    ? "bg-sky-600 font-medium text-white"
                    : "text-slate-300",
                ].join(" ")}
              >
                {d.getDate()}
              </div>
            </div>
          );
        })}
      </div>

      {/* 全天事件条。没有全天事件时整条不出现，省一行高度。 */}
      {hasAllDay ? (
        <div className="flex border-b border-white/10 pr-3">
          <div className="w-11 shrink-0 py-1 pr-1 text-right text-[10px] text-slate-500">
            全天
          </div>
          {days.map((d) => {
            const key = toDateKey(d);
            const list = allDayByDay.get(key) ?? [];
            return (
              <div key={key} className="flex-1 space-y-0.5 border-l border-white/5 p-0.5">
                {list.map((occ) => {
                  const color =
                    occ.event.tags.length > 0
                      ? tagMap.get(occ.event.tags[0]!)?.color
                      : undefined;
                  return (
                    <button
                      key={occ.key}
                      type="button"
                      onClick={() => onOpenEvent(occ.event)}
                      className="block w-full truncate rounded px-1 py-0.5 text-left text-[11px] text-white"
                      style={{ backgroundColor: color ?? "#475569" }}
                    >
                      {occ.event.title}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : null}

      {/* 时间轴 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex" ref={gridRef}>
          {/* 左侧小时刻度 */}
          <div className="w-11 shrink-0">
            {hours.map((h) => (
              <div
                key={h}
                className="relative text-right text-[10px] text-slate-500"
                style={{ height: HOUR_HEIGHT }}
              >
                {/* 整点标在线的上方一点，视觉上更贴合刻度线 */}
                {h > 0 ? (
                  <span className="absolute -top-1.5 right-1.5 tabular-nums">
                    {String(h).padStart(2, "0")}:00
                  </span>
                ) : null}
              </div>
            ))}
          </div>

          {/* 7 列 */}
          {days.map((d) => {
            const key = toDateKey(d);
            const laid = byDay.get(key) ?? [];
            const isToday = key === todayKey;
            const nowMinutes = minutesIntoDay(now);

            return (
              <div
                key={key}
                onClick={(e) => onGridClick(e, d)}
                className={[
                  "relative flex-1 border-l border-white/5",
                  isToday ? "bg-sky-500/[0.04]" : "",
                ].join(" ")}
                style={{ height: HOUR_HEIGHT * 24 }}
              >
                {/* 小时横线 */}
                {hours.map((h) =>
                  h === 0 ? null : (
                    <div
                      key={h}
                      className="absolute inset-x-0 border-t border-white/5"
                      style={{ top: h * HOUR_HEIGHT }}
                    />
                  ),
                )}

                {/* 当前时刻红线 */}
                {isToday ? (
                  <div
                    className="pointer-events-none absolute inset-x-0 z-20 flex items-center"
                    style={{ top: (nowMinutes / 60) * HOUR_HEIGHT }}
                  >
                    <span className="size-1.5 -translate-x-0.5 rounded-full bg-rose-500" />
                    <span className="h-px flex-1 bg-rose-500/70" />
                  </div>
                ) : null}

                {/* 事件块 */}
                {laid.map(({ occ, col, cols }) => {
                  const isDragging = drag?.occ.key === occ.key;

                  const baseStart = parseTime(occ.start);
                  const baseEnd = parseTime(occ.end);

                  // 拖拽中：这一列跟着位移预览
                  const previewStart = isDragging
                    ? new Date(
                        baseStart.getTime() +
                          (drag?.minutesDelta ?? 0) * 60_000 +
                          (drag?.daysDelta ?? 0) * 86_400_000,
                      )
                    : baseStart;

                  // 跨天事件在每一天只画属于这一天的那一段
                  const dayStart = parseTime(key);
                  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
                  const visStart = Math.max(previewStart.getTime(), dayStart.getTime());

                  const shiftMs = previewStart.getTime() - baseStart.getTime();
                  const visEnd = Math.min(
                    baseEnd.getTime() + shiftMs,
                    dayEnd.getTime(),
                  );

                  const top = ((visStart - dayStart.getTime()) / 3_600_000) * HOUR_HEIGHT;
                  const height = Math.max(
                    ((visEnd - visStart) / 3_600_000) * HOUR_HEIGHT,
                    18, // 15 分钟的事件也要点得到
                  );

                  const color =
                    occ.event.tags.length > 0
                      ? tagMap.get(occ.event.tags[0]!)?.color
                      : undefined;

                  const soon =
                    !occ.event.done &&
                    parseTime(occ.start).getTime() - now.getTime() <
                      SOON_MINUTES * 60_000 &&
                    parseTime(occ.end) > now;

                  const widthPct = 100 / cols;
                  const startHHMM = new Date(
                    baseStart.getTime() + shiftMs,
                  );

                  return (
                    <button
                      key={occ.key}
                      type="button"
                      onPointerDown={(e) => onBlockPointerDown(e, occ)}
                      onPointerMove={onBlockPointerMove}
                      onPointerUp={onBlockPointerUp}
                      title={`${occ.event.title} ${fmtTime(occ.start)}-${fmtTime(occ.end)}`}
                      className={[
                        "absolute z-10 overflow-hidden rounded px-1.5 py-0.5 text-left",
                        "border-l-[3px] transition-shadow",
                        isDragging
                          ? "z-30 opacity-90 shadow-lg ring-2 ring-sky-400"
                          : "hover:shadow-md",
                        occ.event.done ? "opacity-50" : "",
                      ].join(" ")}
                      style={{
                        top,
                        height,
                        left: `calc(${col * widthPct}% + 1px)`,
                        width: `calc(${widthPct}% - 3px)`,
                        backgroundColor: `${color ?? "#475569"}33`,
                        borderColor: color ?? "#64748b",
                        touchAction: "none",
                      }}
                    >
                      <div
                        className={[
                          "truncate text-[11px] leading-4 font-medium text-slate-100",
                          occ.event.done ? "line-through" : "",
                        ].join(" ")}
                      >
                        {occ.event.title}
                      </div>
                      {height > 28 ? (
                        <div className="truncate text-[10px] leading-3 text-slate-300/80 tabular-nums">
                          {fmtTime(startHHMM)}
                          {soon ? (
                            <span className="ml-1 text-rose-400">即将</span>
                          ) : null}
                        </div>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export { addDays };
