// Quick Capture: a task in seconds, from anywhere. Never invents a deadline or follow-up date.
import { esc, zonedToISO, todayISO, addDays } from "../util.js";
import { PRIORITIES, PRIORITY_LABEL } from "../logic.js";
import { state, activeWorkspaces, canWrite, membersOf, nameOf } from "../store.js";
import { createTask, savePrefs, uploadDocument, addLink } from "../api.js";
import { safeFileName } from "../insights.js";
import { ICON, $, openSheet, closeSheet, rerenderSheet, sheetHead, toast, toastError, busy } from "../ui.js";
import { openTask } from "./task.js";
import { parseCapture, guessContext, guessKind } from "../smart.js";
import { sb, run } from "../api.js";

const cap = { draft: null, saved: null };
import { fin, canWriteFin } from "../finapi.js";
const hasPersonalBooks = () => fin.loaded && fin.entities.some(e => e.kind === "personal" && !e.archived && canWriteFin(e.id));

function defaults(over = {}) {
  const ws = over.workspace_id || state.prefs.default_ws || state.prefs.last_ws;
  const writable = activeWorkspaces().filter(w => canWrite(w.id));
  const wsId = writable.some(w => w.id === ws) ? ws : (writable[0] || {}).id;
  return { title: "", description: "", workspace_id: wsId, project_id: over.project_id || null, parent_id: null, priority: "medium", status: "inbox",
           due_d: "", due_t: "", fu_d: "", fu_t: "", owner_id: state.user.id, more: false, off: new Set(), kind: null, wsPicked: !!over.workspace_id, statusPicked: false, ...over };
}

export function openCapture(over = {}) {
  cap.draft = defaults(over); cap.saved = null;
  openSheet(sh => render(sh));
}

