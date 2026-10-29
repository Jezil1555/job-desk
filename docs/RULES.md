# Job Desk — business rules

These rules are enforced in the database (triggers, constraints, row-level security) and mirrored in `public/js/logic.js` for instant feedback. The database is the authority.

## Tasks
| Rule | Where enforced |
|---|---|
| Statuses: Inbox, Not started, In progress, Waiting on someone, Blocked, Completed, Cancelled | check constraint |
| Priorities: Critical, High, Medium, Low — independent of status | check constraint |
| **Waiting** requires who you're waiting on (text or linked contact) | `tasks_before_write` |
| **Blocked** requires a description of the blocker | `tasks_before_write` |
| **Cancelled** requires a reason | `tasks_before_write` |
| **Complete** requires: every completion criterion ticked, no open subtasks, no open prerequisite tasks | `tasks_before_write` |
| Leaving **Completed** requires a recorded reason (only via `reopen_task(task, reason)`); reason is kept in the activity log | trigger + RPC |
| Owner must be a member of the task's workspace; project/milestone/parent must belong to the same workspace | `tasks_before_write` |
| Deleting a task is a soft delete (`deleted_at`), audited and restorable | client + audit trigger |
| Deadlines and follow-up dates are never invented: Quick Capture saves them as empty unless entered | client |
| Recurring tasks: completing one creates exactly one next occurrence, shifted from the deadline (weekdays skip Fri/Sat) | `tasks_after_write` |

### Progress
- Task **with subtasks**: completed subtasks ÷ subtasks that aren't cancelled. Read-only; manual progress is kept but not shown while subtasks exist.
- Task **without subtasks**: the manually set value; 100% on completion.

### Dependencies
- A task is **ready** when every prerequisite is Completed or Cancelled.
- A **dependency failure** is an open prerequisite that is itself overdue.
- Circular dependencies are rejected.

## Projects
- **Progress**: if the project has milestones → weight of milestones with an actual date ÷ total weight. Otherwise → completed top-level tasks ÷ top-level tasks that aren't cancelled. Neither → no progress shown.
- **Calculated status** (first match wins):
  1. Completed — has tasks or milestones, none open, all milestones achieved
  2. Blocked — a critical milestone is overdue, or a critical/high task is blocked
  3. At risk — any milestone overdue, a critical/high task overdue, target date passed with open work, or no task activity for 14 days with open work
  4. Planned — start date in the future and no task started
  5. On track — otherwise
- **Manual override** requires a reason; the calculated status is always shown next to it.
- Milestone variance uses real dates only: late = actual − planned; an open milestone past its planned date shows days overdue. Missing actual dates are never assumed.

## Follow-ups
- Party required: a linked contact or a typed person/organisation.
- Reminder fires **once per next-follow-up value**; changing the date re-arms it.
- On the **escalation date** the item becomes Escalated and the owner is alerted once.
- Nothing is ever sent to the other party automatically.

## Reminders (server-side, `run_reminders()`, every 5 minutes via pg_cron)
| Reminder | De-duplication |
|---|---|
| Overdue task | first when deadline passes, then at most every 24h while open |
| Due within 24h | once per deadline value (`due_soon_for`) |
| Task follow-up date reached | once per value (`followup_reminded_for`) |
| Follow-up tracker due | once per value (`reminded_for`) |
| Escalation | status change to Escalated prevents repeats |
Rows are locked with `FOR UPDATE SKIP LOCKED`, so overlapping runs can't double-send.

## Access (row-level security)
| Role | Read | Write |
|---|---|---|
| Workspace owner | everything in the workspace | everything; manage people & roles; delete workspace |
| Member | everything in the workspace | tasks, projects, milestones, follow-ups, contacts, comments |
| Viewer | everything in the workspace | nothing |
| Not a member / signed out | nothing | nothing |
The audit log (`activity`) is written only by triggers and can't be edited or deleted by users. Finance permissions will be per entity (Phase 3).

## Command Centre "attention" ranking
Overdue task (100 + priority) › Escalated follow-up (90) › Critical milestone overdue (88) › Project blocked (85) › Blocked task (80 + priority) › Follow-up due (75) › Response overdue (72) › Task follow-up due (70 + priority) › Milestone overdue (68) › Project at risk (65) › Due today (60 + priority) › Critical due within 2 days (55).
