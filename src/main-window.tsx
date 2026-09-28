/**
 * 主窗口：完整视图。
 *
 * 布局是三栏——左边迷你月历和筛选，中间周/月视图，右边当日详情。
 * 顶部是视图切换、搜索和新建。
 *
 * 这里不直接调后端：数据从 `useArchive` / `useOccurrences` 来，
 * 任何改动都通过 `api.*` 提交，然后等广播回来刷新。
 */

import { StrictMode, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import { api } from "./lib/ipc";
import {
  useArchive,
  useOccurrences,
  useTagMap,
  type OccurrenceView,
} from "./lib/useArchive";
import {
  addDays,
  fmtDateWithWeekday,
  fmtRange,
  fmtTime,
  parseTime,
  startOfDay,
  startOfWeek,
  toDateKey,
} from "./lib/time";
import { MiniMonth } from "./components/MiniMonth";
import { MonthView } from "./components/MonthView";
import { WeekView } from "./components/WeekView";
import { EventEditor } from "./components/EventEditor";
import { PlanEditor } from "./components/PlanEditor";
import { PlansView } from "./components/PlansView";
import { SettingsDialog } from "./components/SettingsDialog";
import type { CalendarEvent, Plan } from "./types";

type ViewMode = "week" | "month" | "plans";

/** 打开编辑器时的上下文：编辑既有事件，或在某个时间点新建。 */
interface Editing {
  event: CalendarEvent | null;
  start: Date;
}

function MainWindow() {
  const { archive, error } = useArchive();
  const tagMap = useTagMap(archive);

  const [mode, setMode] = useState<ViewMode>("week");
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [editing, setEditing] = useState<Editing | null>(null);
  const [planEditing, setPlanEditing] = useState<{ plan: Plan | null } | null>(
    null,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  const weekStart = archive?.settings.weekStart ?? 1;

  /** 当前视图覆盖的日期范围。展开查询按它来取。 */
  const { rangeStart, rangeEnd, days } = useMemo(() => {
    if (mode === "week") {
      const start = startOfWeek(cursor, weekStart);
      const ds = Array.from({ length: 7 }, (_, i) => addDays(start, i));
      return {
        rangeStart: toDateKey(start),
        rangeEnd: toDateKey(addDays(start, 6)),
        days: ds,
      };
    }
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = startOfWeek(first, weekStart);
    return {
      rangeStart: toDateKey(start),
      rangeEnd: toDateKey(addDays(start, 41)),
      days: Array.from({ length: 42 }, (_, i) => addDays(start, i)),
    };
  }, [cursor, mode, weekStart]);

  const all = useOccurrences(archive, rangeStart, rangeEnd);

  /** 搜索与标签筛选。两个条件都得满足。 */
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((occ) => {
      if (tagFilter.size > 0 && !occ.event.tags.some((t) => tagFilter.has(t))) {
        return false;
      }
      if (q !== "") {
        const hay = `${occ.event.title} ${occ.event.notes}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [all, search, tagFilter]);

  /** 迷你月历上的小圆点：用未筛选的数据，否则筛选一开就全空了。 */
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const occ of all) {
      const s = parseTime(occ.start).getTime();
      const e = parseTime(occ.end).getTime();
      const startKey = toDateKey(parseTime(occ.start));
      let d = parseTime(startKey);
      // 跨天事件要在覆盖到的每一天都计数
      while (d.getTime() < e) {
        const key = toDateKey(d);
        map.set(key, (map.get(key) ?? 0) + 1);
        d = addDays(d, 1);
        if (d.getTime() > s + 31 * 86_400_000) break; // 防御：异常数据不至于死循环
      }
    }
    return map;
  }, [all]);

  const selectedDayOccurrences = useMemo(
    () =>
      visible.filter((occ) => {
        const s = parseTime(occ.start).getTime();
        const e = parseTime(occ.end).getTime();
        const dayStart = cursor.getTime();
        return s < dayStart + 86_400_000 && e > dayStart;
      }),
    [visible, cursor],
  );

  const openNew = useCallback((start: Date) => {
    setEditing({ event: null, start });
  }, []);

  const openEvent = useCallback((event: CalendarEvent) => {
    setEditing({ event, start: parseTime(event.start) });
  }, []);

  const goToday = () => setCursor(startOfDay(new Date()));

  const shift = (delta: number) => {
    if (mode === "week") {
      setCursor((c) => addDays(c, delta * 7));
    } else {
      setCursor((c) => new Date(c.getFullYear(), c.getMonth() + delta, 1));
    }
  };

  const toggleTagFilter = (id: string) =>
    setTagFilter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rangeLabel = useMemo(() => {
    if (mode === "week") {
      const start = startOfWeek(cursor, weekStart);
      const end = addDays(start, 6);
      return `${start.getMonth() + 1}月${start.getDate()}日 – ${end.getMonth() + 1}月${end.getDate()}日`;
    }
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "long",
      timeZone: "Asia/Shanghai",
    }).format(cursor);
  }, [cursor, mode, weekStart]);

  const todos = useMemo(
    () => visible.filter((o) => !o.event.done && parseTime(o.end) >= new Date()),
    [visible],
  );

  return (
    <div className="flex h-screen w-screen flex-col bg-slate-950 text-slate-100">
      {/* 顶部栏 */}
      <header className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2">
        {/* 计划页没有「上/下一周」可言，那一格留给标题。 */}
        {mode !== "plans" ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={mode === "week" ? "上一周" : "上个月"}
              onClick={() => shift(-1)}
              className="rounded px-2 py-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-100"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={goToday}
              className="rounded px-2 py-1 text-[12px] text-slate-300 transition-colors hover:bg-white/10"
            >
              今天
            </button>
            <button
              type="button"
              aria-label={mode === "week" ? "下一周" : "下个月"}
              onClick={() => shift(1)}
              className="rounded px-2 py-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-100"
            >
              ›
            </button>
          </div>
        ) : null}

        <h1
          className={[
            "text-[13px] font-medium text-slate-200",
            mode === "plans" ? "" : "tabular-nums",
          ].join(" ")}
        >
          {mode === "plans" ? "长期计划" : rangeLabel}
        </h1>

        <div className="flex-1" />

        {/* 搜索是在当前可见的日程里过滤，对计划页没有作用——
            与其放一个点了没反应的框，不如收起来。 */}
        {mode !== "plans" ? (
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索…"
            className="w-40 rounded-lg border border-white/10 bg-slate-900 px-2 py-1 text-[12px] outline-none transition-colors focus:border-sky-500"
          />
        ) : null}

        <div className="flex rounded-lg bg-white/5 p-0.5">
          {(["week", "month", "plans"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={[
                "rounded px-2.5 py-1 text-[12px] transition-colors",
                mode === m
                  ? "bg-sky-600 text-white"
                  : "text-slate-400 hover:text-slate-100",
              ].join(" ")}
            >
              {m === "week" ? "周" : m === "month" ? "月" : "计划"}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => {
            if (mode === "plans") setPlanEditing({ plan: null });
            else openNew(new Date(cursor.getTime() + 9 * 3_600_000));
          }}
          className="rounded-lg bg-sky-600 px-3 py-1 text-[12px] font-medium text-white transition-colors hover:bg-sky-500"
        >
          {mode === "plans" ? "+ 新建计划" : "+ 新建"}
        </button>

        <button
          type="button"
          aria-label="设置"
          title="设置"
          onClick={() => setSettingsOpen(true)}
          className="rounded-lg px-2 py-1 text-[14px] leading-none text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-100"
        >
          ⚙
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左栏。计划页整页留给自己，不留这两条侧栏——
            迷你月历和「当日详情」讲的都是日程，摆在计划旁边只会误导。 */}
        {mode !== "plans" ? (
        <aside className="flex w-[196px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-white/10 p-3">
          <MiniMonth
            month={cursor}
            selected={cursor}
            today={new Date()}
            weekStart={weekStart}
            counts={counts}
            onSelect={setCursor}
            onMonthChange={setCursor}
          />

          {archive && archive.tags.length > 0 ? (
            <div>
              <div className="mb-1.5 text-[10px] text-slate-500">标签</div>
              <ul className="space-y-0.5">
                {archive.tags.map((t) => {
                  const on = tagFilter.has(t.id);
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => toggleTagFilter(t.id)}
                        className={[
                          "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] transition-colors",
                          on ? "bg-white/10 text-slate-100" : "text-slate-400 hover:bg-white/5",
                        ].join(" ")}
                      >
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{
                            backgroundColor: t.color,
                            // 未选中时压暗，一眼看出哪些在筛
                            opacity: on ? 1 : 0.45,
                          }}
                        />
                        <span className="truncate">{t.name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {tagFilter.size > 0 ? (
                <button
                  type="button"
                  onClick={() => setTagFilter(new Set())}
                  className="mt-1 text-[10px] text-sky-400 hover:text-sky-300"
                >
                  清除筛选
                </button>
              ) : null}
            </div>
          ) : null}
        </aside>
        ) : null}

        {/* 中栏 */}
        <main className="flex min-w-0 flex-1 flex-col">
          {error ? (
            <div className="m-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-[12px] text-rose-300">
              {error}
            </div>
          ) : mode === "plans" ? (
            <PlansView
              plans={archive?.plans ?? []}
              today={startOfDay(new Date())}
              onOpen={(plan) => setPlanEditing({ plan })}
              onNew={() => setPlanEditing({ plan: null })}
            />
          ) : mode === "week" ? (
            <WeekView
              days={days}
              occurrences={visible}
              tagMap={tagMap}
              today={startOfDay(new Date())}
              onOpenEvent={openEvent}
              onCreateAt={openNew}
            />
          ) : (
            <MonthView
              month={cursor}
              today={startOfDay(new Date())}
              weekStart={weekStart}
              occurrences={visible}
              tagMap={tagMap}
              onOpenEvent={(occ) => openEvent(occ.event)}
              onCreateAt={openNew}
            />
          )}
        </main>

        {/* 右栏：当日详情 */}
        {mode !== "plans" ? (
        <aside className="flex w-[220px] shrink-0 flex-col border-l border-white/10">
          <div className="shrink-0 border-b border-white/10 px-3 py-2">
            <div className="text-[12px] font-medium text-slate-200">
              {fmtDateWithWeekday(cursor)}
            </div>
            <div className="text-[10px] text-slate-500">
              {selectedDayOccurrences.length === 0
                ? "没有安排"
                : `${selectedDayOccurrences.length} 件事`}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {selectedDayOccurrences.length === 0 ? (
              <p className="px-1 py-3 text-[11px] text-slate-600">
                空着。点中间的时间轴或上面的「+ 新建」加一件事。
              </p>
            ) : (
              <ul className="space-y-1">
                {selectedDayOccurrences.map((occ) => (
                  <DayDetailRow
                    key={occ.key}
                    occ={occ}
                    color={
                      occ.event.tags.length > 0
                        ? tagMap.get(occ.event.tags[0]!)?.color
                        : undefined
                    }
                    onOpen={() => openEvent(occ.event)}
                  />
                ))}
              </ul>
            )}
          </div>

          {/* 待办：今天之后还没完成的 */}
          <div className="max-h-[38%] shrink-0 overflow-y-auto border-t border-white/10 p-2">
            <div className="mb-1 px-1 text-[10px] text-slate-500">
              待办（{todos.length}）
            </div>
            {todos.length === 0 ? (
              <p className="px-1 text-[11px] text-slate-600">都清完了</p>
            ) : (
              <ul className="space-y-0.5">
                {todos.slice(0, 20).map((occ) => (
                  <li key={occ.key}>
                    <button
                      type="button"
                      onClick={() => void api.toggleEventDone(occ.event.id)}
                      className="flex w-full items-baseline gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-slate-300 transition-colors hover:bg-white/5"
                    >
                      <span className="size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-slate-500" />
                      <span className="truncate">{occ.event.title}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-slate-600 tabular-nums">
                        {fmtTime(occ.start)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
        ) : null}
      </div>

      {settingsOpen && archive ? (
        <SettingsDialog
          settings={archive.settings}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {planEditing ? (
        <PlanEditor
          plan={planEditing.plan}
          onClose={() => setPlanEditing(null)}
          onSaved={() => {
            /* 后端会广播 archive-changed，计划页自动刷新 */
          }}
        />
      ) : null}

      {editing ? (
        <EventEditor
          event={editing.event}
          defaultStart={editing.start}
          tags={archive?.tags ?? []}
          defaultReminder={archive?.settings.defaultReminder ?? 10}
          onClose={() => setEditing(null)}
          onSaved={() => {
            /* 后端会广播 archive-changed，各窗口自动刷新，这里不用做事 */
          }}
        />
      ) : null}
    </div>
  );
}

function DayDetailRow({
  occ,
  color,
  onOpen,
}: {
  occ: OccurrenceView;
  color: string | undefined;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="w-full rounded-lg border-l-[3px] px-2 py-1.5 text-left transition-colors hover:bg-white/5"
        style={{
          borderColor: color ?? "#64748b",
          backgroundColor: `${color ?? "#475569"}14`,
        }}
      >
        <div
          className={[
            "truncate text-[12px]",
            occ.event.done ? "text-slate-500 line-through" : "text-slate-100",
          ].join(" ")}
        >
          {occ.event.title}
        </div>
        <div className="text-[10px] text-slate-400 tabular-nums">
          {fmtRange(occ.start, occ.end, occ.event.allDay)}
          {occ.event.repeatRule ? (
            <span className="ml-1 text-slate-500">· 重复</span>
          ) : null}
          {occ.event.priority === "high" ? (
            <span className="ml-1 text-rose-400">· 高</span>
          ) : null}
        </div>
      </button>
    </li>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MainWindow />
  </StrictMode>,
);
