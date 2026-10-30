// Workspaces → projects → milestones & tasks.
import { esc, fmtDate, todayISO, daysFromToday } from "../util.js";
import { isOpen, isOverdue, sortTasks, milestoneVariance, PROJECT_STATUS_LABEL, PRIORITY_LABEL, overduePrerequisites, openPrerequisites, isClosed } from "../logic.js";
import { emit, state, wsById, projectById, membersOf, nameOf, canWrite, isWsOwner, roleIn, contactById } from "../store.js";
import { ICON, taskRow, section, emptyState, wsDot, avatar, projectPill, prioChip } from "../ui.js";
import { phRow, actRow } from "./home.js";
import { linkedPanel, NOTE_KIND, DOC_CATEGORY } from "../sheets/knowledge.js";
import { sb, run } from "../api.js";
import { ago } from "../util.js";

export function renderWorkspaces(view) {
  const list = state.workspaces;
  view.innerHTML = `<div class="page-head"><div><h1>Projects & Workspaces</h1><p class="sub">Each workspace keeps its own projects, tasks, follow-ups, contacts and people.</p></div>
    <div class="filters"><button class="btn primary" data-act="new-workspace">${ICON.plus}New workspace</button></div></div>
  <div class="ws-grid">${list.filter(w => !w.archived).map(wsCard).join("")}</div>
  ${list.some(w => w.archived) ? section("Archived", `<div class="ws-grid">${list.filter(w => w.archived).map(wsCard).join("")}</div>`) : ""}`;
}
function wsCard(w) {
  const ts = state.tasks.filter(t => t.workspace_id === w.id && !t.deleted_at);
  const open = ts.filter(isOpen), od = open.filter(t => isOverdue(t)).length, bl = open.filter(t => t.status === "blocked").length;
  const projs = state.projects.filter(p => p.workspace_id === w.id && !p.archived);
  const risky = projs.filter(p => ["at_risk", "blocked"].includes((state.healthById.get(p.id) || {}).effective_status)).length;
  const mem = membersOf(w.id);
  const fu = state.followUps.filter(f => f.workspace_id === w.id && ["open", "escalated"].includes(f.status)).length;
  return `<a class="ws-card" href="#/w/${w.id}" style="--c:${esc(w.color)}">
    <div class="ws-top"><h3>${esc(w.name)}</h3>${mem.length > 1 ? `<span class="avstack">${mem.slice(0, 4).map(m => avatar(m.user_id, "sm")).join("")}</span>` : ""}</div>
    <p class="ws-kind">${esc({ business: "Business", professional: "Professional", personal: "Personal & family", other: "Other" }[w.kind] || "")}${roleIn(w.id) !== "owner" ? ` · ${roleIn(w.id) === "viewer" ? "view only" : "shared with you"}` : ""}</p>
    <div class="ws-nums"><span><b class="num">${open.length}</b> open</span><span><b class="num">${projs.length}</b> projects</span><span><b class="num">${fu}</b> follow-ups</span></div>
    ${od || bl || risky ? `<div class="ws-flags">${od ? `<span class="flag bad">${od} overdue</span>` : ""}${bl ? `<span class="flag bad">${bl} blocked</span>` : ""}${risky ? `<span class="flag warn">${risky} project${risky > 1 ? "s" : ""} need attention</span>` : ""}</div>` : `<div class="ws-flags"><span class="flag ok">Nothing overdue</span></div>`}
  </a>`;
}

