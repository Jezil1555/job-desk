// Goals, habits and (optional) health logs. All of this is private to the signed-in user — even inside shared workspaces.
import { esc, todayISO, addDays, fmtDate, fmtNum, ago } from "../util.js";
import { habitDueOn, habitStreak, habitRate, goalProgress, weekStartOf, weekDays } from "../insights.js";
import { state } from "../store.js";
import { sb, run } from "../api.js";
import { ICON, $, openSheet, closeSheet, rerenderSheet, sheetHead, toast, toastError, dialog, busy, emptyState } from "../ui.js";

export const HORIZON = { long_term: "Long-term", yearly: "This year", quarterly: "This quarter", monthly: "This month", weekly: "This week" };
const GOAL_CAT = { career: "Career", business: "Business", health: "Health", finance: "Finance", learning: "Learning", family: "Family", personal: "Personal", other: "Other" };
const HABIT_CAT = { health: "Health", fitness: "Fitness", learning: "Learning", family: "Family", work: "Work", finance: "Finance", personal: "Personal", other: "Other" };
const HEALTH_KIND = { weight: "Weight", workout: "Workout", walk: "Walk", wellness: "Wellness note" };
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const val = id => ($(id) ? $(id).value.trim() : "");
const num = id => { const v = val(id); return v === "" ? null : Number(v); };

export const doneSet = hid => new Set(state.habitLogs.filter(l => l.habit_id === hid).map(l => l.log_date));
export const activeHabits = () => state.habits.filter(h => !h.archived).sort((a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at));

/* ---------- shared: habit check-in rows (also used on the Command Centre) ---------- */
export function habitChecklist(today = todayISO(state.tz)) {
  const list = activeHabits().filter(h => habitDueOn(h, today));
  if (!list.length) return "";
  return `<div class="habits">${list.map(h => {
    const done = doneSet(h.id), on = done.has(today), streak = habitStreak(h, done, today);
    const weekCount = h.schedule === "weekly" ? weekDays(weekStartOf(today)).filter(d => done.has(d)).length : null;
    return `<button class="habit ${on ? "on" : ""}" data-act="habit-toggle" data-id="${h.id}" data-date="${today}" aria-pressed="${on}">
      <span class="hcheck">${on ? ICON.check : ""}</span><span class="htitle">${esc(h.title)}</span>
      <small>${weekCount !== null ? `${weekCount}/${h.per_week} this week` : ""}${streak ? ` · 🔥 ${streak}` : ""}</small></button>`;
  }).join("")}</div>`;
}

/* ---------- screen ---------- */
export function renderGoals(view, tab = "habits") {
  if (!["habits", "goals", "health"].includes(tab)) tab = "habits";
  const today = todayISO(state.tz);
  let body = "";
  if (tab === "habits") body = habitsTab(today);
  else if (tab === "goals") body = goalsTab();
  else body = healthTab(today);
  view.innerHTML = `
  <div class="page-head"><div><h1>Goals & Habits</h1><p class="sub">${ICON.lock} Private to you — never shown to people in your shared workspaces.</p></div>
    <div class="btnrow">${tab === "habits" ? `<button class="btn primary" data-act="habit-new">${ICON.plus}New habit</button>` : tab === "goals" ? `<button class="btn primary" data-act="goal-new">${ICON.plus}New goal</button>` : `<button class="btn primary" data-act="health-new">${ICON.plus}Log entry</button>`}</div></div>
  <div class="viewtabs"><a href="#/goals/habits" class="${tab === "habits" ? "on" : ""}">Habits</a><a href="#/goals/goals" class="${tab === "goals" ? "on" : ""}">Goals</a><a href="#/goals/health" class="${tab === "health" ? "on" : ""}">Health log</a></div>
  ${body}`;
}

