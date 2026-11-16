// Wall board: an always-on, full-screen view for a spare monitor.
// A whiteboard of pending jobs: quick to-dos (carried over / today), open project jobs and what got done today.
import { esc } from "../util.js";
import { state, activeWorkspaces, wsById } from "../store.js";
import { loadAll } from "../api.js";
import { ICON } from "../ui.js";
import { projectStats } from "./simple.js";
import { letter, critFirst } from "./quicktodo.js";

const LS_PROJ = "jd-wall-projects", LS_HIDE_WS = "jd-wall-hide-ws";
const lsList = k => { try { return JSON.parse(localStorage.getItem(k) || "[]"); } catch (e) { return []; } };
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v === "1"; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v ? "1" : "0"); } catch (e) {} };

const dayOf = iso => new Intl.DateTimeFormat("en-CA", { timeZone: state.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

function todoNote(t, today, num) {
  const ad = dayOf(t.created_at), n = Math.round((new Date(today) - new Date(ad)) / 864e5);
  const items = Array.isArray(t.items) ? t.items : [];
  const dn = items.filter(x => x.done).length;
  return `<article class="wnote ${n >= 2 ? "old" : n === 1 ? "y" : ""} ${t.critical ? "crit" : ""}">
    <div class="wn-top"><button class="sw-check" data-act="qt-toggle" data-id="${t.id}" aria-label="Mark done"></button><div class="wn-title"><b class="wn-num">${num}.</b> ${t.critical ? `<em class="qt-crit">Critical</em> ` : ""}${esc(t.text)}</div></div>
    ${t.note ? `<div class="wn-desc">${esc(t.note)}</div>` : ""}
    ${items.length ? `<ul class="qt-sub wn-sub">${items.map((x, i) => `<li class="${x.done ? "on" : ""}"><b class="qt-letter">${letter(i)}.</b><button class="qt-subc ${x.done ? "on" : ""}" data-act="qt-sub" data-id="${t.id}" data-i="${i}" aria-label="Tick">${x.done ? ICON.check : ""}</button><span>${esc(x.text)}</span></li>`).join("")}</ul>` : ""}
    <div class="wn-meta">${n <= 0 ? "Added today" : n === 1 ? "From yesterday" : `Since ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(ad + "T12:00:00Z"))} · ${n} days`}${items.length ? ` · ${dn}/${items.length}` : ""}</div>
  </article>`;
}
function projectCard(p) {
  const s = projectStats(p), w = wsById(p.workspace_id) || {};
  const n = s.next;
  const dl = p.target_date ? (s.daysLeft < 0 ? `<b class="bad-text">${-s.daysLeft}d late</b>` : s.daysLeft === 0 ? `<b class="warn-text">due today</b>` : `${s.daysLeft}d left`) : "";
  return `<a class="wcard wproj ${s.status === "overdue" ? "over" : ""} ${p.priority === "critical" ? "p-critical" : ""}" href="#/p/${p.id}" style="--wc:${esc(w.color || "var(--accent)")}">
    <div class="wc-title">${esc(p.name)}</div>
    ${n ? `<div class="wc-note">Next: ${esc(n.s ? n.s.title : n.t.title)}${n.s && n.s.responsible ? ` <span class="sw-who">${esc(n.s.responsible)}</span>` : ""}</div>` : ""}
    <div class="wc-meta"><span class="wc-ws"><i class="dot" style="background:${esc(w.color || "var(--accent)")}"></i>${esc(w.name || "")}</span>${p.priority === "critical" ? `<span class="sw-pill pr-critical">Critical</span>` : ""}${dl ? `<span class="wc-due">${dl}</span>` : ""}<span class="wc-sub">${s.done}/${s.total}</span></div>
  </a>`;
}

