// Quick to-do: a private sticky note for small daily items, outside projects.
// Items stay open (and keep showing) until ticked off; each shows the day it was added.
import { esc, fmtDate, todayISO, zonedDate, daysFromToday } from "../util.js";
import { state, emit } from "../store.js";
import { ICON, toast, toastError, dialog, openSheet, sheetHead, closeSheet, busy } from "../ui.js";
import { sb, run } from "../api.js";

export async function loadQuickTodos() {
  const r = await sb.from("quick_todos").select("*").order("created_at").limit(5000);
  state.quick = r.error ? [] : (r.data || []);
}

function added(t) {
  const d = zonedDate(t.created_at, state.tz), n = daysFromToday(d, state.tz);
  if (n === 0) return `<span class="faint">Added today</span>`;
  if (n === -1) return `<span class="warn-text">Added yesterday</span>`;
  return `<span class="bad-text">Added ${fmtDate(d, { day: "numeric", month: "short" })} · ${-n} days open</span>`;
}

export function quickTodoCard() {
  const all = state.quick || [], today = todayISO(state.tz);
  const open = all.filter(t => !t.done_at).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const doneToday = all.filter(t => t.done_at && zonedDate(t.done_at, state.tz) === today).sort((a, b) => b.done_at.localeCompare(a.done_at));
  const showDone = state.ui.qtShowDone;
  return `<section class="qt" aria-label="Quick to-do">
    <div class="qt-h"><h2>Quick to-do</h2><span class="qt-n">${open.length ? `${open.length} open` : "All clear"}${doneToday.length ? ` · ${doneToday.length} done today` : ""}</span></div>
    <form class="qt-add" data-form="qt-add"><input class="input" name="text" maxlength="500" placeholder="Add something to do today…" autocomplete="off"><button class="btn sm primary">${ICON.plus}Add</button></form>
    <ul class="qt-list">
      ${open.map(t => `<li class="qt-i">
        <button class="sw-check" data-act="qt-toggle" data-id="${t.id}" aria-label="Mark done"></button>
        <div class="qt-t" data-act="qt-edit" data-id="${t.id}" role="button" tabindex="0"><span>${esc(t.text)}</span><small>${added(t)}</small></div>
        <button class="iconbtn sm sw-del" data-act="qt-del" data-id="${t.id}" aria-label="Delete">${ICON.trash}</button></li>`).join("")}
      ${!open.length ? `<li class="qt-empty">Nothing pending. Add quick things here instead of making a project task.</li>` : ""}
    </ul>
    ${doneToday.length ? `<button class="linkbtn qt-more" data-act="qt-showdone">${showDone ? "Hide" : "Show"} done today (${doneToday.length})</button>
      ${showDone ? `<ul class="qt-list done">${doneToday.map(t => `<li class="qt-i done"><button class="sw-check on" data-act="qt-toggle" data-id="${t.id}" aria-label="Mark not done">${ICON.check}</button>
        <div class="qt-t"><span>${esc(t.text)}</span><small class="faint">Added ${fmtDate(zonedDate(t.created_at, state.tz), { day: "numeric", month: "short" })} · done ${fmtTime(t.done_at)}</small></div></li>`).join("")}</ul>` : ""}` : ""}
  </section>`;
}

const fmtTime = iso => new Intl.DateTimeFormat("en-GB", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: state.tz }).format(new Date(iso));
const splitItems = v => String(v || "").split("\n").map(x => x.replace(/^\s*(?:\d+[.)]|[-•*])\s*/, "").trim()).filter(Boolean).slice(0, 100);
const upsertLocal = row => { const i = state.quick.findIndex(x => x.id === row.id); if (i >= 0) state.quick[i] = row; else state.quick.push(row); emit("data"); };

