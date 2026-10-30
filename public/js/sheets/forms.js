// Forms for projects, milestones, follow-ups, workspaces (incl. people & roles) and contacts.
import { esc, zonedDate, zonedTime, zonedToISO, fmtDate, fmtDateTime, todayISO, addDays, ago } from "../util.js";
import { PRIORITIES, PRIORITY_LABEL, PROJECT_STATUS_LABEL } from "../logic.js";
import { emit, state, wsById, projectById, contactById, followUpById, membersOf, nameOf, shortName, canWrite, isWsOwner, activeWorkspaces } from "../store.js";
import { sb, run, loadAll, refreshHealthSoon } from "../api.js";
import { ICON, $, openSheet, closeSheet, rerenderSheet, sheetHead, toast, toastError, dialog, busy, avatar } from "../ui.js";
import { openTask } from "./task.js";

const COLORS = ["#1f6aa0", "#6b4b8a", "#2e7d6b", "#c0612b", "#b3352b", "#8a6d1f", "#3d5a80", "#5f6b78"];
const f = { kind: null, id: null, ctx: {}, msg: null, logs: null };
const val = id => ($(id) ? $(id).value.trim() : "");
const opt = (v, cur, label) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(label)}</option>`;

/* ======================= Projects ======================= */
export function openProjectForm(id, ctx = {}) { f.kind = "project"; f.id = id || null; f.ctx = ctx; openSheet(renderProject); }
function renderProject(sh) {
  const p = f.id ? projectById(f.id) : { name: "", workspace_id: f.ctx.workspace_id || (activeWorkspaces().find(w => canWrite(w.id)) || {}).id, priority: "medium", owner_id: state.user.id };
  const wsList = activeWorkspaces().filter(w => canWrite(w.id));
  const mem = membersOf(p.workspace_id);
  const h = f.id ? state.healthById.get(f.id) : null;
  sh.innerHTML = sheetHead(f.id ? "Project settings" : "New project") + `
  <form id="projectForm" class="sh-body" novalidate>
    <label class="field"><span>Name</span><input class="input" id="pf-name" value="${esc(p.name)}" maxlength="120" autofocus required></label>
    <div class="grid2">
      <label class="field"><span>Workspace</span><select class="input" id="pf-ws" ${f.id ? "disabled" : ""}>${wsList.map(w => opt(w.id, p.workspace_id, w.name)).join("")}</select></label>
      <label class="field"><span>Owner</span><select class="input" id="pf-owner">${mem.map(m => opt(m.user_id, p.owner_id, nameOf(m.user_id))).join("")}</select></label>
      <label class="field"><span>Priority</span><select class="input" id="pf-priority">${PRIORITIES.map(x => opt(x, p.priority, PRIORITY_LABEL[x])).join("")}</select></label>
      <label class="field"><span>Budget <small>(optional)</small></span><div class="dt"><input class="input num" id="pf-budget" type="number" min="0" step="0.01" value="${p.budget ?? ""}"><input class="input" id="pf-cur" maxlength="3" placeholder="QAR" value="${esc(p.budget_currency || "")}" style="max-width:5.5em;text-transform:uppercase"></div></label>
      <label class="field"><span>Start date</span><input class="input" type="date" id="pf-start" value="${p.start_date || ""}"></label>
      <label class="field"><span>Target completion</span><input class="input" type="date" id="pf-target" value="${p.target_date || ""}"></label>
    </div>
    <label class="field"><span>Next required action</span><input class="input" id="pf-next" value="${esc(p.next_action || "")}"></label>
    <label class="field"><span>Description</span><textarea class="input" id="pf-desc" rows="3">${esc(p.description || "")}</textarea></label>
    ${f.id ? `<fieldset class="group"><legend>Status</legend>
      <p class="hint">Calculated from milestones and tasks: <b>${PROJECT_STATUS_LABEL[h ? h.calculated_status : "on_track"]}</b>${h && h.reasons && h.reasons.length ? ` (${esc(h.reasons.join("; "))})` : ""}. Override only with a reason; the calculated status is kept alongside.</p>
      <div class="grid2"><label class="field"><span>Manual status</span><select class="input" id="pf-mstatus"><option value="">Use calculated status</option>${Object.entries(PROJECT_STATUS_LABEL).map(([k, v]) => opt(k, p.manual_status || "", v)).join("")}</select></label>
      <label class="field"><span>Reason for override</span><input class="input" id="pf-mreason" value="${esc(p.manual_status_reason || "")}"></label></div></fieldset>` : ""}
    <div class="sheet-foot"><button class="btn primary" type="submit" id="pfSave">${f.id ? "Save project" : "Create project"}</button></div>
    ${f.id ? `<div class="danger-zone"><button type="button" class="btn" data-act="project-archive" data-id="${p.id}">${p.archived ? "Restore project" : "Archive project"}</button>
      <button type="button" class="btn danger" data-act="project-delete" data-id="${p.id}">${ICON.trash}Delete project</button></div>` : ""}
  </form>`;
}
async function submitProject() {
  const name = val("pf-name"); if (!name) return toastError("Give the project a name.");
  const ms = f.id ? val("pf-mstatus") : "", mr = f.id ? val("pf-mreason") : "";
  if (ms && mr.length < 3) return toastError("Give a reason for the manual status (at least 3 characters).");
  const start = val("pf-start") || null, target = val("pf-target") || null;
  if (start && target && target < start) return toastError("Target completion can't be before the start date.");
  const row = { name, owner_id: val("pf-owner") || null, priority: val("pf-priority"), start_date: start, target_date: target,
    budget: val("pf-budget") === "" ? null : Number(val("pf-budget")), budget_currency: val("pf-cur").toUpperCase() || null,
    next_action: val("pf-next") || null, description: val("pf-desc") || null };
  if (f.id) { row.manual_status = ms || null; row.manual_status_reason = ms ? mr : null; }
  else row.workspace_id = val("pf-ws");
  const cur = f.id ? projectById(f.id) : null;
  if (cur && cur.baselined_at && (start !== cur.start_date || target !== cur.target_date)) {
    if (!start || !target) return toastError("A baselined project keeps its start and target dates; change them instead of clearing them.");
    const reason = await dialog({ title: "Why is the schedule changing?", text: `This project has a baseline (target ${fmtDate(cur.baseline_target_date)}). The change is logged against it.`, input: { label: "Reason", required: true, min: 3, multiline: true }, confirm: "Change dates" });
    if (!reason) return;
    const rv = await run(sb.rpc("revise_project_dates", { p_project: f.id, p_start: start, p_target: target, p_reason: reason }));
    if (rv.error) return toastError(rv.error);
    if (state.ui.sched) delete state.ui.sched[f.id];
  }
  if (cur && cur.baselined_at) { delete row.start_date; delete row.target_date; }
  const btn = $("pfSave"); busy(btn, true);
  const r = f.id ? await run(sb.from("projects").update(row).eq("id", f.id).select().single()) : await run(sb.from("projects").insert(row).select().single());
  busy(btn, false);
  if (r.error) return toastError(r.error);
  if (f.id) Object.assign(projectById(f.id), r.data); else state.projects.push(r.data);
  refreshHealthSoon();
  closeSheet();
  if (!f.id) location.hash = "#/p/" + r.data.id;
  toast(f.id ? "Project saved" : "Project created");
}

/* ======================= Milestones ======================= */
export function openMilestoneForm(id, projectId) { f.kind = "milestone"; f.id = id || null; f.ctx = { project_id: projectId }; openSheet(renderMilestone); }
function renderMilestone(sh) {
  const m = f.id ? state.milestones.find(x => x.id === f.id) : { title: "", weight: 1, is_critical: false, project_id: f.ctx.project_id };
  sh.innerHTML = sheetHead(f.id ? "Milestone" : "New milestone", esc((projectById(m.project_id) || {}).name || "")) + `
  <form id="milestoneForm" class="sh-body" novalidate>
    <label class="field"><span>Milestone</span><input class="input" id="mf-title" value="${esc(m.title)}" autofocus placeholder="e.g. Material readiness / Customs clearance"></label>
    <div class="grid2">
      <label class="field"><span>Planned date</span><input class="input" type="date" id="mf-planned" value="${m.planned_date || ""}"></label>
      <label class="field"><span>Actual date <small>(when achieved)</small></span><input class="input" type="date" id="mf-actual" value="${m.actual_date || ""}"></label>
      <label class="field"><span>Weight <small>(share of project progress)</small></span><input class="input num" type="number" min="0.1" step="0.1" id="mf-weight" value="${m.weight}"></label>
      <label class="toggle"><span>Critical milestone</span><input type="checkbox" id="mf-critical" ${m.is_critical ? "checked" : ""}></label>
    </div>
    <label class="field"><span>Notes</span><textarea class="input" id="mf-notes" rows="2">${esc(m.notes || "")}</textarea></label>
    <p class="hint">Only enter an actual date when the milestone has really happened. Missing dates are never assumed.</p>
    <div class="sheet-foot"><button class="btn primary" type="submit" id="mfSave">${f.id ? "Save" : "Add milestone"}</button>
    ${f.id ? `<button type="button" class="btn danger" data-act="milestone-delete" data-id="${m.id}">${ICON.trash}Delete</button>` : ""}</div>
  </form>`;
}
async function submitMilestone() {
  const title = val("mf-title"); if (!title) return toastError("Name the milestone.");
  const actual = val("mf-actual") || null;
  if (actual && actual > todayISO(state.tz)) return toastError("The actual date can't be in the future.");
  const row = { title, planned_date: val("mf-planned") || null, actual_date: actual, weight: Number(val("mf-weight") || 1), is_critical: $("mf-critical").checked, notes: val("mf-notes") || null };
  if (!f.id) row.project_id = f.ctx.project_id;
  const curM = f.id ? state.milestones.find(x => x.id === f.id) : null;
  if (curM && curM.baseline_date && row.planned_date !== curM.planned_date) {
    const reason = await dialog({ title: "Why is this milestone moving?", text: `Baseline date: ${fmtDate(curM.baseline_date)}. The change is logged against it.`, input: { label: "Reason", required: true, min: 3, multiline: true }, confirm: "Move milestone" });
    if (!reason) return;
    const rv = await run(sb.rpc("revise_milestone_date", { p_milestone: f.id, p_planned: row.planned_date, p_reason: reason }));
    if (rv.error) return toastError(rv.error);
    if (state.ui.sched) delete state.ui.sched[curM.project_id];
  }
  if (curM && curM.baseline_date) delete row.planned_date;
  const btn = $("mfSave"); busy(btn, true);
  const r = f.id ? await run(sb.from("milestones").update(row).eq("id", f.id).select().single()) : await run(sb.from("milestones").insert(row).select().single());
  busy(btn, false);
  if (r.error) return toastError(r.error);
  if (f.id) Object.assign(state.milestones.find(x => x.id === f.id), r.data); else state.milestones.push(r.data);
  refreshHealthSoon(); closeSheet(); toast(f.id ? "Milestone saved" : "Milestone added");
}

/* ======================= Follow-ups ======================= */
export function openFollowUp(id, ctx = {}) {
  f.kind = "followup"; f.id = id || null; f.ctx = ctx; f.logs = null; f.closing = null;
  if (id && !followUpById(id)) { toastError("That follow-up isn't available."); return; }
  openSheet(renderFollowUp, { wide: !!id });
  if (id) sb.from("follow_up_logs").select("*").eq("follow_up_id", id).order("contacted_at", { ascending: false }).then(({ data }) => { if (f.id === id) { f.logs = data || []; rerenderSheet(); } });
}
const OUTCOME_LABEL = { fulfilled: "Fulfilled", partly_fulfilled: "Partly fulfilled", not_fulfilled: "Not fulfilled", renegotiated: "Renegotiated", no_longer_needed: "No longer needed" };
function renderFollowUp(sh) {
  const tz = state.tz;
  const x = f.id ? followUpById(f.id) : { subject: "", direction: "they_owe", status: "open", workspace_id: f.ctx.workspace_id || state.prefs.last_ws || (activeWorkspaces()[0] || {}).id, task_id: f.ctx.task_id || null, project_id: f.ctx.project_id || null, owner_id: state.user.id, counterpart: f.ctx.counterpart || "", ...(f.ctx.draft || {}) };
  if (!x) { closeSheet(); return; }
  const w = canWrite(x.workspace_id);
  const contacts = state.contacts.filter(c => c.workspace_id === x.workspace_id);
  const tasks = state.tasks.filter(t => t.workspace_id === x.workspace_id && !t.deleted_at && t.status !== "cancelled").slice(0, 300);
  const projects = state.projects.filter(p => p.workspace_id === x.workspace_id && !p.archived);
  const nd = x.next_follow_up_at ? zonedDate(x.next_follow_up_at, tz) : "", nt = x.next_follow_up_at ? zonedTime(x.next_follow_up_at, tz) : "";
  const ro = w ? "" : "disabled";
  sh.innerHTML = sheetHead(f.id ? "Follow-up" : "New follow-up", f.id ? `${esc((wsById(x.workspace_id) || {}).name || "")} · ${x.status === "escalated" ? '<span class="warn-text">Escalated</span>' : x.status}` : "Track what someone owes you, or what you owe them.") + `
  <form id="fuForm" class="sh-body" novalidate>
    <label class="field"><span>Commitment</span><input class="input" id="fu-subject" value="${esc(x.subject)}" ${ro} autofocus placeholder="e.g. Revised dispatch date and recovery plan"></label>
    <label class="field"><span>What exactly is expected <small>(deliverable, document, decision)</small></span><textarea class="input" id="fu-expectation" rows="2" ${ro} placeholder="e.g. Written revised dispatch date with a recovery plan for the 3 delayed racks">${esc(x.expectation || "")}</textarea></label>
    <label class="field inline"><span>Type</span><select class="input" id="fu-type" ${ro}><option value="external" ${x.commitment_type !== "internal" ? "selected" : ""}>External (supplier, client, authority)</option><option value="internal" ${x.commitment_type === "internal" ? "selected" : ""}>Internal (colleague, team)</option></select></label>
    <div class="seg2" role="radiogroup" aria-label="Direction">
      <label class="${x.direction === "they_owe" ? "on" : ""}"><input type="radio" name="fu-dir" value="they_owe" ${x.direction === "they_owe" ? "checked" : ""} ${ro}><b>They owe me</b><small>Awaiting their response</small></label>
      <label class="${x.direction === "i_owe" ? "on" : ""}"><input type="radio" name="fu-dir" value="i_owe" ${x.direction === "i_owe" ? "checked" : ""} ${ro}><b>I owe them</b><small>My commitment</small></label>
    </div>
    <div class="grid2">
      ${f.id ? "" : `<label class="field"><span>Workspace</span><select class="input" id="fu-ws">${activeWorkspaces().filter(ws => canWrite(ws.id)).map(ws => opt(ws.id, x.workspace_id, ws.name)).join("")}</select></label>`}
      <label class="field"><span>Contact</span><select class="input" id="fu-contact" ${ro}><option value="">— not in contacts —</option>${contacts.map(c => opt(c.id, x.contact_id || "", c.name + (c.organisation ? " · " + c.organisation : ""))).join("")}</select></label>
      <label class="field"><span>Or person / organisation</span><input class="input" id="fu-counterpart" value="${esc(x.counterpart || "")}" ${ro}></label>
      <label class="field"><span>Last communication</span><input class="input" type="date" id="fu-last" value="${x.last_contact_at || ""}" ${ro}></label>
      <label class="field"><span>Expected response by</span><input class="input" type="date" id="fu-expected" value="${x.expected_at || ""}" ${ro}></label>
      <div class="field"><span>Next follow-up</span><div class="dt"><input class="input" type="date" id="fu-next-d" value="${nd}" ${ro}><input class="input" type="time" id="fu-next-t" value="${nt}" ${ro}></div></div>
      <label class="field"><span>Escalate on</span><input class="input" type="date" id="fu-escalate" value="${x.escalate_at || ""}" ${ro}></label>
      <label class="field"><span>Related task</span><select class="input" id="fu-task" ${ro}><option value="">None</option>${tasks.map(t => opt(t.id, x.task_id || "", t.title.slice(0, 70))).join("")}</select></label>
      <label class="field"><span>Project</span><select class="input" id="fu-project" ${ro}><option value="">None</option>${projects.map(p => opt(p.id, x.project_id || "", p.name)).join("")}</select></label>
      <label class="field"><span>Responsible</span><select class="input" id="fu-owner" ${ro}>${membersOf(x.workspace_id).map(m => opt(m.user_id, x.owner_id || "", nameOf(m.user_id))).join("")}</select></label>
      <label class="field"><span>Supporting email / document link</span><input class="input" id="fu-doc" type="url" value="${esc(x.document_url || "")}" placeholder="https://…" ${ro}></label>
    </div>
    ${f.id ? `<fieldset class="group"><legend>Actual response</legend><div class="grid2">
      <label class="field"><span>What they said or delivered</span><textarea class="input" id="fu-response" rows="2" ${ro}>${esc(x.response || "")}</textarea></label>
      <label class="field"><span>Received on</span><input class="input" type="date" id="fu-response-at" value="${x.response_at || ""}" max="${todayISO(tz)}" ${ro}></label></div></fieldset>` : ""}
    ${x.outcome ? `<div class="banner ${x.outcome === "fulfilled" ? "ok" : x.outcome === "not_fulfilled" ? "bad" : "info"}"><b>Outcome: ${OUTCOME_LABEL[x.outcome]}</b>${x.outcome_note ? ` — ${esc(x.outcome_note)}` : ""}</div>` : ""}
    ${f.closing ? `<fieldset class="group" id="fu-close-panel"><legend>${f.closing === "cancel" ? "Cancel commitment" : "Close commitment"}</legend>
      ${f.closing === "close" ? `<label class="field"><span>Outcome</span><select class="input" id="fu-outcome"><option value="">Choose…</option>${Object.entries(OUTCOME_LABEL).filter(([k]) => k !== "no_longer_needed").map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}<option value="no_longer_needed">${OUTCOME_LABEL.no_longer_needed}</option></select></label>` : ""}
      <label class="field"><span>${f.closing === "cancel" ? "Why is it cancelled?" : "Outcome note"}</span><input class="input" id="fu-outcome-note" placeholder="${f.closing === "cancel" ? "e.g. Order cancelled by client" : "e.g. New date agreed: 12 Nov"}"></label>
      <div class="btnrow"><button type="button" class="btn primary" data-act="fu-close-confirm" data-id="${x.id}">${f.closing === "cancel" ? "Cancel commitment" : "Close with this outcome"}</button><button type="button" class="btn" data-act="fu-close-back">Back</button></div>
      <p class="hint">Completing a related task never closes a commitment — it stays open until you record what actually happened.</p></fieldset>` : ""}
    <label class="field"><span>Notes</span><textarea class="input" id="fu-notes" rows="2" ${ro}>${esc(x.notes || "")}</textarea></label>
    <p class="hint">Reminders fire once at the next follow-up time. On the escalation date the item is marked Escalated and you're alerted. Nothing is ever sent to the other party automatically.</p>
    ${w ? `<div class="sheet-foot"><button class="btn primary" type="submit" id="fuSave">${f.id ? "Save" : "Create follow-up"}</button>
      ${f.id && ["open", "escalated"].includes(x.status) && !f.closing ? `<button type="button" class="btn" data-act="fu-close" data-id="${x.id}">${ICON.check}Close…</button><button type="button" class="btn" data-act="fu-cancel" data-id="${x.id}">Cancel…</button>` : ""}
      ${f.id && ["closed", "cancelled"].includes(x.status) ? `<button type="button" class="btn" data-act="fu-reopen" data-id="${x.id}">Reopen</button>` : ""}
      ${f.id && x.status === "open" ? `<button type="button" class="btn" data-act="fu-escalate" data-id="${x.id}">Escalate now</button>` : ""}
      ${f.id && ["open", "escalated"].includes(x.status) ? `<button type="button" class="btn" data-act="draft-msg" data-kind="followup" data-id="${x.id}">✉ Draft message</button>` : ""}</div>` : ""}
  </form>
  ${f.id ? `<section class="sh-body sub"><div class="sub-h"><h3>Communication log</h3></div>
    ${w ? `<form class="upform" id="fuLogForm"><textarea class="input" id="fuLogInput" rows="2" placeholder="What happened? e.g. Called, promised reply by Sunday"></textarea>
      <div class="grid2"><label class="field"><span>Contacted on</span><input class="input" type="date" id="fuLogDate" value="${todayISO(tz)}"></label>
      <label class="field"><span>Next follow-up <small>(optional)</small></span><input class="input" type="date" id="fuLogNext"></label></div>
      <button class="btn primary" type="submit">Log contact</button></form>` : ""}
    ${!f.logs ? `<p class="hint">Loading…</p>` : f.logs.length ? `<ol class="timeline">${f.logs.map(l => `<li class="note"><span class="pt"></span><div><time>${esc(shortName(l.author_id))} · ${fmtDateTime(l.contacted_at, tz)}</time><div class="body">${esc(l.body)}</div></div></li>`).join("")}</ol>` : `<p class="hint">No contact logged yet.</p>`}
    ${x.task_id ? `<p><button class="linkbtn" data-act="open-task" data-id="${x.task_id}">Open related task</button></p>` : ""}
  </section>` : ""}`;
}
function readFollowUp() {
  const nd = val("fu-next-d"), nt = val("fu-next-t");
  const row = {
    subject: val("fu-subject"), direction: (document.querySelector('input[name="fu-dir"]:checked') || {}).value || "they_owe",
    contact_id: val("fu-contact") || null, counterpart: val("fu-counterpart") || null,
    last_contact_at: val("fu-last") || null, expected_at: val("fu-expected") || null,
    next_follow_up_at: nd ? zonedToISO(nd, nt || "09:00", state.tz) : null, escalate_at: val("fu-escalate") || null,
    task_id: val("fu-task") || null, project_id: val("fu-project") || null, owner_id: val("fu-owner") || null,
    document_url: val("fu-doc") || null, notes: val("fu-notes") || null,
    expectation: val("fu-expectation") || null, commitment_type: val("fu-type") || "external"
  };
  if ($("fu-response")) { row.response = val("fu-response") || null; row.response_at = val("fu-response-at") || null; }
  if (!f.id) row.workspace_id = val("fu-ws");
  return row;
}
async function submitFollowUp() {
  const row = readFollowUp();
  if (!row.subject) return toastError("Say what was requested or promised.");
  if (!row.contact_id && !row.counterpart) return toastError("Choose a contact or type the person/organisation.");
  if (row.document_url && !/^https?:\/\//i.test(row.document_url)) return toastError("The document link must start with http:// or https://");
  const btn = $("fuSave"); busy(btn, true);
  const r = f.id ? await run(sb.from("follow_ups").update(row).eq("id", f.id).select().single()) : await run(sb.from("follow_ups").insert(row).select().single());
  busy(btn, false);
  if (r.error) return toastError(r.error);
  if (f.id) Object.assign(followUpById(f.id), r.data); else state.followUps.push(r.data);
  if (!f.id) { closeSheet(); toast("Follow-up created"); } else { rerenderSheet(); toast("Follow-up saved"); }
}
async function setFollowUpStatus(id, status) {
  const r = await run(sb.from("follow_ups").update({ status }).eq("id", id).select().single());
  if (r.error) return toastError(r.error);
  Object.assign(followUpById(id), r.data); rerenderSheet(); toast(status === "closed" ? "Follow-up closed" : status === "escalated" ? "Marked escalated" : "Reopened");
}
async function submitFollowUpLog() {
  const body = val("fuLogInput"); if (!body) return toastError("Write what happened.");
  const day = val("fuLogDate") || todayISO(state.tz), next = val("fuLogNext");
  const r = await run(sb.from("follow_up_logs").insert({ follow_up_id: f.id, body, contacted_at: zonedToISO(day, "12:00", state.tz) }).select().single());
  if (r.error) return toastError(r.error);
  const patch = { last_contact_at: day }; if (next) patch.next_follow_up_at = zonedToISO(next, "09:00", state.tz);
  const u = await run(sb.from("follow_ups").update(patch).eq("id", f.id).select().single());
  if (u.error) toastError(u.error); else Object.assign(followUpById(f.id), u.data);
  f.logs = [r.data, ...(f.logs || [])]; rerenderSheet(); toast("Contact logged");
}

/* ======================= Workspaces ======================= */
export function openWorkspaceForm(id) { f.kind = "workspace"; f.id = id || null; f.msg = null; openSheet(renderWorkspace); }
function renderWorkspace(sh) {
  const w = f.id ? wsById(f.id) : { name: "", color: COLORS[state.workspaces.length % COLORS.length], kind: "business" };
  const owner = !f.id || isWsOwner(f.id);
  const mem = f.id ? membersOf(f.id).slice().sort((a, b) => (a.role === "owner" ? -1 : b.role === "owner" ? 1 : 0)) : [];
  sh.innerHTML = sheetHead(f.id ? w.name : "New workspace", f.id ? (owner ? "You own this workspace" : `Owned by ${esc(nameOf(w.owner_id))}`) : "A workspace holds projects, tasks, follow-ups and contacts for one area of your life or business.") + `
  <div class="sh-body">
  ${owner ? `<form id="wsForm" style="display:grid;gap:14px" novalidate>
    <div class="grid2"><label class="field"><span>Name</span><input class="input" id="wf-name" value="${esc(w.name)}" maxlength="80" autofocus></label>
    <label class="field"><span>Type</span><select class="input" id="wf-kind">${[["business", "Business"], ["professional", "Professional / employer"], ["personal", "Personal & family"], ["other", "Other"]].map(([k, v]) => opt(k, w.kind, v)).join("")}</select></label></div>
    <label class="field"><span>Description</span><input class="input" id="wf-desc" value="${esc(w.description || "")}"></label>
    <div class="field"><span>Colour</span><div class="colors">${COLORS.map((c, i) => `<label><input type="radio" name="wf-color" value="${c}" ${c === w.color ? "checked" : ""}><span style="--sw:${c}"></span></label>`).join("")}</div></div>
    <div class="sheet-foot"><button class="btn primary" type="submit" id="wfSave">${f.id ? "Save" : "Create workspace"}</button></div>
  </form>` : ""}
  ${f.id ? `<section class="sub"><div class="sub-h"><h3>People</h3><span class="c">${mem.length}</span></div>
    <ul class="mlist">${mem.map(m => `<li>${avatar(m.user_id, "lg")}<div style="min-width:0"><div class="mn">${esc(nameOf(m.user_id))}${m.user_id === state.user.id ? " (you)" : ""}</div><div class="me">${esc((state.profiles[m.user_id] || {}).email || "")}</div></div>
      ${m.role === "owner" ? `<span class="role">Owner</span>` : owner ? `<select class="input sm" data-act="ws-role" data-uid="${m.user_id}" aria-label="Role">${opt("member", m.role, "Member")}${opt("viewer", m.role, "Viewer (read-only)")}</select><button class="iconbtn" data-act="ws-remove" data-uid="${m.user_id}" aria-label="Remove">${ICON.close}</button>` : `<span class="role">${m.role}</span>`}</li>`).join("")}</ul>
    ${owner ? `<form id="wsAddForm" class="addrow"><input class="input" id="wf-email" type="email" placeholder="Their Job Desk email"><select class="input" id="wf-role" style="max-width:9em">${opt("member", "member", "Member")}${opt("viewer", "", "Viewer")}</select><button class="btn primary" type="submit">Add</button></form>
      ${f.msg ? `<div class="formmsg ${f.msg.type}">${esc(f.msg.text)}</div>` : ""}
      <p class="hint">Members can add and edit everything in this workspace. Viewers can only read. Finance permissions will be set separately per entity in Phase 3.</p>` : `<button class="btn danger" data-act="ws-leave" data-id="${f.id}">Leave workspace</button>`}
  </section>
  ${owner ? `<div class="danger-zone"><button class="btn" data-act="ws-archive" data-id="${f.id}">${w.archived ? "Restore workspace" : "Archive workspace"}</button><button class="btn danger" data-act="ws-delete" data-id="${f.id}">${ICON.trash}Delete workspace</button></div>` : ""}` : ""}
  </div>`;
}
async function submitWorkspace() {
  const name = val("wf-name"); if (!name) return toastError("Give the workspace a name.");
  const row = { name, kind: val("wf-kind"), description: val("wf-desc") || null, color: (document.querySelector('input[name="wf-color"]:checked') || {}).value || COLORS[0] };
  const btn = $("wfSave"); busy(btn, true);
  const r = f.id ? await run(sb.from("workspaces").update(row).eq("id", f.id).select().single()) : await run(sb.from("workspaces").insert({ ...row, owner_id: state.user.id, sort: state.workspaces.length }).select().single());
  busy(btn, false);
  if (r.error) return toastError(r.error);
  await loadAll().catch(() => {});
  closeSheet(); toast(f.id ? "Workspace saved" : "Workspace created");
  if (!f.id) location.hash = "#/w/" + r.data.id;
}

/* ======================= Contacts ======================= */
export function openContactForm(id, ctx = {}) { f.kind = "contact"; f.id = id || null; f.ctx = ctx; openSheet(renderContact); }
function renderContact(sh) {
  const c = f.id ? contactById(f.id) : { name: "", kind: "person", workspace_id: f.ctx.workspace_id };
  sh.innerHTML = sheetHead(f.id ? c.name : "New contact", esc((wsById(c.workspace_id) || {}).name || "")) + `
  <form id="contactForm" class="sh-body" novalidate>
    <div class="grid2">
      <label class="field"><span>Name</span><input class="input" id="cf-name" value="${esc(c.name)}" autofocus></label>
      <label class="field"><span>Type</span><select class="input" id="cf-kind">${["person", "company", "supplier", "customer", "partner", "colleague", "other"].map(k => opt(k, c.kind, k[0].toUpperCase() + k.slice(1))).join("")}</select></label>
      <label class="field"><span>Organisation</span><input class="input" id="cf-org" value="${esc(c.organisation || "")}"></label>
      <label class="field"><span>Email</span><input class="input" id="cf-email" type="email" value="${esc(c.email || "")}"></label>
      <label class="field"><span>Phone</span><input class="input" id="cf-phone" type="tel" value="${esc(c.phone || "")}"></label>
    </div>
    <label class="field"><span>Notes</span><textarea class="input" id="cf-notes" rows="2">${esc(c.notes || "")}</textarea></label>
    <div class="sheet-foot"><button class="btn primary" type="submit" id="cfSave">${f.id ? "Save" : "Add contact"}</button>
    ${f.id ? `<button type="button" class="btn danger" data-act="contact-archive" data-id="${c.id}">Archive</button>` : ""}</div>
  </form>`;
}
async function submitContact() {
  const name = val("cf-name"); if (!name) return toastError("Enter a name.");
  const row = { name, kind: val("cf-kind"), organisation: val("cf-org") || null, email: val("cf-email") || null, phone: val("cf-phone") || null, notes: val("cf-notes") || null };
  if (!f.id) row.workspace_id = f.ctx.workspace_id;
  const btn = $("cfSave"); busy(btn, true);
  const r = f.id ? await run(sb.from("contacts").update(row).eq("id", f.id).select().single()) : await run(sb.from("contacts").insert(row).select().single());
  busy(btn, false);
  if (r.error) return toastError(r.error);
  if (f.id) Object.assign(contactById(f.id), r.data); else state.contacts.push(r.data);
  closeSheet(); toast(f.id ? "Contact saved" : "Contact added");
}

/* ======================= event routing ======================= */
export async function handleFormSubmit(form) {
  switch (form.id) {
    case "projectForm": await submitProject(); return true;
    case "milestoneForm": await submitMilestone(); return true;
    case "fuForm": await submitFollowUp(); return true;
    case "fuLogForm": await submitFollowUpLog(); return true;
    case "wsForm": await submitWorkspace(); return true;
    case "contactForm": await submitContact(); return true;
    case "wsAddForm": {
      const email = val("wf-email"); if (!/^\S+@\S+\.\S+$/.test(email)) { f.msg = { type: "err", text: "Enter a valid email." }; rerenderSheet(); return true; }
      const r = await run(sb.rpc("add_workspace_member", { p_workspace: f.id, p_email: email, p_role: val("wf-role") }));
      f.msg = r.error ? { type: "err", text: /account yet|not_registered/.test(r.error + (r.raw && r.raw.message)) ? `${email} doesn't have a Job Desk account yet. Share the invite link from Settings first.` : r.error } : { type: "ok", text: "Added. They've been notified." };
      if (!r.error) await loadAll().catch(() => {});
      rerenderSheet(); return true;
    }
  }
  return false;
}

