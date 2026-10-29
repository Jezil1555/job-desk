// Task detail & editor. Autosaves each field after the server confirms; rules are enforced server-side too.
import { esc, zonedDate, zonedTime, zonedToISO, fmtDateTime, ago } from "../util.js";
import { STATUSES, STATUS_LABEL, PRIORITIES, PRIORITY_LABEL, RECURRENCE_LABEL, isClosed, isOpen, completionBlockers, statusRequirements,
         openPrerequisites, dependents, taskProgress, overduePrerequisites } from "../logic.js";
import { state, wsById, projectById, membersOf, nameOf, shortName, subtasksOf, canWrite, contactById, activeWorkspaces } from "../store.js";
import { sb, run, updateTask, createTask, reopenTask, refreshTask, linksFor } from "../api.js";
import { linkedPanel } from "./knowledge.js";
import { ICON, $, openSheet, closeSheet, rerenderSheet, sheetHead, toast, toastError, dialog, statusPill, prioChip, taskRow, avatar, dueLabel, busy } from "../ui.js";

const sheetState = { tab: "details", comments: null, activity: null, saving: 0, savedAt: null };

export function openTask(id) {
  const t = state.taskById.get(id);
  if (!t) { toastError("That task isn't available. It may have been deleted or you no longer have access."); return; }
  sheetState.tab = "details"; sheetState.comments = null; sheetState.activity = null; sheetState.id = id;
  openSheet(sh => renderTask(sh, id), { wide: true });
  loadSide(id);
}

async function loadSide(id) {
  const [c, a] = await Promise.all([
    sb.from("task_comments").select("*").eq("task_id", id).order("created_at", { ascending: false }),
    sb.from("activity").select("*").eq("entity_type", "task").eq("entity_id", id).order("created_at", { ascending: false }).limit(100)
  ]);
  if (sheetState.id !== id) return;
  sheetState.comments = c.data || []; sheetState.activity = a.data || [];
  rerenderSheet();
}

/* ---------- status changes (used by list, board and sheet) ---------- */
export async function setStatus(t, status) {
  if (t.status === status) return true;
  if (t.status === "completed" && status !== "completed") {
    const reason = await dialog({ title: "Reopen task", text: `"${t.title}" is completed. Why does it need reopening? This is kept in the task history.`, input: { label: "Reason", required: true, min: 3, requiredText: "Give a short reason (at least 3 characters).", multiline: true }, confirm: "Reopen" });
    if (!reason) return false;
    const target = status === "cancelled" ? "in_progress" : status;
    const r = await reopenTask(t.id, reason, target === "waiting" && !t.waiting_on ? "in_progress" : target === "blocked" && !t.blocker ? "in_progress" : target);
    if (r.error) { toastError(r.error); return false; }
    toast("Task reopened");
    return true;
  }
  const fields = { status };
  if (status === "completed") {
    const blockers = completionBlockers(t, subtasksOf(t.id), state.deps, state.taskById);
    if (blockers.length) { toastError("Can't complete yet: " + blockers.join(", ") + "."); return false; }
  }
  if (status === "waiting" && statusRequirements("waiting", t)) {
    const who = await dialog({ title: "Waiting on someone", text: "Who are you waiting on? You can add what you need and a follow-up date in the task.", input: { label: "Person or organisation", required: true, placeholder: "e.g. Supplier — Al Muthawa" }, confirm: "Set waiting" });
    if (!who) return false; fields.waiting_on = who;
  }
  if (status === "blocked" && statusRequirements("blocked", t)) {
    const why = await dialog({ title: "What's blocking it?", input: { label: "Blocker", required: true, multiline: true, placeholder: "e.g. Customs hold on BOE, awaiting CoC" }, confirm: "Mark blocked" });
    if (!why) return false; fields.blocker = why;
  }
  if (status === "cancelled") {
    const why = await dialog({ title: "Cancel task", text: "Cancelled tasks stay in history. Why is it being cancelled?", input: { label: "Reason", required: true, min: 3, requiredText: "Give a short reason." }, confirm: "Cancel task", danger: true });
    if (!why) return false; fields.cancelled_reason = why;
  }
  const r = await updateTask(t.id, fields);
  if (r.error) { toastError(r.error); return false; }
  if (status === "completed") {
    const next = state.tasks.find(x => x.recurrence_parent_id === t.id);
    toast(t.recurrence ? "Completed — next occurrence created" : "Task completed");
    if (t.recurrence && !next) refreshAllSoon();
  } else toast(`Status: ${STATUS_LABEL[status]}`);
  return true;
}
function refreshAllSoon() { import("../api.js").then(m => setTimeout(() => m.loadAll().catch(() => {}), 600)); }

