// Task-engine rules shared by every screen. Pure functions over plain rows; unit-tested in tests/unit.
// The database enforces the same rules (triggers); these give fast, friendly feedback in the UI.
import { daysFromToday, zonedDate, todayISO, DEFAULT_TZ } from "./util.js";

export const STATUSES = ["inbox", "not_started", "in_progress", "waiting", "blocked", "completed", "cancelled"];
export const STATUS_LABEL = { inbox: "Inbox", not_started: "Not started", in_progress: "In progress", waiting: "Waiting on someone", blocked: "Blocked", completed: "Completed", cancelled: "Cancelled" };
export const STATUS_SHORT = { inbox: "Inbox", not_started: "Not started", in_progress: "In progress", waiting: "Waiting", blocked: "Blocked", completed: "Done", cancelled: "Cancelled" };
export const PRIORITIES = ["critical", "high", "medium", "low"];
export const PRIORITY_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
export const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
export const PROJECT_STATUS_LABEL = { planned: "Planned", on_track: "On track", at_risk: "At risk", blocked: "Blocked", completed: "Completed", cancelled: "Cancelled" };
export const RECURRENCE_LABEL = { daily: "Every day", weekdays: "Every working day (Sun–Thu)", weekly: "Every week", monthly: "Every month", yearly: "Every year" };

export const isClosed = t => t.status === "completed" || t.status === "cancelled";
export const isOpen = t => !isClosed(t) && !t.deleted_at;

/** Deadline passed and task still open. */
export const isOverdue = (t, now = new Date()) => isOpen(t) && !!t.due_at && new Date(t.due_at) < now;

/** Days until the deadline in the user's zone (null when no deadline). */
export const dueInDays = (t, tz = DEFAULT_TZ, now = new Date()) => (t.due_at ? daysFromToday(zonedDate(t.due_at, tz), tz, now) : null);

export function followUpDue(t, now = new Date()) { return isOpen(t) && !!t.follow_up_at && new Date(t.follow_up_at) <= now; }

/** Prerequisites still open for a task. deps: [{task_id, depends_on_id}] */
export function openPrerequisites(task, deps, tasksById) {
  return deps.filter(d => d.task_id === task.id).map(d => tasksById.get(d.depends_on_id)).filter(p => p && isOpen(p));
}
/** A task is ready when nothing it depends on is still open. */
export const isReady = (task, deps, tasksById) => openPrerequisites(task, deps, tasksById).length === 0;
/** Tasks that wait on this one (downstream impact). */
export function dependents(task, deps, tasksById) {
  return deps.filter(d => d.depends_on_id === task.id).map(d => tasksById.get(d.task_id)).filter(Boolean);
}
/** Prerequisites that are themselves overdue — a dependency failure. */
export function overduePrerequisites(task, deps, tasksById, now = new Date()) {
  return openPrerequisites(task, deps, tasksById).filter(p => isOverdue(p, now));
}

/**
 * Progress rule (documented in docs/RULES.md):
 *  - task with subtasks: completed subtasks / subtasks not cancelled (calculated, read-only)
 *  - task without subtasks: the manually maintained progress value (100 when completed)
 */
export function taskProgress(task, subtasks) {
  const live = subtasks.filter(s => s.status !== "cancelled" && !s.deleted_at);
  if (live.length) return { value: Math.round(100 * live.filter(s => s.status === "completed").length / live.length), basis: "subtasks" };
  return { value: task.status === "completed" ? 100 : task.progress || 0, basis: "manual" };
}

/** Why a task can't be completed right now (mirrors the database rule). Empty array = can complete. */
export function completionBlockers(task, subtasks, deps, tasksById) {
  const out = [];
  const crit = Array.isArray(task.completion_criteria) ? task.completion_criteria : [];
  const unticked = crit.filter(c => !c.done);
  if (unticked.length) out.push(`${unticked.length} completion criteri${unticked.length === 1 ? "on" : "a"} not ticked`);
  const openSubs = subtasks.filter(s => !isClosed(s) && !s.deleted_at);
  if (openSubs.length) out.push(`${openSubs.length} subtask${openSubs.length === 1 ? "" : "s"} still open`);
  const pre = openPrerequisites(task, deps, tasksById);
  if (pre.length) out.push(`${pre.length} prerequisite task${pre.length === 1 ? "" : "s"} still open`);
  if (task.reviewer_id && task.review_status !== "approved") out.push("the reviewer hasn't approved it yet");
  return out;
}

/** Fields a status needs before the database will accept it. */
export function statusRequirements(status, t) {
  if (status === "waiting" && !(t.waiting_on || "").trim() && !t.waiting_on_contact_id) return "Say who you're waiting on.";
  if (status === "blocked" && !(t.blocker || "").trim()) return "Describe what's blocking it.";
  return null;
}

