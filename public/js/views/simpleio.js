// Excel in and out for the simple work screens:
//  - Download Excel: a workspace's open / closed / all projects with every task and step.
//  - Import template: fill one row per step, upload, preview, then confirm. Nothing is saved before Confirm.
import { esc, zonedDate, zonedToISO, todayISO } from "../util.js";
import { state, emit, wsById, canWrite } from "../store.js";
import { ICON, toast, toastError, openSheet, sheetHead, closeSheet, busy, rerenderSheet } from "../ui.js";
import { sb, run, reindex } from "../api.js";
import { downloadXlsx } from "../xlsx.js";
import { stepsOf, projectStats, STATUS, taskDone } from "./simple.js";

const PRIO = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
const tz = () => state.tz;
const dmy = iso => { if (!iso) return ""; const [y, m, d] = iso.slice(0, 10).split("-"); return `${d}/${m}/${y}`; };
const taskDate = t => t.due_at ? zonedDate(t.due_at, tz()) : null;
const tasksOf = pid => state.tasks.filter(t => t.project_id === pid && !t.deleted_at && !t.parent_id && t.status !== "cancelled").sort((a, b) => (a.sort - b.sort) || a.created_at.localeCompare(b.created_at));
const slug = s => String(s).replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "workspace";

/* The columns shared by the template and the full export, so an export can be edited and imported again. */
const COLS = ["Project", "Project deadline", "Project priority", "Task", "Reference", "Task deadline", "Task notes", "Step", "Responsible", "Step status"];

/* ---------------- download ---------------- */
export function openExport(wsId) {
  const w = wsById(wsId); if (!w) return;
  const ps = state.projects.filter(p => p.workspace_id === wsId && !p.archived);
  const n = { open: ps.filter(p => !p.closed_at).length, closed: ps.filter(p => p.closed_at).length, all: ps.length };
  openSheet(sh => {
    sh.innerHTML = sheetHead("Download Excel", esc(w.name)) + `<div class="sh-body">
      <p class="hint">One row per step, with every project and task detail. Opens in Excel or Google Sheets.</p>
      <div class="sw-choice">
        <button class="btn block" data-act="swx-export" data-ws="${wsId}" data-k="open" ${n.open ? "" : "disabled"}>Open projects <span class="num faint">${n.open}</span></button>
        <button class="btn block" data-act="swx-export" data-ws="${wsId}" data-k="closed" ${n.closed ? "" : "disabled"}>Closed projects <span class="num faint">${n.closed}</span></button>
        <button class="btn block primary" data-act="swx-export" data-ws="${wsId}" data-k="all" ${n.all ? "" : "disabled"}>All projects <span class="num">${n.all}</span></button>
      </div></div>`;
  });
}
export function exportWorkspace(wsId, kind) {
  const w = wsById(wsId);
  const ps = state.projects.filter(p => p.workspace_id === wsId && !p.archived && (kind === "all" || (kind === "closed" ? p.closed_at : !p.closed_at)))
    .sort((a, b) => (a.target_date || "9999").localeCompare(b.target_date || "9999") || a.name.localeCompare(b.name));
  const today = todayISO(tz());
  const summary = ps.map(p => {
    const s = projectStats(p);
    return [p.name, STATUS[s.status], PRIO[p.priority] || p.priority, dmy(p.target_date), s.daysLeft === null || p.closed_at ? null : s.daysLeft, s.pct, `${s.done}/${s.total}`,
      s.next ? (s.next.s ? s.next.s.title : s.next.t.title) : "", s.next && s.next.s ? s.next.s.responsible || "" : "", p.closed_at ? dmy(zonedDate(p.closed_at, tz())) : "", p.description || ""];
  });
  const rows = [];
  for (const p of ps) {
    const s = projectStats(p);
    const ts = tasksOf(p.id);
    if (!ts.length) rows.push([p.name, dmy(p.target_date), PRIO[p.priority], "", "", "", "", "", "", "", STATUS[s.status], "", "", "", "", ""]);
    for (const t of ts) {
      const td = taskDate(t), st = stepsOf(t.id);
      const late = td && !taskDone(t) && td < today ? "Late" : "";
      const tStatus = taskDone(t) ? "Done" : st.some(x => x.status === "done") ? "In progress" : "Pending";
      const base = [p.name, dmy(p.target_date), PRIO[p.priority], t.title, t.reference || "", dmy(td), t.description || ""];
      if (!st.length) rows.push([...base, "", "", "", STATUS[s.status], tStatus, late, "", "", p.closed_at ? dmy(zonedDate(p.closed_at, tz())) : ""]);
      for (const x of st) rows.push([...base, x.title, x.responsible || "", x.status === "done" ? "Done" : "Pending", STATUS[s.status], tStatus, late, x.done_at ? dmy(zonedDate(x.done_at, tz())) : "", x.note || "", p.closed_at ? dmy(zonedDate(p.closed_at, tz())) : ""]);
    }
  }
  const label = { open: "Open", closed: "Closed", all: "All" }[kind];
  downloadXlsx(`${slug(w.name)}-${label.toLowerCase()}-projects-${today}.xlsx`, [
    { name: "Projects", columns: ["Project", "Status", "Priority", "Deadline", "Days left", "Progress %", "Done", "Next step", "Next step by", "Closed on", "Description"].map(label => ({ label })), rows: summary },
    { name: "Tasks & steps", columns: [...COLS, "Project status", "Task status", "Late", "Step done on", "Step note", "Project closed on"].map(label => ({ label })), rows }
  ]);
  closeSheet(); toast(`Downloaded ${ps.length} ${label.toLowerCase()} project(s)`);
}

