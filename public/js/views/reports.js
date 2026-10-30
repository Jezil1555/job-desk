// Reports & Insights — every number here is counted from stored records; nothing is estimated.
import { aiOn, aiCall } from "../assist.js";
import { esc, todayISO, addDays, fmtDate, fmtDateTime, zonedDate } from "../util.js";
import { isOpen, isOverdue, dueInDays, followUpDue, PROJECT_STATUS_LABEL, STATUS_LABEL, PRIORITY_LABEL } from "../logic.js";
import { weeklyReport, ownerWorkload, milestoneReport, toCSV, weekStartOf, habitRate, habitDueOn } from "../insights.js";
import { state, wsById, projectById, nameOf, activeWorkspaces } from "../store.js";
import { sb, run } from "../api.js";
import { ICON, $, taskRow, section, emptyState, projectPill, toast, toastError, busy } from "../ui.js";
import { activeHabits, doneSet } from "./goals.js";

export const REPORT_TABS = { daily: "Daily overview", weekly: "Weekly review", projects: "Projects", workload: "Workload" };

const scopeWs = () => { const f = state.ui.repWs || ""; const live = new Set(activeWorkspaces().map(w => w.id)); return t => live.has(t.workspace_id) && (!f || t.workspace_id === f); };
const liveTasks = () => state.tasks.filter(t => !t.deleted_at).filter(scopeWs());
const tile = (n, label, cls = "") => `<div class="tile ${cls}"><span class="tn">${n}</span><span class="tl">${label}</span></div>`;
function download(name, text) {
  const url = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const TASK_COLS = [
  { label: "Title", key: "title" }, { label: "Workspace", get: t => (wsById(t.workspace_id) || {}).name },
  { label: "Project", get: t => (projectById(t.project_id) || {}).name }, { label: "Status", get: t => STATUS_LABEL[t.status] },
  { label: "Priority", get: t => PRIORITY_LABEL[t.priority] }, { label: "Owner", get: t => nameOf(t.owner_id) },
  { label: "Due", get: t => t.due_at ? fmtDateTime(t.due_at, state.tz, true) : "" }, { label: "Completed", get: t => t.completed_at ? fmtDateTime(t.completed_at, state.tz, true) : "" },
  { label: "Waiting on", key: "waiting_on" }, { label: "Blocker", key: "blocker" }, { label: "Next action", key: "next_action" }
];

export function renderReports(view, tab = "daily") {
  if (!REPORT_TABS[tab]) tab = "daily";
  const body = tab === "daily" ? daily() : tab === "weekly" ? weekly() : tab === "projects" ? projects() : workload();
  view.innerHTML = `
  <div class="page-head"><div><h1>Reports & Insights</h1><p class="sub">Counted from your records as of ${fmtDateTime(new Date().toISOString(), state.tz)}.</p></div>
    <div class="filters noprint"><select class="input" id="rep-ws"><option value="">All workspaces</option>${activeWorkspaces().map(w => `<option value="${w.id}" ${state.ui.repWs === w.id ? "selected" : ""}>${esc(w.name)}</option>`).join("")}</select>
    <button class="btn" data-act="rep-print">Print / PDF</button></div></div>
  <div class="viewtabs noprint">${Object.entries(REPORT_TABS).map(([k, l]) => `<a href="#/reports/${k}" class="${tab === k ? "on" : ""}">${l}</a>`).join("")}</div>
  <div class="report">${body}</div>`;
}

/* ---------- daily ---------- */
function daily() {
  const tz = state.tz, now = new Date(), today = todayISO(tz);
  const ts = liveTasks(), open = ts.filter(isOpen);
  const overdue = open.filter(t => isOverdue(t, now));
  const dueToday = open.filter(t => t.due_at && !isOverdue(t, now) && dueInDays(t, tz, now) === 0);
  const doneToday = ts.filter(t => t.status === "completed" && t.completed_at && zonedDate(t.completed_at, tz) === today);
  const createdToday = ts.filter(t => zonedDate(t.created_at, tz) === today);
  const fus = state.followUps.filter(scopeWs()).filter(f => ["open", "escalated"].includes(f.status));
  const fuDue = fus.filter(f => f.status === "escalated" || (f.next_follow_up_at && new Date(f.next_follow_up_at) <= now));
  const followNow = open.filter(t => followUpDue(t, now));
  const pendingDec = state.notes.filter(scopeWs()).filter(n => n.kind === "decision" && n.decision_status === "proposed");
  const habits = activeHabits().filter(h => habitDueOn(h, today)), habitsDone = habits.filter(h => doneSet(h.id).has(today));
  return `<h2 class="print-only">Daily overview · ${fmtDate(today)}</h2>
  <div class="tiles">${tile(open.length, "Open tasks")}${tile(overdue.length, "Overdue", overdue.length ? "bad" : "")}${tile(dueToday.length, "Due today")}${tile(doneToday.length, "Completed today", "ok")}${tile(createdToday.length, "Added today")}
    ${tile(open.filter(t => t.status === "blocked").length, "Blocked")}${tile(open.filter(t => t.status === "waiting").length, "Waiting")}${tile(fuDue.length, "Follow-ups due")}${habits.length ? tile(`${habitsDone.length}/${habits.length}`, "Habits today") : ""}</div>
  ${overdue.length ? section("Overdue", `<div class="list">${overdue.slice(0, 25).map(t => taskRow(t)).join("")}</div>`, { count: overdue.length, cls: "risk" }) : ""}
  ${dueToday.length ? section("Due today", `<div class="list">${dueToday.map(t => taskRow(t)).join("")}</div>`, { count: dueToday.length }) : ""}
  ${followNow.length ? section("Tasks to chase today", `<div class="list">${followNow.map(t => taskRow(t)).join("")}</div>`, { count: followNow.length }) : ""}
  ${doneToday.length ? section("Completed today", `<div class="list">${doneToday.map(t => taskRow(t)).join("")}</div>`, { count: doneToday.length }) : ""}
  ${pendingDec.length ? section("Decisions waiting to be made", `<div class="list">${pendingDec.map(n => `<div class="trow" data-act="open-note" data-id="${n.id}" role="button" tabindex="0"><div class="tmain"><div class="ttitle">${esc(n.title)}</div><div class="tmeta">${esc((wsById(n.workspace_id) || {}).name || "")}</div></div></div>`).join("")}</div>`, { count: pendingDec.length }) : ""}
  ${!overdue.length && !dueToday.length && !doneToday.length ? `<p class="calm">${ICON.done} Nothing overdue or due today.</p>` : ""}`;
}

/* ---------- weekly ---------- */
function weekly() {
  const tz = state.tz, today = todayISO(tz);
  const from = state.ui.repWeek || weekStartOf(addDays(today, -7)) /* default: last full week */, to = addDays(from, 6);
  const notes = state.notes.filter(scopeWs());
  const ms = state.milestones.filter(m => { const p = projectById(m.project_id); return p && scopeWs()(p); });
  const r = weeklyReport({ tasks: liveTasks(), milestones: ms, notes, from, to, tz });
  const saved = state.reviews.find(x => x.week_start === from);
  const habits = activeHabits();
  const hRates = habits.map(h => ({ h, rate: habitRate(h, doneSet(h.id), from > (h.created_at || "").slice(0, 10) ? from : (h.created_at || from).slice(0, 10), to < today ? to : today) })).filter(x => x.rate !== null);
  state.ui.weekSnapshot = { from, to, completed: r.completed.length, created: r.created.length, overdue: r.overdue.length, carried: r.carried.length, blocked: r.blocked.length, waiting: r.waiting.length,
    completion_rate: r.completionRate, milestones_hit: r.msHit.length, milestones_missed: r.msMissed.length, decisions: r.decisions.length, workspace: state.ui.repWs || null };
  state.ui.weekCompleted = r.completed;
  const list = (arr, n = 15) => arr.length ? `<div class="list">${arr.slice(0, n).map(t => taskRow(t)).join("")}</div>${arr.length > n ? `<p class="hint">+${arr.length - n} more</p>` : ""}` : `<p class="calm">None.</p>`;
  return `
  <div class="weekpick noprint"><button class="btn sm" data-act="rep-week" data-d="${addDays(from, -7)}">‹ Previous</button><b>${fmtDate(from)} – ${fmtDate(to)}</b><button class="btn sm" data-act="rep-week" data-d="${addDays(from, 7)}" ${addDays(from, 7) > today ? "disabled" : ""}>Next ›</button>
    ${from !== weekStartOf(today) ? `<button class="btn sm" data-act="rep-week" data-d="${weekStartOf(today)}">This week</button>` : ""}<button class="btn sm" data-act="rep-csv-week">${ICON.download}CSV</button></div>
  <h2 class="print-only">Weekly review · ${fmtDate(from)} – ${fmtDate(to)}</h2>
  <div class="tiles">${tile(r.completed.length, "Completed", "ok")}${tile(r.carried.length, "Due this week, still open", r.carried.length ? "warn" : "")}${tile(r.completionRate === null ? "—" : r.completionRate + "%", "On-time completion")}
    ${tile(r.created.length, "New tasks")}${tile(r.overdue.length, "Overdue now", r.overdue.length ? "bad" : "")}${tile(r.blocked.length, "Blocked now")}${tile(`${r.msHit.length}/${r.msHit.length + r.msMissed.length}`, "Milestones hit")}</div>
  <p class="hint">On-time completion = tasks completed this week ÷ (completed + due this week and still open).</p>
  ${section("Completed this week", list(r.completed), { count: r.completed.length })}
  ${r.carried.length ? section("Slipped — due this week, not done", list(r.carried), { count: r.carried.length, cls: "risk" }) : ""}
  ${r.blocked.length || r.waiting.length ? section("Blocked & waiting", list([...r.blocked, ...r.waiting]), { count: r.blocked.length + r.waiting.length }) : ""}
  ${r.msMissed.length || r.msHit.length ? section("Milestones", `<ul class="plain">${r.msHit.map(m => `<li>${ICON.check} ${esc(m.title)} — ${esc((projectById(m.project_id) || {}).name || "")} (${fmtDate(m.actual_date)})</li>`).join("")}${r.msMissed.map(m => `<li class="bad-text">✕ ${esc(m.title)} — ${esc((projectById(m.project_id) || {}).name || "")} planned ${fmtDate(m.planned_date)}</li>`).join("")}</ul>`) : ""}
  ${r.decisions.length || r.pendingDecisions.length ? section("Decisions", `<ul class="plain">${r.decisions.map(n => `<li><button class="linkbtn" data-act="open-note" data-id="${n.id}">${esc(n.title)}</button> — ${n.decision_status}</li>`).join("")}${r.pendingDecisions.filter(n => !r.decisions.includes(n)).map(n => `<li><button class="linkbtn" data-act="open-note" data-id="${n.id}">${esc(n.title)}</button> — <b>pending</b></li>`).join("")}</ul>`) : ""}
  ${hRates.length ? section("Habits", `<ul class="plain">${hRates.map(x => `<li>${esc(x.h.title)} — ${x.rate}%</li>`).join("")}</ul>`) : ""}
  ${section("Priorities for next week", list(r.nextWeek, 12), { count: r.nextWeek.length })}
  ${section("My review", `<form id="reviewForm" class="review-form">
    <label class="field"><span>Wins</span><textarea class="input" id="rv-wins" rows="3">${esc((saved || {}).wins || "")}</textarea></label>
    <label class="field"><span>Issues & lessons</span><textarea class="input" id="rv-issues" rows="3">${esc((saved || {}).issues || "")}</textarea></label>
    <label class="field"><span>Top priorities next week</span><textarea class="input" id="rv-prio" rows="3">${esc((saved || {}).priorities || "")}</textarea></label>
    <label class="field"><span>Notes ${aiOn() ? `<button type="button" class="linkbtn" data-act="rep-ai" id="rvAi">✨ Draft a summary with AI</button>` : ""}</span><textarea class="input" id="rv-notes" rows="${aiOn() ? 5 : 2}">${esc((saved || {}).notes || "")}</textarea></label>
    <div class="btnrow noprint"><button class="btn primary" type="submit" id="rvSave">${saved ? "Update review" : "Save review"}</button>${saved ? `<small class="hint">Saved ${fmtDateTime(saved.updated_at, state.tz)} · private to you</small>` : `<small class="hint">Private to you. Saves this week's numbers with it.</small>`}</div></form>`)}
  ${state.reviews.length ? section("Past reviews", `<ul class="plain">${state.reviews.slice(0, 12).map(x => `<li><button class="linkbtn" data-act="rep-week" data-d="${x.week_start}">${fmtDate(x.week_start)}</button> — ${x.snapshot && x.snapshot.completed !== undefined ? `${x.snapshot.completed} completed, ${x.snapshot.carried} slipped` : ""}</li>`).join("")}</ul>`, { cls: "noprint" }) : ""}`;
}

/* ---------- projects ---------- */
function projects() {
  const ps = state.projects.filter(p => !p.archived).filter(scopeWs());
  if (!ps.length) return emptyState("No projects", "Create projects inside a workspace to see their health here.");
  const sel = state.ui.repProject && ps.find(p => p.id === state.ui.repProject);
  const rows = ps.map(p => ({ p, h: state.healthById.get(p.id) || {} }));
  return `<div class="tablewrap"><table class="rtable"><thead><tr><th>Project</th><th>Workspace</th><th>Status</th><th class="num">Progress</th><th class="num">Open</th><th class="num">Overdue</th><th class="num">Blocked</th><th>Next milestone</th><th>Target</th></tr></thead><tbody>
    ${rows.map(({ p, h }) => `<tr class="${sel && sel.id === p.id ? "on" : ""}"><td><button class="linkbtn" data-act="rep-project" data-id="${p.id}">${esc(p.name)}</button></td><td>${esc((wsById(p.workspace_id) || {}).name || "")}</td><td>${projectPill(h.effective_status || "on_track")}</td>
      <td class="num">${h.progress ?? "—"}${h.progress !== null && h.progress !== undefined ? "%" : ""}</td><td class="num">${h.task_open || 0}</td><td class="num ${h.task_overdue ? "bad-text" : ""}">${h.task_overdue || 0}</td><td class="num">${h.task_blocked || 0}</td>
      <td>${h.next_milestone_title ? esc(h.next_milestone_title) + (h.next_milestone_date ? " · " + fmtDate(h.next_milestone_date) : "") : "—"}</td><td>${p.target_date ? fmtDate(p.target_date) : "—"}</td></tr>`).join("")}
  </tbody></table></div>
  <div class="btnrow noprint"><button class="btn sm" data-act="rep-csv-projects">${ICON.download}Projects CSV</button></div>
  ${sel ? projectDetail(sel) : `<p class="hint">Select a project for its milestone plan vs actual.</p>`}`;
}
function projectDetail(p) {
  const ms = milestoneReport(state.milestones.filter(m => m.project_id === p.id).sort((a, b) => (a.planned_date || "9").localeCompare(b.planned_date || "9")), state.tz);
  const open = state.tasks.filter(t => t.project_id === p.id && isOpen(t) && !t.deleted_at);
  return section(`${p.name} — plan vs actual`, (ms.length ? `<div class="tablewrap"><table class="rtable"><thead><tr><th>Milestone</th><th>Planned</th><th>Actual</th><th>Variance</th><th>State</th></tr></thead><tbody>
    ${ms.map(m => `<tr><td>${esc(m.title)}${m.is_critical ? " <b>(critical)</b>" : ""}</td><td>${m.planned_date ? fmtDate(m.planned_date) : "—"}</td><td>${m.actual_date ? fmtDate(m.actual_date) : "—"}</td>
      <td class="${m.variance_days > 0 ? "bad-text" : ""}">${m.variance_days === null ? "—" : m.variance_days > 0 ? `${m.variance_days}d late` : m.variance_days < 0 ? `${-m.variance_days}d early` : "on time"}</td><td>${{ achieved: "Achieved", overdue: "Overdue", pending: "Pending" }[m.state]}</td></tr>`).join("")}</tbody></table></div>
    <div class="btnrow noprint"><button class="btn sm" data-act="rep-csv-ms" data-id="${p.id}">${ICON.download}Milestones CSV</button><a class="btn sm" href="#/p/${p.id}">Open project</a></div>` : `<p class="calm">No milestones recorded.</p>`) +
    (open.length ? `<h3>Open tasks (${open.length})</h3><div class="list">${open.slice(0, 20).map(t => taskRow(t, { showWs: false })).join("")}</div>` : ""));
}

/* ---------- workload ---------- */
function workload() {
  const rows = ownerWorkload(liveTasks());
  if (!rows.length) return emptyState("No open work", "");
  const max = Math.max(...rows.map(r => r.open));
  return `<div class="tablewrap"><table class="rtable"><thead><tr><th>Owner</th><th class="num">Open</th><th></th><th class="num">Overdue</th><th class="num">High/critical</th><th class="num">Blocked</th><th class="num">Waiting</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${r.owner_id === "unassigned" ? "Unassigned" : esc(nameOf(r.owner_id))}</td><td class="num">${r.open}</td><td style="width:30%"><div class="bar"><i style="width:${Math.round(100 * r.open / max)}%"></i></div></td>
      <td class="num ${r.overdue ? "bad-text" : ""}">${r.overdue}</td><td class="num">${r.high}</td><td class="num">${r.blocked}</td><td class="num">${r.waiting}</td></tr>`).join("")}</tbody></table></div>
  <div class="btnrow noprint"><button class="btn sm" data-act="rep-csv-workload">${ICON.download}Workload CSV</button><button class="btn sm" data-act="rep-csv-open">${ICON.download}All open tasks CSV</button></div>`;
}

/* ---------- events ---------- */
export async function handleReportsClick(act, el, rerender) {
  const stamp = todayISO(state.tz);
  switch (act) {
    case "rep-print": window.print(); return true;
    case "rep-ai": {
      const snap = state.ui.weekSnapshot, list = a => (a || []).slice(0, 10).map(t => t.title);
      const btn = $("rvAi"); busy(btn, true, "Writing…");
      const r = await aiCall("weekly_narrative", { week: `${snap.from} to ${snap.to}`, numbers: snap, completed: list(state.ui.weekCompleted), wins: $("rv-wins").value, issues: $("rv-issues").value, priorities: $("rv-prio").value });
      busy(btn, false);
      if (r.error) return toastError(r.error), true;
      const ta = $("rv-notes"); ta.value = (ta.value.trim() ? ta.value.trim() + "\n\n" : "") + r.data.text; ta.focus();
      toast("Draft added to Notes — edit it, then save the review"); return true;
    }
    case "rep-week": state.ui.repWeek = el.dataset.d; if (state.route.a !== "weekly") location.hash = "#/reports/weekly"; else rerender(); return true;
    case "rep-project": state.ui.repProject = el.dataset.id; rerender(); return true;
    case "rep-csv-week": download(`weekly-completed-${state.ui.weekSnapshot.from}.csv`, toCSV(state.ui.weekCompleted || [], TASK_COLS)); return true;
    case "rep-csv-open": download(`open-tasks-${stamp}.csv`, toCSV(liveTasks().filter(isOpen), TASK_COLS)); return true;
    case "rep-csv-workload": download(`workload-${stamp}.csv`, toCSV(ownerWorkload(liveTasks()), [{ label: "Owner", get: r => r.owner_id === "unassigned" ? "Unassigned" : nameOf(r.owner_id) }, { label: "Open", key: "open" }, { label: "Overdue", key: "overdue" }, { label: "High/critical", key: "high" }, { label: "Blocked", key: "blocked" }, { label: "Waiting", key: "waiting" }])); return true;
    case "rep-csv-projects": download(`projects-${stamp}.csv`, toCSV(state.projects.filter(p => !p.archived).filter(scopeWs()), [{ label: "Project", key: "name" }, { label: "Workspace", get: p => (wsById(p.workspace_id) || {}).name },
      { label: "Status", get: p => PROJECT_STATUS_LABEL[(state.healthById.get(p.id) || {}).effective_status] }, { label: "Progress %", get: p => (state.healthById.get(p.id) || {}).progress }, { label: "Open tasks", get: p => (state.healthById.get(p.id) || {}).task_open },
      { label: "Overdue tasks", get: p => (state.healthById.get(p.id) || {}).task_overdue }, { label: "Next milestone", get: p => (state.healthById.get(p.id) || {}).next_milestone_title }, { label: "Target date", key: "target_date" }])); return true;
    case "rep-csv-ms": { const p = projectById(el.dataset.id);
      download(`milestones-${p.name.replace(/\W+/g, "-")}-${stamp}.csv`, toCSV(milestoneReport(state.milestones.filter(m => m.project_id === p.id), state.tz), [{ label: "Milestone", key: "title" }, { label: "Planned", key: "planned_date" }, { label: "Actual", key: "actual_date" }, { label: "Variance days", key: "variance_days" }, { label: "State", key: "state" }, { label: "Critical", get: m => m.is_critical ? "yes" : "" }])); return true; }
  }
  return false;
}
export function handleReportsChange(e, rerender) {
  if (e.target.id === "rep-ws") { state.ui.repWs = e.target.value; rerender(); return true; }
  return false;
}
export async function handleReportsSubmit(form, rerender) {
  if (form.id !== "reviewForm") return false;
  const snap = state.ui.weekSnapshot;
  const row = { user_id: state.user.id, week_start: snap.from, wins: $("rv-wins").value.trim() || null, issues: $("rv-issues").value.trim() || null, priorities: $("rv-prio").value.trim() || null, notes: $("rv-notes").value.trim() || null, snapshot: snap };
  const btn = $("rvSave"); busy(btn, true);
  const r = await run(sb.from("weekly_reviews").upsert(row, { onConflict: "user_id,week_start" }).select().single());
  busy(btn, false);
  if (r.error) return toastError(r.error), true;
  state.reviews = [r.data, ...state.reviews.filter(x => x.week_start !== r.data.week_start)].sort((a, b) => b.week_start.localeCompare(a.week_start));
  toast("Weekly review saved"); rerender(); return true;
}
