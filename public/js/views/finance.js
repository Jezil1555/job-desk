// Finance & CFO screens. Every figure is calculated from posted ledger entries in that entity's own books.
import { aiOn } from "../assist.js";
import { esc, todayISO, addDays, fmtDate, ago } from "../util.js";
import { state, nameOf, wsById } from "../store.js";
import { ICON, emptyState, section } from "../ui.js";
import { fin, entityById, accById, partyById, finRole, canWriteFin, isFinOwner, accountsOf, moneyAccounts, linesOf, linesOfJournal, stockOf, itemById } from "../finapi.js";
import { renderPartners } from "./partners.js";
import { renderIntercompany } from "./intercompany.js";
import { money, r2, ACCOUNT_TYPES, SUBTYPE_LABEL, trialBalance, profitAndLoss, balanceSheet, cashFlow, ledger, invoiceStatus, INVOICE_STATUS_LABEL, aging, AGING_LABEL,
  budgetVsActual, monthStart, monthEnd, monthsBetween, fiscalYearStart, convert, natural, matchCandidates } from "../finance.js";

export const FIN_TABS = { overview: "Overview", entries: "Entries", invoices: "Invoices", bills: "Bills", payments: "Payments", banking: "Banking", accounts: "Accounts",
  people: "Customers & suppliers", stock: "Stock", partners: "Partner accounts", intercompany: "Inter-entity", budgets: "Budgets", reports: "Reports", settings: "Settings" };
const BUSINESS_ONLY = new Set(["stock", "partners"]);
export const ui = () => (state.ui.fin = state.ui.fin || { period: "this_month", from: null, to: null, report: "pl", jq: "", jstatus: "", invStatus: "open", bankAcc: null, ledgerAcc: null, budgetMonth: null });
export const rates = () => Object.assign({ base: "QAR", INR: 26.10 }, state.prefs.fin_rates || {});
const today = () => todayISO(state.tz);
const M = (n, e) => money(n, e.base_currency);
const tile = (n, label, cls = "", href = "") => `<${href ? `a href="${href}"` : "div"} class="tile ${cls}"><span class="tn">${n}</span><span class="tl">${label}</span></${href ? "a" : "div"}>`;
const pill = (s, label) => `<span class="pill inv-${s}">${label || INVOICE_STATUS_LABEL[s] || s}</span>`;

export function periodRange(e, key, custom = {}) {
  const t = today(), ms = monthStart(t);
  switch (key) {
    case "last_month": { const lm = monthStart(addDays(ms, -1)); return [lm, monthEnd(lm), "Last month"]; }
    case "quarter": { const [y, m] = t.split("-").map(Number); const qs = `${y}-${String(m - ((m - 1) % 3)).padStart(2, "0")}-01`; return [qs, t, "This quarter"]; }
    case "fy": return [fiscalYearStart(t, e.fiscal_year_start), t, "Financial year to date"];
    case "last_fy": { const fs = fiscalYearStart(t, e.fiscal_year_start); const ls = fiscalYearStart(addDays(fs, -1), e.fiscal_year_start); return [ls, addDays(fs, -1), "Last financial year"]; }
    case "custom": return [custom.from || ms, custom.to || t, "Custom"];
    default: return [ms, t, "This month"];
  }
}

/* ======================= finance home: all books ======================= */
export function renderFinanceHome(view) {
  if (!fin.loaded) { view.innerHTML = fin.error ? `<div class="banner bad">Couldn't load your books. ${esc(fin.error.message || "")}</div>` : `<div class="loading"><div class="spinner"></div>Loading your books…</div>`; return; }
  const ents = fin.entities.filter(e => !e.archived), rt = rates();
  const cards = ents.map(e => {
    const ls = linesOf(e.id), bs = balanceSheet(accountsOf(e.id), ls, today());
    const [f, t] = periodRange(e, "this_month"), pl = profitAndLoss(accountsOf(e.id), ls, f, t);
    const cash = r2(accountsOf(e.id, a => ["cash", "bank"].includes(a.subtype)).reduce((s, a) => s + natural(a, ls.filter(l => l.account_id === a.id).reduce((x, l) => x + Number(l.debit) - Number(l.credit), 0)), 0));
    const owed = invTotalsOut(e.id, "sale"), owe = invTotalsOut(e.id, "purchase");
    const ws = e.workspace_id && wsById(e.workspace_id);
    return { e, cash, owed, owe, pl, bs, html: `<a class="fin-card" href="#/finance/${e.id}/overview">
      <div class="fc-h"><b>${esc(e.name)}</b><span class="chip">${e.base_currency}</span>${e.kind === "personal" ? `<span class="chip">${ICON.lock} Personal</span>` : ""}</div>
      ${ls.length ? `<dl class="fc-kv"><dt>Cash & bank</dt><dd>${M(cash, e)}</dd>
        ${e.kind === "personal" ? `<dt>Net worth</dt><dd>${M(bs.netWorth, e)}</dd><dt>This month</dt><dd class="${pl.netProfit < 0 ? "bad-text" : "ok-text"}">${M(pl.netProfit, e)} saved</dd>`
          : `<dt>Owed to you</dt><dd>${M(owed, e)}</dd><dt>You owe</dt><dd>${M(owe, e)}</dd><dt>Profit this month</dt><dd class="${pl.netProfit < 0 ? "bad-text" : "ok-text"}">${M(pl.netProfit, e)}</dd>`}</dl>`
        : `<p class="hint">No entries yet — start with opening balances.</p>`}
      <small class="hint">${ws ? "Linked to " + esc(ws.name) + " · " : ""}${esc(finRole(e.id) || "")}</small></a>` };
  });
  // consolidated view at the management rate (clearly labelled; never mixed into an entity's own books)
  const conv = cards.map(c => ({ c, cash: convert(c.cash, c.e.base_currency, rt.base, rt), nw: convert(c.bs.netWorth, c.e.base_currency, rt.base, rt) }));
  const missing = conv.filter(x => x.cash === null).map(x => x.c.e.base_currency);
  const totCash = r2(conv.reduce((s, x) => s + (x.cash || 0), 0)), totNW = r2(conv.reduce((s, x) => s + (x.nw || 0), 0));
  view.innerHTML = `
  <div class="page-head"><div><h1>Finance & CFO</h1><p class="sub">Separate books for each entity. Figures come only from posted entries.</p></div>
    <div class="btnrow"><button class="btn primary" data-act="fin-new-entity">${ICON.plus}New books</button></div></div>
  ${ents.length ? `
  <section class="sect"><div class="sect-h"><h2>All books combined</h2><span class="c">in ${rt.base} at management rates</span></div>
    <div class="tiles">${tile(money(totCash, rt.base), "Cash & bank")}${tile(money(totNW, rt.base), "Net position (assets − liabilities)")}</div>
    <p class="hint">Management rate: ${Object.entries(rt).filter(([k]) => k !== "base").map(([k, v]) => `${v} ${k} = 1 ${rt.base}`).join(", ")} · <button class="linkbtn" data-act="fin-rates">Change</button>
      ${missing.length ? ` · <b>No rate for ${[...new Set(missing)].join(", ")} — those books are left out of the total.</b>` : ""} For planning only; each entity's own books stay in its own currency.</p></section>
  <div class="fin-grid">${cards.map(c => c.html).join("")}</div>` :
  emptyState("No books yet", "Create separate books for Personal, Dlusso, Fitness Hub, The Burgery or any other entity. Each gets its own chart of accounts.", `<button class="btn primary" data-act="fin-new-entity">${ICON.plus}New books</button>`)}
  ${fin.entities.some(e => e.archived) ? section("Archived", `<ul class="plain">${fin.entities.filter(e => e.archived).map(e => `<li><a href="#/finance/${e.id}/overview">${esc(e.name)}</a></li>`).join("")}</ul>`) : ""}`;
}
function invTotalsOut(eid, kind) {
  return r2(fin.invoices.filter(i => i.entity_id === eid && i.kind === kind && i.status === "posted").reduce((s, i) => { const t = fin.totals.get(i.id); return s + (t ? Number(t.total) - Number(t.paid) : 0); }, 0));
}

