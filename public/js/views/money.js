// Simple money screens for personal books: what I have, what I'm owed, what I owe, where the money went.
// Every figure comes from posted ledger lines in these books (money.js); the double entry stays underneath, out of sight.
import { esc, todayISO, addDays, fmtDate } from "../util.js";
import { state } from "../store.js";
import { ICON, emptyState } from "../ui.js";
import { fin, accById, partyById, accountsOf, moneyAccounts, linesOf, linesOfJournal, canWriteFin, filesOf, pendingRowsOf, obligationFor, lastBalanceCheck, entityById } from "../finapi.js";
import { money, r2, natural, balanceSheet, monthStart, monthEnd } from "../finance.js";
import { businessParties, classifyJournal, monthSummary, groupedBalances, receivableItems, FLOW_LABEL, DEBT_KIND_LABEL, CASH, SAVINGS, byJournal } from "../money.js";

export const MONEY_TABS = { overview: "Overview", transactions: "Transactions", owed: "Owed to me", owe: "I owe", accounts: "Accounts", month: "Monthly report", advanced: "Advanced" };
export const ADV_TABS = { entries: "All entries", invoices: "Claims & invoices", bills: "Bills", payments: "Payments", banking: "Bank reconciliation", chart: "Chart of accounts", people: "People",
  intercompany: "Inter-entity", budgets: "Budgets", reports: "Accounting reports", settings: "Settings" };
const ADV_HINT = { entries: "Every posted entry, with reversals", invoices: "Formal claims raised to people who owe you", bills: "Bills you need to pay, with due dates", payments: "Payments against claims and bills",
  banking: "Match a CSV bank statement line by line", chart: "Accounts and their codes", people: "Everyone in these books", intercompany: "Transfers between your sets of books",
  budgets: "Monthly spending plans against actuals", reports: "Profit & loss, balance sheet, cash flow, trial balance, ledger", settings: "Access, lock date, change log" };

const today = () => todayISO(state.tz);
const mu = () => (state.ui.money = state.ui.money || { month: null, filter: "all", q: "" });
const M = (n, e, o) => money(n, e.base_currency, o);
const partyName = id => (partyById(id) || {}).name;

/* ---------- shared calculations for one set of personal books ---------- */
export function moneyModel(e) {
  const ls = linesOf(e.id), accs = accountsOf(e.id);
  const biz = businessParties(e.id, { plinks: fin.plinks, parties: fin.parties, entities: fin.entities });
  const bal = a => natural(a, ls.filter(l => l.account_id === a.id).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0));
  const owed = groupedBalances(ls, accById, a => a.subtype === "receivable", 1);
  const owe = groupedBalances(ls, accById, a => a.type === "liability", -1);
  // liabilities with details recorded but nothing posted yet still show
  for (const o of fin.obligations.filter(o => o.entity_id === e.id && o.side === "i_owe" && !o.archived)) {
    if (!owe.some(g => g.account.id === o.account_id && g.party_id === (o.party_id || null))) owe.push({ key: o.account_id + "|" + (o.party_id || ""), account: accById(o.account_id), party_id: o.party_id || null, balance: 0, debits: 0, credits: 0, lines: [] });
  }
  const cashAccs = moneyAccounts(e.id).filter(a => CASH.has(a.subtype)).map(a => ({ a, b: bal(a) }));
  const cards = moneyAccounts(e.id).filter(a => a.subtype === "card").map(a => ({ a, b: -bal(a) }));
  const cash = r2(cashAccs.reduce((s, x) => s + x.b, 0));
  const owedTotal = r2(owed.reduce((s, g) => s + g.balance, 0)), oweTotal = r2(owe.reduce((s, g) => s + g.balance, 0));
  const bs = balanceSheet(accs, ls, today());
  return { e, ls, accs, biz, bal, owed, owe, cashAccs, cards, cash, owedTotal, oweTotal, net: r2(bs.totalAssets - bs.totalLiabilities), bs };
}
export const groupName = g => (g.party_id && partyName(g.party_id)) || g.account.name;
export function debtKind(g) {
  const o = obligationFor(g.account.id, g.party_id); if (o) return o.kind;
  if (g.account.subtype === "card") return "credit_card";
  if (/friend|family/i.test(g.account.name)) return "friend_family";
  if (g.account.subtype === "loan") return "bank_loan";
  if (/dlusso|business|partner/i.test(g.account.name)) return "business";
  return "other";
}
const kindIcon = k => ({ bank_loan: "🏦", credit_card: "💳", friend_family: "🤝", business: "🏢", partner: "🏢", other: "📄" }[k] || "📄");

