// Wall board: an always-on, full-screen view for a spare monitor.
// One column per workspace (project), live via the existing realtime subscription.
import { esc } from "../util.js";
import { sortTasks, isClosed, isOverdue, dueInDays } from "../logic.js";
import { state, activeWorkspaces, projectById, subtasksOf } from "../store.js";
import { loadAll } from "../api.js";
import { ICON, prioChip, statusPill, dueLabel, avatar } from "../ui.js";

const LS_EMPTY = "jd-wall-hide-empty";
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v === "1"; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v ? "1" : "0"); } catch (e) {} };

const isToday = iso => {
  if (!iso) return false;
  const f = d => new Intl.DateTimeFormat("en-CA", { timeZone: state.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return f(new Date(iso)) === f(new Date());
};

function card(t) {
  const d = dueLabel(t), proj = projectById(t.project_id);
  const subs = subtasksOf(t.id).filter(s => s.status !== "cancelled");
  const subsDone = subs.filter(s => s.status === "completed").length;
  const mine = t.owner_id === state.user.id || t.assignee_id === state.user.id;
  const note = t.status === "waiting" && t.waiting_on ? `Waiting on ${t.waiting_on}` : t.status === "blocked" && t.blocker ? `Blocked: ${t.blocker}` : t.next_action ? `Next: ${t.next_action}` : "";
  const cls = ["wcard", isOverdue(t) ? "over" : "", t.status === "blocked" ? "blk" : "", `p-${t.priority}`].join(" ");
  return `<article class="${cls}" data-act="open-task" data-id="${t.id}" role="button" tabindex="0">
    <div class="wc-title">${esc(t.title)}</div>
    ${note ? `<div class="wc-note">${esc(note)}</div>` : ""}
    <div class="wc-meta">
      ${["critical", "high"].includes(t.priority) ? prioChip(t.priority) : ""}
      ${t.status !== "not_started" ? statusPill(t.status) : ""}
      ${d.text ? `<span class="wc-due ${d.cls}">${esc(d.text)}</span>` : ""}
      ${subs.length ? `<span class="wc-sub">${subsDone}/${subs.length}</span>` : ""}
      ${proj ? `<span class="wc-proj">${esc(proj.name)}</span>` : ""}
      ${!mine && (t.assignee_id || t.owner_id) ? avatar(t.assignee_id || t.owner_id, "sm") : ""}
    </div>
  </article>`;
}

export function renderWall(view) {
  const hideEmpty = lsGet(LS_EMPTY, false);
  const live = state.tasks.filter(t => !t.deleted_at && !t.parent_id);
  const now = new Date();
  const cols = activeWorkspaces().map(w => {
    const mine = live.filter(t => t.workspace_id === w.id);
    const open = sortTasks(mine.filter(t => !isClosed(t)), "smart");
    const done = mine.filter(t => t.status === "completed" && isToday(t.completed_at)).sort((a, b) => (b.completed_at || "").localeCompare(a.completed_at || ""));
    return { w, open, done, over: open.filter(t => isOverdue(t, now)).length };
  }).filter(c => !hideEmpty || c.open.length || c.done.length);

  const allOpen = cols.flatMap(c => c.open);
  const kpi = {
    open: allOpen.length,
    over: allOpen.filter(t => isOverdue(t, now)).length,
    today: allOpen.filter(t => !isOverdue(t, now) && dueInDays(t, state.tz) === 0).length,
    waiting: allOpen.filter(t => t.status === "waiting" || t.status === "blocked").length,
    done: cols.reduce((n, c) => n + c.done.length, 0)
  };
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: state.tz, weekday: "long", day: "numeric", month: "long" }).format(now);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: state.tz, hour: "2-digit", minute: "2-digit" }).format(now);

  view.innerHTML = `<div class="wall">
    <header class="wall-head">
      <a class="wall-brand" href="#/home" title="Back to J. Desk"><span class="wm">J<i>.</i> Desk</span><small>Board</small></a>
      <div class="wall-kpis">
        <div><b>${kpi.open}</b><span>Pending</span></div>
        <div class="${kpi.over ? "bad" : ""}"><b>${kpi.over}</b><span>Overdue</span></div>
        <div class="${kpi.today ? "warn" : ""}"><b>${kpi.today}</b><span>Due today</span></div>
        <div><b>${kpi.waiting}</b><span>Waiting / blocked</span></div>
        <div class="ok"><b>${kpi.done}</b><span>Done today</span></div>
      </div>
      <div class="wall-right">
        <div class="wall-clock"><b class="num">${time}</b><span>${esc(clock)}</span></div>
        <div class="wall-tools">
          <button class="iconbtn" data-act="capture" title="Add a task (C)" aria-label="Add a task">${ICON.plus}</button>
          <button class="btn sm ${hideEmpty ? "on" : ""}" data-act="wall-empty" title="Show or hide workspaces with nothing pending">${hideEmpty ? "Show empty" : "Hide empty"}</button>
          <button class="btn sm" data-act="wall-full" title="Full screen (F)">Full screen</button>
        </div>
      </div>
    </header>
    <div class="wall-cols" style="--n:${Math.max(cols.length, 1)}">
      ${cols.length ? cols.map(c => `<section class="wcol" style="--wc:${esc(c.w.color || "var(--accent)")}">
        <h2><i class="dot"></i><span>${esc(c.w.name)}</span><b class="num">${c.open.length}</b>${c.over ? `<em>${c.over} overdue</em>` : ""}</h2>
        <div class="wcol-body">
          ${c.open.length ? c.open.map(card).join("") : `<div class="wcol-clear">All clear ✓</div>`}
          ${c.done.length ? `<div class="wcol-done"><p>Done today · ${c.done.length}</p>${c.done.slice(0, 6).map(t => `<div class="wdone" data-act="open-task" data-id="${t.id}" role="button" tabindex="0">${esc(t.title)}</div>`).join("")}</div>` : ""}
        </div>
      </section>`).join("") : `<div class="wcol-clear big">Nothing pending anywhere. Enjoy it.</div>`}
    </div>
    <footer class="wall-foot"><span class="live"><i></i>Live</span> Updates by itself when tasks change on any device. Click a card to open it.</footer>
  </div>`;
}

/* ---------- always-on behaviour ---------- */
let wakeLock = null, safety = null;
async function keepAwake() {
  try { if ("wakeLock" in navigator && document.visibilityState === "visible" && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); } } catch (e) { wakeLock = null; }
}
export function enterWall() {
  document.body.classList.add("wall-on");
  keepAwake();
  // belt and braces: refetch every 5 minutes in case the live connection dropped overnight
  if (!safety) safety = setInterval(() => { if (navigator.onLine) loadAll().catch(() => {}); }, 5 * 60 * 1000);
}
export function leaveWall() {
  document.body.classList.remove("wall-on");
  if (safety) { clearInterval(safety); safety = null; }
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener("visibilitychange", () => { if (document.body.classList.contains("wall-on")) keepAwake(); });

function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}
export function handleWallClick(act, rerender) {
  if (act === "wall-empty") { lsSet(LS_EMPTY, !lsGet(LS_EMPTY, false)); rerender(); return true; }
  if (act === "wall-full") { toggleFull(); return true; }
  return false;
}
export function handleWallKey(e) {
  if (!document.body.classList.contains("wall-on")) return false;
  if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleFull(); return true; }
  return false;
}
