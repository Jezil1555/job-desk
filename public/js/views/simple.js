// Simple work screens (monday.com style): Home → Workspace dashboard → Project board.
// Model: workspace → project (one job) → tasks → steps (small milestones, each with a status and a responsible person).
import { esc, fmtDate, todayISO, daysFromToday, ago } from "../util.js";
import { state, emit, wsById, projectById, canWrite, isWsOwner, activeWorkspaces, nameOf } from "../store.js";
import { ICON, emptyState, toast, toastError, dialog, openSheet, sheetHead, closeSheet, busy } from "../ui.js";
import { sb, run, reindex, reopenTask, updateTask } from "../api.js";

const PRIO = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
const today = () => todayISO(state.tz);

/* ---------- derived state ---------- */
export const stepsOf = taskId => (state.steps || []).filter(s => s.task_id === taskId).sort((a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at));
const tasksOf = pid => state.tasks.filter(t => t.project_id === pid && !t.deleted_at && !t.parent_id && t.status !== "cancelled").sort((a, b) => (a.sort - b.sort) || a.created_at.localeCompare(b.created_at));
const projectsIn = wsId => state.projects.filter(p => p.workspace_id === wsId && !p.archived);
const isClosedP = p => !!p.closed_at;

export function taskDone(t) {
  if (t.status === "completed") return true;
  const st = stepsOf(t.id);
  return st.length > 0 && st.every(s => s.status === "done");
}
function projectStats(p) {
  const ts = tasksOf(p.id);
  let total = 0, done = 0;
  const pending = [];
  for (const t of ts) {
    const st = stepsOf(t.id);
    if (st.length) { total += st.length; done += st.filter(s => s.status === "done").length; st.filter(s => s.status !== "done").forEach(s => pending.push({ s, t })); }
    else { total += 1; if (taskDone(t)) done += 1; else pending.push({ s: null, t }); }
  }
  const pct = total ? Math.round(done / total * 100) : 0;
  const daysLeft = p.target_date ? daysFromToday(p.target_date, state.tz) : null;
  let status = "not_started";
  if (isClosedP(p)) status = "closed";
  else if (daysLeft !== null && daysLeft < 0) status = "overdue";
  else if (total && done === total) status = "ready";
  else if (done > 0) status = "working";
  return { ts, total, done, pct, pending, next: pending[0] || null, daysLeft, status };
}
const STATUS = { closed: "Closed", overdue: "Overdue", ready: "Ready to close", working: "Working on it", not_started: "Not started" };
const statusPill = s => `<span class="sw-pill st-${s}">${STATUS[s]}</span>`;
const prioPill = p => `<span class="sw-pill pr-${p}">${PRIO[p] || p}</span>`;
function deadlineText(p, daysLeft) {
  if (!p.target_date) return `<span class="faint">No deadline</span>`;
  const d = fmtDate(p.target_date, { day: "numeric", month: "short", year: "numeric" });
  if (isClosedP(p)) return d;
  if (daysLeft < 0) return `${d} <small class="bad-text">${-daysLeft}d late</small>`;
  if (daysLeft === 0) return `${d} <small class="warn-text">today</small>`;
  if (daysLeft <= 7) return `${d} <small class="warn-text">${daysLeft}d left</small>`;
  return `${d} <small class="faint">${daysLeft}d left</small>`;
}
const bar = pct => `<span class="sw-bar" title="${pct}% done"><i style="width:${pct}%"></i></span><span class="num sw-pct">${pct}%</span>`;
const nextText = n => !n ? `<span class="faint">—</span>` : n.s ? `${esc(n.s.title)}${n.s.responsible ? ` <span class="sw-who">${esc(n.s.responsible)}</span>` : ""}` : `${esc(n.t.title)}`;

function wsCounts(wsId) {
  const ps = projectsIn(wsId);
  const open = ps.filter(p => !isClosedP(p));
  return {
    open: open.length, closed: ps.length - open.length,
    critical: open.filter(p => p.priority === "critical").length,
    overdue: open.filter(p => p.target_date && p.target_date < today()).length
  };
}