export async function handleQuickSubmit(form) {
  if (form.dataset.form !== "qt-add") return false;
  const text = form.elements.text.value.trim(); if (!text) return true;
  const note = form.elements.note ? form.elements.note.value.trim() || null : null;
  const items = form.elements.items ? splitItems(form.elements.items.value).map(x => ({ text: x, done: false })) : [];
  const critical = !!(form.elements.critical && form.elements.critical.checked);
  const r = await run(sb.from("quick_todos").insert({ text, note, items, critical, user_id: state.user.id }).select().single());
  if (r.error) { toastError(r.error); return true; }
  upsertLocal(r.data);
  setTimeout(() => { const i = document.querySelector('[data-form="qt-add"] input'); if (i) i.focus(); }, 30);
  return true;
}
export async function handleQuickClick(act, el) {
  if (!act.startsWith("qt-")) return false;
  const id = el.dataset.id, t = (state.quick || []).find(x => x.id === id);
  if (act === "qt-details") { state.ui.qtDetails = !state.ui.qtDetails; emit("data"); setTimeout(() => { const n = document.querySelector('[data-form="qt-add"] [name=note]'); if (n) n.focus(); }, 30); return true; }
  if (act === "qt-showdone") { state.ui.qtShowDone = !state.ui.qtShowDone; emit("data"); return true; }
  if (act === "qt-day-clear") { state.ui.todoDay = null; emit("data"); return true; }
  if (act === "qt-more-days") { state.ui.todoSpan = (state.ui.todoSpan || 14) + 30; emit("data"); return true; }
  if (!t) return true;
  if (act === "qt-toggle") {
    const r = await run(sb.from("quick_todos").update({ done_at: t.done_at ? null : new Date().toISOString() }).eq("id", id).select().single());
    if (r.error) toastError(r.error); else { upsertLocal(r.data); if (r.data.done_at) toast("Done"); }
  }
  if (act === "qt-edit") editSheet(t);
  if (act === "qt-crit") {
    const r = await run(sb.from("quick_todos").update({ critical: !t.critical }).eq("id", id).select().single());
    if (r.error) toastError(r.error); else { upsertLocal(r.data); toast(r.data.critical ? "Marked critical" : "No longer critical"); }
  }
  if (act === "qt-sub") {
    const items = (Array.isArray(t.items) ? t.items : []).map((x, i) => i === Number(el.dataset.i) ? { ...x, done: !x.done } : x);
    const r = await run(sb.from("quick_todos").update({ items }).eq("id", id).select().single());
    if (r.error) toastError(r.error); else { upsertLocal(r.data); if (!t.done_at && items.length && items.every(x => x.done)) toast("All sub-items done — tick the to-do when you're ready"); }
  }
  if (act === "qt-del") {
    if (!await dialog({ title: "Delete this to-do?", text: `"${t.text}" — this can't be undone.`, confirm: "Delete", danger: true })) return true;
    const r = await run(sb.from("quick_todos").delete().eq("id", id));
    if (r.error) toastError(r.error); else { state.quick = state.quick.filter(x => x.id !== id); emit("data"); }
  }
  return true;
}

