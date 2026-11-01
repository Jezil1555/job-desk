// Personal: your own tasks, projects, money, notes, goals and habits — kept apart from the businesses.
import { esc, todayISO } from "../util.js";
import { state, activeWorkspaces } from "../store.js";
import { isOpen, sortTasks } from "../logic.js";
import { ICON, taskRow, section, emptyState } from "../ui.js";
import { fin, loadFin, linesOf, accountsOf } from "../finapi.js";
import { money, r2, natural, profitAndLoss } from "../finance.js";

export function renderPersonal(view) {
  const wss = activeWorkspaces().filter(w => w.kind === "personal");
  const wsIds = new Set(wss.map(w => w.id)), ws0 = wss[0];
  const tasks = sortTasks(state.tasks.filter(t => wsIds.has(t.workspace_id) && isOpen(t) && !t.parent_id && !t.deleted_at));
  const projs = state.projects.filter(p => wsIds.has(p.workspace_id) && !p.archived);
  const notes = state.notes.filter(n => wsIds.has(n.workspace_id)).slice(0, 5);
  const habits = (state.habits || []).filter(h => !h.archived), goals = (state.goals || []).filter(g => g.status === "active");
  if (!fin.loaded && !fin.loading) loadFin();
  const books = fin.loaded ? fin.entities.filter(e => e.kind === "personal" && !e.archived) : [];
  const t = todayISO(state.tz), ms = t.slice(0, 8) + "01";
  const moneyRow = e => {
    const ls = linesOf(e.id), accs = accountsOf(e.id);
    const cash = r2(accs.filter(a => ["cash", "bank"].includes(a.subtype)).reduce((s, a) => s + natural(a, ls.filter(l => l.account_id === a.id).reduce((x, l) => x + Number(l.debit) - Number(l.credit), 0)), 0));
    const pl = profitAndLoss(accs, ls, ms, t);
    return `<a href="#/finance/${e.id}/overview"><span class="grow"><b>${esc(e.name)}</b><br><small>Spent this month ${money(pl.totalExpenses + pl.totalCogs, e.base_currency)}</small></span><span class="num">${money(cash, e.base_currency)}<br><small>cash & bank</small></span></a>`;
  };
  const prog = p => { const ts = state.tasks.filter(x => x.project_id === p.id && !x.parent_id && !x.deleted_at && x.status !== "cancelled"); const d = ts.filter(x => x.status === "completed").length; return ts.length ? Math.round(d * 100 / ts.length) : null; };
  view.innerHTML = `
  <div class="page-head"><div><h1>Personal</h1><p class="sub">Your own tasks, projects, money and notes — kept apart from the businesses.</p></div>
    ${ws0 ? `<div class="btnrow"><button class="btn primary" data-act="capture" data-ws="${ws0.id}">${ICON.plus}Personal task</button></div>` : ""}</div>
  ${!ws0 ? emptyState("No personal workspace", "Create a workspace of type Personal to keep your own tasks here.", `<button class="btn primary" data-act="new-workspace">${ICON.plus}New workspace</button>`) : ""}
  ${ws0 ? section("Tasks", tasks.length ? `<div class="list">${tasks.slice(0, 8).map(x => taskRow(x, { showWs: false })).join("")}</div>${tasks.length > 8 ? `<p><a href="#/w/${ws0.id}/tasks">All ${tasks.length} personal tasks</a></p>` : ""}` : `<p class="calm">Nothing open. Use the button above or Quick capture.</p>`, { count: tasks.length }) : ""}
  ${ws0 ? section("Projects", `${projs.length ? `<div class="plist">${projs.map(p => { const pc = prog(p); return `<a href="#/p/${p.id}"><span class="grow">${esc(p.name)}${p.target_date ? `<br><small>target ${esc(p.target_date)}</small>` : ""}</span><small class="num">${pc === null ? "no tasks yet" : pc + "% done"}</small></a>`; }).join("")}</div>` : `<p class="calm">No personal projects — a trip, a move, a renovation fits here.</p>`}
    <p><button class="btn sm" data-act="new-project" data-ws="${ws0.id}">${ICON.plus}New personal project</button></p>`, { count: projs.length }) : ""}
  ${section("Money", fin.loaded ? (books.length ? `<div class="plist">${books.map(moneyRow).join("")}</div><p class="hint">Your personal books only. Business money stays in each business's own books under Finance.</p>` : `<p class="calm">No personal books yet. <a href="#/finance">Set them up in Finance</a>.</p>`) : `<p class="hint">Loading…</p>`)}
  ${section("Notes", `${notes.length ? `<div class="plist">${notes.map(n => `<a href="#/n/${n.id}"><span class="grow">${esc(n.title)}</span><small>${esc((n.updated_at || "").slice(0, 10))}</small></a>`).join("")}</div>` : `<p class="calm">No personal notes yet.</p>`}
    <p><a href="#/notes">All notes & documents</a></p>`, { count: notes.length })}
  ${section("Goals & habits", `<div class="plist"><a href="#/goals/goals"><span class="grow">Goals</span><small>${goals.length} active</small></a><a href="#/goals/habits"><span class="grow">Habits</span><small>${habits.length} tracked</small></a><a href="#/goals/health"><span class="grow">Health log</span><small>private</small></a></div>`)}`;
}
