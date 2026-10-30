// Command Centre: a live summary across workspaces, built only from stored records.
import { esc, fmtDate, zonedDate, todayISO, addDays, daysFromToday, ago, fmtDateTime, relDay } from "../util.js";
import { isOpen, isOverdue, dueInDays, followUpDue, attentionItems, sortTasks, PROJECT_STATUS_LABEL, STATUS_LABEL, PRIORITY_LABEL } from "../logic.js";
import { state, wsById, projectById, contactById, nameOf, shortName, activeWorkspaces } from "../store.js";
import { habitChecklist, activeHabits, doneSet } from "./goals.js";
import { habitDueOn } from "../insights.js";
import { dailyBriefing } from "../smart.js";
import { fin } from "../finapi.js";
import { ICON, taskRow, section, emptyState, wsDot, projectPill, statusPill, prioChip, avatar } from "../ui.js";

export const HOME_SECTIONS = {
  attention: "What needs my attention",
  today: "Today",
  habits: "Habits today",
  tiles: "Summary",
  upcoming: "Next 7 days",
  waiting: "Waiting on others",
  projects: "Project health",
  activity: "Recent activity"
};

export function renderHome(view) {
  const tz = state.tz, uid = state.user.id, now = new Date(), today = todayISO(tz);
  const hidden = new Set(state.prefs.dashboard_hidden || []);
  const wsFilter = state.ui.homeWs, ownerFilter = state.ui.homeOwner || "me";
  const act = new Set(activeWorkspaces().map(w => w.id));
  const inScope = x => act.has(x.workspace_id) && (!wsFilter || x.workspace_id === wsFilter);
  const tasks = state.tasks.filter(t => inScope(t) && !t.deleted_at && (ownerFilter === "all" || t.owner_id === uid || t.assignee_id === uid || (t.reviewer_id === uid && t.review_status === "requested") || (ownerFilter === "me" && t.created_by === uid && !t.owner_id)));
  const open = tasks.filter(isOpen);
  const fus = state.followUps.filter(f => inScope(f) && ["open", "escalated"].includes(f.status) && (ownerFilter === "all" || f.owner_id === uid));
  const projects = state.projects.filter(p => inScope(p) && !p.archived);
  const health = state.health.filter(h => projects.some(p => p.id === h.project_id));
  const msOpen = state.milestones.filter(m => !m.actual_date && projects.some(p => p.id === m.project_id));

  const overdue = open.filter(t => isOverdue(t, now));
  const dueToday = open.filter(t => !isOverdue(t, now) && dueInDays(t, tz, now) === 0);
  const fuToday = open.filter(t => followUpDue(t, now));
  const fuItemsDue = fus.filter(f => f.next_follow_up_at && zonedDate(f.next_follow_up_at, tz) <= today);
  const next7 = open.filter(t => { const n = dueInDays(t, tz, now); return n !== null && n >= 1 && n <= 7; });
  const waiting = open.filter(t => t.status === "waiting");
  const blocked = open.filter(t => t.status === "blocked");
  const inbox = open.filter(t => t.status === "inbox");
  const weekAgo = Date.now() - 7 * 86400000;
  const doneWeek = tasks.filter(t => t.status === "completed" && t.completed_at && new Date(t.completed_at) > weekAgo).length;

  const hour = +new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(now);
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const first = (state.me.display_name || state.user.email.split("@")[0]).split(" ")[0];

  const parts = [];
  parts.push(`<div class="page-head"><div><h1 class="h-display">${greet}, ${esc(first)}</h1><p class="sub">${fmtDate(today, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</p>${briefingHtml(today, now)}</div>
    <div class="filters">
      <select class="input sm" id="home-ws" aria-label="Workspace"><option value="">All workspaces</option>${activeWorkspaces().map(w => `<option value="${w.id}" ${w.id === wsFilter ? "selected" : ""}>${esc(w.name)}</option>`).join("")}</select>
      <select class="input sm" id="home-owner" aria-label="Owner"><option value="me" ${ownerFilter === "me" ? "selected" : ""}>Mine</option><option value="all" ${ownerFilter === "all" ? "selected" : ""}>Everyone</option></select>
      <a class="iconbtn" href="#/settings" title="Choose dashboard sections" aria-label="Customise dashboard">${ICON.settings}</a>
    </div></div>`);

  if (!state.workspaces.length) {
    view.innerHTML = parts.join("") + emptyState("Create your first workspace", "Workspaces keep QCloud, Dlusso, Fitness Hub, The Burgery and personal life separate.", `<button class="btn primary" data-act="new-workspace">New workspace</button>`);
    return;
  }

  if (!hidden.has("tiles")) parts.push(`<div class="tiles">
    ${tile("Overdue", overdue.length, "#/tasks/overdue", overdue.length ? "bad" : "")}
    ${tile("Due today", dueToday.length, "#/tasks/today", dueToday.length ? "warn" : "")}
    ${tile("Next 7 days", next7.length, "#/tasks/upcoming")}
    ${tile("Waiting", waiting.length, "#/tasks/waiting")}
    ${tile("Blocked", blocked.length, "#/tasks/blocked", blocked.length ? "bad" : "")}
    ${tile("Follow-ups due", fuItemsDue.length + fuToday.length, "#/followups", fuItemsDue.length + fuToday.length ? "warn" : "")}
    ${tile("Inbox", inbox.length, "#/tasks/inbox")}
    ${tile("Done this week", doneWeek, "#/tasks/completed", "", true)}
  </div>`);

  if (!hidden.has("attention")) {
    const allItems = attentionItems({ tasks: open, followUps: fus, health, projects, milestones: msOpen, uid, mineOnly: ownerFilter !== "all", tz, now });
    const list = allItems.slice(0, 8);
    parts.push(section("What needs my attention", list.length ? `<div class="attn">${list.map(attnRow).join("")}</div>` : `<p class="calm">${ICON.done} Nothing overdue, blocked or escalated. You're on top of things.</p>`, { count: allItems.length, cls: "attention" }));
  }

  if (!hidden.has("today")) {
    const todayList = sortTasks([...overdue, ...dueToday, ...open.filter(t => followUpDue(t, now) && !overdue.includes(t) && !dueToday.includes(t))]);
    const fuRows = fuItemsDue.map(fuRow).join("");
    parts.push(section("Today", (todayList.length ? `<div class="list">${todayList.slice(0, 12).map(t => taskRow(t)).join("")}</div>` : "") + (fuRows ? `<div class="list">${fuRows}</div>` : "") +
      (!todayList.length && !fuRows ? `<p class="calm">Nothing due today.${inbox.length ? ` <a href="#/tasks/inbox">${inbox.length} item(s) in your inbox</a> to sort.` : ""}</p>` : "") +
      (todayList.length > 12 ? `<a class="more" href="#/tasks/today">See all ${todayList.length}</a>` : ""), { count: todayList.length + fuItemsDue.length }));
  }
  if (!hidden.has("habits") && activeHabits().length) {
    const hl = habitChecklist();
    if (hl) parts.push(section("Habits today", hl + `<a class="more" href="#/goals/habits">Week view</a>`, { cls: "habits-sect" }));
  }

  const grid = [];
  if (!hidden.has("upcoming")) {
    const agenda = [];
    for (let i = 1; i <= 7; i++) {
      const d = addDays(today, i);
      const items = [
        ...open.filter(t => t.due_at && zonedDate(t.due_at, tz) === d).map(t => ({ k: "task", t })),
        ...msOpen.filter(m => m.planned_date === d).map(m => ({ k: "ms", m })),
        ...fus.filter(f => f.next_follow_up_at && zonedDate(f.next_follow_up_at, tz) === d).map(f => ({ k: "fu", f }))
      ];
      if (items.length) agenda.push(`<div class="ag-day"><div class="ag-date">${relDay(d, tz)}<small>${fmtDate(d, { day: "numeric", month: "short" })}</small></div><div class="ag-items">${items.map(agItem).join("")}</div></div>`);
    }
    grid.push(section("Next 7 days", agenda.join("") || `<p class="calm">No deadlines, milestones or follow-ups in the next week.</p>`, { right: `<a class="more" href="#/calendar">Calendar</a>` }));
  }
  if (!hidden.has("waiting")) {
    const w = sortTasks(waiting).slice(0, 8);
    grid.push(section("Waiting on others", w.length ? `<div class="list compact">${w.map(t => taskRow(t)).join("")}</div>` : `<p class="calm">Not waiting on anyone.</p>`, { count: waiting.length, right: waiting.length > 8 ? `<a class="more" href="#/tasks/waiting">All</a>` : "" }));
  }
  if (grid.length) parts.push(`<div class="grid-2">${grid.join("")}</div>`);

  if (!hidden.has("projects")) {
    parts.push(section("Project health", projects.length ? `<div class="ph-list">${projects.map(p => phRow(p)).join("")}</div>` :
      `<p class="calm">No projects yet. Create one inside a workspace to track milestones and progress.</p>`, { count: projects.length, right: `<a class="more" href="#/workspaces">Workspaces</a>` }));
  }

  if (!hidden.has("activity")) {
    const acts = state.activity.filter(a => !wsFilter || a.workspace_id === wsFilter).slice(0, 10);
    parts.push(section("Recent activity", acts.length ? `<ul class="feed">${acts.map(actRow).join("")}</ul>` : `<p class="calm">Changes you and your team make will appear here.</p>`));
  }

  view.innerHTML = parts.join("");
}

