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

## 4. Financial ledger integrity — Met (FX: increment 8, 31 Oct)
Chart of accounts, journal headers/lines, balance check on posting, posting controls, lock date, reversals, payment allocations, AR/AP subledgers,
per-entity isolation, bank reconciliation, inventory accounting, audit history. Every dashboard figure is computed from posted lines.
Tests prove the trial balance balances and invoice/payment flows don't double-count (phase3 tests, 73 checks).
- Foreign currency: each set of books keeps one base currency. Invoices and bills can be raised in another currency with a rate the person enters
  (never assumed); posting converts each line at that rate and ledger lines keep the foreign amount. Foreign payments record both the foreign amount
  and what actually reached or left the bank; the invoice is cleared at its booked rate and the difference is posted as a **realised** gain or loss
  to "Exchange gains and losses" (4900). A payment can only settle invoices in its own currency (database trigger). **Month-end revaluation** values
  open foreign items at closing rates the person enters, posts the **unrealised** difference and reverses it the next day; it can be cancelled with
  a reason (opposite entries, originals kept). Totals, ageing and dashboard tiles count foreign documents in base at their booked rate.
  Limitation: an unallocated foreign payment sitting on account is not revalued.
  Tests: 29 checks run locally and live (rolled back), earlier finance suites re-run on top (phase 3: 73, partners: 61, inter-entity: 21,
  production: 24 — all pass), rollback verified locally, 2 unit, 13 browser checks.

## 5. Entity separation — Met (increment 6, 31 Oct)
Personal, Dlusso, Fitness Hub and Burgery are separate books; cross-book account use is rejected; nothing auto-treats a transfer as income/expense.
Inter-entity transactions (`fin_ic_txns`, Finance → Inter-entity): transfer, paid-on-behalf or recharge between any two books you keep, posted in BOTH books
in one step with the same IC number, via one "Inter-entity current accounts" account per book tagged by counterparty. Different currencies need the amount
each side actually recorded (no assumed rate). Reversal reverses both sides. `fin_ic_position` checks each book's balance against the other book and the
recorded transactions (Matched / Mismatch). Partner accounts (Jezz ↔ Dlusso) remain as built.
Tests: 21 checks run both locally and live (rolled back), rollback verified locally, 4 browser checks.

## 6. Inventory and costing — Met (increment 7, 31 Oct)
Stock moves are separate from cash, valued at average cost, with a full move history. **Goods received** (GRN-0001…) put fabric into stock at the
delivery-note cost against 2050 "Goods received, not yet billed"; the supplier's bill is coded to 2050 and clears it, so stock is never counted twice.
**Production orders** (JOB-0001…): fabric issued moves from inventory to 1250 Work in progress at average cost; stitching, trims and other costs are
added from a bank, cash, payable or expense account; completing the order moves the total job cost to cost of goods sold, and the order is then closed
to new costs. Material and other costs per order are shown from posted rows (`fin_production_summary`). Negative stock is refused unless the **owner**
authorises it with a reason, recorded in `fin_stock_exceptions` with the shortfall. Every cost and receipt is reversed by a document action (reason
required, material goes back into stock); a receipt already used can't be reversed and an order with costs can't be cancelled.
Tests: 24 checks run both locally and live (rolled back), rollback verified locally, 13 browser checks.

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
- Met (increment 9, 31 Oct): **configurable fields and project templates on the same engine.** Each workspace defines its own fields (text, number,
  date, choice list, yes/no), for every task or one project; values live on the task (`tasks.custom`), are checked by the database, can be
  required before completion, and every change is in the task's history. Fields are archived, never deleted (values kept); key and type are fixed.
  Any project can be saved as a template (milestones, tasks, priorities, criteria, next actions and its own fields — no values, people or progress),
  and a new project made from it with dates counted from a chosen start. Instantiation inserts ordinary rows as the person, so every task rule applies.
  Tests: 30 checks locally and live (rolled back), rollback verified locally, 3 unit, 9 browser checks. The live run caught that the app role can't
  write the activity log directly (the local stand-in allowed it); fixed with a checked helper (`20261031031000_template_log_fix`) and the
  stand-in now matches production for that table.
- Gap: written rollback (down) scripts for the migrations before increment 1.

## 11–12. Quality gates and discipline
Each feature so far has a schema, backend, frontend, permission tests, validation tests and persistence checks before deploy. Increments continue one at a time.

## Known defects / open items
- Browser test "goal progress" occasionally fails on timing (passes on re-run); test-only, the screen itself is correct.
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
7. ~~Dlusso production costing~~ — done.
8. ~~Foreign currency~~ — done.
9. ~~Templates and project-specific fields~~ — done.
10. **Rollback scripts** for each migration with a tested rollback procedure.

## Deployment status
- App: Render, auto-deploy from `main` (latest: templates and custom fields).
- Database: all migrations in `supabase/migrations` applied to project `lvusersarnzzamdgvxgm`.
- Edge functions: `send-push`, `calendar-feed`, `assistant`, `gcal-sync`.
