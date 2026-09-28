/**
 * 浏览器里的假后端。
 *
 * 只在**没有 Tauri 环境**时启用（也就是直接 `npm run dev` 用浏览器打开时）。
 * 目的是让界面能脱离 Rust 单独调——不然每改一个 CSS 都要等一遍 cargo 编译。
 *
 * 数据存在 localStorage，刷新不丢；但**它不是真实存档**，
 * 打包运行时会走 `ipc.ts` 里的真后端，这份代码不参与。
 */

import type {
  Archive,
  BackupEntry,
  CalendarEvent,
  EventDraft,
  ImportPreview,
  MergeStats,
  Occurrence,
  Plan,
  PlanDraft,
  Settings,
  Tag,
} from "../types";
import { SCHEMA_VERSION } from "../types";
import { addDays, parseTime, startOfDay, toDateKey, toLocalIso } from "./time";

const KEY = "calendar-mock-archive";

const nowIso = () => new Date().toISOString().replace(/Z$/, "+08:00");

function seedTags(): Tag[] {
  return [
    { id: "work", name: "工作", color: "#3b82f6" },
    { id: "life", name: "生活", color: "#22c55e" },
    { id: "study", name: "学习", color: "#8b5cf6" },
  ];
}

/** 造几条围绕今天的数据，方便看各种形态：全天、跨天、重复、已完成。 */
function seedEvents(): CalendarEvent[] {
  const today = startOfDay(new Date());
  const at = (dayOffset: number, hour: number, minute = 0) =>
    toLocalIso(new Date(addDays(today, dayOffset).getTime() + (hour * 60 + minute) * 60_000));

  const make = (
    title: string,
    dayOffset: number,
    startH: number,
    endH: number,
    extra: Partial<CalendarEvent> = {},
  ): CalendarEvent => ({
    id: crypto.randomUUID(),
    title,
    start: at(dayOffset, startH),
    end: at(dayOffset, endH),
    allDay: false,
    repeatRule: null,
    tags: [],
    priority: "normal",
    notes: "",
    subtasks: [],
    reminders: [10],
    snoozedUntil: null,
    done: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastModifiedBy: "pc",
    deleted: false,
    ...extra,
  });

  return [
    make("晨会", 0, 9, 9.5, { tags: ["work"], priority: "high" }),
    make("写周报", 0, 14, 16, {
      tags: ["work"],
      subtasks: [
        { id: crypto.randomUUID(), title: "收集数据", done: true },
        { id: crypto.randomUUID(), title: "写初稿", done: false },
      ],
    }),
    make("健身", 0, 19, 20, { tags: ["life"], reminders: [30] }),
    make("牙医预约", 1, 10, 11, { tags: ["life"], priority: "high", reminders: [60, 10] }),
    make("项目评审", 2, 15, 16.5, { tags: ["work"] }),
    make("读书", 2, 21, 22, {
      tags: ["study"],
      repeatRule: { rrule: "FREQ=DAILY;COUNT=5", exdates: [] },
    }),
    make("季度总结", -2, 13, 17, { tags: ["work"], done: true }),
  ];
}

/** 造几条长期计划：有提醒日期已过的、有快到的、有没有目标日期的。 */
function seedPlans(): Plan[] {
  const today = startOfDay(new Date());
  const day = (offset: number) => toDateKey(addDays(today, offset));

  const make = (
    title: string,
    targetDate: string | null,
    reminderDate: string | null,
    extra: Partial<Plan> = {},
  ): Plan => ({
    id: crypto.randomUUID(),
    title,
    targetDate,
    reminderDate,
    notes: "",
    done: false,
    reminded: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastModifiedBy: "pc",
    deleted: false,
    ...extra,
  });

  return [
    make("学完《数据库系统概念》", day(90), day(1), {
      notes: "每周至少两章，配合课后题",
    }),
    make("写完毕业论文初稿", day(150), day(-2)),
    make("把这本书读完", null, null, { notes: "没定截止日期，先挂着" }),
    make("整理去年的照片", day(-10), null, { done: true }),
  ];
}

function emptyArchive(): Archive {
  return {
    version: SCHEMA_VERSION,
    exportedAt: nowIso(),
    device: "pc",
    events: seedEvents(),
    plans: seedPlans(),
    tags: seedTags(),
    habits: [],
    habitLogs: [],
    focusSessions: [],
    settings: {
      theme: "dark",
      weekStart: 1,
      defaultReminder: 10,
      autostart: true,
    },
  };
}