/* ---------- Home ---------- */
export function renderSimpleHome(view) {
  const wss = activeWorkspaces();
  const all = wss.map(w => ({ w, c: wsCounts(w.id) }));
  const sum = k => all.reduce((a, x) => a + x.c[k], 0);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: state.tz }).format(new Date()));
  const hello = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const first = (state.me.display_name || "").split(/\s+/)[0];
  // jobs that need attention across every workspace: overdue first, then nearest deadline, critical before others
  const attention = state.projects.filter(p => !p.archived && !isClosedP(p) && wss.some(w => w.id === p.workspace_id))
    .map(p => ({ p, s: projectStats(p) }))
    .filter(x => x.s.status === "overdue" || x.p.priority === "critical" || (x.s.daysLeft !== null && x.s.daysLeft <= 7))
    .sort((a, b) => (a.s.daysLeft ?? 9999) - (b.s.daysLeft ?? 9999) || (a.p.priority === "critical" ? -1 : 1))
    .slice(0, 8);
  view.innerHTML = `<div class="sw">
    <div class="sw-head"><div><h1>${hello}${first ? ", " + esc(first) : ""}</h1><p class="sub">${fmtDate(today(), { weekday: "long", day: "numeric", month: "long" })}</p></div></div>
    <div class="sw-kpis sw-hk">
      ${kpi("Workspaces", wss.length)}${kpi("Open projects", sum("open"))}${kpi("Closed projects", sum("closed"))}${kpi("Critical", sum("critical"), "crit")}${kpi("Overdue", sum("overdue"), "bad")}
    </div>
    ${attention.length ? `<section class="sw-sect"><h2>Needs attention</h2><div class="sw-table">${attention.map(x => projectRow(x.p, x.s, true)).join("")}</div></section>` : ""}
    <section class="sw-sect"><div class="sw-sect-h"><h2>Workspaces</h2><button class="btn sm" data-act="new-workspace">${ICON.plus}New workspace</button></div>
    <div class="sw-wsgrid">${all.map(({ w, c }) => `<a class="sw-ws" href="#/w/${w.id}" style="--c:${esc(w.color)}">
      <h3>${esc(w.name)}</h3>
      <div class="sw-ws-n"><span><b class="num">${c.open}</b>Open</span><span><b class="num">${c.closed}</b>Closed</span><span class="${c.critical ? "crit" : ""}"><b class="num">${c.critical}</b>Critical</span>${c.overdue ? `<span class="bad"><b class="num">${c.overdue}</b>Overdue</span>` : ""}</div>
    </a>`).join("")}</div></section>
  </div>`;
}
const kpi = (label, n, cls = "", act = "") => `<div class="sw-kpi ${cls}" ${act}><b class="num">${n}</b><span>${label}</span></div>`;

