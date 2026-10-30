// Boot, auth, routing, navigation and event wiring.
import { esc, debounce, friendlyError } from "./util.js";
import { VIEWS, viewFilter } from "./logic.js";
import { state, on, emit, activeWorkspaces } from "./store.js";
import { sb, loadAll, subscribe, unsubscribe, run } from "./api.js";
import { ICON, $, toast, toastError, closeSheet, closeAllSheets, sheetOpen, dialog } from "./ui.js";
import { openTask, handleTaskChange, handleTaskInput, handleTaskClick, handleTaskSubmit, handleContactSelect, clearTaskSheet } from "./sheets/task.js";
import { openCapture, handleCaptureChange, handleCaptureClick, handleCaptureSubmit, handleCaptureInput } from "./sheets/capture.js";
import { openProjectForm, openMilestoneForm, openFollowUp, openWorkspaceForm, openContactForm, handleFormSubmit, handleFormClick, handleFormChange } from "./sheets/forms.js";
import { renderHome } from "./views/home.js";
import { renderNotes, handleNotesChange, handleNotesInput, NOTE_TABS } from "./views/notes.js";
import { renderGoals, handleGoalsClick, handleGoalsChange, handleGoalsSubmit } from "./views/goals.js";
import { renderReports, handleReportsClick, handleReportsChange, handleReportsSubmit, REPORT_TABS } from "./views/reports.js";
import { renderFinanceHome, renderFinance, FIN_TABS } from "./views/finance.js";
import { handleFinClick, handleFinChange, handleFinInput, handleFinSubmit, finSheetReset } from "./sheets/finforms.js";
import { loadFin, fin } from "./finapi.js";
import { handleIcClick, handleIcChange, handleIcSubmit } from "./views/intercompany.js";
import { handleProdClick, handleProdSubmit } from "./views/production.js";
import { handleFxClick, handleFxChange, handleFxSubmit } from "./views/fx.js";
import { handleSetupClick, handleSetupChange, handleSetupSubmit } from "./views/setup.js";
import { handlePartnerClick, handlePartnerChange, handlePartnerInput, handlePartnerSubmit } from "./sheets/partnerforms.js";
import { openDraft, handleAssistClick, handleAssistChange } from "./sheets/assist.js";
import { handleIntegrationsClick, handleIntegrationsChange } from "./views/integrations.js";
import { openNote, openDocument, handleKnowledgeClick, handleKnowledgeSubmit, handleKnowledgeChange, handleKnowledgeInput } from "./sheets/knowledge.js";
import { renderTasks, handleTasksChange, handleTasksClick, bindBoard } from "./views/tasks.js";
import { renderWorkspaces, renderWorkspace, renderProject } from "./views/workspaces.js";
import { renderCalendar, handleCalendarClick, renderFollowUps, renderSearch, runSearch, renderAlerts, renderSettings, handleSettingsChange, handleSettingsClick, renderPlanned, pushSupported, snoozeAlert } from "./views/other.js";

const cfg = window.JOBDESK_CONFIG;
const NAV = [
  { key: "home", label: "Command Centre", icon: "home", href: "#/home" },
  { key: "tasks", label: "My Tasks", icon: "tasks", href: "#/tasks/today" },
  { key: "workspaces", label: "Projects & Workspaces", icon: "folder", href: "#/workspaces" },
  { key: "calendar", label: "Calendar & Follow-ups", icon: "calendar", href: "#/calendar" },
  { key: "finance", label: "Finance & CFO", icon: "finance", href: "#/finance" },
  { key: "goals", label: "Goals & Habits", icon: "goals", href: "#/goals" },
  { key: "notes", label: "Notes & Documents", icon: "notes", href: "#/notes" },
  { key: "reports", label: "Reports & Insights", icon: "reports", href: "#/reports" },
  { key: "settings", label: "Settings", icon: "settings", href: "#/settings" }
];

/* ---------- routing ---------- */
function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, query] = raw.split("?");
  const seg = path.split("/").filter(Boolean);
  const params = new URLSearchParams(query || "");
  const r = { name: seg[0] || "home", a: seg[1], b: seg[2], c: seg[3], params };
  return r;
}
const navKey = r => ({ home: "home", tasks: "tasks", workspaces: "workspaces", w: "workspaces", p: "workspaces", calendar: "calendar", followups: "calendar", finance: "finance", goals: "goals", notes: "notes", reports: "reports", settings: "settings", search: "search", alerts: "alerts" }[r.name] || "home");