const tile = (label, n, href, cls = "", ok = false) => `<a class="tile ${cls} ${ok && n ? "ok" : ""}" href="${href}"><span class="tl">${label}</span><span class="tn num">${n}</span></a>`;

function attnRow(i) {
  const icon = i.kind === "project" ? ICON.folder : i.kind === "milestone" ? ICON.milestone : i.kind === "follow_up" ? ICON.phone : ICON.tasks;
  let title = "", sub = "", act = "", id = i.id;
  if (i.kind === "task") { const t = i.ref, ws = wsById(t.workspace_id); title = t.title; sub = `${ws ? esc(ws.name) : ""} · ${PRIORITY_LABEL[t.priority]}${t.status === "blocked" && t.blocker ? " · " + esc(t.blocker) : ""}`; act = "open-task"; }
  if (i.kind === "follow_up") { const f = i.ref, c = contactById(f.contact_id); title = f.subject; sub = `${esc(c ? c.name : f.counterpart || "")} · ${esc((wsById(f.workspace_id) || {}).name || "")}`; act = "open-followup"; }
  if (i.kind === "project") { title = i.ref.name; sub = esc((i.why || []).join(" · ")); act = "open-project"; }
  if (i.kind === "milestone") { const p = projectById(i.ref.project_id); title = i.ref.title; sub = `${esc(p ? p.name : "")} · planned ${fmtDate(i.ref.planned_date)}`; act = "open-project"; id = i.ref.project_id; }
  return `<div class="attn-row" data-act="${act}" data-id="${id}" role="button" tabindex="0"><span class="attn-ico s${Math.min(3, Math.floor(i.score / 30))}">${icon}</span>
    <div class="tmain"><div class="ttitle">${esc(title)}</div><div class="tmeta">${sub}</div></div><span class="attn-why">${esc(i.reason)}</span></div>`;
}

