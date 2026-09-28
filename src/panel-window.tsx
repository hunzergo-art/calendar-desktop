/**
 * 小面板：鼠标移到悬浮块上时从它旁边弹出的一小块。
 *
 * 定位是「扫一眼接下来要做什么，顺手勾掉一件事」，分三段：
 * 今日任务、明日任务、长期计划。新建/编辑的完整表单不在这里——
 * 那是主窗口的职责，这里只放一个入口。
 *
 * ## 为什么会自己收起
 *
 * 面板**不再抢焦点**（`window.rs` 里 `focused(false)`），所以「失焦收起」
 * 那套在这里不成立：一个从没获得过焦点的窗口不会有失焦事件。改成把鼠标的
 * 进入/离开报给后端，由 `window::set_panel_hover` 统一裁决——鼠标跨过
 * 悬浮块和面板之间那条空隙时，也只有在那一个地方才看得全两边。
 *
 * 窗口无边框透明，圆角、阴影、背景都由这里画。
 */

import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import { api } from "./lib/ipc";
import {
  isOngoing,
  nextUpcoming,
  useArchive,
  useOccurrences,
  useTagMap,
  useToday,
  type OccurrenceView,
} from "./lib/useArchive";
import {
  addDays,
  fmtDateWithWeekday,
  fmtMonthDay,
  fmtTime,
  parseTime,
  startOfDay,
  toDateKey,
} from "./lib/time";
import type { Plan } from "./types";