export function renderWorkspace(view, id, tab = "projects") {
  const w = wsById(id);
  if (!w) { view.innerHTML = emptyState("Workspace not found", "It may have been deleted, or you no longer have access.", `<a class="btn" href="#/workspaces">All workspaces</a>`); return; }
  const writable = canWrite(id);
  const projs = state.projects.filter(p => p.workspace_id === id);
  const ts = state.tasks.filter(t => t.workspace_id === id && !t.deleted_at);
  const fus = state.followUps.filter(f => f.workspace_id === id);
  const contacts = state.contacts.filter(c => c.workspace_id === id);
  const tabs = { projects: `Projects · ${projs.filter(p => !p.archived).length}`, tasks: `Tasks · ${ts.filter(isOpen).length}`, followups: `Follow-ups · ${fus.filter(f => ["open", "escalated"].includes(f.status)).length}`, contacts: `Contacts · ${contacts.length}`, knowledge: `Notes & docs · ${state.notes.filter(n => n.workspace_id === id).length + state.documents.filter(d => d.workspace_id === id).length}`, activity: "Activity" };
  let body = "";
  if (tab === "projects") {
    const active = projs.filter(p => !p.archived);
    body = (writable ? `<div class="toolbar"><button class="btn primary" data-act="new-project" data-ws="${id}">${ICON.plus}New project</button></div>` : "") +
      (active.length ? `<div class="ph-list">${active.map(phRow).join("")}</div>` : emptyState("No projects yet", "Group related tasks and milestones into a project to track progress and health.")) +
      (projs.some(p => p.archived) ? section("Archived", `<div class="ph-list">${projs.filter(p => p.archived).map(phRow).join("")}</div>`) : "");
  } else if (tab === "tasks") {
    const open = sortTasks(ts.filter(t => isOpen(t) && !t.parent_id));
    const noProj = open.filter(t => !t.project_id);
    body = (writable ? `<div class="toolbar"><button class="btn primary" data-act="capture" data-ws="${id}">${ICON.plus}New task</button><a class="btn" href="#/tasks/all" data-act="filter-ws" data-ws="${id}">Open in My Tasks</a></div>` : "") +
      (open.length ? `<div class="list">${open.map(t => taskRow(t, { showWs: false })).join("")}</div>` : emptyState("No open tasks", "")) +
      (noProj.length && projs.length ? `<p class="hint">${noProj.length} task(s) aren't linked to a project.</p>` : "");
  } else if (tab === "followups") {
    const openF = fus.filter(f => ["open", "escalated"].includes(f.status));
    body = (writable ? `<div class="toolbar"><button class="btn primary" data-act="new-followup" data-ws="${id}">${ICON.plus}New follow-up</button></div>` : "") +
      (openF.length ? `<div class="list">${openF.map(fuLine).join("")}</div>` : emptyState("No open follow-ups", "Track commitments: who owes you what, and by when."));
  } else if (tab === "knowledge") {
    const ns = state.notes.filter(n => n.workspace_id === id), ds = state.documents.filter(d => d.workspace_id === id);
    body = (writable ? `<div class="toolbar"><button class="btn primary" data-act="new-note" data-ws="${id}">${ICON.plus}New note</button><button class="btn" data-act="new-note" data-kind="meeting" data-ws="${id}">Meeting notes</button><button class="btn" data-act="new-note" data-kind="decision" data-ws="${id}">Decision</button><button class="btn" data-act="upload-doc" data-ws="${id}">${ICON.download}Upload</button></div>` : "") +
      (ns.length ? section("Notes", `<div class="list">${ns.slice(0, 50).map(n => `<div class="trow" data-act="open-note" data-id="${n.id}" role="button" tabindex="0"><span class="kico">${ICON.notes}</span><div class="tmain"><div class="ttitle">${esc(n.title)}</div><div class="tmeta">${NOTE_KIND[n.kind]} · ${ago(n.updated_at)}</div></div></div>`).join("")}</div>`, { count: ns.length }) : "") +
      (ds.length ? section("Documents", `<div class="list">${ds.slice(0, 50).map(d => `<div class="trow" data-act="open-doc" data-id="${d.id}" role="button" tabindex="0"><span class="kico">${d.kind === "link" ? ICON.link : ICON.download}</span><div class="tmain"><div class="ttitle">${esc(d.title)}</div><div class="tmeta">${DOC_CATEGORY[d.category]} · ${ago(d.created_at)}</div></div></div>`).join("")}</div>`, { count: ds.length }) : "") +
      (!ns.length && !ds.length ? emptyState("No notes or documents yet", "Keep meeting notes, decisions, invoices and certificates for this workspace in one place.") : "");
  } else if (tab === "activity") {
    const cached = wsActivity.get(id);
    if (!cached || Date.now() - (wsActivityAt.get(id) || 0) > 60000) { wsActivityAt.set(id, Date.now()); loadWsActivity(id); }
    body = cached ? (cached.length ? `<ul class="feed">${cached.map(actRow).join("")}</ul><p class="hint">Latest ${cached.length} changes. The audit log is append-only.</p>` : `<p class="calm">No activity recorded yet.</p>`) : `<div class="loading"><div class="spinner"></div>Loading activity…</div>`;
  } else {
    body = (writable ? `<div class="toolbar"><button class="btn primary" data-act="new-contact" data-ws="${id}">${ICON.plus}New contact</button></div>` : "") +
      (contacts.length ? `<div class="clist">${contacts.map(c => `<button class="cline" data-act="open-contact" data-id="${c.id}"><span class="av" style="--h:${(c.name.charCodeAt(0) * 37) % 360}">${esc(c.name[0].toUpperCase())}</span><span class="tmain"><span class="ttitle">${esc(c.name)}</span><span class="tmeta">${esc(c.organisation || "")}${c.email ? " · " + esc(c.email) : ""}</span></span><span class="kind">${esc(c.kind)}</span></button>`).join("")}</div>` :
        emptyState("No contacts yet", "Add suppliers, customers, partners and colleagues to link them to tasks and follow-ups."));
  }
  view.innerHTML = `<div class="page-head ws-head" style="--c:${esc(w.color)}"><div><p class="crumb"><a href="#/workspaces">Workspaces</a></p><h1>${wsDot(w)}${esc(w.name)}</h1>${w.description ? `<p class="sub">${esc(w.description)}</p>` : ""}</div>
    <div class="filters"><span class="avstack">${membersOf(id).slice(0, 5).map(m => avatar(m.user_id, "sm")).join("")}</span><button class="btn sm" data-act="edit-workspace" data-id="${id}">${ICON.people}${isWsOwner(id) ? "People & settings" : "People"}</button></div></div>
    <div class="viewtabs">${Object.entries(tabs).map(([k, v]) => `<a href="#/w/${id}/${k}" class="${k === tab ? "on" : ""}">${v}</a>`).join("")}</div>
    ${body}`;
}

