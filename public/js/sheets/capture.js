// Quick Capture: a task in seconds, from anywhere. Never invents a deadline or follow-up date.
import { esc, zonedToISO, todayISO, addDays } from "../util.js";
import { PRIORITIES, PRIORITY_LABEL } from "../logic.js";
import { state, activeWorkspaces, canWrite, membersOf, nameOf } from "../store.js";
import { createTask, savePrefs, uploadDocument, addLink } from "../api.js";
import { safeFileName } from "../insights.js";
import { ICON, $, openSheet, closeSheet, rerenderSheet, sheetHead, toast, toastError, busy } from "../ui.js";
import { openTask } from "./task.js";

const cap = { draft: null, saved: null };

function defaults(over = {}) {
  const ws = over.workspace_id || state.prefs.default_ws || state.prefs.last_ws;
  const writable = activeWorkspaces().filter(w => canWrite(w.id));
  const wsId = writable.some(w => w.id === ws) ? ws : (writable[0] || {}).id;
  return { title: "", description: "", workspace_id: wsId, project_id: over.project_id || null, parent_id: null, priority: "medium", status: "inbox",
           due_d: "", due_t: "", fu_d: "", fu_t: "", owner_id: state.user.id, more: false, ...over };
}

export function openCapture(over = {}) {
  cap.draft = defaults(over); cap.saved = null;
  openSheet(sh => render(sh));
}

