// Inter-entity transactions: money moving between your own sets of books, posted in both at once with one IC number.
import { esc, todayISO, fmtDate } from "../util.js";
import { state } from "../store.js";
import { sb, run } from "../api.js";
import { ICON, $, openSheet, closeSheet, rerenderSheet, sheetHead, toast, toastError, dialog, busy, section, emptyState } from "../ui.js";
import { money, ACCOUNT_TYPES } from "../finance.js";
import { fin, loadFin, entityById, accById, canWriteFin, accountsOf } from "../finapi.js";

export const IC_KIND = { transfer: "Transfer (loan / repayment / funding)", paid_on_behalf: "Paid an expense on their behalf", recharge: "Recharge (invoice them, no cash)" };
const positions = new Map(); // entity id → {loading|data|error}
function loadPosition(eid, force) {
  if (positions.has(eid) && !force) return;
  positions.set(eid, { loading: true });
  run(sb.rpc("fin_ic_position", { p_entity: eid })).then(r => { positions.set(eid, r.error ? { error: r.error } : { data: r.data || [] }); const v = $("ic-pos"); if (v && state.route.a === eid) v.innerHTML = positionHtml(entityById(eid)); });
}
const M = (n, ccy) => money(n, ccy);
function positionHtml(e) {
  const p = positions.get(e.id);
  if (!p || p.loading) return `<p class="hint">Checking balances…</p>`;
  if (p.error) return `<p class="bad-text">${esc(p.error.message || String(p.error))}</p>`;
  if (!p.data.length) return `<p class="calm">No balances with your other books yet.</p>`;
  return `<div class="tablewrap"><table class="rtable"><thead><tr><th>Other books</th><th class="num">In these books</th><th class="num">In their books</th><th>Check</th></tr></thead><tbody>
    ${p.data.map(x => { const mine = Number(x.mine), theirs = x.theirs === null ? null : Number(x.theirs);
      return `<tr><td><a href="#/finance/${x.entity_id}/intercompany">${esc(x.name)}</a></td>
      <td class="num">${mine === 0 ? "—" : mine > 0 ? `${M(mine, e.base_currency)} <small class="hint">owed to these books</small>` : `${M(-mine, e.base_currency)} <small class="hint">owed by these books</small>`}</td>
      <td class="num">${theirs === null ? `<small class="hint">not visible to you</small>` : theirs === 0 ? "—" : M(Math.abs(theirs), x.currency)}</td>
      <td>${x.matched ? `<span class="pill inv-paid">Matched</span>` : `<span class="pill inv-overdue">Mismatch</span> <small class="hint">recorded ${M(Number(x.recorded_mine), e.base_currency)}</small>`}</td></tr>`; }).join("")}</tbody></table></div>
    <p class="hint">Debit in one book always equals credit in the other, in each book's own currency. A mismatch means an entry was posted to the inter-entity account outside this screen.</p>`;
}
export function renderIntercompany(e) {
  loadPosition(e.id);
  const w = canWriteFin(e.id);
  const txns = fin.ictxns.filter(t => t.from_entity_id === e.id || t.to_entity_id === e.id);
  const other = t => entityById(t.from_entity_id === e.id ? t.to_entity_id : t.from_entity_id) || { name: "Other books", base_currency: "" };
  return `${w ? `<div class="btnrow noprint" style="margin:8px 0"><button class="btn primary" data-act="ic-new">${ICON.plus}Record inter-entity transaction</button></div>` : ""}
  ${section("Balances with your other books", `<div id="ic-pos">${positionHtml(e)}</div>`)}
  ${section("Transactions", txns.length ? `<div class="tablewrap"><table class="rtable"><thead><tr><th>IC no.</th><th>Date</th><th>With</th><th>What</th><th class="num">Amount (these books)</th><th></th></tr></thead><tbody>
    ${txns.map(t => { const out = t.from_entity_id === e.id, amt = out ? t.amount : t.amount_to;
      return `<tr class="${t.status === "reversed" ? "muted" : ""}"><td><b>${esc(t.ic_no)}</b></td><td>${fmtDate(t.txn_date)}</td><td>${out ? "→" : "←"} ${esc(other(t).name)}</td>
      <td>${esc(t.description)}<br><small class="hint">${esc(IC_KIND[t.kind])}${t.reference && t.reference !== t.ic_no ? " · " + esc(t.reference) : ""}</small>${t.status === "reversed" ? ` <span class="pill inv-void">Reversed</span> <small class="hint">${esc(t.reversal_reason || "")}</small>` : ""}</td>
      <td class="num">${out ? "" : "−"}${M(amt, e.base_currency)}</td>
      <td>${t.status === "posted" && canWriteFin(t.from_entity_id) && canWriteFin(t.to_entity_id) ? `<button class="btn sm" data-act="ic-reverse" data-id="${t.id}">Reverse…</button>` : ""}</td></tr>`; }).join("")}</tbody></table></div>`
    : `<p class="calm">Nothing recorded yet. Use this for loans, repayments and expenses one of your businesses pays for another — it posts the matching entry in both sets of books.</p>`, { count: txns.length })}`;
}