/* ---------- rendering ---------- */
function renderTask(sh, id) {
  const t = state.taskById.get(id);
  if (!t) { closeSheet(); return; }
  // keep whatever the person is typing across a re-render
  const f = document.activeElement;
  const keep = f && f.id && sh.contains(f) && ["INPUT", "TEXTAREA"].includes(f.tagName) && f.type !== "checkbox" ? { id: f.id, v: f.value, s: f.selectionStart } : null;
  const scroll = sh.scrollTop;
  renderTaskInner(sh, t);
  sh.scrollTop = scroll;
  if (keep) { const n = $(keep.id); if (n) { n.value = keep.v; n.focus(); try { n.setSelectionRange(keep.s, keep.s); } catch (e) {} } }
}

function renderTaskInner(sh, t) {
  const id = t.id;
  const ws = wsById(t.workspace_id), writable = canWrite(t.workspace_id), closed = isClosed(t);
  const subs = subtasksOf(t.id), prog = taskProgress(t, subs);
  const tz = state.tz;
  const parent = t.parent_id ? state.taskById.get(t.parent_id) : null;
  const tabs = { details: "Details", plan: `Subtasks, links & files${(subs.length + linksFor("task", t.id).length) ? " · " + (subs.length + linksFor("task", t.id).length) : ""}`, updates: `Updates${sheetState.comments ? " · " + sheetState.comments.filter(c => c.kind === "note").length : ""}`, history: "History" };
  const savedNote = sheetState.saving ? `<span class="savestate">Saving…</span>` : sheetState.savedAt && Date.now() - sheetState.savedAt < 4000 ? `<span class="savestate ok">Saved</span>` : "";
  sh.innerHTML = sheetHead(closed ? "Task · " + STATUS_LABEL[t.status] : "Task", `${ws ? esc(ws.name) : ""}${parent ? ` · subtask of <a href="#" data-act="open-task" data-id="${parent.id}">${esc(parent.title)}</a>` : ""} ${savedNote}`) + `
  <div class="sh-body">
    ${!writable ? `<div class="banner info">${ICON.lock} You have view-only access to this workspace.</div>` : ""}
    ${t.deleted_at ? `<div class="banner warn">This task is in the bin. <button class="linkbtn" data-act="restore-task" data-id="${t.id}">Restore</button></div>` : ""}
    <textarea class="title-input" id="tf-title" rows="1" ${writable ? "" : "readonly"} aria-label="Task title">${esc(t.title)}</textarea>
    <div class="status-bar">
      <label class="field inline"><span>Status</span>
        <select class="input" id="tf-status" ${writable ? "" : "disabled"}>${STATUSES.map(s => `<option value="${s}" ${t.status === s ? "selected" : ""}>${STATUS_LABEL[s]}</option>`).join("")}</select></label>
      <label class="field inline"><span>Priority</span>
        <select class="input" id="tf-priority" ${writable ? "" : "disabled"}>${PRIORITIES.map(p => `<option value="${p}" ${t.priority === p ? "selected" : ""}>${PRIORITY_LABEL[p]}</option>`).join("")}</select></label>
      ${writable && !closed ? `<button class="btn primary" data-act="complete-task" data-id="${t.id}">${ICON.check}Complete</button>` : ""}
      ${writable && closed && !t.deleted_at ? `<button class="btn" data-act="reopen-task" data-id="${t.id}">Reopen…</button>` : ""}
    </div>
    ${readinessBanner(t)}
    <div class="tabs" role="tablist">${Object.entries(tabs).map(([k, v]) => `<button role="tab" class="${sheetState.tab === k ? "on" : ""}" data-act="task-tab" data-tab="${k}">${v}</button>`).join("")}</div>
    <div class="tabpanel">${sheetState.tab === "details" ? detailsTab(t, writable, prog, subs) : sheetState.tab === "plan" ? planTab(t, writable, subs) : sheetState.tab === "updates" ? updatesTab(t, writable) : historyTab(t)}</div>
    ${writable && !t.deleted_at ? `<div class="sheet-foot">
      ${!closed ? `<button class="btn" data-act="cancel-task" data-id="${t.id}">Cancel task…</button>` : ""}
      <button class="btn danger" data-act="delete-task" data-id="${t.id}">${ICON.trash}Move to bin</button></div>` : ""}
  </div>`;
  autoGrow($("tf-title"));
}

