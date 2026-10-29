// Phase 2 rules: habits, meeting action items and report calculations. Pure functions; unit-tested.
import { addDays, weekdayOf, zonedDate, daysFromToday, DEFAULT_TZ } from "./util.js";
import { isOpen, isOverdue, isClosed, PRIORITY_RANK } from "./logic.js";

/* ---------- weeks (GCC working week starts Sunday) ---------- */
export const weekStartOf = dateStr => addDays(dateStr, -weekdayOf(dateStr));
export const weekDays = startStr => [...Array(7)].map((_, i) => addDays(startStr, i));

/* ---------- habits ---------- */
/** Is the habit expected on this date? daily: every day; days: chosen weekdays; weekly: any day counts toward the weekly target. */
export function habitDueOn(h, dateStr) {
  if (h.schedule === "days") return (h.days || []).includes(weekdayOf(dateStr));
  return true;
}

/**
 * Current streak.
 *  daily/days: consecutive scheduled days completed, counting back from today
 *              (today only counts if done; an unfinished today doesn't break the streak yet).
 *  weekly:     consecutive weeks that met the weekly target, counting back from the current week
 *              (the current week only counts once its target is met).
 */
export function habitStreak(h, doneDates, today) {
  const done = doneDates instanceof Set ? doneDates : new Set(doneDates);
  if (h.schedule === "weekly") {
    let n = 0, ws = weekStartOf(today);
    const met = s => weekDays(s).filter(d => done.has(d)).length >= (h.per_week || 1);
    if (!met(ws)) ws = addDays(ws, -7);
    for (let i = 0; i < 520 && met(ws); i++) { n++; ws = addDays(ws, -7); }
    return n;
  }
  let n = 0, d = today;
  if (!done.has(d)) d = addDays(d, -1);
  for (let i = 0; i < 3650; i++) {
    if (habitDueOn(h, d)) { if (!done.has(d)) break; n++; }
    d = addDays(d, -1);
    if (h.created_at && d < h.created_at.slice(0, 10)) break;
  }
  return n;
}

/** Completion rate (0–100) over [from, to]. weekly habits: share of the weekly target achieved per week (capped at 100). */
export function habitRate(h, doneDates, from, to) {
  const done = doneDates instanceof Set ? doneDates : new Set(doneDates);
  if (to < from) return null;
  if (h.schedule === "weekly") {
    let got = 0, need = 0;
    for (let ws = weekStartOf(from); ws <= to; ws = addDays(ws, 7)) {
      need += h.per_week || 1;
      got += Math.min(h.per_week || 1, weekDays(ws).filter(d => d >= from && d <= to && done.has(d)).length);
    }
    return need ? Math.round(100 * got / need) : null;
  }
  let due = 0, hit = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (habitDueOn(h, d)) { due++; if (done.has(d)) hit++; }
  return due ? Math.round(100 * hit / due) : null;
}

export function goalProgress(g) {
  if (g.status === "achieved") return 100;
  if (g.target_value === null || g.target_value === undefined || Number(g.target_value) === 0) return null;
  return Math.max(0, Math.min(100, Math.round(100 * Number(g.current_value || 0) / Number(g.target_value))));
}

/* ---------- meeting notes → proposed tasks (rule-based, always reviewed before creating) ---------- */
const ACTION_RE = /^\s*(?:[-*•]\s*)?(?:\[\s?\]\s*|todo:\s*|action:\s*|ai:\s*|→\s*|->\s*)(.+)$/i;
export function extractActionItems(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (/^\s*(?:[-*•]\s*)?\[x\]/i.test(raw)) continue; // already done
    const m = raw.match(ACTION_RE);
    if (!m) continue;
    let title = m[1].trim().replace(/\s+/g, " ");
    const owner = (title.match(/@([\p{L}][\p{L}.\-]*)/u) || [])[1] || null;
    if (!title) continue;
    out.push({ title: title.slice(0, 300), owner_hint: owner });
  }
  return out;
}