function render() {
  if (!state.user) return;
  const r = state.route = parseRoute();
  // deep links that open a panel over the Command Centre
  if (["t", "f", "n", "d"].includes(r.name)) {
    const id = r.a; history.replaceState(null, "", r.name === "n" || r.name === "d" ? "#/notes" + (r.name === "d" ? "/documents" : "") : "#/home");
    state.route = parseRoute(); render();
    if (state.loaded) openDeep(r.name, id); else pendingOpen = r;
    return;
  }
  renderNav();
  const view = $("view");
  if (!state.loaded) { view.innerHTML = `<div class="loading"><div class="spinner"></div>Loading your command centre…</div>`; return; }
  const k = navKey(r);
  let title = (NAV.find(n => n.key === k) || {}).label || "";
  try {
    switch (r.name) {
      case "tasks": renderTasks(view, r.a || "today"); title = (VIEWS[r.a] || VIEWS.today).label; bindBoard(view); break;
      case "workspaces": renderWorkspaces(view); break;
      case "w": renderWorkspace(view, r.a, r.b || "projects"); break;
      case "p": renderProject(view, r.a); break;
      case "calendar": renderCalendar(view); break;
      case "followups": renderFollowUps(view); title = "Follow-ups"; break;
      case "search": renderSearch(view); title = "Search"; break;
      case "alerts": renderAlerts(view); title = "Alerts"; break;
      case "settings": renderSettings(view); break;
      case "notes": renderNotes(view, r.a || "notes"); break;
      case "goals": renderGoals(view, r.a || "habits"); break;
      case "reports": renderReports(view, r.a || "daily"); break;
      case "finance": r.a ? renderFinance(view, r.a, r.b || "overview", r.c) : renderFinanceHome(view); if (r.a && fin.loaded) { const fe = fin.entities.find(x => x.id === r.a); if (fe) title = fe.name + " · " + ((FIN_TABS[r.b] || "Overview")); } break;
      default: renderHome(view); title = "Command Centre";
    }
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="banner bad">This screen hit an error and couldn't be shown. Your data is safe. <button class="linkbtn" data-act="reload">Reload</button></div>`;
  }
  $("pageTitle").textContent = title;
  document.title = `${title} · Job Desk`;
}
let pendingOpen = null;
const openDeep = (k, id) => ({ t: openTask, f: openFollowUp, n: openNote, d: openDocument })[k](id);

function renderNav() {
  const k = navKey(state.route);
  const unread = state.notifications.filter(n => !n.read_at).length;
  const counts = state.loaded ? {
    tasks: state.tasks.filter(viewFilter("today", state.user.id, state.tz)).filter(t => activeWorkspaces().some(w => w.id === t.workspace_id)).length,
    inbox: state.tasks.filter(t => t.status === "inbox" && !t.deleted_at).length,
    calendar: state.followUps.filter(f => f.status === "escalated" || (f.status === "open" && f.next_follow_up_at && new Date(f.next_follow_up_at) <= new Date())).length
  } : {};
  const saved = state.prefs.saved_views || [];
  $("sidenav").innerHTML = `
    <div class="brand"><img src="/icons/icon-192.png" alt="" width="28" height="28"><span>Job Desk</span></div>
    <button class="capture-btn" data-act="capture">${ICON.plus}<span>Quick capture</span><kbd>N</kbd></button>
    <nav aria-label="Main">${NAV.map(n => `<a href="${n.href}" class="${k === n.key ? "on" : ""} ${n.soon ? "soon" : ""}">${ICON[n.icon]}<span>${n.label}</span>${n.soon ? `<small>${n.soon}</small>` : counts[n.key] ? `<b class="cnt">${counts[n.key]}</b>` : ""}</a>`).join("")}</nav>
    ${k === "tasks" || saved.length ? `<div class="subnav"><p>Task views</p>
      <a href="#/tasks/inbox">Inbox${counts.inbox ? `<b class="cnt">${counts.inbox}</b>` : ""}</a><a href="#/tasks/overdue">Overdue</a><a href="#/tasks/waiting">Waiting</a><a href="#/tasks/blocked">Blocked</a><a href="#/tasks/delegated">Delegated</a>
      ${saved.map((s, i) => `<a href="#/tasks/${s.view}" data-act="apply-view" data-i="${i}">★ ${esc(s.name)}</a>`).join("")}</div>` : ""}
    <div class="subnav ws"><p>Workspaces</p>${activeWorkspaces().map(w => `<a href="#/w/${w.id}" class="${state.route.a === w.id ? "on" : ""}"><i class="dot" style="background:${esc(w.color)}"></i>${esc(w.name)}</a>`).join("")}</div>`;
  $("bottomnav").innerHTML = [
    ["home", "#/home", "home", "Home"], ["tasks", "#/tasks/today", "tasks", "Tasks"], ["capture", null, "plus", "Capture"], ["calendar", "#/followups", "calendar", "Follow-ups"], ["more", null, "more", "More"]
  ].map(([key, href, ic, label]) => key === "capture" ? `<button class="bn-capture" data-act="capture" aria-label="Quick capture">${ICON.plus}</button>` :
    href ? `<a href="${href}" class="${k === key ? "on" : ""}">${ICON[ic]}<span>${label}</span>${counts[key] ? `<b class="cnt">${counts[key]}</b>` : ""}</a>` : `<button data-act="more-menu" class="${["workspaces", "finance", "goals", "notes", "reports", "settings"].includes(k) ? "on" : ""}">${ICON[ic]}<span>${label}</span></button>`).join("");
  const b = $("bellCount"); b.hidden = !unread; b.textContent = unread > 99 ? "99+" : unread;
  if ("setAppBadge" in navigator) { try { unread ? navigator.setAppBadge(unread) : navigator.clearAppBadge(); } catch (e) {} }
}