/* ======================= one entity ======================= */
export function renderFinance(view, eid, tab = "overview", sub) {
  if (!fin.loaded) return renderFinanceHome(view);
  const e = entityById(eid);
  if (!e) { view.innerHTML = emptyState("Books not found", "They may have been removed, or you don't have access.", `<a class="btn" href="#/finance">All books</a>`); return; }
  if (!FIN_TABS[tab] || (BUSINESS_ONLY.has(tab) && e.kind === "personal")) tab = "overview";
  const w = canWriteFin(eid);
  const tabs = Object.entries(FIN_TABS).filter(([k]) => !(BUSINESS_ONLY.has(k) && e.kind === "personal")).map(([k, l]) => [k, e.kind === "personal" && k === "invoices" ? "Money owed to me" : e.kind === "personal" && k === "bills" ? "Bills" : l]);
  const body = { overview, entries, invoices: x => invoicesTab(x, "sale"), bills: x => invoicesTab(x, "purchase"), payments, banking, accounts, people, stock, partners: x => renderPartners(x, sub), intercompany: renderIntercompany, budgets, reports, settings }[tab](e);
  view.innerHTML = `
  <div class="page-head"><div><p class="crumb"><a href="#/finance">Finance</a></p><h1>${esc(e.name)} <span class="chip">${e.base_currency}</span></h1>
    <p class="sub">${e.kind === "personal" ? `${ICON.lock} Personal books` : "Business books"} · you are ${esc(finRole(eid) || "—")}${e.lock_date ? ` · locked to ${fmtDate(e.lock_date)}` : ""}${e.archived ? " · archived" : ""}</p></div>
    ${w ? `<div class="btnrow noprint"><button class="btn" data-act="fin-quick" data-kind="expense">${e.kind === "personal" ? "Spend" : "Expense"}</button><button class="btn" data-act="fin-quick" data-kind="income">Income</button>
      <button class="btn" data-act="fin-quick" data-kind="transfer">Transfer</button><button class="btn primary" data-act="fin-new-entry">${ICON.plus}Entry</button></div>` : ""}</div>
  <div class="viewtabs noprint fin-tabs">${tabs.map(([k, l]) => `<a href="#/finance/${eid}/${k}" class="${tab === k ? "on" : ""}">${l}</a>`).join("")}</div>
  ${body}`;
}

