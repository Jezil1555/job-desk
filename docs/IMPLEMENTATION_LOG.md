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


## 2026-10-30 — Phase 3 (Finance & CFO)

### Changes
- **Schema** (`20261030090000_phase3_finance.sql`, `20261030110000_fin_tighten_grants.sql`, applied): `fin_entities`, `fin_members`, `fin_accounts` (personal and business templates), `fin_parties`, `fin_journals` + `fin_lines` (double entry), `fin_invoices` + `fin_invoice_lines`, `fin_items` + `fin_stock_moves` (moving-average cost), `fin_payments` + `fin_allocations`, `fin_statement_lines`, `fin_budgets`, `fin_files` (private `finance` bucket), `fin_audit`; view `fin_invoice_totals`; functions to post, reverse, post/void invoices, record/void payments, adjust stock, match/unmatch statements, add members; hourly `fin_reminders()` job. Additive only.
- **Books created** (empty, no balances): Personal & Family (QAR, personal template), Dlusso Bespoke (QAR), Fitness Hub (QAR), The Burgery Thrissur (INR); each linked to its workspace, owned by Jezz.
- **Frontend**: Finance home (all books + combined view at management rate), per-entity Overview, Entries (journal editor with live balance check, drafts, reversal), opening-balances wizard, quick Expense/Income/Transfer, Invoices, Bills, Payments, Banking (CSV import, match, create entry, ignore), Accounts + ledger, Customers & suppliers with balances, Stock, Budgets, Reports (P&L, balance sheet, cash flow, trial balance, ageing, general ledger; print/PDF and CSV), Settings (members/roles, lock date, financial year, audit log); receipts on entries/invoices/payments; bills & invoices shown on linked tasks. Service worker cache → `jobdesk-v5`.

### Verification
- Unit tests: `npm test` → 44/44 (adds 16 finance calculations: posted-only, TB, P&L, balance sheet, cash flow, ledger, invoice status, ageing, budget variance, entry checks, FX, bank CSV/dates, match candidates).
- Database tests: `supabase/tests/phase3_tests.sql` → 73/73 on a local Postgres 16 (with `supabase/tests/local/stubs.sql`) and 73/73 on the live project in a rolled-back transaction with throwaway users and test books. Verified afterwards: no test users, books, entries, files or notifications left. Re-checked after the grant change (posting still works; signed-out visitors and internal helpers blocked).
- End-to-end UI: `python3 tests/e2e/run.py` → 99/99 (adds 28 finance checks incl. opening balances, quick expense, unbalanced entry refused, invoice → part payment → status, P&L/BS/TB figures, CSV export, statement import + match, budget, phone layouts).
- Security advisor: finance functions no longer callable by anonymous visitors; remaining warnings are the intentional signed-in helper/RPC functions (each checks the caller), `pg_net` in public, and leaked-password protection (dashboard).

### Known limitations
- Invoices and bills are in the entity's base currency; foreign-currency amounts can be noted on entry lines but aren't revalued.
- No tax/VAT/GST engine yet (Qatar has no VAT; India GST for The Burgery would be a later addition).
- Average cost uses all movements to date (not date-sensitive back-dating).
- Recurring bills and earmarked-fund rules are not automated yet.


## 2026-10-30 — Phase 4 (AI & integrations)

### Changes
- **Smart Quick Capture** (`public/js/smart.js`): dates/times/follow-up/#workspace/@owner/!priority parsed into removable chips; form values win; nothing invented.
- **Daily briefing** line on the Command Centre (rule-based).
- **Message drafts** for follow-ups and waiting tasks: polite/firm templates, open in WhatsApp or email, copy, "I sent it — log it".
- **Calendar link**: migration `20261030130000_phase4_calendar_ai.sql` (`calendar_feeds` with hashed tokens, `create_calendar_feed`, `revoke_calendar_feed`, service-role-only `calendar_feed_events`); edge function `calendar-feed` (iCal, verify_jwt off — the token is the credential); Settings card with Apple/Google instructions.
- **AI assistant**: edge function `assistant` (verify_jwt on, opt-in per user, daily limit, usage log `ai_usage` without content). Actions: rewrite a message, suggest meeting action items, draft the weekly review notes, suggest accounts for unmatched bank lines — all review-only.
- **Push reliability**: `20261030140000_push_timeout.sql` raises the database→push-function timeout from 8 s to 30 s (one push this morning timed out on a cold start).
- Service worker cache → `jobdesk-v6`.

### Verification
- Unit tests: `npm test` → 58/58 (adds 9 capture/briefing/draft, 2 iCal, 3 assistant prompt/validation/request tests — no network).
- Database tests: `supabase/tests/phase4_tests.sql` → 17/17 on the live project, rolled back (token hashing, own-row visibility, no direct writes, feed contents and exclusions, other users' items never included, bills only when chosen, new link revokes old, turn-off revokes, signed-in users can't read feeds by token, signed-out can't create links, usage log not writable).
- Live functions: `calendar-feed` returns 404 for unknown/ malformed tokens (exercises the service-role RPC path); `assistant` rejects requests without a session (401).
- End-to-end UI: `python3 tests/e2e/run.py` → 118/118 (adds 19: briefing, capture chips and chip removal, "tomorrow 3pm @adil" stored correctly, drafts send nothing until logged, calendar link shown once, AI opt-in, AI suggestions for action items / weekly notes / bank lines only populate review UI).
- Security advisor: no new findings beyond the intentional signed-in RPCs.

### Needs from the owner
- AI: add `ANTHROPIC_API_KEY` under Supabase → Edge Functions → Secrets, then turn it on in Settings. Until then AI buttons stay hidden and everything else works.
- Not verified: a live AI call (no key yet) and a calendar app subscribing to a real link (the sandbox can't reach Supabase; the iCal output is unit-tested).