function load(): Archive {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      // 兼容旧版本存下来的存档：加了新集合之后，localStorage 里那份
      // 还是老结构，直接当 Archive 用会在 `archive.plans.filter` 上崩。
      // 真后端的对应物是 serde 的 `#[serde(default)]`。
      return { ...emptyArchive(), ...(JSON.parse(raw) as Archive) };
    }
  } catch {
    // 存的东西坏了就当没有，重新播种
  }
  const fresh = emptyArchive();
  save(fresh);
  return fresh;
}

function save(archive: Archive): void {
  localStorage.setItem(KEY, JSON.stringify(archive));
}

/**
 * 预览用的简易重复展开。
 *
 * **这不是事实来源**——真正的 RRULE 解析在 `src-tauri/src/recurrence.rs`，
 * 打包运行时走的是那边。这里只覆盖 DAILY / WEEKLY 两种最常见的情况，
 * 让浏览器里能看出重复事件长什么样。碰到读不懂的规则就退化成单次事件。
 */
function expandForPreview(event: CalendarEvent, from: Date, to: Date): Date[] {
  const start = parseTime(event.start);
  const rule = event.repeatRule;

  if (!rule) {
    return start >= from && start <= to ? [start] : [];
  }

  const parts = new Map(
    rule.rrule
      .split(";")
      .filter((p) => p.includes("="))
      .map((p) => p.split("=", 2) as [string, string])
      .map(([k, v]) => [k.toUpperCase(), v]),
  );

  const freq = parts.get("FREQ")?.toUpperCase();
  const interval = Math.max(1, Number(parts.get("INTERVAL") ?? 1) || 1);
  const count = parts.get("COUNT") ? Number(parts.get("COUNT")) : undefined;
  // UNTIL 在 RRULE 里写作 `20260930T235959`，取前 8 位转成日期串。
  const untilRaw = parts.get("UNTIL");
  const until =
    untilRaw && untilRaw.length >= 8
      ? parseTime(
          `${untilRaw.slice(0, 4)}-${untilRaw.slice(4, 6)}-${untilRaw.slice(6, 8)}`,
        )
      : undefined;

  const stepMs =
    freq === "DAILY"
      ? interval * 86_400_000
      : freq === "WEEKLY"
        ? interval * 7 * 86_400_000
        : null;

  if (stepMs === null) {
    return start >= from && start <= to ? [start] : [];
  }

  const out: Date[] = [];
  for (let i = 0; i < 1000; i++) {
    if (count !== undefined && i >= count) break;
    const t = new Date(start.getTime() + i * stepMs);
    if (until && t > until) break;
    if (t > to) break;
    if (t >= from) out.push(t);
  }
  return out;
}

