// Reusable UI pieces: icons, chips, task rows, sheets, dialogs and toasts.
import { esc, fmtDate, zonedDate, zonedTime, relDay, ago } from "./util.js";
import { STATUS_SHORT, PRIORITY_LABEL, isOverdue, isClosed, dueInDays, isReady, openPrerequisites, PROJECT_STATUS_LABEL } from "./logic.js";
import { state, wsById, projectById, nameOf, shortName, subtasksOf } from "./store.js";

export const $ = id => document.getElementById(id);
const P = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
export const ICON = {
  home: P('<path d="M4 11l8-6.5 8 6.5"/><path d="M6 10v9.5h12V10"/>'),
  tasks: P('<path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M3.8 6.5l1.2 1.2 2-2.2M3.8 12l1.2 1.2 2-2.2M3.8 17.5l1.2 1.2 2-2.2"/>'),
  folder: P('<path d="M3.5 7.5a2 2 0 012-2h4l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2h-13a2 2 0 01-2-2z"/>'),
  calendar: P('<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3"/>'),
  finance: P('<path d="M4 19.5h16M6 16V11M10 16V8M14 16v-6M18 16V6"/>'),
  goals: P('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".9" fill="currentColor"/>'),
  notes: P('<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4M9 12h6M9 15.5h6"/>'),
  reports: P('<path d="M4 20V4M4 20h16"/><path d="M8 15l3.5-4 3 2.5L19 8"/>'),
  settings: P('<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.2 7l2 1.2M17.8 15.8l2 1.2M4.2 17l2-1.2M17.8 8.2l2-1.2"/>'),
  search: P('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
  bell: P('<path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 004 0"/>'),
  plus: P('<path d="M12 5v14M5 12h14"/>'),
  close: P('<path d="M6 6l12 12M18 6L6 18"/>'),
  check: P('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  more: P('<circle cx="5.5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor"/>'),
  back: P('<path d="M15 5l-7 7 7 7"/>'),
  chevron: P('<path d="M9 6l6 6-6 6"/>'),
  people: P('<circle cx="9" cy="8.5" r="3.2"/><path d="M3 19.5c.9-3 3.2-4.6 6-4.6s5.1 1.6 6 4.6"/><circle cx="17" cy="9.5" r="2.5"/><path d="M16.5 14.6c2.3.1 4 1.5 4.6 3.9"/>'),
  phone: P('<path d="M6.5 3.5h3l1.5 4-2 1.5a11 11 0 005 5l1.5-2 4 1.5v3a2 2 0 01-2 2A15.5 15.5 0 014.5 5.5a2 2 0 012-2z"/>'),
  clock: P('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  flag: P('<path d="M5.5 21V4M5.5 4.5h11l-2 4 2 4h-11"/>'),
  link: P('<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>'),
  board: P('<rect x="3.5" y="4" width="5" height="16" rx="1.2"/><rect x="9.5" y="4" width="5" height="11" rx="1.2"/><rect x="15.5" y="4" width="5" height="13" rx="1.2"/>'),
  list: P('<path d="M4 6.5h16M4 12h16M4 17.5h16"/>'),
  trash: P('<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/>'),
  user: P('<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.3-3.6 4.2-5.4 7.5-5.4s6.2 1.8 7.5 5.4"/>'),
  note: P('<path d="M5 5h14v10l-4 4H5z"/><path d="M15 19v-4h4"/>'),
  done: P('<circle cx="12" cy="12" r="8.5"/><path d="M8 12.5l3 3 5-6"/>'),
  alert: P('<path d="M12 4l9 15.5H3z"/><path d="M12 10v4.5M12 17.2v.3"/>'),
  lock: P('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 018 0v2.5"/>'),
  milestone: P('<path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z"/>'),
  filter: P('<path d="M4 5.5h16l-6 7.5v5l-4 2v-7z"/>'),
  download: P('<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>'),
  sun: P('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M5.2 18.8l1.4-1.4M17.4 6.6l1.4-1.4"/>')
};

const hue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
export const initials = uid => nameOf(uid).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "?";
export const avatar = (uid, cls = "") => uid ? `<span class="av ${cls}" style="--h:${hue(uid)}" title="${esc(nameOf(uid))}">${esc(initials(uid))}</span>` : "";
export const wsDot = ws => ws ? `<i class="dot" style="background:${esc(ws.color)}"></i>` : "";
export const prioChip = p => `<span class="prio p-${p}"><i></i>${PRIORITY_LABEL[p]}</span>`;
export const statusPill = s => `<span class="pill s-${s}">${STATUS_SHORT[s]}</span>`;
export const projectPill = s => `<span class="pill ps-${s}">${PROJECT_STATUS_LABEL[s] || s}</span>`;

export function dueLabel(t) {
  if (!t.due_at) return { cls: "", text: "" };
  const tz = state.tz, d = zonedDate(t.due_at, tz), time = t.due_all_day ? "" : " " + zonedTime(t.due_at, tz);
  if (isClosed(t)) return { cls: "", text: fmtDate(d) };
  const n = dueInDays(t, tz);
  if (isOverdue(t)) return { cls: "over", text: n < 0 ? `${-n}d overdue` : `Overdue${time}` };
  if (n === 0) return { cls: "soon", text: "Today" + time };
  if (n === 1) return { cls: "soon", text: "Tomorrow" + time };
  if (n <= 6) return { cls: n <= 3 ? "soon" : "", text: relDay(d, tz) + time };
  return { cls: "", text: fmtDate(d) + time };
}

/** One task row, used everywhere tasks are listed. */
export function taskRow(t, { showWs = true, selectable = false, selected = false } = {}) {
  const ws = wsById(t.workspace_id), proj = projectById(t.project_id), d = dueLabel(t), closed = isClosed(t);
  const subs = subtasksOf(t.id), subsOpen = subs.filter(s => !isClosed(s)).length;
  const notReady = !closed && !isReady(t, state.deps, state.taskById);
  const meta = [];
  if (showWs && ws) meta.push(`<span class="m-ws">${wsDot(ws)}${esc(ws.name)}</span>`);
  if (proj) meta.push(`<span>${esc(proj.name)}</span>`);
  if (t.status === "waiting" && t.waiting_on) meta.push(`<span class="m-wait">Waiting on ${esc(t.waiting_on)}</span>`);
  if (t.status === "blocked" && t.blocker) meta.push(`<span class="m-block">${esc(t.blocker)}</span>`);
  if (subs.length) meta.push(`<span class="num">${subs.length - subsOpen}/${subs.length} subtasks</span>`);
  if (notReady) meta.push(`<span class="m-dep">${ICON.lock}Waiting on ${openPrerequisites(t, state.deps, state.taskById).length} task(s)</span>`);
  if (t.reference) meta.push(`<span class="num">${esc(t.reference)}</span>`);
  return `<div class="trow p-${t.priority} ${closed ? "closed" : ""} ${selected ? "sel" : ""}" data-act="open-task" data-id="${t.id}" role="button" tabindex="0">
    ${selectable ? `<input type="checkbox" class="tsel" data-act="select-task" data-id="${t.id}" ${selected ? "checked" : ""} aria-label="Select task">` :
      `<button class="tcheck ${t.status === "completed" ? "on" : ""}" data-act="toggle-complete" data-id="${t.id}" aria-label="${t.status === "completed" ? "Reopen" : "Complete"} task">${t.status === "completed" ? ICON.check : ""}</button>`}
    <div class="tmain">
      <div class="ttitle">${esc(t.title)}</div>
      ${meta.length ? `<div class="tmeta">${meta.join("")}</div>` : ""}
      ${t.next_action && !closed ? `<div class="tnext"><b>Next:</b> ${esc(t.next_action)}</div>` : ""}
    </div>
    <div class="tside">
      ${prioChip(t.priority)}
      ${statusPill(t.status)}
      ${d.text ? `<span class="due ${d.cls}">${d.text}</span>` : ""}
      ${t.review_status === "requested" ? `<span class="chip" title="Waiting for review">In review</span>` : ""}
      ${(t.assignee_id || t.owner_id) && (t.assignee_id || t.owner_id) !== state.user.id ? avatar(t.assignee_id || t.owner_id, "sm") : ""}
    </div>
  </div>`;
}

export function emptyState(title, text, action = "") {
  return `<div class="empty"><strong>${esc(title)}</strong>${text ? `<span>${esc(text)}</span>` : ""}${action}</div>`;
}
export const section = (title, inner, opts = {}) => `<section class="sect ${opts.cls || ""}">
  <div class="sect-h"><h2>${esc(title)}</h2>${opts.count !== undefined ? `<span class="c">${opts.count}</span>` : ""}${opts.right || ""}</div>${inner}</section>`;

/* ---------- toast ---------- */
let toastTimer;
export function toast(msg, opts = {}) {
  const el = $("toast");
  el.className = "toast " + (opts.type || "");
  el.innerHTML = `<span>${esc(msg)}</span>` + (opts.action ? `<button type="button">${esc(opts.action.label)}</button>` : "");
  if (opts.action) el.querySelector("button").onclick = () => { el.hidden = true; opts.action.run(); };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), opts.action ? 6500 : opts.type === "error" ? 6000 : 2800);
}
export const toastError = msg => toast(msg, { type: "error" });

/* ---------- sheets (side panel on desktop, bottom sheet on phones) ---------- */
const stack = [];
export function openSheet(render, { wide = false, onClose } = {}) {
  stack.push({ render, onClose });
  const wrap = $("sheetWrap"), sh = $("sheet");
  sh.classList.toggle("wide", wide);
  wrap.hidden = false; document.body.classList.add("noscroll");
  render(sh);
  setTimeout(() => { const f = sh.querySelector("[autofocus]"); if (f) f.focus(); }, 40);
}
export function rerenderSheet() { const top = stack[stack.length - 1]; if (top) top.render($("sheet")); }
export function closeSheet() {
  const top = stack.pop();
  if (top && top.onClose) top.onClose();
  if (stack.length) { stack[stack.length - 1].render($("sheet")); return; }
  $("sheetWrap").hidden = true; document.body.classList.remove("noscroll"); $("sheet").innerHTML = "";
}
export function closeAllSheets() { while (stack.length) closeSheet(); }
export const sheetOpen = () => stack.length > 0;
export const sheetHead = (title, sub = "") => `<div class="sheet-h"><div class="grabber"></div><div class="sh-row"><div style="min-width:0"><h2>${esc(title)}</h2>${sub ? `<p class="sh-sub">${sub}</p>` : ""}</div><button class="iconbtn" data-act="close-sheet" aria-label="Close">${ICON.close}</button></div></div>`;

/* ---------- in-page dialogs (the viewer has no native confirm/prompt) ---------- */
export function dialog({ title, text = "", input = null, confirm = "OK", danger = false, cancel = "Cancel" }) {
  return new Promise(resolve => {
    const d = $("dialog");
    d.innerHTML = `<div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dlgT">
      <h3 id="dlgT">${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ""}
      ${input ? `<label class="field"><span>${esc(input.label)}</span>${input.multiline ? `<textarea class="input" id="dlgIn" rows="3" placeholder="${esc(input.placeholder || "")}"></textarea>` : `<input class="input" id="dlgIn" placeholder="${esc(input.placeholder || "")}">`}</label>` : ""}
      <p class="dlg-err" id="dlgErr" hidden></p>
      <div class="dlg-btns"><button class="btn" data-r="0">${esc(cancel)}</button><button class="btn ${danger ? "danger-fill" : "primary"}" data-r="1">${esc(confirm)}</button></div></div>`;
    d.hidden = false;
    const inp = $("dlgIn"); if (inp) setTimeout(() => inp.focus(), 30); else setTimeout(() => d.querySelector('[data-r="1"]').focus(), 30);
    const done = v => { d.hidden = true; d.innerHTML = ""; document.removeEventListener("keydown", key); resolve(v); };
    const key = e => { if (e.key === "Escape") done(null); if (e.key === "Enter" && (!inp || inp.tagName === "INPUT")) d.querySelector('[data-r="1"]').click(); };
    document.addEventListener("keydown", key);
    d.onclick = e => {
      const b = e.target.closest("[data-r]"); if (!b && e.target === d) return done(null); if (!b) return;
      if (b.dataset.r === "0") return done(null);
      if (input) {
        const v = inp.value.trim();
        if (input.required && v.length < (input.min || 1)) { const er = $("dlgErr"); er.textContent = input.requiredText || "This is required."; er.hidden = false; return; }
        return done(v);
      }
      done(true);
    };
  });
}

export function busy(btn, on = true, label = "Saving…") {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = label; }
  else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
}

export const healthBadge = h => h ? `${projectPill(h.effective_status)}${h.calculated_status !== h.effective_status ? `<span class="calc-note">calculated: ${PROJECT_STATUS_LABEL[h.calculated_status]}</span>` : ""}` : "";
export const agoText = ago;