function habitsTab(today) {
  const list = activeHabits();
  if (!list.length) return emptyState("No habits yet", "Add the routines you want to keep — gym, reading, Arabic practice, family time — and tick them off each day.", `<button class="btn primary" data-act="habit-new">${ICON.plus}New habit</button>`);
  const ws = weekStartOf(today), days = weekDays(ws);
  const from30 = addDays(today, -29);
  const rows = list.map(h => {
    const done = doneSet(h.id), streak = habitStreak(h, done, today);
    const start = h.created_at ? h.created_at.slice(0, 10) : from30;
    const rate = habitRate(h, done, start > from30 ? start : from30, today);
    const sched = h.schedule === "daily" ? "Every day" : h.schedule === "weekly" ? `${h.per_week}× a week` : h.days.map(d => DOW[d]).join(", ");
    return `<tr><th scope="row"><button class="linkbtn" data-act="habit-edit" data-id="${h.id}">${esc(h.title)}</button><small>${sched}</small></th>
      ${days.map(d => { const due = habitDueOn(h, d), on = done.has(d), fut = d > addDays(today, 0);
        return `<td><button class="hcell ${on ? "on" : ""} ${due ? "" : "off"} ${d === today ? "today" : ""}" ${fut ? "disabled" : ""} data-act="habit-toggle" data-id="${h.id}" data-date="${d}" aria-label="${esc(h.title)} ${fmtDate(d)}${on ? " done" : ""}">${on ? ICON.check : ""}</button></td>`; }).join("")}
      <td class="num">${streak ? `🔥 ${streak}` : "—"}</td><td class="num">${rate === null ? "—" : rate + "%"}</td></tr>`;
  }).join("");
  const dueToday = list.filter(h => habitDueOn(h, today));
  const doneToday = dueToday.filter(h => doneSet(h.id).has(today)).length;
  return `
  <section class="sect"><div class="sect-h"><h2>Today</h2><span class="c">${doneToday}/${dueToday.length} done</span></div>${habitChecklist(today) || `<p class="hint">Nothing scheduled today.</p>`}</section>
  <section class="sect"><div class="sect-h"><h2>This week</h2><span class="c">${fmtDate(days[0])} – ${fmtDate(days[6])}</span></div>
    <div class="tablewrap"><table class="hgrid"><thead><tr><th></th>${days.map(d => `<th class="${d === today ? "today" : ""}">${DOW[new Date(d + "T12:00:00Z").getUTCDay()]}<small>${+d.slice(8)}</small></th>`).join("")}<th class="num">Streak</th><th class="num">30 days</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="hint">Tap a day to tick or untick it. You can back-fill past days; future days are locked.</p></section>`;
}

