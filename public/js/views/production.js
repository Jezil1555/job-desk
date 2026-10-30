// Production & job costing: goods received before the bill, fabric issued to orders, other job costs, finished cost to COGS.
// Every action is a database function that posts a balanced entry; nothing here edits ledger rows directly.
import { esc, todayISO, fmtDate } from "../util.js";
import { state } from "../store.js";
import { sb, run } from "../api.js";
import { ICON, $, openSheet, closeSheet, rerenderSheet, sheetHead, toast, toastError, dialog, busy, section, emptyState } from "../ui.js";
import { money, r2, ACCOUNT_TYPES } from "../finance.js";
import { fin, loadFin, accById, partyById, itemById, canWriteFin, isFinOwner, accountsOf, stockOf } from "../finapi.js";

const M = (n, e) => money(n, e.base_currency);
const STATUS = { open: "Open", completed: "Completed", cancelled: "Cancelled" };
const PILL = { open: "inv-open", completed: "inv-paid", cancelled: "inv-void" };
export const orderCosts = id => fin.prodCosts.filter(c => c.order_id === id);
export function orderTotals(id) { // from posted cost rows; same rule as the fin_production_summary view
  const cs = orderCosts(id).filter(c => c.status === "posted");
  const material = r2(cs.filter(c => c.kind === "material").reduce((s, c) => s + Number(c.amount), 0));
  const other = r2(cs.filter(c => c.kind === "other").reduce((s, c) => s + Number(c.amount), 0));
  return { material, other, total: r2(material + other) };
}