/* ---------- page shell ---------- */
export function renderMoney(view, e, tab, sub, classic) {
  const w = canWriteFin(e.id), pend = pendingRowsOf(e.id).length;
  const isAdv = !!ADV_TABS[tab];
  if (!MONEY_TABS[tab] && !isAdv) tab = "overview";
  const body = isAdv ? advancedShell(e, tab, classic) : { overview, transactions, owed: owedTab, owe: oweTab, accounts: accountsTab, month: monthTab, advanced: advancedTab }[tab](e, sub);
  view.innerHTML = `<div class="mn">
  <div class="page-head mn-head"><div><p class="crumb"><a href="#/finance">Finance</a></p><h1>${esc(e.name)} <span class="chip">${e.base_currency}</span></h1>
    <p class="sub">${ICON.lock} Private to you${fin.members.filter(m => m.entity_id === e.id).length > 1 ? " and the people you added" : ""}</p></div>
    ${w ? `<div class="btnrow noprint"><button class="btn primary mn-capture" data-act="mn-capture" data-entity="${e.id}">${ICON.plus}Capture</button></div>` : ""}</div>
  <div class="viewtabs noprint fin-tabs mn-tabs">${Object.entries(MONEY_TABS).map(([k, l]) => `<a href="#/finance/${e.id}/${k}" class="${tab === k || (k === "advanced" && isAdv) ? "on" : ""}">${l}${k === "transactions" && pend ? ` <span class="badge">${pend}</span>` : ""}</a>`).join("")}</div>
  ${pend && tab !== "transactions" && !isAdv ? `<div class="banner info mn-pending">${pend} imported transaction${pend > 1 ? "s" : ""} waiting for your OK. <a href="#/finance/${e.id}/transactions">Review</a></div>` : ""}
  ${body}</div>`;
}

