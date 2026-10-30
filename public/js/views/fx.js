// Month-end revaluation of open foreign-currency invoices and bills. The person enters each closing rate; nothing is assumed.
// Posting creates an unrealised gain/loss entry at the date and its automatic reversal the next day.
import { esc, todayISO, fmtDate, addDays } from "../util.js";
import { state } from "../store.js";
import { sb, run } from "../api.js";
import { $, openSheet, rerenderSheet, sheetHead, toast, toastError, dialog, busy } from "../ui.js";
import { money, r2, monthStart, revalueGain } from "../finance.js";
import { fin, loadFin, entityById, canWriteFin } from "../finapi.js";

let fx = null; // {eid, date, items|null, error, rates:{}}
const lastMonthEnd = () => addDays(monthStart(todayISO(state.tz)), -1);
async function loadItems() {
  fx.items = null; fx.error = null; rerenderSheet();
  const r = await run(sb.rpc("fin_fx_open_items", { p_entity: fx.eid, p_date: fx.date }));
  if (!fx) return;
  if (r.error) fx.error = r.error; else fx.items = r.data || [];
  rerenderSheet();
}
export function openRevaluation(eid) {
  fx = { eid, date: lastMonthEnd(), items: null, error: null, rates: {} };
  openSheet(render, { wide: true }); loadItems();
}
function rows() {
  return (fx.items || []).map(x => { const rate = Number(fx.rates[x.currency]); const g = rate > 0 ? revalueGain(x.kind, Number(x.outstanding), Number(x.booked_rate), rate) : null; return { x, rate, g }; });
}
function render(sh) {
  const e = entityById(fx.eid), w = canWriteFin(e.id), rs = rows(), ccys = [...new Set((fx.items || []).map(x => x.currency))];
  const net = r2(rs.reduce((s, r) => s + (r.g ? r.g.gain : 0), 0)), ready = rs.length && rs.every(r => r.g);
  const past = fin.fxRevals.filter(v => v.entity_id === e.id);
  sh.innerHTML = sheetHead("Revalue foreign currency", `${e.name} · unrealised gains and losses, reversed the next day`) + `<form id="fxForm" class="sh-body" novalidate>
    <label class="field"><span>Revalue as at</span><input class="input" type="date" id="fx-date" value="${fx.date}"></label>
    ${fx.error ? `<p class="bad-text">${esc(fx.error.message || String(fx.error))}</p>` : fx.items === null ? `<p class="hint">Finding open items…</p>` : !rs.length ? `<p class="calm">No foreign-currency invoices or bills were open on ${fmtDate(fx.date)}.</p>` : `
    <div class="grid3">${ccys.map(c => `<label class="field"><span>Closing rate: 1 ${c} = ? ${e.base_currency}</span><input class="input num" type="number" step="0.00000001" min="0" data-fxrate="${c}" value="${fx.rates[c] || ""}"></label>`).join("")}</div>
    <div class="tablewrap"><table class="rtable" id="fxTable"><thead><tr><th>Document</th><th class="num">Open</th><th class="num">Booked</th><th class="num">At closing rate</th><th class="num">Gain / loss</th></tr></thead><tbody>
      ${rs.map(({ x, g }) => `<tr><td><b>${esc(x.number)}</b> <small class="hint">${x.kind === "sale" ? "invoice" : "bill"} · ${Number(x.booked_rate)}</small></td><td class="num">${money(x.outstanding, x.currency)}</td>
        <td class="num">${money(r2(x.outstanding * x.booked_rate), e.base_currency)}</td><td class="num">${g ? money(g.now, e.base_currency) : "—"}</td>
        <td class="num ${g && g.gain < 0 ? "bad-text" : g && g.gain > 0 ? "ok-text" : ""}">${g ? money(g.gain, e.base_currency) : "—"}</td></tr>`).join("")}
      <tr class="total"><td colspan="4">Net unrealised ${net < 0 ? "loss" : "gain"}</td><td class="num" id="fx-net">${ready ? money(net, e.base_currency) : "enter every rate"}</td></tr></tbody></table></div>
    <p class="hint">Posts one entry on ${fmtDate(fx.date)} to the receivable/payable accounts and "Exchange gains and losses", and its reversal on ${fmtDate(addDays(fx.date, 1))}, so the documents keep their original rate until they're paid.</p>
    ${w ? `<div class="sheet-foot"><button class="btn primary block" type="submit" id="fxPost" ${ready ? "" : "disabled"}>Post revaluation</button></div>` : ""}`}
    ${past.length ? `<h3>Earlier revaluations</h3><div class="tablewrap"><table class="rtable"><thead><tr><th>Date</th><th>Rates</th><th class="num">Net</th><th></th></tr></thead><tbody>
      ${past.map(v => `<tr class="${v.status === "cancelled" ? "muted" : ""}"><td>${fmtDate(v.rev_date)}</td><td>${Object.entries(v.rates || {}).map(([c, r]) => `${c} ${r}`).join(", ")}</td><td class="num">${money(v.net, e.base_currency)}</td>
        <td>${v.status === "cancelled" ? `<span class="pill inv-void">Cancelled</span> <small class="hint">${esc(v.cancel_reason || "")}</small>` : w ? `<button type="button" class="btn sm" data-act="fx-cancel" data-id="${v.id}">Cancel…</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : ""}
  </form>`;
}

export async function handleFxClick(act, el) {
  if (act === "fx-reval") { openRevaluation(state.route.a); return true; }
  if (act === "fx-cancel") {
    const v = fin.fxRevals.find(x => x.id === el.dataset.id);
    const reason = await dialog({ title: `Cancel the ${fmtDate(v.rev_date)} revaluation?`, text: "Posts the opposite of the revaluation and of its reversal. The originals stay on record.", input: { label: "Reason", required: true, min: 3 }, confirm: "Cancel revaluation", danger: true });
    if (!reason) return true;
    const r = await run(sb.rpc("fin_fx_revaluation_cancel", { p_id: v.id, p_reason: reason })); if (r.error) return toastError(r.error), true;
    await loadFin(true); if (fx) rerenderSheet(); toast("Revaluation cancelled"); return true;
  }
  return false;
}
export function handleFxChange(ev) {
  const t = ev.target;
  if (!fx) return false;
  if (t.id === "fx-date") { fx.date = t.value || lastMonthEnd(); loadItems(); return true; }
  if (t.dataset && t.dataset.fxrate !== undefined) { fx.rates[t.dataset.fxrate] = t.value; rerenderSheet(); return true; }
  return false;
}
export async function handleFxSubmit(form) {
  if (form.id !== "fxForm" || !fx) return false;
  const rates = {}; for (const c of new Set((fx.items || []).map(x => x.currency))) { const v = Number(fx.rates[c]); if (!(v > 0)) return toastError(`Enter the closing rate for ${c}.`), true; rates[c] = v; }
  const net = r2(rows().reduce((s, r) => s + r.g.gain, 0)), e = entityById(fx.eid);
  if (!(await dialog({ title: `Post revaluation at ${fmtDate(fx.date)}?`, text: `Net unrealised ${net < 0 ? "loss" : "gain"} of ${money(Math.abs(net), e.base_currency)}, reversed on ${fmtDate(addDays(fx.date, 1))}.`, confirm: "Post" }))) return true;
  const btn = $("fxPost"); busy(btn, true);
  const r = await run(sb.rpc("fin_fx_revalue", { p_entity: fx.eid, p_date: fx.date, p_rates: rates })); busy(btn, false);
  if (r.error) return toastError(r.error), true;
  await loadFin(true); fx.rates = {}; await loadItems(); toast("Revaluation posted"); return true;
}