function goalsTab() {
  const goals = state.goals;
  if (!goals.length) return emptyState("No goals yet", "Set long-term goals, then break them into yearly, quarterly, monthly and weekly objectives.", `<button class="btn primary" data-act="goal-new">${ICON.plus}New goal</button>`);
  const f = state.ui.goalStatus || "active";
  const shown = goals.filter(g => f === "all" || g.status === f);
  const byH = Object.keys(HORIZON).map(h => [h, shown.filter(g => g.horizon === h)]).filter(([, l]) => l.length);
  return `<div class="filters kfilters"><select class="input" id="goal-status">${[["active", "Active"], ["achieved", "Achieved"], ["dropped", "Dropped"], ["all", "All"]].map(([k, l]) => `<option value="${k}" ${f === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
  ${byH.map(([h, l]) => `<section class="sect"><div class="sect-h"><h2>${HORIZON[h]}</h2><span class="c">${l.length}</span></div><div class="goal-grid">${l.map(goalCard).join("")}</div></section>`).join("") || `<p class="hint">No ${f} goals.</p>`}`;
}
function goalCard(g) {
  const p = goalProgress(g), parent = g.parent_id && state.goals.find(x => x.id === g.parent_id);
  const kids = state.goals.filter(x => x.parent_id === g.id);
  const habits = state.habits.filter(h => h.goal_id === g.id && !h.archived);
  return `<button class="goal-card ${g.status}" data-act="goal-edit" data-id="${g.id}">
    <div class="gc-top"><span class="chip">${GOAL_CAT[g.category]}</span>${g.due_date ? `<small>by ${fmtDate(g.due_date)}</small>` : ""}</div>
    <div class="gc-title">${esc(g.title)}</div>
    ${parent ? `<small class="hint">Part of: ${esc(parent.title)}</small>` : ""}
    ${p !== null ? `<div class="bar"><i style="width:${p}%"></i></div><small>${fmtNum(g.current_value)} / ${fmtNum(g.target_value)} ${esc(g.unit || "")} · ${p}%</small>` : g.status === "achieved" ? `<small>Achieved ${g.achieved_at ? ago(g.achieved_at) : ""}</small>` : `<small class="hint">No numeric target</small>`}
    ${kids.length || habits.length ? `<small class="hint">${kids.length ? `${kids.filter(k => k.status === "achieved").length}/${kids.length} objectives` : ""}${kids.length && habits.length ? " · " : ""}${habits.length ? `${habits.length} habit${habits.length > 1 ? "s" : ""}` : ""}</small>` : ""}
  </button>`;
}

function healthTab(today) {
  const logs = [...state.healthLogs].sort((a, b) => b.log_date.localeCompare(a.log_date) || b.created_at.localeCompare(a.created_at));
  const weights = logs.filter(l => l.kind === "weight" && l.value !== null).slice(0, 30).reverse();
  const from7 = addDays(today, -6), from30 = addDays(today, -29);
  const act = (from) => logs.filter(l => (l.kind === "workout" || l.kind === "walk") && l.log_date >= from);
  const mins = l => l.reduce((s, x) => s + (x.duration_min || 0), 0);
  const walkKm = logs.filter(l => l.kind === "walk" && l.log_date >= from7 && (l.unit || "km") === "km").reduce((s, x) => s + Number(x.value || 0), 0);
  return `<p class="banner">${ICON.lock} Optional. Only you can see these entries. Delete any entry at any time.</p>
  <div class="tiles">
    <div class="tile"><span class="tn">${weights.length ? fmtNum(weights[weights.length - 1].value) + " " + esc(weights[weights.length - 1].unit || "kg") : "—"}</span><span class="tl">Latest weight</span></div>
    <div class="tile"><span class="tn">${act(from7).length}</span><span class="tl">Sessions, last 7 days</span></div>
    <div class="tile"><span class="tn">${mins(act(from7))}</span><span class="tl">Active minutes, 7 days</span></div>
    <div class="tile"><span class="tn">${walkKm ? walkKm.toFixed(1) : "0"}</span><span class="tl">Km walked, 7 days</span></div>
    <div class="tile"><span class="tn">${act(from30).length}</span><span class="tl">Sessions, 30 days</span></div>
  </div>
  ${weights.length >= 2 ? `<section class="sect"><div class="sect-h"><h2>Weight trend</h2><span class="c">last ${weights.length} entries</span></div>${sparkline(weights)}</section>` : ""}
  <section class="sect"><div class="sect-h"><h2>Entries</h2></div>
    ${logs.length ? `<div class="list">${logs.slice(0, 60).map(l => `<div class="trow"><span class="kico">${l.kind === "weight" ? "⚖️" : l.kind === "walk" ? "🚶" : l.kind === "workout" ? "🏋️" : "📝"}</span>
      <div class="tmain"><div class="ttitle">${HEALTH_KIND[l.kind]}${l.value !== null ? ` · ${fmtNum(l.value)} ${esc(l.unit || "")}` : ""}${l.duration_min ? ` · ${l.duration_min} min` : ""}</div>
      <div class="tmeta">${fmtDate(l.log_date)}${l.note ? " · " + esc(l.note) : ""}</div></div>
      <button class="iconbtn sm" data-act="health-delete" data-id="${l.id}" aria-label="Delete entry">${ICON.trash}</button></div>`).join("")}</div>`
      : emptyState("Nothing logged", "Log weight, workouts, walks or a quick wellness note.", `<button class="btn primary" data-act="health-new">${ICON.plus}Log entry</button>`)}
  </section>`;
}
function sparkline(points) {
  const W = 600, H = 120, P = 8, vs = points.map(p => Number(p.value));
  const min = Math.min(...vs), max = Math.max(...vs), span = max - min || 1;
  const xy = vs.map((v, i) => [P + i * (W - 2 * P) / Math.max(1, vs.length - 1), H - P - (v - min) / span * (H - 2 * P)]);
  return `<figure class="spark"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Weight from ${fmtNum(vs[0])} to ${fmtNum(vs[vs.length - 1])}">
    <polyline fill="none" stroke="var(--accent)" stroke-width="2.5" vector-effect="non-scaling-stroke" points="${xy.map(p => p.join(",")).join(" ")}"/>
    ${xy.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="3" fill="var(--accent)"><title>${fmtDate(points[i].log_date)}: ${fmtNum(vs[i])}</title></circle>`).join("")}</svg>
    <figcaption>${fmtDate(points[0].log_date)}: ${fmtNum(vs[0])} → ${fmtDate(points[points.length - 1].log_date)}: ${fmtNum(vs[vs.length - 1])} (${vs[vs.length - 1] - vs[0] >= 0 ? "+" : ""}${(vs[vs.length - 1] - vs[0]).toFixed(1)})</figcaption></figure>`;
}

/* ---------- sheets ---------- */
let editId = null, goalUpdates = [];
function openHabit(id) {
  editId = id || null;
  openSheet(sh => {
    const h = id ? state.habits.find(x => x.id === id) : { title: "", category: "personal", schedule: "daily", days: [0, 1, 2, 3, 4, 5, 6], per_week: 3, unit: "", target_value: null, goal_id: null };
    sh.innerHTML = sheetHead(id ? "Edit habit" : "New habit", "Private to you") + `<form id="habitForm" class="sh-body" novalidate>
      <label class="field"><span>Habit</span><input class="input" id="hb-title" value="${esc(h.title)}" placeholder="e.g. Gym, Read 20 pages, Call parents" maxlength="120" autofocus></label>
      <div class="grid2"><label class="field"><span>Category</span><select class="input" id="hb-cat">${Object.entries(HABIT_CAT).map(([k, l]) => `<option value="${k}" ${h.category === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="field"><span>Schedule</span><select class="input" id="hb-sched">${[["daily", "Every day"], ["days", "Specific days"], ["weekly", "Times per week"]].map(([k, l]) => `<option value="${k}" ${h.schedule === k ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
      <div class="field" id="hb-days-wrap" ${h.schedule === "days" ? "" : "hidden"}><span>Days</span><div class="daypick">${DOW.map((d, i) => `<label><input type="checkbox" name="hb-day" value="${i}" ${h.days.includes(i) ? "checked" : ""}>${d}</label>`).join("")}</div></div>
      <label class="field" id="hb-pw-wrap" ${h.schedule === "weekly" ? "" : "hidden"}><span>Times per week</span><input class="input" type="number" min="1" max="7" id="hb-pw" value="${h.per_week}"></label>
      <label class="field"><span>Supports goal <small>(optional)</small></span><select class="input" id="hb-goal"><option value="">None</option>${state.goals.filter(g => g.status === "active" || g.id === h.goal_id).map(g => `<option value="${g.id}" ${g.id === h.goal_id ? "selected" : ""}>${esc(g.title)}</option>`).join("")}</select></label>
      <div class="sheet-foot"><button class="btn primary" type="submit" id="hbSave">Save</button>${id ? `<button type="button" class="btn" data-act="habit-archive">${h.archived ? "Restore" : "Archive"}</button><button type="button" class="btn danger" data-act="habit-delete">${ICON.trash}Delete</button>` : ""}</div></form>`;
  });
}
function openGoal(id, parentId) {
  editId = id || null; goalUpdates = [];
  if (id) run(sb.from("goal_updates").select("*").eq("goal_id", id).order("created_at", { ascending: false }).limit(30)).then(r => { if (r.data && editId === id) { goalUpdates = r.data; rerenderSheet(); } });
  openSheet(sh => {
    const g = id ? state.goals.find(x => x.id === id) : { title: "", description: "", horizon: parentId ? childHorizon(parentId) : "yearly", category: "personal", target_value: null, current_value: null, unit: "", start_date: null, due_date: null, status: "active", parent_id: parentId || null };
    if (!g) { closeSheet(); return; }
    const kids = id ? state.goals.filter(x => x.parent_id === id) : [];
    const p = goalProgress(g);
    sh.innerHTML = sheetHead(id ? "Goal" : "New goal", "Private to you") + `<form id="goalForm" class="sh-body" novalidate>
      <input class="title-input" id="gl-title" value="${esc(g.title)}" placeholder="e.g. Grow Burgery to 2 outlets, Lose 8 kg, Clear CILT Level 5" maxlength="200" ${id ? "" : "autofocus"}>
      <div class="grid3"><label class="field"><span>Horizon</span><select class="input" id="gl-h">${Object.entries(HORIZON).map(([k, l]) => `<option value="${k}" ${g.horizon === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="field"><span>Category</span><select class="input" id="gl-cat">${Object.entries(GOAL_CAT).map(([k, l]) => `<option value="${k}" ${g.category === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="field"><span>Part of</span><select class="input" id="gl-parent"><option value="">— top level —</option>${state.goals.filter(x => x.id !== id && x.status !== "dropped").map(x => `<option value="${x.id}" ${x.id === g.parent_id ? "selected" : ""}>${esc(x.title)}</option>`).join("")}</select></label></div>
      <div class="grid3"><label class="field"><span>Target <small>(optional)</small></span><input class="input" type="number" step="any" id="gl-target" value="${g.target_value ?? ""}"></label>
      <label class="field"><span>Current</span><input class="input" type="number" step="any" id="gl-current" value="${g.current_value ?? ""}"></label>
      <label class="field"><span>Unit</span><input class="input" id="gl-unit" value="${esc(g.unit || "")}" placeholder="kg, QAR, outlets…"></label></div>
      <div class="grid3"><label class="field"><span>Start</span><input class="input" type="date" id="gl-start" value="${g.start_date || ""}"></label>
      <label class="field"><span>Target date</span><input class="input" type="date" id="gl-due" value="${g.due_date || ""}"></label>
      <label class="field"><span>Status</span><select class="input" id="gl-status">${[["active", "Active"], ["achieved", "Achieved"], ["dropped", "Dropped"]].map(([k, l]) => `<option value="${k}" ${g.status === k ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
      <label class="field"><span>Why it matters / notes</span><textarea class="input" id="gl-desc" rows="3">${esc(g.description || "")}</textarea></label>
      <div class="sheet-foot"><button class="btn primary" type="submit" id="glSave">Save</button>${id ? `<button type="button" class="btn danger" data-act="goal-delete">${ICON.trash}Delete</button>` : ""}</div>
    </form>
    ${id ? `<div class="sh-body">
      ${p !== null ? `<div class="bar big"><i style="width:${p}%"></i></div><p class="hint">${p}% of target</p>` : ""}
      <section class="sub"><div class="sub-h"><h3>Objectives</h3><span class="c">${kids.length}</span></div>
        ${kids.map(k => `<div class="krow"><span class="kico">${k.status === "achieved" ? ICON.check : "○"}</span><button class="linkbtn" data-act="goal-edit" data-id="${k.id}">${esc(k.title)}</button><small>${HORIZON[k.horizon]}${goalProgress(k) !== null ? " · " + goalProgress(k) + "%" : ""}</small></div>`).join("") || `<p class="hint">Break this into smaller objectives.</p>`}
        <button class="btn sm" data-act="goal-new" data-parent="${id}">${ICON.plus}Add objective</button></section>
      <section class="sub"><div class="sub-h"><h3>Progress updates</h3></div>
        <form id="goalUpdateForm" class="addrow"><input class="input" type="number" step="any" id="gu-value" placeholder="New value" style="max-width:8em"><input class="input" id="gu-note" placeholder="What changed?"><button class="btn sm" type="submit">Add</button></form>
        ${goalUpdates.map(u => `<div class="krow"><small>${ago(u.created_at)}</small><span>${u.value !== null ? `<b>${fmtNum(u.value)} ${esc(g.unit || "")}</b> ` : ""}${esc(u.note || "")}</span></div>`).join("")}
      </section></div>` : ""}`;
  }, { wide: !!id });
}
const childHorizon = pid => { const order = Object.keys(HORIZON); const p = state.goals.find(g => g.id === pid); return p ? order[Math.min(order.length - 1, order.indexOf(p.horizon) + 1)] : "yearly"; };
function openHealth() {
  openSheet(sh => {
    sh.innerHTML = sheetHead("Log health entry", "Private to you · optional") + `<form id="healthForm" class="sh-body" novalidate>
      <div class="grid2"><label class="field"><span>Type</span><select class="input" id="hl-kind">${Object.entries(HEALTH_KIND).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
      <label class="field"><span>Date</span><input class="input" type="date" id="hl-date" value="${todayISO(state.tz)}" max="${addDays(todayISO(state.tz), 1)}"></label></div>
      <div class="grid3"><label class="field"><span>Value</span><input class="input" type="number" step="any" id="hl-value" placeholder="e.g. 82.4 or 5.2"></label>
      <label class="field"><span>Unit</span><input class="input" id="hl-unit" value="kg"></label>
      <label class="field"><span>Minutes</span><input class="input" type="number" min="0" max="1440" id="hl-min"></label></div>
      <label class="field"><span>Note</span><input class="input" id="hl-note" placeholder="e.g. Leg day, felt strong"></label>
      <div class="sheet-foot"><button class="btn primary block" type="submit" id="hlSave">Save</button></div></form>`;
  });
}

/* ---------- events ---------- */
export async function toggleHabit(id, date) {
  const today = todayISO(state.tz);
  if (date > today) return toastError("Future days can't be ticked yet.");
  const has = state.habitLogs.find(l => l.habit_id === id && l.log_date === date);
  if (has) {
    state.habitLogs = state.habitLogs.filter(l => l !== has);
    const r = await run(sb.from("habit_logs").delete().eq("habit_id", id).eq("log_date", date));
    if (r.error) { state.habitLogs.push(has); toastError(r.error); }
  } else {
    const row = { habit_id: id, log_date: date };
    state.habitLogs.push(row);
    const r = await run(sb.from("habit_logs").insert(row));
    if (r.error) { state.habitLogs = state.habitLogs.filter(l => l !== row); toastError(r.error); }
  }
}
export async function handleGoalsClick(act, el, rerender) {
  switch (act) {
    case "habit-toggle": el.classList.toggle("on"); await toggleHabit(el.dataset.id, el.dataset.date); rerender(); return true;
    case "habit-new": openHabit(); return true;
    case "habit-edit": openHabit(el.dataset.id); return true;
    case "goal-new": openGoal(null, el.dataset.parent || null); return true;
    case "goal-edit": openGoal(el.dataset.id); return true;
    case "health-new": openHealth(); return true;
    case "habit-archive": {
      const h = state.habits.find(x => x.id === editId); const r = await run(sb.from("habits").update({ archived: !h.archived }).eq("id", h.id));
      if (r.error) return toastError(r.error), true; h.archived = !h.archived; closeSheet(); rerender(); toast(h.archived ? "Habit archived — history kept" : "Habit restored"); return true;
    }
    case "habit-delete": {
      const h = state.habits.find(x => x.id === editId);
      if (!(await dialog({ title: `Delete "${h.title}"?`, text: "This also deletes its check-in history. Archive it instead to keep the history.", confirm: "Delete", danger: true }))) return true;
      const r = await run(sb.from("habits").delete().eq("id", h.id)); if (r.error) return toastError(r.error), true;
      state.habits = state.habits.filter(x => x.id !== h.id); state.habitLogs = state.habitLogs.filter(l => l.habit_id !== h.id); closeSheet(); rerender(); return true;
    }
    case "goal-delete": {
      const g = state.goals.find(x => x.id === editId), kids = state.goals.filter(x => x.parent_id === g.id).length;
      if (!(await dialog({ title: `Delete "${g.title}"?`, text: kids ? `Its ${kids} objective(s) are deleted too. Consider marking it Dropped instead.` : "Consider marking it Dropped instead to keep the record.", confirm: "Delete", danger: true }))) return true;
      const r = await run(sb.from("goals").delete().eq("id", g.id)); if (r.error) return toastError(r.error), true;
      const gone = new Set([g.id]); let grew = true; while (grew) { grew = false; for (const x of state.goals) if (x.parent_id && gone.has(x.parent_id) && !gone.has(x.id)) { gone.add(x.id); grew = true; } }
      state.goals = state.goals.filter(x => !gone.has(x.id)); closeSheet(); rerender(); return true;
    }
    case "health-delete": {
      if (!(await dialog({ title: "Delete this entry?", confirm: "Delete", danger: true }))) return true;
      const r = await run(sb.from("health_logs").delete().eq("id", el.dataset.id)); if (r.error) return toastError(r.error), true;
      state.healthLogs = state.healthLogs.filter(l => l.id !== el.dataset.id); rerender(); return true;
    }
  }
  return false;
}
export function handleGoalsChange(e, rerender) {
  if (e.target.id === "hb-sched") { $("hb-days-wrap").hidden = e.target.value !== "days"; $("hb-pw-wrap").hidden = e.target.value !== "weekly"; return true; }
  if (e.target.id === "goal-status") { state.ui.goalStatus = e.target.value; rerender(); return true; }
  if (e.target.id === "hl-kind") { $("hl-unit").value = { weight: "kg", walk: "km", workout: "", wellness: "" }[e.target.value]; return true; }
  return false;
}
export async function handleGoalsSubmit(form, rerender) {
  if (form.id === "habitForm") {
    const sched = val("hb-sched"), days = [...document.querySelectorAll('input[name="hb-day"]:checked')].map(i => +i.value);
    const row = { title: val("hb-title"), category: val("hb-cat"), schedule: sched, days: sched === "days" ? days : [0, 1, 2, 3, 4, 5, 6], per_week: Math.min(7, Math.max(1, num("hb-pw") || 1)), goal_id: val("hb-goal") || null };
    if (!row.title) return toastError("Name the habit."), true;
    if (sched === "days" && !days.length) return toastError("Pick at least one day."), true;
    const btn = $("hbSave"); busy(btn, true);
    const r = editId ? await run(sb.from("habits").update(row).eq("id", editId).select().single()) : await run(sb.from("habits").insert({ ...row, sort: state.habits.length }).select().single());
    busy(btn, false); if (r.error) return toastError(r.error), true;
    if (editId) Object.assign(state.habits.find(x => x.id === editId), r.data); else state.habits.push(r.data);
    closeSheet(); rerender(); toast("Habit saved"); return true;
  }
  if (form.id === "goalForm") {
    const status = val("gl-status"), old = editId && state.goals.find(x => x.id === editId);
    const row = { title: val("gl-title"), horizon: val("gl-h"), category: val("gl-cat"), parent_id: val("gl-parent") || null, target_value: num("gl-target"), current_value: num("gl-current"), unit: val("gl-unit") || null,
      start_date: val("gl-start") || null, due_date: val("gl-due") || null, status, description: val("gl-desc") || null };
    if (!row.title) return toastError("Name the goal."), true;
    if (row.start_date && row.due_date && row.due_date < row.start_date) return toastError("The target date is before the start date."), true;
    if (status === "achieved" && (!old || old.status !== "achieved")) row.achieved_at = new Date().toISOString();
    if (status !== "achieved") row.achieved_at = null;
    const btn = $("glSave"); busy(btn, true);
    const r = editId ? await run(sb.from("goals").update(row).eq("id", editId).select().single()) : await run(sb.from("goals").insert(row).select().single());
    busy(btn, false); if (r.error) return toastError(r.error), true;
    if (editId) Object.assign(old, r.data); else { state.goals.push(r.data); editId = r.data.id; }
    rerenderSheet(); rerender(); toast("Goal saved"); return true;
  }
  if (form.id === "goalUpdateForm") {
    const value = num("gu-value"), note = val("gu-note");
    if (value === null && !note) return toastError("Enter a value or a note."), true;
    const r = await run(sb.from("goal_updates").insert({ goal_id: editId, value, note: note || null }).select().single());
    if (r.error) return toastError(r.error), true;
    goalUpdates.unshift(r.data);
    if (value !== null) { const g = state.goals.find(x => x.id === editId); const u = await run(sb.from("goals").update({ current_value: value }).eq("id", g.id)); if (!u.error) g.current_value = value; }
    rerenderSheet(); rerender(); return true;
  }
  if (form.id === "healthForm") {
    const row = { kind: val("hl-kind"), log_date: val("hl-date"), value: num("hl-value"), unit: val("hl-unit") || null, duration_min: num("hl-min"), note: val("hl-note") || null };
    if (row.kind !== "wellness" && row.value === null && row.duration_min === null) return toastError("Enter a value or minutes."), true;
    if (row.kind === "wellness" && !row.note) return toastError("Write a short note."), true;
    const btn = $("hlSave"); busy(btn, true);
    const r = await run(sb.from("health_logs").insert(row).select().single()); busy(btn, false);
    if (r.error) return toastError(r.error), true;
    state.healthLogs.unshift(r.data); closeSheet(); rerender(); toast("Logged"); return true;
  }
  return false;
}