const wsActivity = new Map(), wsActivityAt = new Map();
async function loadWsActivity(id) {
  const r = await run(sb.from("activity").select("*").eq("workspace_id", id).order("created_at", { ascending: false }).limit(200));
  wsActivity.set(id, r.data || []);
  if (r.error) wsActivity.delete(id);
  wsActivityAt.set(id, Date.now());
  if (state.route.name === "w" && state.route.a === id && state.route.b === "activity") emit("data");
}
export const clearWsActivity = () => wsActivity.clear();

export function fuLine(f) {
  const c = contactById(f.contact_id), today = todayISO(state.tz);
  const due = f.next_follow_up_at && new Date(f.next_follow_up_at) <= new Date();
  const late = f.expected_at && f.expected_at < today && ["open", "escalated"].includes(f.status);
  return `<div class="trow fu ${["closed", "cancelled"].includes(f.status) ? "closed" : ""}" data-act="open-followup" data-id="${f.id}" role="button" tabindex="0"><span class="fu-ico">${ICON.phone}</span>
    <div class="tmain"><div class="ttitle">${esc(f.subject)}</div><div class="tmeta"><span>${f.direction === "they_owe" ? "Awaiting" : "You owe"} · <b>${esc(c ? c.name : f.counterpart || "")}</b></span>${f.last_contact_at ? `<span>last contact ${fmtDate(f.last_contact_at, { day: "numeric", month: "short" })}</span>` : ""}${f.expected_at ? `<span class="${late ? "bad-text" : ""}">expected ${fmtDate(f.expected_at, { day: "numeric", month: "short" })}</span>` : ""}</div></div>
    <div class="tside">${f.status === "escalated" ? `<span class="pill s-blocked">Escalated</span>` : f.status === "closed" ? `<span class="pill s-completed">Closed</span>` : due ? `<span class="pill s-waiting">Follow up now</span>` : f.next_follow_up_at ? `<span class="due">${fmtDate(f.next_follow_up_at.slice(0, 10), { day: "numeric", month: "short" })}</span>` : ""}</div></div>`;
}

