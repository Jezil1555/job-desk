// Calendar, Follow-ups, Search, Alerts, Settings and the modules planned for later phases.
import { integrationsHtml } from "./integrations.js";
import { esc, fmtDate, zonedDate, zonedTime, zonedToISO, todayISO, addDays, weekdayOf, fmtDateTime, ago, DEFAULT_TZ } from "../util.js";
import { isOpen, isOverdue, STATUS_LABEL } from "../logic.js";
import { state, wsById, projectById, contactById, activeWorkspaces, canWrite, nameOf } from "../store.js";
import { sb, run, savePrefs } from "../api.js";
import { ICON, taskRow, section, emptyState, wsDot, toast, toastError } from "../ui.js";
import { fuLine } from "./workspaces.js";
import { snoozeUntil } from "../smart.js";
import { HOME_SECTIONS } from "./home.js";

/* ======================= Calendar ======================= */
function itemsOn(day) {
  const tz = state.tz, act = new Set(activeWorkspaces().map(w => w.id)), wsF = state.ui.calWs;
  const ok = x => act.has(x.workspace_id) && (!wsF || x.workspace_id === wsF);
  const out = [];
  state.tasks.forEach(t => {
    if (!ok(t) || t.deleted_at || t.status === "cancelled") return;
    if (t.due_at && zonedDate(t.due_at, tz) === day) out.push({ k: "due", t, time: t.due_all_day ? "" : zonedTime(t.due_at, tz) });
    if (t.follow_up_at && isOpen(t) && zonedDate(t.follow_up_at, tz) === day) out.push({ k: "tfu", t, time: zonedTime(t.follow_up_at, tz) });
    if (t.start_date === day && isOpen(t)) out.push({ k: "start", t });
  });
  state.followUps.forEach(f => { if (ok(f) && ["open", "escalated"].includes(f.status) && f.next_follow_up_at && zonedDate(f.next_follow_up_at, tz) === day) out.push({ k: "fu", f, time: zonedTime(f.next_follow_up_at, tz) }); });
  state.milestones.forEach(m => { const p = projectById(m.project_id); if (p && ok(p) && (m.planned_date === day || m.actual_date === day)) out.push({ k: "ms", m, done: !!m.actual_date }); });
  return out.sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));
}
function chip(x, full = false) {
  if (x.k === "due" || x.k === "tfu" || x.k === "start") {
    const t = x.t, closed = !isOpen(t), over = isOverdue(t);
    const pre = x.k === "tfu" ? "Follow up: " : x.k === "start" ? "Start: " : "";
    return `<button class="cal-it ${x.k} p-${t.priority} ${closed ? "closed" : ""} ${over && x.k === "due" ? "over" : ""}" data-act="open-task" data-id="${t.id}">${x.time ? `<span class="num">${x.time}</span>` : ""}${esc(pre + t.title)}${full ? ` <small>${esc((wsById(t.workspace_id) || {}).name || "")}</small>` : ""}</button>`;
  }
  if (x.k === "fu") return `<button class="cal-it fu" data-act="open-followup" data-id="${x.f.id}">${ICON.phone}${x.time ? `<span class="num">${x.time}</span>` : ""}${esc(x.f.subject)}</button>`;
  return `<button class="cal-it ms ${x.done ? "closed" : ""}" data-act="open-project" data-id="${x.m.project_id}">${ICON.milestone}${esc(x.m.title)}${full ? ` <small>${esc((projectById(x.m.project_id) || {}).name || "")}</small>` : ""}</button>`;
}