function fuRow(f) {
  const c = contactById(f.contact_id), ws = wsById(f.workspace_id);
  return `<div class="trow fu" data-act="open-followup" data-id="${f.id}" role="button" tabindex="0"><span class="fu-ico">${ICON.phone}</span>
    <div class="tmain"><div class="ttitle">${esc(f.subject)}</div><div class="tmeta"><span class="m-ws">${wsDot(ws)}${esc(ws ? ws.name : "")}</span><span>${f.direction === "they_owe" ? "Awaiting" : "You owe"} · ${esc(c ? c.name : f.counterpart || "")}</span></div></div>
    <div class="tside">${f.status === "escalated" ? `<span class="pill s-blocked">Escalated</span>` : `<span class="pill s-waiting">Follow up</span>`}</div></div>`;
}

function agItem(x) {
  if (x.k === "task") return `<button class="ag-it" data-act="open-task" data-id="${x.t.id}"><span class="prio-dot p-${x.t.priority}"></span>${esc(x.t.title)}</button>`;
  if (x.k === "ms") return `<button class="ag-it ms" data-act="open-project" data-id="${x.m.project_id}">${ICON.milestone}${esc(x.m.title)}</button>`;
  return `<button class="ag-it fu" data-act="open-followup" data-id="${x.f.id}">${ICON.phone}${esc(x.f.subject)}</button>`;
}