export function renderProject(view, id) {
  const p = projectById(id);
  if (!p) { view.innerHTML = emptyState("Project not found", "It may have been deleted.", `<a class="btn" href="#/workspaces">Workspaces</a>`); return; }
  const w = wsById(p.workspace_id), h = state.healthById.get(id) || {}, writable = canWrite(p.workspace_id), tz = state.tz;
  const ms = state.milestones.filter(m => m.project_id === id).sort((a, b) => (a.planned_date || "9999").localeCompare(b.planned_date || "9999") || a.sort - b.sort);
  const ts = state.tasks.filter(t => t.project_id === id && !t.deleted_at);
  const open = sortTasks(ts.filter(t => isOpen(t) && !t.parent_id)), done = sortTasks(ts.filter(t => isClosed(t) && !t.parent_id));
  const risks = ts.filter(t => isOpen(t) && (t.status === "blocked" || isOverdue(t)));
  const depFails = ts.filter(t => isOpen(t) && overduePrerequisites(t, state.deps, state.taskById).length);
  const fus = state.followUps.filter(f => f.project_id === id && ["open", "escalated"].includes(f.status));
  const pct = h.progress ?? null;
  view.innerHTML = `
  <div class="page-head"><div><p class="crumb"><a href="#/workspaces">Workspaces</a> / <a href="#/w/${w.id}">${esc(w.name)}</a></p><h1>${esc(p.name)}</h1>${p.description ? `<p class="sub">${esc(p.description)}</p>` : ""}</div>
    <div class="filters">${writable ? `<button class="btn sm" data-act="edit-project" data-id="${id}">${ICON.settings}Project settings</button>` : ""}</div></div>
  <section class="proj-hero">
    <div class="ph-col"><span class="k">Status</span><div>${projectPill(h.effective_status || "on_track")}</div>${p.manual_status ? `<span class="calc-note">Manual: “${esc(p.manual_status_reason || "")}” · calculated ${PROJECT_STATUS_LABEL[h.calculated_status] || ""}</span>` : h.reasons && h.reasons.length ? `<span class="calc-note">${esc(h.reasons.join(" · "))}</span>` : ""}</div>
    <div class="ph-col"><span class="k">Progress</span><div class="ph-bar big"><div class="bar"><i style="width:${pct || 0}%"></i></div><b class="num">${pct === null ? "—" : pct + "%"}</b></div><span class="calc-note">${h.progress_basis === "milestones" ? "weighted by completed milestones" : h.progress_basis === "tasks" ? "share of completed top-level tasks" : "add milestones or tasks to measure progress"}</span></div>
    <div class="ph-col"><span class="k">Next milestone</span><div>${h.next_milestone_title ? `${esc(h.next_milestone_title)}${h.next_milestone_date ? ` <span class="num">· ${fmtDate(h.next_milestone_date)}</span>` : ""}` : "—"}</div></div>
    <div class="ph-col"><span class="k">Owner · dates</span><div>${esc(nameOf(p.owner_id))}</div><span class="calc-note">${p.start_date ? fmtDate(p.start_date) : "no start"} → ${p.target_date ? fmtDate(p.target_date) : "no target"}${p.budget ? ` · budget ${esc(p.budget_currency || "")} ${Number(p.budget).toLocaleString("en-US")}` : ""}</span>
      ${p.baselined_at ? `<span class="calc-note">Baseline ${p.baseline_target_date ? fmtDate(p.baseline_target_date) : "—"}${slipText(p.baseline_target_date, p.target_date)}</span>` : ""}</div>
  </section>
  ${p.next_action ? `<div class="banner info"><b>Next required action:</b> ${esc(p.next_action)}</div>` : ""}
  ${risks.length || depFails.length ? section("Risks & blockers", `<div class="list">${[...new Set([...risks, ...depFails])].map(t => taskRow(t, { showWs: false })).join("")}</div>`, { count: risks.length + depFails.length, cls: "risk" }) : ""}
  <div class="grid-2">
    ${section("Milestones", `${ms.length ? `<ol class="mslist">${ms.map(m => msRow(m, writable)).join("")}</ol>` : `<p class="calm">No milestones. Add the key stages, for example Purchase order → Production → Material readiness → Dispatch → Shipping → Customs clearance → Site delivery.</p>`}
      ${writable ? `<button class="btn sm" data-act="new-milestone" data-project="${id}">${ICON.plus}Add milestone</button>` : ""}`, { count: ms.length })}
    ${section("Follow-ups", `${fus.length ? `<div class="list compact">${fus.map(fuLine).join("")}</div>` : `<p class="calm">No open follow-ups linked to this project.</p>`}
      ${writable ? `<button class="btn sm" data-act="new-followup" data-ws="${w.id}" data-project="${id}">${ICON.plus}New follow-up</button>` : ""}`, { count: fus.length })}
  </div>
  ${scheduleSection(p, ms, writable)}
  ${section("Open tasks", `${open.length ? `<div class="list">${open.map(t => taskRow(t, { showWs: false })).join("")}</div>` : `<p class="calm">No open tasks.</p>`}
    ${writable ? `<button class="btn sm" data-act="capture" data-ws="${w.id}" data-project="${id}">${ICON.plus}Add task</button>` : ""}`, { count: open.length })}
  ${linkedPanel("project", id, p.workspace_id)}
  ${done.length ? section("Completed", `<div class="list">${done.slice(0, 15).map(t => taskRow(t, { showWs: false })).join("")}</div>`, { count: done.length }) : ""}`;
}