export function renderCalendar(view) {
  const tz = state.tz, today = todayISO(tz);
  const mode = state.ui.calMode || "month";
  const cur = state.ui.calCursor || today;
  let title = "", body = "";
  if (mode === "month") {
    const first = cur.slice(0, 8) + "01";
    const startOffset = (weekdayOf(first) + 1) % 7; // weeks start Saturday? use Sunday-first for GCC working week (Sun–Thu)
    const gridStart = addDays(first, -weekdayOf(first));
    title = fmtDate(first, { month: "long", year: "numeric" });
    const days = [...Array(42)].map((_, i) => addDays(gridStart, i));
    body = `<div class="cal-month"><div class="cal-dow">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => `<span class="${d === "Fri" || d === "Sat" ? "we" : ""}">${d}</span>`).join("")}</div>
      <div class="cal-grid">${days.map(d => { const its = itemsOn(d); return `<div class="cal-cell ${d.slice(0, 7) !== first.slice(0, 7) ? "out" : ""} ${d === today ? "today" : ""} ${[5, 6].includes(weekdayOf(d)) ? "we" : ""}">
        <button class="cal-dn" data-act="cal-day" data-d="${d}">${+d.slice(8)}</button>${its.slice(0, 3).map(x => chip(x)).join("")}${its.length > 3 ? `<button class="cal-more" data-act="cal-day" data-d="${d}">+${its.length - 3} more</button>` : ""}</div>`; }).join("")}</div></div>`;
  } else if (mode === "week") {
    const start = addDays(cur, -weekdayOf(cur));
    title = `${fmtDate(start, { day: "numeric", month: "short" })} – ${fmtDate(addDays(start, 6), { day: "numeric", month: "short", year: "numeric" })}`;
    body = `<div class="cal-week">${[...Array(7)].map((_, i) => { const d = addDays(start, i), its = itemsOn(d); return `<div class="cal-wd ${d === today ? "today" : ""}"><button class="cal-wh" data-act="cal-day" data-d="${d}">${fmtDate(d, { weekday: "short", day: "numeric" })}</button>${its.map(x => chip(x)).join("") || `<span class="bempty">—</span>`}</div>`; }).join("")}</div>`;
  } else {
    title = fmtDate(cur, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const its = itemsOn(cur);
    body = its.length ? `<div class="cal-day">${its.map(x => chip(x, true)).join("")}</div>` : emptyState("Nothing scheduled", "No deadlines, follow-ups or milestones on this day.");
  }
  view.innerHTML = `<div class="page-head"><div><h1>Calendar</h1><p class="sub">Deadlines, follow-ups and milestones, shown in ${esc(tz)}.</p></div>
    <div class="filters"><select class="input sm" id="cal-ws"><option value="">All workspaces</option>${activeWorkspaces().map(w => `<option value="${w.id}" ${state.ui.calWs === w.id ? "selected" : ""}>${esc(w.name)}</option>`).join("")}</select>
    <div class="segbtn">${["month", "week", "day"].map(m => `<button class="${mode === m ? "on" : ""}" data-act="cal-mode" data-m="${m}">${m[0].toUpperCase() + m.slice(1)}</button>`).join("")}</div></div></div>
  <div class="cal-nav"><button class="iconbtn" data-act="cal-prev" aria-label="Previous">${ICON.back}</button><h2>${title}</h2><button class="iconbtn flip" data-act="cal-next" aria-label="Next">${ICON.back}</button><button class="btn sm" data-act="cal-today">Today</button>
    <span class="legend"><span><i class="lg due"></i>Deadline</span><span><i class="lg tfu"></i>Follow-up</span><span><i class="lg ms"></i>Milestone</span></span></div>
  ${body}`;
}
export function handleCalendarClick(act, el, rerender) {
  const tz = state.tz, cur = state.ui.calCursor || todayISO(tz), mode = state.ui.calMode || "month";
  const step = mode === "month" ? null : mode === "week" ? 7 : 1;
  const shiftMonth = n => { const [y, m] = cur.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 10); };
  switch (act) {
    case "cal-mode": state.ui.calMode = el.dataset.m; rerender(); return true;
    case "cal-prev": state.ui.calCursor = step ? addDays(cur, -step) : shiftMonth(-1); rerender(); return true;
    case "cal-next": state.ui.calCursor = step ? addDays(cur, step) : shiftMonth(1); rerender(); return true;
    case "cal-today": state.ui.calCursor = todayISO(tz); rerender(); return true;
    case "cal-day": state.ui.calCursor = el.dataset.d; state.ui.calMode = "day"; rerender(); return true;
  }
  return false;
}

