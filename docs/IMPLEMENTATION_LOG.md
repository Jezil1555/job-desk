# Implementation log

## 2026-10-29 — Phase 1 (Command Centre foundation)

### Audit findings (before)
- Static PWA, single 900-line `app.js`; Supabase (Postgres + Auth + Realtime + `send-push` Edge Function + pg_cron); Render static site from GitHub.
- "Projects" were really workspaces; thin task model; no follow-ups, milestones, calendar, tests, or migrations in the repo.

### Changes
- **Migrations committed** (`supabase/migrations/`), including the 4 previously applied directly.
- **Data safety**: snapshot in `backup.b20261029_*` (non-API schema) before restructuring. 1 real task and 4 workspaces carried over; "To do" → "Not started".
- **Schema** (`20261029140000_phase1_command_centre.sql`): `projects`→`workspaces` (ids kept), `workspace_members` with owner/member/viewer; new `projects`, `milestones`, `contacts`, `task_contacts`, `task_dependencies`, `follow_ups`, `follow_up_logs`, `activity` (append-only audit); task engine fields; `project_health` view; `search_all()`; `reopen_task()`; `run_reminders()` (5-min cron, idempotent). Rules in `docs/RULES.md`.
- **Frontend** rebuilt as ES modules (no build step kept): `js/main.js` shell/router, `js/logic.js` rules, `js/util.js` time zones, `js/api.js` data, views (Command Centre, My Tasks list/board, Workspaces, Project, Calendar month/week/day, Follow-ups, Search, Alerts, Settings), sheets (task detail, Quick Capture, project/milestone/follow-up/workspace/contact forms). Persistent sidebar ≥1000px; bottom nav + More on phones. Finance, Goals, Notes, Reports shown as honest "planned" pages.
- **Time zones**: stored UTC, displayed in the profile time zone (default Asia/Qatar).
- **Exports**: tasks CSV and full JSON backup from Settings.

### Verification
- Unit tests: `npm test` → 17/17 pass (rules + time-zone conversion).
- Database tests: `supabase/tests/phase1_tests.sql` → 47/47 pass in a rolled-back transaction with two throwaway users (rules, RLS for outsider/viewer/member/anon, reminders de-dup, health, recurrence). Verified no test data persisted.
- End-to-end UI: `python3 tests/e2e/run.py` → 37/37 pass (desktop + phone, light + dark, against an in-memory API fake; no console errors, no horizontal overflow).
- Security advisor: remaining warnings are intentional — access-check helpers and owner-only RPCs must be callable by signed-in users (each checks the caller internally; covered by tests); `pg_net` lives in `public` (Supabase default); leaked-password protection needs enabling in the dashboard.

### Known limitations / remaining issues
1. Supabase **Site URL** still `localhost` → email confirmation links land on localhost (account is still confirmed). Fix in dashboard: Authentication → URL Configuration.
2. **Leaked-password protection** off (dashboard toggle).
3. Phone push delivery verified server-side only; needs a real-device check.
4. E2E tests use an API fake (the sandbox can't reach Supabase); live smoke test done by the user.
5. Attachments wait for Phase 2 storage; Quick Capture says so.
6. Tasks load all open + 120 days of closed (older on demand). Fine for personal scale; server-side pagination for very large lists is a later step.

### Next (Phase 2)
Notes & documents (private storage, signed URLs), goals & habits, reports (daily overview, weekly executive review, project reports), activity views per workspace, mobile refinements.


## 2026-10-29 — Phase 2 (Notes, documents, goals, habits, reports)

### Changes
- **Schema** (`20261029160000_phase2_knowledge_goals.sql`, applied): `notes` (note/meeting/decision, full-text search), `documents` (file or link), `record_links`, private storage bucket `documents` with membership-based policies; private per-user `goals`, `goal_updates`, `habits`, `habit_logs`, `health_logs`, `weekly_reviews`; `search_all()` now covers notes and documents; audit + realtime on notes/documents/links. Additive only — no existing data changed.
- **Frontend**: Notes & Documents screen (tabs, filters, tags, decision log), note editor with linking and "create tasks from action items" (reviewed, no invented dates), document upload/link/open/delete; "Notes & documents" panel on every task and project; attachments in Quick Capture; Goals & Habits (today check-in, week grid, streaks, 30-day rate, goals by horizon with objectives and progress updates, optional health log with weight trend); Reports (daily overview, weekly review with save, project plan-vs-actual, workload, CSV exports, print/PDF); workspace "Notes & docs" and "Activity" tabs; "Habits today" on the Command Centre. Service worker cache → `jobdesk-v4`.
- Rules documented in `docs/RULES.md`.

### Verification
- Unit tests: `npm test` → 29/29 (adds 12 for habits, streaks, action items, weekly report, workload, milestones, CSV).
- End-to-end UI: `python3 tests/e2e/run.py` → 71/71 (adds 34: meeting → reviewed tasks with no deadlines, decision validation, file upload to workspace folder + signed link + delete, habit tick/untick and future lock, goal progress, health log, daily/weekly/project/workload reports, weekly review upsert, CSV download, workspace tabs, note search, phone layouts).
- Database tests: `supabase/tests/phase2_tests.sql` → 31/31 pass on the live project in a rolled-back transaction (owner/viewer/outsider/anonymous access to notes, documents, links and stored files; cross-workspace and missing-record links rejected; goals/habits/health/reviews private even from co-members; habit date rule; audit). Verified afterwards: no test users, workspaces or files left; documents bucket private, 25 MB limit. Storage rows can't be deleted from SQL (Supabase guard), so file-delete access is tested through the write check its policy uses.
- Security advisor (2026-10-30): no new findings from Phase 2; remaining warnings are the intentional ones listed under Phase 1.
- Deployed: Render deploy `dep-dbhnfmh5efls7394ek40` live.

### Known limitations
- Linking an existing note/document from a task uses a numbered picker; a searchable picker is a later refinement.
- Health log has no charts beyond the weight trend.