/* ---------------- template ---------------- */
export function downloadTemplate(wsId) {
  const w = wsById(wsId);
  const ex = [
    ["Pending POs", "10/12/2026", "Critical", "Close PO-0586", "PO-0586", "05/12/2026", "Supplier: Al Muthawa", "Waiting for shipment arrival", "Adil", "Pending"],
    ["Pending POs", "10/12/2026", "Critical", "Close PO-0586", "PO-0586", "05/12/2026", "Supplier: Al Muthawa", "Followed up with freight forwarder", "Jezil", "Done"],
    ["Riyadh suite", "20/12/2026", "High", "Suit order", "INV-689766", "", "", "Fabric to be purchased", "Jezil", "Pending"],
    ["Riyadh suite", "20/12/2026", "High", "Suit order", "INV-689766", "", "", "Stitching completed, waiting for delivery", "Shahul", "Pending"]
  ];
  const help = [
    ["How to fill the Jobs sheet"],
    ["One row = one step. Repeat the Project and Task on every row that belongs to them."],
    ["Project and Task are required. Everything else is optional."],
    ["Dates: DD/MM/YYYY, e.g. 10/12/2026 (an Excel date cell also works)."],
    ["Project priority: Critical, High, Medium or Low (Medium if empty)."],
    ["Step status: Pending or Done (Pending if empty)."],
    ["A project that already exists in this workspace (same name, still open) gets the new tasks added to it."],
    ["A task with no step: fill Project and Task, leave Step empty."],
    ["Then in J. Desk: open the workspace → Import → choose this file → check the preview → Confirm."],
    ["See the Example sheet for how a finished file looks. Rows in the Example sheet are not imported."]
  ];
  downloadXlsx(`J-Desk-import-template-${slug(w ? w.name : "workspace")}.xlsx`, [
    { name: "Jobs", columns: COLS.map(label => ({ label, width: label === "Step" ? 40 : label === "Task" ? 30 : undefined })), rows: [] },
    { name: "Example", columns: COLS.map(label => ({ label })), rows: ex },
    { name: "How to fill", columns: [{ label: "J. Desk import template", width: 100 }], rows: help }
  ]);
}