function render(sh) {
  if (cap.saved) {
    const t = cap.saved;
    sh.innerHTML = sheetHead("Captured") + `<div class="sh-body">
      <div class="banner ok">${ICON.done} Saved to ${esc((state.workspaces.find(w => w.id === t.workspace_id) || {}).name || "")}${t.status === "inbox" ? " · Inbox" : ""}: <b>${esc(t.title)}</b></div>
      <div class="btnrow"><button class="btn primary" data-act="cap-another" autofocus>Capture another</button><button class="btn" data-act="cap-open" data-id="${t.id}">Open task</button><button class="btn" data-act="close-sheet">Done</button></div></div>`;
    return;
  }
  const d = cap.draft;
  const wsList = activeWorkspaces().filter(w => canWrite(w.id));
  if (!wsList.length) { sh.innerHTML = sheetHead("Quick capture") + `<div class="sh-body"><p>Create a workspace first (Workspaces → New workspace).</p></div>`; return; }
  const projects = state.projects.filter(p => p.workspace_id === d.workspace_id && !p.archived);
  const mem = membersOf(d.workspace_id);
  sh.innerHTML = sheetHead("Quick capture", "Capture now, classify later. Nothing is scheduled unless you add a date.") + `
  <form id="capForm" class="sh-body" novalidate>
    <label class="field"><span>What needs attention?</span><textarea class="input big" id="cap-title" rows="2" autofocus placeholder="e.g. Follow up with supplier on delayed shipment">${esc(d.title)}</textarea></label>
    <div class="seg2" role="radiogroup" aria-label="Capture as">
      <label class="${d.status === "inbox" ? "on" : ""}"><input type="radio" name="cap-status" value="inbox" ${d.status === "inbox" ? "checked" : ""}><b>Inbox</b><small>Sort it out later</small></label>
      <label class="${d.status === "not_started" ? "on" : ""}"><input type="radio" name="cap-status" value="not_started" ${d.status === "not_started" ? "checked" : ""}><b>Ready to work</b><small>Add straight to my tasks</small></label>
    </div>
    <div class="grid2">
      <label class="field"><span>Workspace</span><select class="input" id="cap-ws">${wsList.map(w => `<option value="${w.id}" ${w.id === d.workspace_id ? "selected" : ""}>${esc(w.name)}</option>`).join("")}</select></label>
      <label class="field"><span>Priority</span><select class="input" id="cap-priority">${PRIORITIES.map(p => `<option value="${p}" ${d.priority === p ? "selected" : ""}>${PRIORITY_LABEL[p]}</option>`).join("")}</select></label>
    </div>
    <button type="button" class="linkbtn" data-act="cap-more">${d.more ? "Hide details" : "Add deadline, follow-up, owner, project…"}</button>
    ${d.more ? `
    <div class="grid2">
      <div class="field"><span>Deadline <small>(optional)</small></span><div class="dt"><input class="input" type="date" id="cap-due-d" value="${d.due_d}"><input class="input" type="time" id="cap-due-t" value="${d.due_t}" aria-label="Deadline time"></div>
        <div class="quick"><button type="button" data-act="cap-quick" data-f="due" data-n="0">Today</button><button type="button" data-act="cap-quick" data-f="due" data-n="1">Tomorrow</button><button type="button" data-act="cap-quick" data-f="due" data-n="7">+1 week</button><button type="button" data-act="cap-quick" data-f="due" data-n="">Clear</button></div></div>
      <div class="field"><span>Follow-up <small>(optional)</small></span><div class="dt"><input class="input" type="date" id="cap-fu-d" value="${d.fu_d}"><input class="input" type="time" id="cap-fu-t" value="${d.fu_t}" aria-label="Follow-up time"></div>
        <div class="quick"><button type="button" data-act="cap-quick" data-f="fu" data-n="1">Tomorrow</button><button type="button" data-act="cap-quick" data-f="fu" data-n="3">+3 days</button><button type="button" data-act="cap-quick" data-f="fu" data-n="">Clear</button></div></div>
      <label class="field"><span>Owner</span><select class="input" id="cap-owner">${mem.map(m => `<option value="${m.user_id}" ${m.user_id === d.owner_id ? "selected" : ""}>${esc(nameOf(m.user_id))}${m.user_id === state.user.id ? " (me)" : ""}</option>`).join("")}</select></label>
      <label class="field"><span>Project</span><select class="input" id="cap-project"><option value="">No project</option>${projects.map(p => `<option value="${p.id}" ${p.id === d.project_id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
    </div>
    <label class="field"><span>Description <small>(optional)</small></span><textarea class="input" id="cap-desc" rows="3">${esc(d.description)}</textarea></label>
    <label class="field"><span>Attach files <small>(optional · private · max 25 MB each)</small></span><input class="input" type="file" id="cap-files" multiple></label>` : ""}
    <div class="sheet-foot"><button class="btn primary block" type="submit" id="capSave">Save task</button></div>
    <p class="hint center">Tip: press <kbd>N</kbd> anywhere to capture.</p>
  </form>`;
}

function sync() {
  const d = cap.draft; if (!$("cap-title")) return;
  d.title = $("cap-title").value; d.workspace_id = $("cap-ws").value; d.priority = $("cap-priority").value;
  d.status = (document.querySelector('input[name="cap-status"]:checked') || {}).value || "inbox";
  if (d.more && $("cap-due-d")) {
    d.due_d = $("cap-due-d").value; d.due_t = $("cap-due-t").value; d.fu_d = $("cap-fu-d").value; d.fu_t = $("cap-fu-t").value;
    d.owner_id = $("cap-owner").value; d.project_id = $("cap-project").value || null; d.description = $("cap-desc").value;
  }
}

export function handleCaptureChange(e) {
  const id = e.target.id || "", nm = e.target.name || "";
  if (!id.startsWith("cap-") && nm !== "cap-status") return false;
  const prevWs = cap.draft.workspace_id;
  sync();
  if (cap.draft.workspace_id !== prevWs) { cap.draft.project_id = null; if (!membersOf(cap.draft.workspace_id).some(m => m.user_id === cap.draft.owner_id)) cap.draft.owner_id = state.user.id; rerenderSheet(); }
  if (nm === "cap-status") rerenderSheet();
  return true;
}

export async function handleCaptureClick(act, el) {
  if (act === "cap-more") { sync(); cap.draft.more = !cap.draft.more; rerenderSheet(); return true; }
  if (act === "cap-quick") {
    sync(); const f = el.dataset.f, n = el.dataset.n;
    cap.draft[f + "_d"] = n === "" ? "" : addDays(todayISO(state.tz), +n);
    if (n === "") cap.draft[f + "_t"] = "";
    rerenderSheet(); return true;
  }
  if (act === "cap-another") { const ws = cap.saved.workspace_id; cap.draft = defaults({ workspace_id: ws }); cap.saved = null; rerenderSheet(); setTimeout(() => $("cap-title") && $("cap-title").focus(), 30); return true; }
  if (act === "cap-open") { const id = el.dataset.id; closeSheet(); openTask(id); return true; }
  return false;
}

export async function handleCaptureSubmit(form) {
  if (form.id !== "capForm") return false;
  sync();
  const d = cap.draft;
  if (!d.title.trim()) { toastError("Give the task a title."); $("cap-title").focus(); return true; }
  const btn = $("capSave");
  if (btn.disabled) return true; // duplicate-submission guard
  busy(btn, true);
  const row = {
    title: d.title.trim(), description: d.description.trim() || null, workspace_id: d.workspace_id, project_id: d.project_id || null,
    priority: d.priority, status: d.status, owner_id: d.owner_id || state.user.id, progress: 0,
    due_at: d.due_d ? zonedToISO(d.due_d, d.due_t || "23:59", state.tz) : null, due_all_day: !d.due_t,
    follow_up_at: d.fu_d ? zonedToISO(d.fu_d, d.fu_t || "09:00", state.tz) : null
  };
  const files = $("cap-files") ? [...$("cap-files").files] : [];
  const r = await createTask(row);
  if (r.error) { busy(btn, false); toastError(r.error); return true; }
  for (const f of files) {
    if (btn) btn.innerHTML = `Uploading ${esc(f.name)}…`;
    const u = await uploadDocument(f, { workspace_id: row.workspace_id, title: f.name }, safeFileName);
    if (u.error) { toastError(`${f.name}: ${u.error}`); continue; }
    const l = await addLink(row.workspace_id, "document", u.data.id, "task", r.data.id);
    if (l.error) toastError(l.error);
  }
  busy(btn, false);
  cap.saved = r.data;
  if (state.prefs.last_ws !== d.workspace_id) savePrefs({ last_ws: d.workspace_id });
  rerenderSheet();
  return true;
}