/** 与 `ipc.ts` 的真后端同签名，前端代码不需要知道自己跑在哪种模式下。 */
export function createMockBackend() {
  let archive = load();

  const commit = () => save(archive);

  const draftToEvent = (draft: EventDraft, id?: string): CalendarEvent => {
    const existing = id ? archive.events.find((e) => e.id === id) : undefined;
    return {
      id: id ?? crypto.randomUUID(),
      ...draft,
      snoozedUntil: null,
      done: existing?.done ?? false,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      lastModifiedBy: "pc",
      deleted: false,
    };
  };

  return {
    async getArchive(): Promise<Archive> {
      return structuredClone(archive);
    },

    async occurrencesInRange(from: string, to: string): Promise<Occurrence[]> {
      const fromD = parseTime(from);
      // `to` 是含端点的日期，展开到当天 23:59:59.999 为止。
      const toD = new Date(parseTime(to).getTime() + 86_400_000 - 1);

      const out: Occurrence[] = [];
      for (const e of archive.events) {
        if (e.deleted) continue;
        const start = parseTime(e.start);
        const durationMs = parseTime(e.end).getTime() - start.getTime();

        for (const s of expandForPreview(e, fromD, toD)) {
          out.push({
            eventId: e.id,
            start: toLocalIso(s),
            end: toLocalIso(new Date(s.getTime() + durationMs)),
          });
        }
      }

      out.sort((a, b) => a.start.localeCompare(b.start));
      return out;
    },

    async createEvent(draft: EventDraft): Promise<CalendarEvent> {
      if (draft.title.trim() === "") throw new Error("标题不能为空");
      const event = draftToEvent(draft);
      archive.events.push(event);
      commit();
      return event;
    },

    async updateEvent(id: string, draft: EventDraft): Promise<CalendarEvent> {
      const idx = archive.events.findIndex((e) => e.id === id);
      if (idx < 0) throw new Error(`找不到事件 ${id}`);
      const event = draftToEvent(draft, id);
      archive.events[idx] = event;
      commit();
      return event;
    },

    async deleteEvent(id: string): Promise<void> {
      const e = archive.events.find((x) => x.id === id);
      if (!e) throw new Error(`找不到事件 ${id}`);
      e.deleted = true;
      e.updatedAt = nowIso();
      commit();
    },

    async toggleEventDone(id: string): Promise<CalendarEvent> {
      const e = archive.events.find((x) => x.id === id);
      if (!e) throw new Error(`找不到事件 ${id}`);
      e.done = !e.done;
      e.updatedAt = nowIso();
      commit();
      return e;
    },

    async undoLast(): Promise<boolean> {
      // 浏览器 mock 不做撤销栈——它的意义是看界面，不是试数据安全。
      return false;
    },

    // ---------------------------------------------------------- 长期计划

    async createPlan(draft: PlanDraft): Promise<Plan> {
      if (draft.title.trim() === "") throw new Error("标题不能为空");
      const plan: Plan = {
        id: crypto.randomUUID(),
        title: draft.title.trim(),
        targetDate: draft.targetDate,
        reminderDate: draft.reminderDate,
        notes: draft.notes,
        done: false,
        reminded: false,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        lastModifiedBy: "pc",
        deleted: false,
      };
      archive.plans.push(plan);
      commit();
      return plan;
    },

    async updatePlan(id: string, draft: PlanDraft): Promise<Plan> {
      const p = archive.plans.find((x) => x.id === id);
      if (!p) throw new Error(`找不到计划 ${id}`);
      // 与 Rust 侧的 `Plan::set_reminder_date` 同一条规则：
      // 换了提醒日期就当作一条新提醒，清掉「已播报」。
      if (p.reminderDate !== draft.reminderDate) p.reminded = false;
      p.title = draft.title.trim();
      p.targetDate = draft.targetDate;
      p.reminderDate = draft.reminderDate;
      p.notes = draft.notes;
      p.updatedAt = nowIso();
      commit();
      return p;
    },

    async deletePlan(id: string): Promise<void> {
      const p = archive.plans.find((x) => x.id === id);
      if (!p) throw new Error(`找不到计划 ${id}`);
      p.deleted = true;
      p.updatedAt = nowIso();
      commit();
    },

    async togglePlanDone(id: string): Promise<Plan> {
      const p = archive.plans.find((x) => x.id === id);
      if (!p) throw new Error(`找不到计划 ${id}`);
      p.done = !p.done;
      // 刻意不动 reminded，与 Rust 侧一致。
      p.updatedAt = nowIso();
      commit();
      return p;
    },

    async updateSettings(settings: Settings): Promise<void> {
      archive.settings = settings;
      commit();
    },

    async dataDir(): Promise<string> {
      return "(浏览器预览模式没有数据目录)";
    },

    async openDataDir(): Promise<void> {
      throw new Error("浏览器预览模式打不开数据目录");
    },

    async exportArchive(_path: string): Promise<void> {
      throw new Error("浏览器预览模式不支持导出，请在打包后的应用里操作");
    },

    async inspectImport(_path: string): Promise<ImportPreview> {
      throw new Error("浏览器预览模式不支持导入，请在打包后的应用里操作");
    },

    async applyImport(_path: string, _mode: string): Promise<MergeStats> {
      throw new Error("浏览器预览模式不支持导入，请在打包后的应用里操作");
    },

    async listBackups(): Promise<BackupEntry[]> {
      return [];
    },

    async restoreBackup(_name: string): Promise<void> {
      throw new Error("浏览器预览模式不支持恢复，请在打包后的应用里操作");
    },

    async showMain(): Promise<void> {
      console.info("[mock] showMain");
    },
    async togglePanel(): Promise<void> {
      console.info("[mock] togglePanel");
    },
    async hidePanel(): Promise<void> {
      console.info("[mock] hidePanel");
    },
    async panelHoverFloat(over: boolean): Promise<void> {
      // 浏览器里悬浮块和面板是同页面的普通元素，悬停由 CSS 负责，
      // 后端的跨窗口裁决在这里没有对应物。
      console.info("[mock] panelHoverFloat", over);
    },
    async panelHoverPanel(over: boolean): Promise<void> {
      console.info("[mock] panelHoverPanel", over);
    },
    async quitApp(): Promise<void> {
      console.info("[mock] quitApp");
    },
    async dragFloat(): Promise<void> {
      // 浏览器里窗口拖拽由系统负责，这里无事可做
    },
    async today(): Promise<string> {
      return toLocalIso(new Date()).slice(0, 10);
    },

    /** 仅供开发时重置种子数据。 */
    async reset(): Promise<void> {
      archive = emptyArchive();
      commit();
    },
  };
}

export type MockBackend = ReturnType<typeof createMockBackend>;