/* ======================= Follow-ups ======================= */
export function renderFollowUps(view) {
  const now = new Date(), today = todayISO(state.tz), wsF = state.ui.fuWs;
  const act = new Set(activeWorkspaces().map(w => w.id));
  const all = state.followUps.filter(f => act.has(f.workspace_id) && (!wsF || f.workspace_id === wsF));
  const live = all.filter(f => ["open", "escalated"].includes(f.status));
  const esc_ = live.filter(f => f.status === "escalated");
  const due = live.filter(f => f.status === "open" && f.next_follow_up_at && new Date(f.next_follow_up_at) <= now);
  const late = live.filter(f => f.status === "open" && !due.includes(f) && f.expected_at && f.expected_at < today);
  const awaiting = live.filter(f => f.status === "open" && f.direction === "they_owe" && !due.includes(f) && !late.includes(f));
  const iowe = live.filter(f => f.status === "open" && f.direction === "i_owe" && !due.includes(f) && !late.includes(f));
  const closed = all.filter(f => ["closed", "cancelled"].includes(f.status)).slice(0, 20);
  const waitingTasks = state.tasks.filter(t => t.status === "waiting" && act.has(t.workspace_id) && (!wsF || t.workspace_id === wsF));
  const sec = (title, list, cls) => list.length ? section(title, `<div class="list">${list.map(fuLine).join("")}</div>`, { count: list.length, cls }) : "";
  view.innerHTML = `<div class="page-head"><div><h1>Follow-ups & commitments</h1><p class="sub">Who owes you what, what you've promised, and when to chase.</p></div>
    <div class="filters"><select class="input sm" id="fu-filter-ws"><option value="">All workspaces</option>${activeWorkspaces().map(w => `<option value="${w.id}" ${wsF === w.id ? "selected" : ""}>${esc(w.name)}</option>`).join("")}</select>
    <button class="btn primary" data-act="new-followup">${ICON.plus}New follow-up</button></div></div>
  ${!live.length && !waitingTasks.length ? emptyState("No open follow-ups", "When you're waiting on a supplier, customer or colleague, record it here so it can't slip.", `<button class="btn primary" data-act="new-followup">New follow-up</button>`) : ""}
  ${sec("Escalated", esc_, "risk")}${sec("Follow up now", due, "attention")}${sec("Response overdue", late, "attention")}${sec("Awaiting response", awaiting)}${sec("I owe them", iowe)}
  ${waitingTasks.length ? section("Tasks waiting on someone", `<div class="list">${waitingTasks.map(t => taskRow(t)).join("")}</div>`, { count: waitingTasks.length }) : ""}
  ${closed.length ? section("Recently closed", `<div class="list">${closed.map(fuLine).join("")}</div>`) : ""}`;
}

/* ======================= Search ======================= */
export function renderSearch(view) {
  const q = state.ui.globalQ || "";
  view.innerHTML = `<div class="page-head"><div><h1>Search</h1><p class="sub">Tasks, projects, follow-ups, contacts and updates across every workspace you can access.</p></div></div>
    <div class="searchbar big">${ICON.search}<input class="input" id="global-q" type="search" value="${esc(q)}" placeholder="Search everything…" autocomplete="off" autofocus></div>
    <div id="searchResults">${q.length < 2 ? `<p class="calm">Type at least 2 characters.</p>` : `<p class="calm">Searching…</p>`}</div>`;
  if (q.length >= 2) runSearch(q);
}
let searchSeq = 0;
export async function runSearch(q) {
  const box = document.getElementById("searchResults"); if (!box) return;
  if (q.trim().length < 2) { box.innerHTML = `<p class="calm">Type at least 2 characters.</p>`; return; }
  const seq = ++searchSeq;
  const r = await run(sb.rpc("search_all", { q }));
  if (seq !== searchSeq || !document.getElementById("searchResults")) return;
  if (r.error) { box.innerHTML = `<div class="banner bad">${esc(r.error)}</div>`; return; }
  const groups = { task: "Tasks", project: "Projects", follow_up: "Follow-ups", note: "Notes", document: "Documents", contact: "Contacts", comment: "Updates" };
  const act = { task: "open-task", project: "open-project", follow_up: "open-followup", note: "open-note", document: "open-doc", contact: "open-contact", comment: "open-task" };
  const rows = r.data || [];
  box.innerHTML = rows.length ? Object.keys(groups).map(k => { const g = rows.filter(x => x.kind === k); return g.length ? section(groups[k], `<div class="list">${g.map(x => `<button class="srow" data-act="${act[k]}" data-id="${x.id}"><span class="ttitle">${esc(x.title)}</span><span class="tmeta">${wsDot(wsById(x.workspace_id))}${esc((wsById(x.workspace_id) || {}).name || "")}${x.subtitle ? " · " + esc(x.subtitle) : ""}</span></button>`).join("")}</div>`, { count: g.length }) : ""; }).join("")
    : emptyState("No results", `Nothing matches “${q}”.`);
}