export function renderProduction(e) {
  const w = canWriteFin(e.id);
  const orders = fin.prodOrders.filter(o => o.entity_id === e.id);
  const receipts = fin.receipts.filter(g => g.entity_id === e.id);
  const exc = fin.stockExceptions.filter(x => x.entity_id === e.id);
  const sys = k => fin.accounts.find(a => a.entity_id === e.id && a.system_key === k);
  const bal = a => a ? r2(fin.posted.filter(l => l.account_id === a.id).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0)) : 0;
  const wip = bal(sys("wip")), grni = -bal(sys("grni"));
  const open = orders.filter(o => o.status === "open");
  return `${w ? `<div class="btnrow noprint" style="margin:8px 0"><button class="btn primary" data-act="prod-new">${ICON.plus}New production order</button><button class="btn" data-act="prod-receive">Goods received</button></div>` : ""}
  <div class="tiles"><div class="tile"><span class="tn">${open.length}</span><span class="tl">Open orders</span></div>
    <div class="tile"><span class="tn">${M(wip, e)}</span><span class="tl">Work in progress (ledger)</span></div>
    <div class="tile ${grni > 0.005 ? "warn" : ""}"><span class="tn">${M(grni, e)}</span><span class="tl">Received, not yet billed</span></div></div>
  ${section("Production orders", orders.length ? `<div class="tablewrap"><table class="rtable"><thead><tr><th>Order</th><th>For</th><th>Status</th><th class="num">Material</th><th class="num">Other</th><th class="num">Job cost</th></tr></thead><tbody>
    ${orders.map(o => { const t = orderTotals(o.id), p = o.party_id && partyById(o.party_id);
      return `<tr class="clickrow ${o.status === "cancelled" ? "muted" : ""}" data-act="prod-open" data-id="${o.id}"><td><b>${esc(o.order_no)}</b> ${esc(o.title)}${o.job_ref ? ` <small class="hint">${esc(o.job_ref)}</small>` : ""}</td>
        <td>${p ? esc(p.name) : "—"}</td><td><span class="pill ${PILL[o.status]}">${STATUS[o.status]}</span></td>
        <td class="num">${M(t.material, e)}</td><td class="num">${M(t.other, e)}</td><td class="num"><b>${M(o.status === "completed" ? Number(o.total_cost) : t.total, e)}</b></td></tr>`; }).join("")}</tbody></table></div>`
    : `<p class="calm">No orders yet. Open one per garment or job, issue the fabric it uses and add stitching or trim costs — completing it moves the full job cost to cost of goods sold.</p>`, { count: orders.length })}
  ${section("Goods received", receipts.length ? `<div class="tablewrap"><table class="rtable"><thead><tr><th>GRN</th><th>Date</th><th>Item</th><th>Supplier</th><th class="num">Qty</th><th class="num">Value</th><th></th></tr></thead><tbody>
    ${receipts.map(g => { const it = itemById(g.item_id), p = g.party_id && partyById(g.party_id);
      return `<tr class="${g.status === "reversed" ? "muted" : ""}"><td><b>${esc(g.receipt_no)}</b>${g.reference ? ` <small class="hint">${esc(g.reference)}</small>` : ""}</td><td>${fmtDate(g.receipt_date)}</td>
        <td>${esc(it ? it.name : "")}</td><td>${p ? esc(p.name) : "—"}</td><td class="num">${Number(g.qty)} ${esc(it ? it.unit : "")}</td><td class="num">${M(r2(g.qty * g.unit_cost), e)}</td>
        <td>${g.status === "reversed" ? `<span class="pill inv-void">Reversed</span> <small class="hint">${esc(g.reversal_reason || "")}</small>` : w ? `<button class="btn sm" data-act="prod-grn-reverse" data-id="${g.id}">Reverse…</button>` : ""}</td></tr>`; }).join("")}</tbody></table></div>
    <p class="hint">When the supplier's bill arrives, code its line to <b>${esc(sys("grni") ? sys("grni").code + " " + sys("grni").name : "Goods received, not yet billed")}</b> rather than to stock — the stock is already in.</p>`
    : `<p class="calm">Record fabric when it arrives, before the bill. It goes into stock at the delivery-note cost and is held as owed until the bill clears it.</p>`, { count: receipts.length })}
  ${exc.length ? section("Authorised stock exceptions", `<div class="tablewrap"><table class="rtable"><thead><tr><th>When</th><th>Item</th><th class="num">Short by</th><th>Reason</th></tr></thead><tbody>
    ${exc.map(x => { const it = itemById(x.item_id); return `<tr><td>${fmtDate(String(x.authorised_at).slice(0, 10))}</td><td>${esc(it ? it.name : "")}</td><td class="num bad-text">${Number(x.qty_short)} ${esc(it ? it.unit : "")}</td><td>${esc(x.reason)}</td></tr>`; }).join("")}</tbody></table></div>
    <p class="hint">Stock went below zero only with the owner's recorded reason. Enter the missing receipt to bring it back.</p>`, { count: exc.length }) : ""}`;
}

/* ---------------- sheets ---------------- */
let cur = null; // {mode, eid, orderId}
const itemOpts = (eid, sel) => `<option value="">Choose…</option>` + fin.items.filter(i => i.entity_id === eid && !i.archived)
  .map(i => { const s = stockOf(i.id); return `<option value="${i.id}" ${i.id === sel ? "selected" : ""}>${esc(i.name)} — ${s.qty} ${esc(i.unit)} in stock</option>`; }).join("");
const partyOpts = (eid, kinds, sel) => `<option value="">—</option>` + fin.parties.filter(p => p.entity_id === eid && !p.archived && kinds.includes(p.kind))
  .map(p => `<option value="${p.id}" ${p.id === sel ? "selected" : ""}>${esc(p.name)}</option>`).join("");
const costAccOpts = eid => `<option value="">Choose…</option>` + ["expense", "liability", "asset"].map(t => {
  const as = accountsOf(eid, a => a.type === t && a.is_active && !["wip", "inventory", "grni", "intercompany", "ar"].includes(a.system_key));
  return as.length ? `<optgroup label="${ACCOUNT_TYPES[t]}">${as.map(a => `<option value="${a.id}">${esc(a.code + " " + a.name)}</option>`).join("")}</optgroup>` : ""; }).join("");

function renderSheet(sh) {
  const e = fin.entities.find(x => x.id === cur.eid), d = todayISO(state.tz);
  if (cur.mode === "new") {
    sh.innerHTML = sheetHead("New production order", e.name) + `<form id="prodNewForm" class="sh-body" novalidate>
      <label class="field"><span>What is being made</span><input class="input" id="po-title" maxlength="200" placeholder="e.g. Navy two-piece suit"></label>
      <div class="grid2"><label class="field"><span>Customer <small>(optional)</small></span><select class="input" id="po-party">${partyOpts(e.id, ["customer", "both"])}</select></label>
        <label class="field"><span>Job / order ref <small>(optional)</small></span><input class="input" id="po-ref"></label></div>
      <label class="field"><span>Opened on</span><input class="input" type="date" id="po-date" value="${d}"></label>
      <div class="sheet-foot"><button class="btn primary block" type="submit" id="poSave">Open order</button></div></form>`;
    return;
  }
  if (cur.mode === "receive") {
    sh.innerHTML = sheetHead("Goods received", "Stock in before the supplier's bill") + `<form id="prodGrnForm" class="sh-body" novalidate>
      <label class="field"><span>Item</span><select class="input" id="gr-item">${itemOpts(e.id)}</select></label>
      <div class="grid2"><label class="field"><span>Quantity received</span><input class="input num" type="number" step="0.001" min="0.001" id="gr-qty"></label>
        <label class="field"><span>Unit cost (${e.base_currency})</span><input class="input num" type="number" step="0.0001" min="0" id="gr-cost"></label></div>
      <div class="grid2"><label class="field"><span>Supplier <small>(optional)</small></span><select class="input" id="gr-party">${partyOpts(e.id, ["supplier", "both"])}</select></label>
        <label class="field"><span>Delivery note / PO <small>(optional)</small></span><input class="input" id="gr-ref"></label></div>
      <label class="field"><span>Date received</span><input class="input" type="date" id="gr-date" value="${d}"></label>
      <p class="hint">Posts stock in at this cost and a matching amount owed (goods received, not yet billed). The supplier's bill then clears it.</p>
      <div class="sheet-foot"><button class="btn primary block" type="submit" id="grSave">Record receipt</button></div></form>`;
    return;
  }
  const o = fin.prodOrders.find(x => x.id === cur.orderId);
  if (!o) { closeSheet(); return; }
  const t = orderTotals(o.id), w = canWriteFin(e.id) && o.status === "open", p = o.party_id && partyById(o.party_id);
  const cs = orderCosts(o.id);
  sh.innerHTML = sheetHead(`${o.order_no} · ${o.title}`, `${STATUS[o.status]}${p ? " · " + p.name : ""}${o.job_ref ? " · " + o.job_ref : ""}`) + `<div class="sh-body">
    <div class="tiles"><div class="tile"><span class="tn">${M(t.material, e)}</span><span class="tl">Material</span></div><div class="tile"><span class="tn">${M(t.other, e)}</span><span class="tl">Other costs</span></div>
      <div class="tile"><span class="tn">${M(o.status === "completed" ? Number(o.total_cost) : t.total, e)}</span><span class="tl">${o.status === "completed" ? "Finished cost (to COGS)" : "Job cost so far"}</span></div></div>
    ${o.status === "completed" ? `<p class="hint">Completed ${fmtDate(o.completed_on)}. The finished cost was moved from work in progress to cost of goods sold.</p>` : ""}
    ${o.status === "cancelled" ? `<p class="hint">Cancelled: ${esc(o.cancel_reason || "")}</p>` : ""}
    ${cs.length ? `<div class="tablewrap"><table class="rtable" id="prodCosts"><thead><tr><th>Date</th><th>Cost</th><th class="num">Amount</th><th></th></tr></thead><tbody>
      ${cs.map(c => { const it = c.item_id && itemById(c.item_id), a = c.source_account_id && accById(c.source_account_id);
        return `<tr class="${c.status === "reversed" ? "muted" : ""}"><td>${fmtDate(c.cost_date)}</td>
          <td>${c.kind === "material" ? `${esc(it ? it.name : "")} × ${Number(c.qty)} ${esc(it ? it.unit : "")} <small class="hint">@ ${M(c.unit_cost, e)}</small>` : esc(c.note || "")}
            ${c.kind === "material" && c.note ? ` <small class="hint">${esc(c.note)}</small>` : ""}${a ? ` <small class="hint">from ${esc(a.code + " " + a.name)}</small>` : ""}
            ${c.exception_id ? ` <span class="pill inv-overdue">Authorised short stock</span>` : ""}${c.status === "reversed" ? ` <span class="pill inv-void">Reversed</span> <small class="hint">${esc(c.reversal_reason || "")}</small>` : ""}</td>
          <td class="num">${M(c.amount, e)}</td><td>${w && c.status === "posted" ? `<button class="btn sm" data-act="prod-cost-reverse" data-id="${c.id}">Reverse…</button>` : ""}</td></tr>`; }).join("")}</tbody></table></div>` : `<p class="calm">No costs yet.</p>`}
    ${w ? `<form id="prodIssueForm" class="card-form" novalidate><h3>Issue material</h3>
        <div class="grid2"><label class="field"><span>Item</span><select class="input" id="pi-item">${itemOpts(e.id)}</select></label>
          <label class="field"><span>Quantity used</span><input class="input num" type="number" step="0.001" min="0.001" id="pi-qty"></label></div>
        <div class="grid2"><label class="field"><span>Date</span><input class="input" type="date" id="pi-date" value="${d}"></label><label class="field"><span>Note <small>(optional)</small></span><input class="input" id="pi-note"></label></div>
        <p class="hint">Valued at the item's average cost. If there isn't enough recorded stock, only the owner can authorise it, with a reason.</p>
        <div class="btnrow"><button class="btn" type="submit" id="piSave">Issue to ${esc(o.order_no)}</button></div></form>
      <form id="prodCostForm" class="card-form" novalidate><h3>Add other cost</h3>
        <label class="field"><span>What it is</span><input class="input" id="pc-note" maxlength="200" placeholder="e.g. Stitching — Topaz tailoring"></label>
        <div class="grid2"><label class="field"><span>Amount (${e.base_currency})</span><input class="input num" type="number" step="0.01" min="0.01" id="pc-amt"></label>
          <label class="field"><span>Paid from / owed on</span><select class="input" id="pc-acc">${costAccOpts(e.id)}</select></label></div>
        <label class="field"><span>Date</span><input class="input" type="date" id="pc-date" value="${d}"></label>
        <p class="hint">Choose the bank or cash account if paid now, a payable if owed, or the expense account a bill was already posted to (to move that cost into this job).</p>
        <div class="btnrow"><button class="btn" type="submit" id="pcSave">Add cost</button></div></form>
      <div class="sheet-foot btnrow"><label class="field" style="margin:0"><span>Completion date</span><input class="input" type="date" id="pd-date" value="${d}"></label><button class="btn primary" data-act="prod-complete" ${t.total > 0 ? "" : "disabled"}>Complete order…</button><button class="btn danger" data-act="prod-cancel">Cancel order…</button></div>` : ""}
  </div>`;
}
const openWith = (c) => { cur = c; openSheet(renderSheet, { wide: c.mode === "order" }); };
const refresh = async (msg) => { await loadFin(true); if (cur) rerenderSheet(); if (msg) toast(msg); };

export async function handleProdClick(act, el) {
  switch (act) {
    case "prod-new": openWith({ mode: "new", eid: state.route.a }); return true;
    case "prod-receive": openWith({ mode: "receive", eid: state.route.a }); return true;
    case "prod-open": openWith({ mode: "order", eid: state.route.a, orderId: el.dataset.id }); return true;
    case "prod-grn-reverse": {
      const g = fin.receipts.find(x => x.id === el.dataset.id);
      const reason = await dialog({ title: `Reverse ${g.receipt_no}?`, text: "Takes the stock back out and removes the amount owed. Not possible once any of it has been used.", input: { label: "Reason", required: true, min: 3 }, confirm: "Reverse", danger: true });
      if (!reason) return true;
      const r = await run(sb.rpc("fin_goods_receipt_reverse", { p_receipt: g.id, p_reason: reason })); if (r.error) return toastError(r.error), true;
      await refresh("Receipt reversed"); return true; }
    case "prod-cost-reverse": {
      const c = fin.prodCosts.find(x => x.id === el.dataset.id);
      const reason = await dialog({ title: "Reverse this cost?", text: c.kind === "material" ? "The material goes back into stock at the same cost." : "Posts the opposite entry; the original stays on record.", input: { label: "Reason", required: true, min: 3 }, confirm: "Reverse", danger: true });
      if (!reason) return true;
      const r = await run(sb.rpc("fin_production_reverse_cost", { p_cost: c.id, p_reason: reason })); if (r.error) return toastError(r.error), true;
      await refresh("Cost reversed"); return true; }
    case "prod-complete": {
      const o = fin.prodOrders.find(x => x.id === cur.orderId), e = fin.entities.find(x => x.id === o.entity_id), t = orderTotals(o.id);
      const date = $("pd-date") && $("pd-date").value;
      if (!date) return toastError("Choose the completion date."), true;
      const ok = await dialog({ title: `Complete ${o.order_no}?`, text: `Moves the job cost of ${M(t.total, e)} from work in progress to cost of goods sold on ${fmtDate(date)}. No more costs can be added afterwards.`, confirm: "Complete" });
      if (!ok) return true;
      const r = await run(sb.rpc("fin_production_complete", { p_order: o.id, p_date: date })); if (r.error) return toastError(r.error), true;
      await refresh(`${o.order_no} completed`); return true; }
    case "prod-cancel": {
      const o = fin.prodOrders.find(x => x.id === cur.orderId);
      if (orderCosts(o.id).some(c => c.status === "posted")) return toastError("Reverse the material and costs first — material goes back into stock."), true;
      const reason = await dialog({ title: `Cancel ${o.order_no}?`, input: { label: "Reason", required: true, min: 3 }, confirm: "Cancel order", danger: true });
      if (!reason) return true;
      const r = await run(sb.rpc("fin_production_cancel", { p_order: o.id, p_reason: reason })); if (r.error) return toastError(r.error), true;
      await refresh("Order cancelled"); return true; }
  }
  return false;
}

export async function handleProdSubmit(form) {
  const ids = ["prodNewForm", "prodGrnForm", "prodIssueForm", "prodCostForm"];
  if (!ids.includes(form.id) || !cur) return false;
  const v = id => $(id).value.trim();
  if (form.id === "prodNewForm") {
    if (!v("po-title")) return toastError("Say what is being made."), true;
    const btn = $("poSave"); busy(btn, true, "Opening…");
    const r = await run(sb.rpc("fin_production_open", { p_entity: cur.eid, p_title: v("po-title"), p_party: v("po-party") || null, p_job_ref: v("po-ref") || null, p_date: v("po-date") || null }));
    busy(btn, false); if (r.error) return toastError(r.error), true;
    cur = { mode: "order", eid: cur.eid, orderId: r.data }; await refresh("Order opened"); return true;
  }
  if (form.id === "prodGrnForm") {
    const qty = Number(v("gr-qty")), cost = v("gr-cost") === "" ? NaN : Number(v("gr-cost"));
    if (!v("gr-item")) return toastError("Choose the item."), true;
    if (!(qty > 0)) return toastError("Enter the quantity received."), true;
    if (!(cost >= 0)) return toastError("Enter the unit cost from the delivery note or PO."), true;
    const btn = $("grSave"); busy(btn, true, "Recording…");
    const r = await run(sb.rpc("fin_goods_receipt", { p: { item_id: v("gr-item"), qty, unit_cost: cost, party_id: v("gr-party") || null, reference: v("gr-ref") || null, receipt_date: v("gr-date") || null } }));
    busy(btn, false); if (r.error) return toastError(r.error), true;
    await loadFin(true); closeSheet(); cur = null; toast("Goods received — stock updated"); return true;
  }
  if (form.id === "prodIssueForm") {
    const item = v("pi-item"), qty = Number(v("pi-qty"));
    if (!item) return toastError("Choose the item."), true;
    if (!(qty > 0)) return toastError("Enter the quantity used."), true;
    const it = itemById(item), s = stockOf(item), o = fin.prodOrders.find(x => x.id === cur.orderId);
    let reason = null;
    if (s.qty < qty) {
      if (!isFinOwner(o.entity_id)) return toastError(`Only ${s.qty} ${it.unit} of ${it.name} in stock. Record the receipt first, or ask the owner to authorise.`), true;
      reason = await dialog({ title: "Not enough recorded stock", text: `Only ${s.qty} ${it.unit} of ${it.name} is recorded. As the owner you can authorise using ${qty} ${it.unit}; the shortfall and your reason are kept on record.`, input: { label: "Reason", required: true, min: 3 }, confirm: "Authorise and issue", danger: true });
      if (!reason) return true;
    }
    const btn = $("piSave"); busy(btn, true, "Issuing…");
    const r = await run(sb.rpc("fin_production_issue", { p_order: o.id, p_item: item, p_qty: qty, p_date: v("pi-date") || null, p_note: v("pi-note") || null, p_authorise_reason: reason }));
    busy(btn, false); if (r.error) return toastError(r.error), true;
    await refresh("Material issued"); return true;
  }
  if (form.id === "prodCostForm") {
    const amt = Number(v("pc-amt"));
    if (v("pc-note").length < 3) return toastError("Say what the cost is."), true;
    if (!(amt > 0)) return toastError("Enter the amount."), true;
    if (!v("pc-acc")) return toastError("Choose where it was paid from."), true;
    const btn = $("pcSave"); busy(btn, true, "Adding…");
    const r = await run(sb.rpc("fin_production_add_cost", { p_order: cur.orderId, p_amount: amt, p_account: v("pc-acc"), p_date: v("pc-date") || null, p_note: v("pc-note") }));
    busy(btn, false); if (r.error) return toastError(r.error), true;
    await refresh("Cost added"); return true;
  }
  return false;
}