export function phRow(p) {
  const h = state.healthById.get(p.id) || {}, ws = wsById(p.workspace_id);
  const pct = h.progress ?? null;
  return `<a class="ph-row" href="#/p/${p.id}">
    <div class="ph-name"><span class="ttitle">${esc(p.name)}</span><span class="tmeta"><span class="m-ws">${wsDot(ws)}${esc(ws ? ws.name : "")}</span>${h.next_milestone_title ? `<span>Next: ${esc(h.next_milestone_title)}${h.next_milestone_date ? " · " + fmtDate(h.next_milestone_date) : ""}</span>` : ""}</span></div>
    <div class="ph-bar"><div class="bar"><i style="width:${pct || 0}%"></i></div><span class="num">${pct === null ? "—" : pct + "%"}</span></div>
    <div class="ph-status">${projectPill(h.effective_status || "on_track")}</div>
  </a>`;
}

export function actRow(a) {
  const what = { created: "created", updated: "updated", completed: "completed", reopened: "reopened", deleted: "binned", restored: "restored", insert: "added", update: "updated", delete: "deleted", dependency_added: "added a prerequisite to", member_added: "added a member to", member_removed: "removed a member from", role_changed: "changed a role in" }[a.action] || a.action;
  let label = "";
  if (a.entity_type === "task") { const t = state.taskById.get(a.entity_id); label = t ? `<button class="linkbtn" data-act="open-task" data-id="${t.id}">${esc(t.title)}</button>` : `<span>${esc((a.changes && a.changes.title) || "a task")}</span>`; }
  else if (a.entity_type === "project") { const p = projectById(a.entity_id); label = p ? `<a href="#/p/${p.id}">${esc(p.name)}</a>` : "a project"; }
  else if (a.entity_type === "note") { const n = state.notes.find(x => x.id === a.entity_id); label = n ? `<button class="linkbtn" data-act="open-note" data-id="${n.id}">${esc(n.title)}</button>` : "a note"; }
  else if (a.entity_type === "document") { const d = state.documents.find(x => x.id === a.entity_id); label = d ? `<button class="linkbtn" data-act="open-doc" data-id="${d.id}">${esc(d.title)}</button>` : "a document"; }
  else if (a.entity_type === "follow_up") label = "a follow-up";
  else if (a.entity_type === "milestone") label = "a milestone";
  else if (a.entity_type === "workspace") label = esc((wsById(a.entity_id) || {}).name || "a workspace");
  return `<li>${a.actor_id ? avatar(a.actor_id, "sm") : `<span class="av sm sys">·</span>`}<div><span>${esc(a.actor_id ? shortName(a.actor_id) : "System")} ${what} ${label}</span><time>${ago(a.created_at)}</time></div></li>`;
}

/* one-line briefing from stored records (rule-based; no AI) */
function briefingHtml(today, now) {
  const hd = activeHabits().filter(h => habitDueOn(h, today));
  const billsDue = fin.invoices.filter(i => i.kind === "purchase" && i.status === "posted" && i.due_date && i.due_date <= addDays(today, 7) && (() => { const t = fin.totals.get(i.id); return t && Number(t.total) > Number(t.paid); })());
  const b = dailyBriefing({ tasks: state.tasks, followUps: state.followUps, uid: state.user.id, tz: state.tz, now, habitsDue: hd.length, habitsDone: hd.filter(h => doneSet(h.id).has(today)).length, billsDue });
  return `<p class="briefing">${esc(b.summary)}${b.focus ? ` <span class="hint">Start with</span> <button class="linkbtn" data-act="open-task" data-id="${b.focus.id}">${esc(b.focus.title)}</button>` : ""}</p>`;
}