/* ---------- Workspace dashboard ---------- */
export function renderSimpleWorkspace(view, wsId) {
  const w = wsById(wsId);
  if (!w) { view.innerHTML = emptyState("Workspace not found", "It may have been deleted, or you no longer have access.", `<a class="btn" href="#/home">Home</a>`); return; }
  const f = (state.ui.wsFilter && state.ui.wsFilter.ws === wsId) ? state.ui.wsFilter.k : "open";
  const c = wsCounts(wsId), writable = canWrite(wsId);
  const rows = projectsIn(wsId).map(p => ({ p, s: projectStats(p) })).filter(({ p, s }) =>
    f === "all" ? true : f === "closed" ? isClosedP(p) : isClosedP(p) ? false : f === "critical" ? p.priority === "critical" : f === "overdue" ? s.status === "overdue" : true)
    .sort((a, b) => (isClosedP(a.p) - isClosedP(b.p)) || (a.p.priority === "critical" ? 0 : 1) - (b.p.priority === "critical" ? 0 : 1) || (a.s.daysLeft ?? 9999) - (b.s.daysLeft ?? 9999));
  const tile = (k, label, n, cls = "") => `<button class="sw-kpi ${cls} ${f === k ? "on" : ""}" data-act="sw-filter" data-ws="${wsId}" data-k="${k}"><b class="num">${n}</b><span>${label}</span></button>`;
  view.innerHTML = `<div class="sw">
    <div class="sw-head" style="--c:${esc(w.color)}"><div><p class="crumb"><a href="#/home">Home</a></p><h1><i class="dot" style="background:${esc(w.color)}"></i>${esc(w.name)}</h1><p class="sub">As of ${fmtDate(today(), { day: "numeric", month: "short", year: "numeric" })}</p></div>
      <div class="sw-actions">${writable ? `<button class="btn primary" data-act="sw-new-project" data-ws="${wsId}">${ICON.plus}New project</button>` : ""}<button class="btn" data-act="edit-workspace" data-id="${wsId}">${ICON.settings}Settings</button>${isWsOwner(wsId) ? `<button class="btn danger" data-act="ws-delete" data-id="${wsId}">${ICON.trash}Delete workspace</button>` : ""}</div></div>
    <div class="sw-kpis">${tile("open", "Open projects", c.open)}${tile("closed", "Closed projects", c.closed)}${tile("critical", "Critical", c.critical, "crit")}${tile("overdue", "Overdue", c.overdue, "bad")}</div>
    <section class="sw-sect"><div class="sw-sect-h"><h2>${{ open: "Open projects", closed: "Closed projects", critical: "Critical projects", overdue: "Overdue projects", all: "All projects" }[f]}</h2>${f !== "all" ? `<button class="linkbtn" data-act="sw-filter" data-ws="${wsId}" data-k="all">Show all</button>` : ""}</div>
    <div class="sw-table">
      <div class="sw-tr sw-th"><span>Project</span><span>Status</span><span>Priority</span><span>Deadline</span><span>Progress</span><span>Next step</span></div>
      ${rows.length ? rows.map(({ p, s }) => projectRow(p, s)).join("") : `<div class="sw-empty">${f === "open" ? "No open projects. Every job you're working on becomes a project." : "Nothing here."}</div>`}
      ${writable ? `<form class="sw-add" data-form="sw-add-project" data-ws="${wsId}"><span>${ICON.plus}</span><input class="input" name="name" placeholder="Add a project, e.g. Pending POs" maxlength="120" autocomplete="off"><button class="btn sm">Add</button></form>` : ""}
    </div></section>
    <p class="hint">Older screens for this workspace (follow-ups, contacts, notes): <a href="#/w/${wsId}/followups">open</a></p>
  </div>`;
}
function projectRow(p, s, showWs = false) {
  const w = wsById(p.workspace_id);
  return `<a class="sw-tr ${isClosedP(p) ? "closed" : ""}" href="#/p/${p.id}" style="--c:${esc((w || {}).color || "#999")}">
    <span class="sw-name"><b>${esc(p.name)}</b>${showWs && w ? `<small>${esc(w.name)}</small>` : ""}<small class="sw-count">${s.done}/${s.total} done</small></span>
    <span data-l="Status">${statusPill(s.status)}</span>
    <span data-l="Priority">${prioPill(p.priority)}</span>
    <span data-l="Deadline">${deadlineText(p, s.daysLeft)}</span>
    <span data-l="Progress" class="sw-prog">${bar(s.pct)}</span>
    <span data-l="Next" class="sw-next">${isClosedP(p) ? `<span class="faint">Closed ${p.closed_at ? fmtDate(p.closed_at.slice(0, 10), { day: "numeric", month: "short" }) : ""}</span>` : nextText(s.next)}</span>
  </a>`;
}