export function sortTasks(list, by = "smart") {
  const cmpDue = (a, b) => (a.due_at || "9999") < (b.due_at || "9999") ? -1 : (a.due_at || "9999") > (b.due_at || "9999") ? 1 : 0;
  const cmpPri = (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  return list.slice().sort((a, b) => {
    const ac = isClosed(a), bc = isClosed(b);
    if (ac !== bc) return ac ? 1 : -1;
    if (ac && bc) return (b.completed_at || b.updated_at || "").localeCompare(a.completed_at || a.updated_at || "");
    if (by === "priority") return cmpPri(a, b) || cmpDue(a, b);
    if (by === "updated") return (b.updated_at || "").localeCompare(a.updated_at || "");
    if (by === "created") return (b.created_at || "").localeCompare(a.created_at || "");
    if (by === "title") return a.title.localeCompare(b.title);
    // smart: deadline first, then priority
    return cmpDue(a, b) || cmpPri(a, b) || (a.created_at || "").localeCompare(b.created_at || "");
  });
}

/** Task views used by My Tasks and the sidebar. */
export const VIEWS = {
  today: { label: "Today", hint: "Due today, overdue, or follow-up due" },
  inbox: { label: "Inbox", hint: "Captured, not yet classified" },
  upcoming: { label: "Upcoming", hint: "Due in the next 14 days" },
  overdue: { label: "Overdue", hint: "Past their deadline" },
  priority: { label: "High priority", hint: "Critical and high" },
  waiting: { label: "Waiting on someone", hint: "Waiting for a reply" },
  blocked: { label: "Blocked", hint: "Can't progress" },
  delegated: { label: "Delegated", hint: "Created by you, owned by others" },
  mine: { label: "My tasks", hint: "Everything you own" },
  completed: { label: "Completed", hint: "Done or cancelled" },
  all: { label: "All tasks", hint: "Every open task" }
};

export function viewFilter(view, uid, tz = DEFAULT_TZ, now = new Date()) {
  return t => {
    if (t.deleted_at) return false;
    const n = dueInDays(t, tz, now);
    switch (view) {
      case "today": return isOpen(t) && (isOverdue(t, now) || n === 0 || followUpDue(t, now)) && t.owner_id === uid;
      case "inbox": return t.status === "inbox";
      case "upcoming": return isOpen(t) && n !== null && n >= 0 && n <= 14;
      case "overdue": return isOverdue(t, now);
      case "priority": return isOpen(t) && (t.priority === "critical" || t.priority === "high");
      case "waiting": return t.status === "waiting";
      case "blocked": return t.status === "blocked";
      case "delegated": return isOpen(t) && t.created_by === uid && t.owner_id && t.owner_id !== uid;
      case "mine": return isOpen(t) && t.owner_id === uid;
      case "completed": return isClosed(t);
      default: return isOpen(t);
    }
  };
}

/**
 * "What needs my attention?" — a ranked list across tasks, follow-ups and projects.
 * Score = urgency of the condition; ties broken by priority. Documented in docs/RULES.md.
 */
export function attentionItems({ tasks, followUps, health, projects, milestones, uid, mineOnly = true, tz = DEFAULT_TZ, now = new Date() }) {
  const items = [];
  const today = todayISO(tz, now);
  for (const t of tasks) {
    if (!isOpen(t)) continue;
    const mine = t.owner_id === uid || t.created_by === uid;
    if (mineOnly && !mine) continue;
    const pr = 3 - PRIORITY_RANK[t.priority];
    if (isOverdue(t, now)) items.push({ kind: "task", id: t.id, reason: "Overdue", score: 100 + pr * 5, ref: t });
    else if (t.status === "blocked") items.push({ kind: "task", id: t.id, reason: "Blocked", score: 80 + pr * 5, ref: t });
    else if (followUpDue(t, now)) items.push({ kind: "task", id: t.id, reason: "Follow-up due", score: 70 + pr * 5, ref: t });
    else if (dueInDays(t, tz, now) === 0) items.push({ kind: "task", id: t.id, reason: "Due today", score: 60 + pr * 5, ref: t });
    else if (t.priority === "critical" && dueInDays(t, tz, now) !== null && dueInDays(t, tz, now) <= 2) items.push({ kind: "task", id: t.id, reason: "Critical, due soon", score: 55, ref: t });
  }
  for (const f of followUps) {
    if (f.status === "escalated") items.push({ kind: "follow_up", id: f.id, reason: "Escalated", score: 90, ref: f });
    else if (f.status === "open" && f.next_follow_up_at && new Date(f.next_follow_up_at) <= now) items.push({ kind: "follow_up", id: f.id, reason: "Follow-up due", score: 75, ref: f });
    else if (f.status === "open" && f.expected_at && f.expected_at < today) items.push({ kind: "follow_up", id: f.id, reason: "Response overdue", score: 72, ref: f });
  }
  for (const h of health) {
    const p = projects.find(x => x.id === h.project_id);
    if (!p || p.archived) continue;
    if (h.effective_status === "blocked") items.push({ kind: "project", id: p.id, reason: "Project blocked", score: 85, ref: p, why: h.reasons });
    else if (h.effective_status === "at_risk") items.push({ kind: "project", id: p.id, reason: "Project at risk", score: 65, ref: p, why: h.reasons });
  }
  for (const m of milestones) {
    if (!m.actual_date && m.planned_date && m.planned_date < today) items.push({ kind: "milestone", id: m.id, reason: m.is_critical ? "Critical milestone overdue" : "Milestone overdue", score: m.is_critical ? 88 : 68, ref: m });
  }
  return items.sort((a, b) => b.score - a.score);
}

/** Planned vs actual variance in days for a milestone (positive = late). */
export function milestoneVariance(m, tz = DEFAULT_TZ, now = new Date()) {
  if (!m.planned_date) return null;
  if (m.actual_date) return Math.round((Date.parse(m.actual_date) - Date.parse(m.planned_date)) / 86400000);
  const n = daysFromToday(m.planned_date, tz, now);
  return n < 0 ? -n : null; // late so far (open and past plan)
}

/** Who is doing the work: the assignee if there is one, otherwise the responsible owner. */
export const doerOf = t => t.assignee_id || t.owner_id;
/** Tasks that involve this person: responsible for, assigned to, or waiting for their review. */
export const involves = (t, uid) => t.owner_id === uid || t.assignee_id === uid || (t.reviewer_id === uid && t.review_status === "requested");