/* ---------- overview ---------- */
function overview(e) {
  const m = moneyModel(e), t = today(), ms = monthStart(t);
  if (!m.ls.length) return gettingStarted(e);
  const s = monthSummary(m.ls, accById, m.biz, ms, t);
  const topOwed = [...m.owed].filter(g => g.balance > 0.004).sort((a, b) => b.balance - a.balance);
  const topOwe = [...m.owe].filter(g => g.balance > 0.004).sort((a, b) => b.balance - a.balance);
  const card = (href, label, amount, sub, cls = "") => `<a class="mn-card ${cls}" href="${href}"><span class="mn-l">${label}</span><span class="mn-n num">${amount}</span><span class="mn-s">${sub}</span><span class="mn-go">${ICON.chevron}</span></a>`;
  const monthName = new Date(ms + "T12:00:00Z").toLocaleDateString("en-GB", { month: "long" });
  const checks = m.cashAccs.map(x => ({ x, c: lastBalanceCheck(x.a.id) })).filter(y => y.c && Math.abs(Number(y.c.balance) - y.x.b) > 0.004);
  return `
  <div class="mn-cards">
    ${card(`#/finance/${e.id}/owed`, "Owed to me", M(m.owedTotal, e), topOwed.length ? topOwed.slice(0, 2).map(g => `${esc(groupName(g))} ${M(g.balance, e)}`).join(" · ") : "Nobody owes you anything", "in")}
    ${card(`#/finance/${e.id}/owe`, "I owe", M(m.oweTotal, e), topOwe.length ? `${topOwe.length} item${topOwe.length > 1 ? "s" : ""} · biggest: ${esc(groupName(topOwe[0]))}` : "No debts recorded", "out")}
    ${card(`#/finance/${e.id}/accounts`, "Cash & bank", M(m.cash, e), m.cashAccs.filter(x => x.b).map(x => `${esc(x.a.name.replace(/ —.*$/, ""))} ${M(x.b, e)}`).slice(0, 2).join(" · ") || "Nothing recorded yet")}
    ${card(`#/finance/${e.id}/accounts`, "Net position", M(m.net, e), "What you have + owed to you − what you owe", m.net < 0 ? "bad" : "")}
  </div>
  ${checks.length ? `<div class="banner warn">${checks.map(y => `${esc(y.x.a.name)}: the bank showed ${M(y.c.balance, e)} on ${fmtDate(y.c.as_of)}, your books show ${M(y.x.b, e)} (difference ${M(Number(y.c.balance) - y.x.b, e)}).`).join("<br>")} <a href="#/finance/${e.id}/accounts">Check</a></div>` : ""}
  ${!m.bs.balanced ? `<div class="banner bad">Your books don't balance — please report this. Posted entries should always balance.</div>` : ""}
  <div class="grid-2 mn-grid">
    <section class="sect"><div class="sect-h"><h2>${monthName} so far</h2><a class="more" href="#/finance/${e.id}/month">Full report</a></div>${monthRows(e, s)}</section>
    <section class="sect"><div class="sect-h"><h2>Where the money went</h2><span class="c">${monthName}</span></div>${salaryBar(e, s)}</section>
  </div>
  ${businessBlock(e, m)}
  <section class="sect"><div class="sect-h"><h2>Recent</h2><a class="more" href="#/finance/${e.id}/transactions">All transactions</a></div>${txList(e, m, journalsOf(e).slice(0, 8))}</section>`;
}
function gettingStarted(e) {
  return `<section class="sect getting-started"><div class="sect-h"><h2>Let's get your money in one place</h2></div><ol class="steps">
    <li><b>What you have today.</b> Enter what's in your bank, cash and cards. <a class="btn sm" href="#/finance/${e.id}/accounts">Accounts</a></li>
    <li><b>Who owes you, and what you owe.</b> Add loans, cards, money friends or a business owe you. <a class="btn sm" href="#/finance/${e.id}/owe">I owe</a> <a class="btn sm" href="#/finance/${e.id}/owed">Owed to me</a></li>
    <li><b>Day to day.</b> Press <b>Capture</b> to snap a receipt, paste a bank SMS, or upload your statement. You confirm each line before it's saved.</li></ol>
    <p class="hint">Nothing is entered for you. Every figure comes from what you confirm.</p></section>`;
}
function monthRows(e, s) {
  const row = (label, amt, cls = "", href = "") => `<${href ? `a href="${href}"` : "div"} class="mn-row ${cls}"><span>${label}</span><b class="num">${M(amt, e)}</b></${href ? "a" : "div"}>`;
  return `<div class="mn-rows">
    ${row("Salary received", s.salary, "in")}${s.otherIncome ? row("Other income", s.otherIncome, "in") : ""}
    ${row("Spent on me & family", s.spending, "out")}
    ${row("Paid for businesses", s.bizPaid, "biz", `#/finance/${e.id}/transactions?f=business`)}${s.bizRepaid ? row("Businesses paid me back", s.bizRepaid, "in") : ""}
    ${row("Loan & card repayments", s.repayments, "out")}
    ${row("Saved (income − spending)", s.saved, s.saved < 0 ? "bad total" : "ok total")}
    ${row("Net change in cash & bank", s.netCash, "total " + (s.netCash < 0 ? "bad" : ""))}</div>`;
}
function salaryBar(e, s) {
  const base = s.salary + s.otherIncome + s.bizRepaid + s.repaidToMe;
  const parts = [["Me & family", s.spending, "out"], ["Businesses", s.bizPaid, "biz"], ["Repayments", s.repayments, "debt"], ["Lent", s.lent, "lent"], ["Savings", s.savings, "sav"]].filter(p => p[1] > 0);
  const used = parts.reduce((x, p) => x + p[1], 0), left = r2(base - used);
  if (!base && !used) return `<p class="calm">Nothing recorded this month yet. Upload your statement or paste your salary SMS with <b>Capture</b>.</p>`;
  const tot = Math.max(base, used) || 1;
  return `<p class="hint">Money in this month: <b class="num">${M(base, e)}</b>${s.salary ? ` (salary ${M(s.salary, e)})` : ""}</p>
    <div class="mn-bar">${parts.map(p => `<i class="seg ${p[2]}" style="width:${(p[1] / tot * 100).toFixed(1)}%" title="${p[0]}"></i>`).join("")}${left > 0 ? `<i class="seg left" style="width:${(left / tot * 100).toFixed(1)}%"></i>` : ""}</div>
    <ul class="mn-legend">${parts.map(p => `<li><i class="seg ${p[2]}"></i>${p[0]}<b class="num">${M(p[1], e)}</b></li>`).join("")}
      <li><i class="seg left"></i>${left >= 0 ? "Not yet spent" : "Spent more than came in"}<b class="num ${left < 0 ? "bad-text" : ""}">${M(left, e)}</b></li></ul>
    <p class="hint">Card spending counts when you spend, card bills count as repayments, and money paid for a business is kept apart from your own spending.</p>`;
}
function businessBlock(e, m) {
  const rows = [...m.biz.entries()].map(([pid, b]) => {
    const ls = m.ls.filter(l => l.party_id === pid && (accById(l.account_id) || {}).subtype === "receivable");
    if (!ls.length) return null;
    const paid = r2(ls.reduce((s, l) => s + Number(l.debit), 0)), back = r2(ls.reduce((s, l) => s + Number(l.credit), 0));
    const acc = ls[0].account_id;
    return { pid, b, paid, back, out: r2(paid - back), key: acc + "|" + pid };
  }).filter(Boolean);
  if (!rows.length) return "";
  return `<section class="sect mn-biz"><div class="sect-h"><h2>My money in businesses</h2><span class="c">all time</span></div>
    <div class="tablewrap"><table class="rtable"><thead><tr><th>Business</th><th class="num">Paid by me</th><th class="num">Paid back</th><th class="num">Still owed to me</th></tr></thead><tbody>
    ${rows.map(r => `<tr class="clickrow" data-act="mn-owed" data-entity="${e.id}" data-key="${r.key}"><td><span class="mn-dot biz"></span>${esc(r.b.name || partyName(r.pid))}</td><td class="num">${M(r.paid, e)}</td><td class="num">${M(r.back, e)}</td><td class="num"><b>${M(r.out, e)}</b></td></tr>`).join("")}
    </tbody></table></div><p class="hint">"Paid by me" includes opening balances you carried in. Tap a business for each item, its receipt, and what's still outstanding.</p></section>`;
}