function EventRow({
  occ,
  color,
  now,
}: {
  occ: OccurrenceView;
  color: string | undefined;
  now: Date;
}) {
  const { event } = occ;
  const ongoing = isOngoing(occ, now);
  const past = parseTime(occ.end) <= now;

  const toggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      void api.toggleEventDone(event.id);
    },
    [event.id],
  );

  return (
    <li
      className={[
        "flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors",
        ongoing ? "bg-sky-500/15" : "hover:bg-white/5",
        past && !event.done ? "opacity-55" : "",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={toggle}
        aria-label={event.done ? "标记为未完成" : "标记为已完成"}
        className={[
          "mt-0.5 size-4 shrink-0 rounded border transition-colors",
          event.done
            ? "border-emerald-400 bg-emerald-400/90 text-slate-900"
            : "border-slate-500 hover:border-slate-300",
        ].join(" ")}
      >
        {event.done ? (
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

      <span
        className="mt-1.5 size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color ?? "#64748b" }}
      />

      <div className="min-w-0 flex-1">
        <div
          className={[
            "truncate text-[13px] leading-5",
            event.done ? "text-slate-500 line-through" : "text-slate-100",
          ].join(" ")}
        >
          {event.title}
        </div>
        <div className="text-[11px] leading-4 text-slate-400 tabular-nums">
          {event.allDay ? "全天" : `${fmtTime(occ.start)} - ${fmtTime(occ.end)}`}
          {ongoing ? <span className="ml-1.5 text-sky-400">进行中</span> : null}
          {/* 重复事件在面板里标一下，免得以为只此一次 */}
          {event.repeatRule ? (
            <span className="ml-1.5 text-slate-500">重复</span>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/**
 * 面板里的一条计划。
 *
 * 只显示标题和日期，不给勾选框——面板的空间和注意力都该留给「今天要做什么」，
 * 而计划是长期的东西，顺手在弹出的小块里把它勾掉更像误触。
 * 要动它请去主窗口的计划页。
 */
function PlanRow({ plan, today }: { plan: Plan; today: Date }) {
  const overdue =
    plan.targetDate !== null &&
    Math.round(
      (parseTime(plan.targetDate).getTime() - startOfDay(today).getTime()) /
        86_400_000,
    ) < 0;

  return (
    <li className="flex items-start gap-2 rounded-lg px-2 py-1.5">
      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-violet-400" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] leading-5 text-slate-100">
          {plan.title}
        </div>
        <div className="text-[11px] leading-4 text-slate-400">
          {plan.reminderDate ? (
            <span>提醒 {fmtMonthDay(plan.reminderDate)}</span>
          ) : null}
          {plan.reminderDate && plan.targetDate ? (
            <span className="text-slate-600"> · </span>
          ) : null}
          {plan.targetDate ? (
            <span className={overdue ? "text-rose-400" : undefined}>
              目标 {fmtMonthDay(plan.targetDate)}
              {overdue ? "（已逾期）" : ""}
            </span>
          ) : null}
          {!plan.reminderDate && !plan.targetDate ? (
            <span className="text-slate-600">没有日期</span>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-2">
      <div className="px-2 py-1 text-[10px] tracking-wide text-slate-500">
        {title}
        {count > 0 ? <span className="ml-1 text-slate-600">{count}</span> : null}
      </div>
      {count === 0 ? (
        <p className="px-2 pb-1 text-[11px] text-slate-600">{empty}</p>
      ) : (
        <ul className="space-y-0.5">{children}</ul>
      )}
    </section>
  );
}

function Panel() {
  const { archive, error } = useArchive();
  const today = useToday(archive);
  const tagMap = useTagMap(archive);

  // 面板是常驻窗口（只是藏起来），一次加载要活很久。不自己走时的话，
  // 「进行中」「已过」会一直停在打开那一刻，跨过午夜后「明日任务」
  // 显示的也还是昨天算出来的那天。
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  // 明天一整天的安排。`useOccurrences` 的区间是含两端的日期，
  // 同一天当起止就是「这一天」。
  const tomorrowKey = toDateKey(addDays(startOfDay(now), 1));
  const tomorrow = useOccurrences(archive, tomorrowKey, tomorrowKey);

  // Esc 收起。面板通常没有焦点，这条多半不触发；但点过上面的按钮之后
  // 焦点会落进来，那时它就是个顺手的退路。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void api.hidePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pending = today.filter((o) => !o.event.done);
  const doneCount = today.length - pending.length;
  const upcoming = nextUpcoming(pending, now);

  const tomorrowPending = tomorrow.filter((o) => !o.event.done);

  const plans = useMemo(
    () =>
      (archive?.plans ?? [])
        .filter((p) => !p.deleted && !p.done)
        .sort((a, b) => {
          const ka = a.reminderDate ?? a.targetDate ?? "";
          const kb = b.reminderDate ?? b.targetDate ?? "";
          // 有日期的排在前面，各自按日期先后。
          if (ka === kb) return a.title.localeCompare(b.title, "zh-CN");
          if (ka === "") return 1;
          if (kb === "") return -1;
          return ka.localeCompare(kb);
        }),
    [archive],
  );

  /** 取事件第一个标签的颜色，没有就用中性色。 */
  const colorOf = (occ: OccurrenceView) =>
    occ.event.tags.length > 0 ? tagMap.get(occ.event.tags[0]!)?.color : undefined;

  /** 打开主窗口。面板此时还挂在屏幕上，显式收掉——鼠标没动，
   *  不会有 pointerleave 来触发那次收起。 */
  const openMain = () => {
    void api.showMain();
    void api.hidePanel();
  };

  return (
    <div
      // 悬停进出如实上报，由后端统一裁决去留——面板看不见悬浮块那边的鼠标。
      //
      // 注意这里是真实的指针事件，不是挂载时上报一次：面板窗口在启动时就
      // 建好并加载好前端了（只是藏着），挂载那一刻鼠标根本不在上面。
      // 那时报一个 `true` 会变成一个再也撤销不掉的「鼠标一直在面板上」，
      // 之后每次悬停都收不起来。
      onPointerEnter={() => void api.panelHoverPanel(true)}
      onPointerLeave={() => void api.panelHoverPanel(false)}
      className="flex h-screen w-screen flex-col overflow-hidden rounded-xl border border-white/10 bg-slate-900/95 text-slate-100 shadow-2xl backdrop-blur-md"
    >
      <header className="flex items-baseline justify-between px-3 pt-3 pb-2">
        <div>
          <div className="text-[13px] font-medium">
            {fmtDateWithWeekday(now)}
          </div>
          <div className="text-[11px] text-slate-400">
            {today.length === 0
              ? "今天没有安排"
              : `${today.length} 件事${doneCount > 0 ? ` · 已完成 ${doneCount}` : ""}`}
          </div>
        </div>
        {upcoming ? (
          <div className="text-right text-[11px] text-slate-400 tabular-nums">
            <div className="text-slate-500">接下来</div>
            <div className="text-slate-300">{fmtTime(upcoming.start)}</div>
          </div>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1">
        {error ? (
          <p className="px-2 py-4 text-[12px] text-rose-400">{error}</p>
        ) : (
          <>
            <Section
              title="今日任务"
              count={today.length}
              empty="今天空着，点下面的「新建」加一件事"
            >
              {today.map((occ) => (
                <EventRow
                  key={occ.key}
                  occ={occ}
                  color={colorOf(occ)}
                  now={now}
                />
              ))}
            </Section>

            <Section
              title="明日任务"
              count={tomorrowPending.length}
              empty="明天没有安排"
            >
              {tomorrowPending.map((occ) => (
                <EventRow
                  key={occ.key}
                  occ={occ}
                  color={colorOf(occ)}
                  now={now}
                />
              ))}
            </Section>

            <Section
              title="长期计划"
              count={plans.length}
              empty="还没有进行中的计划"
            >
              {plans.map((plan) => (
                <PlanRow key={plan.id} plan={plan} today={now} />
              ))}
            </Section>
          </>
        )}
      </div>

      <footer className="flex gap-1.5 border-t border-white/10 p-2">
        <button
          type="button"
          onClick={openMain}
          className="flex-1 rounded-lg bg-sky-600 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-sky-500"
        >
          + 新建
        </button>
        <button
          type="button"
          onClick={openMain}
          className="rounded-lg bg-white/5 px-3 py-1.5 text-[12px] text-slate-200 transition-colors hover:bg-white/10"
        >
          打开主窗
        </button>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Panel />
  </StrictMode>,
);