function readinessBanner(t) {
  if (isClosed(t)) {
    if (t.status === "cancelled" && t.cancelled_reason) return `<div class="banner muted">Cancelled: ${esc(t.cancelled_reason)}</div>`;
    return t.completed_at ? `<div class="banner ok">${ICON.done} Completed ${fmtDateTime(t.completed_at, state.tz)}</div>` : "";
  }
  const pre = openPrerequisites(t, state.deps, state.taskById), late = overduePrerequisites(t, state.deps, state.taskById);
  const parts = [];
  if (pre.length) parts.push(`<div class="banner ${late.length ? "bad" : "warn"}">${ICON.lock} Not ready: waiting on ${pre.length} prerequisite task${pre.length > 1 ? "s" : ""}${late.length ? `, ${late.length} of them overdue` : ""}. <button class="linkbtn" data-act="task-tab" data-tab="plan">See dependencies</button></div>`);
  if (t.status === "waiting") parts.push(`<div class="banner info">${ICON.clock} Waiting on <b>${esc(t.waiting_on || (contactById(t.waiting_on_contact_id) || {}).name || "someone")}</b>${t.waiting_for ? ` for ${esc(t.waiting_for)}` : ""}${t.follow_up_at ? ` · follow up ${fmtDateTime(t.follow_up_at, state.tz)}` : ` · <span class="warn-text">no follow-up date set</span>`}</div>`);
  if (t.status === "blocked") parts.push(`<div class="banner bad">${ICON.alert} Blocked: ${esc(t.blocker || "")}${t.unblock_action ? ` · next: ${esc(t.unblock_action)}` : ""}</div>`);
  return parts.join("");
}

function dtInputs(id, iso, allDay, tz) {
  const d = iso ? zonedDate(iso, tz) : "", tm = iso && !allDay ? zonedTime(iso, tz) : "";
  return `<div class="dt"><input class="input" type="date" id="${id}-d" value="${d}"><input class="input" type="time" id="${id}-t" value="${tm}" aria-label="Time (optional)"></div>`;
}