export function renderWall(view) {
  const showProj = lsGet(LS_PROJ, false); // off by default: workspace names stay private on a shared screen
  const now = new Date(), today = dayOf(now.toISOString());
  const todos = state.quick || [];
  const open = todos.filter(t => !t.done_at).sort(critFirst);
  const carried = open.filter(t => dayOf(t.created_at) < today), fresh = open.filter(t => dayOf(t.created_at) >= today);
  const doneToday = todos.filter(t => t.done_at && dayOf(t.done_at) === today).sort((a, b) => b.done_at.localeCompare(a.done_at));
  const hidden = new Set(lsList(LS_HIDE_WS));
  const wsIds = new Set(activeWorkspaces().filter(w => !hidden.has(w.id)).map(w => w.id));
  const projs = state.projects.filter(p => !p.archived && !p.closed_at && wsIds.has(p.workspace_id)).map(p => ({ p, s: projectStats(p) }))
    .sort((a, b) => (a.s.status === "overdue" ? 0 : 1) - (b.s.status === "overdue" ? 0 : 1) || (a.p.priority === "critical" ? 0 : 1) - (b.p.priority === "critical" ? 0 : 1) || (a.s.daysLeft ?? 9999) - (b.s.daysLeft ?? 9999)).map(x => x.p);
  const stepsDone = (state.steps || []).filter(x => x.status === "done" && x.done_at && dayOf(x.done_at) === today);
  const overdueP = projs.filter(p => projectStats(p).status === "overdue").length;
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: state.tz, weekday: "long", day: "numeric", month: "long" }).format(now);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: state.tz, hour: "2-digit", minute: "2-digit" }).format(now);
  const col = (title, cls, count, body, extra = "") => `<section class="wcol ${cls}"><h2><span>${title}</span><b class="num">${count}</b>${extra}</h2><div class="wcol-body">${body}</div></section>`;

  view.innerHTML = `<div class="wall wb">
    <header class="wall-head">
      <a class="wall-brand" href="#/todo" title="Back to To-do"><span class="wm">J<i>.</i> Desk</span><small>Pending jobs</small></a>
      <div class="wall-kpis">
        <div><b>${open.length}</b><span>To-dos pending</span></div>
        ${open.some(t => t.critical) ? `<div class="bad"><b>${open.filter(t => t.critical).length}</b><span>Critical</span></div>` : ""}
        <div class="${carried.length ? "bad" : ""}"><b>${carried.length}</b><span>Carried over</span></div>
        ${showProj ? `<div><b>${projs.length}</b><span>Open projects</span></div><div class="${overdueP ? "bad" : ""}"><b>${overdueP}</b><span>Projects overdue</span></div>` : ""}
        <div class="ok"><b>${doneToday.length + (showProj ? stepsDone.length : 0)}</b><span>Done today</span></div>
      </div>
      <div class="wall-right">
        <div class="wall-clock"><b class="num">${time}</b><span>${esc(clock)}</span></div>
        <div class="wall-tools">
          <button class="btn sm" data-act="wall-proj">${showProj ? "Hide projects" : "Show projects"}</button>
          <button class="btn sm" data-act="wall-full" title="Full screen (F)">Full screen</button>
        </div>
      </div>
    </header>
    ${showProj ? `<div class="wb-ws"><span>Projects from:</span>${activeWorkspaces().map(w => `<button class="chip ${hidden.has(w.id) ? "" : "on"}" data-act="wall-ws" data-id="${w.id}"><i class="dot" style="background:${esc(w.color)}"></i>${esc(w.name)}</button>`).join("")}</div>` : ""}
    <form class="wb-add" data-form="qt-add"><input class="input" name="text" maxlength="500" placeholder="Write on the board… (Enter to add a to-do)" autocomplete="off"></form>
    <div class="wall-cols wb-cols" style="--n:${showProj ? 4 : 3}">
      ${col("Carried over", "c-old", carried.length, carried.length ? carried.map((t, i) => todoNote(t, today, i + 1)).join("") : `<div class="wcol-clear">Nothing left from earlier ✓</div>`)}
      ${col("Today", "c-today", fresh.length, fresh.length ? fresh.map((t, i) => todoNote(t, today, carried.length + i + 1)).join("") : `<div class="wcol-clear">Add today's jobs above</div>`)}
      ${showProj ? col("Project jobs", "c-proj", projs.length, projs.length ? projs.map(projectCard).join("") : `<div class="wcol-clear">No open projects</div>`, overdueP ? `<em>${overdueP} overdue</em>` : "") : ""}
      ${col("Done today", "c-done", doneToday.length + (showProj ? stepsDone.length : 0),
        (doneToday.map(t => `<div class="wdone"><button class="sw-check on" data-act="qt-toggle" data-id="${t.id}" aria-label="Undo">${ICON.check}</button><span>${esc(t.text)}</span></div>`).join("") +
        (showProj ? stepsDone.map(x => { const tk = state.taskById.get(x.task_id); return `<div class="wdone"><span class="wd-ic">${ICON.check}</span><span>${esc(x.title)}${tk ? ` <small class="faint">· ${esc(tk.title)}</small>` : ""}</span></div>`; }).join("") : "")) || `<div class="wcol-clear">Nothing ticked off yet</div>`)}
    </div>
    <footer class="wall-foot"><span class="live"><i></i>Live</span> Updates by itself when you add or tick things on any device. Tick a note to finish it.</footer>
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
export function handleWallClick(act, rerender, el) {
  if (act === "wall-ws") { const id = el && el.dataset.id, h = new Set(lsList(LS_HIDE_WS)); h.has(id) ? h.delete(id) : h.add(id); try { localStorage.setItem(LS_HIDE_WS, JSON.stringify([...h])); } catch (e) {} rerender(); return true; }
  if (act === "wall-proj") { lsSet(LS_PROJ, !lsGet(LS_PROJ, false)); rerender(); return true; }
  if (act === "wall-full") { toggleFull(); return true; }
  return false;
}
export function handleWallKey(e) {
  if (!document.body.classList.contains("wall-on")) return false;
  if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleFull(); return true; }
  return false;
}