function overview(e) {
  const ls = linesOf(e.id), accs = accountsOf(e.id), t = today();
  if (!ls.length && !fin.journals.some(j => j.entity_id === e.id)) {
    return `<section class="sect getting-started"><div class="sect-h"><h2>Get these books started</h2></div><ol class="steps">
      <li><b>Opening balances.</b> Enter what's in each bank, cash, card and loan account today (and stock, receivables, payables for a business). <button class="btn sm" data-act="fin-opening">Enter opening balances</button></li>
      <li><b>Customers & suppliers.</b> Add the people you invoice and the suppliers who bill you. <a class="btn sm" href="#/finance/${e.id}/people">Add people</a></li>
      <li><b>Day to day.</b> Record spending and income with the buttons above, or raise invoices and bills; import bank statements to reconcile.</li></ol>
      <p class="hint">Nothing is entered for you. Every figure on these pages comes from entries you post.</p></section>`;
  }
  const [mf, mt] = periodRange(e, "this_month"), [ff] = periodRange(e, "fy");
  const pl = profitAndLoss(accs, ls, mf, mt), ply = profitAndLoss(accs, ls, ff, t), bs = balanceSheet(accs, ls, t);
  const bal = a => natural(a, ls.filter(l => l.account_id === a.id).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0));
  const moneyAccs = moneyAccounts(e.id).map(a => ({ a, b: bal(a) }));
  const inv = fin.invoices.filter(i => i.entity_id === e.id && i.status === "posted");
  const st = i => invoiceStatus(i, fin.totals.get(i.id), t), out = i => { const x = fin.totals.get(i.id); return x ? r2(Number(x.total) - Number(x.paid)) : 0; };
  const overdueInv = inv.filter(i => i.kind === "sale" && st(i) === "overdue"), billsDue = inv.filter(i => i.kind === "purchase" && out(i) > 0 && i.due_date && i.due_date <= addDays(t, 7));
  const drafts = fin.journals.filter(j => j.entity_id === e.id && j.status === "draft").length + fin.invoices.filter(i => i.entity_id === e.id && i.status === "draft").length;
  const unrec = fin.statement.filter(s => s.entity_id === e.id && s.status === "unmatched").length;
  const ar = invTotalsOut(e.id, "sale"), ap = invTotalsOut(e.id, "purchase");
  return `
  <div class="tiles">
    ${tile(M(moneyAccs.filter(x => x.a.subtype !== "card").reduce((s, x) => s + x.b, 0), e), "Cash & bank")}
    ${e.kind === "personal" ? tile(M(bs.netWorth, e), "Net worth") : tile(M(ar, e), "Owed to you", "", `#/finance/${e.id}/invoices`)}
    ${tile(M(ap, e), e.kind === "personal" ? "Bills to pay" : "You owe suppliers", billsDue.length ? "warn" : "", `#/finance/${e.id}/bills`)}
    ${tile(M(pl.netProfit, e), e.kind === "personal" ? "Saved this month" : "Profit this month", pl.netProfit < 0 ? "bad" : "ok")}
    ${tile(M(pl.totalIncome, e), "Income this month")}${tile(M(pl.totalExpenses + pl.totalCogs, e), e.kind === "personal" ? "Spent this month" : "Costs this month")}
    ${tile(M(ply.netProfit, e), e.kind === "personal" ? "Saved, year to date" : "Profit, year to date", ply.netProfit < 0 ? "bad" : "")}
    ${tile(unrec, "Bank lines to reconcile", unrec ? "warn" : "", `#/finance/${e.id}/banking`)}
  </div>
  ${!bs.balanced ? `<div class="banner bad">The balance sheet doesn't balance (difference ${M(bs.totalAssets - bs.totalLiabilities - bs.totalEquity, e)}). Please report this — posted entries should always balance.</div>` : ""}
  ${drafts ? `<div class="banner info">${drafts} draft${drafts > 1 ? "s" : ""} not yet posted — drafts don't count in any figure. <a href="#/finance/${e.id}/entries">Review</a></div>` : ""}
  <div class="grid-2">
    ${section("Bank, cash & cards", moneyAccs.length ? `<div class="list">${moneyAccs.map(x => `<div class="trow" data-act="fin-ledger" data-id="${x.a.id}" role="button" tabindex="0"><span class="kico">${x.a.subtype === "card" ? "💳" : x.a.subtype === "cash" ? "💵" : "🏦"}</span><div class="tmain"><div class="ttitle">${esc(x.a.name)}</div><div class="tmeta">${x.a.code} · ${SUBTYPE_LABEL[x.a.subtype]}</div></div><div class="tside num">${M(x.b, e)}</div></div>`).join("")}</div>` : `<p class="calm">No money accounts.</p>`)}
    ${section("Needs attention", (overdueInv.length || billsDue.length) ? `<div class="list">${[...overdueInv, ...billsDue].map(i => invRow(i, e)).join("")}</div>` : `<p class="calm">${ICON.done} No overdue invoices or bills due this week.</p>`)}
  </div>
  ${section("Recent entries", journalTable(e, fin.journals.filter(j => j.entity_id === e.id).slice(0, 8)), { right: `<a class="more" href="#/finance/${e.id}/entries">All entries</a>` })}`;
}

function journalAmount(j) { return r2(linesOfJournal(j.id).reduce((s, l) => s + Number(l.debit), 0)); }
const SOURCE_LABEL = { manual: "Entry", opening: "Opening", invoice: "Invoice", bill: "Bill", payment: "Payment", reversal: "Reversal", stock: "Stock", partner: "Partner", intercompany: "Inter-entity" };
function journalTable(e, js) {
  if (!js.length) return `<p class="calm">No entries yet.</p>`;
  return `<div class="tablewrap"><table class="rtable"><thead><tr><th>#</th><th>Date</th><th>Description</th><th>Type</th><th class="num">Amount</th></tr></thead><tbody>
    ${js.map(j => `<tr class="clickrow ${j.reversed_by || j.reversal_of ? "muted" : ""}" data-act="fin-open-journal" data-id="${j.id}"><td class="num">${j.number || "—"}</td><td>${fmtDate(j.entry_date)}</td>
      <td>${esc(j.memo)}${j.reference ? ` <small class="hint">${esc(j.reference)}</small>` : ""}${j.reversed_by ? ` <span class="pill inv-void">Reversed</span>` : ""}</td>
      <td>${j.status === "draft" ? pill("draft") : `<span class="chip">${SOURCE_LABEL[j.source]}</span>`}</td><td class="num">${M(journalAmount(j), e)}</td></tr>`).join("")}</tbody></table></div>`;
}

function entries(e) {
  const u = ui(), q = u.jq.trim().toLowerCase();
  let js = fin.journals.filter(j => j.entity_id === e.id);
  if (u.jstatus) js = js.filter(j => u.jstatus === "draft" ? j.status === "draft" : j.status === "posted" && (u.jstatus === "posted" || j.source === u.jstatus));
  if (q) js = js.filter(j => [j.memo, j.reference, String(j.number || "")].join(" ").toLowerCase().includes(q) || linesOfJournal(j.id).some(l => (l.description || "").toLowerCase().includes(q) || (accById(l.account_id) || {}).name?.toLowerCase().includes(q)));
  return `<div class="filters kfilters noprint"><input class="input" type="search" id="fj-q" placeholder="Search entries…" value="${esc(u.jq)}">
    <select class="input" id="fj-status"><option value="">All</option><option value="draft" ${u.jstatus === "draft" ? "selected" : ""}>Drafts</option><option value="posted" ${u.jstatus === "posted" ? "selected" : ""}>Posted</option>
    ${Object.entries(SOURCE_LABEL).map(([k, l]) => `<option value="${k}" ${u.jstatus === k ? "selected" : ""}>${l}s</option>`).join("")}</select>
    ${canWriteFin(e.id) ? `<button class="btn" data-act="fin-opening">Opening balances</button>` : ""}</div>
    ${journalTable(e, js.slice(0, 300))}${js.length > 300 ? `<p class="hint">Showing the latest 300 of ${js.length}.</p>` : ""}
    <p class="hint">Posted entries can't be edited or deleted. To correct one, open it and choose Reverse, then post the right entry.</p>`;
}