/* ---------------- To-do tab: pending now + date-wise diary ---------------- */
const dayOf = iso => zonedDate(iso, state.tz);
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayTitle = (d, today) => d === today ? "Today" : d === addDays(today, -1) ? "Yesterday" : fmtDate(d, { weekday: "long", day: "numeric", month: "long", year: d.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric" });

const FLAG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/></svg>';
export const letter = i => i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(65 + Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26));
function details(t) {
  const items = Array.isArray(t.items) ? t.items : [];
  return `${t.note ? `<p class="qt-note">${esc(t.note)}</p>` : ""}${items.length ? `<ul class="qt-sub">${items.map((x, i) => `<li class="${x.done ? "on" : ""}"><b class="qt-letter">${letter(i)}.</b><button class="qt-subc ${x.done ? "on" : ""}" data-act="qt-sub" data-id="${t.id}" data-i="${i}" aria-label="${x.done ? "Mark not done" : "Mark done"}">${x.done ? ICON.check : ""}</button><span>${esc(x.text)}</span></li>`).join("")}</ul>` : ""}`;
}
export const critFirst = (a, b) => (b.critical ? 1 : 0) - (a.critical ? 1 : 0) || a.created_at.localeCompare(b.created_at);
const subCount = t => { const it = Array.isArray(t.items) ? t.items : []; if (!it.length) return ""; const d = it.filter(x => x.done).length; return ` · <span class="${d === it.length ? "ok-text" : "faint"}">${d}/${it.length} sub-items</span>`; };
function itemRow(t, today, { showAdded = true, compact = false, num = null } = {}) {
  const done = !!t.done_at, ad = dayOf(t.created_at), dd = done ? dayOf(t.done_at) : null;
  const meta = done
    ? `<span class="ok-text">Done ${dd === ad ? "same day" : fmtDate(dd, { day: "numeric", month: "short" })} · ${fmtTime(t.done_at)}</span>${showAdded && dd !== ad ? ` <span class="faint">· added ${fmtDate(ad, { day: "numeric", month: "short" })}</span>` : ""}`
    : (() => { const n = -daysFromToday(ad, state.tz); return n <= 0 ? `<span class="faint">Pending · added today</span>` : `<span class="${n === 1 ? "warn-text" : "bad-text"}">Pending · added ${n === 1 ? "yesterday" : fmtDate(ad, { day: "numeric", month: "short" }) + ` · ${n} days`}</span>`; })();
  return `<li class="qt-i ${done ? "done" : ""} ${t.critical && !done ? "crit" : ""}">
    <button class="sw-check ${done ? "on" : ""}" data-act="qt-toggle" data-id="${t.id}" aria-label="${done ? "Mark not done" : "Mark done"}">${done ? ICON.check : ""}</button>
    ${num !== null ? `<b class="qt-num">${num}.</b>` : ""}<div class="qt-t"><span data-act="qt-edit" data-id="${t.id}" role="button" tabindex="0">${t.critical && !done ? `<em class="qt-crit">Critical</em> ` : ""}${esc(t.text)}</span><small>${meta}${subCount(t)}</small>${compact ? "" : details(t)}</div>
    ${done ? "" : `<button class="iconbtn sm qt-flag ${t.critical ? "on" : ""}" data-act="qt-crit" data-id="${t.id}" aria-label="${t.critical ? "Remove critical" : "Mark critical"}" title="${t.critical ? "Remove critical" : "Mark critical"}">${FLAG}</button>`}
    <button class="iconbtn sm sw-del" data-act="qt-del" data-id="${t.id}" aria-label="Delete">${ICON.trash}</button></li>`;
}

export function renderTodo(view) {
  const all = state.quick || [], today = todayISO(state.tz), yday = addDays(today, -1);
  const open = all.filter(t => !t.done_at).sort(critFirst);
  const fromY = open.filter(t => dayOf(t.created_at) === yday), older = open.filter(t => dayOf(t.created_at) < yday), todays = open.filter(t => dayOf(t.created_at) >= today);
  const doneToday = all.filter(t => t.done_at && dayOf(t.done_at) === today);
  // diary: every date something was added or completed
  const jump = state.ui.todoDay || null, span = state.ui.todoSpan || 14;
  const dates = [...new Set(all.flatMap(t => [dayOf(t.created_at), t.done_at ? dayOf(t.done_at) : null]).filter(Boolean))].sort().reverse();
  const shown = jump ? [jump] : dates.filter(d => d > addDays(today, -span));
  const olderLeft = !jump && dates.some(d => d <= addDays(today, -span));
  let n = 0; // one running number across the pending groups: 1, 2, 3…
  const group = (title, items, cls = "") => items.length ? `<div class="td-g ${cls}"><h3>${title} <span class="c">${items.length}</span></h3><ul class="qt-list">${items.map(t => itemRow(t, today, { num: ++n })).join("")}</ul></div>` : "";
  view.innerHTML = `<div class="sw td">
    <div class="sw-head"><div><h1>To-do</h1><p class="sub">${fmtDate(today, { weekday: "long", day: "numeric", month: "long" })} · your private daily list</p></div>
      <div class="sw-actions"><a class="btn" href="#/board" target="_blank" rel="noopener" title="Open the whiteboard in a new window for your other screen">${ICON.grid || ICON.tasks}Whiteboard</a></div></div>
    <div class="sw-kpis td-k">
      <div class="sw-kpi"><b class="num">${open.length}</b><span>Pending now</span></div>
      <div class="sw-kpi ${fromY.length + older.length ? "bad" : ""}"><b class="num">${fromY.length + older.length}</b><span>Carried over</span></div>
      <div class="sw-kpi"><b class="num">${todays.length}</b><span>Added today, open</span></div>
      <div class="sw-kpi ok"><b class="num">${doneToday.length}</b><span>Done today</span></div>
    </div>
    <section class="qt td-now">
      <form class="qt-addf" data-form="qt-add">
        <div class="qt-add"><input class="input" name="text" maxlength="500" placeholder="Add something to do today…" autocomplete="off"><button class="btn sm primary">${ICON.plus}Add</button></div>
        ${state.ui.qtDetails ? `<div class="qt-more-f"><textarea class="input" name="note" rows="2" maxlength="4000" placeholder="Description (optional)"></textarea>
          <textarea class="input" name="items" rows="3" placeholder="Sub-items (optional) — one per line, e.g.&#10;DSV - materials disposal&#10;Adnov - KSA warehouse&#10;QBH"></textarea></div>` : ""}
        <div class="qt-addopts"><label class="qt-critc"><input type="checkbox" name="critical"> Critical</label>
        <button type="button" class="linkbtn qt-toggle-d" data-act="qt-details">${state.ui.qtDetails ? "− Hide description & sub-items" : "+ Description / sub-items (optional)"}</button></div>
      </form>
      ${open.length ? group("Pending from yesterday", fromY, "y") + group("Older, still pending", older, "o") + group("Today", todays) : `<p class="qt-empty">Nothing pending. 🎉</p>`}
    </section>
    <section class="sw-sect">
      <div class="sw-sect-h"><h2>Diary</h2><span class="td-jump"><input class="input sm" type="date" id="td-day" max="${today}" value="${jump || ""}" aria-label="Go to date">${jump ? `<button class="linkbtn" data-act="qt-day-clear">Show all days</button>` : ""}</span></div>
      ${shown.length ? shown.map(d => {
        const addedAll = all.filter(t => dayOf(t.created_at) === d).sort((a, b) => a.created_at.localeCompare(b.created_at));
        // today's pending items are already in the list above, so the diary only logs what got done today
        const addedD = d === today ? addedAll.filter(t => t.done_at) : addedAll;
        const doneD = all.filter(t => t.done_at && dayOf(t.done_at) === d && dayOf(t.created_at) !== d).sort((a, b) => a.done_at.localeCompare(b.done_at));
        const stillOpen = addedD.filter(t => !t.done_at).length, doneCount = all.filter(t => t.done_at && dayOf(t.done_at) === d).length;
        return `<div class="td-day">
          <div class="td-day-h"><h3>${dayTitle(d, today)}${d === today || d === yday ? ` <small class="faint">${fmtDate(d, { day: "numeric", month: "short" })}</small>` : ""}</h3>
            <span class="td-sum">${addedAll.length ? `${addedAll.length} added` : ""}${doneCount ? `${addedAll.length ? " · " : ""}<span class="ok-text">${doneCount} done</span>` : ""}${stillOpen ? ` · <span class="bad-text">${stillOpen} still pending</span>` : ""}</span></div>
          ${addedD.length ? `<ul class="qt-list">${addedD.map(t => itemRow(t, today, { showAdded: false, compact: true })).join("")}</ul>` : ""}
          ${doneD.length ? `<p class="td-sub">Finished this day (added earlier)</p><ul class="qt-list">${doneD.map(t => itemRow(t, today, { compact: true })).join("")}</ul>` : ""}
          ${d === today && !addedD.length && !doneD.length ? `<p class="hint td-none">Nothing finished yet today — pending items are in the list above.</p>` : ""}
        </div>`;
      }).join("") : `<div class="sw-empty">${jump ? "Nothing was added or finished on this day." : "Your diary fills up as you add and finish to-dos."}</div>`}
      ${olderLeft ? `<button class="btn block" data-act="qt-more-days">Show older days</button>` : ""}
    </section>
  </div>`;
}
export function quickTodoSummary() {
  const all = state.quick || [], today = todayISO(state.tz);
  const open = all.filter(t => !t.done_at), carried = open.filter(t => dayOf(t.created_at) < today).length, crit = open.filter(t => t.critical).length;
  return `<a class="td-strip" href="#/todo">${ICON.check}<span><b>${open.length ? `${open.length} to-do${open.length === 1 ? "" : "s"} pending` : "To-do: all clear"}</b>${crit ? ` · <span class="bad-text"><b>${crit} critical</b></span>` : ""}${carried ? ` · <span class="bad-text">${carried} carried over</span>` : ""}</span><span class="faint">Open ›</span></a>`;
}
export async function handleTodoChange(e) {
  if (e.target.id !== "td-day") return false;
  state.ui.todoDay = e.target.value || null; emit("data"); return true;
}

function editSheet(t) {
  const items = Array.isArray(t.items) ? t.items : [];
  openSheet(sh => {
    sh.innerHTML = sheetHead("Edit to-do") + `<form class="sh-body" id="qtEdit">
      <label class="field"><span>To-do</span><input class="input" name="text" value="${esc(t.text)}" maxlength="500" required></label>
      <label class="check qt-critc"><input type="checkbox" name="critical" ${t.critical ? "checked" : ""}> Critical — needs to be done soon</label>
      <label class="field"><span>Description (optional)</span><textarea class="input" name="note" rows="3" maxlength="4000">${esc(t.note || "")}</textarea></label>
      <label class="field"><span>Sub-items (optional, one per line)</span><textarea class="input" name="items" rows="5">${esc(items.map(x => x.text).join("\n"))}</textarea></label>
      <p class="hint">Sub-items you keep stay ticked if they were done.</p>
      <div class="sheet-foot"><button class="btn primary block">Save</button></div></form>`;
    sh.querySelector("#qtEdit").onsubmit = async e => {
      e.preventDefault(); e.stopPropagation();
      const f = e.target, b = f.querySelector(".primary");
      const prev = new Map(items.map(x => [x.text.toLowerCase(), !!x.done]));
      const next = splitItems(f.items.value).map(x => ({ text: x, done: prev.get(x.toLowerCase()) || false }));
      busy(b);
      const r = await run(sb.from("quick_todos").update({ text: f.text.value.trim(), note: f.note.value.trim() || null, items: next, critical: f.critical.checked }).eq("id", t.id).select().single());
      busy(b, false);
      if (r.error) return toastError(r.error);
      upsertLocal(r.data); closeSheet();
    };
  });
}
