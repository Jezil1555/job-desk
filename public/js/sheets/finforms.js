// Finance forms and actions. Nothing is posted, paid or matched unless the person presses the button that says so.
import { aiCall, aiDecision } from "../assist.js";
import { esc, todayISO, fmtDate, addDays } from "../util.js";
import { state, nameOf } from "../store.js";
import { sb, run, savePrefs } from "../api.js";
import { ICON, $, openSheet, closeSheet, rerenderSheet, sheetHead, toast, toastError, dialog, busy } from "../ui.js";
import { safeFileName, fmtBytes, toCSV } from "../insights.js";
import { money, r2, entryTotals, ACCOUNT_TYPES, SUBTYPE_LABEL, invoiceStatus, INVOICE_STATUS_LABEL, parseStatementCSV, profitAndLoss, balanceSheet, cashFlow, trialBalance, aging, ledger, monthStart, monthEnd, monthsBetween, natural } from "../finance.js";
import { fin, loadFin, loadAudit, entityById, accById, partyById, journalById, invoiceById, paymentById, itemById, canWriteFin, isFinOwner, accountsOf, moneyAccounts, sysAccount,
  linesOf, linesOfJournal, invLinesOf, filesOf, stockOf, postJournal, reverseJournal, postInvoice, voidInvoice, recordPayment, recordFxPayment, voidPayment, matchStatement, unmatchStatement,
  addFinMember, stockAdjust, saveJournal, deleteDraftJournal, saveInvoice, uploadFinFile, finFileUrl, deleteFinFile } from "../finapi.js";
import { ui, rates, periodRange, REPORTS, auditHtml, bankingAccount } from "../views/finance.js";

const today = () => todayISO(state.tz);
const val = id => ($(id) ? $(id).value.trim() : "");
const num = id => { const v = val(id); return v === "" ? null : Number(v); };
const CURRENCIES = ["QAR", "INR", "BHD", "AED", "SAR", "KWD", "OMR", "USD", "EUR", "GBP"];
const curEntity = () => entityById(state.route.a);
const ccyOptions = (base, sel, extra = []) => [...new Set([base, ...extra, ...CURRENCIES])].map(c => `<option value="${c}" ${c === (sel || base) ? "selected" : ""}>${c}${c === base ? " (books)" : ""}</option>`).join("");
const accOptions = (eid, sel, pred = () => true, blank = "Choose account…") => `<option value="">${blank}</option>` + Object.entries(ACCOUNT_TYPES).map(([t, l]) => {
  const as = accountsOf(eid, a => a.type === t && (a.is_active || a.id === sel) && pred(a)); return as.length ? `<optgroup label="${l}">${as.map(a => `<option value="${a.id}" ${a.id === sel ? "selected" : ""}>${esc(a.code + " " + a.name)}</option>`).join("")}</optgroup>` : ""; }).join("");
const partyOptions = (eid, sel, kinds) => `<option value="">—</option>` + fin.parties.filter(p => p.entity_id === eid && (!p.archived || p.id === sel) && (!kinds || kinds.includes(p.kind) || p.id === sel)).map(p => `<option value="${p.id}" ${p.id === sel ? "selected" : ""}>${esc(p.name)}</option>`).join("");
async function refresh() { await loadFin(true); }
const done = async (msg, close = true) => { await refresh(); if (close) closeSheet(); else rerenderSheet(); if (msg) toast(msg); };
function filesPanel(eid, field, id) {
  const fs = filesOf(field, id), w = canWriteFin(eid);
  return `<section class="sub"><div class="sub-h"><h3>Receipts & documents</h3><span class="c">${fs.length}</span></div>
    ${fs.map(f => `<div class="krow"><span class="kico">${ICON.download}</span><button class="linkbtn" data-act="fin-file-open" data-id="${f.id}">${esc(f.title)}</button><small>${fmtBytes(f.size_bytes || 0)}</small>${w ? `<button class="iconbtn sm" data-act="fin-file-del" data-id="${f.id}" aria-label="Delete">${ICON.trash}</button>` : ""}</div>`).join("") || `<p class="hint">Nothing attached.</p>`}
    ${w ? `<label class="btn sm filebtn">${ICON.download}Attach file<input type="file" hidden data-act="fin-attach" data-field="${field}" data-id="${id}" data-entity="${eid}"></label>` : ""}</section>`;
}

/* ======================= new books / management rates ======================= */
function openNewEntity() {
  openSheet(sh => { sh.innerHTML = sheetHead("New books", "Each set of books has its own accounts, members and reports.") + `<form id="finNewEntity" class="sh-body" novalidate>
    <label class="field"><span>Name</span><input class="input" id="ne-name" placeholder="e.g. Dlusso Bespoke" autofocus></label>
    <div class="grid2"><label class="field"><span>Type</span><select class="input" id="ne-kind"><option value="business">Business</option><option value="personal">Personal / household</option></select></label>
    <label class="field"><span>Base currency</span><select class="input" id="ne-ccy">${CURRENCIES.map(c => `<option>${c}</option>`).join("")}</select></label></div>
    <label class="field"><span>Linked workspace <small>(optional)</small></span><select class="input" id="ne-ws"><option value="">None</option>${state.workspaces.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join("")}</select></label>
    <p class="hint">The base currency can't be changed once entries are posted. A standard chart of accounts is created; you can add or rename accounts later.</p>
    <div class="sheet-foot"><button class="btn primary block" type="submit" id="neSave">Create books</button></div></form>`; });
}
async function openRates() {
  const rt = rates();
  const v = await dialog({ title: "Management exchange rates", text: `Used only to combine books on the Finance page for planning. Enter how many units of each currency equal 1 ${rt.base}, e.g. INR=26.10, BHD=0.1035.`,
    input: { label: "Rates", required: true, placeholder: "INR=26.10", multiline: true }, confirm: "Save" });
  if (v === null || v === undefined) return;
  const out = { base: rt.base };
  for (const part of String(v).split(/[\n,;]+/)) { const m = part.trim().toUpperCase().match(/^([A-Z]{3})\s*=\s*([\d.]+)$/); if (m && Number(m[2]) > 0) out[m[1]] = Number(m[2]); }
  if (Object.keys(out).length < 2) return toastError("Write rates like INR=26.10");
  const r = await savePrefs({ fin_rates: out }); if (r && r.error) return toastError(r.error);
  toast("Rates saved"); location.hash = "#/finance";
}

/* ======================= quick entries (expense / income / transfer) ======================= */
function openQuick(kind) {
  const e = curEntity(); if (!e) return;
  const monies = moneyAccounts(e.id);
  openSheet(sh => { sh.innerHTML = sheetHead(kind === "expense" ? (e.kind === "personal" ? "Record spending" : "Record an expense") : kind === "income" ? "Record income" : "Transfer between accounts", `${esc(e.name)} · ${e.base_currency}`) + `
    <form id="finQuick" class="sh-body" data-kind="${kind}" novalidate>
      <div class="grid2"><label class="field"><span>Date</span><input class="input" type="date" id="fq-date" value="${today()}"></label>
      <label class="field"><span>Amount (${e.base_currency})</span><input class="input num" type="number" step="0.01" min="0.01" id="fq-amt" autofocus></label></div>
      ${kind === "transfer" ? `<div class="grid2"><label class="field"><span>From</span><select class="input" id="fq-from">${accOptions(e.id, null, a => ["cash", "bank", "card", "earmarked", "investment"].includes(a.subtype))}</select></label>
        <label class="field"><span>To</span><select class="input" id="fq-to">${accOptions(e.id, null, a => ["cash", "bank", "card", "earmarked", "investment", "loan"].includes(a.subtype))}</select></label></div>`
      : `<div class="grid2"><label class="field"><span>${kind === "expense" ? "Paid from" : "Received into"}</span><select class="input" id="fq-money">${monies.map(a => `<option value="${a.id}">${esc(a.code + " " + a.name)}</option>`).join("")}</select></label>
        <label class="field"><span>${kind === "expense" ? "Category" : "Income type"}</span><select class="input" id="fq-cat">${accOptions(e.id, null, a => kind === "expense" ? a.type === "expense" || ["fixed_asset", "inventory", "partner"].includes(a.subtype) : a.type === "income" || a.subtype === "partner" || a.type === "equity")}</select></label></div>
      <label class="field"><span>${kind === "expense" ? "Paid to" : "Received from"} <small>(optional)</small></span><select class="input" id="fq-party">${partyOptions(e.id, null)}</select></label>`}
      <label class="field"><span>Description</span><input class="input" id="fq-memo" placeholder="${kind === "expense" ? "e.g. October shop rent" : kind === "income" ? "e.g. October salary" : "e.g. Move to savings"}"></label>
      <label class="field"><span>Reference <small>(optional)</small></span><input class="input" id="fq-ref" placeholder="Receipt / cheque / TT number"></label>
      <label class="field"><span>Receipt <small>(optional)</small></span><input class="input" type="file" id="fq-file"></label>
      <div class="sheet-foot"><button class="btn primary" type="submit" data-post="1">Save & post</button><button class="btn" type="submit" data-post="0">Save as draft</button></div>
    </form>`; });
}
async function submitQuick(form, post) {
  const e = curEntity(), kind = form.dataset.kind, amt = r2(num("fq-amt")), date = val("fq-date");
  if (!amt || amt <= 0) return toastError("Enter an amount.");
  if (!date) return toastError("Choose a date.");
  let lines, memo = val("fq-memo");
  if (kind === "transfer") {
    const from = val("fq-from"), to = val("fq-to");
    if (!from || !to || from === to) return toastError("Choose two different accounts.");
    lines = [{ account_id: to, debit: amt }, { account_id: from, credit: amt }]; memo = memo || `Transfer: ${accById(from).name} → ${accById(to).name}`;
  } else {
    const m = val("fq-money"), c = val("fq-cat"), p = val("fq-party") || null;
    if (!m || !c) return toastError(kind === "expense" ? "Choose where it was paid from and the category." : "Choose where it went and the income type.");
    lines = kind === "expense" ? [{ account_id: c, debit: amt, party_id: p }, { account_id: m, credit: amt }] : [{ account_id: m, debit: amt }, { account_id: c, credit: amt, party_id: p }];
    memo = memo || `${kind === "expense" ? "Paid" : "Received"}: ${accById(c).name}`;
  }
  const btn = form.querySelector(`[data-post="${post ? 1 : 0}"]`); busy(btn, true);
  const r = await saveJournal({ entity_id: e.id, entry_date: date, memo, reference: val("fq-ref") }, lines, post);
  if (r.error) { busy(btn, false); return toastError(r.error); }
  const f = $("fq-file") && $("fq-file").files[0];
  if (f) { const u = await uploadFinFile(f, e.id, { journal_id: r.data.id }, safeFileName); if (u.error) toastError(u.error); }
  busy(btn, false); await done(post ? "Posted" : "Saved as draft");
}

