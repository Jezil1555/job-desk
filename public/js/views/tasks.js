// My Tasks: universal views, filters, sorting, list/board, saved views and bulk actions.
import { esc } from "../util.js";
import { VIEWS, viewFilter, sortTasks, STATUSES, STATUS_LABEL, PRIORITIES, PRIORITY_LABEL, isClosed } from "../logic.js";
import { state, wsById, activeWorkspaces, membersOf, nameOf, canWrite } from "../store.js";
import { updateTask, savePrefs, loadOlderCompleted, run, sb, reindex } from "../api.js";
import { emit } from "../store.js";
import { ICON, taskRow, emptyState, toast, toastError, dialog, statusPill, prioChip, dueLabel, avatar, wsDot } from "../ui.js";
import { setStatus } from "../sheets/task.js";

const BOARD_COLS = ["inbox", "not_started", "in_progress", "waiting", "blocked", "completed"];

export function currentTaskList(view) {
  const f = state.ui.filters, uid = state.user.id;
  const act = new Set(activeWorkspaces().map(w => w.id));
  let list = state.tasks.filter(t => act.has(t.workspace_id)).filter(viewFilter(view, uid, state.tz));
  if (f.ws) list = list.filter(t => t.workspace_id === f.ws);
  if (f.priority) list = list.filter(t => t.priority === f.priority);
  if (f.status) list = list.filter(t => t.status === f.status);
  if (f.owner === "me") list = list.filter(t => t.owner_id === uid); else if (f.owner === "others") list = list.filter(t => t.owner_id !== uid); else if (f.owner) list = list.filter(t => t.owner_id === f.owner);
  if (f.project) list = list.filter(t => t.project_id === f.project);
  if (f.top) list = list.filter(t => !t.parent_id);
  if (state.ui.search) { const q = state.ui.search.toLowerCase(); list = list.filter(t => [t.title, t.description, t.reference, t.client_name, t.next_action, t.category, t.waiting_on].some(v => v && v.toLowerCase().includes(q))); }
  return sortTasks(list, state.ui.sort || state.prefs.task_sort || "smart");
}