/* ======================= Alerts ======================= */
const ALERT_ICON = { assigned: ICON.user, update: ICON.note, overdue: ICON.clock, completed: ICON.done, added: ICON.people, due_soon: ICON.clock, follow_up: ICON.phone, escalation: ICON.alert, blocked: ICON.alert };
const DELIVERY_LABEL = { sent: ["📱 Sent to phone", "ok-text"], pending: ["📱 Sending…", ""], failed: ["📱 Phone push failed — retrying", "warn-text"], no_device: ["No phone set up", "hint"], gave_up: ["📱 Couldn't reach your phone", "bad-text"] };
let deliveries = null, deliveriesFor = "";
function loadDeliveries(ids) {
  const key = ids.join(","); if (key === deliveriesFor) return; deliveriesFor = key;
  if (!ids.length) { deliveries = new Map(); return; }
  sb.from("notification_deliveries").select("notification_id, status, attempts, sent_at, created_at").in("notification_id", ids).order("created_at").then(({ data }) => {
    deliveries = new Map((data || []).map(d => [d.notification_id, d])); const v = document.querySelector(".alist"); if (v) renderAlerts(document.getElementById("view"));
  });
}
export function renderAlerts(view) {
  const now = new Date().toISOString();
  const snoozed = state.notifications.filter(n => n.snoozed_until && n.snoozed_until > now), list = state.notifications.filter(n => !(n.snoozed_until && n.snoozed_until > now));
  loadDeliveries(list.slice(0, 40).map(n => n.id));
  const del = n => { const d = deliveries && deliveries.get(n.id); if (!d) return ""; const [l, c] = DELIVERY_LABEL[d.status] || ["", ""]; return `<small class="${c}">${l}${d.attempts > 1 ? ` · ${d.attempts} tries` : ""}</small>`; };
  view.innerHTML = `<div class="page-head"><div><h1>Alerts</h1><p class="sub">Reminders and changes from your workspaces.</p></div>
    <div class="filters">${list.some(n => !n.read_at) ? `<button class="btn sm" data-act="read-all">Mark all read</button>` : ""}</div></div>
    ${pushCard()}
    ${list.length ? `<div class="alist">${list.map(n => `<div class="alert k-${esc(n.kind)} ${n.read_at ? "" : "unread"}" data-act="open-alert" data-id="${n.id}" role="button" tabindex="0">
      <span class="ico">${ALERT_ICON[n.kind] || ICON.bell}</span><div class="tmain"><div class="ttitle">${esc(n.title)}</div><div class="tmeta">${esc(n.body)}</div>
      <div class="snz"><span class="hint">Snooze:</span><button class="chip" data-act="alert-snooze" data-id="${n.id}" data-when="1h">1 hour</button><button class="chip" data-act="alert-snooze" data-id="${n.id}" data-when="tomorrow">Tomorrow 9:00</button><button class="chip" data-act="alert-snooze" data-id="${n.id}" data-when="monday">Monday 9:00</button> ${del(n)}</div></div><time>${ago(n.created_at)}</time></div>`).join("")}</div>`
      : emptyState("No alerts yet", "You'll be alerted about overdue and due-soon tasks, follow-ups, escalations, assignments and updates.")}
    ${snoozed.length ? section("Snoozed", `<div class="list compact">${snoozed.map(n => `<div class="trow"><div class="tmain"><div class="ttitle">${esc(n.title)}</div><div class="tmeta">back ${fmtDateTime(n.snoozed_until, state.tz)}</div></div></div>`).join("")}</div>`, { count: snoozed.length }) : ""}`;
}
export async function snoozeAlert(id, when) {
  const until = snoozeUntil(when, state.tz);
  const r = await run(sb.rpc("snooze_notification", { p_notification: id, p_until: until }));
  if (r.error) return toastError(r.error);
  const n = state.notifications.find(x => x.id === id); if (n) { n.snoozed_until = until; n.read_at = n.read_at || new Date().toISOString(); }
  toast(`Snoozed until ${fmtDateTime(until, state.tz)}`); renderAlerts(document.getElementById("view"));
}
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
export const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
export function pushCard() {
  if (pushSupported() && Notification.permission === "granted") return "";
  if (isIOS && !isStandalone()) return `<div class="banner info"><b>Phone alerts on iPhone:</b> add Jezz HQ to your Home Screen (Share → Add to Home Screen), open it from there, then turn on notifications.</div>`;
  if (!pushSupported()) return `<div class="banner muted">This browser can't show phone notifications. In-app alerts still work.</div>`;
  if (Notification.permission === "denied") return `<div class="banner warn">Notifications are blocked for Jezz HQ. Allow them in your browser or phone settings.</div>`;
  return `<div class="banner info"><span>Get reminders on this device even when Jezz HQ is closed.</span> <button class="btn sm primary" data-act="enable-push">Turn on notifications</button></div>`;
}