function invRow(i, e) {
  const t = fin.totals.get(i.id) || { total: 0, paid: 0 }, s = invoiceStatus(i, t, today()), p = partyById(i.party_id);
  return `<div class="trow" data-act="fin-open-invoice" data-id="${i.id}" role="button" tabindex="0"><span class="kico">${i.kind === "sale" ? "↗" : "↙"}</span>
    <div class="tmain"><div class="ttitle">${esc(p ? p.name : "No party")} <small class="hint">${esc(i.number || "Draft")}${i.party_reference ? " · " + esc(i.party_reference) : ""}</small></div>
    <div class="tmeta">${fmtDate(i.issue_date)}${i.due_date ? ` · due ${fmtDate(i.due_date)}` : " · no due date"}${i.task_id ? ` · ${ICON.tasks} linked task` : ""}</div></div>
    <div class="tside"><b class="num">${M(t.total, e)}</b>${pill(s)}${s === "partial" || s === "overdue" ? `<small class="num">${M(Number(t.total) - Number(t.paid), e)} left</small>` : ""}</div></div>`;
}
function invoicesTab(e, kind) {
  const u = ui(), t = today();
  let list = fin.invoices.filter(i => i.entity_id === e.id && i.kind === kind);
  const st = i => invoiceStatus(i, fin.totals.get(i.id), t);
  if (u.invStatus === "open") list = list.filter(i => ["draft", "unpaid", "partial", "overdue"].includes(st(i)));
  else if (u.invStatus) list = list.filter(i => st(i) === u.invStatus);
  const ag = aging(fin.invoices.filter(i => i.entity_id === e.id && i.kind === kind), fin.totals, t);
  const noun = kind === "sale" ? (e.kind === "personal" ? "claim" : "invoice") : "bill";
  return `<div class="tiles">${Object.entries(AGING_LABEL).map(([k, l]) => tile(M(ag.buckets[k], e), l, k === "d90" && ag.buckets[k] ? "bad" : "")).join("")}${tile(M(ag.total, e), "Total outstanding")}</div>
  <div class="filters kfilters noprint"><select class="input" id="fi-status">${[["open", "Open"], ["", "All"], ["draft", "Drafts"], ["unpaid", "Unpaid"], ["partial", "Part paid"], ["overdue", "Overdue"], ["paid", "Paid"], ["void", "Void"]].map(([k, l]) => `<option value="${k}" ${u.invStatus === k ? "selected" : ""}>${l}</option>`).join("")}</select>
    ${canWriteFin(e.id) ? `<button class="btn primary" data-act="fin-new-invoice" data-kind="${kind}">${ICON.plus}New ${noun}</button><button class="btn" data-act="fin-pay" data-dir="${kind === "sale" ? "in" : "out"}">${kind === "sale" ? "Receive payment" : "Pay a bill"}</button>` : ""}</div>
  ${list.length ? `<div class="list">${list.map(i => invRow(i, e)).join("")}</div>` : emptyState(`No ${noun}s here`, kind === "sale" ? "Raise an invoice to record a sale on credit. The customer's balance updates when you record their payment." : "Enter supplier bills as they arrive; paying them is a separate step you record when the money leaves.")}`;
}

function payments(e) {
  const ps = fin.payments.filter(p => p.entity_id === e.id);
  return `<div class="filters kfilters noprint">${canWriteFin(e.id) ? `<button class="btn" data-act="fin-pay" data-dir="in">Money in</button><button class="btn" data-act="fin-pay" data-dir="out">Money out</button>` : ""}</div>
  ${ps.length ? `<div class="tablewrap"><table class="rtable"><thead><tr><th>Date</th><th>Who</th><th>Account</th><th>Reference</th><th class="num">In</th><th class="num">Out</th><th></th></tr></thead><tbody>
    ${ps.map(p => `<tr class="clickrow ${p.status === "void" ? "muted" : ""}" data-act="fin-open-payment" data-id="${p.id}"><td>${fmtDate(p.pay_date)}</td><td>${esc((partyById(p.party_id) || {}).name || "—")}</td><td>${esc((accById(p.account_id) || {}).name || "")}</td>
      <td>${esc(p.reference || "")}</td><td class="num">${p.direction === "in" ? M(p.amount, e) : ""}</td><td class="num">${p.direction === "out" ? M(p.amount, e) : ""}</td><td>${p.status === "void" ? pill("void") : ""}</td></tr>`).join("")}</tbody></table></div>`
    : emptyState("No payments yet", "Payments against invoices and bills appear here. They're only ever recorded by you — completing a task never marks anything paid.")}`;
}

