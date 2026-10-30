# Architecture status — review against the Critical Architecture Review (30 Oct 2026)

Source of truth for what is done, what is missing, known defects and deployment status. Updated after every increment.
Checked against the live schema (47 public tables, all with RLS on) on 30 Oct 2026.

Legend: **Met** · **Partial** (works, but a stated requirement is missing) · **Gap** (not built)

## 1. Separate core objects — Met
Separate tables with their own lifecycle: `workspaces`, `projects`, `tasks` (subtasks via `parent_id`, one level), `task_dependencies`, `milestones`,
`follow_ups` + `follow_up_logs` (commitments), `contacts` (person/organisation), `task_comments`, `documents` (attachments), `activity`, `notifications`, `record_links`.

## 2. Ownership and accountability — Met (increment 1, 30 Oct)
- `created_by`, responsible `owner_id`, optional `assignee_id` and `reviewer_id` (all must be workspace members; the reviewer can't be the person doing the work),
  `due_at`, `next_action`. A task with a reviewer can only be completed by the reviewer's approval (`request_task_review` / `review_task`); review state can't be edited directly.
- Delegation and status history: every change of owner, assignee, reviewer, review state and status is logged in `activity` (old → new, who, when) and shown on the task's History tab.
- Changing project never changes people; moving workspace keeps people only if they're members there.
- Tests: 19 live DB checks (rolled back), rollback script verified locally (schema identical after undo), 1 unit, 7 browser checks.

## 3. Commitment tracking — Met (increment 2, 30 Oct)
Responsible person/organisation, internal/external, what exactly is expected, expected date, last contact, next follow-up, escalation date and status,
actual response (text + date), and an outcome (fulfilled / partly / not fulfilled / renegotiated / no longer needed) that must be recorded to close;
cancelling needs a reason. Reopening clears the outcome (kept in history). Completing a related task never closes a commitment.
Tests: 12 live DB checks (rolled back), rollback verified locally, 4 browser checks.

## 4. Financial ledger integrity — Met (FX partial)
Chart of accounts, journal headers/lines, balance check on posting, posting controls, lock date, reversals, payment allocations, AR/AP subledgers,
per-entity isolation, bank reconciliation, inventory accounting, audit history. Every dashboard figure is computed from posted lines.
Tests prove the trial balance balances and invoice/payment flows don't double-count (phase3 tests, 73 checks).
- Partial: foreign currency. Each set of books has one base currency; lines carry `fx_currency`/`fx_amount`, but there are no FX invoices, revaluation or realised gain/loss.

## 5. Entity separation — Met (increment 6, 31 Oct)
Personal, Dlusso, Fitness Hub and Burgery are separate books; cross-book account use is rejected; nothing auto-treats a transfer as income/expense.
Inter-entity transactions (`fin_ic_txns`, Finance → Inter-entity): transfer, paid-on-behalf or recharge between any two books you keep, posted in BOTH books
in one step with the same IC number, via one "Inter-entity current accounts" account per book tagged by counterparty. Different currencies need the amount
each side actually recorded (no assumed rate). Reversal reverses both sides. `fin_ic_position` checks each book's balance against the other book and the
recorded transactions (Matched / Mismatch). Partner accounts (Jezz ↔ Dlusso) remain as built.
Tests: 21 checks run both locally and live (rolled back), rollback verified locally, 4 browser checks.

## 6. Inventory and costing — Partial
- Met: stock moves are separate from cash, average cost, auditable move history, negative stock is refused.
- Gap: fabric receipt separate from purchase (goods-received), **consumption into work in progress**, **finished-order costing**, and an
  authorised negative-stock exception with a recorded reason.

## 7. Project progress — Met (increment 3, 30 Oct)
Milestone weights; planned and actual dates stored separately; **baselines** (project start/target and each milestone) frozen by "Set baseline".
Once baselined, any date change needs a reason and is logged in `schedule_revisions` (old → new, who, when, why); baselines can't be edited directly,
only re-baselined with a reason (old baseline kept in the log). `schedule_variance` view gives slip days per project and milestone.
Tests: 18 live DB checks (rolled back), rollback verified locally, 4 browser checks.

## 8. Notifications — Met (increment 5, 30 Oct)
Server-side scheduled jobs (pg_cron) for reminders, escalation (follow-ups), user time zones. Every phone push has a delivery record
(`notification_deliveries`: pending / sent / failed / no device / gave up, attempts, last error), unique per alert and reason (idempotent).
Failed or unconfirmed pushes are retried every 2 minutes with backoff (1, 5, 15, 60 min), giving up after 5 attempts. Alerts can be snoozed
(1 hour / tomorrow 9:00 / Monday 9:00, up to 30 days); they come back unread and push again. In-app history shows delivery status.
Tests: 11 local logic checks, 10 live DB checks (rolled back), rollback verified locally, 1 unit, 3 browser checks.

## 9. AI governance — Met (increment 4, 30 Oct)
The assistant only returns suggestions: it has no route to post entries, confirm payments, delete records, change deadlines or owners, close commitments
or send anything — those stay behind the person's own actions and the database rules. Every suggestion is recorded in `ai_proposals` (output only, never
the input text) and the app records what was done with it: accepted, accepted with edits, or rejected (with detail); untouched suggestions expire after
14 days. Decisions can only be added through `record_ai_decision` by the owner of the suggestion. History is shown in Settings → AI assistant.
Tests: 11 live DB checks (rolled back), rollback verified locally, 4 browser checks.

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
1. ~~Task accountability~~ — done.
2. ~~Commitments~~ — done.
3. ~~Project baselines~~ — done.
4. ~~AI proposal log~~ — done.
5. ~~Notification reliability~~ — done.
6. ~~Inter-entity transactions~~ — done.
7. **Dlusso production costing** — goods received, consumption to WIP, finished-order cost, authorised negative-stock exception.
8. **Foreign currency** — FX invoices/bills, realised gain/loss, month-end revaluation.
9. **Templates and project-specific fields** on the shared task engine.
10. **Rollback scripts** for each migration with a tested rollback procedure.

## Deployment status
- App: Render, auto-deploy from `main` (latest: live Google Calendar sync).
- Database: all migrations in `supabase/migrations` applied to project `lvusersarnzzamdgvxgm`.
- Edge functions: `send-push`, `calendar-feed`, `assistant`, `gcal-sync`.
