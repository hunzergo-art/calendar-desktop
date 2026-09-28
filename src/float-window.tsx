/**
 * 悬浮块：右下角常驻的小梯形。
 *
 * 它只干三件事——告诉你今天有多少事、有没有事马上要开始、
 * 以及**鼠标移上去展开面板**（今日任务 / 明日任务 / 长期计划）。
 * 详细信息一概不放这儿，那是面板和主窗口的事。
 *
 * 窗口本身是 `decorations: false` + `transparent: true`，
 * 外形完全由这里的 CSS 决定（clip-path 切出梯形）。
 *
 * ## 悬停为什么要报给后端
 *
 * 悬浮块和面板是两个**独立的窗口**（各自的 webview 实例），互相看不见
 * 对方的鼠标。鼠标从这块挪到面板上时，必然先离开这里、再进入那边，
 * 中间还隔着几个像素的空隙。要在这条缝上不闪断，就得有个能看到两边的
 * 地方来裁决——那是 `window::set_panel_hover`，这里只负责如实上报。
 *
 * 于是「原地点击」改去打开主窗口：面板已经由悬停负责了，
 * 点击再切换它只会和悬停互相打架。
 */

import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import { api } from "./lib/ipc";
import { isOngoing, nextUpcoming, useArchive, useToday } from "./lib/useArchive";
import { fmtTime, parseTime } from "./lib/time";

/** 拖动判定阈值：移动超过这么多像素才算拖，否则算点击。 */
const DRAG_THRESHOLD_PX = 4;
/** 距离开始多久以内算「马上」，进入提醒状态。 */
const SOON_MINUTES = 15;

function FloatBlock() {
  const { archive } = useArchive();
  const today = useToday(archive);

  const pointer = useRef<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);

  // 每分钟重算一次「现在」，让「即将开始」和「还有几分钟」自动跟上。
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const pending = useMemo(() => today.filter((o) => !o.event.done), [today]);

  const ongoing = useMemo(
    () => pending.find((o) => isOngoing(o, now)) ?? null,
    [pending, now],
  );

  const upcoming = useMemo(() => nextUpcoming(pending, now), [pending, now]);

  /** 下一件事在 15 分钟内开始 → 整块转红并呼吸。 */
  const urgent = useMemo(() => {
    if (ongoing) return true;
    if (!upcoming) return false;
    const mins = (parseTime(upcoming.start).getTime() - now.getTime()) / 60_000;
    return mins <= SOON_MINUTES;
  }, [ongoing, upcoming, now]);

  const dateLabel = useMemo(
    () =>
      new Intl.DateTimeFormat("zh-CN", {
        weekday: "short",
        timeZone: "Asia/Shanghai",
      }).format(now),
    [now],
  );

  const dayNumber = useMemo(
    () =>
      new Intl.DateTimeFormat("zh-CN", {
        day: "numeric",
        timeZone: "Asia/Shanghai",
      }).format(now),
    [now],
  );

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    pointer.current = { x: e.clientX, y: e.clientY };
    dragging.current = false;
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const start = pointer.current;
    if (!start || dragging.current) return;

    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    if (moved > DRAG_THRESHOLD_PX) {
      dragging.current = true;
      // 交给系统去拖窗口——自己算位移在跨 DPI 缩放时会飘。
      void api.dragFloat();
    }
  }, []);

  const onPointerUp = useCallback(() => {
    const wasDrag = dragging.current;
    pointer.current = null;
    dragging.current = false;
    // 拖动结束时不该顺手打开主窗口，只有「原地按一下」才算点击。
    if (!wasDrag) void api.showMain();
  }, []);

  /**
   * 悬停进出如实上报。这里不做任何「该不该收」的判断——
   * 那要看两边窗口的鼠标状态，只有 Rust 侧看得全。
   */
  const onPointerEnter = useCallback(() => {
    void api.panelHoverFloat(true);
  }, []);

  const onPointerLeave = useCallback(() => {
    void api.panelHoverFloat(false);
  }, []);

  const count = pending.length;

  return (
    <div className="flex h-screen w-screen items-end justify-end p-0.5">
      <button
        type="button"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        title={
          ongoing
            ? `正在进行：${ongoing.event.title}`
            : upcoming
              ? `接下来：${upcoming.event.title}（${fmtTime(upcoming.start)}）`
              : "今天没有安排"
        }
        className={[
          "group relative flex h-full w-full select-none flex-col items-center justify-center",
          "text-white transition-[opacity,background-color] duration-200",
          "opacity-70 hover:opacity-100",
          urgent
            ? "bg-rose-500/90 animate-pulse"
            : "bg-slate-800/80 hover:bg-slate-700/90",
        ].join(" ")}
        style={{
          // 切掉左上角，形成「嵌在屏幕角落」的梯形。
          clipPath: "polygon(30% 0, 100% 0, 100% 100%, 0 100%)",
        }}
      >
        <span className="text-[11px] leading-none opacity-80">{dateLabel}</span>
        <span className="text-xl leading-tight font-semibold tabular-nums">
          {dayNumber}
        </span>

        {count > 0 ? (
          <span
            className={[
              "absolute right-1.5 bottom-1 rounded-full px-1.5 text-[10px] leading-4 tabular-nums",
              urgent ? "bg-white/25" : "bg-white/15",
            ].join(" ")}
          >
            {count}
          </span>
        ) : (
          <span className="absolute right-1.5 bottom-1 text-[10px] leading-4 opacity-50">
            —
          </span>
        )}
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FloatBlock />
  </StrictMode>,
);