/* ---------- transactions ---------- */
export function journalsOf(e) { return fin.journals.filter(j => j.entity_id === e.id && j.status === "posted"); }
function describe(e, m, j) {
  const jl = linesOfJournal(j.id).map(l => ({ ...l, entry_date: j.entry_date, journal: j }));
  const c = classifyJournal(jl, accById, m.biz);
  const acc = l => accById(l.account_id) || {};
  const moneyLine = jl.find(l => CASH.has(acc(l).subtype)) || jl.find(l => acc(l).subtype === "card");
  let label, amt = c.cashNet, cls = c.cashNet > 0 ? "in" : c.cashNet < 0 ? "out" : "neutral";
  if (c.business) { label = c.bizOut ? `Paid for ${c.business.name || "a business"}` : `${c.business.name || "Business"} paid me back`; if (!amt) { amt = c.bizOut ? -c.bizOut : c.bizIn; cls = c.bizOut ? "out" : "neutral"; } }
  else if (j.source === "opening" || c.flows.some(f => f.cat === "opening") || jl.every(l => ["equity"].includes(acc(l).type) || !CASH.has(acc(l).subtype)) && jl.some(l => acc(l).type === "equity")) { label = "Opening balance / adjustment"; cls = "neutral"; amt = r2(jl.reduce((s, l) => s + Number(l.debit), 0)); }
  else if (c.flows.length) { const f = [...c.flows].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0]; label = f.cat === "spend" ? (f.account.name) : FLOW_LABEL[f.cat]; if (f.cat === "own_transfer") { cls = "neutral"; amt = r2(jl.reduce((s, l) => s + Number(l.debit), 0)); } }
  else if (c.spend) { label = `${(jl.find(l => acc(l).type === "expense") ? acc(jl.find(l => acc(l).type === "expense")).name : "Spending")} · on card`; amt = -c.spend; cls = "out"; }
  else { label = "Entry"; amt = r2(jl.reduce((s, l) => s + Number(l.debit), 0)); cls = "neutral"; }
  const files = filesOf("journal_id", j.id).length + (j.source === "partner" ? fin.pdocs.filter(d => d.txn_id === j.source_id).length : 0);
  const imported = fin.importRows.some(r => r.journal_id === j.id);
  return { j, c, label, amt, cls, via: moneyLine ? acc(moneyLine).name : null, files, imported, biz: !!c.business };
}
function txList(e, m, js) {
  if (!js.length) return `<p class="calm">No transactions yet.</p>`;
  return `<div class="list mn-tx">${js.map(j => { const d = describe(e, m, j);
    return `<div class="trow mn-txrow ${d.biz ? "biz" : ""}" data-act="fin-open-journal" data-id="${j.id}" role="button" tabindex="0">
      <span class="mn-ico ${d.cls}">${d.biz ? "🏢" : d.cls === "in" ? "↓" : d.cls === "out" ? "↑" : "⇄"}</span>
      <div class="tmain"><div class="ttitle">${esc(j.memo)}</div><div class="tmeta">${fmtDate(j.entry_date)} · ${esc(d.label)}${d.via ? ` · ${esc(d.via)}` : ""}${d.files ? ` · 📎 ${d.files}` : ""}${d.imported ? " · imported" : ""}</div></div>
      <div class="tside"><b class="num mn-amt ${d.cls}">${d.cls === "in" ? "+" : d.cls === "out" ? "−" : ""}${M(Math.abs(d.amt), e)}</b>${d.biz ? `<span class="chip biz">${esc((d.c.business.name || "Business").split(" ")[0])}</span>` : ""}</div></div>`; }).join("")}</div>`;
}
function transactions(e) {
  const u = mu(), m = moneyModel(e), q = (u.q || "").trim().toLowerCase();
  const f = (state.route.params && state.route.params.get("f")) || u.filter || "all";
  const pend = pendingRowsOf(e.id), imps = [...new Set(pend.map(r => r.import_id))].map(id => fin.imports.find(i => i.id === id)).filter(Boolean);
  let js = journalsOf(e).map(j => describe(e, m, j));
  if (f === "in") js = js.filter(d => d.cls === "in"); else if (f === "out") js = js.filter(d => d.cls === "out");
  else if (f === "business") js = js.filter(d => d.biz); else if (f === "receipts") js = js.filter(d => d.files); else if (f === "noreceipt") js = js.filter(d => !d.files && d.cls === "out");
  if (q) js = js.filter(d => [d.j.memo, d.j.reference, d.label, d.via].join(" ").toLowerCase().includes(q));
  const chip = (k, l) => `<button class="chip-btn ${f === k ? "on" : ""}" data-act="mn-filter" data-f="${k}">${l}</button>`;
  return `${imps.length ? `<section class="sect mn-review"><div class="sect-h"><h2>Waiting for your OK</h2><span class="c">${pend.length}</span></div><div class="list">
    ${imps.map(i => { const rs = pend.filter(r => r.import_id === i.id); return `<div class="trow" data-act="mn-review" data-id="${i.id}" role="button" tabindex="0"><span class="mn-ico neutral">${{ statement: "📄", sms: "💬", email: "✉️", receipt: "🧾", text: "✍️" }[i.source] || "📄"}</span>
      <div class="tmain"><div class="ttitle">${esc(i.title)}</div><div class="tmeta">${rs.length} line${rs.length > 1 ? "s" : ""} · added ${fmtDate(i.created_at.slice(0, 10))}${rs.some(r => r.duplicate) ? ` · ${rs.filter(r => r.duplicate).length} possible duplicate${rs.filter(r => r.duplicate).length > 1 ? "s" : ""}` : ""}</div></div>
      <div class="tside"><span class="btn sm primary">Review</span></div></div>`; }).join("")}</div></section>` : ""}
  <div class="filters kfilters noprint mn-filters">${chip("all", "All")}${chip("in", "Money in")}${chip("out", "Money out")}${chip("business", "For businesses")}${chip("receipts", "With receipt")}${chip("noreceipt", "No receipt")}
    <input class="input" type="search" id="mn-q" placeholder="Search…" value="${esc(u.q || "")}"></div>
  ${js.length ? `<div class="list mn-tx">${js.slice(0, 300).map(d => txRowHtml(e, d)).join("")}</div>${js.length > 300 ? `<p class="hint">Showing the latest 300 of ${js.length}.</p>` : ""}` : emptyState("Nothing here", f === "all" ? "Press Capture to add your first transaction." : "No transactions match this filter.")}
  <p class="hint">Tap a transaction to see its details and receipts. To correct one, open it and choose Reverse — nothing is ever silently changed.</p>`;
}
function txRowHtml(e, d) {
  const j = d.j;
  return `<div class="trow mn-txrow ${d.biz ? "biz" : ""}" data-act="fin-open-journal" data-id="${j.id}" role="button" tabindex="0">
    <span class="mn-ico ${d.cls}">${d.biz ? "🏢" : d.cls === "in" ? "↓" : d.cls === "out" ? "↑" : "⇄"}</span>
    <div class="tmain"><div class="ttitle">${esc(j.memo)}${j.reversed_by || j.reversal_of ? ` <span class="pill inv-void">${j.reversal_of ? "Reversal" : "Reversed"}</span>` : ""}</div><div class="tmeta">${fmtDate(j.entry_date)} · ${esc(d.label)}${d.via ? ` · ${esc(d.via)}` : ""}${d.files ? ` · 📎 ${d.files}` : ""}${d.imported ? " · imported" : ""}</div></div>
    <div class="tside"><b class="num mn-amt ${d.cls}">${d.cls === "in" ? "+" : d.cls === "out" ? "−" : ""}${M(Math.abs(d.amt), e)}</b>${d.biz ? `<span class="chip biz">${esc((d.c.business.name || "Business").split(" ")[0])}</span>` : ""}</div></div>`;
}