/* ======================= journal editor / viewer ======================= */
let jd = null; // draft being edited
function openJournal(id) {
  const e = curEntity() || (id && entityById((journalById(id) || {}).entity_id)); if (!e) return;
  const j = id ? journalById(id) : null;
  if (id && !j) return toastError("That entry isn't available.");
  jd = j && j.status === "draft" ? { id: j.id, entity_id: j.entity_id, entry_date: j.entry_date, memo: j.memo, reference: j.reference, source: j.source, lines: linesOfJournal(j.id).map(l => ({ ...l })) }
    : !j ? { entity_id: e.id, entry_date: today(), memo: "", reference: "", source: "manual", lines: [{}, {}] } : null;
  openSheet(sh => renderJournal(sh, id), { wide: true });
}
function renderJournal(sh, id) {
  const j = id ? journalById(id) : null, e = entityById(j ? j.entity_id : jd.entity_id), w = canWriteFin(e.id);
  if (j && j.status === "posted") {
    const ls = linesOfJournal(j.id), rev = j.reversed_by && journalById(j.reversed_by), orig = j.reversal_of && journalById(j.reversal_of);
    const doc = j.source_id && (fin.invoices.find(i => i.id === j.source_id) || fin.payments.find(p => p.id === j.source_id));
    sh.innerHTML = sheetHead(`Entry #${j.number}`, `${esc(e.name)} · posted ${fmtDate(j.entry_date)} by ${esc(nameOf(j.posted_by))}`) + `<div class="sh-body">
      <p class="lead">${esc(j.memo)}${j.reference ? ` <small class="hint">· ${esc(j.reference)}</small>` : ""}</p>
      ${rev ? `<div class="banner warn">Reversed by <button class="linkbtn" data-act="fin-open-journal" data-id="${rev.id}">#${rev.number}</button>${j.reversal_reason ? `: ${esc(j.reversal_reason)}` : ""}</div>` : ""}
      ${orig ? `<div class="banner info">This reverses <button class="linkbtn" data-act="fin-open-journal" data-id="${orig.id}">#${orig.number}</button>.</div>` : ""}
      ${doc ? `<div class="banner info">Created by ${doc.kind ? `${doc.kind === "sale" ? "invoice" : "bill"} <button class="linkbtn" data-act="fin-open-invoice" data-id="${doc.id}">${esc(doc.number)}</button>` : `a <button class="linkbtn" data-act="fin-open-payment" data-id="${doc.id}">payment</button>`} — change it there.</div>` : ""}
      <table class="rtable"><thead><tr><th>Account</th><th>Detail</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>
        ${ls.map(l => `<tr><td>${esc((accById(l.account_id) || {}).code + " " + (accById(l.account_id) || {}).name)}</td><td>${esc(l.description || "")}${l.party_id ? ` <small class="hint">${esc((partyById(l.party_id) || {}).name || "")}</small>` : ""}${l.statement_line_id ? ` <span class="chip">reconciled</span>` : ""}</td>
          <td class="num">${Number(l.debit) ? money(l.debit) : ""}</td><td class="num">${Number(l.credit) ? money(l.credit) : ""}</td></tr>`).join("")}
        <tr class="total"><td colspan="2">Total</td><td class="num">${money(ls.reduce((s, l) => s + Number(l.debit), 0))}</td><td class="num">${money(ls.reduce((s, l) => s + Number(l.credit), 0))}</td></tr></tbody></table>
      ${filesPanel(e.id, "journal_id", j.id)}
      ${w && !rev && !orig && ["manual", "opening"].includes(j.source) ? `<div class="sheet-foot"><button class="btn" data-act="fin-reverse" data-id="${j.id}">Reverse this entry</button></div><p class="hint">Reversing posts a mirror-image entry so the original stays on record.</p>` : ""}
    </div>`;
    return;
  }
  const d = jd, t = entryTotals(d.lines);
  sh.innerHTML = sheetHead(d.id ? "Draft entry" : d.source === "opening" ? "Opening balances" : "New journal entry", `${esc(e.name)} · ${e.base_currency} · drafts don't affect any figure until posted`) + `
  <form id="finJournal" class="sh-body" novalidate>
    <div class="grid3"><label class="field"><span>Date</span><input class="input" type="date" id="fj-date" value="${d.entry_date}"></label>
    <label class="field" style="grid-column:span 2"><span>Description</span><input class="input" id="fj-memo" value="${esc(d.memo)}" placeholder="What is this entry for?"></label></div>
    <label class="field"><span>Reference <small>(optional)</small></span><input class="input" id="fj-ref" value="${esc(d.reference || "")}"></label>
    <div class="tablewrap"><table class="rtable jlines"><thead><tr><th>Account</th><th>Detail</th><th>Who</th><th class="num">Debit</th><th class="num">Credit</th><th></th></tr></thead><tbody>
      ${d.lines.map((l, i) => `<tr><td><select class="input sm" data-jl="${i}" data-f="account_id">${accOptions(e.id, l.account_id)}</select></td>
        <td><input class="input sm" data-jl="${i}" data-f="description" value="${esc(l.description || "")}"></td>
        <td><select class="input sm" data-jl="${i}" data-f="party_id">${partyOptions(e.id, l.party_id)}</select></td>
        <td><input class="input sm num" type="number" step="0.01" min="0" data-jl="${i}" data-f="debit" value="${Number(l.debit) || ""}" style="width:7.5em"></td>
        <td><input class="input sm num" type="number" step="0.01" min="0" data-jl="${i}" data-f="credit" value="${Number(l.credit) || ""}" style="width:7.5em"></td>
        <td><button type="button" class="iconbtn sm" data-act="fj-del" data-i="${i}" aria-label="Remove line">${ICON.close}</button></td></tr>`).join("")}
      <tr class="total"><td colspan="3"><button type="button" class="btn sm" data-act="fj-add">${ICON.plus}Line</button>${t.diff ? ` <button type="button" class="btn sm" data-act="fj-balance">Put difference on last line</button>` : ""}</td>
        <td class="num" id="fj-dr">${money(t.debit)}</td><td class="num" id="fj-cr">${money(t.credit)}</td><td></td></tr></tbody></table></div>
    <p id="fj-problems" class="${t.ok ? "ok-text" : "hint"}">${t.ok ? `${ICON.check} Balanced` : esc(t.problems[0])}</p>
    ${w ? `<div class="sheet-foot"><button class="btn primary" type="submit" data-post="1">Save & post</button><button class="btn" type="submit" data-post="0">Save draft</button>
      ${d.id ? `<button type="button" class="btn danger" data-act="fj-delete">${ICON.trash}Delete draft</button>` : ""}</div>` : ""}
  </form>${d.id ? `<div class="sh-body">${filesPanel(e.id, "journal_id", d.id)}</div>` : ""}`;
}
function journalTotalsLive() {
  const t = entryTotals(jd.lines);
  if ($("fj-dr")) { $("fj-dr").textContent = money(t.debit); $("fj-cr").textContent = money(t.credit); const p = $("fj-problems"); p.className = t.ok ? "ok-text" : "hint"; p.textContent = t.ok ? "✓ Balanced" : t.problems[0]; }
}
function syncJournalHead() { if (!jd || !$("fj-date")) return; jd.entry_date = val("fj-date"); jd.memo = val("fj-memo"); jd.reference = val("fj-ref"); }
async function submitJournal(post, btn) {
  syncJournalHead();
  if (!jd.memo) return toastError("Add a description.");
  if (post) { const t = entryTotals(jd.lines); if (!t.ok) return toastError(t.problems[0]); }
  busy(btn, true);
  const r = await saveJournal(jd, jd.lines, post);
  busy(btn, false);
  if (r.error) { if (r.draftId) { jd.id = r.draftId; await refresh(); } return toastError(r.error); }
  jd = null; await done(post ? "Posted" : "Draft saved");
}

/* opening balances: one line per balance-sheet account; the difference goes to Opening balance equity */
function openOpening() {
  const e = curEntity(); if (!e) return;
  const open = sysAccount(e.id, "opening");
  const accs = accountsOf(e.id, a => ["asset", "liability", "equity"].includes(a.type) && a.is_active && !["opening", "retained"].includes(a.system_key) && !["receivable", "payable", "inventory"].includes(a.subtype));
  openSheet(sh => { sh.innerHTML = sheetHead("Opening balances", `${esc(e.name)} · enter actual balances from statements on the start date`) + `<form id="finOpening" class="sh-body" novalidate>
    <label class="field"><span>Balances as at</span><input class="input" type="date" id="fo-date" value="${today()}"></label>
    <div class="tablewrap"><table class="rtable"><thead><tr><th>Account</th><th class="num">Balance (${e.base_currency})</th></tr></thead><tbody>
      ${accs.map(a => `<tr><td>${esc(a.code + " " + a.name)} <small class="hint">${a.type === "asset" ? "what you have" : a.type === "liability" ? "what you owe" : "capital"}</small></td><td class="num"><input class="input sm num" type="number" step="0.01" min="0" name="ob-${a.id}" style="width:9em"></td></tr>`).join("")}
    </tbody></table></div>
    <p class="hint">Customer and supplier balances and stock are entered separately (as invoices/bills and opening stock) so they stay itemised. The balancing figure goes to <b>${esc(open ? open.name : "Opening balance equity")}</b>. You'll review the entry before it's posted.</p>
    <div class="sheet-foot"><button class="btn primary block" type="submit">Prepare entry for review</button></div></form>`; });
}
function submitOpening() {
  const e = curEntity(), open = sysAccount(e.id, "opening"), lines = [];
  document.querySelectorAll('#finOpening input[name^="ob-"]').forEach(inp => {
    const v = r2(inp.value); if (!v) return; const a = accById(inp.name.slice(3));
    lines.push(a.type === "asset" ? { account_id: a.id, debit: v, description: "Opening balance" } : { account_id: a.id, credit: v, description: "Opening balance" });
  });
  if (!lines.length) return toastError("Enter at least one balance.");
  const t = entryTotals(lines);
  if (t.diff) lines.push(t.diff > 0 ? { account_id: open.id, credit: t.diff, description: "Balancing figure" } : { account_id: open.id, debit: -t.diff, description: "Balancing figure" });
  closeSheet();
  jd = { entity_id: e.id, entry_date: val("fo-date") || today(), memo: "Opening balances", reference: "", source: "opening", lines };
  openSheet(sh => renderJournal(sh, null), { wide: true });
}

/* ======================= invoices & bills ======================= */
let idraft = null;
function openInvoice(id, kind) {
  const inv = id ? invoiceById(id) : null;
  if (id && !inv) return toastError("That invoice isn't available.");
  const e = inv ? entityById(inv.entity_id) : curEntity(); if (!e) return;
  idraft = inv && inv.status === "draft" ? { ...inv, lines: invLinesOf(inv.id).map(l => ({ ...l })) } : !inv ? { entity_id: e.id, kind, issue_date: today(), due_date: "", party_id: "", party_reference: "", notes: "", task_id: "", currency: "", fx_rate: "", lines: [{ qty: 1 }] } : null;
  openSheet(sh => renderInvoice(sh, id), { wide: true });
}
function taskOptions(e, sel) {
  const ts = state.tasks.filter(t => !t.deleted_at && (t.id === sel || (!["completed", "cancelled"].includes(t.status) && (!e.workspace_id || t.workspace_id === e.workspace_id))));
  return `<option value="">No task</option>` + ts.slice(0, 200).map(t => `<option value="${t.id}" ${t.id === sel ? "selected" : ""}>${esc(t.title.slice(0, 80))}</option>`).join("");
}
function renderInvoice(sh, id) {
  const inv = id ? invoiceById(id) : null, e = entityById(inv ? inv.entity_id : idraft.entity_id), w = canWriteFin(e.id);
  const kind = inv ? inv.kind : idraft.kind, noun = kind === "sale" ? "Invoice" : "Bill";
  if (inv && inv.status !== "draft") {
    const t = fin.totals.get(inv.id) || { total: 0, paid: 0 }, s = invoiceStatus(inv, t, today()), out = r2(Number(t.total) - Number(t.paid));
    const allocs = fin.allocations.filter(a => a.invoice_id === inv.id).map(a => ({ a, p: paymentById(a.payment_id) })).filter(x => x.p);
    const task = inv.task_id && state.taskById.get(inv.task_id), cc = inv.currency || e.base_currency;
    sh.innerHTML = sheetHead(`${noun} ${inv.number}`, `${esc(e.name)} · ${esc((partyById(inv.party_id) || {}).name || "")}`) + `<div class="sh-body">
      <div class="inv-head"><span class="pill inv-${s}">${INVOICE_STATUS_LABEL[s]}</span><div><small class="hint">Total</small><b class="num big">${money(t.total, cc)}</b></div>
        <div><small class="hint">Paid</small><b class="num">${money(t.paid, cc)}</b></div><div><small class="hint">Outstanding</small><b class="num ${out > 0 && s === "overdue" ? "bad-text" : ""}">${money(Math.max(out, 0), cc)}</b></div></div>
      ${inv.status === "void" ? `<div class="banner warn">Void: ${esc(inv.void_reason || "")}</div>` : ""}
      <dl class="kv"><dt>Issued</dt><dd>${fmtDate(inv.issue_date)}</dd>${inv.party_reference ? `<dt>${kind === "sale" ? "Customer ref" : "Supplier's number"}</dt><dd>${esc(inv.party_reference)}</dd>` : ""}<dt>Journal</dt><dd><button class="linkbtn" data-act="fin-open-journal" data-id="${inv.journal_id}">#${(journalById(inv.journal_id) || {}).number || ""}</button></dd>
        ${inv.currency ? `<dt>Exchange rate</dt><dd>1 ${inv.currency} = ${Number(inv.fx_rate)} ${e.base_currency} · booked at ${money(r2(Number(t.total) * Number(inv.fx_rate)), e.base_currency)}</dd>` : ""}</dl>
      <table class="rtable"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead><tbody>
        ${invLinesOf(inv.id).map(l => `<tr><td>${esc(l.description)}${l.item_id ? ` <small class="hint">${esc((itemById(l.item_id) || {}).sku || "stock")}</small>` : ""}</td><td class="num">${Number(l.qty)}</td><td class="num">${money(l.unit_price)}</td><td class="num">${money(l.amount)}</td></tr>`).join("")}
        <tr class="total"><td colspan="3">Total</td><td class="num">${money(t.total)}</td></tr></tbody></table>
      ${allocs.length ? `<h3>Payments</h3><ul class="plain">${allocs.map(x => `<li><button class="linkbtn" data-act="fin-open-payment" data-id="${x.p.id}">${fmtDate(x.p.pay_date)} · ${money(x.a.amount, cc)}${x.p.reference ? " · " + esc(x.p.reference) : ""}</button>${x.p.status === "void" ? ` <span class="pill inv-void">void</span>` : ""}</li>`).join("")}</ul>` : ""}
      <form id="finInvMeta" class="review-form" data-id="${inv.id}">
        <div class="grid2"><label class="field"><span>Due date <small>(optional)</small></span><input class="input" type="date" id="im-due" value="${inv.due_date || ""}" min="${inv.issue_date}" ${w ? "" : "disabled"}></label>
        <label class="field"><span>Linked task</span><select class="input" id="im-task" ${w ? "" : "disabled"}>${taskOptions(e, inv.task_id)}</select></label></div>
        <label class="field"><span>Notes</span><textarea class="input" id="im-notes" rows="2" ${w ? "" : "disabled"}>${esc(inv.notes || "")}</textarea></label>
        ${task ? `<p class="hint">Task: <button class="linkbtn" data-act="open-task" data-id="${task.id}">${esc(task.title)}</button> (${esc(task.status.replace("_", " "))}). Completing the task doesn't mark this ${noun.toLowerCase()} paid.</p>` : ""}
        ${w ? `<div class="btnrow"><button class="btn sm" type="submit">Save details</button></div>` : ""}</form>
      ${filesPanel(e.id, "invoice_id", inv.id)}
      ${w && inv.status === "posted" ? `<div class="sheet-foot">${out > 0 ? `<button class="btn primary" data-act="fin-pay" data-dir="${kind === "sale" ? "in" : "out"}" data-invoice="${inv.id}">${kind === "sale" ? "Record payment received" : "Record payment made"}</button>` : ""}
        <button class="btn danger" data-act="fin-void-invoice" data-id="${inv.id}">Void</button></div>` : ""}
    </div>`;
    return;
  }
  const d = idraft, total = r2(d.lines.reduce((s, l) => s + r2((Number(l.qty) || 0) * (Number(l.unit_price) || 0)), 0));
  const items = fin.items.filter(i => i.entity_id === e.id && !i.archived);
  sh.innerHTML = sheetHead(d.id ? `Draft ${noun.toLowerCase()}` : `New ${noun.toLowerCase()}`, `${esc(e.name)} · ${e.base_currency} · posting creates the journal entry`) + `
  <form id="finInvoice" class="sh-body" novalidate>
    <div class="grid3"><label class="field"><span>${kind === "sale" ? "Customer" : "Supplier"}</span><select class="input" id="fi-party">${partyOptions(e.id, d.party_id, kind === "sale" ? ["customer", "partner", "other", "employee"] : ["supplier", "partner", "other", "employee"])}</select>
      <button type="button" class="linkbtn" data-act="fin-party" data-quick="1">+ add new</button></label>
    <label class="field"><span>Date</span><input class="input" type="date" id="fi-date" value="${d.issue_date}"></label>
    <label class="field"><span>Due date <small>(optional)</small></span><input class="input" type="date" id="fi-due" value="${d.due_date || ""}"></label></div>
    <div class="grid2"><label class="field"><span>Currency</span><select class="input" id="fi-ccy">${ccyOptions(e.base_currency, d.currency)}</select></label>
      ${d.currency ? `<label class="field"><span>Rate: 1 ${d.currency} = ? ${e.base_currency}</span><input class="input num" type="number" step="0.00000001" min="0" id="fi-rate" value="${d.fx_rate || ""}" placeholder="from your bank or the invoice"></label>` : `<span></span>`}</div>
    ${d.currency ? `<p class="hint">Prices below are in ${d.currency}. Posting records them in ${e.base_currency} at this rate; the difference when it's paid is posted as an exchange gain or loss. No rate is filled in for you.</p>` : ""}
    <div class="grid2"><label class="field"><span>${kind === "sale" ? "Customer reference / PO" : "Supplier's bill number"}</span><input class="input" id="fi-ref" value="${esc(d.party_reference || "")}"></label>
    <label class="field"><span>Linked task <small>(optional)</small></span><select class="input" id="fi-task">${taskOptions(e, d.task_id)}</select></label></div>
    <div class="tablewrap"><table class="rtable jlines"><thead><tr>${items.length ? "<th>Stock item</th>" : ""}<th>Description</th><th class="num">Qty</th><th class="num">Price</th><th>${kind === "sale" ? "Income account" : "Expense / asset account"}</th><th class="num">Amount</th><th></th></tr></thead><tbody>
      ${d.lines.map((l, i) => `<tr>${items.length ? `<td><select class="input sm" data-il="${i}" data-f="item_id"><option value="">—</option>${items.map(it => `<option value="${it.id}" ${it.id === l.item_id ? "selected" : ""}>${esc(it.name)}</option>`).join("")}</select></td>` : ""}
        <td><input class="input sm" data-il="${i}" data-f="description" value="${esc(l.description || "")}"></td>
        <td><input class="input sm num" type="number" step="0.001" min="0" data-il="${i}" data-f="qty" value="${l.qty ?? 1}" style="width:5em"></td>
        <td><input class="input sm num" type="number" step="0.01" min="0" data-il="${i}" data-f="unit_price" value="${l.unit_price ?? ""}" style="width:7em"></td>
        <td>${l.item_id && kind === "purchase" ? `<small class="hint">Inventory</small>` : `<select class="input sm" data-il="${i}" data-f="account_id">${accOptions(e.id, l.account_id, a => kind === "sale" ? a.type === "income" : ["expense", "asset"].includes(a.type) && !["cash", "bank", "receivable"].includes(a.subtype), kind === "sale" ? "Default: Sales" : "Choose…")}</select>`}</td>
        <td class="num">${money(r2((Number(l.qty) || 0) * (Number(l.unit_price) || 0)))}</td><td><button type="button" class="iconbtn sm" data-act="fi-del" data-i="${i}" aria-label="Remove line">${ICON.close}</button></td></tr>`).join("")}
      <tr class="total"><td colspan="${items.length ? 5 : 4}"><button type="button" class="btn sm" data-act="fi-add">${ICON.plus}Line</button></td><td class="num" id="fi-total">${money(total, d.currency || e.base_currency)}</td><td></td></tr></tbody></table></div>
    <label class="field"><span>Notes</span><textarea class="input" id="fi-notes" rows="2">${esc(d.notes || "")}</textarea></label>
    ${w ? `<div class="sheet-foot"><button class="btn primary" type="submit" data-post="1">Save & post</button><button class="btn" type="submit" data-post="0">Save draft</button>${d.id ? `<button type="button" class="btn danger" data-act="fi-delete">${ICON.trash}Delete draft</button>` : ""}</div>` : ""}
  </form>`;
}
function invoiceTotalLive() {
  if (!idraft) return;
  document.querySelectorAll("#finInvoice tbody tr").forEach((tr, i) => { const l = idraft.lines[i]; const cell = tr.querySelector("td.num:not(:has(input))"); if (l && cell) cell.textContent = money(r2((Number(l.qty) || 0) * (Number(l.unit_price) || 0))); });
  const total = r2(idraft.lines.reduce((s, l) => s + r2((Number(l.qty) || 0) * (Number(l.unit_price) || 0)), 0)); if ($("fi-total")) { const e = entityById(idraft.entity_id); $("fi-total").textContent = money(total, idraft.currency || e.base_currency); }
}
function syncInvoiceHead() { if (!idraft || !$("fi-date")) return; const base = entityById(idraft.entity_id).base_currency, cc = val("fi-ccy");
  Object.assign(idraft, { currency: cc && cc !== base ? cc : "", fx_rate: $("fi-rate") ? val("fi-rate") : idraft.fx_rate, party_id: val("fi-party"), issue_date: val("fi-date"), due_date: val("fi-due"), party_reference: val("fi-ref"), task_id: val("fi-task"), notes: val("fi-notes") }); }
async function submitInvoice(post, btn) {
  syncInvoiceHead();
  const d = idraft;
  if (post && !d.party_id) return toastError(d.kind === "sale" ? "Choose the customer." : "Choose the supplier.");
  if (d.due_date && d.due_date < d.issue_date) return toastError("The due date is before the invoice date.");
  if (post && d.currency && !(Number(d.fx_rate) > 0)) return toastError(`Enter the exchange rate: how many ${entityById(d.entity_id).base_currency} 1 ${d.currency} is worth.`);
  if (!d.lines.some(l => l.description && Number(l.qty) > 0)) return toastError("Add at least one line with a description.");
  if (d.kind === "purchase" && d.lines.some(l => l.description && !l.item_id && !l.account_id)) return toastError("Choose an account for each line.");
  busy(btn, true);
  const r = await saveInvoice(d, d.lines);
  if (r.error) { busy(btn, false); return toastError(r.error); }
  d.id = r.data.id;
  if (post) { const p = await postInvoice(d.id); if (p.error) { busy(btn, false); await refresh(); rerenderSheet(); return toastError(p.error); } }
  busy(btn, false); idraft = null; await done(post ? `${d.kind === "sale" ? "Invoice" : "Bill"} posted` : "Draft saved");
}

/* ======================= payments ======================= */
let pd = null;
function openPayment(dir, invoiceId) {
  const inv = invoiceId && invoiceById(invoiceId), e = inv ? entityById(inv.entity_id) : curEntity(); if (!e) return;
  const m = moneyAccounts(e.id);
  pd = { entity_id: e.id, direction: dir, party_id: inv ? inv.party_id : "", currency: inv && inv.currency ? inv.currency : "", base_amount: "", pay_date: today(), account_id: (m.find(a => a.subtype === "bank") || m[0] || {}).id, amount: "", reference: "", memo: "", alloc: {} };
  if (inv) { const t = fin.totals.get(inv.id); pd.amount = r2(Number(t.total) - Number(t.paid)); pd.alloc[inv.id] = pd.amount; }
  openSheet(renderPayment);
}
function openInvoicesFor(eid, dir, party, currency = "") {
  const kind = dir === "in" ? "sale" : "purchase";
  return fin.invoices.filter(i => i.entity_id === eid && i.kind === kind && i.status === "posted" && i.party_id === party && (i.currency || "") === currency).map(i => ({ i, out: r2(Number((fin.totals.get(i.id) || {}).total) - Number((fin.totals.get(i.id) || {}).paid)) }))
    .filter(x => x.out > 0).sort((a, b) => (a.i.due_date || a.i.issue_date).localeCompare(b.i.due_date || b.i.issue_date));
}
function renderPayment(sh) {
  const d = pd, e = entityById(d.entity_id), opens = d.party_id ? openInvoicesFor(e.id, d.direction, d.party_id, d.currency) : [], cc = d.currency || e.base_currency;
  const partyCcys = d.party_id ? [...new Set(fin.invoices.filter(i => i.entity_id === e.id && i.party_id === d.party_id && i.currency && i.status === "posted").map(i => i.currency))] : [];
  const alloc = r2(Object.values(d.alloc).reduce((s, v) => s + (Number(v) || 0), 0));
  sh.innerHTML = sheetHead(d.direction === "in" ? "Record money received" : "Record money paid", `${esc(e.name)} · ${e.base_currency} · recorded only when you save`) + `
  <form id="finPayment" class="sh-body" novalidate>
    <div class="grid2"><label class="field"><span>${d.direction === "in" ? "From" : "To"}</span><select class="input" id="fp-party">${partyOptions(e.id, d.party_id)}</select></label>
    <label class="field"><span>Date</span><input class="input" type="date" id="fp-date" value="${d.pay_date}"></label></div>
    <div class="grid2"><label class="field"><span>Currency</span><select class="input" id="fp-ccy">${ccyOptions(e.base_currency, d.currency, partyCcys)}</select></label>
      ${d.currency ? `<label class="field"><span>${d.direction === "in" ? "Reached the bank" : "Left the bank"} (${e.base_currency})</span><input class="input num" type="number" step="0.01" min="0.01" id="fp-base" value="${d.base_amount}" placeholder="from the bank advice"></label>` : `<span></span>`}</div>
    ${d.currency ? `<p class="hint">Enter both amounts from the bank advice. The difference from the rate on the ${d.direction === "in" ? "invoices" : "bills"} is posted as a realised exchange gain or loss — no rate is assumed.</p>` : ""}
    <div class="grid2"><label class="field"><span>Amount${d.currency ? ` (${d.currency})` : ""}</span><input class="input num" type="number" step="0.01" min="0.01" id="fp-amt" value="${d.amount}"></label>
    <label class="field"><span>${d.direction === "in" ? "Into" : "From"} account</span><select class="input" id="fp-acc">${moneyAccounts(e.id).map(a => `<option value="${a.id}" ${a.id === d.account_id ? "selected" : ""}>${esc(a.code + " " + a.name)}</option>`).join("")}</select></label></div>
    <div class="grid2"><label class="field"><span>Reference</span><input class="input" id="fp-ref" value="${esc(d.reference)}" placeholder="TT / cheque / receipt no."></label>
    <label class="field"><span>Note</span><input class="input" id="fp-memo" value="${esc(d.memo)}"></label></div>
    ${d.party_id ? (opens.length ? `<h3>Apply to ${d.direction === "in" ? "invoices" : "bills"}</h3><table class="rtable"><thead><tr><th>Number</th><th>Due</th><th class="num">Outstanding</th><th class="num">Apply</th></tr></thead><tbody>
      ${opens.map(x => `<tr><td>${esc(x.i.number)}</td><td>${x.i.due_date ? fmtDate(x.i.due_date) : "—"}</td><td class="num">${money(x.out, cc)}</td><td class="num"><input class="input sm num" type="number" step="0.01" min="0" max="${x.out}" data-alloc="${x.i.id}" value="${d.alloc[x.i.id] ?? ""}" style="width:8em"></td></tr>`).join("")}
      <tr class="total"><td colspan="3"><button type="button" class="btn sm" data-act="fp-auto">Fill oldest first</button></td><td class="num" id="fp-alloc">${money(alloc, cc)}</td></tr></tbody></table>
      <p class="hint">Anything not applied stays on the ${d.direction === "in" ? "customer's" : "supplier's"} account as ${d.direction === "in" ? "a credit" : "an advance"}.</p>` : `<p class="hint">No open ${d.currency ? d.currency + " " : ""}${d.direction === "in" ? "invoices" : "bills"} for them — the payment will sit on their account.</p>`) : `<p class="hint">Choose who it's ${d.direction === "in" ? "from" : "to"} to apply it to ${d.direction === "in" ? "invoices" : "bills"}.</p>`}
    <div class="sheet-foot"><button class="btn primary block" type="submit" id="fpSave">Record payment</button></div>
  </form>`;
}
function syncPayment() { if (!pd || !$("fp-date")) return; const base = entityById(pd.entity_id).base_currency, cc = val("fp-ccy");
  Object.assign(pd, { currency: cc && cc !== base ? cc : "", base_amount: $("fp-base") ? val("fp-base") : pd.base_amount, party_id: val("fp-party"), pay_date: val("fp-date"), amount: val("fp-amt"), account_id: val("fp-acc"), reference: val("fp-ref"), memo: val("fp-memo") });
  document.querySelectorAll("[data-alloc]").forEach(i => { pd.alloc[i.dataset.alloc] = i.value; }); }
async function submitPayment() {
  syncPayment();
  const amt = r2(pd.amount);
  if (!amt || amt <= 0) return toastError("Enter the amount.");
  const allocations = Object.entries(pd.alloc).map(([invoice_id, a]) => ({ invoice_id, amount: r2(a) })).filter(a => a.amount > 0);
  if (r2(allocations.reduce((s, a) => s + a.amount, 0)) > amt) return toastError("You've applied more than the payment amount.");
  if (pd.currency && !(r2(pd.base_amount) > 0)) return toastError(`Enter what ${pd.direction === "in" ? "reached" : "left"} the bank in ${entityById(pd.entity_id).base_currency}.`);
  if (pd.currency && !pd.party_id) return toastError("Choose who the payment is " + (pd.direction === "in" ? "from." : "to."));
  const btn = $("fpSave"); busy(btn, true);
  const r = pd.currency ? await recordFxPayment({ ...pd, amount: amt, base_amount: r2(pd.base_amount), allocations }) : await recordPayment({ ...pd, amount: amt, allocations });
  busy(btn, false);
  if (r.error) return toastError(r.error);
  pd = null; await done("Payment recorded");
}
function renderPaymentView(sh, id) {
  const p = paymentById(id), e = entityById(p.entity_id), w = canWriteFin(e.id);
  const allocs = fin.allocations.filter(a => a.payment_id === p.id);
  sh.innerHTML = sheetHead(p.direction === "in" ? "Money received" : "Money paid", `${esc(e.name)} · ${fmtDate(p.pay_date)}`) + `<div class="sh-body">
    <div class="inv-head"><b class="num big">${money(p.currency ? p.base_amount : p.amount, e.base_currency)}</b>${p.currency ? `<small class="hint">${money(p.amount, p.currency)} at ${Number(p.fx_rate)}</small>` : ""}${p.status === "void" ? `<span class="pill inv-void">Void</span>` : ""}</div>
    ${p.status === "void" ? `<div class="banner warn">Void: ${esc(p.void_reason || "")}</div>` : ""}
    <dl class="kv"><dt>${p.direction === "in" ? "From" : "To"}</dt><dd>${esc((partyById(p.party_id) || {}).name || "—")}</dd><dt>Account</dt><dd>${esc((accById(p.account_id) || {}).name || "")}</dd>
      ${p.reference ? `<dt>Reference</dt><dd>${esc(p.reference)}</dd>` : ""}${p.memo ? `<dt>Note</dt><dd>${esc(p.memo)}</dd>` : ""}${p.currency && Number(p.fx_gain) ? `<dt>Realised exchange ${Number(p.fx_gain) > 0 ? "gain" : "loss"}</dt><dd class="${Number(p.fx_gain) > 0 ? "ok-text" : "bad-text"}">${money(Math.abs(p.fx_gain), e.base_currency)}</dd>` : ""}<dt>Journal</dt><dd><button class="linkbtn" data-act="fin-open-journal" data-id="${p.journal_id}">#${(journalById(p.journal_id) || {}).number || ""}</button></dd></dl>
    ${allocs.length ? `<h3>Applied to</h3><ul class="plain">${allocs.map(a => { const i = invoiceById(a.invoice_id); return `<li><button class="linkbtn" data-act="fin-open-invoice" data-id="${a.invoice_id}">${esc(i ? i.number : "")}</button> — ${money(a.amount, p.currency || e.base_currency)}</li>`; }).join("")}</ul>` : ""}
    ${filesPanel(e.id, "payment_id", p.id)}
    ${w && p.status === "posted" ? `<div class="sheet-foot"><button class="btn danger" data-act="fin-void-payment" data-id="${p.id}">Void payment</button></div>` : ""}</div>`;
}

/* ======================= accounts, ledger, parties, items ======================= */
function openAccount(id) {
  const e = curEntity(), a = id ? accById(id) : { code: "", name: "", type: "expense", subtype: "other", is_active: true, description: "" };
  const used = id && fin.lines.some(l => l.account_id === id);
  openSheet(sh => { sh.innerHTML = sheetHead(id ? "Edit account" : "New account", esc(e.name)) + `<form id="finAccount" class="sh-body" data-id="${id || ""}" novalidate>
    <div class="grid2"><label class="field"><span>Code</span><input class="input" id="fa-code" value="${esc(a.code)}" placeholder="e.g. 6150"></label><label class="field"><span>Name</span><input class="input" id="fa-name" value="${esc(a.name)}"></label></div>
    <div class="grid2"><label class="field"><span>Type</span><select class="input" id="fa-type" ${used || a.system_key ? "disabled" : ""}>${Object.entries(ACCOUNT_TYPES).map(([k, l]) => `<option value="${k}" ${a.type === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <label class="field"><span>Kind</span><select class="input" id="fa-sub" ${a.system_key ? "disabled" : ""}>${Object.entries(SUBTYPE_LABEL).map(([k, l]) => `<option value="${k}" ${a.subtype === k ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
    ${used ? `<p class="hint">This account has entries, so its type can't change.</p>` : ""}${a.system_key ? `<p class="hint">System account used by invoices, payments or stock — it can be renamed but not removed.</p>` : ""}
    <label class="field"><span>Notes</span><input class="input" id="fa-desc" value="${esc(a.description || "")}"></label>
    ${id && !a.system_key ? `<label class="check"><input type="checkbox" id="fa-active" ${a.is_active ? "checked" : ""}> Active</label>` : ""}
    <div class="sheet-foot"><button class="btn primary" type="submit" id="faSave">Save</button>${id && !used && !a.system_key ? `<button type="button" class="btn danger" data-act="fin-account-del" data-id="${id}">${ICON.trash}Delete</button>` : ""}</div></form>`; });
}
function openLedger(id) {
  const a = accById(id), e = entityById(a.entity_id), u = ui();
  const [from, to] = periodRange(e, u.period, { from: u.from, to: u.to });
  openSheet(sh => { const g = ledger(a, linesOf(e.id), from, to);
    sh.innerHTML = sheetHead(`${a.code} ${a.name}`, `${esc(e.name)} · ${fmtDate(from)} – ${fmtDate(to)} · change the period on the Reports tab`) + `<div class="sh-body">
    <table class="rtable"><thead><tr><th>Date</th><th>#</th><th>Description</th><th class="num">In / debit</th><th class="num">Out / credit</th><th class="num">Balance</th></tr></thead><tbody>
      <tr class="muted"><td colspan="5">Opening balance</td><td class="num">${money(g.opening)}</td></tr>
      ${g.rows.map(r => `<tr class="clickrow" data-act="fin-open-journal" data-id="${r.line.journal_id}"><td>${fmtDate(r.line.entry_date)}</td><td class="num">${r.line.journal.number}</td><td>${esc(r.line.description || r.line.journal.memo)}${r.line.statement_line_id ? " ✓" : ""}</td>
        <td class="num">${Number(r.line.debit) ? money(r.line.debit) : ""}</td><td class="num">${Number(r.line.credit) ? money(r.line.credit) : ""}</td><td class="num">${money(r.balance)}</td></tr>`).join("")}
      <tr class="total"><td colspan="5">Closing balance</td><td class="num">${money(g.closing, e.base_currency)}</td></tr></tbody></table>
    <p class="hint">✓ = matched to a bank statement line.</p></div>`; }, { wide: true });
}
function openParty(id, quick) {
  const e = curEntity(), p = id ? partyById(id) : { name: "", kind: idraft ? (idraft.kind === "sale" ? "customer" : "supplier") : "customer", email: "", phone: "", notes: "" };
  openSheet(sh => { sh.innerHTML = sheetHead(id ? "Edit" : "Add customer / supplier", esc(e.name)) + `<form id="finParty" class="sh-body" data-id="${id || ""}" data-quick="${quick ? 1 : ""}" novalidate>
    <div class="grid2"><label class="field"><span>Name</span><input class="input" id="fpa-name" value="${esc(p.name)}" autofocus></label>
    <label class="field"><span>Type</span><select class="input" id="fpa-kind">${["customer", "supplier", "partner", "employee", "other"].map(k => `<option ${p.kind === k ? "selected" : ""}>${k}</option>`).join("")}</select></label></div>
    <div class="grid2"><label class="field"><span>Email</span><input class="input" type="email" id="fpa-email" value="${esc(p.email || "")}"></label><label class="field"><span>Phone</span><input class="input" id="fpa-phone" value="${esc(p.phone || "")}"></label></div>
    <label class="field"><span>Notes</span><input class="input" id="fpa-notes" value="${esc(p.notes || "")}"></label>
    <div class="sheet-foot"><button class="btn primary" type="submit" id="fpaSave">Save</button>${id ? `<button type="button" class="btn" data-act="fin-party-archive" data-id="${id}">Archive</button>` : ""}</div></form>`; });
}
function openItem(id) {
  const e = curEntity(), it = id ? itemById(id) : { sku: "", name: "", unit: "pc", sale_price: "" };
  const s = id ? stockOf(id) : null, moves = id ? fin.moves.filter(m => m.item_id === id).slice(-30).reverse() : [];
  openSheet(sh => { sh.innerHTML = sheetHead(id ? it.name : "New stock item", esc(e.name)) + `<form id="finItem" class="sh-body" data-id="${id || ""}" novalidate>
    <div class="grid3"><label class="field"><span>Name</span><input class="input" id="fit-name" value="${esc(it.name)}"></label><label class="field"><span>SKU</span><input class="input" id="fit-sku" value="${esc(it.sku || "")}"></label>
    <label class="field"><span>Unit</span><input class="input" id="fit-unit" value="${esc(it.unit)}" placeholder="pc, m, kg"></label></div>
    <label class="field"><span>Usual selling price <small>(optional)</small></span><input class="input num" type="number" step="0.01" min="0" id="fit-price" value="${it.sale_price ?? ""}"></label>
    <div class="sheet-foot"><button class="btn primary" type="submit" id="fitSave">Save</button></div></form>
    ${id ? `<div class="sh-body"><div class="tiles">${`<div class="tile"><span class="tn">${s.qty} ${esc(it.unit)}</span><span class="tl">On hand</span></div><div class="tile"><span class="tn">${money(s.avg, e.base_currency)}</span><span class="tl">Average cost</span></div><div class="tile"><span class="tn">${money(s.value, e.base_currency)}</span><span class="tl">Value</span></div>`}</div>
      ${canWriteFin(e.id) ? `<form id="finStockAdj" class="review-form" data-id="${id}"><h3>Stock count / opening stock</h3><div class="grid3">
        <label class="field"><span>Kind</span><select class="input" id="fsa-kind"><option value="opening">Opening stock (adds, against opening equity)</option><option value="adjustment">Count correction (+/−, against cost of sales)</option></select></label>
        <label class="field"><span>Quantity (+ in / − out)</span><input class="input num" type="number" step="0.001" id="fsa-qty"></label><label class="field"><span>Unit cost (for additions)</span><input class="input num" type="number" step="0.01" min="0" id="fsa-cost"></label></div>
        <div class="grid2"><label class="field"><span>Date</span><input class="input" type="date" id="fsa-date" value="${today()}"></label><label class="field"><span>Reason</span><input class="input" id="fsa-reason" placeholder="e.g. Physical count 30 Oct"></label></div>
        <button class="btn" type="submit">Post adjustment</button></form>` : ""}
      <h3>Movements</h3>${moves.length ? `<table class="rtable"><tbody>${moves.map(m => `<tr><td>${fmtDate(m.move_date)}</td><td>${esc(m.source)}${m.note ? " · " + esc(m.note) : ""}</td><td class="num">${Number(m.qty) > 0 ? "+" : ""}${Number(m.qty)}</td><td class="num">${money(m.unit_cost)}</td></tr>`).join("")}</tbody></table>` : `<p class="calm">No movements yet.</p>`}</div>` : ""}`; }, { wide: !!id });
}

/* ======================= bank statement import ======================= */
let importRows = null;
async function previewImport(file) {
  const e = curEntity(), acc = bankingAccount(e);
  const text = await file.text(), p = parseStatementCSV(text);
  importRows = { rows: p.rows, errors: p.errors, account: acc };
  const existing = new Set(fin.statement.filter(s => s.account_id === acc.id).map(s => `${s.line_date}|${r2(s.amount)}|${s.description}|${s.reference || ""}`));
  importRows.rows.forEach(r => { r.dupe = existing.has(`${r.line_date}|${r2(r.amount)}|${r.description}|${r.reference || ""}`); });
  openSheet(sh => { const fresh = importRows.rows.filter(r => !r.dupe);
    sh.innerHTML = sheetHead("Import statement", `${esc(acc.name)} · ${esc(file.name)}`) + `<div class="sh-body">
    <p>${importRows.rows.length} lines read · <b>${fresh.length} new</b>${importRows.rows.length - fresh.length ? ` · ${importRows.rows.length - fresh.length} already imported (skipped)` : ""}${importRows.errors.length ? ` · ${importRows.errors.length} unreadable` : ""}.</p>
    ${importRows.errors.length ? `<details><summary>Unreadable rows</summary><ul class="plain">${importRows.errors.slice(0, 20).map(x => `<li class="bad-text">${esc(x)}</li>`).join("")}</ul></details>` : ""}
    <p class="hint">Dates are read day-first (e.g. 05/10/2026 = 5 October). Money in is positive, money out negative. Check a few lines before importing.</p>
    <div class="tablewrap"><table class="rtable"><thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th></tr></thead><tbody>${importRows.rows.slice(0, 50).map(r => `<tr class="${r.dupe ? "muted" : ""}"><td>${fmtDate(r.line_date)}</td><td>${esc(r.description)}</td><td class="num ${r.amount < 0 ? "bad-text" : "ok-text"}">${money(r.amount)}</td></tr>`).join("")}</tbody></table></div>
    ${importRows.rows.length > 50 ? `<p class="hint">…and ${importRows.rows.length - 50} more.</p>` : ""}
    <div class="sheet-foot"><button class="btn primary" data-act="fin-import-go" ${fresh.length ? "" : "disabled"}>Import ${fresh.length} lines</button></div></div>`; }, { wide: true });
}
async function doImport(btn) {
  const e = curEntity(), batch = crypto.randomUUID(), rows = importRows.rows.filter(r => !r.dupe).map(r => ({ entity_id: e.id, account_id: importRows.account.id, line_date: r.line_date, description: r.description.slice(0, 300), amount: r.amount, reference: r.reference, import_batch: batch }));
  busy(btn, true, "Importing…");
  for (let i = 0; i < rows.length; i += 200) { const r = await run(sb.from("fin_statement_lines").insert(rows.slice(i, i + 200))); if (r.error) { busy(btn, false); await refresh(); return toastError(r.error); } }
  busy(btn, false); importRows = null; await done(`${rows.length} lines imported`);
}
function openStatementEntry(id, preAcc) {
  const s = fin.statement.find(x => x.id === id), e = entityById(s.entity_id);
  openSheet(sh => { sh.innerHTML = sheetHead("Create entry from statement", `${esc(s.description)} · ${money(s.amount, e.base_currency)}`) + `<form id="finStmtEntry" class="sh-body" data-id="${id}" novalidate>
    <p class="hint">Posts an entry on ${fmtDate(s.line_date)} between ${esc((accById(s.account_id) || {}).name)} and the account you choose, then matches it to this line.</p>
    <label class="field"><span>${s.amount < 0 ? "What was it for?" : "What was it?"}</span><select class="input" id="fse-acc">${accOptions(e.id, preAcc || null, a => a.id !== s.account_id)}</select></label>${preAcc ? `<p class="hint">✨ Account suggested by AI — change it if it's wrong.</p>` : ""}
    <label class="field"><span>Description</span><input class="input" id="fse-memo" value="${esc(s.description)}"></label>
    <div class="sheet-foot"><button class="btn primary block" type="submit" id="fseSave">Post & match</button></div></form>`; });
}

/* ======================= CSV export of the current report ======================= */
function exportReportCSV() {
  const e = curEntity(), u = ui(), [from, to] = periodRange(e, u.period, { from: u.from, to: u.to }), accs = accountsOf(e.id), ls = linesOf(e.id);
  let rows = [], cols = [{ key: "a", label: "Line" }, { key: "b", label: "Amount" }];
  const add = (a, b) => rows.push({ a, b: b === "" ? "" : r2(b) }), accRow = r => add(`${r.account.code} ${r.account.name}`, r.amount);
  if (u.report === "pl") { const p = profitAndLoss(accs, ls, from, to); add("INCOME", ""); p.income.forEach(accRow); add("Total income", p.totalIncome); if (p.cogs.length) { add("COST OF GOODS SOLD", ""); p.cogs.forEach(accRow); add("Gross profit", p.grossProfit); } add("EXPENSES", ""); p.expenses.forEach(accRow); add("Total expenses", p.totalExpenses); add("Net profit", p.netProfit); }
  else if (u.report === "bs") { const b = balanceSheet(accs, ls, to); add("ASSETS", ""); b.assets.forEach(accRow); add("Total assets", b.totalAssets); add("LIABILITIES", ""); b.liabilities.forEach(accRow); add("Total liabilities", b.totalLiabilities); add("EQUITY", ""); b.equity.forEach(accRow); add("Current earnings", b.earnings); add("Total equity", b.totalEquity); }
  else if (u.report === "cf") { const c = cashFlow(accs, ls, from, to); add("Opening cash", c.opening); for (const k of ["operating", "investing", "financing"]) { add(`${k} in`, c[k].in); add(`${k} out`, -c[k].out); add(`${k} net`, c[k].net); } add("Closing cash", c.closing); }
  else if (u.report === "tb") { const t = trialBalance(accs, ls, to); cols = [{ key: "a", label: "Account" }, { key: "d", label: "Debit" }, { key: "c", label: "Credit" }]; rows = t.rows.map(r => ({ a: `${r.account.code} ${r.account.name}`, d: r.debit || "", c: r.credit || "" })); rows.push({ a: "Total", d: t.debit, c: t.credit }); }
  else if (u.report === "ar" || u.report === "ap") { const a = aging(fin.invoices.filter(i => i.entity_id === e.id && i.kind === (u.report === "ar" ? "sale" : "purchase")), fin.totals, to);
    cols = [{ key: "n", label: "Number" }, { key: "p", label: "Party" }, { key: "d", label: "Due" }, { key: "l", label: "Days late" }, { key: "o", label: "Outstanding" }];
    rows = a.rows.map(r => ({ n: r.invoice.number, p: (partyById(r.invoice.party_id) || {}).name, d: r.invoice.due_date || "", l: r.days ?? "", o: r.outstanding })); }
  else { cols = [{ key: "acc", label: "Account" }, { key: "date", label: "Date" }, { key: "no", label: "Entry" }, { key: "desc", label: "Description" }, { key: "dr", label: "Debit" }, { key: "cr", label: "Credit" }, { key: "bal", label: "Balance" }];
    for (const a of accs) { const g = ledger(a, ls, from, to); g.rows.forEach(r => rows.push({ acc: `${a.code} ${a.name}`, date: r.line.entry_date, no: r.line.journal.number, desc: r.line.description || r.line.journal.memo, dr: Number(r.line.debit) || "", cr: Number(r.line.credit) || "", bal: r.balance })); } }
  const csv = toCSV(rows, cols), url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const aEl = document.createElement("a"); aEl.href = url; aEl.download = `${e.name.replace(/\W+/g, "-")}-${REPORTS[u.report].replace(/\W+/g, "-")}-${to}.csv`; document.body.appendChild(aEl); aEl.click(); aEl.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ======================= event handlers ======================= */
export async function handleFinClick(act, el, rerender) {
  const id = el.dataset.id, e = curEntity();
  switch (act) {
    case "fin-new-entity": openNewEntity(); return true;
    case "fin-rates": await openRates(); return true;
    case "fin-quick": openQuick(el.dataset.kind); return true;
    case "fin-new-entry": openJournal(null); return true;
    case "fin-open-journal": openJournal(id); return true;
    case "fin-opening": openOpening(); return true;
    case "fj-add": syncJournalHead(); jd.lines.push({}); rerenderSheet(); return true;
    case "fj-del": syncJournalHead(); jd.lines.splice(+el.dataset.i, 1); if (jd.lines.length < 2) jd.lines.push({}); rerenderSheet(); return true;
    case "fj-balance": { syncJournalHead(); const t = entryTotals(jd.lines), last = jd.lines[jd.lines.length - 1];
      if (t.diff > 0) { last.credit = r2((Number(last.credit) || 0) + t.diff); last.debit = 0; } else { last.debit = r2((Number(last.debit) || 0) - t.diff); last.credit = 0; }
      if (Number(last.debit) && Number(last.credit)) { const n = r2(last.debit - last.credit); last.debit = n > 0 ? n : 0; last.credit = n < 0 ? -n : 0; }
      rerenderSheet(); return true; }
    case "fj-delete": if (!(await dialog({ title: "Delete this draft?", confirm: "Delete", danger: true }))) return true;
      { const r = await deleteDraftJournal(jd.id); if (r.error) return toastError(r.error), true; jd = null; await done("Draft deleted"); } return true;
    case "fin-reverse": { const j = journalById(id);
      const reason = await dialog({ title: `Reverse entry #${j.number}?`, text: "A mirror-image entry will be posted; the original stays on record. Give a reason (it's saved in the history).", input: { label: "Reason", required: true }, confirm: "Reverse" });
      if (!reason) return true;
      const r = await reverseJournal(id, reason, null); if (r.error) return toastError(r.error), true; await done("Reversed"); return true; }
    case "fin-new-invoice": openInvoice(null, el.dataset.kind); return true;
    case "fin-open-invoice": openInvoice(id); return true;
    case "fi-add": syncInvoiceHead(); idraft.lines.push({ qty: 1 }); rerenderSheet(); return true;
    case "fi-del": syncInvoiceHead(); idraft.lines.splice(+el.dataset.i, 1); if (!idraft.lines.length) idraft.lines.push({ qty: 1 }); rerenderSheet(); return true;
    case "fi-delete": if (!(await dialog({ title: "Delete this draft?", confirm: "Delete", danger: true }))) return true;
      { const r = await run(sb.from("fin_invoices").delete().eq("id", idraft.id)); if (r.error) return toastError(r.error), true; idraft = null; await done("Draft deleted"); } return true;
    case "fin-void-invoice": { const i = invoiceById(id);
      const reason = await dialog({ title: `Void ${i.number}?`, text: "Its entry is reversed (and any stock returned). The invoice stays on record as void.", input: { label: "Reason", required: true }, confirm: "Void", danger: true });
      if (!reason) return true; const r = await voidInvoice(id, reason); if (r.error) return toastError(r.error), true; await done("Voided", false); return true; }
    case "fin-pay": openPayment(el.dataset.dir, el.dataset.invoice); return true;
    case "fp-auto": { syncPayment(); let left = r2(pd.amount) || 0; pd.alloc = {};
      for (const x of openInvoicesFor(pd.entity_id, pd.direction, pd.party_id)) { if (left <= 0) break; const a = Math.min(left, x.out); pd.alloc[x.i.id] = r2(a); left = r2(left - a); }
      rerenderSheet(); return true; }
    case "fin-open-payment": openSheet(sh => renderPaymentView(sh, id)); return true;
    case "fin-void-payment": { const reason = await dialog({ title: "Void this payment?", text: "Its entry is reversed and the invoices it paid become outstanding again.", input: { label: "Reason", required: true }, confirm: "Void", danger: true });
      if (!reason) return true; const r = await voidPayment(id, reason); if (r.error) return toastError(r.error), true; await done("Payment voided"); return true; }
    case "fin-match": { const r = await matchStatement(el.dataset.st, el.dataset.line); if (r.error) return toastError(r.error), true; await refresh(); rerender(); toast("Matched"); return true; }
    case "fin-unmatch": { const s = fin.statement.find(x => x.id === id);
      const r = s.status === "ignored" ? await run(sb.from("fin_statement_lines").update({ status: "unmatched" }).eq("id", id)) : await unmatchStatement(id);
      if (r.error) return toastError(r.error), true; await refresh(); rerender(); return true; }
    case "fin-ignore": { const r = await run(sb.from("fin_statement_lines").update({ status: "ignored" }).eq("id", id)); if (r.error) return toastError(r.error), true; await refresh(); rerender(); return true; }
    case "fin-stmt-entry": openStatementEntry(id, el.dataset.acc); return true;
    case "fin-ai-cat": {
      const acc = bankingAccount(e), open = fin.statement.filter(x => x.account_id === acc.id && x.status === "unmatched").slice(0, 40);
      const btn = $("finAiCat"); busy(btn, true, "Thinking…");
      const r = await aiCall("categorize", { lines: open.map(x => ({ id: x.id, description: x.description, amount: Number(x.amount) })),
        accounts: accountsOf(e.id, a => a.is_active && a.id !== acc.id).map(a => ({ id: a.id, code: a.code, name: a.name, type: a.type })) }, { type: "fin_account", id: acc.id });
      busy(btn, false);
      if (r.error) return toastError(r.error), true;
      const u = ui(); u.suggest = Object.assign(u.suggest || {}, Object.fromEntries(r.data.suggestions.map(x => [x.id, { ...x, proposal_id: r.data.proposal_id || null }])));
      rerender(); toast(`${r.data.suggestions.length} suggestion${r.data.suggestions.length === 1 ? "" : "s"} — check each before posting`); return true;
    }
    case "fin-import-go": await doImport(el); return true;
    case "fin-account": openAccount(id); return true;
    case "fin-account-del": if (!(await dialog({ title: "Delete this account?", confirm: "Delete", danger: true }))) return true;
      { const r = await run(sb.from("fin_accounts").delete().eq("id", id)); if (r.error) return toastError(r.error), true; await done("Account deleted"); } return true;
    case "fin-ledger": openLedger(id); return true;
    case "fin-party": openParty(id, el.dataset.quick); return true;
    case "fin-party-archive": { const r = await run(sb.from("fin_parties").update({ archived: true }).eq("id", id)); if (r.error) return toastError(r.error), true; await done("Archived"); return true; }
    case "fin-item": openItem(id); return true;
    case "fin-file-open": { const f = fin.files.find(x => x.id === id), win = window.open("", "_blank"); const r = await finFileUrl(f);
      if (r.error) { if (win) win.close(); return toastError(r.error), true; } if (win) win.location = r.data; else location.href = r.data; return true; }
    case "fin-file-del": { const f = fin.files.find(x => x.id === id); if (!(await dialog({ title: `Delete "${f.title}"?`, confirm: "Delete", danger: true }))) return true;
      const r = await deleteFinFile(f); if (r.error) return toastError(r.error), true; rerenderSheet(); return true; }
    case "fin-bmonth": ui().budgetMonth = el.dataset.m; rerender(); return true;
    case "fin-bcopy": { const u = ui(), m = u.budgetMonth || monthStart(today());
      const src = fin.budgets.filter(b => b.entity_id === e.id && b.month === m); if (!src.length) return toastError("Save a budget for this month first."), true;
      const fs = periodRange(e, "fy")[0], [fy, fm] = fs.split("-").map(Number), nextFy = `${fy + 1}-${String(fm).padStart(2, "0")}-01`;
      const months = monthsBetween(monthStart(addDays(monthEnd(m), 1)), monthStart(addDays(nextFy, -1)));
      if (!months.length) return toastError("This is the last month of the financial year."), true;
      if (!(await dialog({ title: "Copy budget?", text: `Copies this month's ${src.length} budget lines to ${months.length} later month(s) in the financial year, replacing what's there.`, confirm: "Copy" }))) return true;
      const rows = months.flatMap(mo => src.map(b => ({ entity_id: e.id, account_id: b.account_id, month: mo, amount: b.amount })));
      const r = await run(sb.from("fin_budgets").upsert(rows, { onConflict: "account_id,month" })); if (r.error) return toastError(r.error), true; await refresh(); rerender(); toast("Budget copied"); return true; }
    case "fin-csv": exportReportCSV(); return true;
    case "fin-archive": { const r = await run(sb.from("fin_entities").update({ archived: !e.archived }).eq("id", e.id)); if (r.error) return toastError(r.error), true; await refresh(); rerender(); return true; }
    case "fin-remove-member": if (!(await dialog({ title: `Remove ${nameOf(el.dataset.user)} from these books?`, confirm: "Remove", danger: true }))) return true;
      { const r = await run(sb.from("fin_members").delete().eq("entity_id", e.id).eq("user_id", el.dataset.user)); if (r.error) return toastError(r.error), true; await refresh(); rerender(); } return true;
    case "fin-audit": { const r = await loadAudit(e.id); if (r.error) return toastError(r.error), true; $("finAudit").innerHTML = auditHtml(e); return true; }
  }
  return false;
}
export async function handleFinChange(ev, rerender) {
  const t = ev.target, u = ui();
  if (t.dataset && t.dataset.jl !== undefined && jd) { const l = jd.lines[+t.dataset.jl]; l[t.dataset.f] = t.value;
    if (t.dataset.f === "debit" && Number(t.value)) { l.credit = 0; const o = document.querySelector(`[data-jl="${t.dataset.jl}"][data-f="credit"]`); if (o) o.value = ""; }
    if (t.dataset.f === "credit" && Number(t.value)) { l.debit = 0; const o = document.querySelector(`[data-jl="${t.dataset.jl}"][data-f="debit"]`); if (o) o.value = ""; }
    journalTotalsLive(); return true; }
  if (t.dataset && t.dataset.il !== undefined && idraft) { const l = idraft.lines[+t.dataset.il]; l[t.dataset.f] = t.value;
    if (t.dataset.f === "item_id") { // only picking a stock item changes the form's shape; typing never re-draws it (keeps focus)
      syncInvoiceHead();
      if (t.value) { const it = itemById(t.value); if (!l.description) l.description = it.name; if (idraft.kind === "sale" && !l.unit_price && it.sale_price) l.unit_price = it.sale_price; }
      rerenderSheet(); }
    else invoiceTotalLive();
    return true; }
  if ((t.id === "fp-party" || t.id === "fp-ccy") && pd) { syncPayment(); pd.alloc = {}; rerenderSheet(); return true; }
  if (t.id === "fi-ccy" && idraft) { syncInvoiceHead(); if (!idraft.currency) idraft.fx_rate = ""; rerenderSheet(); return true; }
  if (t.dataset && t.dataset.alloc !== undefined && pd) { syncPayment(); const a = r2(Object.values(pd.alloc).reduce((s, v) => s + (Number(v) || 0), 0)); if ($("fp-alloc")) $("fp-alloc").textContent = money(a, pd.currency || entityById(pd.entity_id).base_currency); return true; }
  if (t.dataset && t.dataset.act === "fin-attach") { const f = t.files[0]; if (!f) return true; toast(`Uploading ${f.name}…`);
    const r = await uploadFinFile(f, t.dataset.entity, { [t.dataset.field]: t.dataset.id }, safeFileName); t.value = ""; if (r.error) return toastError(r.error), true; toast("Attached"); rerenderSheet(); return true; }
  if (t.dataset && t.dataset.act === "fin-role") { const e = curEntity(); const r = await run(sb.from("fin_members").update({ role: t.value }).eq("entity_id", e.id).eq("user_id", t.dataset.user)); if (r.error) toastError(r.error); await refresh(); rerender(); return true; }
  const map = { "fj-status": "jstatus", "fi-status": "invStatus", "fb-acc": "bankAcc", "fr-report": "report", "fr-period": "period", "fr-from": "from", "fr-to": "to" };
  if (map[t.id]) { u[map[t.id]] = t.value; rerender(); return true; }
  if (t.id === "fb-file") { const f = t.files[0]; t.value = ""; if (f) await previewImport(f); return true; }
  return false;
}
export function handleFinInput(ev, keepFocus) {
  const t = ev.target;
  if (t.id === "fj-q") { ui().jq = t.value; keepFocus("fj-q"); return true; }
  if (t.dataset && t.dataset.jl !== undefined && jd && ["debit", "credit", "description"].includes(t.dataset.f)) { jd.lines[+t.dataset.jl][t.dataset.f] = t.value; journalTotalsLive(); return true; }
  if (t.dataset && t.dataset.il !== undefined && idraft && ["qty", "unit_price", "description"].includes(t.dataset.f)) {
    idraft.lines[+t.dataset.il][t.dataset.f] = t.value; invoiceTotalLive(); return true; }
  return false;
}
export async function handleFinSubmit(form, rerender, submitter) {
  const post = submitter && submitter.dataset.post === "1";
  switch (form.id) {
    case "finNewEntity": { const name = val("ne-name"); if (!name) return toastError("Name the books."), true;
      const btn = $("neSave"); busy(btn, true);
      const r = await run(sb.from("fin_entities").insert({ name, kind: val("ne-kind"), base_currency: val("ne-ccy"), workspace_id: val("ne-ws") || null }).select().single());
      busy(btn, false); if (r.error) return toastError(r.error), true;
      await refresh(); closeSheet(); location.hash = `#/finance/${r.data.id}/overview`; toast("Books created"); return true; }
    case "finQuick": await submitQuick(form, post); return true;
    case "finJournal": await submitJournal(post, submitter); return true;
    case "finOpening": submitOpening(); return true;
    case "finInvoice": await submitInvoice(post, submitter); return true;
    case "finInvMeta": { const due = val("im-due") || null, inv = invoiceById(form.dataset.id);
      if (due && due < inv.issue_date) return toastError("The due date is before the invoice date."), true;
      const r = await run(sb.from("fin_invoices").update({ due_date: due, notes: val("im-notes") || null, task_id: val("im-task") || null }).eq("id", form.dataset.id));
      if (r.error) return toastError(r.error), true; await done("Saved", false); return true; }
    case "finPayment": await submitPayment(); return true;
    case "finAccount": { const e = curEntity(), id = form.dataset.id;
      const row = { code: val("fa-code"), name: val("fa-name"), description: val("fa-desc") || null };
      if (!$("fa-type").disabled) row.type = val("fa-type"); if (!$("fa-sub").disabled) row.subtype = val("fa-sub"); if ($("fa-active")) row.is_active = $("fa-active").checked;
      if (!row.code || !row.name) return toastError("Enter a code and a name."), true;
      const btn = $("faSave"); busy(btn, true);
      const r = id ? await run(sb.from("fin_accounts").update(row).eq("id", id)) : await run(sb.from("fin_accounts").insert({ ...row, entity_id: e.id }));
      busy(btn, false); if (r.error) return toastError(/duplicate/.test(r.error) ? "That code is already used in these books." : r.error), true; await done("Account saved"); return true; }
    case "finParty": { const e = curEntity(), id = form.dataset.id, row = { name: val("fpa-name"), kind: val("fpa-kind"), email: val("fpa-email") || null, phone: val("fpa-phone") || null, notes: val("fpa-notes") || null };
      if (!row.name) return toastError("Enter a name."), true;
      const r = id ? await run(sb.from("fin_parties").update(row).eq("id", id).select().single()) : await run(sb.from("fin_parties").insert({ ...row, entity_id: e.id }).select().single());
      if (r.error) return toastError(r.error), true;
      await refresh(); closeSheet();
      if (form.dataset.quick && idraft) { idraft.party_id = r.data.id; rerenderSheet(); } else rerender();
      toast("Saved"); return true; }
    case "finItem": { const e = curEntity(), id = form.dataset.id, row = { name: val("fit-name"), sku: val("fit-sku") || null, unit: val("fit-unit") || "pc", sale_price: num("fit-price") };
      if (!row.name) return toastError("Enter a name."), true;
      const r = id ? await run(sb.from("fin_items").update(row).eq("id", id)) : await run(sb.from("fin_items").insert({ ...row, entity_id: e.id }));
      if (r.error) return toastError(/duplicate/.test(r.error) ? "That SKU is already used." : r.error), true; await done("Item saved"); return true; }
    case "finStockAdj": { const q = num("fsa-qty"), reason = val("fsa-reason");
      if (!q) return toastError("Enter a quantity."), true; if (!reason) return toastError("Give a reason."), true;
      const r = await stockAdjust({ item_id: form.dataset.id, date: val("fsa-date"), qty: q, unit_cost: num("fsa-cost"), kind: val("fsa-kind"), reason });
      if (r.error) return toastError(r.error), true; await done("Stock adjusted", false); return true; }
    case "finStmtEntry": { const s = fin.statement.find(x => x.id === form.dataset.id), acc = val("fse-acc"), amt = Math.abs(Number(s.amount));
      if (!acc) return toastError("Choose an account."), true;
      const btn = $("fseSave"); busy(btn, true);
      const lines = s.amount > 0 ? [{ account_id: s.account_id, debit: amt }, { account_id: acc, credit: amt }] : [{ account_id: acc, debit: amt }, { account_id: s.account_id, credit: amt }];
      const r = await saveJournal({ entity_id: s.entity_id, entry_date: s.line_date, memo: val("fse-memo") || s.description, reference: s.reference }, lines, true);
      if (r.error) { busy(btn, false); return toastError(r.error), true; }
      await refresh();
      const line = fin.lines.find(l => l.journal_id === r.data.id && l.account_id === s.account_id);
      const m = await matchStatement(s.id, line.id); busy(btn, false);
      const sug = (ui().suggest || {})[s.id];
      if (sug && sug.proposal_id) { aiDecision(sug.proposal_id, sug.account_id === acc ? "accepted" : "edited", { line: s.id, suggested: sug.account_id, chosen: acc }); delete ui().suggest[s.id]; }
      if (m.error) toastError(m.error); await done("Posted and matched"); return true; }
    case "budgetForm": { const e = curEntity(), m = ui().budgetMonth || monthStart(today()), up = [], del = [];
      form.querySelectorAll('input[name^="b-"]').forEach(i => { const aid = i.name.slice(2); if (i.value === "") del.push(aid); else up.push({ entity_id: e.id, account_id: aid, month: m, amount: r2(i.value) }); });
      const btn = $("budgetSave"); busy(btn, true);
      if (up.length) { const r = await run(sb.from("fin_budgets").upsert(up, { onConflict: "account_id,month" })); if (r.error) { busy(btn, false); return toastError(r.error), true; } }
      if (del.length) await run(sb.from("fin_budgets").delete().eq("month", m).in("account_id", del));
      busy(btn, false); await refresh(); rerender(); toast("Budget saved"); return true; }
    case "finEntityForm": { const e = curEntity(), row = { name: val("fe-name"), fiscal_year_start: Number(val("fe-fy")), workspace_id: val("fe-ws") || null, lock_date: val("fe-lock") || null };
      if (row.lock_date !== (e.lock_date || null) && !(await dialog({ title: row.lock_date ? `Lock the books up to ${fmtDate(row.lock_date)}?` : "Remove the lock?", text: row.lock_date ? "No one will be able to post, reverse or void anything dated on or before this date." : "Entries in earlier periods could be posted again.", confirm: "Confirm" }))) return true;
      const r = await run(sb.from("fin_entities").update(row).eq("id", e.id)); if (r.error) return toastError(r.error), true; await refresh(); rerender(); toast("Saved"); return true; }
    case "finMemberForm": { const e = curEntity(); const r = await addFinMember(e.id, val("fm-email"), val("fm-role")); if (r.error) return toastError(r.error), true; await refresh(); rerender(); toast("Added"); return true; }
  }
  return false;
}
export function finSheetReset() { jd = null; idraft = null; pd = null; importRows = null; }