function banking(e) {
  const u = ui(), accs = moneyAccounts(e.id);
  if (!accs.length) return emptyState("No bank accounts", "Add a bank, cash or card account under Accounts first.");
  const acc = bankingAccount(e);
  const stm = fin.statement.filter(s => s.account_id === acc.id);
  const ls = linesOf(e.id).filter(l => l.account_id === acc.id);
  const book = r2(ls.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0));
  const unmatchedBook = ls.filter(l => !l.statement_line_id);
  const open = stm.filter(s => s.status === "unmatched"), done = stm.filter(s => s.status !== "unmatched");
  return `<div class="filters kfilters noprint"><select class="input" id="fb-acc">${accs.map(a => `<option value="${a.id}" ${a.id === acc.id ? "selected" : ""}>${esc(a.code + " " + a.name)}</option>`).join("")}</select>
    ${canWriteFin(e.id) ? `<label class="btn filebtn">${ICON.download}Import statement (CSV)<input type="file" accept=".csv,text/csv,text/plain" id="fb-file" hidden></label>` : ""}</div>
  <div class="tiles">${tile(M(book, e), "Balance in your books")}${tile(open.length, "Statement lines to match", open.length ? "warn" : "")}${tile(unmatchedBook.length, "Book entries not on a statement")}${tile(done.length, "Matched / ignored")}</div>
  ${open.length && canWriteFin(e.id) && aiOn() ? `<div class="btnrow noprint"><button class="btn" data-act="fin-ai-cat" id="finAiCat">✨ Suggest accounts for unmatched lines</button><small class="hint">Sends the line descriptions and amounts plus your account names to the AI. Suggestions only — you post each entry yourself.</small></div>` : ""}
  ${open.length ? section("To reconcile", `<div class="list">${open.map(s => stmtRow(s, e, unmatchedBook)).join("")}</div>`, { count: open.length }) :
    `<p class="calm">${stm.length ? `${ICON.done} Every imported line is matched or ignored.` : "Import a CSV statement from your bank to reconcile this account. Columns needed: Date and either Amount or Debit/Credit."}</p>`}
  ${done.length ? section("Reconciled", `<div class="list compact">${done.slice(0, 40).map(s => `<div class="trow"><div class="tmain"><div class="ttitle">${esc(s.description)}</div><div class="tmeta">${fmtDate(s.line_date)}${s.reference ? " · " + esc(s.reference) : ""} · ${s.status}</div></div>
    <div class="tside"><b class="num ${s.amount < 0 ? "bad-text" : "ok-text"}">${M(s.amount, e)}</b>${canWriteFin(e.id) ? `<button class="btn sm" data-act="fin-unmatch" data-id="${s.id}">${s.status === "ignored" ? "Restore" : "Unmatch"}</button>` : ""}</div></div>`).join("")}</div>`, { count: done.length }) : ""}`;
}
function stmtRow(s, e, bookLines) {
  const cands = matchCandidates(s, bookLines).slice(0, 3), w = canWriteFin(e.id), sug = !cands.length && (ui().suggest || {})[s.id];
  return `<div class="trow stmt"><div class="tmain"><div class="ttitle">${esc(s.description)}</div><div class="tmeta">${fmtDate(s.line_date)}${s.reference ? " · " + esc(s.reference) : ""}</div>
    ${w ? `<div class="btnrow">${cands.map(c => `<button class="btn sm primary" data-act="fin-match" data-st="${s.id}" data-line="${c.line.id}">Match: #${c.line.journal.number} ${esc(c.line.journal.memo.slice(0, 40))} (${fmtDate(c.line.entry_date)})</button>`).join("")}
      ${sug ? `<button class="btn sm" data-act="fin-stmt-entry" data-id="${s.id}" data-acc="${sug.account_id}" title="AI suggestion (${sug.confidence} confidence)">✨ ${esc((accById(sug.account_id) || {}).code + " " + (accById(sug.account_id) || {}).name)}</button>` : ""}
      <button class="btn sm" data-act="fin-stmt-entry" data-id="${s.id}">Create entry</button><button class="btn sm" data-act="fin-ignore" data-id="${s.id}">Ignore</button></div>` : ""}</div>
    <div class="tside"><b class="num ${s.amount < 0 ? "bad-text" : "ok-text"}">${M(s.amount, e)}</b></div></div>`;
}

function accounts(e) {
  const ls = linesOf(e.id), w = canWriteFin(e.id);
  const bal = a => natural(a, ls.filter(l => l.account_id === a.id).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0));
  return `${w ? `<div class="filters kfilters noprint"><button class="btn primary" data-act="fin-account">${ICON.plus}New account</button></div>` : ""}
  ${Object.entries(ACCOUNT_TYPES).map(([type, label]) => { const accs = accountsOf(e.id, a => a.type === type); return accs.length ? section(label, `<div class="tablewrap"><table class="rtable"><tbody>
    ${accs.map(a => `<tr class="clickrow ${a.is_active ? "" : "muted"}" data-act="fin-ledger" data-id="${a.id}"><td class="num" style="width:5em">${esc(a.code)}</td><td>${esc(a.name)}${a.system_key ? ` <small class="hint">system</small>` : ""}${a.is_active ? "" : " <small>(inactive)</small>"}</td>
      <td><small class="hint">${SUBTYPE_LABEL[a.subtype]}</small></td><td class="num">${M(bal(a), e)}</td>${w ? `<td style="width:3em"><button class="iconbtn sm" data-act="fin-account" data-id="${a.id}" aria-label="Edit">${ICON.settings}</button></td>` : ""}</tr>`).join("")}
    </tbody></table></div>`, { count: accs.length }) : ""; }).join("")}`;
}

function people(e) {
  const ar = sysAcc(e, "ar"), ap = sysAcc(e, "ap"), ls = linesOf(e.id), w = canWriteFin(e.id);
  const bal = (p, acc, sign) => acc ? r2(sign * ls.filter(l => l.party_id === p.id && l.account_id === acc.id).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0)) : 0;
  const ps = fin.parties.filter(p => p.entity_id === e.id && !p.archived);
  return `${w ? `<div class="filters kfilters noprint"><button class="btn primary" data-act="fin-party">${ICON.plus}Add</button></div>` : ""}
  ${ps.length ? `<div class="tablewrap"><table class="rtable"><thead><tr><th>Name</th><th>Type</th><th class="num">Owes you</th><th class="num">You owe</th></tr></thead><tbody>
    ${ps.map(p => `<tr class="clickrow" data-act="fin-party" data-id="${p.id}"><td>${esc(p.name)}${p.email ? ` <small class="hint">${esc(p.email)}</small>` : ""}</td><td>${esc(p.kind)}</td>
      <td class="num">${M(bal(p, ar, 1), e)}</td><td class="num">${M(bal(p, ap, -1), e)}</td></tr>`).join("")}</tbody></table></div>`
    : emptyState("No customers or suppliers yet", "Add the people you invoice and the suppliers who bill you.")}`;
}
const sysAcc = (e, k) => fin.accounts.find(a => a.entity_id === e.id && a.system_key === k);

