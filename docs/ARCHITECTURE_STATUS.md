# Architecture status — review against the Critical Architecture Review (30 Oct 2026)

Source of truth for what is done, what is missing, known defects and deployment status. Updated after every increment.
Checked against the live schema (47 public tables, all with RLS on) on 30 Oct 2026.

Legend: **Met** · **Partial** (works, but a stated requirement is missing) · **Gap** (not built)

## 1. Separate core objects — Met
Separate tables with their own lifecycle: `workspaces`, `projects`, `tasks` (subtasks via `parent_id`, one level), `task_dependencies`, `milestones`,
`follow_ups` + `follow_up_logs` (commitments), `contacts` (person/organisation), `task_comments`, `documents` (attachments), `activity`, `notifications`, `record_links`.

## 2. Ownership and accountability — Partial
- Met: `created_by`, responsible `owner_id` (must be a workspace member), `due_at`, `next_action`; owner and status changes are logged in `activity`
  with old → new values (this is the status and delegation history); changing project never changes the owner.
- Gap: no separate **assignee** or **reviewer**; no history view on the task screen.

## 3. Commitment tracking — Partial
- Met: responsible person/organisation (`contact_id` / `counterpart`), expected date, last contact, next follow-up, escalation date and status,
  contact log; completing a linked task does **not** close the follow-up.
- Gap: separate fields for **what is expected**, **actual response** and **outcome**; internal/external flag.

## 4. Financial ledger integrity — Met (FX partial)
Chart of accounts, journal headers/lines, balance check on posting, posting controls, lock date, reversals, payment allocations, AR/AP subledgers,
per-entity isolation, bank reconciliation, inventory accounting, audit history. Every dashboard figure is computed from posted lines.
Tests prove the trial balance balances and invoice/payment flows don't double-count (phase3 tests, 73 checks).
- Partial: foreign currency. Each set of books has one base currency; lines carry `fx_currency`/`fx_amount`, but there are no FX invoices, revaluation or realised gain/loss.

## 5. Entity separation — Partial
- Met: Personal, Dlusso, Fitness Hub and Burgery are separate books; cross-book account use is rejected; nothing auto-treats a transfer as income/expense.
- Met for one case: partner accounts (Jezz ↔ Dlusso) post matching entries in both books with references and a two-book check.
- Gap: a general **inter-entity transaction** (e.g. Dlusso ↔ Fitness Hub loan) with due-to/due-from accounts and a matching check.

## 6. Inventory and costing — Partial
- Met: stock moves are separate from cash, average cost, auditable move history, negative stock is refused.
- Gap: fabric receipt separate from purchase (goods-received), **consumption into work in progress**, **finished-order costing**, and an
  authorised negative-stock exception with a recorded reason.

## 7. Project progress — Partial
- Met: milestone weights, planned vs actual dates, progress from weighted milestones and tasks.
- Gap: **baseline dates and revision history** — today a target date or milestone date can be edited in place (logged in `activity`, but there is no baseline to compare against).

## 8. Notifications — Partial
- Met: server-side scheduled jobs (pg_cron), idempotency via `*_reminded_for` markers, user time zones, escalation dates on follow-ups, in-app history, phone push.
- Gap: **delivery tracking and retry** (a failed push is not recorded or retried), **snooze**.

## 9. AI governance — Partial
- Met: the assistant only returns suggestions; it cannot post, pay, delete, change dates or owners, close commitments or send anything. Usage is counted.
- Gap: **recording each proposal and whether you accepted or rejected it**.

## 10. Technical governance — Partial
- Met: one shared task engine; migrations in the repo with an implementation log; RLS and cross-entity isolation tested on live (rolled back).
- Gap: **written rollback (down) scripts and a rollback test**; project templates and configurable fields.

## 11–12. Quality gates and discipline
Each feature so far has a schema, backend, frontend, permission tests, validation tests and persistence checks before deploy. Increments continue one at a time.

## Known defects / open items
- Google Calendar live sync: built and deployed; waits on the Google OAuth client and `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` secrets.
- Dashboard items still with the user: Supabase Site URL, leaked-password protection, `ANTHROPIC_API_KEY`.
- Dlusso: PR-0001 (5,186) payroll source to verify; four best-guess accounts; bank opening balance not entered (bank shows −8,000).

## Proposed increments (one at a time, each fully tested before deploy)
1. **Task accountability** — assignee and reviewer fields, delegation/status history panel on the task. *Small.*
2. **Commitments** — expected / response / outcome fields, internal-external flag, outcome required to close.
3. **Project baselines** — baseline dates on projects and milestones, revision log with reason, slip report.
4. **AI proposal log** — every AI suggestion recorded with accept / edit / reject.
5. **Notification reliability** — delivery log, retry with backoff, snooze.
6. **Inter-entity transactions** — due-to / due-from between any two books, matching check.
7. **Dlusso production costing** — goods received, consumption to WIP, finished-order cost, authorised negative-stock exception.
8. **Foreign currency** — FX invoices/bills, realised gain/loss, month-end revaluation.
9. **Templates and project-specific fields** on the shared task engine.
10. **Rollback scripts** for each migration with a tested rollback procedure.

## Deployment status
- App: Render, auto-deploy from `main` (latest: live Google Calendar sync).
- Database: all migrations in `supabase/migrations` applied to project `lvusersarnzzamdgvxgm`.
- Edge functions: `send-push`, `calendar-feed`, `assistant`, `gcal-sync`.