/* ---------- Project board ---------- */
export function renderSimpleProject(view, pid) {
  const p = projectById(pid);
  if (!p) { view.innerHTML = emptyState("Project not found", "It may have been deleted.", `<a class="btn" href="#/home">Home</a>`); return; }
  const w = wsById(p.workspace_id), s = projectStats(p), writable = canWrite(p.workspace_id);
  const open = state.ui.openTasks || (state.ui.openTasks = new Set());
  view.innerHTML = `<div class="sw">
    <div class="sw-head"><div><p class="crumb"><a href="#/home">Home</a> / <a href="#/w/${w.id}">${esc(w.name)}</a></p>
      <h1>${esc(p.name)}</h1>${p.description ? `<p class="sub">${esc(p.description)}</p>` : ""}</div>
      <div class="sw-actions">${writable ? (isClosedP(p) ? `<button class="btn" data-act="sw-reopen-project" data-id="${p.id}">Reopen project</button>` : `<button class="btn primary" data-act="sw-close-project" data-id="${p.id}">${ICON.check}Close project</button>`) + `<button class="btn" data-act="sw-edit-project" data-id="${p.id}">Edit</button><button class="btn danger" data-act="sw-delete-project" data-id="${p.id}">${ICON.trash}Delete</button>` : ""}</div></div>
    <div class="sw-kpis sw-pk">
      <div class="sw-kpi"><span>Status</span>${statusPill(s.status)}</div>
      <div class="sw-kpi"><span>Priority</span>${prioPill(p.priority)}</div>
      <div class="sw-kpi"><span>Deadline</span><b class="sw-dl">${deadlineText(p, s.daysLeft)}</b></div>
      <div class="sw-kpi"><span>Progress · ${s.done}/${s.total}</span><div class="sw-prog">${bar(s.pct)}</div></div>
    </div>
    <section class="sw-sect"><div class="sw-sect-h"><h2>Tasks <span class="c">${s.ts.length}</span></h2>${s.ts.length ? `<button class="linkbtn" data-act="sw-expand" data-id="${p.id}">${s.ts.every(t => open.has(t.id)) ? "Collapse all" : "Expand all"}</button>` : ""}</div>
      ${s.ts.map(t => taskGroup(t, open.has(t.id), writable)).join("") || `<div class="sw-empty">No tasks yet. Add each thing that has to be closed for this job, e.g. "Close PO-0586".</div>`}
      ${writable && !isClosedP(p) ? `<form class="sw-add sw-add-task" data-form="sw-add-task" data-project="${p.id}"><span>${ICON.plus}</span><input class="input" name="title" placeholder="Add a task, e.g. Close PO-0586" maxlength="300" autocomplete="off"><input class="input sw-ref" name="ref" placeholder="Ref (PO / invoice no.)" maxlength="60" autocomplete="off"><button class="btn sm">Add task</button></form>` : ""}
    </section>
  </div>`;
}
function taskGroup(t, isOpen, writable) {
  const st = stepsOf(t.id), done = taskDone(t), n = st.filter(s => s.status === "done").length;
  const pending = st.find(s => s.status !== "done");
  return `<div class="sw-task ${done ? "done" : ""} ${isOpen ? "open" : ""}">
    <div class="sw-task-h" data-act="sw-toggle-task" data-id="${t.id}" role="button" tabindex="0">
      <span class="sw-chev">${ICON.chevron}</span>
      <span class="sw-tt"><b>${esc(t.title)}</b>${t.reference ? `<small class="num">${esc(t.reference)}</small>` : ""}</span>
      <span class="sw-tmeta">${!isOpen && pending ? `<span class="sw-next">${esc(pending.title)}${pending.responsible ? ` <span class="sw-who">${esc(pending.responsible)}</span>` : ""}</span>` : ""}
        ${st.length ? `<span class="num faint">${n}/${st.length}</span>` : ""}<span class="sw-pill ${done ? "st-ready" : n ? "st-working" : "st-not_started"}">${done ? "Done" : n ? "In progress" : "Pending"}</span></span>
      ${writable ? `<button class="iconbtn sm" data-act="sw-task-menu" data-id="${t.id}" aria-label="Edit task" title="Edit task">${ICON.more}</button><button class="iconbtn sm sw-del" data-act="sw-task-delete" data-id="${t.id}" aria-label="Delete task" title="Delete task">${ICON.trash}</button>` : ""}
    </div>
    ${isOpen ? `<div class="sw-steps">
      ${st.map(s => `<div class="sw-step ${s.status}">
        <button class="sw-check ${s.status === "done" ? "on" : ""}" data-act="sw-step-toggle" data-id="${s.id}" ${writable ? "" : "disabled"} aria-label="${s.status === "done" ? "Mark pending" : "Mark done"}">${s.status === "done" ? ICON.check : ""}</button>
        <span class="sw-st" ${writable ? `data-act="sw-step-edit" data-id="${s.id}" role="button" tabindex="0"` : ""}>${esc(s.title)}${s.note ? `<small>${esc(s.note)}</small>` : ""}</span>
        <span class="sw-who-c" ${writable ? `data-act="sw-step-who" data-id="${s.id}" role="button" tabindex="0"` : ""}>${s.responsible ? `<span class="sw-who">${esc(s.responsible)}</span>` : `<span class="faint">+ person</span>`}</span>
        <span class="sw-pill ${s.status === "done" ? "st-ready" : "st-overdue-soft"}">${s.status === "done" ? "Done" : "Pending"}</span>
        ${writable ? `<button class="iconbtn sm sw-del" data-act="sw-step-delete" data-id="${s.id}" aria-label="Delete step" title="Delete step">${ICON.trash}</button>` : ""}
      </div>`).join("")}
      ${!st.length && !writable ? `<p class="hint">No steps.</p>` : ""}
      ${writable ? `<form class="sw-add sw-add-step" data-form="sw-add-step" data-task="${t.id}"><span>${ICON.plus}</span><input class="input" name="title" placeholder="Add a step, e.g. Waiting for shipment arrival" maxlength="300" autocomplete="off"><input class="input sw-ref" name="who" placeholder="Responsible" maxlength="80" list="sw-people" autocomplete="off"><button class="btn sm">Add</button></form>${peopleList()}` : ""}
    </div>` : ""}
  </div>`;
}
function peopleList() {
  const names = new Set();
  (state.steps || []).forEach(s => s.responsible && names.add(s.responsible));
  Object.values(state.profiles).forEach(p => p.display_name && names.add(p.display_name));
  return `<datalist id="sw-people">${[...names].sort().map(n => `<option value="${esc(n)}">`).join("")}</datalist>`;
}