/* ---------- owed to me ---------- */
function owedTab(e) {
  const m = moneyModel(e), w = canWriteFin(e.id);
  const open = m.owed.filter(g => Math.abs(g.balance) > 0.004).sort((a, b) => (m.biz.has(b.party_id) - m.biz.has(a.party_id)) || b.balance - a.balance);
  const settled = m.owed.filter(g => Math.abs(g.balance) <= 0.004);
  return `<div class="mn-total"><span>Total owed to me</span><b class="num">${M(m.owedTotal, e)}</b></div>
  ${w ? `<div class="btnrow noprint"><button class="btn" data-act="mn-manual" data-entity="${e.id}" data-kind="lent">${ICON.plus}I lent or paid for someone</button><button class="btn" data-act="mn-manual" data-entity="${e.id}" data-kind="paid_for_business">${ICON.plus}I paid for a business</button><button class="btn" data-act="mn-add-existing" data-entity="${e.id}" data-side="owed_to_me">Add an amount already owed</button></div>` : ""}
  ${open.length ? `<div class="list">${open.map(g => groupRow(e, m, g, "owed")).join("")}</div>` : emptyState("Nobody owes you anything", "When you lend money or pay for someone — or for one of your businesses — it shows here until it's paid back.")}
  ${settled.length ? `<details class="mn-settled"><summary>Settled (${settled.length})</summary><div class="list compact">${settled.map(g => groupRow(e, m, g, "owed")).join("")}</div></details>` : ""}`;
}
function groupRow(e, m, g, side) {
  const b = side === "owed" && m.biz.get(g.party_id), o = obligationFor(g.account.id, g.party_id);
  const n = g.lines.filter(l => side === "owed" ? Number(l.debit) > 0 : Number(l.credit) > 0).length;
  const kind = side === "owe" ? debtKind(g) : null;
  const meta = side === "owed" ? [b ? "Your business" : g.account.name, `${n} item${n === 1 ? "" : "s"}`, o && o.expected_date ? `expected ${fmtDate(o.expected_date)}` : ""]
    : [DEBT_KIND_LABEL[kind], o && o.installment ? `${M(o.installment, e)} a month` : "", o && o.due_day ? `due on the ${ordinal(o.due_day)}` : o && o.due_date ? `due ${fmtDate(o.due_date)}` : "", !o ? "add details" : ""];
  return `<div class="trow mn-group ${b ? "biz" : ""}" data-act="${side === "owed" ? "mn-owed" : "mn-owe"}" data-entity="${e.id}" data-key="${g.key}" role="button" tabindex="0">
    <span class="mn-ico ${side === "owed" ? "in" : "out"}">${side === "owed" ? (b ? "🏢" : "👤") : kindIcon(kind)}</span>
    <div class="tmain"><div class="ttitle">${esc(groupName(g))}</div><div class="tmeta">${meta.filter(Boolean).map(esc).join(" · ")}</div></div>
    <div class="tside"><b class="num">${M(g.balance, e)}</b>${b ? `<span class="chip biz">Business</span>` : ""}</div></div>`;
}
const ordinal = n => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");