export async function handleFormClick(act, el) {
  const id = el.dataset.id;
  switch (act) {
    case "set-baseline": {
      const p = projectById(id);
      if (!p.target_date) return toastError("Set a target date in Project settings first."), true;
      let reason = null;
      if (p.baselined_at) { reason = await dialog({ title: "Re-baseline the schedule?", text: "Today's dates become the new baseline. The old baseline is kept in the revision log.", input: { label: "Reason", required: true, min: 3, multiline: true }, confirm: "Re-baseline" }); if (!reason) return true; }
      else if (!(await dialog({ title: "Set the baseline?", text: `Freezes the current start (${p.start_date ? fmtDate(p.start_date) : "none"}), target (${fmtDate(p.target_date)}) and milestone dates as the original plan. Later changes will need a reason.`, confirm: "Set baseline" }))) return true;
      const r = await run(sb.rpc("set_project_baseline", { p_project: id, p_reason: reason }));
      if (r.error) return toastError(r.error), true;
      const [pp, mm] = await Promise.all([sb.from("projects").select("*").eq("id", id).single(), sb.from("milestones").select("*").eq("project_id", id)]);
      if (pp.data) Object.assign(p, pp.data);
      for (const m of mm.data || []) { const x = state.milestones.find(y => y.id === m.id); if (x) Object.assign(x, m); }
      if (state.ui.sched) delete state.ui.sched[id];
      emit("data"); toast(reason ? "Re-baselined" : "Baseline set"); return true; }
    case "project-archive": { const p = projectById(id); const r = await run(sb.from("projects").update({ archived: !p.archived }).eq("id", id)); if (r.error) return toastError(r.error), true; p.archived = !p.archived; closeSheet(); toast(p.archived ? "Project archived" : "Project restored"); return true; }
    case "project-delete": {
      const p = projectById(id), n = state.tasks.filter(t => t.project_id === id).length;
      const ok = await dialog({ title: `Delete "${p.name}"?`, text: `Milestones are deleted. ${n} task(s) stay in the workspace without a project. The deletion is recorded in the audit log.`, confirm: "Delete project", danger: true });
      if (!ok) return true;
      const r = await run(sb.from("projects").delete().eq("id", id)); if (r.error) return toastError(r.error), true;
      await loadAll().catch(() => {}); closeSheet(); location.hash = "#/w/" + p.workspace_id; toast("Project deleted"); return true;
    }
    case "milestone-delete": {
      if (!(await dialog({ title: "Delete milestone?", confirm: "Delete", danger: true }))) return true;
      const r = await run(sb.from("milestones").delete().eq("id", id)); if (r.error) return toastError(r.error), true;
      state.milestones = state.milestones.filter(m => m.id !== id); refreshHealthSoon(); closeSheet(); toast("Milestone deleted"); return true;
    }
    case "fu-close": f.closing = "close"; rerenderSheet(); setTimeout(() => $("fu-outcome") && $("fu-outcome").focus(), 30); return true;
    case "fu-cancel": f.closing = "cancel"; rerenderSheet(); setTimeout(() => $("fu-outcome-note") && $("fu-outcome-note").focus(), 30); return true;
    case "fu-close-back": f.closing = null; rerenderSheet(); return true;
    case "fu-close-confirm": {
      const cancel = f.closing === "cancel", outcome = cancel ? "no_longer_needed" : val("fu-outcome"), note = val("fu-outcome-note");
      if (!outcome) return toastError("Choose the outcome."), true;
      if (cancel && note.length < 3) return toastError("Say why it's cancelled."), true;
      const patch = { ...readFollowUp(), status: cancel ? "cancelled" : "closed", outcome, outcome_note: note || null }; delete patch.workspace_id;
      const r = await run(sb.from("follow_ups").update(patch).eq("id", id).select().single());
      if (r.error) return toastError(r.error), true;
      f.closing = null; Object.assign(followUpById(id), r.data); rerenderSheet(); toast(cancel ? "Commitment cancelled" : "Commitment closed"); return true; }
    case "fu-reopen": await setFollowUpStatus(id, "open"); return true;
    case "fu-escalate": await setFollowUpStatus(id, "escalated"); return true;
    case "ws-remove": {
      const uid = el.dataset.uid;
      if (!(await dialog({ title: `Remove ${nameOf(uid)}?`, text: "Tasks they own here go back to you. They lose access immediately.", confirm: "Remove", danger: true }))) return true;
      const r = await run(sb.from("workspace_members").delete().eq("workspace_id", f.id).eq("user_id", uid)); if (r.error) return toastError(r.error), true;
      await loadAll().catch(() => {}); rerenderSheet(); toast("Removed"); return true;
    }
    case "ws-leave": {
      if (!(await dialog({ title: "Leave this workspace?", text: "You'll lose access to its tasks and projects.", confirm: "Leave", danger: true }))) return true;
      const r = await run(sb.from("workspace_members").delete().eq("workspace_id", id).eq("user_id", state.user.id)); if (r.error) return toastError(r.error), true;
      await loadAll().catch(() => {}); closeSheet(); location.hash = "#/workspaces"; return true;
    }
    case "ws-archive": { const w = wsById(id); const r = await run(sb.from("workspaces").update({ archived: !w.archived }).eq("id", id)); if (r.error) return toastError(r.error), true; w.archived = !w.archived; closeSheet(); toast(w.archived ? "Workspace archived" : "Workspace restored"); return true; }
    case "ws-delete": {
      const w = wsById(id), n = state.tasks.filter(t => t.workspace_id === id).length;
      const typed = await dialog({ title: `Delete "${w.name}" permanently?`, text: `This deletes ${n} task(s), its projects, follow-ups and contacts for everyone. It can't be undone. Type the workspace name to confirm.`, input: { label: "Workspace name", required: true }, confirm: "Delete permanently", danger: true });
      if (typed === null) return true;
      if (typed !== w.name) { toastError("The name didn't match. Nothing was deleted."); return true; }
      const r = await run(sb.from("workspaces").delete().eq("id", id)); if (r.error) return toastError(r.error), true;
      await loadAll().catch(() => {}); closeSheet(); location.hash = "#/workspaces"; toast("Workspace deleted"); return true;
    }
    case "contact-archive": { const r = await run(sb.from("contacts").update({ archived: true }).eq("id", id)); if (r.error) return toastError(r.error), true; state.contacts = state.contacts.filter(c => c.id !== id); closeSheet(); toast("Contact archived"); return true; }
  }
  return false;
}

export async function handleFormChange(e) {
  if (e.target.dataset && e.target.dataset.act === "ws-role") {
    const r = await run(sb.rpc("set_workspace_member_role", { p_workspace: f.id, p_user: e.target.dataset.uid, p_role: e.target.value }));
    if (r.error) toastError(r.error); else { await loadAll().catch(() => {}); toast("Role updated"); }
    return true;
  }
  if (e.target.name === "fu-dir") { document.querySelectorAll('input[name="fu-dir"]').forEach(i => i.closest("label").classList.toggle("on", i.checked)); return true; }
  if (e.target.id === "fu-ws" && !f.id) { const row = readFollowUp(); f.ctx = { ...f.ctx, workspace_id: row.workspace_id, draft: { ...row, contact_id: null, task_id: null, project_id: null, owner_id: state.user.id } }; rerenderSheet(); return true; }
  if (e.target.id === "pf-ws" && !f.id) { const nm = val("pf-name"); f.ctx.workspace_id = e.target.value; rerenderSheet(); if ($("pf-name")) $("pf-name").value = nm; return true; }
  return false;
}