/* ---------- writes ---------- */
const refresh = () => { reindex(); emit("data"); };
function upsertStep(row) { const i = state.steps.findIndex(s => s.id === row.id); if (i >= 0) state.steps[i] = row; else state.steps.push(row); refresh(); }

async function addProject(wsId, name) {
  const r = await run(sb.from("projects").insert({ workspace_id: wsId, name, priority: "medium" }).select().single());
  if (r.error) return toastError(r.error);
  state.projects.push(r.data); refresh();
  location.hash = "#/p/" + r.data.id;
}
async function addTask(pid, title, ref) {
  const p = projectById(pid);
  const max = Math.max(0, ...tasksOf(pid).map(t => Number(t.sort) || 0));
  const r = await run(sb.from("tasks").insert({ workspace_id: p.workspace_id, project_id: pid, title, reference: ref || null, status: "not_started", priority: p.priority === "critical" ? "critical" : "medium", owner_id: state.user.id, sort: max + 1 }).select().single());
  if (r.error) return toastError(r.error);
  state.tasks.push(r.data); state.ui.openTasks.add(r.data.id); refresh();
  setTimeout(() => { const i = document.querySelector(`[data-form="sw-add-step"][data-task="${r.data.id}"] input[name=title]`); if (i) i.focus(); }, 30);
}
async function addStep(taskId, title, who) {
  const t = state.taskById.get(taskId);
  const max = Math.max(0, ...stepsOf(taskId).map(s => s.sort));
  const r = await run(sb.from("task_steps").insert({ task_id: taskId, workspace_id: t.workspace_id, title, responsible: who || null, sort: max + 1 }).select().single());
  if (r.error) return toastError(r.error);
  upsertStep(r.data);
  setTimeout(() => { const i = document.querySelector(`[data-form="sw-add-step"][data-task="${taskId}"] input[name=title]`); if (i) i.focus(); }, 30);
}
async function patchStep(id, fields) {
  const r = await run(sb.from("task_steps").update(fields).eq("id", id).select().single());
  if (r.error) { toastError(r.error); return false; }
  upsertStep(r.data); return true;
}

