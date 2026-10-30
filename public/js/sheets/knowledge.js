// Notes, meeting notes, decision records and documents — editors, linking, and the "Notes & documents" panel
// used inside tasks and projects. Files live in private storage and open via 10-minute signed links.
import { esc, todayISO, fmtDate, fmtDateTime, ago } from "../util.js";
import { extractActionItems, fmtBytes, safeFileName } from "../insights.js";
import { state, wsById, projectById, contactById, followUpById, noteById, docById, canWrite, activeWorkspaces, membersOf, nameOf, shortName } from "../store.js";
import { sb, run, linksFor, addLink, removeLink, uploadDocument, documentUrl, deleteDocument, createTask, loadAll } from "../api.js";
import { aiOn, aiCall } from "../assist.js";
import { ICON, $, openSheet, closeSheet, rerenderSheet, sheetHead, toast, toastError, dialog, busy } from "../ui.js";

export const NOTE_KIND = { note: "Note", meeting: "Meeting notes", decision: "Decision" };
export const DOC_CATEGORY = { invoice: "Invoice", receipt: "Receipt", delivery: "Delivery / GRN / GDN", compliance: "Compliance / CoC", contract: "Contract", correspondence: "Correspondence", report: "Report", photo: "Photo", other: "Other" };
const TYPE_LABEL = { task: "Task", project: "Project", contact: "Contact", follow_up: "Follow-up", note: "Note", document: "Document" };
const k = { noteId: null, draft: null, docDraft: null, actions: null, linkTarget: null };
const val = id => ($(id) ? $(id).value.trim() : "");
const parseTags = s => [...new Set(String(s || "").split(",").map(t => t.trim().toLowerCase()).filter(Boolean))].slice(0, 12);

/* ======================= linked records panel (tasks, projects, contacts, follow-ups) ======================= */
export function linkedPanel(type, id, workspace_id) {
  const w = canWrite(workspace_id);
  const items = linksFor(type, id).filter(x => x.type === "note" || x.type === "document");
  const rows = items.map(x => {
    if (x.type === "note") { const n = noteById(x.id); return n ? `<div class="krow"><span class="kico">${ICON.notes}</span><button class="linkbtn" data-act="open-note" data-id="${n.id}">${esc(n.title)}</button><small>${NOTE_KIND[n.kind]} · ${ago(n.updated_at)}</small>${w ? `<button class="iconbtn sm" data-act="unlink" data-link="${x.link.id}" aria-label="Unlink">${ICON.close}</button>` : ""}</div>` : ""; }
    const d = docById(x.id); return d ? `<div class="krow"><span class="kico">${d.kind === "link" ? ICON.link : ICON.download}</span><button class="linkbtn" data-act="open-doc" data-id="${d.id}">${esc(d.title)}</button><small>${DOC_CATEGORY[d.category]}${d.size_bytes ? " · " + fmtBytes(d.size_bytes) : ""}</small>${w ? `<button class="iconbtn sm" data-act="unlink" data-link="${x.link.id}" aria-label="Unlink">${ICON.close}</button>` : ""}</div>` : "";
  }).join("");
  return `<section class="sub kpanel"><div class="sub-h"><h3>Notes & documents</h3><span class="c">${items.length}</span></div>
    <div class="klist">${rows || `<p class="hint">Nothing attached yet.</p>`}</div>
    ${w ? `<div class="btnrow">
      <label class="btn sm filebtn">${ICON.download}Attach file<input type="file" data-act="attach-file" data-type="${type}" data-id="${id}" data-ws="${workspace_id}" hidden></label>
      <button class="btn sm" data-act="attach-link" data-type="${type}" data-id="${id}" data-ws="${workspace_id}">${ICON.link}Add link</button>
      <button class="btn sm" data-act="new-note-for" data-type="${type}" data-id="${id}" data-ws="${workspace_id}">${ICON.notes}New note</button>
      <button class="btn sm" data-act="link-existing" data-type="${type}" data-id="${id}" data-ws="${workspace_id}">Link existing…</button></div>` : ""}
  </section>`;
}

