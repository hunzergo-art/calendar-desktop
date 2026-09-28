[English](./README.md) | [简体中文](./README.zh-CN.md)

# Open Calendar

An offline Windows desktop calendar. **No network, no account, no server** — all your data is a single JSON file on your own machine.

Lives in the system tray. A draggable widget sits in the bottom-right corner so you can glance at today's schedule at any time; hover it to expand a panel showing today / tomorrow / long-term plans.

---

## Screenshots

**Main window** — week view, with the mini calendar on the left and the day panel on the right.

![Main window: week view with mini calendar and day panel](docs/screenshots/main-window.png)

**Floating widget and hover panel** — the widget sits in the bottom-right corner showing today at a glance; hovering it expands the panel to its left, with the two bottom edges aligned.

<p>
  <img src="docs/screenshots/hover-panel.png" width="400" alt="Hover panel listing today's tasks, tomorrow's tasks and long-term plans">
  <img src="docs/screenshots/floating-widget.png" width="154" alt="Floating widget showing the weekday and date">
</p>

---

## Highlights

| | |
|---|---|
| **Fully offline** | Makes no network requests. No account, no sync service — your data never leaves the machine |
| **Floating widget** | Always-on-top in the bottom-right corner, draggable, turns red as a reminder approaches; hover to expand the panel, move away to collapse |
| **Long-term plans** | Things with a "by this date" goal (exams, moving) live on their own page and **do not occupy calendar time slots** |
| **Manual sync** | The archive is plain JSON — move it between machines with export/import; conflicts resolved by fixed rules |
| **Recoverable** | Every write backs up first; keeps the last 10 snapshots plus one per day for 30 days, restorable from Settings |

---

## Features

### Main window

- **Week view** — drag event blocks to reschedule
- **Month view** with mini-calendar navigation
- **Recurring events** — RRULE subset, expanded on demand rather than pre-generated
- **Reminders** — periodic scan, system notifications
- **Tag filtering** and search

### Floating widget and panel

Two separate windows. The widget is always visible and can be dragged anywhere; hovering expands a panel listing today's tasks, tomorrow's tasks and long-term plans, which collapses when the mouse leaves.

### Long-term plans

A separate "Plans" page: set a target date and a custom reminder date. Because plans sit alongside events at the data-structure level, they **structurally cannot appear** in the week or month view — no render-time filtering required.

### Settings

Week start day, default reminder time, launch at login, import/export archive, restore from history.

---

## Getting started

### Frontend only (browser preview, no Rust required)

```bash
npm install
npm run dev          # http://localhost:1420/
```

When no Tauri environment is detected it falls back to a mock backend: fake data in localStorage, file operations unavailable. Use this for UI work — no waiting on cargo.

### Full application

Requires the Rust toolchain and the MSVC build tools:

```powershell
winget install Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools   # select "Desktop development with C++"
```

**Reopen your terminal** and verify:

```bash
cargo --version && rustc --version
```

Then:

```bash
npm run app          # tauri dev
npm run app:build    # tauri build -> NSIS installer
```

> **For a bare executable without an installer**, use `./node_modules/.bin/tauri build --no-bundle`.
> Do **not** reach for `cargo build --release` — the resulting exe launches, but the window shows
> "This page can't be reached". The `custom-protocol` feature is injected only by the tauri CLI;
> without it, frontend assets resolve to `devUrl` instead of the embedded bundle.

---

## Data

### Location

`app_data_dir` (on Windows, `%APPDATA%\com.opencalendar.calendar\`):

```
data/calendar.json          main archive
data/calendar.json.bak      previous version (last line of defence against a bad write)
backups/calendar-*.json     snapshot on every write, last 10 kept
backups/daily-*.json        one per day, kept 30 days
config.json                 app settings
logs/app.log                log
```

Writes are always **atomic**: back up, write a temp file, fsync, rename over the target. The order matters — after a power loss `calendar.json` is either the complete old content or the complete new content, never half a JSON document.

Soft-deleted records are physically purged 90 days later on the next write.

### Sync

The archive is self-contained JSON. Move it between machines with "Export archive…" and "Import archive…". When the same `id` exists on both sides:

1. **Newer `updatedAt` wins** — regardless of deletion. Deleted on one side but edited on the other means it is still wanted, so the event comes back.
2. **On a tie, the deleting side wins.** A resurrected record is harder to notice than a missing one.
3. **On a tie with neither deleted, the local copy wins** — the one the user is looking at.

`settings` never participates in merging — theme, week start and launch-at-login are machine-local preferences and should not be overwritten by the other side. Replace-mode import preserves local `settings` too.

---

## Stack

| Layer | Choice |
|---|---|
| Shell | Tauri 2 |
| Frontend | React 19 + TypeScript |
| Styling | Tailwind 4 (CSS-first, no config file) |
| Backend | Rust |
| Storage | Local JSON files |

Time is **fixed to UTC+8** and does not read the system timezone. China does not observe daylight saving, so local times neither repeat nor go missing — event times are therefore stored as offset-less local strings, while timestamps carry an offset.

---

## Project layout

```
.
├── index.html / panel.html / float.html   entry points for the three windows
├── src/
│   ├── types.ts               TS mirror of the archive structure (matches model.rs; change both)
│   ├── float-window.tsx       floating widget
│   ├── panel-window.tsx       hover panel
│   ├── main-window.tsx        main window
│   ├── components/            WeekView / MonthView / MiniMonth / EventEditor
│   │                          / PlansView / PlanEditor / SettingsDialog
│   └── lib/
│       ├── time.ts            time parsing and formatting (fixed UTC+8)
│       ├── ipc.ts             the only frontend-backend channel, with a browser fallback
│       ├── mock.ts            fake backend for browser preview
│       └── useArchive.ts      shared data hook
├── scripts/                   UI verification tools, not part of the bundle
│   ├── make-icon.mjs          generate the app icon source image
│   ├── dump-windows.ps1       list a process's visible windows
│   ├── probe-window.ps1       client-area size + screen origin + DPI
│   ├── shot-window.ps1        screenshot a process's largest visible window
│   └── click-at.ps1           click at a screen coordinate
└── src-tauri/
    ├── tauri.conf.json        bundling and permissions
    ├── capabilities/          Tauri v2 permissions
    └── src/
        ├── model.rs           data structures
        ├── storage.rs         archive read/write and backups
        ├── recurrence.rs      RRULE expansion
        ├── import_export.rs   import/export and merging
        ├── commands.rs        IPC commands
        ├── window.rs          three-window management
        ├── tray.rs            tray icon
        └── reminder.rs        reminder scheduling
```

> The three windows are created by `window.rs`; `windows` in `tauri.conf.json` is an empty array.

---

## Known limitations

- **Windows only.** The tray, the registry-based launch-at-login and NSIS packaging are all Windows-specific.
- **No Android app yet.** The data structures and archive format are designed for two clients, but only the desktop side exists.
- **Dark theme only.** Around a hundred colours in the UI are hard-coded Tailwind classes; a light theme needs them collected into a design-token set first.
- **No drag-and-drop in the month view**, and dragging a recurring event is explicitly blocked (it first needs to answer "this occurrence or the whole series?").
- **Search filters only what is currently visible**, not the whole archive; the Plans page has no search.
- **No iCal import/export.**
- **Plan reminders fire at 09:00 on the day**, not configurable; no repeat reminders and no advance notice.
- Analytics, Pomodoro and habit tracking: data structures exist, no UI.

---

## License

[MIT](./LICENSE)