/* ---------- I owe ---------- */
function oweTab(e) {
  const m = moneyModel(e), w = canWriteFin(e.id);
  const open = m.owe.filter(g => Math.abs(g.balance) > 0.004 || (obligationFor(g.account.id, g.party_id) && !obligationFor(g.account.id, g.party_id).archived)).sort((a, b) => b.balance - a.balance);
  const byKind = {}; for (const g of open) { const k = debtKind(g); byKind[k] = r2((byKind[k] || 0) + g.balance); }
  const monthly = r2(open.reduce((s, g) => s + Number((obligationFor(g.account.id, g.party_id) || {}).installment || 0), 0));
  return `<div class="mn-total out"><span>Total I owe</span><b class="num">${M(m.oweTotal, e)}</b></div>
  ${Object.keys(byKind).length > 1 ? `<div class="mn-kinds">${Object.entries(byKind).map(([k, v]) => `<span>${kindIcon(k)} ${DEBT_KIND_LABEL[k]} <b class="num">${M(v, e)}</b></span>`).join("")}</div>` : ""}
  ${monthly ? `<p class="hint">Monthly instalments you've recorded: <b class="num">${M(monthly, e)}</b></p>` : ""}
  ${w ? `<div class="btnrow noprint"><button class="btn" data-act="mn-manual" data-entity="${e.id}" data-kind="debt_payment">${ICON.plus}I paid a loan or card</button><button class="btn" data-act="mn-manual" data-entity="${e.id}" data-kind="borrowed">${ICON.plus}I borrowed money</button><button class="btn" data-act="mn-add-existing" data-entity="${e.id}" data-side="i_owe">Add an existing loan or debt</button></div>` : ""}
  ${open.length ? `<div class="list">${open.map(g => groupRow(e, m, g, "owe")).join("")}</div>` : emptyState("No debts recorded", "Add bank loans, credit cards, money borrowed from friends or anything else you owe.")}`;
}

/* ---------- accounts & net position ---------- */
function accountsTab(e) {
  const m = moneyModel(e), w = canWriteFin(e.id), ls = m.ls;
  const other = accountsOf(e.id, a => a.type === "asset" && !CASH.has(a.subtype) && a.subtype !== "receivable").map(a => ({ a, b: m.bal(a) })).filter(x => x.b);
  const row = (x, extra = "") => `<div class="trow" data-act="fin-ledger" data-id="${x.a.id}" role="button" tabindex="0"><span class="mn-ico neutral">${x.a.subtype === "card" ? "💳" : x.a.subtype === "cash" ? "💵" : SAVINGS.has(x.a.subtype) ? "📈" : x.a.subtype === "fixed_asset" ? "🏠" : "🏦"}</span>
    <div class="tmain"><div class="ttitle">${esc(x.a.name)}</div><div class="tmeta">${extra}</div></div><div class="tside"><b class="num">${M(x.b, e)}</b></div></div>`;
  const checkMeta = x => { const c = lastBalanceCheck(x.a.id); if (!c) return w ? `<button class="linkbtn" data-act="mn-balcheck" data-entity="${e.id}" data-acc="${x.a.id}">Enter what the bank shows</button>` : "";
    const diff = r2(Number(c.balance) - booksAt(ls, x.a.id, c.as_of));
    return `Bank showed ${M(c.balance, e)} on ${fmtDate(c.as_of)} · ${Math.abs(diff) < 0.005 ? `<span class="ok-text">${ICON.check} matches your books</span>` : `<span class="bad-text">differs by ${M(diff, e)}</span>`}${w ? ` · <button class="linkbtn" data-act="mn-balcheck" data-entity="${e.id}" data-acc="${x.a.id}">Update</button>` : ""}`; };
  return `<div class="grid-2 mn-grid">
  <section class="sect"><div class="sect-h"><h2>Cash & bank</h2><span class="c num">${M(m.cash, e)}</span></div><div class="list">${m.cashAccs.map(x => row(x, checkMeta(x))).join("") || `<p class="calm">No accounts.</p>`}</div>
    <p class="hint">"Your books" is the balance from what you've recorded. Enter what the bank app shows to catch anything missing — differences are flagged, never adjusted for you.</p></section>
  <section class="sect"><div class="sect-h"><h2>Net position</h2><span class="c">as of ${fmtDate(today())}</span></div><table class="rtable fs"><tbody>
    <tr class="grouprow"><th colspan="2">What I have</th></tr><tr><td>Cash & bank</td><td class="num">${M(m.cash, e)}</td></tr>
    ${other.map(x => `<tr><td>${esc(x.a.name)}</td><td class="num">${M(x.b, e)}</td></tr>`).join("")}
    <tr class="clickrow" onclick="location.hash='#/finance/${e.id}/owed'"><td>Owed to me</td><td class="num">${M(m.owedTotal, e)}</td></tr>
    <tr class="grouprow"><th colspan="2">What I owe</th></tr>${m.owe.filter(g => Math.abs(g.balance) > 0.004).map(g => `<tr><td>${esc(groupName(g))}</td><td class="num">(${M(g.balance, e)})</td></tr>`).join("") || `<tr><td class="calm">Nothing</td><td></td></tr>`}
    <tr class="total"><td>Net position</td><td class="num">${M(m.net, e)}</td></tr></tbody></table></section></div>
  ${m.cards.length ? `<section class="sect"><div class="sect-h"><h2>Credit cards</h2></div><div class="list">${m.cards.map(x => row({ a: x.a, b: x.b }, `owed on the card${lastBalanceCheck(x.a.id) ? ` · statement showed ${M(-Number(lastBalanceCheck(x.a.id).balance), e)}` : ""}${w ? ` · <button class="linkbtn" data-act="mn-balcheck" data-entity="${e.id}" data-acc="${x.a.id}">Enter card statement balance</button>` : ""}`)).join("")}</div></section>` : ""}
  ${other.length ? `<section class="sect"><div class="sect-h"><h2>Savings, investments & property</h2></div><div class="list">${other.map(x => row(x, esc(x.a.subtype.replace("_", " ")))).join("")}</div></section>` : ""}
  ${w ? `<div class="btnrow noprint"><button class="btn" data-act="fin-opening">Enter opening balances</button><button class="btn" data-act="mn-manual" data-entity="${e.id}" data-kind="transfer">Move money between accounts</button><button class="btn" data-act="fin-account">New account</button></div>` : ""}`;
}
const booksAt = (ls, accId, asOf) => r2(ls.filter(l => l.account_id === accId && l.entry_date <= asOf).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0));

/* ---------- monthly report ---------- */
function monthTab(e) {
  const u = mu(), t = today(), ms = u.month || monthStart(t), me = monthEnd(ms) > t && ms === monthStart(t) ? t : monthEnd(ms);
  const m = moneyModel(e), s = monthSummary(m.ls, accById, m.biz, ms, me);
  const label = new Date(ms + "T12:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const cats = [...s.byCategory.entries()].map(([id, v]) => ({ a: accById(id), v })).filter(x => x.v).sort((a, b) => b.v - a.v), max = Math.max(...cats.map(c => c.v), 1);
  const flowList = (mp, sign) => [...mp.entries()].filter(([, v]) => v).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="mn-row ${sign}"><span>${FLOW_LABEL[k]}</span><b class="num">${M(v, e)}</b></div>`).join("") || `<p class="calm">Nothing.</p>`;
  return `<div class="weekpick noprint"><button class="btn sm" data-act="mn-month" data-m="${monthStart(addDays(ms, -1))}">‹</button><b>${label}</b>
    ${ms < monthStart(t) ? `<button class="btn sm" data-act="mn-month" data-m="${monthStart(addDays(monthEnd(ms), 1))}">›</button>` : ""}<button class="btn sm" data-act="rep-print">Print / PDF</button></div>
  <div class="report">
  <div class="mn-cards sm">
    <div class="mn-card in"><span class="mn-l">Income</span><span class="mn-n num">${M(s.income, e)}</span><span class="mn-s">Salary ${M(s.salary, e)}</span></div>
    <div class="mn-card out"><span class="mn-l">Spent on me & family</span><span class="mn-n num">${M(s.spending, e)}</span><span class="mn-s">${cats.length} categor${cats.length === 1 ? "y" : "ies"}</span></div>
    <div class="mn-card biz"><span class="mn-l">Paid for businesses</span><span class="mn-n num">${M(s.bizPaid, e)}</span><span class="mn-s">${s.bizRepaid ? `${M(s.bizRepaid, e)} paid back` : "kept apart from your spending"}</span></div>
    <div class="mn-card ${s.saved < 0 ? "bad" : ""}"><span class="mn-l">Saved</span><span class="mn-n num">${M(s.saved, e)}</span><span class="mn-s">income − spending</span></div></div>
  <div class="grid-2 mn-grid">
    <section class="sect"><div class="sect-h"><h2>Spending by category</h2></div>${cats.length ? `<div class="mn-cats">${cats.map(c => `<div class="mn-cat"><span>${esc(c.a.name)}</span><i style="width:${(c.v / max * 100).toFixed(1)}%"></i><b class="num">${M(c.v, e)}</b></div>`).join("")}</div>` : `<p class="calm">No spending recorded.</p>`}</section>
    <section class="sect"><div class="sect-h"><h2>Businesses</h2></div>${s.byBusiness.size ? [...s.byBusiness.values()].map(b => `<div class="mn-row biz"><span>${esc(b.name || "Business")}: paid by me</span><b class="num">${M(b.paid, e)}</b></div>${b.repaid ? `<div class="mn-row in"><span>${esc(b.name || "Business")}: paid me back</span><b class="num">${M(b.repaid, e)}</b></div>` : ""}`).join("") : `<p class="calm">No business payments this month.</p>`}</section>
    <section class="sect"><div class="sect-h"><h2>Money in (cash & bank)</h2><span class="c num">${M(s.cashIn, e)}</span></div>${flowList(s.flowsIn, "in")}</section>
    <section class="sect"><div class="sect-h"><h2>Money out (cash & bank)</h2><span class="c num">${M(s.cashOut, e)}</span></div>${flowList(s.flowsOut, "out")}</section></div>
  <div class="mn-total ${s.netCash < 0 ? "out" : ""}"><span>Net change in cash & bank</span><b class="num">${M(s.netCash, e)}</b></div>
  <p class="hint">Money moved between your own accounts isn't counted as in or out. Card purchases count as spending when you buy; paying the card bill is a repayment. Reimbursements from a business are not income.</p></div>`;
}

/* ---------- advanced ---------- */
function advancedTab(e) {
  return `<p class="hint">The full accounting underneath your money pages. You don't need these day to day — they're here when you want the detail.</p>
  <div class="list mn-adv">${Object.entries(ADV_TABS).map(([k, l]) => `<a class="trow" href="#/finance/${e.id}/${k}"><div class="tmain"><div class="ttitle">${l}</div><div class="tmeta">${ADV_HINT[k]}</div></div><div class="tside">${ICON.chevron}</div></a>`).join("")}</div>`;
}
function advancedShell(e, tab, classic) {
  return `<div class="mn-advbar noprint"><a href="#/finance/${e.id}/advanced">${ICON.back}Advanced</a><select class="input sm" onchange="location.hash='#/finance/${e.id}/'+this.value">${Object.entries(ADV_TABS).map(([k, l]) => `<option value="${k}" ${k === tab ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    ${classic(tab === "chart" ? "accounts" : tab)}`;
}

/** Quick figures for the Finance home card. */
export function moneyCardFigures(e) { const m = moneyModel(e); return { cash: m.cash, owed: m.owedTotal, owe: m.oweTotal, net: m.net }; }
export { receivableItems, byJournal };