const dayDiff = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
function slipText(base, cur) {
  if (!base || !cur) return "";
  const d = dayDiff(base, cur);
  return d > 0 ? ` · <span class="bad-text">slipped ${d}d</span>` : d < 0 ? ` · <span class="ok-text">${-d}d ahead</span>` : " · on baseline";
}
const FIELD_NAME = { start_date: "Start", target_date: "Target", planned_date: "Milestone", baseline: "Re-baseline" };
function scheduleSection(p, ms, writable) {
  const cache = (state.ui.sched = state.ui.sched || {});
  if (p.baselined_at && cache[p.id] === undefined) {
    cache[p.id] = null;
    sb.from("schedule_revisions").select("*").eq("project_id", p.id).order("revised_at", { ascending: false }).limit(100).then(({ data }) => { cache[p.id] = data || []; emit("data"); });
  }
  const revs = cache[p.id] || [];
  const msName = id => (ms.find(m => m.id === id) || {}).title || "milestone";
  if (!p.baselined_at) return section("Schedule baseline", `<p class="calm">No baseline yet. Setting one freezes today's start, target and milestone dates as the original plan, so later changes are measured against it and each change needs a reason.</p>
    ${writable ? `<button class="btn sm" data-act="set-baseline" data-id="${p.id}">Set baseline</button>` : ""}`);
  const slipped = ms.filter(m => m.baseline_date && (m.actual_date || m.planned_date) && dayDiff(m.baseline_date, m.actual_date || m.planned_date) > 0);
  return section("Schedule baseline", `<p class="calm">Baselined ${fmtDate(p.baselined_at.slice(0, 10))} by ${esc(nameOf(p.baselined_by))}. Target: baseline ${p.baseline_target_date ? fmtDate(p.baseline_target_date) : "—"} → now ${p.target_date ? fmtDate(p.target_date) : "—"}${slipText(p.baseline_target_date, p.target_date)}.
    ${slipped.length ? ` ${slipped.length} milestone${slipped.length > 1 ? "s" : ""} behind baseline.` : ""}</p>
    ${revs.length ? `<div class="tablewrap"><table class="rtable"><thead><tr><th>When</th><th>What</th><th>From → to</th><th>Reason</th><th>By</th></tr></thead><tbody>
      ${revs.map(r => `<tr><td>${fmtDate(r.revised_at.slice(0, 10))}</td><td>${FIELD_NAME[r.field]}${r.milestone_id ? ": " + esc(msName(r.milestone_id)) : ""}</td><td class="num">${r.old_date ? fmtDate(r.old_date) : "—"} → ${r.new_date ? fmtDate(r.new_date) : "—"}${r.field !== "baseline" ? slipText(r.old_date, r.new_date) : ""}</td><td>${esc(r.reason)}</td><td>${esc(nameOf(r.revised_by))}</td></tr>`).join("")}</tbody></table></div>`
      : cache[p.id] === null ? `<p class="hint">Loading revisions…</p>` : `<p class="hint">No date changes since the baseline.</p>`}
    ${writable ? `<button class="btn sm" data-act="set-baseline" data-id="${p.id}">Re-baseline…</button>` : ""}`, { count: revs.length });
}

function msRow(m, writable) {
  const v = milestoneVariance(m, state.tz), late = !m.actual_date && v;
  return `<li class="ms ${m.actual_date ? "done" : late ? "late" : ""}" ${writable ? `data-act="edit-milestone" data-id="${m.id}" role="button" tabindex="0"` : ""}>
    <span class="ms-dot">${m.actual_date ? ICON.check : ICON.milestone}</span>
    <div class="tmain"><div class="ttitle">${esc(m.title)}${m.is_critical ? ` <span class="pill s-blocked">Critical</span>` : ""}</div>
      <div class="tmeta"><span>Planned ${m.planned_date ? fmtDate(m.planned_date) : "—"}</span><span>Actual ${m.actual_date ? fmtDate(m.actual_date) : "—"}</span>${m.baseline_date && m.baseline_date !== m.planned_date ? `<span>Baseline ${fmtDate(m.baseline_date)}</span>` : ""}${v !== null ? `<span class="${v > 0 ? "bad-text" : "ok-text"}">${m.actual_date ? (v > 0 ? `${v}d late` : v < 0 ? `${-v}d early` : "on time") : `${v}d overdue`}</span>` : ""}${Number(m.weight) !== 1 ? `<span>weight ${m.weight}</span>` : ""}</div></div></li>`;
}
