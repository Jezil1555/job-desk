// Notes & Documents screen: notes, meeting notes, decision log and the document library.
import { esc, fmtDate, ago } from "../util.js";
import { fmtBytes } from "../insights.js";
import { state, wsById, activeWorkspaces, canWrite, shortName } from "../store.js";
import { linksFor } from "../api.js";
import { ICON, emptyState, wsDot } from "../ui.js";
import { NOTE_KIND, DOC_CATEGORY } from "../sheets/knowledge.js";

export const NOTE_TABS = { notes: "Notes", meetings: "Meetings", decisions: "Decisions", documents: "Documents" };
const TAB_KIND = { notes: "note", meetings: "meeting", decisions: "decision" };

export function renderNotes(view, tab = "notes") {
  if (!NOTE_TABS[tab]) tab = "notes";
  const f = state.ui.kn || (state.ui.kn = { ws: "", q: "", tag: "", cat: "", dstatus: "" });
  const liveWs = new Set(activeWorkspaces().map(w => w.id));
  const inScope = r => liveWs.has(r.workspace_id) && (!f.ws || r.workspace_id === f.ws) && !r.deleted_at;
  const q = f.q.trim().toLowerCase();
  const anyWritable = activeWorkspaces().some(w => canWrite(w.id));

  let body = "", items = [];
  if (tab === "documents") {
    items = state.documents.filter(inScope).filter(d => (!f.cat || d.category === f.cat) && (!f.tag || (d.tags || []).includes(f.tag))
      && (!q || [d.title, d.notes, (d.tags || []).join(" "), d.storage_path, d.url].join(" ").toLowerCase().includes(q)));
    body = items.length ? `<div class="list">${items.map(docRow).join("")}</div>`
      : emptyState("No documents yet", "Upload invoices, delivery notes, certificates or contracts — they're stored privately and open through links that expire after 10 minutes.", anyWritable ? `<button class="btn primary" data-act="upload-doc">${ICON.plus}Upload document</button>` : "");
  } else {
    const kind = TAB_KIND[tab];
    items = state.notes.filter(inScope).filter(n => n.kind === kind && (!f.tag || (n.tags || []).includes(f.tag))
      && (kind !== "decision" || !f.dstatus || n.decision_status === f.dstatus)
      && (!q || [n.title, n.body, n.decision, n.rationale, n.attendees, (n.tags || []).join(" ")].join(" ").toLowerCase().includes(q)))
      .sort((a, b) => (b.pinned - a.pinned) || ((kind === "meeting" ? (b.meeting_date || "") .localeCompare(a.meeting_date || "") : 0)) || b.updated_at.localeCompare(a.updated_at));
    const blurb = { note: ["No notes yet", "Capture context, research and working notes, and link them to the tasks and projects they belong to."],
      meeting: ["No meeting notes yet", "Record who attended and what was agreed. Write action items as “- [ ] Do X @Name” and turn them into tasks after review."],
      decision: ["No decisions recorded", "Keep a decision log: what was decided, why, and when — so nobody has to remember it."] }[kind];
    body = items.length ? `<div class="list">${items.map(noteRow).join("")}</div>`
      : emptyState(blurb[0], blurb[1], anyWritable ? `<button class="btn primary" data-act="new-note" data-kind="${kind}">${ICON.plus}New ${NOTE_KIND[kind].toLowerCase()}</button>` : "");
  }

  const tagPool = [...new Set((tab === "documents" ? state.documents : state.notes).filter(inScope).flatMap(r => r.tags || []))].sort();
  const pending = state.notes.filter(n => inScope(n) && n.kind === "decision" && n.decision_status === "proposed").length;
  view.innerHTML = `
  <div class="page-head"><div><h1>Notes & Documents</h1><p class="sub">${state.notes.filter(inScope).length} notes · ${state.documents.filter(inScope).length} documents${pending ? ` · <b>${pending} decision${pending > 1 ? "s" : ""} pending</b>` : ""}</p></div>
    ${anyWritable ? `<div class="btnrow">${tab === "documents" ? `<button class="btn" data-act="upload-doc" data-mode="link">${ICON.link}Add link</button><button class="btn primary" data-act="upload-doc">${ICON.plus}Upload</button>`
      : `<button class="btn primary" data-act="new-note" data-kind="${TAB_KIND[tab]}">${ICON.plus}New ${NOTE_KIND[TAB_KIND[tab]].toLowerCase()}</button>`}</div>` : ""}</div>
  <div class="viewtabs">${Object.entries(NOTE_TABS).map(([key, l]) => `<a href="#/notes/${key}" class="${tab === key ? "on" : ""}">${l}</a>`).join("")}</div>
  <div class="filters kfilters">
    <input class="input" id="kn-q" type="search" placeholder="Filter ${NOTE_TABS[tab].toLowerCase()}…" value="${esc(f.q)}">
    <select class="input" id="kn-ws"><option value="">All workspaces</option>${activeWorkspaces().map(w => `<option value="${w.id}" ${f.ws === w.id ? "selected" : ""}>${esc(w.name)}</option>`).join("")}</select>
    ${tagPool.length ? `<select class="input" id="kn-tag"><option value="">Any tag</option>${tagPool.map(t => `<option ${f.tag === t ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>` : ""}
    ${tab === "documents" ? `<select class="input" id="kn-cat"><option value="">Any category</option>${Object.entries(DOC_CATEGORY).map(([key, l]) => `<option value="${key}" ${f.cat === key ? "selected" : ""}>${l}</option>`).join("")}</select>` : ""}
    ${tab === "decisions" ? `<select class="input" id="kn-dstatus"><option value="">Any status</option>${[["proposed", "Pending decision"], ["decided", "Decided"], ["superseded", "Superseded"]].map(([key, l]) => `<option value="${key}" ${f.dstatus === key ? "selected" : ""}>${l}</option>`).join("")}</select>` : ""}
  </div>
  ${body}`;
}

function linkCount(type, id) { const n = linksFor(type, id).length; return n ? `<span class="chip">${ICON.link}${n}</span>` : ""; }
function noteRow(n) {
  const ws = wsById(n.workspace_id);
  const snippet = (n.kind === "decision" ? n.decision : n.body || "").replace(/\s+/g, " ").slice(0, 160);
  const meta = n.kind === "meeting" ? `${n.meeting_date ? fmtDate(n.meeting_date) : "No date"}${n.attendees ? " · " + esc(n.attendees) : ""}`
    : n.kind === "decision" ? `<span class="pill ds-${n.decision_status}">${{ proposed: "Pending", decided: "Decided", superseded: "Superseded" }[n.decision_status]}</span>${n.decided_on ? " " + fmtDate(n.decided_on) : ""}`
    : `Updated ${ago(n.updated_at)} by ${esc(shortName(n.created_by))}`;
  return `<div class="trow note-row" data-act="open-note" data-id="${n.id}" role="button" tabindex="0">
    <span class="kico">${n.pinned ? "📌" : ICON.notes}</span>
    <div class="tmain"><div class="ttitle">${esc(n.title)}</div>
      ${snippet ? `<div class="snip">${esc(snippet)}</div>` : ""}
      <div class="tmeta">${wsDot(ws)}${esc(ws ? ws.name : "")} · ${meta} ${(n.tags || []).map(t => `<span class="tag">#${esc(t)}</span>`).join("")} ${linkCount("note", n.id)}</div></div></div>`;
}
function docRow(d) {
  const ws = wsById(d.workspace_id);
  return `<div class="trow" data-act="open-doc" data-id="${d.id}" role="button" tabindex="0">
    <span class="kico">${d.kind === "link" ? ICON.link : ICON.download}</span>
    <div class="tmain"><div class="ttitle">${esc(d.title)}</div>
      <div class="tmeta">${wsDot(ws)}${esc(ws ? ws.name : "")} · ${DOC_CATEGORY[d.category]}${d.size_bytes ? " · " + fmtBytes(d.size_bytes) : d.kind === "link" ? " · link" : ""} · ${ago(d.created_at)} ${(d.tags || []).map(t => `<span class="tag">#${esc(t)}</span>`).join("")} ${linkCount("document", d.id)}</div></div></div>`;
}

export function handleNotesChange(e, rerender) {
  const map = { "kn-ws": "ws", "kn-tag": "tag", "kn-cat": "cat", "kn-dstatus": "dstatus" };
  if (!map[e.target.id]) return false;
  state.ui.kn[map[e.target.id]] = e.target.value; rerender(); return true;
}
export function handleNotesInput(e, rerenderKeepFocus) {
  if (e.target.id !== "kn-q") return false;
  state.ui.kn.q = e.target.value; rerenderKeepFocus("kn-q"); return true;
}
