// Quick to-do: a private sticky note for small daily items, outside projects.
// Items stay open (and keep showing) until ticked off; each shows the day it was added.
import { esc, fmtDate, todayISO, zonedDate, daysFromToday } from "../util.js";
import { state, emit } from "../store.js";
import { ICON, toast, toastError, dialog } from "../ui.js";
import { sb, run } from "../api.js";

export async function loadQuickTodos() {
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const r = await sb.from("quick_todos").select("*").or(`done_at.is.null,done_at.gte.${since}`).order("created_at").limit(500);
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
const upsertLocal = row => { const i = state.quick.findIndex(x => x.id === row.id); if (i >= 0) state.quick[i] = row; else state.quick.push(row); emit("data"); };

export async function handleQuickSubmit(form) {
  if (form.dataset.form !== "qt-add") return false;
  const text = form.elements.text.value.trim(); if (!text) return true;
  const r = await run(sb.from("quick_todos").insert({ text, user_id: state.user.id }).select().single());
  if (r.error) { toastError(r.error); return true; }
  upsertLocal(r.data);
  setTimeout(() => { const i = document.querySelector('[data-form="qt-add"] input'); if (i) i.focus(); }, 30);
  return true;
}
export async function handleQuickClick(act, el) {
  if (!act.startsWith("qt-")) return false;
  const id = el.dataset.id, t = (state.quick || []).find(x => x.id === id);
  if (act === "qt-showdone") { state.ui.qtShowDone = !state.ui.qtShowDone; emit("data"); return true; }
  if (!t) return true;
  if (act === "qt-toggle") {
    const r = await run(sb.from("quick_todos").update({ done_at: t.done_at ? null : new Date().toISOString() }).eq("id", id).select().single());
    if (r.error) toastError(r.error); else { upsertLocal(r.data); if (r.data.done_at) toast("Done"); }
  }
  if (act === "qt-edit") {
    const v = await dialog({ title: "Edit to-do", input: { label: "To-do", value: t.text, required: true }, confirm: "Save" });
    if (v && v.trim() && v.trim() !== t.text) { const r = await run(sb.from("quick_todos").update({ text: v.trim() }).eq("id", id).select().single()); if (r.error) toastError(r.error); else upsertLocal(r.data); }
  }
  if (act === "qt-del") {
    if (!await dialog({ title: "Delete this to-do?", text: `"${t.text}" — this can't be undone.`, confirm: "Delete", danger: true })) return true;
    const r = await run(sb.from("quick_todos").delete().eq("id", id));
    if (r.error) toastError(r.error); else { state.quick = state.quick.filter(x => x.id !== id); emit("data"); }
  }
  return true;
}
