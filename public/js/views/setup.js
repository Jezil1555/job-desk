// Workspace set-up: custom fields and project templates for the one shared task engine.
import { esc, fmtDate, todayISO } from "../util.js";
import { state, emit, wsById, projectById, canWrite } from "../store.js";
import { sb, run, loadAll } from "../api.js";
import { ICON, $, openSheet, closeSheet, rerenderSheet, sheetHead, toast, toastError, dialog, busy, section, emptyState } from "../ui.js";
import { fieldKey } from "../logic.js";

export const FIELD_TYPE = { text: "Text", number: "Number", date: "Date", select: "Choice list", checkbox: "Yes / no" };

async function reloadSetup() {
  const [f, t] = await Promise.all([run(sb.from("field_defs").select("*").order("sort").order("label")), run(sb.from("project_templates").select("*").order("name"))]);
  if (!f.error) state.fieldDefs = f.data || [];
  if (!t.error) state.templates = t.data || [];
  emit("data");
}

export function renderSetup(wsId) {
  const w = canWrite(wsId);
  const defs = (state.fieldDefs || []).filter(d => d.workspace_id === wsId);
  const active = defs.filter(d => !d.archived), archived = defs.filter(d => d.archived);
  const tpls = (state.templates || []).filter(t => t.workspace_id === wsId && !t.archived);
  const n = (t, k) => ((t.body || {})[k] || []).length;
  return `${section("Custom fields", `${w ? `<div class="toolbar"><button class="btn primary" data-act="field-new" data-ws="${wsId}">${ICON.plus}Add field</button></div>` : ""}
    ${active.length ? `<div class="tablewrap"><table class="rtable" id="fieldTable"><thead><tr><th>Field</th><th>Type</th><th>Applies to</th><th>Before completing</th><th></th></tr></thead><tbody>
      ${active.map(d => `<tr><td><b>${esc(d.label)}</b> <small class="hint">${esc(d.key)}</small>${d.type === "select" ? `<br><small class="hint">${d.options.map(esc).join(" · ")}</small>` : ""}</td><td>${FIELD_TYPE[d.type]}</td>
        <td>${d.project_id ? esc((projectById(d.project_id) || {}).name || "a project") : "Every task in this workspace"}</td><td>${d.required ? (d.type === "checkbox" ? "Must be ticked" : "Must be filled in") : "Optional"}</td>
        <td>${w ? `<button class="btn sm" data-act="field-archive" data-id="${d.id}">Archive…</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
      : `<p class="calm">No custom fields. Add the details this workspace tracks on its tasks — fabric and measurements for tailoring, container or AWB numbers for logistics — instead of keeping them in descriptions.</p>`}
    ${archived.length ? `<p class="hint">Archived: ${archived.map(d => esc(d.label)).join(", ")}. Values already recorded are kept on the tasks.</p>` : ""}`, { count: active.length })}
  ${section("Project templates", `${w && tpls.length ? "" : ""}
    ${tpls.length ? `<div class="list">${tpls.map(t => `<div class="trow"><span class="kico">${ICON.folder || "▦"}</span><div class="tmain"><div class="ttitle">${esc(t.name)}</div>
      <div class="tmeta">${n(t, "milestones")} milestones · ${n(t, "tasks")} tasks · ${n(t, "fields")} fields${t.source_project_id && projectById(t.source_project_id) ? ` · from ${esc(projectById(t.source_project_id).name)}` : ""} · ${fmtDate(String(t.created_at).slice(0, 10))}</div></div>
      <div class="tside">${w ? `<button class="btn sm primary" data-act="tpl-use" data-id="${t.id}">Use…</button><button class="btn sm" data-act="tpl-archive" data-id="${t.id}">Archive</button>` : ""}</div></div>`).join("")}</div>`
      : `<p class="calm">No templates yet. Open a project that works well and choose <b>Save as template</b>; its milestones, tasks, completion criteria and project fields are kept, with dates stored as days from the start.</p>`}`, { count: tpls.length })}`;
}

/* ---------------- sheets ---------------- */
let cur = null;
function renderField(sh) {
  const projs = state.projects.filter(p => p.workspace_id === cur.ws && !p.archived), d = cur.draft;
  sh.innerHTML = sheetHead("Add a field", (wsById(cur.ws) || {}).name || "") + `<form id="fieldForm" class="sh-body" novalidate>
    <label class="field"><span>Label</span><input class="input" id="fd-label" maxlength="60" value="${esc(d.label || "")}" placeholder="e.g. Fabric, Chest (cm), AWB number"></label>
    <div class="grid2"><label class="field"><span>Type</span><select class="input" id="fd-type" data-act="fd-redraw">${Object.entries(FIELD_TYPE).map(([k, l]) => `<option value="${k}" ${k === d.type ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="field"><span>Applies to</span><select class="input" id="fd-scope"><option value="">Every task in this workspace</option>${projs.map(p => `<option value="${p.id}" ${p.id === d.scope ? "selected" : ""}>Only “${esc(p.name)}”</option>`).join("")}</select></label></div>
    ${d.type === "select" ? `<label class="field"><span>Choices <small>(one per line)</small></span><textarea class="input" id="fd-options" rows="4">${esc(d.options || "")}</textarea></label>` : ""}
    <label class="field chk"><input type="checkbox" id="fd-required" ${d.required ? "checked" : ""}> <span>${d.type === "checkbox" ? "Must be ticked" : "Must be filled in"} before a task can be completed</span></label>
    <p class="hint">The type can't be changed later (values already recorded depend on it); archive the field and add a new one instead.</p>
    <div class="sheet-foot"><button class="btn primary block" type="submit" id="fdSave">Add field</button></div></form>`;
}
function syncField() { const d = cur.draft; d.label = $("fd-label").value; d.type = $("fd-type").value; d.scope = $("fd-scope").value; d.required = $("fd-required").checked; if ($("fd-options")) d.options = $("fd-options").value; }
function renderUse(sh) {
  const t = (state.templates || []).find(x => x.id === cur.id), b = t.body || {};
  sh.innerHTML = sheetHead(`New project from “${t.name}”`, (wsById(t.workspace_id) || {}).name || "") + `<form id="tplUseForm" class="sh-body" novalidate>
    <label class="field"><span>Project name</span><input class="input" id="tu-name" maxlength="120"></label>
    <div class="grid2"><label class="field"><span>Start date</span><input class="input" type="date" id="tu-start" value="${todayISO(state.tz)}"></label>
      <label class="field"><span>Target date <small>(optional)</small></span><input class="input" type="date" id="tu-target"></label></div>
    <p class="hint">Creates ${(b.milestones || []).length} milestones and ${(b.tasks || []).length} tasks owned by you, with dates counted from the start date (the target defaults to the last of them).
      Tasks start open with criteria unticked and no field values. Nothing is baselined until you choose to.</p>
    <div class="sheet-foot"><button class="btn primary block" type="submit" id="tuSave">Create project</button></div></form>`;
}

export async function handleSetupClick(act, el) {
  switch (act) {
    case "field-new": cur = { mode: "field", ws: el.dataset.ws, draft: { type: "text", scope: el.dataset.project || "" } }; openSheet(renderField); return true;
    case "field-archive": {
      const d = state.fieldDefs.find(x => x.id === el.dataset.id);
      if (!(await dialog({ title: `Archive “${d.label}”?`, text: "It stops appearing on tasks and stops being required. Values already recorded stay on the tasks and in their history.", confirm: "Archive", danger: true }))) return true;
      const r = await run(sb.from("field_defs").update({ archived: true }).eq("id", d.id)); if (r.error) return toastError(r.error), true;
      await reloadSetup(); toast("Field archived"); return true; }
    case "tpl-use": cur = { mode: "use", id: el.dataset.id }; openSheet(renderUse); return true;
    case "tpl-archive": {
      const t = state.templates.find(x => x.id === el.dataset.id);
      const r = await run(sb.from("project_templates").update({ archived: true }).eq("id", t.id)); if (r.error) return toastError(r.error), true;
      await reloadSetup(); toast("Template archived"); return true; }
    case "save-template": {
      const p = projectById(el.dataset.id);
      const name = await dialog({ title: "Save as template", text: "Keeps the milestones, tasks (titles, priorities, criteria, next actions), and this project's own fields, with dates as days from the start. Notes, values, people and progress aren't copied.", input: { label: "Template name", required: true }, confirm: "Save template" });
      if (!name) return true;
      const r = await run(sb.rpc("save_project_as_template", { p_project: p.id, p_name: name })); if (r.error) return toastError(r.error), true;
      await reloadSetup(); toast("Template saved — find it under the workspace's Fields & templates"); return true; }
  }
  return false;
}
export function handleSetupChange(ev) {
  if (ev.target.dataset.act !== "fd-redraw" || !cur || cur.mode !== "field") return false;
  syncField(); rerenderSheet(); return true;
}
export async function handleSetupSubmit(form) {
  if (form.id === "fieldForm" && cur) {
    syncField(); const d = cur.draft;
    if (!d.label.trim()) return toastError("Give the field a label."), true;
    const options = d.type === "select" ? String(d.options || "").split("\n").map(s => s.trim()).filter(Boolean) : [];
    if (d.type === "select" && !options.length) return toastError("Add at least one choice."), true;
    const key = fieldKey(d.label);
    if ((state.fieldDefs || []).some(x => x.workspace_id === cur.ws && x.key === key && !x.archived)) return toastError(`There's already a field called “${d.label}” here.`), true;
    const btn = $("fdSave"); busy(btn, true);
    const r = await run(sb.from("field_defs").insert({ workspace_id: cur.ws, project_id: d.scope || null, key, label: d.label.trim(), type: d.type, options, required: d.required, created_by: state.user.id }));
    busy(btn, false); if (r.error) return toastError(r.error), true;
    closeSheet(); cur = null; await reloadSetup(); toast("Field added"); return true;
  }
  if (form.id === "tplUseForm" && cur) {
    const name = $("tu-name").value.trim(), start = $("tu-start").value, target = $("tu-target").value || null;
    if (!name) return toastError("Name the project."), true;
    if (!start) return toastError("Choose the start date."), true;
    if (target && target < start) return toastError("The target date is before the start."), true;
    const btn = $("tuSave"); busy(btn, true);
    const r = await run(sb.rpc("create_project_from_template", { p_template: cur.id, p_name: name, p_start: start, p_target: target }));
    busy(btn, false); if (r.error) return toastError(r.error), true;
    closeSheet(); cur = null; await loadAll(); location.hash = `#/p/${r.data}`; toast("Project created from template"); return true;
  }
  return false;
}