/* ======================= note editor ======================= */
export function openNote(id, ctx = {}) {
  if (id && !noteById(id)) { toastError("That note isn't available."); return; }
  k.noteId = id || null; k.actions = null;
  k.draft = id ? null : { kind: ctx.kind || "note", workspace_id: ctx.workspace_id || state.prefs.last_ws || (activeWorkspaces().find(w => canWrite(w.id)) || {}).id, title: "", body: "", tags: [], meeting_date: ctx.kind === "meeting" ? todayISO(state.tz) : null, linkTo: ctx.linkTo || null };
  openSheet(renderNote, { wide: true });
}
function renderNote(sh) {
  const n = k.noteId ? noteById(k.noteId) : k.draft;
  if (!n) { closeSheet(); return; }
  const isNew = !k.noteId, w = canWrite(n.workspace_id), ro = w ? "" : "disabled";
  const wsList = activeWorkspaces().filter(x => canWrite(x.id) || x.id === n.workspace_id);
  sh.innerHTML = sheetHead(isNew ? `New ${NOTE_KIND[n.kind].toLowerCase()}` : NOTE_KIND[n.kind], isNew ? "" : `${esc((wsById(n.workspace_id) || {}).name || "")} · by ${esc(shortName(n.created_by))} · updated ${ago(n.updated_at)}`) + `
  <form id="noteForm" class="sh-body" novalidate>
    ${isNew ? `<div class="segbtn">${Object.entries(NOTE_KIND).map(([key, l]) => `<button type="button" class="${n.kind === key ? "on" : ""}" data-act="note-kind" data-k="${key}">${l}</button>`).join("")}</div>` : ""}
    <input class="title-input" id="nf-title" value="${esc(n.title)}" placeholder="${n.kind === "meeting" ? "e.g. Weekly logistics review with Adil" : n.kind === "decision" ? "e.g. Switch forwarder for KSA lane" : "Title"}" ${ro} autofocus>
    <div class="grid3">
      <label class="field"><span>Workspace</span><select class="input" id="nf-ws" ${isNew ? "" : "disabled"}>${wsList.map(x => `<option value="${x.id}" ${x.id === n.workspace_id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
      ${n.kind === "meeting" ? `<label class="field"><span>Meeting date</span><input class="input" type="date" id="nf-mdate" value="${n.meeting_date || ""}" ${ro}></label>
        <label class="field"><span>Attendees</span><input class="input" id="nf-attendees" value="${esc(n.attendees || "")}" placeholder="Names, comma separated" ${ro}></label>` : ""}
      ${n.kind === "decision" ? `<label class="field"><span>Status</span><select class="input" id="nf-dstatus" ${ro}>${[["proposed", "Proposed — needs a decision"], ["decided", "Decided"], ["superseded", "Superseded"]].map(([key, l]) => `<option value="${key}" ${(n.decision_status || "proposed") === key ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="field"><span>Decided on</span><input class="input" type="date" id="nf-ddate" value="${n.decided_on || ""}" ${ro}></label>` : ""}
    </div>
    ${n.kind === "decision" ? `<label class="field"><span>Decision</span><textarea class="input" id="nf-decision" rows="2" placeholder="What was (or needs to be) decided" ${ro}>${esc(n.decision || "")}</textarea></label>
      <label class="field"><span>Rationale</span><textarea class="input" id="nf-rationale" rows="2" placeholder="Why — options considered, trade-offs" ${ro}>${esc(n.rationale || "")}</textarea></label>` : ""}
    <label class="field"><span>${n.kind === "meeting" ? "Notes <small>(write action items as “- [ ] Do X @Name”)</small>" : n.kind === "decision" ? "Context" : "Note"}</span>
      <textarea class="input notebody" id="nf-body" rows="${n.kind === "note" ? 12 : 9}" ${ro}>${esc(n.body || "")}</textarea></label>
    <label class="field"><span>Tags <small>(comma separated)</small></span><input class="input" id="nf-tags" value="${esc((n.tags || []).join(", "))}" placeholder="e.g. customs, ksa, supplier" ${ro}></label>
    ${w ? `<div class="sheet-foot"><button class="btn primary" type="submit" id="nfSave">${isNew ? "Save" : "Save changes"}</button>
      ${!isNew && n.kind === "meeting" ? `<button type="button" class="btn" data-act="note-actions">${ICON.tasks}Create tasks from action items</button>${aiOn() ? `<button type="button" class="btn" data-act="note-actions-ai" id="nfAi">✨ Suggest with AI</button>` : ""}` : ""}
      ${!isNew ? `<button type="button" class="btn" data-act="note-pin">${n.pinned ? "Unpin" : "Pin"}</button><button type="button" class="btn danger" data-act="note-delete">${ICON.trash}Delete</button>` : ""}</div>` : ""}
  </form>
  ${k.actions ? actionsPanel(n) : ""}
  ${!isNew ? `<div class="sh-body">${linksSection("note", n.id, n.workspace_id)}</div>` : ""}`;
}
function linksSection(type, id, ws) {
  const w = canWrite(ws);
  const items = linksFor(type, id).filter(x => x.type !== "note" || type !== "note" || true);
  return `<section class="sub"><div class="sub-h"><h3>Linked records</h3><span class="c">${items.length}</span></div>
    <div class="klist">${items.map(x => `<div class="krow"><span class="kico">${x.type === "task" ? ICON.tasks : x.type === "project" ? ICON.folder : x.type === "contact" ? ICON.user : x.type === "follow_up" ? ICON.phone : x.type === "document" ? ICON.download : ICON.notes}</span>${linkLabel(x)}<small>${TYPE_LABEL[x.type]}</small>${w ? `<button class="iconbtn sm" data-act="unlink" data-link="${x.link.id}" aria-label="Unlink">${ICON.close}</button>` : ""}</div>`).join("") || `<p class="hint">Link this to the tasks, projects, contacts or follow-ups it relates to.</p>`}</div>
    ${w ? `<div class="addrow"><select class="input" id="lk-type" style="max-width:9.5em">${["task", "project", "contact", "follow_up"].map(t => `<option value="${t}">${TYPE_LABEL[t]}</option>`).join("")}</select><input class="input" id="lk-q" placeholder="Search to link…" autocomplete="off" data-from-type="${type}" data-from-id="${id}" data-ws="${ws}"></div><div id="lk-results" class="depres"></div>` : ""}
  </section>`;
}
function linkLabel(x) {
  if (x.type === "task") { const t = state.taskById.get(x.id); return t ? `<button class="linkbtn" data-act="open-task" data-id="${t.id}">${esc(t.title)}</button>` : `<span class="hint">Task not available</span>`; }
  if (x.type === "project") { const p = projectById(x.id); return p ? `<a href="#/p/${p.id}" data-act="close-sheet">${esc(p.name)}</a>` : `<span class="hint">Project not available</span>`; }
  if (x.type === "contact") { const c = contactById(x.id); return c ? `<button class="linkbtn" data-act="open-contact" data-id="${c.id}">${esc(c.name)}</button>` : ""; }
  if (x.type === "follow_up") { const f = followUpById(x.id); return f ? `<button class="linkbtn" data-act="open-followup" data-id="${f.id}">${esc(f.subject)}</button>` : ""; }
  if (x.type === "document") { const d = docById(x.id); return d ? `<button class="linkbtn" data-act="open-doc" data-id="${d.id}">${esc(d.title)}</button>` : ""; }
  const n = noteById(x.id); return n ? `<button class="linkbtn" data-act="open-note" data-id="${n.id}">${esc(n.title)}</button>` : "";
}
function actionsPanel(n) {
  const mem = membersOf(n.workspace_id);
  return `<section class="sh-body sub actions-review"><div class="sub-h"><h3>Proposed tasks from this meeting</h3><span class="c">${k.actions.length}</span></div>
    ${k.actions.length ? `<p class="hint">${k.aiSource ? "Suggested by AI from your notes — check each one. " : ""}Review before creating. Nothing is created until you confirm. No deadlines are added — set them on each task when you commit.</p>
    <ul class="crit">${k.actions.map((a, i) => `<li><label><input type="checkbox" data-act="ai-toggle" data-i="${i}" ${a.on ? "checked" : ""}> <input class="input sm" id="ai-title-${i}" value="${esc(a.title)}" style="flex:1"></label>
      <select class="input sm" id="ai-owner-${i}">${mem.map(m => `<option value="${m.user_id}" ${m.user_id === a.owner_id ? "selected" : ""}>${esc(nameOf(m.user_id))}</option>`).join("")}</select></li>`).join("")}</ul>
    <div class="btnrow"><button class="btn primary" data-act="ai-create">Create ${k.actions.filter(a => a.on).length} task(s)</button><button class="btn" data-act="ai-cancel">Cancel</button></div>`
      : `<p class="hint">No action items found. Write them as lines starting with “- [ ]”, “TODO:” or “Action:”.</p><button class="btn" data-act="ai-cancel">Close</button>`}
  </section>`;
}
function readNote() {
  const base = k.noteId ? noteById(k.noteId) : k.draft;
  const row = { title: val("nf-title"), body: $("nf-body") ? $("nf-body").value : "", tags: parseTags(val("nf-tags")) };
  if (!k.noteId) { row.kind = base.kind; row.workspace_id = val("nf-ws"); }
  const kind = base.kind;
  if (kind === "meeting") { row.meeting_date = val("nf-mdate") || null; row.attendees = val("nf-attendees") || null; }
  if (kind === "decision") { row.decision = val("nf-decision"); row.rationale = val("nf-rationale") || null; row.decision_status = val("nf-dstatus") || "proposed"; row.decided_on = val("nf-ddate") || null; }
  return row;
}
async function saveNote() {
  const row = readNote();
  if (!row.title) return toastError("Give it a title.");
  const kind = k.noteId ? noteById(k.noteId).kind : k.draft.kind;
  if (kind === "decision" && !row.decision) return toastError("Write down the decision.");
  if (kind === "decision" && row.decision_status === "decided" && !row.decided_on) row.decided_on = todayISO(state.tz);
  const btn = $("nfSave"); busy(btn, true);
  const r = k.noteId ? await run(sb.from("notes").update(row).eq("id", k.noteId).select().single()) : await run(sb.from("notes").insert(row).select().single());
  busy(btn, false);
  if (r.error) return toastError(r.error);
  const saved = r.data; delete saved.search;
  if (k.noteId) Object.assign(noteById(k.noteId), saved);
  else {
    state.notes.unshift(saved);
    if (k.draft.linkTo) { const lt = k.draft.linkTo; const l = await addLink(saved.workspace_id, "note", saved.id, lt.type, lt.id); if (l.error) toastError(l.error); }
    k.noteId = saved.id; k.draft = null;
  }
  rerenderSheet(); toast("Saved");
}

/* ======================= documents ======================= */
export async function openDocument(id) {
  const d = docById(id); if (!d) return toastError("That document isn't available.");
  openSheet(sh => renderDoc(sh, id));
}
function renderDoc(sh, id) {
  const d = docById(id); if (!d) { closeSheet(); return; }
  const w = canWrite(d.workspace_id);
  sh.innerHTML = sheetHead(d.title, `${DOC_CATEGORY[d.category]} · ${esc((wsById(d.workspace_id) || {}).name || "")} · added by ${esc(shortName(d.created_by))} ${ago(d.created_at)}`) + `
  <div class="sh-body">
    <div class="docbox"><span class="kico big">${d.kind === "link" ? ICON.link : ICON.notes}</span><div class="tmain"><div class="ttitle">${esc(d.kind === "link" ? d.url : d.storage_path.split("/").pop())}</div>
      <div class="tmeta">${d.kind === "file" ? `${esc(d.mime_type || "file")} · ${fmtBytes(d.size_bytes || 0)} · stored privately` : "External link"}</div></div>
      <button class="btn primary" data-act="doc-open" data-id="${d.id}">${d.kind === "link" ? "Open link" : "Open"}</button></div>
    ${d.kind === "file" ? `<p class="hint">${ICON.lock} Opens through a private link that expires in 10 minutes.</p>` : ""}
    <form id="docEditForm" style="display:grid;gap:12px" novalidate>
      <div class="grid2"><label class="field"><span>Title</span><input class="input" id="de-title" value="${esc(d.title)}" ${w ? "" : "disabled"}></label>
      <label class="field"><span>Category</span><select class="input" id="de-cat" ${w ? "" : "disabled"}>${Object.entries(DOC_CATEGORY).map(([key, l]) => `<option value="${key}" ${d.category === key ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
      <label class="field"><span>Tags</span><input class="input" id="de-tags" value="${esc((d.tags || []).join(", "))}" ${w ? "" : "disabled"}></label>
      <label class="field"><span>Notes</span><textarea class="input" id="de-notes" rows="2" ${w ? "" : "disabled"}>${esc(d.notes || "")}</textarea></label>
      ${w ? `<div class="sheet-foot"><button class="btn primary" type="submit" id="deSave">Save</button><button type="button" class="btn danger" data-act="doc-delete" data-id="${d.id}">${ICON.trash}Delete</button></div>` : ""}
    </form>
    ${linksSection("document", d.id, d.workspace_id)}
  </div>`;
}

export function openUpload(ctx = {}) {
  k.docDraft = { workspace_id: ctx.workspace_id || state.prefs.last_ws || (activeWorkspaces().find(w => canWrite(w.id)) || {}).id, linkTo: ctx.linkTo || null, mode: ctx.mode || "file" };
  openSheet(renderUpload);
}
function renderUpload(sh) {
  const d = k.docDraft;
  sh.innerHTML = sheetHead(d.mode === "file" ? "Upload document" : "Add a link", d.mode === "file" ? "Files are stored privately (max 25 MB) and open through expiring links." : "Store a link to a document kept elsewhere (Drive, email, portal).") + `
  <form id="uploadForm" class="sh-body" novalidate>
    <div class="segbtn"><button type="button" class="${d.mode === "file" ? "on" : ""}" data-act="up-mode" data-m="file">File</button><button type="button" class="${d.mode === "link" ? "on" : ""}" data-act="up-mode" data-m="link">Link</button></div>
    ${d.mode === "file" ? `<label class="field"><span>File</span><input class="input" type="file" id="up-file"></label>` : `<label class="field"><span>URL</span><input class="input" type="url" id="up-url" placeholder="https://…"></label>`}
    <div class="grid2">
      <label class="field"><span>Title</span><input class="input" id="up-title" placeholder="Defaults to the file name"></label>
      <label class="field"><span>Workspace</span><select class="input" id="up-ws" ${d.linkTo ? "disabled" : ""}>${activeWorkspaces().filter(w => canWrite(w.id)).map(w => `<option value="${w.id}" ${w.id === d.workspace_id ? "selected" : ""}>${esc(w.name)}</option>`).join("")}</select></label>
      <label class="field"><span>Category</span><select class="input" id="up-cat">${Object.entries(DOC_CATEGORY).map(([key, l]) => `<option value="${key}">${l}</option>`).join("")}</select></label>
      <label class="field"><span>Tags</span><input class="input" id="up-tags" placeholder="e.g. po-0031, customs"></label>
    </div>
    <div class="sheet-foot"><button class="btn primary block" type="submit" id="upSave">${d.mode === "file" ? "Upload" : "Save link"}</button></div>
  </form>`;
}
async function submitUpload() {
  const d = k.docDraft, ws = d.linkTo ? d.workspace_id : val("up-ws");
  const meta = { workspace_id: ws, title: val("up-title"), category: val("up-cat"), tags: parseTags(val("up-tags")) };
  const btn = $("upSave"); if (btn.disabled) return; busy(btn, true, d.mode === "file" ? "Uploading…" : "Saving…");
  let r;
  if (d.mode === "file") {
    const f = $("up-file").files[0];
    if (!f) { busy(btn, false); return toastError("Choose a file."); }
    r = await uploadDocument(f, meta, safeFileName);
  } else {
    const url = val("up-url");
    if (!/^https?:\/\//i.test(url)) { busy(btn, false); return toastError("Enter a link starting with http:// or https://"); }
    r = await run(sb.from("documents").insert({ ...meta, title: meta.title || url.replace(/^https?:\/\//, "").slice(0, 120), kind: "link", url }).select().single());
    if (r.data) state.documents.unshift(r.data);
  }
  busy(btn, false);
  if (r.error) return toastError(r.error);
  if (d.linkTo) { const l = await addLink(ws, "document", r.data.id, d.linkTo.type, d.linkTo.id); if (l.error) toastError(l.error); }
  closeSheet(); toast(d.mode === "file" ? "Uploaded" : "Link saved");
}

/* direct attach from a panel (file chooser change) */
export async function attachFile(input) {
  const f = input.files[0]; if (!f) return;
  const { type, id, ws } = input.dataset;
  toast(`Uploading ${f.name}…`);
  const r = await uploadDocument(f, { workspace_id: ws, title: f.name }, safeFileName);
  input.value = "";
  if (r.error) return toastError(r.error);
  const l = await addLink(ws, "document", r.data.id, type, id);
  if (l.error) return toastError(l.error);
  toast("Attached"); rerenderSheet();
}

/* ======================= events ======================= */
export async function handleKnowledgeClick(act, el) {
  switch (act) {
    case "open-note": openNote(el.dataset.id); return true;
    case "open-doc": openDocument(el.dataset.id); return true;
    case "new-note": openNote(null, { kind: el.dataset.kind || "note", workspace_id: el.dataset.ws || undefined }); return true;
    case "new-note-for": openNote(null, { workspace_id: el.dataset.ws, linkTo: { type: el.dataset.type, id: el.dataset.id } }); return true;
    case "upload-doc": openUpload({ workspace_id: el.dataset.ws || undefined, mode: el.dataset.mode || "file" }); return true;
    case "attach-link": openUpload({ workspace_id: el.dataset.ws, linkTo: { type: el.dataset.type, id: el.dataset.id }, mode: "link" }); return true;
    case "up-mode": k.docDraft.mode = el.dataset.m; rerenderSheet(); return true;
    case "note-kind": { const d = k.draft; d.title = val("nf-title"); d.body = $("nf-body").value; d.workspace_id = val("nf-ws"); d.kind = el.dataset.k; if (d.kind === "meeting" && !d.meeting_date) d.meeting_date = todayISO(state.tz); rerenderSheet(); return true; }
    case "link-existing": {
      const { type, id, ws } = el.dataset;
      const opts = [...state.notes.filter(n => n.workspace_id === ws).map(n => ({ t: "note", id: n.id, label: `${NOTE_KIND[n.kind]}: ${n.title}` })), ...state.documents.filter(d => d.workspace_id === ws).map(d => ({ t: "document", id: d.id, label: `Document: ${d.title}` }))];
      if (!opts.length) { toast("No notes or documents in this workspace yet."); return true; }
      const q = await dialog({ title: "Link a note or document", text: opts.slice(0, 25).map((o, i) => `${i + 1}. ${o.label}`).join("\n"), input: { label: "Number from the list", required: true }, confirm: "Link" });
      const pick = opts[+q - 1]; if (!pick) { if (q) toastError("Pick a number from the list."); return true; }
      const r = await addLink(ws, pick.t, pick.id, type, id); r.error ? toastError(r.error) : toast("Linked"); rerenderSheet(); return true;
    }
    case "unlink": { const r = await removeLink(el.dataset.link); r.error ? toastError(r.error) : toast("Unlinked"); rerenderSheet(); return true; }
    case "lk-pick": {
      const r = await addLink(el.dataset.ws, el.dataset.fromType, el.dataset.fromId, el.dataset.toType, el.dataset.toId);
      r.error ? toastError(r.error) : toast("Linked"); rerenderSheet(); return true;
    }
    case "note-pin": { const n = noteById(k.noteId); const r = await run(sb.from("notes").update({ pinned: !n.pinned }).eq("id", n.id)); if (r.error) return toastError(r.error), true; n.pinned = !n.pinned; rerenderSheet(); return true; }
    case "note-delete": {
      const n = noteById(k.noteId);
      if (!(await dialog({ title: `Delete "${n.title}"?`, text: "It's removed from Notes and unlinked from records. The deletion is kept in the audit log.", confirm: "Delete", danger: true }))) return true;
      const r = await run(sb.from("notes").update({ deleted_at: new Date().toISOString() }).eq("id", n.id)); if (r.error) return toastError(r.error), true;
      state.notes = state.notes.filter(x => x.id !== n.id); closeSheet(); toast("Note deleted"); return true;
    }
    case "note-actions": { k.aiSource = false;
      const n = noteById(k.noteId); const body = $("nf-body") ? $("nf-body").value : n.body;
      k.actions = extractActionItems(body).map(a => {
        const m = a.owner_hint && membersOf(n.workspace_id).find(x => nameOf(x.user_id).toLowerCase().startsWith(a.owner_hint.toLowerCase()));
        return { title: a.title.replace(/@\S+/g, "").trim() || a.title, owner_id: m ? m.user_id : state.user.id, on: true };
      });
      rerenderSheet(); return true;
    }
    case "note-actions-ai": {
      const n = noteById(k.noteId), body = $("nf-body") ? $("nf-body").value : n.body;
      if (!body.trim()) return toastError("Write some notes first."), true;
      const btn = $("nfAi"); busy(btn, true, "Reading notes…");
      const r = await aiCall("action_items", { notes: body, people: membersOf(n.workspace_id).map(m => nameOf(m.user_id)) });
      busy(btn, false);
      if (r.error) return toastError(r.error), true;
      k.actions = r.data.items.map(a => {
        const m = a.owner && membersOf(n.workspace_id).find(x => nameOf(x.user_id).toLowerCase().startsWith(a.owner.toLowerCase().split(" ")[0]));
        return { title: a.title, owner_id: m ? m.user_id : state.user.id, on: true };
      });
      k.aiSource = true; rerenderSheet(); return true;
    }
    case "ai-toggle": k.actions[+el.dataset.i].on = el.checked; return true;
    case "ai-cancel": k.actions = null; rerenderSheet(); return true;
    case "ai-create": {
      const n = noteById(k.noteId); let made = 0, fails = [];
      for (let i = 0; i < k.actions.length; i++) {
        const a = k.actions[i]; if (!a.on) continue;
        const title = val(`ai-title-${i}`); if (!title) continue;
        const r = await createTask({ title, workspace_id: n.workspace_id, status: "not_started", priority: "medium", owner_id: val(`ai-owner-${i}`) || state.user.id, description: `From meeting: ${n.title}${n.meeting_date ? " (" + fmtDate(n.meeting_date) + ")" : ""}` });
        if (r.error) { fails.push(`${title}: ${r.error}`); continue; }
        await addLink(n.workspace_id, "note", n.id, "task", r.data.id); made++;
      }
      k.actions = null; rerenderSheet();
      toast(`${made} task(s) created and linked to this meeting`);
      if (fails.length) toastError(fails[0]);
      return true;
    }
    case "doc-open": {
      const d = docById(el.dataset.id);
      const win = window.open("", "_blank"); // open synchronously so popup blockers allow it
      const r = await documentUrl(d);
      if (r.error) { if (win) win.close(); return toastError(r.error), true; }
      if (win) win.location = r.data; else location.href = r.data;
      return true;
    }
    case "doc-delete": {
      const d = docById(el.dataset.id);
      if (!(await dialog({ title: `Delete "${d.title}"?`, text: d.kind === "file" ? "The file is permanently removed from storage and unlinked everywhere." : "The link is removed and unlinked everywhere.", confirm: "Delete", danger: true }))) return true;
      const r = await deleteDocument(d); if (r.error) return toastError(r.error), true;
      closeSheet(); toast("Document deleted"); return true;
    }
  }
  return false;
}
export async function handleKnowledgeSubmit(form) {
  if (form.id === "noteForm") { await saveNote(); return true; }
  if (form.id === "uploadForm") { await submitUpload(); return true; }
  if (form.id === "docEditForm") {
    const d = docById(document.querySelector('[data-act="doc-delete"]').dataset.id);
    const row = { title: val("de-title") || d.title, category: val("de-cat"), tags: parseTags(val("de-tags")), notes: val("de-notes") || null };
    const btn = $("deSave"); busy(btn, true);
    const r = await run(sb.from("documents").update(row).eq("id", d.id).select().single()); busy(btn, false);
    if (r.error) return toastError(r.error), true;
    Object.assign(d, r.data); rerenderSheet(); toast("Saved"); return true;
  }
  return false;
}
export async function handleKnowledgeChange(e) {
  if (e.target.dataset && e.target.dataset.act === "attach-file") { await attachFile(e.target); return true; }
  return false;
}
export function handleKnowledgeInput(e) {
  if (e.target.id !== "lk-q") return false;
  const q = e.target.value.trim().toLowerCase(), box = $("lk-results"); if (!box) return true;
  const type = val("lk-type"), { fromType, fromId, ws } = e.target.dataset;
  if (q.length < 2) { box.innerHTML = ""; return true; }
  const src = type === "task" ? state.tasks.filter(t => !t.deleted_at).map(t => ({ id: t.id, ws: t.workspace_id, label: t.title }))
    : type === "project" ? state.projects.map(p => ({ id: p.id, ws: p.workspace_id, label: p.name }))
    : type === "contact" ? state.contacts.map(c => ({ id: c.id, ws: c.workspace_id, label: c.name + (c.organisation ? " · " + c.organisation : "") }))
    : state.followUps.map(f => ({ id: f.id, ws: f.workspace_id, label: f.subject }));
  const hits = src.filter(x => x.ws === ws && x.label.toLowerCase().includes(q)).slice(0, 8);
  box.innerHTML = hits.map(x => `<button class="depopt" data-act="lk-pick" data-ws="${ws}" data-from-type="${fromType}" data-from-id="${fromId}" data-to-type="${type}" data-to-id="${x.id}">${esc(x.label)}</button>`).join("") || `<p class="hint">Nothing matching in this workspace.</p>`;
  return true;
}