/* ---------- reports ---------- */
const inRange = (iso, from, to, tz) => { if (!iso) return false; const d = zonedDate(iso, tz); return d >= from && d <= to; };

/** Weekly executive review numbers from stored records only. */
export function weeklyReport({ tasks, milestones = [], notes = [], from, to, tz = DEFAULT_TZ, now = new Date() }) {
  const live = tasks.filter(t => !t.deleted_at);
  const completed = live.filter(t => t.status === "completed" && inRange(t.completed_at, from, to, tz));
  const created = live.filter(t => inRange(t.created_at, from, to, tz));
  const overdue = live.filter(t => isOverdue(t, now));
  const carried = live.filter(t => isOpen(t) && t.due_at && inRange(t.due_at, from, to, tz));
  const blocked = live.filter(t => t.status === "blocked");
  const waiting = live.filter(t => t.status === "waiting");
  const nextTo = addDays(to, 7);
  // next week: everything open that is due by the end of next week (including slipped work), plus undated high/critical work
  const nextWeek = live.filter(t => isOpen(t) && ((t.due_at && zonedDate(t.due_at, tz) <= nextTo) || (!t.due_at && (t.priority === "critical" || t.priority === "high"))))
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.due_at || "9").localeCompare(b.due_at || "9"));
  const msHit = milestones.filter(m => m.actual_date && m.actual_date >= from && m.actual_date <= to);
  const msMissed = milestones.filter(m => !m.actual_date && m.planned_date && m.planned_date >= from && m.planned_date <= to && m.planned_date < zonedDate(now, tz));
  const decisions = notes.filter(n => n.kind === "decision" && !n.deleted_at && ((n.decided_on && n.decided_on >= from && n.decided_on <= to) || inRange(n.created_at, from, to, tz)));
  const pendingDecisions = notes.filter(n => n.kind === "decision" && !n.deleted_at && n.decision_status === "proposed");
  return { completed, created, overdue, carried, blocked, waiting, nextWeek, msHit, msMissed, decisions, pendingDecisions,
    completionRate: completed.length + carried.length ? Math.round(100 * completed.length / (completed.length + carried.length)) : null };
}

/** Open work per owner, with overdue and high-priority counts. */
export function ownerWorkload(tasks, now = new Date()) {
  const m = new Map();
  for (const t of tasks) {
    if (!isOpen(t)) continue;
    const k = t.owner_id || "unassigned";
    const r = m.get(k) || { owner_id: k, open: 0, overdue: 0, high: 0, blocked: 0, waiting: 0 };
    r.open++; if (isOverdue(t, now)) r.overdue++; if (t.priority === "critical" || t.priority === "high") r.high++;
    if (t.status === "blocked") r.blocked++; if (t.status === "waiting") r.waiting++;
    m.set(k, r);
  }
  return [...m.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open);
}

/** Planned-vs-actual table for a project's milestones. */
export function milestoneReport(milestones, tz = DEFAULT_TZ, now = new Date()) {
  return milestones.map(m => {
    const late = m.actual_date ? Math.round((Date.parse(m.actual_date) - Date.parse(m.planned_date || m.actual_date)) / 86400000)
      : m.planned_date && daysFromToday(m.planned_date, tz, now) < 0 ? -daysFromToday(m.planned_date, tz, now) : null;
    return { ...m, state: m.actual_date ? "achieved" : late ? "overdue" : "pending", variance_days: m.planned_date ? late : null };
  });
}

/** CSV text from rows and column definitions [{key, label, get?}]. */
export function toCSV(rows, cols) {
  const q = v => { const s = v === null || v === undefined ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.map(c => q(c.label)).join(","), ...rows.map(r => cols.map(c => q(c.get ? c.get(r) : r[c.key])).join(","))].join("\n");
}

export const fmtBytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
export const safeFileName = name => String(name || "file").normalize("NFKD").replace(/[^\w.\-]+/g, "_").replace(/_+/g, "_").slice(-120) || "file";