/* ---------------- import ---------------- */
let imp = null; // { wsId, file, plan, errors, saving }
let xlsxLib = null;
const loadReader = () => xlsxLib || (xlsxLib = new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"; s.onload = () => res(window.XLSX); s.onerror = () => { xlsxLib = null; rej(new Error("Couldn't load the Excel reader. Check your connection and try again.")); }; document.head.appendChild(s); }));

export function openImport(wsId) {
  imp = { wsId, plan: null, errors: [], fileName: "" };
  openSheet(renderImport, { wide: true, onClose: () => { imp = null; } });
}
function renderImport(sh) {
  const w = wsById(imp.wsId), p = imp.plan;
  sh.innerHTML = sheetHead("Import jobs from Excel", esc(w.name)) + `<div class="sh-body">
    ${!p ? `<ol class="sw-steps-help"><li>Download the template and fill it in, one row per step. <button class="linkbtn" data-act="swx-template" data-ws="${imp.wsId}">${ICON.download} Download template</button></li>
      <li>Choose the filled file. You'll see a preview first — nothing is saved until you press Confirm.</li></ol>
      <label class="btn primary block sw-file">${ICON.plus}Choose Excel file<input type="file" id="swx-file" accept=".xlsx,.xls,.csv" hidden></label>
      ${imp.reading ? `<p class="hint">Reading ${esc(imp.fileName)}…</p>` : ""}
      ${imp.errors.length ? `<div class="banner bad">${imp.errors.map(esc).join("<br>")}</div>` : ""}` : previewHtml(p)}
  </div>`;
}
function previewHtml(p) {
  const nTasks = p.projects.reduce((a, x) => a + x.tasks.length, 0), nSteps = p.projects.reduce((a, x) => a + x.tasks.reduce((b, t) => b + t.steps.length, 0), 0);
  const newP = p.projects.filter(x => !x.existingId).length;
  return `<p><b>${esc(imp.fileName)}</b> — this will add <b>${newP}</b> new project(s)${p.projects.length - newP ? `, add to <b>${p.projects.length - newP}</b> existing project(s)` : ""}, <b>${nTasks}</b> task(s) and <b>${nSteps}</b> step(s).</p>
    ${imp.errors.length ? `<div class="banner bad"><b>${imp.errors.length} row(s) will be skipped:</b><br>${imp.errors.slice(0, 12).map(esc).join("<br>")}${imp.errors.length > 12 ? "<br>…" : ""}</div>` : ""}
    <div class="sw-prev">${p.projects.map(x => `<div class="sw-prev-p">
      <div class="sw-prev-h"><b>${esc(x.name)}</b><span class="sw-pill ${x.existingId ? "st-not_started" : "st-working"}">${x.existingId ? "Existing project" : "New project"}</span>${x.priority ? `<span class="sw-pill pr-${x.priority}">${PRIO[x.priority]}</span>` : ""}${x.deadline ? `<span class="faint">Deadline ${dmy(x.deadline)}</span>` : ""}</div>
      ${x.tasks.map(t => `<div class="sw-prev-t"><div><b>${esc(t.title)}</b>${t.reference ? ` <small class="num">${esc(t.reference)}</small>` : ""}${t.deadline ? ` <small class="faint">· due ${dmy(t.deadline)}</small>` : ""}${t.existingId ? ` <small class="faint">· existing task</small>` : ""}</div>
        ${t.steps.map(s => `<div class="sw-prev-s"><span class="${s.status === "done" ? "ok-text" : ""}">${s.status === "done" ? "✓" : "○"}</span> ${esc(s.title)}${s.responsible ? ` <span class="sw-who">${esc(s.responsible)}</span>` : ""}</div>`).join("")}</div>`).join("")}
    </div>`).join("")}</div>
    <div class="sheet-foot"><button class="btn" data-act="swx-reset">Choose another file</button><button class="btn primary block" data-act="swx-confirm" ${nTasks || newP ? "" : "disabled"}>Confirm and add</button></div>`;
}

/** Excel serial, DD/MM/YYYY, YYYY-MM-DD or "10 Dec 2026" → YYYY-MM-DD; "" → null; anything else → undefined (invalid). */
export function parseDate(v) {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  if (typeof v === "number" && v > 20000 && v < 80000) { const d = new Date(Math.round((v - 25569) * 86400000)); return d.toISOString().slice(0, 10); }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (m) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; const iso = `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; return validIso(iso); }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return validIso(`${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`);
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})$/);
  if (m) { const mi = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[2].slice(0, 3).toLowerCase()); if (mi >= 0) return validIso(`${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`); }
  return undefined;
}
function validIso(iso) { const d = new Date(iso + "T12:00:00Z"); return isNaN(d) || d.toISOString().slice(0, 10) !== iso ? undefined : iso; }
const normPrio = v => { const s = String(v || "").trim().toLowerCase(); if (!s) return null; return PRIO[s] ? s : s.startsWith("crit") ? "critical" : s.startsWith("hi") ? "high" : s.startsWith("lo") ? "low" : s.startsWith("med") ? "medium" : undefined; };
const normStatus = v => { const s = String(v || "").trim().toLowerCase(); if (!s) return "pending"; return ["done", "completed", "complete", "yes", "y", "closed", "delivered", "ready"].includes(s) ? "done" : ["pending", "to do", "todo", "in progress", "waiting", "open", "no", "n"].includes(s) ? "pending" : undefined; };
const key = s => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

/** Turn sheet rows (objects keyed by header) into a plan. Exported for tests. */
export function buildPlan(rows, wsId) {
  const errors = [], projects = new Map();
  const existingP = state.projects.filter(p => p.workspace_id === wsId && !p.archived && !p.closed_at);
  const get = (r, name) => { const k = Object.keys(r).find(x => key(x) === key(name)); return k ? r[k] : ""; };
  rows.forEach((r, i) => {
    const line = i + 2;
    const pname = String(get(r, "Project") || "").trim(), ttitle = String(get(r, "Task") || "").trim(), step = String(get(r, "Step") || "").trim();
    if (!pname && !ttitle && !step) return; // blank row
    if (!pname) return errors.push(`Row ${line}: Project is empty`);
    if (!ttitle && step) return errors.push(`Row ${line}: Task is empty`);
    const pd = parseDate(get(r, "Project deadline")), td = parseDate(get(r, "Task deadline"));
    if (pd === undefined) return errors.push(`Row ${line}: Project deadline "${get(r, "Project deadline")}" isn't a date (use DD/MM/YYYY)`);
    if (td === undefined) return errors.push(`Row ${line}: Task deadline "${get(r, "Task deadline")}" isn't a date (use DD/MM/YYYY)`);
    const pr = normPrio(get(r, "Project priority"));
    if (pr === undefined) return errors.push(`Row ${line}: Priority "${get(r, "Project priority")}" should be Critical, High, Medium or Low`);
    const st = normStatus(get(r, "Step status"));
    if (st === undefined) return errors.push(`Row ${line}: Step status "${get(r, "Step status")}" should be Pending or Done`);
    if (pname.length > 120) return errors.push(`Row ${line}: Project name is longer than 120 characters`);
    let P = projects.get(key(pname));
    if (!P) {
      const ex = existingP.find(p => key(p.name) === key(pname));
      P = { name: pname, existingId: ex ? ex.id : null, deadline: pd, priority: pr, tasks: [], taskMap: new Map() };
      projects.set(key(pname), P);
    } else { if (pd && !P.deadline) P.deadline = pd; if (pr && !P.priority) P.priority = pr; }
    if (!ttitle) return; // project-only row
    let T = P.taskMap.get(key(ttitle));
    if (!T) {
      const ex = P.existingId && state.tasks.find(t => t.project_id === P.existingId && !t.deleted_at && key(t.title) === key(ttitle));
      T = { title: ttitle.slice(0, 300), reference: String(get(r, "Reference") || "").trim().slice(0, 60) || null, deadline: td, notes: String(get(r, "Task notes") || get(r, "Notes") || "").trim() || null, existingId: ex ? ex.id : null, steps: [] };
      P.taskMap.set(key(ttitle), T); P.tasks.push(T);
    } else if (td && !T.deadline) T.deadline = td;
    if (step) {
      const already = T.existingId && stepsOf(T.existingId).some(s => key(s.title) === key(step));
      if (already) return errors.push(`Row ${line}: step "${step}" already exists on "${ttitle}"`);
      T.steps.push({ title: step.slice(0, 300), responsible: String(get(r, "Responsible") || "").trim().slice(0, 80) || null, status: st });
    }
  });
  return { projects: [...projects.values()], errors };
}

async function readFile(file) {
  const X = await loadReader();
  const wb = X.read(await file.arrayBuffer(), { type: "array" });
  const name = wb.SheetNames.find(n => key(n) === "jobs") || wb.SheetNames.find(n => !["example", "how to fill", "projects"].includes(key(n))) || wb.SheetNames[0];
  // an exported file can be imported again: its detail sheet is "Tasks & steps"
  const pick = wb.SheetNames.find(n => key(n) === "tasks & steps") && !wb.SheetNames.some(n => key(n) === "jobs") ? "Tasks & steps" : name;
  return X.utils.sheet_to_json(wb.Sheets[pick], { defval: "", raw: true });
}

async function confirmImport(btn) {
  const p = imp.plan, wsId = imp.wsId; busy(btn, true, "Adding…");
  let made = { projects: 0, tasks: 0, steps: 0 }, failed = null;
  try {
    for (const P of p.projects) {
      let pid = P.existingId;
      if (!pid) {
        const r = await run(sb.from("projects").insert({ workspace_id: wsId, name: P.name, priority: P.priority || "medium", target_date: P.deadline || null }).select().single());
        if (r.error) throw new Error(`Project "${P.name}": ${r.error}`);
        state.projects.push(r.data); pid = r.data.id; made.projects++;
      }
      let sort = Math.max(0, ...state.tasks.filter(t => t.project_id === pid).map(t => Number(t.sort) || 0));
      for (const T of P.tasks) {
        let tid = T.existingId;
        if (!tid) {
          const r = await run(sb.from("tasks").insert({ workspace_id: wsId, project_id: pid, title: T.title, reference: T.reference, description: T.notes, status: T.steps.some(s => s.status === "done") ? "in_progress" : "not_started",
            priority: P.priority === "critical" ? "critical" : "medium", owner_id: state.user.id, sort: ++sort, due_at: T.deadline ? zonedToISO(T.deadline, "23:59", tz()) : null, due_all_day: true }).select().single());
          if (r.error) throw new Error(`Task "${T.title}": ${r.error}`);
          state.tasks.push(r.data); tid = r.data.id; made.tasks++;
        }
        if (T.steps.length) {
          const base = Math.max(0, ...stepsOf(tid).map(s => s.sort));
          const r = await run(sb.from("task_steps").insert(T.steps.map((s, i) => ({ task_id: tid, workspace_id: wsId, title: s.title, responsible: s.responsible, status: s.status, sort: base + i + 1 }))).select());
          if (r.error) throw new Error(`Steps of "${T.title}": ${r.error}`);
          state.steps.push(...r.data); made.steps += r.data.length;
        }
      }
    }
  } catch (e) { failed = e.message; }
  busy(btn, false); reindex(); emit("data");
  if (failed) { toastError(`Stopped: ${failed}. Added so far: ${made.projects} project(s), ${made.tasks} task(s), ${made.steps} step(s).`); return; }
  closeSheet(); toast(`Added ${made.projects} project(s), ${made.tasks} task(s) and ${made.steps} step(s)`);
}

export async function handleIoClick(act, el) {
  if (!act.startsWith("swx-")) return false;
  switch (act) {
    case "swx-open-export": openExport(el.dataset.ws); break;
    case "swx-export": exportWorkspace(el.dataset.ws, el.dataset.k); break;
    case "swx-open-import": if (canWrite(el.dataset.ws)) openImport(el.dataset.ws); break;
    case "swx-template": downloadTemplate(el.dataset.ws); break;
    case "swx-reset": imp.plan = null; imp.errors = []; rerenderSheet(); break;
    case "swx-confirm": await confirmImport(el); break;
  }
  return true;
}
export async function handleIoChange(e) {
  if (e.target.id !== "swx-file" || !imp) return false;
  const file = e.target.files[0]; if (!file) return true;
  imp.fileName = file.name; imp.reading = true; imp.errors = []; rerenderSheet();
  try {
    const rows = await readFile(file);
    const plan = buildPlan(rows, imp.wsId);
    imp.reading = false;
    if (!plan.projects.length) { imp.errors = plan.errors.length ? plan.errors : ["No rows found. Fill the Jobs sheet: one row per step, with Project and Task on every row."]; rerenderSheet(); return true; }
    imp.plan = plan; imp.errors = plan.errors;
  } catch (err) { imp.reading = false; imp.errors = [err.message || "Couldn't read that file."]; }
  rerenderSheet();
  return true;
}