function moreMenu() {
  import("./ui.js").then(({ openSheet, sheetHead }) => openSheet(sh => {
    sh.innerHTML = sheetHead("More") + `<div class="sh-body"><nav class="morenav">${NAV.filter(n => !["home", "tasks"].includes(n.key)).map(n => `<a href="${n.href}" data-act="close-sheet">${ICON[n.icon]}<span>${n.label}</span>${n.soon ? `<small>${n.soon}</small>` : ""}</a>`).join("")}
      <a href="#/calendar" data-act="close-sheet">${ICON.calendar}<span>Calendar</span></a><a href="#/search" data-act="close-sheet">${ICON.search}<span>Search</span></a><a href="#/alerts" data-act="close-sheet">${ICON.bell}<span>Alerts</span></a></nav></div>`;
  }));
}

/* ---------- events ---------- */
const rerender = () => render();
document.addEventListener("click", async e => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  if (el.tagName === "A" && !["apply-view", "close-sheet", "filter-ws"].includes(act)) e.preventDefault();
  if (act === "open-task" && e.target.closest("[data-act]") !== el) return;
  if (await handleCaptureClick(act, el)) return;
  if (await handleTaskClick(act, el)) return;
  if (await handleFormClick(act, el)) return;
  if (await handleTasksClick(act, el, rerender)) return;
  if (handleCalendarClick(act, el, rerender)) return;
  if (await handleSettingsClick(act, el, rerender)) return;
  if (await handleKnowledgeClick(act, el)) return;
  if (await handleGoalsClick(act, el, rerender)) return;
  if (await handleReportsClick(act, el, rerender)) return;
  if (await handleIcClick(act, el)) return;
  if (await handleProdClick(act, el)) return;
  if (await handleFxClick(act, el)) return;
  if (await handleSetupClick(act, el)) return;
  if (await handlePartnerClick(act, el, rerender)) return;
  if (await handleFinClick(act, el, rerender)) return;
  if (await handleAssistClick(act, el)) return;
  if (await handleIntegrationsClick(act, el)) return;
  if (act === "draft-msg") { openDraft(el.dataset.kind, el.dataset.id); return; }
  const id = el.dataset.id;
  switch (act) {
    case "close-sheet": closeSheet(); if (!sheetOpen()) clearTaskSheet(); break;
    case "capture": openCapture({ workspace_id: el.dataset.ws || undefined, project_id: el.dataset.project || null, status: el.dataset.project ? "not_started" : undefined }); break;
    case "open-task": e.preventDefault(); openTask(id); break;
    case "open-followup": openFollowUp(id); break;
    case "open-project": location.hash = "#/p/" + id; closeAllSheets(); break;
    case "open-contact": openContactForm(id); break;
    case "new-workspace": openWorkspaceForm(null); break;
    case "edit-workspace": openWorkspaceForm(id); break;
    case "new-project": openProjectForm(null, { workspace_id: el.dataset.ws }); break;
    case "edit-project": openProjectForm(id); break;
    case "new-milestone": openMilestoneForm(null, el.dataset.project); break;
    case "edit-milestone": openMilestoneForm(id, null); break;
    case "new-followup": openFollowUp(null, { workspace_id: el.dataset.ws || state.ui.fuWs || undefined, project_id: el.dataset.project || null }); break;
    case "new-contact": openContactForm(null, { workspace_id: el.dataset.ws }); break;
    case "filter-ws": state.ui.filters = { ws: el.dataset.ws }; break;
    case "more-menu": moreMenu(); break;
    case "reload": location.reload(); break;
    case "sign-out": await sb.auth.signOut(); break;
    case "enable-push": enablePush(); break;
    case "invite": shareInvite(); break;
    case "copy-link": copyLink(); break;
    case "read-all": markRead(state.notifications.filter(n => !n.read_at).map(n => n.id)); break;
    case "alert-snooze": snoozeAlert(id, el.dataset.when); break;
    case "open-alert": { const n = state.notifications.find(x => x.id === id); if (!n) break; markRead([n.id]); if (n.task_id) openTask(n.task_id); else if (n.follow_up_id) openFollowUp(n.follow_up_id); else if (n.url) location.hash = n.url.replace(/^\/?#?/, "#"); break; }
  }
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && sheetOpen() && $("dialog").hidden) { closeSheet(); if (!sheetOpen()) clearTaskSheet(); return; }
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName) || document.activeElement.isContentEditable;
  if (typing || e.metaKey || e.ctrlKey || e.altKey || !state.loaded) return;
  if ((e.key === "n" || e.key === "c") && !sheetOpen()) { e.preventDefault(); openCapture(); }
  if (e.key === "/" && !sheetOpen()) { e.preventDefault(); location.hash = "#/search"; }
  if ((e.key === "Enter" || e.key === " ") && document.activeElement.dataset && document.activeElement.dataset.act && document.activeElement.getAttribute("role") === "button") { e.preventDefault(); document.activeElement.click(); }
});
document.addEventListener("change", async e => {
  if (handleCaptureChange(e)) return;
  if (handleTaskChange(e)) return;
  if (await handleContactSelect(e)) return;
  if (await handleFormChange(e)) return;
  if (handleTasksChange(e, rerender)) return;
  if (await handleSettingsChange(e)) return;
  if (await handleKnowledgeChange(e)) return;
  if (handleNotesChange(e, rerender)) return;
  if (handleGoalsChange(e, rerender)) return;
  if (handleReportsChange(e, rerender)) return;
  if (handleIcChange(e)) return;
  if (handleFxChange(e)) return;
  if (handleSetupChange(e)) return;
  if (await handlePartnerChange(e, rerender)) return;
  if (await handleFinChange(e, rerender)) return;
  if (handleAssistChange(e)) return;
  if (await handleIntegrationsChange(e)) return;
  const id = e.target.id;
  if (id === "home-ws") { state.ui.homeWs = e.target.value; render(); }
  if (id === "home-owner") { state.ui.homeOwner = e.target.value; render(); }
  if (id === "cal-ws") { state.ui.calWs = e.target.value; render(); }
  if (id === "fu-filter-ws") { state.ui.fuWs = e.target.value; render(); }
});
const keepFocus = debounce(id => { const i0 = $(id), pos = i0 && i0.selectionStart; render(); const i = $(id); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch (err) {} } }, 200);
const searchDebounced = debounce(q => runSearch(q), 250);
const listDebounced = debounce(() => { const pos = $("tl-search") && $("tl-search").selectionStart; render(); const i = $("tl-search"); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch (err) {} } }, 200);
document.addEventListener("input", e => {
  handleTaskInput(e);
  if (handleCaptureInput(e)) return;
  if (handleKnowledgeInput(e)) return;
  if (handleNotesInput(e, keepFocus)) return;
  if (handlePartnerInput(e, keepFocus)) return;
  if (handleFinInput(e, keepFocus)) return;
  if (e.target.id === "global-q") { state.ui.globalQ = e.target.value; searchDebounced(e.target.value); }
  if (e.target.id === "tl-search") { state.ui.search = e.target.value; listDebounced(); }
  if (e.target.id === "topsearch") { state.ui.globalQ = e.target.value; }
});
document.addEventListener("submit", async e => {
  e.preventDefault();
  const form = e.target;
  if (form.id === "authForm") return submitAuth();
  if (form.id === "topSearchForm") { location.hash = "#/search"; return; }
  if (await handleCaptureSubmit(form)) return;
  if (await handleTaskSubmit(form)) return;
  if (await handleFormSubmit(form)) return;
  if (await handleKnowledgeSubmit(form)) return;
  if (await handleGoalsSubmit(form, rerender)) return;
  if (await handleReportsSubmit(form, rerender)) return;
  if (await handleIcSubmit(form)) return;
  if (await handleProdSubmit(form)) return;
  if (await handleFxSubmit(form)) return;
  if (await handleSetupSubmit(form)) return;
  if (await handlePartnerSubmit(form)) return;
  if (await handleFinSubmit(form, rerender, e.submitter)) return;
});
$("sheetWrap").addEventListener("click", e => { if (e.target.id === "sheetBackdrop") { closeSheet(); if (!sheetOpen()) clearTaskSheet(); } });
window.addEventListener("hashchange", () => { closeAllSheets(); clearTaskSheet(); finSheetReset(); state.ui.selecting = false; state.ui.selected.clear(); render(); window.scrollTo(0, 0); });
window.addEventListener("online", () => { $("offline").hidden = true; if (state.user) loadAll().catch(() => {}); });
window.addEventListener("offline", () => { $("offline").hidden = false; });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.user && state.loaded && Date.now() - (state.loadedAt || 0) > 30000) { loadAll().catch(() => {}); loadFin(true); } });
on("data", () => { if (state.user) { if (!sheetOpen() || !document.activeElement || !document.activeElement.closest("#view")) render(); else renderNav(); } });
on("notifications", () => renderNav());
on("fin", () => { if (!state.user) return; if (state.route.name === "finance" || (state.route.name === "home" && !sheetOpen())) render(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", e => { if (e.data && e.data.type === "open" && e.data.url) location.hash = e.data.url.replace(/^\/?#?/, "#"); });
setInterval(() => { if (state.loaded && !sheetOpen() && ["home", "tasks"].includes(state.route.name)) render(); }, 60000);

/* ---------- notifications ---------- */
async function markRead(ids) {
  if (!ids.length) return;
  const now = new Date().toISOString();
  state.notifications.forEach(n => { if (ids.includes(n.id) && !n.read_at) n.read_at = now; });
  renderNav(); if (state.route.name === "alerts") render();
  await sb.from("notifications").update({ read_at: now }).in("id", ids).is("read_at", null);
}
function b64ToBytes(b64) { const p = "=".repeat((4 - b64.length % 4) % 4); const raw = atob((b64 + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from([...raw].map(c => c.charCodeAt(0))); }
async function saveSub(sub) {
  const j = sub.toJSON();
  const r = await run(sb.from("push_subscriptions").upsert({ user_id: state.user.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 200) }, { onConflict: "endpoint" }));
  if (r.error) console.error(r.error);
  return r;
}
async function enablePush() {
  if (!pushSupported()) return toastError("This browser can't show notifications.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { render(); return toastError("Notifications weren't allowed."); }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.vapidPublicKey) });
    const r = await saveSub(sub);
    if (r.error) toastError("Couldn't register this device: " + r.error); else toast("Notifications are on for this device");
  } catch (e) { toastError("Couldn't turn on notifications. Try again."); }
  render();
}
async function ensurePush() {
  if (!pushSupported() || Notification.permission !== "granted") return;
  try { const reg = await navigator.serviceWorker.ready; const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.vapidPublicKey) }); await saveSub(sub); } catch (e) {}
}
async function shareInvite() {
  const data = { title: "Job Desk", text: "I use Job Desk to run my tasks, projects and follow-ups. Create your free account:", url: location.origin };
  if (navigator.share) { try { await navigator.share(data); return; } catch (e) { if (e.name === "AbortError") return; } }
  copyLink();
}
async function copyLink() { try { await navigator.clipboard.writeText(location.origin); toast("Link copied"); } catch (e) { toast("Copy this link: " + location.origin); } }

/* ---------- auth ---------- */
let authMode = "signin", recovery = false;
function renderAuth(msg, email = "") {
  const titles = { signin: "Sign in", signup: "Create your account", reset: "Reset your password", newpass: "Choose a new password" };
  const btn = { signin: "Sign in", signup: "Create account", reset: "Send reset link", newpass: "Save password" };
  $("auth").innerHTML = `<form class="auth-card" id="authForm" novalidate>
    <div class="brand"><img src="/icons/icon-192.png" width="44" height="44" alt=""><div><h1>Job Desk</h1><p>${titles[authMode]}</p></div></div>
    ${msg ? `<div class="formmsg ${msg.type}" role="alert">${esc(msg.text)}</div>` : ""}
    ${authMode === "signup" ? `<label class="field"><span>Your name</span><input class="input" id="af-name" autocomplete="name" maxlength="60"></label>` : ""}
    ${authMode !== "newpass" ? `<label class="field"><span>Email</span><input class="input" id="af-email" type="email" autocomplete="email" inputmode="email" value="${esc(email)}"></label>` : ""}
    ${authMode !== "reset" ? `<label class="field"><span>${authMode === "newpass" ? "New password" : "Password"}</span><input class="input" id="af-pass" type="password" autocomplete="${authMode === "signin" ? "current-password" : "new-password"}" minlength="8"></label>` : ""}
    <button class="btn primary block" type="submit" id="af-btn">${btn[authMode]}</button>
    <div class="auth-switch">${authMode === "signin" ? `<button type="button" class="linkbtn" data-auth="signup">Create account</button><button type="button" class="linkbtn" data-auth="reset">Forgot password?</button>` : authMode !== "newpass" ? `<button type="button" class="linkbtn" data-auth="signin">Back to sign in</button>` : ""}</div>
  </form>`;
  $("auth").querySelectorAll("[data-auth]").forEach(b => b.onclick = () => { authMode = b.dataset.auth; renderAuth(null, $("af-email") ? $("af-email").value : ""); });
}
async function submitAuth() {
  const email = $("af-email") ? $("af-email").value.trim() : "", pass = $("af-pass") ? $("af-pass").value : "", name = $("af-name") ? $("af-name").value.trim() : "";
  if (authMode === "signup" && !name) return renderAuth({ type: "err", text: "Enter your name so people know who you are." }, email);
  if (authMode !== "newpass" && !/^\S+@\S+\.\S+$/.test(email)) return renderAuth({ type: "err", text: "Enter a valid email address." }, email);
  if (authMode !== "reset" && pass.length < 8) return renderAuth({ type: "err", text: "Password needs at least 8 characters." }, email);
  const b = $("af-btn"); if (b.disabled) return; b.disabled = true; b.textContent = "Please wait…";
  let res;
  if (authMode === "signin") res = await sb.auth.signInWithPassword({ email, password: pass });
  else if (authMode === "signup") res = await sb.auth.signUp({ email, password: pass, options: { emailRedirectTo: location.origin, data: { display_name: name } } });
  else if (authMode === "reset") res = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
  else res = await sb.auth.updateUser({ password: pass });
  if (res.error) {
    const m = res.error.message || "";
    return renderAuth({ type: "err", text: /invalid login/i.test(m) ? "Email or password is wrong." : /not confirmed/i.test(m) ? "Confirm your email first using the link we sent." : friendlyError(res.error) }, email);
  }
  if (authMode === "signup" && !res.data.session) { authMode = "signin"; return renderAuth({ type: "ok", text: "Account created. Tap the confirmation link in your email, then sign in here." }, email); }
  if (authMode === "reset") { authMode = "signin"; return renderAuth({ type: "ok", text: "Reset link sent. Open it on this device." }, email); }
  if (authMode === "newpass") { recovery = false; authMode = "signin"; toast("Password updated"); showApp(); }
}

function showAuth() { $("boot").hidden = true; $("app").hidden = true; $("auth").hidden = false; closeAllSheets(); renderAuth(); }
async function showApp() {
  $("boot").hidden = true; $("auth").hidden = true; $("app").hidden = false;
  $("offline").hidden = navigator.onLine;
  render();
  try { await loadAll(); }
  catch (e) { $("view").innerHTML = `<div class="empty"><strong>Couldn't load your data</strong><span>${esc(friendlyError(e))}</span><button class="btn primary" data-act="reload">Try again</button></div>`; return; }
  subscribe(n => { if (document.visibilityState === "visible") toast(n.title, { action: { label: "View", run: () => { markRead([n.id]); if (n.task_id) openTask(n.task_id); else if (n.follow_up_id) openFollowUp(n.follow_up_id); } } }); });
  render();
  if (pendingOpen) { const p = pendingOpen; pendingOpen = null; openDeep(p.name, p.a); }
  ensurePush();
  loadFin(); // finance loads in the background; screens show a spinner until it arrives
}
sb.auth.onAuthStateChange((event, session) => {
  if (event === "PASSWORD_RECOVERY") { recovery = true; state.user = session.user; authMode = "newpass"; showAuth(); return; }
  if (recovery) return;
  const prev = state.user && state.user.id;
  state.user = session ? session.user : null;
  if (!state.user) { state.loaded = false; unsubscribe(); showAuth(); }
  else if (prev !== state.user.id) setTimeout(showApp, 0);
});
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