export async function handleSimpleSubmit(form) {
  const kind = form.dataset.form;
  if (!kind || !kind.startsWith("sw-")) return false;
  const btn = form.querySelector("button");
  const v = n => (form.elements[n] ? form.elements[n].value.trim() : "");
  if (kind === "sw-add-project") { if (!v("name")) return true; busy(btn); await addProject(form.dataset.ws, v("name")); busy(btn, false); }
  if (kind === "sw-add-task") { if (!v("title")) return true; busy(btn); await addTask(form.dataset.project, v("title"), v("ref")); busy(btn, false); }
  if (kind === "sw-add-step") { if (!v("title")) return true; busy(btn); await addStep(form.dataset.task, v("title"), v("who")); busy(btn, false); }
  if (kind === "sw-project") { busy(btn); await saveProject(form); busy(btn, false); }
  return true;
}

export async function handleSimpleClick(act, el) {
  if (!act.startsWith("sw-")) return false;
  const id = el.dataset.id;
  switch (act) {
    case "sw-filter": state.ui.wsFilter = { ws: el.dataset.ws, k: el.dataset.k }; emit("data"); break;
    case "sw-toggle-task": { const o = state.ui.openTasks || (state.ui.openTasks = new Set()); o.has(id) ? o.delete(id) : o.add(id); emit("data"); break; }
    case "sw-expand": { const ts = tasksOf(id), o = state.ui.openTasks; if (ts.every(t => o.has(t.id))) ts.forEach(t => o.delete(t.id)); else ts.forEach(t => o.add(t.id)); emit("data"); break; }
    case "sw-step-toggle": { const s = state.steps.find(x => x.id === id); if (s) await patchStep(id, { status: s.status === "done" ? "pending" : "done" }); break; }
    case "sw-step-who": { const s = state.steps.find(x => x.id === id); const v = await dialog({ title: "Responsible person", input: { label: "Name", placeholder: "e.g. Shahul" }, confirm: "Save" }); if (v !== null && s) await patchStep(id, { responsible: v || null }); break; }
    case "sw-step-edit": await stepMenu(id); break;
    case "sw-task-menu": await taskMenu(id); break;
    case "sw-new-project": { const v = await dialog({ title: "New project", text: "Each job is a project, e.g. Pending POs or Riyadh suite.", input: { label: "Project name", required: true }, confirm: "Create" }); if (v) await addProject(el.dataset.ws, v); break; }
    case "sw-edit-project": openProjectSheet(id); break;
    case "sw-close-project": { const p = projectById(id), s = projectStats(p); const ok = await dialog({ title: "Close this project?", text: s.done < s.total ? `${s.total - s.done} item(s) are still pending. You can reopen it later.` : "It will move to Closed projects. You can reopen it later.", confirm: "Close project" }); if (ok) await setClosed(id, true); break; }
    case "sw-reopen-project": await setClosed(id, false); break;
    case "sw-delete-project": await deleteProject(id); break;
    case "sw-task-delete": await deleteTask(id); break;
    case "sw-step-delete": await deleteStep(id); break;
  }
  return true;
}
async function setClosed(id, closed) {
  const r = await run(sb.from("projects").update({ closed_at: closed ? new Date().toISOString() : null, closed_by: closed ? state.user.id : null }).eq("id", id).select().single());
  if (r.error) return toastError(r.error);
  const i = state.projects.findIndex(p => p.id === id); state.projects[i] = r.data; refresh();
  toast(closed ? "Project closed" : "Project reopened");
}
async function stepMenu(id) {
  const s = state.steps.find(x => x.id === id); if (!s) return;
  openSheet(sh => {
    sh.innerHTML = sheetHead("Step") + `<form class="sh-body" id="swStepForm">
      <label class="field"><span>Step</span><input class="input" name="title" value="${esc(s.title)}" maxlength="300" required></label>
      <label class="field"><span>Responsible person</span><input class="input" name="who" value="${esc(s.responsible || "")}" maxlength="80" list="sw-people2">${peopleList().replace('id="sw-people"', 'id="sw-people2"')}</label>
      <label class="field"><span>Status</span><select class="input" name="status"><option value="pending" ${s.status !== "done" ? "selected" : ""}>Pending</option><option value="done" ${s.status === "done" ? "selected" : ""}>Done</option></select></label>
      <label class="field"><span>Note (optional)</span><textarea class="input" name="note" rows="3" maxlength="2000">${esc(s.note || "")}</textarea></label>
      <div class="sheet-foot"><button type="button" class="btn danger" id="swStepDel">${ICON.trash}Delete</button><button class="btn primary block">Save</button></div></form>`;
    sh.querySelector("#swStepForm").onsubmit = async e => {
      e.preventDefault(); e.stopPropagation();
      const f = e.target, b = f.querySelector(".primary"); busy(b);
      const ok = await patchStep(id, { title: f.title.value.trim(), responsible: f.who.value.trim() || null, status: f.status.value, note: f.note.value.trim() || null });
      busy(b, false); if (ok) closeSheet();
    };
    sh.querySelector("#swStepDel").onclick = async () => { if (await deleteStep(id)) closeSheet(); };
  });
}
async function taskMenu(id) {
  const t = state.taskById.get(id); if (!t) return;
  const st = stepsOf(id);
  openSheet(sh => {
    sh.innerHTML = sheetHead("Task") + `<form class="sh-body" id="swTaskForm">
      <label class="field"><span>Task</span><input class="input" name="title" value="${esc(t.title)}" maxlength="300" required></label>
      <label class="field"><span>Reference (PO / invoice no.)</span><input class="input" name="ref" value="${esc(t.reference || "")}" maxlength="60"></label>
      <label class="field"><span>Notes</span><textarea class="input" name="desc" rows="3">${esc(t.description || "")}</textarea></label>
      ${!st.length ? `<label class="check"><input type="checkbox" name="done" ${t.status === "completed" ? "checked" : ""}> Task is done</label>` : `<p class="hint">This task is done when all its ${st.length} steps are done.</p>`}
      <div class="sheet-foot"><button type="button" class="btn danger" id="swTaskDel">${ICON.trash}Delete</button><button class="btn primary block">Save</button></div></form>`;
    sh.querySelector("#swTaskForm").onsubmit = async e => {
      e.preventDefault(); e.stopPropagation();
      const f = e.target, b = f.querySelector(".primary"); busy(b);
      let r = await updateTask(id, { title: f.title.value.trim(), reference: f.ref.value.trim() || null, description: f.desc.value.trim() || null });
      if (!r.error && f.done) {
        if (f.done.checked && t.status !== "completed") r = await updateTask(id, { status: "completed" });
        else if (!f.done.checked && t.status === "completed") r = await reopenTask(id, "Reopened from project board", "not_started");
      }
      busy(b, false);
      if (r.error) return toastError(r.error);
      closeSheet();
    };
    sh.querySelector("#swTaskDel").onclick = async () => { if (await deleteTask(id)) closeSheet(); };
  });
}
function openProjectSheet(id) {
  const p = projectById(id); if (!p) return;
  openSheet(sh => {
    sh.innerHTML = sheetHead("Edit project") + `<form class="sh-body" data-form="sw-project" data-id="${id}">
      <label class="field"><span>Project name</span><input class="input" name="name" value="${esc(p.name)}" maxlength="120" required></label>
      <div class="grid2">
        <label class="field"><span>Priority</span><select class="input" name="priority">${Object.entries(PRIO).map(([k, v]) => `<option value="${k}" ${p.priority === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        <label class="field"><span>Completion deadline</span><input class="input" type="date" name="target" value="${p.target_date || ""}"></label>
      </div>
      <label class="field"><span>Description (optional)</span><textarea class="input" name="desc" rows="3">${esc(p.description || "")}</textarea></label>
      <div class="sheet-foot"><button type="button" class="btn danger" data-act="sw-delete-project" data-id="${id}">${ICON.trash}Delete</button><button class="btn primary block">Save</button></div></form>`;
  });
}
async function saveProject(form) {
  const id = form.dataset.id, f = form.elements;
  const target = f.target.value || null, p = projectById(id);
  const patch = { name: f.name.value.trim(), priority: f.priority.value, target_date: target, description: f.desc.value.trim() || null };
  if (target && p.start_date && target < p.start_date) patch.start_date = null;
  const r = await run(sb.from("projects").update(patch).eq("id", id).select().single());
  if (r.error) return toastError(r.error);
  const i = state.projects.findIndex(x => x.id === id); state.projects[i] = r.data; refresh(); closeSheet();
}
async function deleteStep(id) {
  const s = state.steps.find(x => x.id === id); if (!s) return false;
  if (!await dialog({ title: `Delete step "${s.title}"?`, text: "This can't be undone.", confirm: "Delete", danger: true })) return false;
  const r = await run(sb.from("task_steps").delete().eq("id", id));
  if (r.error) { toastError(r.error); return false; }
  state.steps = state.steps.filter(x => x.id !== id); refresh(); toast("Step deleted"); return true;
}
async function deleteTask(id) {
  const t = state.taskById.get(id); if (!t) return false;
  const n = stepsOf(id).length;
  if (!await dialog({ title: `Delete task "${t.title}"?`, text: n ? `Its ${n} step(s) will be deleted too. This can't be undone.` : "This can't be undone.", confirm: "Delete", danger: true })) return false;
  const r = await run(sb.from("tasks").delete().eq("id", id));
  if (r.error) { toastError(r.error); return false; }
  state.tasks = state.tasks.filter(x => x.id !== id); state.steps = state.steps.filter(s => s.task_id !== id); refresh(); toast("Task deleted"); return true;
}
async function deleteProject(id) {
  const p = projectById(id), n = tasksOf(id).length;
  if (!await dialog({ title: `Delete "${p.name}"?`, text: n ? `Its ${n} task(s) and their steps will be deleted too. This can't be undone. Closing the project keeps the history instead.` : "This can't be undone.", confirm: "Delete project", danger: true })) return;
  const ids = tasksOf(id).map(t => t.id);
  if (ids.length) { const r0 = await run(sb.from("tasks").delete().in("id", ids)); if (r0.error) return toastError(r0.error); }
  const r = await run(sb.from("projects").delete().eq("id", id));
  if (r.error) return toastError(r.error);
  state.projects = state.projects.filter(x => x.id !== id); state.tasks = state.tasks.filter(t => !ids.includes(t.id)); state.steps = state.steps.filter(s => !ids.includes(s.task_id));
  closeSheet(); refresh(); toast("Project deleted"); location.hash = "#/w/" + p.workspace_id;
}

/** Capture on the work screens: in a project → add a task; anywhere else outside Finance → new project. */
export async function simpleCapture() {
  const r = state.route || {};
  if (r.name === "finance" || r.name === "personal" || r.name === "notes" || r.name === "goals") return false;
  if (r.name === "p" && !r.b) {
    const i = document.querySelector('[data-form="sw-add-task"] input[name=title]');
    if (i) { i.scrollIntoView({ block: "center" }); i.focus(); return true; }
  }
  const wss = activeWorkspaces().filter(w => canWrite(w.id));
  if (!wss.length) return false;
  const pre = r.name === "w" ? r.a : r.name === "p" ? (projectById(r.a) || {}).workspace_id : null;
  openSheet(sh => {
    sh.innerHTML = sheetHead("New project", "Each job is a project. Add its tasks and steps next.") + `<form class="sh-body" id="swNewProj">
      <label class="field"><span>Workspace</span><select class="input" name="ws">${wss.map(w => `<option value="${w.id}" ${w.id === pre ? "selected" : ""}>${esc(w.name)}</option>`).join("")}</select></label>
      <label class="field"><span>Project name</span><input class="input" name="name" maxlength="120" required autofocus placeholder="e.g. Pending POs"></label>
      <div class="grid2"><label class="field"><span>Priority</span><select class="input" name="priority">${Object.entries(PRIO).map(([k, v]) => `<option value="${k}" ${k === "medium" ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      <label class="field"><span>Completion deadline</span><input class="input" type="date" name="target"></label></div>
      <div class="sheet-foot"><button class="btn primary block">Create project</button></div></form>`;
    sh.querySelector("#swNewProj").onsubmit = async e => {
      e.preventDefault(); e.stopPropagation();
      const f = e.target, b = f.querySelector(".primary"); busy(b);
      const res = await run(sb.from("projects").insert({ workspace_id: f.ws.value, name: f.name.value.trim(), priority: f.priority.value, target_date: f.target.value || null }).select().single());
      busy(b, false);
      if (res.error) return toastError(res.error);
      state.projects.push(res.data); refresh(); closeSheet(); location.hash = "#/p/" + res.data.id;
    };
  });
  return true;
}