function stock(e) {
  const items = fin.items.filter(i => i.entity_id === e.id && !i.archived), w = canWriteFin(e.id);
  const invAcc = sysAcc(e, "inventory"), ls = linesOf(e.id);
  const glInv = invAcc ? r2(ls.filter(l => l.account_id === invAcc.id).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0)) : 0;
  const rows = items.map(i => ({ i, s: stockOf(i.id) })), total = r2(rows.reduce((s, r) => s + r.s.value, 0));
  return `${w ? `<div class="filters kfilters noprint"><button class="btn primary" data-act="fin-item">${ICON.plus}New item</button></div>` : ""}
  <div class="tiles">${tile(items.length, "Items")}${tile(M(total, e), "Stock value (average cost)")}${tile(M(glInv, e), "Inventory account balance", Math.abs(glInv - total) > 0.05 ? "warn" : "")}</div>
  ${Math.abs(glInv - total) > 0.05 ? `<p class="hint">The inventory account and item records differ by ${M(glInv - total, e)} — usually because stock was bought on bills without choosing an item, or a manual entry touched the inventory account.</p>` : ""}
  ${rows.length ? `<div class="tablewrap"><table class="rtable"><thead><tr><th>Item</th><th>SKU</th><th class="num">On hand</th><th class="num">Avg cost</th><th class="num">Value</th></tr></thead><tbody>
    ${rows.map(({ i, s }) => `<tr class="clickrow" data-act="fin-item" data-id="${i.id}"><td>${esc(i.name)}</td><td>${esc(i.sku || "")}</td><td class="num ${s.qty <= 0 ? "bad-text" : ""}">${s.qty} ${esc(i.unit)}</td><td class="num">${M(s.avg, e)}</td><td class="num">${M(s.value, e)}</td></tr>`).join("")}
    </tbody></table></div>` : emptyState("No stock items", "Add the fabrics, ingredients or products you buy and sell. Buying them on a bill adds stock; selling them on an invoice posts the cost of goods sold automatically.")}`;
}