export function renderTasks(view, viewKey) {
  const v = VIEWS[viewKey] ? viewKey : "mine";
  const mode = state.ui.mode || state.prefs.task_mode || "list";
  const f = state.ui.filters;
  const list = currentTaskList(v);
  const owners = [...new Set(state.members.map(m => m.user_id))];
  const projects = state.projects.filter(p => !p.archived && (!f.ws || p.workspace_id === f.ws));
  const sel = state.ui.selected;
  const filtersOn = ["ws", "priority", "status", "owner", "project"].filter(k => f[k]).length + (f.top ? 1 : 0);
  const saved = state.prefs.saved_views || [];

  view.innerHTML = `
  <div class="page-head"><div><h1>${esc(VIEWS[v].label)}</h1><p class="sub">${esc(VIEWS[v].hint)} · <span class="num">${list.length}</span> task${list.length === 1 ? "" : "s"}</p></div>
    <div class="filters">
      <div class="segbtn" role="group" aria-label="Layout"><button class="${mode === "list" ? "on" : ""}" data-act="task-mode" data-m="list" aria-label="List">${ICON.list}</button><button class="${mode === "board" ? "on" : ""}" data-act="task-mode" data-m="board" aria-label="Board">${ICON.board}</button></div>
      <button class="btn sm ${state.ui.selecting ? "on" : ""}" data-act="bulk-toggle">${state.ui.selecting ? "Done selecting" : "Select"}</button>
    </div></div>
  <div class="viewtabs">${["today", "inbox", "upcoming", "overdue", "priority", "waiting", "blocked", "delegated", "mine", "all", "completed"].map(k => `<a href="#/tasks/${k}" class="${k === v ? "on" : ""}">${VIEWS[k].label}<span class="c">${state.tasks.filter(viewFilter(k, state.user.id, state.tz)).filter(t => activeWorkspaces().some(w => w.id === t.workspace_id)).length}</span></a>`).join("")}
    ${saved.map((s, i) => `<a href="#/tasks/${s.view}" data-act="apply-view" data-i="${i}" class="saved">★ ${esc(s.name)}</a>`).join("")}</div>
  <div class="filterbar">
    <div class="searchbar">${ICON.search}<input class="input sm" id="tl-search" placeholder="Filter these tasks…" value="${esc(state.ui.search || "")}" autocomplete="off"></div>
    <select class="input sm" id="tl-ws" aria-label="Workspace"><option value="">All workspaces</option>${activeWorkspaces().map(w => `<option value="${w.id}" ${f.ws === w.id ? "selected" : ""}>${esc(w.name)}</option>`).join("")}</select>
    <select class="input sm" id="tl-project" aria-label="Project"><option value="">All projects</option>${projects.map(p => `<option value="${p.id}" ${f.project === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
    <select class="input sm" id="tl-priority" aria-label="Priority"><option value="">Any priority</option>${PRIORITIES.map(p => `<option value="${p}" ${f.priority === p ? "selected" : ""}>${PRIORITY_LABEL[p]}</option>`).join("")}</select>
    <select class="input sm" id="tl-status" aria-label="Status"><option value="">Any status</option>${STATUSES.map(s => `<option value="${s}" ${f.status === s ? "selected" : ""}>${STATUS_LABEL[s]}</option>`).join("")}</select>
    <select class="input sm" id="tl-owner" aria-label="Owner"><option value="">Anyone</option><option value="me" ${f.owner === "me" ? "selected" : ""}>Me</option><option value="others" ${f.owner === "others" ? "selected" : ""}>Others</option>${owners.filter(o => o !== state.user.id).map(o => `<option value="${o}" ${f.owner === o ? "selected" : ""}>${esc(nameOf(o))}</option>`).join("")}</select>
    <select class="input sm" id="tl-sort" aria-label="Sort"><option value="smart">Sort: deadline</option>${[["priority", "Sort: priority"], ["updated", "Sort: recently updated"], ["created", "Sort: newest"], ["title", "Sort: A–Z"]].map(([k, l]) => `<option value="${k}" ${(state.ui.sort || state.prefs.task_sort) === k ? "selected" : ""}>${l}</option>`).join("")}</select>
    <label class="chk"><input type="checkbox" id="tl-top" ${f.top ? "checked" : ""}> Hide subtasks</label>
    ${filtersOn ? `<button class="linkbtn" data-act="clear-filters">Clear filters (${filtersOn})</button>` : ""}
    <button class="linkbtn" data-act="save-view">Save view</button>
  </div>
  ${state.ui.selecting ? bulkBar(sel) : ""}
  ${mode === "board" ? board(list) : list.length ? `<div class="list">${list.map(t => taskRow(t, { selectable: state.ui.selecting, selected: sel.has(t.id) })).join("")}</div>` :
    emptyState(v === "inbox" ? "Inbox zero" : "No tasks here", v === "inbox" ? "Everything captured has been classified." : filtersOn || state.ui.search ? "Try clearing filters." : "Use Quick Capture (N) to add one.", filtersOn ? `<button class="btn" data-act="clear-filters">Clear filters</button>` : `<button class="btn primary" data-act="capture">Capture a task</button>`)}
  ${v === "completed" ? `<div class="center"><button class="btn" data-act="load-older">Load completed tasks older than 120 days</button></div>` : ""}`;
}

function bulkBar(sel) {
  return `<div class="bulkbar"><span><b class="num">${sel.size}</b> selected</span>
    <button class="linkbtn" data-act="bulk-all">Select all</button>
    <select class="input sm" id="bulk-status"><option value="">Set status…</option>${STATUSES.filter(s => !["waiting", "blocked", "cancelled"].includes(s)).map(s => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join("")}</select>
    <select class="input sm" id="bulk-priority"><option value="">Set priority…</option>${PRIORITIES.map(p => `<option value="${p}">${PRIORITY_LABEL[p]}</option>`).join("")}</select>
    <select class="input sm" id="bulk-ws"><option value="">Move to workspace…</option>${activeWorkspaces().filter(w => canWrite(w.id)).map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join("")}</select>
    <button class="btn sm danger" data-act="bulk-delete" ${sel.size ? "" : "disabled"}>Move to bin</button></div>`;
}

function board(list) {
  const cols = BOARD_COLS.map(s => {
    const items = list.filter(t => t.status === s);
    return `<div class="bcol" data-status="${s}"><div class="bcol-h">${statusPill(s)}<span class="c">${items.length}</span></div>
      <div class="bcol-body" data-drop="${s}">${items.map(t => card(t)).join("") || `<p class="bempty">Drop here</p>`}</div></div>`;
  }).join("");
  return `<div class="board" role="region" aria-label="Board">${cols}</div>`;
}
function card(t) {
  const d = dueLabel(t), ws = wsById(t.workspace_id);
  return `<article class="bcard p-${t.priority}" draggable="${canWrite(t.workspace_id)}" data-drag="${t.id}" data-act="open-task" data-id="${t.id}" tabindex="0">
    <div class="ttitle">${esc(t.title)}</div>
    <div class="tmeta"><span class="m-ws">${wsDot(ws)}${esc(ws ? ws.name : "")}</span></div>
    <div class="bmeta">${prioChip(t.priority)}${d.text ? `<span class="due ${d.cls}">${d.text}</span>` : ""}${t.owner_id !== state.user.id ? avatar(t.owner_id, "sm") : ""}</div></article>`;
}

/* ---------- events ---------- */
export function handleTasksChange(e, rerender) {
  const id = e.target.id;
  const map = { "tl-ws": "ws", "tl-priority": "priority", "tl-status": "status", "tl-owner": "owner", "tl-project": "project" };
  if (map[id]) { state.ui.filters[map[id]] = e.target.value || ""; if (id === "tl-ws") state.ui.filters.project = ""; rerender(); return true; }
  if (id === "tl-top") { state.ui.filters.top = e.target.checked; rerender(); return true; }
  if (id === "tl-sort") { state.ui.sort = e.target.value; savePrefs({ task_sort: e.target.value }); rerender(); return true; }
  if (id === "bulk-status" || id === "bulk-priority" || id === "bulk-ws") { bulkApply(id, e.target.value, rerender); return true; }
  return false;
}

async function bulkApply(kind, value, rerender) {
  if (!value) return;
  const ids = [...state.ui.selected];
  if (!ids.length) { toastError("Select some tasks first."); rerender(); return; }
  let ok = 0, failed = [];
  for (const id of ids) {
    const t = state.taskById.get(id); if (!t) continue;
    if (kind === "bulk-status") {
      if (t.status === "completed" && value !== "completed") { failed.push(`${t.title} (reopen needs a reason — open the task)`); continue; }
      const r = await updateTask(id, { status: value });
      r.error ? failed.push(`${t.title}: ${r.error}`) : ok++;
    } else if (kind === "bulk-priority") {
      const r = await updateTask(id, { priority: value }); r.error ? failed.push(`${t.title}: ${r.error}`) : ok++;
    } else {
      const ownerOk = state.members.some(m => m.workspace_id === value && m.user_id === t.owner_id);
      const r = await updateTask(id, { workspace_id: value, project_id: null, milestone_id: null, parent_id: null, owner_id: ownerOk ? t.owner_id : state.user.id });
      r.error ? failed.push(`${t.title}: ${r.error}`) : ok++;
    }
  }
  if (ok) toast(`Updated ${ok} task${ok === 1 ? "" : "s"}`);
  if (failed.length) await dialog({ title: `${failed.length} task(s) not changed`, text: failed.slice(0, 6).join("\n"), confirm: "OK", cancel: "Close" });
  state.ui.selected.clear(); rerender();
}

export async function handleTasksClick(act, el, rerender) {
  switch (act) {
    case "task-mode": state.ui.mode = el.dataset.m; savePrefs({ task_mode: el.dataset.m }); rerender(); return true;
    case "clear-filters": state.ui.filters = {}; state.ui.search = ""; rerender(); return true;
    case "bulk-toggle": state.ui.selecting = !state.ui.selecting; state.ui.selected.clear(); rerender(); return true;
    case "select-task": { const id = el.dataset.id; el.checked ? state.ui.selected.add(id) : state.ui.selected.delete(id); const b = document.querySelector(".bulkbar b"); if (b) b.textContent = state.ui.selected.size; const d = document.querySelector('[data-act="bulk-delete"]'); if (d) d.disabled = !state.ui.selected.size; el.closest(".trow").classList.toggle("sel", el.checked); return true; }
    case "bulk-all": document.querySelectorAll(".tsel").forEach(c => { c.checked = true; state.ui.selected.add(c.dataset.id); }); rerender(); return true;
    case "bulk-delete": {
      const ids = [...state.ui.selected]; if (!ids.length) return true;
      if (!(await dialog({ title: `Move ${ids.length} task(s) to the bin?`, text: "You can restore them later. History is kept.", confirm: "Move to bin", danger: true }))) return true;
      const now = new Date().toISOString(); let n = 0;
      for (const id of ids) { const r = await updateTask(id, { deleted_at: now }); if (!r.error) n++; }
      state.ui.selected.clear(); toast(`${n} moved to bin`); rerender(); return true;
    }
    case "save-view": {
      const name = await dialog({ title: "Save this view", text: "Saves the current tab, filters, sort and layout to the sidebar.", input: { label: "Name", required: true, placeholder: "e.g. QCloud critical" }, confirm: "Save" });
      if (!name) return true;
      const view = (location.hash.split("/")[2] || "mine").split("?")[0];
      const views = [...(state.prefs.saved_views || []), { name, view, filters: { ...state.ui.filters }, sort: state.ui.sort || null, mode: state.ui.mode || null }];
      const r = await savePrefs({ saved_views: views }); if (r.error) toastError(r.error); else toast("View saved"); emit("data"); return true;
    }
    case "apply-view": {
      const s = (state.prefs.saved_views || [])[+el.dataset.i]; if (!s) return false;
      state.ui.filters = { ...(s.filters || {}) }; state.ui.sort = s.sort; state.ui.mode = s.mode;
      return false; // let the link navigate
    }
    case "load-older": { el.disabled = true; el.textContent = "Loading…"; try { const n = await loadOlderCompleted(); toast(n ? `Loaded ${n} older task(s)` : "No older completed tasks"); } catch (e) { toastError("Couldn't load older tasks."); } rerender(); return true; }
  }
  return false;
}

/* drag and drop on the board (desktop) */
export function bindBoard(root) {
  let dragId = null;
  root.querySelectorAll("[data-drag]").forEach(c => {
    c.addEventListener("dragstart", e => { dragId = c.dataset.drag; e.dataTransfer.effectAllowed = "move"; c.classList.add("dragging"); });
    c.addEventListener("dragend", () => c.classList.remove("dragging"));
  });
  root.querySelectorAll("[data-drop]").forEach(z => {
    z.addEventListener("dragover", e => { e.preventDefault(); z.classList.add("over"); });
    z.addEventListener("dragleave", () => z.classList.remove("over"));
    z.addEventListener("drop", async e => {
      e.preventDefault(); z.classList.remove("over");
      const t = state.taskById.get(dragId); if (!t) return;
      await setStatus(t, z.dataset.drop);
    });
  });
}