function detailsTab(t, w, prog, subs) {
  const tz = state.tz, ro = w ? "" : "disabled";
  const wsList = activeWorkspaces().filter(x => canWrite(x.id) || x.id === t.workspace_id);
  const projects = state.projects.filter(p => p.workspace_id === t.workspace_id && (!p.archived || p.id === t.project_id));
  const mem = membersOf(t.workspace_id);
  const ms = t.project_id ? state.milestones.filter(m => m.project_id === t.project_id) : [];
  const contacts = state.contacts.filter(c => c.workspace_id === t.workspace_id);
  return `
  <div class="grid2">
    <label class="field"><span>Workspace</span><select class="input" id="tf-workspace_id" ${ro}>${wsList.map(x => `<option value="${x.id}" ${x.id === t.workspace_id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
    <label class="field"><span>Project</span><select class="input" id="tf-project_id" ${ro}><option value="">No project</option>${projects.map(p => `<option value="${p.id}" ${p.id === t.project_id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
    <label class="field"><span>Owner</span><select class="input" id="tf-owner_id" ${ro}>${mem.map(m => `<option value="${m.user_id}" ${m.user_id === t.owner_id ? "selected" : ""}>${esc(nameOf(m.user_id))}${m.user_id === state.user.id ? " (me)" : ""}</option>`).join("")}</select></label>
    <label class="field"><span>Category</span><input class="input" id="tf-category" value="${esc(t.category || "")}" placeholder="e.g. Logistics / Supplier follow-up" ${ro} list="catList"></label>
  </div>
  <datalist id="catList">${[...new Set(state.tasks.map(x => x.category).filter(Boolean))].slice(0, 40).map(c => `<option value="${esc(c)}">`).join("")}</datalist>
  ${ms.length ? `<label class="field"><span>Milestone</span><select class="input" id="tf-milestone_id" ${ro}><option value="">None</option>${ms.map(m => `<option value="${m.id}" ${m.id === t.milestone_id ? "selected" : ""}>${esc(m.title)}</option>`).join("")}</select></label>` : ""}
  <div class="grid3">
    <label class="field"><span>Start date</span><input class="input" type="date" id="tf-start_date" value="${t.start_date || ""}" ${ro}></label>
    <div class="field"><span>Deadline <small>(time optional)</small></span>${dtInputs("tf-due", t.due_at, t.due_all_day, tz)}</div>
    <div class="field"><span>Next follow-up</span>${dtInputs("tf-fu", t.follow_up_at, false, tz)}</div>
  </div>
  ${!t.due_at ? `<p class="hint">No deadline set. That's fine for captured ideas; add one when you commit to a date.</p>` : ""}
  ${t.status === "waiting" ? `<fieldset class="group"><legend>Waiting details</legend><div class="grid2">
    <label class="field"><span>Waiting on</span><input class="input" id="tf-waiting_on" value="${esc(t.waiting_on || "")}" ${ro} list="contactList"></label>
    <label class="field"><span>Linked contact</span><select class="input" id="tf-waiting_on_contact_id" ${ro}><option value="">None</option>${contacts.map(c => `<option value="${c.id}" ${c.id === t.waiting_on_contact_id ? "selected" : ""}>${esc(c.name)}${c.organisation ? " · " + esc(c.organisation) : ""}</option>`).join("")}</select></label></div>
    <label class="field"><span>What response is needed</span><input class="input" id="tf-waiting_for" value="${esc(t.waiting_for || "")}" placeholder="e.g. Revised dispatch date in writing" ${ro}></label></fieldset>` : ""}
  ${t.status === "blocked" ? `<fieldset class="group"><legend>Blocker</legend>
    <label class="field"><span>What's blocking it</span><textarea class="input" id="tf-blocker" rows="2" ${ro}>${esc(t.blocker || "")}</textarea></label>
    <div class="grid2"><label class="field"><span>Impact</span><input class="input" id="tf-blocker_impact" value="${esc(t.blocker_impact || "")}" placeholder="e.g. Site delivery slips 1 week" ${ro}></label>
    <label class="field"><span>Action to unblock</span><input class="input" id="tf-unblock_action" value="${esc(t.unblock_action || "")}" ${ro}></label></div></fieldset>` : ""}
  <datalist id="contactList">${contacts.map(c => `<option value="${esc(c.name)}">`).join("")}</datalist>
  <label class="field"><span>Next action</span><input class="input" id="tf-next_action" value="${esc(t.next_action || "")}" placeholder="The very next physical step" ${ro}></label>
  <div class="field"><span>Completion criteria <small>(all must be ticked to complete)</small></span>${criteriaEditor(t, w)}</div>
  <div class="field"><span>Progress <small>${prog.basis === "subtasks" ? "· calculated from subtasks" : "· set manually"}</small></span>
    <div class="progrow"><input type="range" min="0" max="100" step="5" id="tf-progress" value="${prog.value}" ${w && prog.basis === "manual" && !isClosed(t) ? "" : "disabled"}><b class="num" id="progVal">${prog.value}%</b></div></div>
  <label class="field"><span>Description</span><textarea class="input" id="tf-description" rows="4" placeholder="Objective, context, details…" ${ro}>${esc(t.description || "")}</textarea></label>
  <div class="grid2">
    <label class="field"><span>Client / counterpart</span><input class="input" id="tf-client_name" value="${esc(t.client_name || "")}" ${ro} list="contactList"></label>
    <label class="field"><span>Reference</span><input class="input" id="tf-reference" value="${esc(t.reference || "")}" placeholder="PO, job no., invoice…" ${ro}></label>
  </div>
  <label class="field"><span>Repeats</span><select class="input" id="tf-recurrence" ${ro}><option value="">Doesn't repeat</option>${Object.entries(RECURRENCE_LABEL).map(([k, v]) => `<option value="${k}" ${t.recurrence === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
  ${t.recurrence ? `<p class="hint">When completed, the next occurrence is created automatically from the deadline.</p>` : ""}
  <p class="meta-foot">Created by ${esc(shortName(t.created_by))} · ${fmtDateTime(t.created_at, state.tz, true)} · updated ${ago(t.updated_at)}</p>`;
}

function criteriaEditor(t, w) {
  const list = Array.isArray(t.completion_criteria) ? t.completion_criteria : [];
  return `<ul class="crit">${list.map((c, i) => `<li><label><input type="checkbox" data-act="crit-toggle" data-i="${i}" ${c.done ? "checked" : ""} ${w ? "" : "disabled"}> <span class="${c.done ? "done" : ""}">${esc(c.text)}</span></label>${w ? `<button class="iconbtn sm" data-act="crit-remove" data-i="${i}" aria-label="Remove criterion">${ICON.close}</button>` : ""}</li>`).join("")}</ul>
  ${w ? `<form class="addrow" id="critForm"><input class="input" id="critInput" placeholder="Add a criterion, e.g. Supplier response recorded" autocomplete="off"><button class="btn" type="submit">Add</button></form>` : ""}`;
}

function planTab(t, w, subs) {
  const pre = state.deps.filter(d => d.task_id === t.id).map(d => state.taskById.get(d.depends_on_id)).filter(Boolean);
  const post = dependents(t, state.deps, state.taskById);
  const links = state.contacts.filter(c => c.workspace_id === t.workspace_id);
  return `
  ${t.parent_id ? "" : `<section class="sub">
    <div class="sub-h"><h3>Subtasks</h3><span class="c">${subs.filter(s => isClosed(s)).length}/${subs.length}</span></div>
    <div class="list">${subs.map(s => taskRow(s, { showWs: false })).join("") || `<p class="hint">Break the work into steps. Progress is then calculated from completed subtasks.</p>`}</div>
    ${w ? `<form class="addrow" id="subForm"><input class="input" id="subInput" placeholder="Add a subtask" autocomplete="off"><button class="btn" type="submit">Add</button></form>` : ""}
  </section>`}
  <section class="sub">
    <div class="sub-h"><h3>Depends on</h3><span class="c">${pre.length}</span></div>
    <p class="hint">This task isn't ready until these are done.</p>
    <div class="deplist">${pre.map(p => depRow(p, w, "dep-remove", t.id)).join("") || `<p class="hint">No prerequisites.</p>`}</div>
    ${w ? `<div class="addrow"><input class="input" id="depSearch" placeholder="Search tasks to add as a prerequisite…" autocomplete="off"></div><div id="depResults" class="depres"></div>` : ""}
  </section>
  <section class="sub">
    <div class="sub-h"><h3>Blocks</h3><span class="c">${post.length}</span></div>
    <div class="deplist">${post.map(p => depRow(p, false)).join("") || `<p class="hint">Nothing waits on this task.</p>`}</div>
    ${post.length && isOpen(t) && t.due_at && new Date(t.due_at) < new Date() ? `<div class="banner bad">${ICON.alert} This task is overdue and ${post.length} task(s) depend on it.</div>` : ""}
  </section>
  <section class="sub">
    <div class="sub-h"><h3>People & organisations</h3></div>
    ${links.length ? "" : `<p class="hint">Add contacts in the workspace's Contacts tab to link them here.</p>`}
    <div id="taskContacts" class="chips">Loading…</div>
    ${w && links.length ? `<select class="input" id="addContact"><option value="">Link a contact…</option>${links.map(c => `<option value="${c.id}">${esc(c.name)}${c.organisation ? " · " + esc(c.organisation) : ""} (${c.kind})</option>`).join("")}</select>` : ""}
  </section>
  ${linkedPanel("task", t.id, t.workspace_id)}`;
}
function depRow(p, w, act, tid) {
  const d = dueLabel(p);
  return `<div class="deprow ${isClosed(p) ? "done" : ""}"><button class="linkbtn" data-act="open-task" data-id="${p.id}">${esc(p.title)}</button>
    ${statusPill(p.status)}${d.text ? `<span class="due ${d.cls}">${d.text}</span>` : ""}
    ${w ? `<button class="iconbtn sm" data-act="${act}" data-id="${tid}" data-dep="${p.id}" aria-label="Remove dependency">${ICON.close}</button>` : ""}</div>`;
}

function updatesTab(t, w) {
  const list = sheetState.comments;
  return `${w ? `<form class="upform" id="upForm"><textarea class="input" id="upInput" rows="2" placeholder="Log an update: who you spoke to, what changed, what's next…"></textarea><button class="btn primary" type="submit">Log update</button></form>` : ""}
    ${!list ? `<p class="hint">Loading…</p>` : list.length ? `<ol class="timeline">${list.map(c => `<li class="${c.kind}"><span class="pt"></span><div><time>${esc(shortName(c.author_id))} · ${fmtDateTime(c.created_at, state.tz)}</time><div class="body">${esc(c.body)}</div></div></li>`).join("")}</ol>` : `<p class="hint">No updates yet.</p>`}`;
}

const FIELD_LABEL = { title: "Title", status: "Status", priority: "Priority", owner_id: "Owner", due_at: "Deadline", start_date: "Start date", follow_up_at: "Follow-up", project_id: "Project", workspace_id: "Workspace", parent_id: "Parent", progress: "Progress", next_action: "Next action", waiting_on: "Waiting on", blocker: "Blocker", category: "Category", recurrence: "Repeats", deleted_at: "Bin", cancelled_reason: "Cancel reason" };
function fmtVal(k, v) {
  if (v === null || v === undefined || v === "") return "—";
  if (k === "status") return STATUS_LABEL[v] || v;
  if (k === "priority") return PRIORITY_LABEL[v] || v;
  if (k === "owner_id") return nameOf(v);
  if (k === "project_id") return (projectById(v) || {}).name || "project";
  if (k === "workspace_id") return (wsById(v) || {}).name || "workspace";
  if (k === "due_at" || k === "follow_up_at" || k === "deleted_at") return fmtDateTime(v, state.tz);
  if (k === "progress") return v + "%";
  return String(v);
}
function historyTab() {
  const list = sheetState.activity;
  if (!list) return `<p class="hint">Loading…</p>`;
  if (!list.length) return `<p class="hint">No history yet.</p>`;
  return `<ol class="timeline">${list.map(a => {
    const ch = Object.entries(a.changes || {}).filter(([k, v]) => Array.isArray(v) && FIELD_LABEL[k]);
    const what = a.action === "created" ? "created the task" : a.action === "completed" ? "completed the task" : a.action === "reopened" ? "reopened the task" : a.action === "deleted" ? "moved it to the bin" : a.action === "restored" ? "restored it" : a.action === "dependency_added" ? "added a prerequisite" : "updated";
    return `<li class="status"><span class="pt"></span><div><time>${esc(a.actor_id ? shortName(a.actor_id) : "System")} · ${fmtDateTime(a.created_at, state.tz)}</time>
      <div class="body">${esc(what)}${a.note ? ` — “${esc(a.note)}”` : ""}${ch.length ? `<ul class="changes">${ch.map(([k, v]) => `<li>${FIELD_LABEL[k]}: <s>${esc(fmtVal(k, v[0]))}</s> → ${esc(fmtVal(k, v[1]))}</li>`).join("")}</ul>` : ""}</div></div></li>`;
  }).join("")}</ol>`;
}

function autoGrow(el) { if (!el) return; el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; }

/* ---------- events (delegated from main.js) ---------- */
const STRUCTURAL = ["status", "workspace_id", "project_id", "recurrence", "completion_criteria", "deleted_at", "priority", "owner_id"];
function setIndicator(text, ok) {
  const s = document.querySelector("#sheet .sh-sub");
  if (!s) return;
  const old = s.querySelector(".savestate"); if (old) old.remove();
  if (text) s.insertAdjacentHTML("beforeend", `<span class="savestate ${ok ? "ok" : ""}">${text}</span>`);
}
/** Save fields; only re-render the panel when the layout depends on the change, so typing elsewhere is never lost. */
async function save(fields) {
  const id = sheetState.id; sheetState.saving++; setIndicator("Saving…");
  const r = await updateTask(id, fields);
  sheetState.saving--;
  if (r.error) { setIndicator("Not saved"); toastError(r.error); rerenderSheet(); return false; }
  sheetState.savedAt = Date.now();
  const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest("#sheet") && ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName);
  if (!typing || Object.keys(fields).some(k => STRUCTURAL.includes(k))) rerenderSheet();
  if (!sheetState.saving) { setIndicator("Saved", true); setTimeout(() => { if (!sheetState.saving) setIndicator(""); }, 2500); }
  return true;
}

export function handleTaskChange(e) {
  const el = e.target; if (!el.id || !el.id.startsWith("tf-") || !sheetState.id) return false;
  const t = state.taskById.get(sheetState.id); if (!t) return true;
  const key = el.id.slice(3);
  if (key === "status") { const target = el.value; el.value = t.status; setStatus(t, target).then(() => rerenderSheet()); return true; }
  if (key === "due-d" || key === "due-t") {
    const d = $("tf-due-d").value, tm = $("tf-due-t").value;
    save(d ? { due_at: zonedToISO(d, tm || "23:59", state.tz), due_all_day: !tm } : { due_at: null, due_all_day: true });
    return true;
  }
  if (key === "fu-d" || key === "fu-t") {
    const d = $("tf-fu-d").value, tm = $("tf-fu-t").value;
    save({ follow_up_at: d ? zonedToISO(d, tm || "09:00", state.tz) : null });
    return true;
  }
  if (key === "title") { const v = el.value.trim(); if (!v) { el.value = t.title; toastError("A task needs a title."); return true; } if (v !== t.title) save({ title: v }); return true; }
  if (key === "progress") { save({ progress: +el.value }); return true; }
  if (key === "workspace_id") {
    if (el.value === t.workspace_id) return true;
    const ownerOk = state.members.some(m => m.workspace_id === el.value && m.user_id === t.owner_id);
    save({ workspace_id: el.value, project_id: null, milestone_id: null, parent_id: null, owner_id: ownerOk ? t.owner_id : state.user.id });
    return true;
  }
  if (key === "project_id") { save({ project_id: el.value || null, milestone_id: null }); return true; }
  const v = el.value === "" ? null : el.value;
  if ((t[key] ?? null) !== v) save({ [key]: v });
  return true;
}
export function handleTaskInput(e) {
  if (e.target.id === "tf-title") autoGrow(e.target);
  if (e.target.id === "tf-progress") { const v = $("progVal"); if (v) v.textContent = e.target.value + "%"; }
  if (e.target.id === "depSearch") depSearch(e.target.value);
}

function depSearch(q) {
  const t = state.taskById.get(sheetState.id), box = $("depResults"); if (!t || !box) return;
  q = q.trim().toLowerCase();
  if (q.length < 2) { box.innerHTML = ""; return; }
  const taken = new Set(state.deps.filter(d => d.task_id === t.id).map(d => d.depends_on_id));
  const hits = state.tasks.filter(x => x.id !== t.id && !taken.has(x.id) && !x.deleted_at && x.title.toLowerCase().includes(q)).slice(0, 8);
  box.innerHTML = hits.map(x => `<button class="depopt" data-act="dep-add" data-id="${t.id}" data-dep="${x.id}">${esc(x.title)} <small>${esc((wsById(x.workspace_id) || {}).name || "")} · ${STATUS_LABEL[x.status]}</small></button>`).join("") || `<p class="hint">No matching tasks.</p>`;
}

async function loadContacts(tid) {
  const box = $("taskContacts"); if (!box) return;
  const { data } = await sb.from("task_contacts").select("contact_id, role").eq("task_id", tid);
  if (!$("taskContacts") || sheetState.id !== tid) return;
  const w = canWrite(state.taskById.get(tid).workspace_id);
  $("taskContacts").innerHTML = (data || []).map(x => { const c = contactById(x.contact_id); return c ? `<span class="chip">${esc(c.name)}${c.organisation ? ` · ${esc(c.organisation)}` : ""}${w ? `<button data-act="contact-unlink" data-id="${tid}" data-c="${c.id}" aria-label="Unlink">${ICON.close}</button>` : ""}</span>` : ""; }).join("") || `<span class="hint">None linked.</span>`;
}

export async function handleTaskClick(act, el) {
  const id = el.dataset.id;
  const t = id ? state.taskById.get(id) : null;
  switch (act) {
    case "task-tab": sheetState.tab = el.dataset.tab; rerenderSheet(); if (sheetState.tab === "plan") loadContacts(sheetState.id); return true;
    case "complete-task": await setStatus(t, "completed"); rerenderSheet(); return true;
    case "reopen-task": await setStatus(t, "in_progress"); rerenderSheet(); return true;
    case "cancel-task": await setStatus(t, "cancelled"); rerenderSheet(); return true;
    case "toggle-complete": {
      if (!t || !canWrite(t.workspace_id)) return true;
      await setStatus(t, t.status === "completed" ? "in_progress" : "completed");
      if (sheetState.id) rerenderSheet();
      return true;
    }
    case "delete-task": {
      const ok = await dialog({ title: "Move task to the bin?", text: `"${t.title}" will be hidden from all views. Its history is kept and you can restore it.`, confirm: "Move to bin", danger: true });
      if (!ok) return true;
      const r = await updateTask(id, { deleted_at: new Date().toISOString() });
      if (r.error) return toastError(r.error), true;
      closeSheet();
      toast("Moved to bin", { action: { label: "Undo", run: async () => { const u = await updateTask(id, { deleted_at: null }); if (u.error) toastError(u.error); else toast("Restored"); } } });
      return true;
    }
    case "restore-task": { const r = await updateTask(id, { deleted_at: null }); if (r.error) toastError(r.error); else toast("Restored"); rerenderSheet(); return true; }
    case "crit-toggle": case "crit-remove": {
      const cur = state.taskById.get(sheetState.id); const list = (cur.completion_criteria || []).map(c => ({ ...c }));
      const i = +el.dataset.i;
      if (act === "crit-toggle") list[i].done = el.checked; else list.splice(i, 1);
      await save({ completion_criteria: list }); return true;
    }
    case "dep-add": {
      const r = await run(sb.from("task_dependencies").insert({ task_id: id, depends_on_id: el.dataset.dep }));
      if (r.error) return toastError(r.error), true;
      state.deps.push({ task_id: id, depends_on_id: el.dataset.dep }); rerenderSheet(); toast("Prerequisite added"); return true;
    }
    case "dep-remove": {
      const r = await run(sb.from("task_dependencies").delete().eq("task_id", id).eq("depends_on_id", el.dataset.dep));
      if (r.error) return toastError(r.error), true;
      state.deps = state.deps.filter(d => !(d.task_id === id && d.depends_on_id === el.dataset.dep)); rerenderSheet(); return true;
    }
    case "contact-unlink": {
      const r = await run(sb.from("task_contacts").delete().eq("task_id", id).eq("contact_id", el.dataset.c));
      if (r.error) toastError(r.error); loadContacts(id); return true;
    }
  }
  return false;
}

export async function handleTaskSubmit(form) {
  const t = state.taskById.get(sheetState.id); if (!t) return false;
  if (form.id === "critForm") {
    const v = $("critInput").value.trim(); if (!v) return true;
    const list = [...(t.completion_criteria || []), { text: v, done: false }];
    if (await save({ completion_criteria: list })) { const i = $("critInput"); if (i) { i.value = ""; i.focus(); } }
    return true;
  }
  if (form.id === "subForm") {
    const v = $("subInput").value.trim(); if (!v) return true;
    const btn = form.querySelector("button"); busy(btn, true, "Adding…");
    const r = await createTask({ title: v, workspace_id: t.workspace_id, project_id: t.project_id, parent_id: t.id, priority: t.priority, status: "not_started", owner_id: t.owner_id });
    busy(btn, false);
    if (r.error) return toastError(r.error), true;
    rerenderSheet(); const i = $("subInput"); if (i) i.focus();
    return true;
  }
  if (form.id === "upForm") {
    const v = $("upInput").value.trim(); if (!v) return true;
    const btn = form.querySelector("button"); busy(btn, true, "Logging…");
    const r = await run(sb.from("task_comments").insert({ task_id: t.id, body: v, kind: "note" }).select().single());
    busy(btn, false);
    if (r.error) return toastError(r.error), true;
    sheetState.comments = [r.data, ...(sheetState.comments || [])];
    state.lastComments.unshift(r.data);
    rerenderSheet(); toast("Update logged");
    return true;
  }
  return false;
}

export async function handleContactSelect(e) {
  if (e.target.id !== "addContact" || !e.target.value) return false;
  const r = await run(sb.from("task_contacts").insert({ task_id: sheetState.id, contact_id: e.target.value }));
  if (r.error) toastError(r.error); loadContacts(sheetState.id);
  return true;
}
export const currentTaskId = () => sheetState.id;
export function clearTaskSheet() { sheetState.id = null; }