function render(sh) {
  if (cap.saved) {
    const t = cap.saved;
    sh.innerHTML = sheetHead("Captured") + `<div class="sh-body">
      <div class="banner ok">${ICON.done} ${t.isNote ? "Note saved" : "Saved"} to ${esc((state.workspaces.find(w => w.id === t.workspace_id) || {}).name || "")}${t.status === "inbox" ? " · Inbox" : ""}: <b>${esc(t.title)}</b></div>
      <div class="btnrow"><button class="btn primary" data-act="cap-another" autofocus>Capture another</button>${t.isNote ? `<a class="btn" href="#/n/${t.id}" data-act="close-sheet">Open note</a>` : `<button class="btn" data-act="cap-open" data-id="${t.id}">Open task</button>`}<button class="btn" data-act="close-sheet">Done</button></div></div>`;
    return;
  }
  const d = cap.draft;
  const wsList = activeWorkspaces().filter(w => canWrite(w.id));
  if (!wsList.length) { sh.innerHTML = sheetHead("Quick capture") + `<div class="sh-body"><p>Create a workspace first (Projects → New workspace).</p></div>`; return; }
  const p = parsed(), kind = d.kind || guessKind(d.title), note = kind === "note";
  const ws = effectiveWs(p);
  const projects = state.projects.filter(x => x.workspace_id === ws && !x.archived);
  const proj = d.project_id || (p.guess && p.guess.project_id && !d.off.has("projguess") ? p.guess.project_id : "");
  const mem = membersOf(ws);
  sh.innerHTML = sheetHead("Quick capture", "Type it as you'd say it. Nothing is scheduled unless you add a date.") + `
  <form id="capForm" class="sh-body" novalidate>
    ${hasPersonalBooks() ? `<button type="button" class="banner info cap-money" data-act="mn-capture">💰 Money instead? Snap a receipt, paste a bank SMS or upload a statement →</button>` : ""}
    <label class="field"><span>What's on your mind?</span><textarea class="input big" id="cap-title" rows="2" autofocus placeholder="e.g. Follow up with Anixter about the Belgium shipment tomorrow">${esc(d.title)}</textarea></label>
    <div id="cap-chips" class="chips cap-chips" aria-live="polite">${chipsHtml()}</div>
    <div class="seg2 capkind" role="radiogroup" aria-label="Save as">
      <label class="${!note ? "on" : ""}"><input type="radio" name="cap-kind" value="task" ${!note ? "checked" : ""}><b>Task</b><small>Something to do</small></label>
      <label class="${note ? "on" : ""}"><input type="radio" name="cap-kind" value="note" ${note ? "checked" : ""}><b>Note</b><small>Just keep it</small></label>
    </div>
    <div class="grid2">
      <label class="field"><span>Workspace</span><select class="input" id="cap-ws">${wsList.map(w => `<option value="${w.id}" ${w.id === ws ? "selected" : ""}>${esc(w.name)}</option>`).join("")}</select></label>
      ${note ? "" : `<label class="field"><span>Project <small>(optional)</small></span><select class="input" id="cap-project"><option value="">No project</option>${projects.map(x => `<option value="${x.id}" ${x.id === proj ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>`}
    </div>
    ${note ? "" : `<div class="grid2">
      <div class="field"><span>Due date <small>(optional)</small></span><div class="dt"><input class="input" type="date" id="cap-due-d" value="${d.due_d}"><input class="input" type="time" id="cap-due-t" value="${d.due_t}" aria-label="Due time"></div>
        <div class="quick"><button type="button" data-act="cap-quick" data-f="due" data-n="0">Today</button><button type="button" data-act="cap-quick" data-f="due" data-n="1">Tomorrow</button><button type="button" data-act="cap-quick" data-f="due" data-n="7">+1 week</button><button type="button" data-act="cap-quick" data-f="due" data-n="">Clear</button></div></div>
      <label class="field"><span>Priority <small>(optional)</small></span><select class="input" id="cap-priority">${PRIORITIES.map(x => `<option value="${x}" ${d.priority === x ? "selected" : ""}>${PRIORITY_LABEL[x]}</option>`).join("")}</select></label>
    </div>
    <button type="button" class="linkbtn" data-act="cap-more">${d.more ? "Fewer details" : "More: follow-up, owner, notes, files…"}</button>
    ${d.more ? `
    <div class="grid2">
      <div class="field"><span>Follow-up <small>(optional)</small></span><div class="dt"><input class="input" type="date" id="cap-fu-d" value="${d.fu_d}"><input class="input" type="time" id="cap-fu-t" value="${d.fu_t}" aria-label="Follow-up time"></div>
        <div class="quick"><button type="button" data-act="cap-quick" data-f="fu" data-n="1">Tomorrow</button><button type="button" data-act="cap-quick" data-f="fu" data-n="3">+3 days</button><button type="button" data-act="cap-quick" data-f="fu" data-n="">Clear</button></div></div>
      <label class="field"><span>Owner</span><select class="input" id="cap-owner">${mem.map(m => `<option value="${m.user_id}" ${m.user_id === d.owner_id ? "selected" : ""}>${esc(nameOf(m.user_id))}${m.user_id === state.user.id ? " (me)" : ""}</option>`).join("")}</select></label>
      <label class="field"><span>Status</span><select class="input" id="cap-status"><option value="">Automatic</option><option value="inbox" ${d.statusPicked && d.status === "inbox" ? "selected" : ""}>Inbox — sort later</option><option value="not_started" ${d.statusPicked && d.status === "not_started" ? "selected" : ""}>Ready to work</option></select></label>
    </div>
    <label class="field"><span>Notes <small>(optional)</small></span><textarea class="input" id="cap-desc" rows="3">${esc(d.description)}</textarea></label>
    <label class="field"><span>Attach files <small>(optional · private · max 25 MB each)</small></span><input class="input" type="file" id="cap-files" multiple></label>` : ""}`}
    <div class="sheet-foot"><button class="btn primary block" type="submit" id="capSave">${note ? "Save note" : "Save task"}</button></div>
    <p class="hint center">Tip: press <kbd>N</kbd> anywhere to capture.</p>
  </form>`;
}
/** The workspace in force: one chosen by hand wins, then a #tag, then a plain-word guess, then the default. */
function effectiveWs(p = parsed()) {
  const d = cap.draft;
  if (d.wsPicked) return d.workspace_id;
  if (p.workspace_id) return p.workspace_id;
  if (p.guess && p.guess.workspace_id && !d.off.has("wsguess")) return p.guess.workspace_id;
  return d.workspace_id;
}

/** What the typed line means: parsed twice so @owner is matched against the chosen workspace's members. */
export function parsed(d = cap.draft) {
  const wsList = activeWorkspaces().filter(w => canWrite(w.id)).map(w => ({ id: w.id, name: w.name }));
  const base = { today: todayISO(state.tz), workspaces: wsList, disabled: d.off };
  const first = parseCapture(d.title, { ...base, members: [] });
  const ws = first.workspace_id || d.workspace_id;
  const out = parseCapture(d.title, { ...base, members: membersOf(ws).map(m => ({ user_id: m.user_id, name: nameOf(m.user_id) })) });
  if (!first.workspace_id) {
    const ids = new Set(wsList.map(w => w.id));
    const g = guessContext(d.title, { workspaces: wsList, projects: state.projects.filter(x => ids.has(x.workspace_id) && !x.archived), contacts: (state.contacts || []).filter(c => ids.has(c.workspace_id)) });
    if (g.workspace_id) {
      out.guess = g;
      const wn = (wsList.find(w => w.id === g.workspace_id) || {}).name;
      if (!d.wsPicked && !d.off.has("wsguess")) out.chips.push({ kind: "wsguess", label: `Workspace: ${wn}${g.why !== wn ? ` (from “${g.why}”)` : ""}` });
      if (g.project_id && !d.project_id && !d.off.has("projguess")) out.chips.push({ kind: "projguess", label: `Project: ${g.project_why}` });
    }
  }
  return out;
}
function chipsHtml() {
  const p = parsed();
  if (!p.chips.length) return `<small class="hint">Write it naturally — <i>Pay Dlusso fabric supplier friday</i>. Dates, workspaces and projects are picked up as you type.</small>`;
  return p.chips.map(c => `<span class="chip on">${esc(c.label)}<button type="button" data-act="cap-chip-off" data-k="${c.kind}" aria-label="Don't use ${esc(c.label)}">${ICON.close}</button></span>`).join("") + `<small class="hint">Picked up from what you typed — tap ✕ to ignore it.</small>`;
}
export function handleCaptureInput(e) {
  if (e.target.id !== "cap-title" || !cap.draft) return false;
  cap.draft.title = e.target.value; if (!e.target.value.trim()) cap.draft.off = new Set();
  const box = $("cap-chips"); if (box) box.innerHTML = chipsHtml();
  const wsSel = $("cap-ws"), want = effectiveWs();
  if (wsSel && wsSel.value !== want && !cap.draft.wsPicked) { wsSel.value = want; }
  const kind = cap.draft.kind || guessKind(cap.draft.title), kr = document.querySelector(`input[name="cap-kind"][value="${kind}"]`);
  if (kr && !kr.checked) { const pos = e.target.selectionStart; rerenderSheet(); const t = $("cap-title"); if (t) { t.focus(); t.setSelectionRange(pos, pos); } }
  return true;
}
function sync() {
  const d = cap.draft; if (!$("cap-title")) return;
  d.title = $("cap-title").value; d.workspace_id = $("cap-ws").value;
  if ($("cap-priority")) d.priority = $("cap-priority").value;
  if ($("cap-project")) d.project_id = $("cap-project").value || null;
  if ($("cap-due-d")) { d.due_d = $("cap-due-d").value; d.due_t = $("cap-due-t").value; }
  if (d.more && $("cap-fu-d")) {
    d.fu_d = $("cap-fu-d").value; d.fu_t = $("cap-fu-t").value; d.owner_id = $("cap-owner").value; d.description = $("cap-desc").value;
    const st = $("cap-status").value; d.statusPicked = !!st; if (st) d.status = st;
  }
}

export function handleCaptureChange(e) {
  const id = e.target.id || "", nm = e.target.name || "";
  if (!id.startsWith("cap-") && nm !== "cap-kind") return false;
  if (nm === "cap-kind") { sync(); cap.draft.kind = e.target.value; rerenderSheet(); return true; }
  if (id === "cap-ws") { sync(); cap.draft.wsPicked = true; cap.draft.project_id = null; cap.draft.off.add("projguess"); if (!membersOf(cap.draft.workspace_id).some(m => m.user_id === cap.draft.owner_id)) cap.draft.owner_id = state.user.id; rerenderSheet(); return true; }
  if (id === "cap-project") { sync(); if (!cap.draft.project_id) cap.draft.off.add("projguess"); return true; }
  sync();
  return true;
}

export async function handleCaptureClick(act, el) {
  if (act === "cap-chip-off") { sync(); cap.draft.off.add(el.dataset.k); if (["wsguess", "projguess"].includes(el.dataset.k)) rerenderSheet(); else { const box = $("cap-chips"); if (box) box.innerHTML = chipsHtml(); } $("cap-title") && $("cap-title").focus(); return true; }
  if (act === "cap-more") { sync(); cap.draft.more = !cap.draft.more; rerenderSheet(); return true; }
  if (act === "cap-quick") {
    sync(); const f = el.dataset.f, n = el.dataset.n;
    cap.draft[f + "_d"] = n === "" ? "" : addDays(todayISO(state.tz), +n);
    if (n === "") cap.draft[f + "_t"] = "";
    rerenderSheet(); return true;
  }
  if (act === "cap-another") { const ws = cap.saved.workspace_id; cap.draft = defaults({ workspace_id: ws, wsPicked: false }); cap.saved = null; rerenderSheet(); setTimeout(() => $("cap-title") && $("cap-title").focus(), 30); return true; }
  if (act === "cap-open") { const id = el.dataset.id; closeSheet(); openTask(id); return true; }
  return false;
}

export async function handleCaptureSubmit(form) {
  if (form.id !== "capForm") return false;
  sync();
  const d = cap.draft;
  if (!d.title.trim()) { toastError("Give the task a title."); $("cap-title").focus(); return true; }
  // apply what was recognised in the typed line; values set explicitly in the form win
  const p = parsed(d);
  d.workspace_id = effectiveWs(p);
  if (!d.project_id && p.guess && p.guess.project_id && !d.off.has("projguess") && p.guess.workspace_id === d.workspace_id) d.project_id = p.guess.project_id;
  if ((d.kind || guessKind(d.title)) === "note") return saveNote(d);
  if (p.title) d.title = p.title;
  if (p.priority) d.priority = p.priority;
  if (p.owner_id && membersOf(d.workspace_id).some(m => m.user_id === p.owner_id)) d.owner_id = p.owner_id;
  if (p.due_d && !d.due_d) { d.due_d = p.due_d; d.due_t = p.due_t || ""; }
  if (p.fu_d && !d.fu_d) { d.fu_d = p.fu_d; d.fu_t = p.fu_t || ""; }
  const btn = $("capSave");
  if (btn.disabled) return true; // duplicate-submission guard
  busy(btn, true);
  const row = {
    title: d.title.trim(), description: d.description.trim() || null, workspace_id: d.workspace_id, project_id: d.project_id || null,
    priority: d.priority, status: d.statusPicked ? d.status : (d.due_d || p.due_d || d.project_id ? "not_started" : "inbox"), owner_id: d.owner_id || state.user.id, progress: 0,
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

/** A note: first line is the title, the whole text is kept as the body. */
async function saveNote(d) {
  const text = d.title.trim().replace(/^(note|notes|idea|fyi|info|minutes|thought)\s*[:\-–]\s*/i, "");
  const first = text.split("\n")[0].slice(0, 120);
  const btn = $("capSave"); if (btn.disabled) return true; busy(btn, true);
  const r = await run(sb.from("notes").insert({ workspace_id: d.workspace_id, kind: "note", title: first || "Note", body: text }).select().single());
  busy(btn, false);
  if (r.error) { toastError(r.error); return true; }
  state.notes.unshift(r.data);
  cap.saved = { ...r.data, isNote: true };
  if (state.prefs.last_ws !== d.workspace_id) savePrefs({ last_ws: d.workspace_id });
  rerenderSheet(); return true;
}