/* ======================= Settings ======================= */
const TZS = ["Asia/Qatar", "Asia/Riyadh", "Asia/Dubai", "Asia/Kuwait", "Asia/Bahrain", "Asia/Kolkata", "Europe/London", "UTC"];
export function renderSettings(view) {
  const hidden = new Set(state.prefs.dashboard_hidden || []);
  view.innerHTML = `<div class="page-head"><div><h1>Settings</h1></div></div>
  <div class="settings">
  ${section("Profile", `<div class="grid2">
    <label class="field"><span>Your name (shown to people you work with)</span><input class="input" id="set-name" value="${esc(state.me.display_name || "")}" maxlength="60"></label>
    <label class="field"><span>Time zone</span><select class="input" id="set-tz">${[...new Set([state.tz, ...TZS])].map(z => `<option ${z === state.tz ? "selected" : ""}>${esc(z)}</option>`).join("")}</select></label>
    <label class="field"><span>Email</span><input class="input" value="${esc(state.user.email)}" disabled></label>
    <label class="field"><span>Default workspace for Quick Capture</span><select class="input" id="set-defws"><option value="">Last used</option>${activeWorkspaces().filter(w => canWrite(w.id)).map(w => `<option value="${w.id}" ${state.prefs.default_ws === w.id ? "selected" : ""}>${esc(w.name)}</option>`).join("")}</select></label>
  </div>`)}
  ${section("Command Centre sections", `<div class="checks">${Object.entries(HOME_SECTIONS).map(([k, v]) => `<label class="chk"><input type="checkbox" data-act="toggle-section" data-k="${k}" ${hidden.has(k) ? "" : "checked"}> ${esc(v)}</label>`).join("")}</div>`)}
  ${section("Saved task views", (state.prefs.saved_views || []).length ? `<ul class="plain">${state.prefs.saved_views.map((s, i) => `<li>★ ${esc(s.name)} <button class="linkbtn" data-act="delete-view" data-i="${i}">Remove</button></li>`).join("")}</ul>` : `<p class="calm">Save filter combinations from My Tasks with “Save view”.</p>`)}
  ${section("Notifications", pushCard() || `<p class="calm">${ICON.done} Phone notifications are on for this device. Reminders run on the server every 5 minutes: overdue (then daily), due within 24h, follow-up dates and escalations.</p>`)}
  ${section("Invite people", `<p class="calm">Anyone with this link can create their own free account. To work together, add them to a workspace by email from that workspace's People button.</p>
    <div class="btnrow"><button class="btn primary" data-act="invite">Share invite link</button><button class="btn" data-act="copy-link">Copy link</button></div><p class="num small">${esc(location.origin)}</p>`)}
  ${section("Install on your phone", isStandalone() ? `<p class="calm">${ICON.done} Installed.</p>` : isIOS ? `<ol class="steps"><li>Open this page in Safari.</li><li>Tap Share.</li><li>Choose <b>Add to Home Screen</b>.</li></ol>` : `<ol class="steps"><li>Open in Chrome.</li><li>Tap ⋮.</li><li>Choose <b>Install app</b>.</li></ol>`)}
  ${integrationsHtml()}
  ${section("Export & backup", `<p class="calm">Download everything you can access. Exports are generated from live data.</p>
    <div class="btnrow"><button class="btn" data-act="export-csv">${ICON.download}Tasks (CSV)</button><button class="btn" data-act="export-json">${ICON.download}Full backup (JSON)</button></div>
    <p class="hint">The database is also backed up daily by Supabase.</p>`)}
  ${section("Account", `<button class="btn" data-act="sign-out">Sign out</button>`)}
  <p class="hint center">Jezz HQ · <a href="https://github.com/Jezil1555/job-desk" target="_blank" rel="noopener">source</a></p>
  </div>`;
}
export async function handleSettingsChange(e) {
  const id = e.target.id;
  if (id === "set-name") { const v = e.target.value.trim(); const r = await run(sb.from("profiles").update({ display_name: v }).eq("id", state.user.id)); if (r.error) return toastError(r.error), true; state.me.display_name = v; state.profiles[state.user.id].display_name = v; toast("Name saved"); return true; }
  if (id === "set-tz") { const v = e.target.value; const r = await run(sb.from("profiles").update({ timezone: v }).eq("id", state.user.id)); if (r.error) return toastError(r.error), true; state.tz = v; state.me.timezone = v; toast("Time zone saved"); return true; }
  if (id === "set-defws") { const r = await savePrefs({ default_ws: e.target.value || null }); r.error ? toastError(r.error) : toast("Saved"); return true; }
  return false;
}
export async function handleSettingsClick(act, el, rerender) {
  if (act === "toggle-section") { const k = el.dataset.k, h = new Set(state.prefs.dashboard_hidden || []); el.checked ? h.delete(k) : h.add(k); const r = await savePrefs({ dashboard_hidden: [...h] }); r.error ? toastError(r.error) : toast("Dashboard updated"); return true; }
  if (act === "delete-view") { const v = [...(state.prefs.saved_views || [])]; v.splice(+el.dataset.i, 1); const r = await savePrefs({ saved_views: v }); r.error ? toastError(r.error) : toast("View removed"); rerender(); return true; }
  if (act === "export-csv") { exportCsv(); return true; }
  if (act === "export-json") { exportJson(); return true; }
  return false;
}
function download(name, text, type) {
  const blob = new Blob([text], { type }); const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function exportCsv() {
  const cols = ["id", "title", "workspace", "project", "status", "priority", "owner", "category", "start_date", "due_at", "follow_up_at", "progress", "next_action", "waiting_on", "blocker", "reference", "client_name", "created_at", "completed_at"];
  const q = v => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = state.tasks.filter(t => !t.deleted_at).map(t => cols.map(c => q(c === "workspace" ? (wsById(t.workspace_id) || {}).name : c === "project" ? (projectById(t.project_id) || {}).name : c === "owner" ? nameOf(t.owner_id) : t[c])).join(","));
  download(`job-desk-tasks-${todayISO(state.tz)}.csv`, [cols.join(","), ...rows].join("\n"), "text/csv");
  toast(`Exported ${rows.length} tasks`);
}
function exportJson() {
  const data = { exported_at: new Date().toISOString(), timezone: state.tz, workspaces: state.workspaces, projects: state.projects, milestones: state.milestones, tasks: state.tasks, task_dependencies: state.deps, follow_ups: state.followUps, contacts: state.contacts };
  download(`job-desk-backup-${todayISO(state.tz)}.json`, JSON.stringify(data, null, 2), "application/json");
  toast("Backup downloaded");
}

/* ======================= Planned modules ======================= */
const PLANNED = {
  finance: { title: "Finance & CFO", phase: "Phase 3", icon: ICON.finance, points: ["Separate books per entity: Personal, Dlusso Bespoke, Fitness Hub, The Burgery", "Double-entry journals that must balance, with reversals instead of deletions", "Receivables, payables, partner accounts, inventory & COGS", "Bank reconciliation, P&L, balance sheet, cash flow", "Tasks link to bills and invoices; completing a task never marks a bill paid"], note: "Needs your confirmation of each entity's base currency before it's built." },
  goals: { title: "Goals & Habits", phase: "Phase 2", icon: ICON.goals, points: ["Long-term goals with monthly and weekly objectives", "Daily habits with schedules, streaks and progress charts", "Workout, walking and weight logs (private and optional)", "Learning, reading and family commitments"] },
  notes: { title: "Notes & Documents", phase: "Phase 2", icon: ICON.notes, points: ["Notes, meeting notes and decision records", "Private file storage with expiring links (invoices, CoCs, delivery docs)", "Link any note or document to tasks, projects, contacts or financial records", "Tags and full-text search"] },
  reports: { title: "Reports & Insights", phase: "Phase 2", icon: ICON.reports, points: ["Daily overview and weekly executive review", "Project reports: planned vs actual, delays, owner workload", "CSV / spreadsheet exports (PDF for financial reports in Phase 3)"], note: "Today's numbers already live on the Command Centre." }
};
export function renderPlanned(view, key) {
  const p = PLANNED[key];
  view.innerHTML = `<div class="page-head"><div><h1>${esc(p.title)}</h1><p class="sub">Planned for ${p.phase}. Not built yet, so nothing here is real data.</p></div></div>
  <section class="planned"><span class="pl-ico">${p.icon}</span><div><h2>What's coming</h2><ul>${p.points.map(x => `<li>${esc(x)}</li>`).join("")}</ul>${p.note ? `<p class="hint">${esc(p.note)}</p>` : ""}</div></section>`;
}
