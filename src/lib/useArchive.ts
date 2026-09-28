/**
 * 三个窗口共用的数据钩子。
 *
 * 数据流是「后端持有唯一真相，前端订阅」：任何写操作走 `api.*`，
 * 后端落盘后广播 `archive-changed`，所有窗口（包括发起方自己）
 * 收到广播再刷新。发起方不做本地乐观更新——个人软件的数据量下，
 * 一次 IPC 往返只有几毫秒，换来的是三个窗口永远不会不一致。
 */

import { useEffect, useMemo, useState } from "react";

import type { Archive, CalendarEvent, Occurrence, Tag } from "../types";
import { api, onArchiveChanged } from "./ipc";
import { addDays, parseTime, toDateKey } from "./time";

/** 展开后的一条发生记录，已经和它的事件本体拼好。 */
export interface OccurrenceView {
  event: CalendarEvent;
  start: string;
  end: string;
  /** 本次发生的开始时间，作为列表 key；重复事件靠它区分同一条的不同次 */
  key: string;
}

export function useArchive() {
  const [archive, setArchive] = useState<Archive | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    api
      .getArchive()
      .then((a) => {
        if (alive) setArchive(a);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      });

    const off = onArchiveChanged((a) => {
      if (alive) setArchive(a);
    });

    return () => {
      alive = false;
      off();
    };
  }, []);

  return { archive, error };
}

/**
 * 取某个日期区间内展开后的发生记录。
 *
 * `archive` 作为依赖传入：存档一变就重新展开，这样重复规则、
 * 标签、删除状态的变化都能立刻反映到界面上。
 */
export function useOccurrences(
  archive: Archive | null,
  fromKey: string,
  toKey: string,
): OccurrenceView[] {
  const [raw, setRaw] = useState<Occurrence[]>([]);

  useEffect(() => {
    if (!archive) return;
    let alive = true;

    api
      .occurrencesInRange(fromKey, toKey)
      .then((list) => {
        if (alive) setRaw(list);
      })
      .catch(() => {
        if (alive) setRaw([]);
      });

    return () => {
      alive = false;
    };
  }, [archive, fromKey, toKey]);

  return useMemo(() => {
    if (!archive) return [];

    const byId = new Map(archive.events.map((e) => [e.id, e]));
    const out: OccurrenceView[] = [];

    for (const occ of raw) {
      const event = byId.get(occ.eventId);
      // 事件可能刚被删掉而展开结果还没刷新，跳过即可。
      if (!event || event.deleted) continue;
      out.push({
        event,
        start: occ.start,
        end: occ.end,
        key: `${occ.eventId}@${occ.start}`,
      });
    }

    out.sort((a, b) => {
      // 全天事件排在最前面，其余按开始时间。
      if (a.event.allDay !== b.event.allDay) return a.event.allDay ? -1 : 1;
      return a.start.localeCompare(b.start);
    });
    return out;
  }, [archive, raw]);
}

/** 取今天的展开记录。悬浮块和小面板用。 */
export function useToday(archive: Archive | null): OccurrenceView[] {
  const key = toDateKey(new Date());
  return useOccurrences(archive, key, key);
}

/** 按 id 取标签，便于渲染时上色。 */
export function useTagMap(archive: Archive | null): Map<string, Tag> {
  return useMemo(
    () => new Map((archive?.tags ?? []).map((t) => [t.id, t])),
    [archive],
  );
}

/**
 * 某天是不是「今天」。
 *
 * 用固定时区算，不用 `new Date().toDateString()`——后者跟着系统时区走，
 * 在非 UTC+8 的机器上会判断错。
 */
export function isToday(d: Date): boolean {
  return toDateKey(d) === toDateKey(new Date());
}

/**
 * 一条发生记录是否正在进行中。
 * 悬浮块靠它决定「有没有事正在进行」的提示。
 */
export function isOngoing(occ: OccurrenceView, at = new Date()): boolean {
  const s = parseTime(occ.start);
  const e = parseTime(occ.end);
  return s <= at && at < e;
}

/** 今天还没开始的下一条。悬浮块显示「接下来」。 */
export function nextUpcoming(
  list: OccurrenceView[],
  at = new Date(),
): OccurrenceView | null {
  return (
    list.find((o) => parseTime(o.end) > at && !o.event.done) ?? null
  );
}

/** 供日期计算复用，避免各组件各写一遍。 */
export { addDays, toDateKey };