function budgets(e) {
  const u = ui(), t = today(), month = u.budgetMonth || monthStart(t);
  const accs = accountsOf(e.id, a => (a.type === "income" || a.type === "expense") && a.is_active), w = canWriteFin(e.id);
  const [fyStart] = periodRange(e, "fy");
  const rowsM = budgetVsActual(accountsOf(e.id), fin.budgets.filter(b => b.entity_id === e.id), linesOf(e.id), [month]);
  const ytdMonths = monthsBetween(fyStart, month), rowsY = budgetVsActual(accountsOf(e.id), fin.budgets.filter(b => b.entity_id === e.id), linesOf(e.id), ytdMonths);
  const get = (rs, id) => rs.find(r => r.account.id === id) || { budget: 0, actual: 0, variance: 0, pct: null };
  const bud = id => (fin.budgets.find(b => b.account_id === id && b.month === month) || {}).amount ?? "";
  return `<div class="weekpick noprint"><button class="btn sm" data-act="fin-bmonth" data-m="${monthStart(addDays(month, -1))}">‹</button><b>${new Date(month + "T12:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</b>
    <button class="btn sm" data-act="fin-bmonth" data-m="${monthStart(addDays(monthEnd(month), 1))}">›</button>${w ? `<button class="btn sm" data-act="fin-bcopy">Copy this month's budget to the rest of the year</button>` : ""}</div>
  <p class="hint">Budgets are plans, kept separate from actuals. Favourable variance is positive (income above plan, spending below plan).</p>
  <form id="budgetForm"><div class="tablewrap"><table class="rtable"><thead><tr><th>Account</th><th class="num">Budget</th><th class="num">Actual</th><th class="num">Variance</th><th class="num">Year to date: budget</th><th class="num">actual</th></tr></thead><tbody>
    ${["income", "expense"].map(type => `<tr class="grouprow"><th colspan="6">${ACCOUNT_TYPES[type]}</th></tr>` + accs.filter(a => a.type === type).map(a => { const m = get(rowsM, a.id), y = get(rowsY, a.id);
      return `<tr><td>${esc(a.code + " " + a.name)}</td><td class="num">${w ? `<input class="input sm num" type="number" step="0.01" min="0" name="b-${a.id}" value="${bud(a.id)}" style="width:8em">` : M(m.budget, e)}</td>
        <td class="num">${M(m.actual, e)}</td><td class="num ${m.variance < 0 ? "bad-text" : m.variance > 0 ? "ok-text" : ""}">${m.budget || m.actual ? M(m.variance, e) : ""}</td><td class="num">${M(y.budget, e)}</td><td class="num">${M(y.actual, e)}</td></tr>`; }).join("")).join("")}
  </tbody></table></div>${w ? `<div class="btnrow"><button class="btn primary" type="submit" id="budgetSave">Save budget for this month</button></div>` : ""}</form>`;
}

/* ======================= reports ======================= */
export const REPORTS = { pl: "Profit & loss", bs: "Balance sheet", cf: "Cash flow", tb: "Trial balance", ar: "Receivables ageing", ap: "Payables ageing", gl: "General ledger" };
function reports(e) {
  const u = ui(), [from, to, plabel] = periodRange(e, u.period, { from: u.from, to: u.to });
  const accs = accountsOf(e.id), ls = linesOf(e.id);
  let body = "";
  if (u.report === "pl") body = plReport(e, profitAndLoss(accs, ls, from, to));
  else if (u.report === "bs") body = bsReport(e, balanceSheet(accs, ls, to));
  else if (u.report === "cf") body = cfReport(e, cashFlow(accs, ls, from, to));
  else if (u.report === "tb") body = tbReport(e, trialBalance(accs, ls, to));
  else if (u.report === "ar" || u.report === "ap") body = agingReport(e, aging(fin.invoices.filter(i => i.entity_id === e.id && i.kind === (u.report === "ar" ? "sale" : "purchase")), fin.totals, to));
  else body = glReport(e, accs, ls, from, to);
  const asAt = ["bs", "tb", "ar", "ap"].includes(u.report);
  return `<div class="filters kfilters noprint">
    <select class="input" id="fr-report">${Object.entries(REPORTS).map(([k, l]) => `<option value="${k}" ${u.report === k ? "selected" : ""}>${l}</option>`).join("")}</select>
    <select class="input" id="fr-period">${[["this_month", "This month"], ["last_month", "Last month"], ["quarter", "This quarter"], ["fy", "Financial year to date"], ["last_fy", "Last financial year"], ["custom", "Custom dates"]].map(([k, l]) => `<option value="${k}" ${u.period === k ? "selected" : ""}>${l}</option>`).join("")}</select>
    ${u.period === "custom" ? `<input class="input" type="date" id="fr-from" value="${from}"><input class="input" type="date" id="fr-to" value="${to}">` : ""}
    <button class="btn" data-act="rep-print">Print / PDF</button><button class="btn" data-act="fin-csv">${ICON.download}CSV</button></div>
  <div class="report fin-report"><h2 class="rep-title">${esc(e.name)} — ${REPORTS[u.report]}</h2>
    <p class="hint">${asAt ? `As at ${fmtDate(to, { day: "numeric", month: "long", year: "numeric" })}` : `${plabel}: ${fmtDate(from, { day: "numeric", month: "short", year: "numeric" })} – ${fmtDate(to, { day: "numeric", month: "short", year: "numeric" })}`} · ${e.base_currency} · posted entries only · produced ${fmtDate(today(), { day: "numeric", month: "short", year: "numeric" })}</p>
    ${body}</div>`;
}
const rrow = (label, amt, e, cls = "") => `<tr class="${cls}"><td>${label}</td><td class="num">${money(amt, "", { paren: true })}</td></tr>`;
const arow = (r, e) => rrow(`<span class="acode">${esc(r.account.code)}</span> ${esc(r.account.name)}`, r.amount, e);
function plReport(e, p) {
  return `<table class="rtable fs"><tbody>
    <tr class="grouprow"><th colspan="2">${e.kind === "personal" ? "Income" : "Revenue"}</th></tr>${p.income.map(r => arow(r, e)).join("") || rrow("—", 0, e)}${rrow("Total income", p.totalIncome, e, "subtotal")}
    ${p.cogs.length ? `<tr class="grouprow"><th colspan="2">Cost of goods sold</th></tr>${p.cogs.map(r => arow(r, e)).join("")}${rrow("Gross profit", p.grossProfit, e, "subtotal")}${p.grossMargin !== null ? `<tr><td class="hint">Gross margin</td><td class="num hint">${p.grossMargin}%</td></tr>` : ""}` : ""}
    <tr class="grouprow"><th colspan="2">${e.kind === "personal" ? "Spending" : "Expenses"}</th></tr>${p.expenses.map(r => arow(r, e)).join("") || rrow("—", 0, e)}${rrow("Total expenses", p.totalExpenses, e, "subtotal")}
    ${rrow(e.kind === "personal" ? "Saved (income − spending)" : "Net profit", p.netProfit, e, "total")}${p.netMargin !== null ? `<tr><td class="hint">Net margin</td><td class="num hint">${p.netMargin}%</td></tr>` : ""}
  </tbody></table>`;
}
function bsReport(e, b) {
  return `<table class="rtable fs"><tbody>
    <tr class="grouprow"><th colspan="2">Assets</th></tr>${b.assets.map(r => arow(r, e)).join("") || rrow("—", 0, e)}${rrow("Total assets", b.totalAssets, e, "subtotal")}
    <tr class="grouprow"><th colspan="2">Liabilities</th></tr>${b.liabilities.map(r => arow(r, e)).join("") || rrow("—", 0, e)}${rrow("Total liabilities", b.totalLiabilities, e, "subtotal")}
    <tr class="grouprow"><th colspan="2">${e.kind === "personal" ? "Net worth" : "Equity"}</th></tr>${b.equity.map(r => arow(r, e)).join("")}${rrow(e.kind === "personal" ? "Saved to date (not yet carried forward)" : "Current earnings (not yet closed)", b.earnings, e)}
    ${rrow(e.kind === "personal" ? "Total net worth" : "Total equity", b.totalEquity, e, "subtotal")}${rrow("Liabilities + equity", b.totalLiabilities + b.totalEquity, e, "total")}
  </tbody></table>${b.balanced ? `<p class="ok-text">${ICON.check} Balances: assets = liabilities + equity.</p>` : `<p class="bad-text">Does not balance — please report this.</p>`}`;
}
function cfReport(e, c) {
  const cat = (k, l) => `<tr class="grouprow"><th colspan="2">${l}</th></tr>${rrow("Cash in", c[k].in, e)}${rrow("Cash out", -c[k].out, e)}${rrow(`Net cash from ${l.toLowerCase()}`, c[k].net, e, "subtotal")}`;
  return `<table class="rtable fs"><tbody>${rrow("Opening cash & bank", c.opening, e, "subtotal")}${cat("operating", "Operating activities")}${cat("investing", "Investing activities")}${cat("financing", "Financing activities")}
    ${rrow("Net change in cash", c.net, e, "subtotal")}${rrow("Closing cash & bank", c.closing, e, "total")}</tbody></table>
    <p class="hint">Cash = cash and bank accounts (card balances are treated as borrowing). Each entry is classified by its main counterpart account: fixed assets and investments → investing; loans, partner and equity accounts → financing; everything else → operating.</p>`;
}
function tbReport(e, t) {
  return `<table class="rtable"><thead><tr><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>
    ${t.rows.map(r => `<tr><td><span class="acode">${esc(r.account.code)}</span> ${esc(r.account.name)}</td><td class="num">${r.debit ? money(r.debit) : ""}</td><td class="num">${r.credit ? money(r.credit) : ""}</td></tr>`).join("")}
    <tr class="total"><td>Total</td><td class="num">${money(t.debit)}</td><td class="num">${money(t.credit)}</td></tr></tbody></table>
    ${t.balanced ? `<p class="ok-text">${ICON.check} Debits equal credits.</p>` : `<p class="bad-text">Out of balance by ${money(t.debit - t.credit)} — please report this.</p>`}`;
}
function agingReport(e, a) {
  return `<div class="tiles">${Object.entries(AGING_LABEL).map(([k, l]) => tile(M(a.buckets[k], e), l)).join("")}${tile(M(a.total, e), "Total")}</div>
  <table class="rtable"><thead><tr><th>Number</th><th>Party</th><th>Due</th><th class="num">Days late</th><th class="num">Outstanding</th></tr></thead><tbody>
    ${a.rows.map(r => `<tr class="clickrow" data-act="fin-open-invoice" data-id="${r.invoice.id}"><td>${esc(r.invoice.number)}</td><td>${esc((partyById(r.invoice.party_id) || {}).name || "")}</td><td>${r.invoice.due_date ? fmtDate(r.invoice.due_date) : "no due date"}</td>
      <td class="num">${r.days !== null && r.days > 0 ? r.days : ""}</td><td class="num">${money(r.outstanding)}</td></tr>`).join("") || `<tr><td colspan="5" class="calm">Nothing outstanding.</td></tr>`}</tbody></table>`;
}
function glReport(e, accs, ls, from, to) {
  const used = accs.filter(a => ls.some(l => l.account_id === a.id));
  return used.map(a => { const g = ledger(a, ls, from, to); if (!g.rows.length && !g.opening) return "";
    return `<h3>${esc(a.code + " " + a.name)}</h3><table class="rtable"><thead><tr><th>Date</th><th>#</th><th>Description</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead><tbody>
      <tr class="muted"><td colspan="5">Opening balance</td><td class="num">${money(g.opening)}</td></tr>
      ${g.rows.map(r => `<tr class="clickrow" data-act="fin-open-journal" data-id="${r.line.journal_id}"><td>${fmtDate(r.line.entry_date)}</td><td class="num">${r.line.journal.number}</td><td>${esc(r.line.description || r.line.journal.memo)}</td>
        <td class="num">${Number(r.line.debit) ? money(r.line.debit) : ""}</td><td class="num">${Number(r.line.credit) ? money(r.line.credit) : ""}</td><td class="num">${money(r.balance)}</td></tr>`).join("")}
      <tr class="subtotal"><td colspan="5">Closing balance</td><td class="num">${money(g.closing)}</td></tr></tbody></table>`; }).join("") || `<p class="calm">No entries in this period.</p>`;
}

function settings(e) {
  const owner = isFinOwner(e.id), ms = fin.members.filter(m => m.entity_id === e.id);
  return `<div class="grid-2">
  ${section("Books", `<form id="finEntityForm" class="review-form">
    <label class="field"><span>Name</span><input class="input" id="fe-name" value="${esc(e.name)}" ${owner ? "" : "disabled"}></label>
    <div class="grid2"><label class="field"><span>Base currency</span><input class="input" value="${e.base_currency}" disabled></label>
    <label class="field"><span>Financial year starts</span><select class="input" id="fe-fy" ${owner ? "" : "disabled"}>${[...Array(12)].map((_, i) => `<option value="${i + 1}" ${e.fiscal_year_start === i + 1 ? "selected" : ""}>${new Date(Date.UTC(2026, i, 1)).toLocaleDateString("en-GB", { month: "long" })}</option>`).join("")}</select></label></div>
    <label class="field"><span>Linked workspace <small>(for linking tasks)</small></span><select class="input" id="fe-ws" ${owner ? "" : "disabled"}><option value="">None</option>${state.workspaces.map(w => `<option value="${w.id}" ${w.id === e.workspace_id ? "selected" : ""}>${esc(w.name)}</option>`).join("")}</select></label>
    <label class="field"><span>Lock books up to <small>(no posting on or before this date)</small></span><input class="input" type="date" id="fe-lock" value="${e.lock_date || ""}" ${owner ? "" : "disabled"}></label>
    ${owner ? `<div class="btnrow"><button class="btn primary" type="submit" id="feSave">Save</button><button class="btn" type="button" data-act="fin-archive">${e.archived ? "Restore books" : "Archive books"}</button></div>` : `<p class="hint">Only the owner can change these settings.</p>`}
  </form>`)}
  ${section("People with access", `<ul class="plain">${ms.map(m => `<li><b>${esc(nameOf(m.user_id))}</b> — ${owner && m.user_id !== state.user.id ? `<select class="input sm" data-act="fin-role" data-user="${m.user_id}">${["owner", "bookkeeper", "viewer"].map(r => `<option ${m.role === r ? "selected" : ""}>${r}</option>`).join("")}</select>
      <button class="linkbtn" data-act="fin-remove-member" data-user="${m.user_id}">Remove</button>` : esc(m.role)}</li>`).join("")}</ul>
    ${owner ? `<form id="finMemberForm" class="addrow"><input class="input" type="email" id="fm-email" placeholder="their Job Desk email" required><select class="input" id="fm-role" style="max-width:9em"><option value="viewer">viewer</option><option value="bookkeeper">bookkeeper</option><option value="owner">owner</option></select><button class="btn" type="submit">Add</button></form>
    <p class="hint">Viewers can read; bookkeepers can enter and post; owners can also lock periods and manage access. Access to books is separate from workspace access.</p>` : ""}
    <h3>Change log</h3><div id="finAudit"><button class="btn sm" data-act="fin-audit">Show recent changes</button></div>`)}</div>`;
}
export function auditHtml(e) {
  return fin.audit.length ? `<ul class="feed">${fin.audit.slice(0, 80).map(a => `<li><div><span>${esc(a.actor_id ? nameOf(a.actor_id) : "System")} ${esc(a.action)} ${esc(a.record_type.replace("fin_", "").replace(/s$/, ""))}${a.changes && a.changes.memo ? ": " + esc(typeof a.changes.memo === "string" ? a.changes.memo : "") : ""}</span><time>${ago(a.created_at)}</time></div></li>`).join("")}</ul>` : `<p class="calm">No changes recorded.</p>`;
}

/** The account the Banking tab works on: the one chosen, else the first bank account, else the first money account. */
export function bankingAccount(e) {
  const u = ui(), accs = moneyAccounts(e.id);
  return accs.find(a => a.id === u.bankAcc) || accs.find(a => a.subtype === "bank") || accs[0];
}