/* ---------------- record form ---------------- */
let draft = null;
const accOpts = (eid, pred, sel) => `<option value="">Choose…</option>` + Object.entries(ACCOUNT_TYPES).map(([t, l]) => {
  const as = accountsOf(eid, a => a.type === t && a.is_active && a.system_key !== "intercompany" && pred(a));
  return as.length ? `<optgroup label="${l}">${as.map(a => `<option value="${a.id}" ${a.id === sel ? "selected" : ""}>${esc(a.code + " " + a.name)}</option>`).join("")}</optgroup>` : ""; }).join("");
const money_ = a => ["cash", "bank"].includes(a.subtype);
function openRecord(eid) {
  const writable = fin.entities.filter(x => !x.archived && canWriteFin(x.id));
  if (writable.length < 2) return toastError("You need to keep at least two sets of books.");
  draft = { from: eid, to: (writable.find(x => x.id !== eid) || {}).id, kind: "transfer" };
  openSheet(render, { wide: true });
}
function render(sh) {
  const writable = fin.entities.filter(x => !x.archived && canWriteFin(x.id));
  const a = entityById(draft.from), b = entityById(draft.to), k = draft.kind, fx = a && b && a.base_currency !== b.base_currency;
  sh.innerHTML = sheetHead("Inter-entity transaction", "Posted in both sets of books at once") + `<form id="icForm" class="sh-body" novalidate>
    <div class="grid2"><label class="field"><span>From (pays / sends)</span><select class="input" id="ic-from" data-act="ic-redraw">${writable.map(x => `<option value="${x.id}" ${x.id === draft.from ? "selected" : ""}>${esc(x.name)} (${x.base_currency})</option>`).join("")}</select></label>
      <label class="field"><span>To (receives / benefits)</span><select class="input" id="ic-to" data-act="ic-redraw">${writable.filter(x => x.id !== draft.from).map(x => `<option value="${x.id}" ${x.id === draft.to ? "selected" : ""}>${esc(x.name)} (${x.base_currency})</option>`).join("")}</select></label></div>
    <label class="field"><span>What happened</span><select class="input" id="ic-kind" data-act="ic-redraw">${Object.entries(IC_KIND).map(([v, l]) => `<option value="${v}" ${v === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <div class="grid2"><label class="field"><span>Date</span><input class="input" type="date" id="ic-date" value="${draft.date || todayISO(state.tz)}"></label>
      <label class="field"><span>Reference <small>(optional)</small></span><input class="input" id="ic-ref" value="${esc(draft.ref || "")}"></label></div>
    <label class="field"><span>Description</span><input class="input" id="ic-desc" maxlength="300" value="${esc(draft.desc || "")}" placeholder="${k === "transfer" ? "e.g. Short-term loan for October payroll" : "e.g. Shop rent October"}"></label>
    <div class="grid2"><label class="field"><span>Amount (${a ? a.base_currency : ""})</span><input class="input num" type="number" step="0.01" min="0.01" id="ic-amt" value="${draft.amt || ""}"></label>
      ${fx ? `<label class="field"><span>Amount received (${b.base_currency})</span><input class="input num" type="number" step="0.01" min="0.01" id="ic-amt-to" value="${draft.amtTo || ""}"></label>` : ""}</div>
    ${fx ? `<p class="hint">The two books use different currencies, so enter the amount each side actually recorded (e.g. from the bank advice). No exchange rate is assumed.</p>` : ""}
    <div class="grid2"><label class="field"><span>${esc(a ? a.name : "")}: ${k === "recharge" ? "income account" : "paid from"}</span><select class="input" id="ic-from-acc">${a ? accOpts(a.id, k === "recharge" ? x => x.type === "income" : money_) : ""}</select></label>
      <label class="field"><span>${esc(b ? b.name : "")}: ${k === "transfer" ? "received into" : "expense or asset"}</span><select class="input" id="ic-to-acc">${b ? accOpts(b.id, k === "transfer" ? money_ : x => !money_(x) && !["income", "equity"].includes(x.type)) : ""}</select></label></div>
    <p class="hint">${k === "transfer" ? "Balance sheet only — neither book records income or expense." : k === "paid_on_behalf" ? "The expense goes in the receiving books; the payer records money owed back." : "Income in the first books, expense in the second; no cash moves."} Both entries carry the same IC number.</p>
    <div class="sheet-foot"><button class="btn primary block" type="submit" id="icSave">Post in both books</button></div></form>`;
}
function syncDraft() {
  draft.date = $("ic-date").value; draft.ref = $("ic-ref").value; draft.desc = $("ic-desc").value; draft.amt = $("ic-amt").value; draft.amtTo = $("ic-amt-to") ? $("ic-amt-to").value : draft.amtTo;
}
export async function handleIcClick(act, el) {
  switch (act) {
    case "ic-new": openRecord(state.route.a); return true;
    case "ic-reverse": {
      const t = fin.ictxns.find(x => x.id === el.dataset.id);
      const reason = await dialog({ title: `Reverse ${t.ic_no}?`, text: "Posts opposite entries in both sets of books. The original stays on record.", input: { label: "Reason", required: true, min: 3 }, confirm: "Reverse", danger: true });
      if (!reason) return true;
      const r = await run(sb.rpc("fin_ic_reverse", { p_txn: t.id, p_reason: reason })); if (r.error) return toastError(r.error), true;
      positions.clear(); await loadFin(true); toast("Reversed in both books"); return true; }
  }
  return false;
}
export function handleIcChange(e) {
  if (e.target.dataset.act !== "ic-redraw" || !draft) return false;
  syncDraft(); draft.from = $("ic-from").value; draft.kind = $("ic-kind").value;
  const to = $("ic-to").value; draft.to = to && to !== draft.from ? to : (fin.entities.find(x => x.id !== draft.from && canWriteFin(x.id) && !x.archived) || {}).id;
  rerenderSheet(); return true;
}
export async function handleIcSubmit(form) {
  if (form.id !== "icForm") return false;
  syncDraft();
  const p = { from_entity_id: $("ic-from").value, to_entity_id: $("ic-to").value, kind: $("ic-kind").value, txn_date: draft.date, description: draft.desc.trim(), reference: draft.ref.trim() || null,
    amount: Number(draft.amt), amount_to: $("ic-amt-to") ? Number(draft.amtTo) || null : null, from_account_id: $("ic-from-acc").value, to_account_id: $("ic-to-acc").value };
  if (!p.description) return toastError("Describe the transaction."), true;
  if (!(p.amount > 0)) return toastError("Enter the amount."), true;
  if ($("ic-amt-to") && !(p.amount_to > 0)) return toastError("Enter the amount received in the other currency."), true;
  if (!p.from_account_id || !p.to_account_id) return toastError("Choose both accounts."), true;
  const btn = $("icSave"); busy(btn, true, "Posting…");
  const r = await run(sb.rpc("fin_ic_record", { p })); busy(btn, false);
  if (r.error) return toastError(r.error), true;
  positions.clear(); await loadFin(true); closeSheet(); draft = null; toast("Posted in both sets of books"); return true;
}
