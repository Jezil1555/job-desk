// Finance rules and reports. Pure functions over posted ledger lines; unit-tested.
// Amounts are in each entity's base currency. Only posted journals count — drafts never touch the reports.
import { addDays } from "./util.js";

export const ACCOUNT_TYPES = { asset: "Assets", liability: "Liabilities", equity: "Equity", income: "Income", expense: "Expenses" };
export const NORMAL_DEBIT = new Set(["asset", "expense"]);
export const SUBTYPE_LABEL = { cash: "Cash", bank: "Bank", card: "Credit card", receivable: "Receivable", payable: "Payable", inventory: "Inventory", fixed_asset: "Fixed asset",
  investment: "Investment", earmarked: "Earmarked", loan: "Loan", partner: "Partner", cogs: "Cost of sales", other: "Other" };
export const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

export function money(n, ccy = "", opts = {}) {
  const v = r2(n), neg = v < 0;
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const body = (ccy ? ccy + " " : "") + s;
  return neg ? (opts.paren ? `(${body})` : `−${body}`) : body;
}

/** Attach entry dates/status from journals; keep posted only. */
export function postedLines(lines, journals) {
  const jm = new Map(journals.map(j => [j.id, j]));
  return lines.map(l => ({ ...l, journal: jm.get(l.journal_id) })).filter(l => l.journal && l.journal.status === "posted")
    .map(l => ({ ...l, entry_date: l.journal.entry_date }));
}
const inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to);

/** Net movement (debit − credit) per account over a date range. */
export function movements(lines, from, to) {
  const m = new Map();
  for (const l of lines) {
    if (!inRange(l.entry_date, from, to)) continue;
    const r = m.get(l.account_id) || { debit: 0, credit: 0 };
    r.debit += Number(l.debit) || 0; r.credit += Number(l.credit) || 0;
    m.set(l.account_id, r);
  }
  for (const r of m.values()) { r.debit = r2(r.debit); r.credit = r2(r.credit); r.net = r2(r.debit - r.credit); }
  return m;
}
/** Balance shown in the account's normal direction (assets/expenses: debit positive; others: credit positive). */
export const natural = (acc, net) => r2(NORMAL_DEBIT.has(acc.type) ? net : -net);

export function trialBalance(accounts, lines, asOf) {
  const mv = movements(lines, null, asOf);
  const rows = accounts.map(a => { const n = (mv.get(a.id) || { net: 0 }).net; return { account: a, debit: n > 0 ? n : 0, credit: n < 0 ? -n : 0 }; })
    .filter(r => r.debit || r.credit).sort((x, y) => x.account.code.localeCompare(y.account.code));
  const debit = r2(rows.reduce((s, r) => s + r.debit, 0)), credit = r2(rows.reduce((s, r) => s + r.credit, 0));
  return { rows, debit, credit, balanced: debit === credit };
}

export function profitAndLoss(accounts, lines, from, to) {
  const mv = movements(lines, from, to);
  const pick = pred => accounts.filter(pred).map(a => ({ account: a, amount: natural(a, (mv.get(a.id) || { net: 0 }).net) })).filter(r => r.amount).sort((x, y) => x.account.code.localeCompare(y.account.code));
  const income = pick(a => a.type === "income"), cogs = pick(a => a.type === "expense" && a.subtype === "cogs"), expenses = pick(a => a.type === "expense" && a.subtype !== "cogs");
  const sum = rs => r2(rs.reduce((s, r) => s + r.amount, 0));
  const totalIncome = sum(income), totalCogs = sum(cogs), totalExpenses = sum(expenses);
  const grossProfit = r2(totalIncome - totalCogs), netProfit = r2(grossProfit - totalExpenses);
  return { income, cogs, expenses, totalIncome, totalCogs, totalExpenses, grossProfit, netProfit,
    grossMargin: totalIncome ? Math.round(1000 * grossProfit / totalIncome) / 10 : null, netMargin: totalIncome ? Math.round(1000 * netProfit / totalIncome) / 10 : null };
}

/** Balance sheet as at a date. Profit not yet closed to retained earnings is shown as "current earnings". */
export function balanceSheet(accounts, lines, asOf) {
  const mv = movements(lines, null, asOf);
  const sect = type => accounts.filter(a => a.type === type).map(a => ({ account: a, amount: natural(a, (mv.get(a.id) || { net: 0 }).net) })).filter(r => r.amount)
    .sort((x, y) => x.account.code.localeCompare(y.account.code));
  const assets = sect("asset"), liabilities = sect("liability"), equity = sect("equity");
  const earnings = r2(accounts.filter(a => a.type === "income" || a.type === "expense").reduce((s, a) => s - ((mv.get(a.id) || { net: 0 }).net), 0));
  const sum = rs => r2(rs.reduce((s, r) => s + r.amount, 0));
  const totalAssets = sum(assets), totalLiabilities = sum(liabilities), totalEquity = r2(sum(equity) + earnings);
  return { assets, liabilities, equity, earnings, totalAssets, totalLiabilities, totalEquity, balanced: r2(totalAssets - totalLiabilities - totalEquity) === 0,
    netWorth: r2(totalAssets - totalLiabilities) };
}

const CASH_SUBTYPES = new Set(["cash", "bank"]);
export function cashCategory(acc) {
  if (!acc) return "operating";
  if (["fixed_asset", "investment"].includes(acc.subtype)) return "investing";
  if (["loan", "partner", "card"].includes(acc.subtype) || acc.type === "equity") return "financing";
  return "operating";
}
/** Direct-method cash flow: each entry's cash movement is classified by its largest non-cash counterpart line. */
export function cashFlow(accounts, lines, from, to) {
  const am = new Map(accounts.map(a => [a.id, a]));
  const isCash = id => CASH_SUBTYPES.has((am.get(id) || {}).subtype);
  const opening = r2(lines.filter(l => isCash(l.account_id) && l.entry_date < from).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0));
  const byJ = new Map();
  for (const l of lines) if (inRange(l.entry_date, from, to)) { const a = byJ.get(l.journal_id) || []; a.push(l); byJ.set(l.journal_id, a); }
  const cats = { operating: { in: 0, out: 0 }, investing: { in: 0, out: 0 }, financing: { in: 0, out: 0 } };
  const detail = [];
  for (const [jid, ls] of byJ) {
    const cash = r2(ls.filter(l => isCash(l.account_id)).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0));
    if (!cash) continue;
    const other = ls.filter(l => !isCash(l.account_id)).sort((a, b) => (Number(b.debit) + Number(b.credit)) - (Number(a.debit) + Number(a.credit)))[0];
    const cat = cashCategory(other && am.get(other.account_id));
    cash > 0 ? (cats[cat].in += cash) : (cats[cat].out += -cash);
    detail.push({ journal_id: jid, category: cat, amount: cash, counterpart: other && am.get(other.account_id) });
  }
  for (const c of Object.values(cats)) { c.in = r2(c.in); c.out = r2(c.out); c.net = r2(c.in - c.out); }
  const net = r2(cats.operating.net + cats.investing.net + cats.financing.net);
  return { opening, ...cats, net, closing: r2(opening + net), detail };
}

/** Running ledger for one account, in its normal direction. */
export function ledger(account, lines, from, to) {
  const ls = lines.filter(l => l.account_id === account.id).sort((a, b) => a.entry_date.localeCompare(b.entry_date) || (a.journal.number || 0) - (b.journal.number || 0) || a.sort - b.sort);
  let bal = r2(ls.filter(l => from && l.entry_date < from).reduce((s, l) => s + natural(account, Number(l.debit) - Number(l.credit)), 0));
  const opening = bal, rows = [];
  for (const l of ls) {
    if (!inRange(l.entry_date, from, to)) continue;
    bal = r2(bal + natural(account, Number(l.debit) - Number(l.credit)));
    rows.push({ line: l, balance: bal });
  }
  return { opening, rows, closing: bal };
}

/** Invoice status from totals (draft/void pass through). */
export function invoiceStatus(inv, totals, today) {
  if (inv.status !== "posted") return inv.status;
  const t = totals || { total: 0, paid: 0 }, out = r2(Number(t.total) - Number(t.paid));
  if (out <= 0) return "paid";
  if (inv.due_date && inv.due_date < today) return "overdue";
  return Number(t.paid) > 0 ? "partial" : "unpaid";
}
export const INVOICE_STATUS_LABEL = { draft: "Draft", unpaid: "Unpaid", partial: "Part paid", paid: "Paid", overdue: "Overdue", void: "Void" };

/** Ageing of outstanding posted invoices/bills by days past due. Invoices with no due date are reported separately (never assumed). */
export function aging(invoices, totalsById, asOf) {
  const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90: 0, no_due: 0 };
  const rows = [];
  for (const inv of invoices) {
    if (inv.status !== "posted") continue;
    const t = totalsById.get(inv.id); if (!t) continue;
    const out = r2(Number(t.total) - Number(t.paid)); if (out <= 0) continue;
    let b = "no_due", days = null;
    if (inv.due_date) {
      days = Math.round((Date.parse(asOf) - Date.parse(inv.due_date)) / 86400000);
      b = days <= 0 ? "current" : days <= 30 ? "d1_30" : days <= 60 ? "d31_60" : days <= 90 ? "d61_90" : "d90";
    }
    buckets[b] = r2(buckets[b] + out);
    rows.push({ invoice: inv, outstanding: out, days, bucket: b });
  }
  const total = r2(Object.values(buckets).reduce((s, v) => s + v, 0));
  return { buckets, total, rows: rows.sort((a, b) => (b.days ?? -1e9) - (a.days ?? -1e9)) };
}
/** Invoice totals converted to the books' base currency at the rate each document was posted at.
 *  Foreign-currency invoices keep their totals in their own currency (fin_invoice_totals); every aggregate uses this map. */
export function baseTotals(invoices, totals) {
  const rate = new Map(invoices.map(i => [i.id, Number(i.fx_rate) || 1]));
  const out = new Map();
  for (const [id, t] of totals) { const k = rate.get(id) || 1; out.set(id, { ...t, total: r2(Number(t.total) * k), paid: r2(Number(t.paid) * k) }); }
  return out;
}
/** Change in the base value of an open foreign item at a closing rate; positive = gain for the books. */
export function revalueGain(kind, outstanding, bookedRate, closingRate) {
  const booked = r2(outstanding * bookedRate), now = r2(outstanding * closingRate), diff = r2(now - booked);
  return { booked, now, gain: kind === "sale" ? diff : r2(-diff) };
}
export const AGING_LABEL = { current: "Not yet due", d1_30: "1–30 days", d31_60: "31–60 days", d61_90: "61–90 days", d90: "Over 90 days", no_due: "No due date" };

/** Budget vs actual for income and expense accounts across months (YYYY-MM-01 keys). */
export function budgetVsActual(accounts, budgets, lines, months) {
  const rows = [];
  const from = months[0], to = addDays(monthEnd(months[months.length - 1]), 0);
  const mv = movements(lines, from, to);
  for (const a of accounts.filter(x => x.type === "income" || x.type === "expense")) {
    const budget = r2(budgets.filter(b => b.account_id === a.id && months.includes(b.month)).reduce((s, b) => s + Number(b.amount), 0));
    const actual = natural(a, (mv.get(a.id) || { net: 0 }).net);
    if (!budget && !actual) continue;
    const variance = r2(a.type === "income" ? actual - budget : budget - actual); // positive = favourable
    rows.push({ account: a, budget, actual, variance, pct: budget ? Math.round(100 * actual / budget) : null });
  }
  return rows.sort((x, y) => x.account.code.localeCompare(y.account.code));
}
export function monthEnd(m) { const [y, mo] = m.split("-").map(Number); const d = new Date(Date.UTC(y, mo, 0)); return d.toISOString().slice(0, 10); }
export const monthStart = d => d.slice(0, 7) + "-01";
export function monthsBetween(from, to) { const out = []; let [y, m] = from.split("-").map(Number); const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${String(m).padStart(2, "0")}-01`); m++; if (m > 12) { m = 1; y++; } } return out; }
/** Start of the financial year containing a date. */
export function fiscalYearStart(dateStr, startMonth = 1) {
  const [y, m] = dateStr.split("-").map(Number);
  const yr = m >= startMonth ? y : y - 1;
  return `${yr}-${String(startMonth).padStart(2, "0")}-01`;
}

/** Draft entry check used by the editor. */
export function entryTotals(lines) {
  const debit = r2(lines.reduce((s, l) => s + (Number(l.debit) || 0), 0)), credit = r2(lines.reduce((s, l) => s + (Number(l.credit) || 0), 0));
  const filled = lines.filter(l => l.account_id && ((Number(l.debit) || 0) > 0 || (Number(l.credit) || 0) > 0));
  const problems = [];
  if (filled.length < 2) problems.push("Add at least two lines with an account and an amount.");
  if (lines.some(l => (Number(l.debit) || 0) > 0 && (Number(l.credit) || 0) > 0)) problems.push("A line can be a debit or a credit, not both.");
  if (lines.some(l => !l.account_id && ((Number(l.debit) || 0) > 0 || (Number(l.credit) || 0) > 0))) problems.push("Every amount needs an account.");
  if (debit !== credit) problems.push(`Debits (${money(debit)}) and credits (${money(credit)}) differ by ${money(Math.abs(debit - credit))}.`);
  if (debit === 0) problems.push("The entry has no amount.");
  return { debit, credit, diff: r2(debit - credit), ok: problems.length === 0, problems };
}

/** Convert between currencies with management rates expressed as units per 1 reporting-currency unit, e.g. {INR: 26.10} with reporting QAR. */
export function convert(amount, from, to, rates) {
  if (from === to) return r2(amount);
  const fr = from === rates.base ? 1 : rates[from], tr = to === rates.base ? 1 : rates[to];
  if (!fr || !tr) return null;
  return r2(Number(amount) / fr * tr);
}

/* ---------- bank statement CSV import ---------- */
function splitCSVLine(line, sep) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === sep) { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur); return out.map(s => s.trim());
}
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** Parse a date written day-first (GCC/India banks) or ISO. Returns YYYY-MM-DD or null. */
export function parseBankDate(s) {
  s = String(s || "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (m) return iso(fullYear(+m[3]), +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3})[A-Za-z]*[\s\-\/,]+(\d{2,4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return iso(fullYear(+m[3]), MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}
const fullYear = y => y < 100 ? 2000 + y : y;
function iso(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return dt.toISOString().slice(0, 10);
}
export function parseAmount(s) {
  s = String(s ?? "").trim(); if (!s) return null;
  let neg = /^\(.*\)$/.test(s) || /^-/.test(s) || /\s?(dr|DR|Dr)$/.test(s);
  const n = Number(s.replace(/[()\s,]|[A-Za-z]{2,3}$/g, "").replace(/^-/, "").replace(/[^\d.\-]/g, ""));
  if (!isFinite(n)) return null;
  return r2(neg ? -n : n);
}
/** Statement CSV → rows {line_date, description, amount, reference}. Money in is positive. Supports one signed Amount column or separate Debit/Credit (Withdrawal/Deposit) columns. */
export function parseStatementCSV(text) {
  const lines = String(text || "").replace(/^﻿/, "").split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { rows: [], errors: ["The file is empty."] };
  const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ";" : lines[0].includes("\t") ? "\t" : ",";
  // find the header row (banks often put account details above it)
  let hi = lines.findIndex(l => /date/i.test(l) && /(amount|debit|credit|withdraw|deposit)/i.test(l));
  if (hi < 0) return { rows: [], errors: ["Couldn't find a header row with Date and Amount (or Debit/Credit) columns."] };
  const head = splitCSVLine(lines[hi], sep).map(h => h.toLowerCase());
  const find = (...names) => head.findIndex(h => names.some(n => h.includes(n)));
  const iDate = find("value date", "txn date", "transaction date", "date"), iDesc = find("description", "narration", "details", "particulars", "remarks", "memo");
  const iAmt = head.findIndex(h => h === "amount" || h.startsWith("amount")), iDr = find("debit", "withdraw", "paid out", "money out"), iCr = find("credit", "deposit", "paid in", "money in");
  const iRef = find("reference", "ref", "cheque", "chq");
  if (iDate < 0 || (iAmt < 0 && (iDr < 0 || iCr < 0))) return { rows: [], errors: ["Need a Date column and either Amount or both Debit and Credit columns."] };
  const rows = [], errors = [];
  for (let i = hi + 1; i < lines.length; i++) {
    const c = splitCSVLine(lines[i], sep);
    if (c.every(x => !x)) continue;
    const d = parseBankDate(c[iDate]);
    if (!d) { if (/total|balance|closing|opening/i.test(lines[i])) continue; errors.push(`Row ${i + 1}: unreadable date "${c[iDate] || ""}"`); continue; }
    let amt;
    if (iAmt >= 0 && c[iAmt]) amt = parseAmount(c[iAmt]);
    else { const dr = parseAmount(c[iDr]) || 0, cr = parseAmount(c[iCr]) || 0; amt = r2(Math.abs(cr) - Math.abs(dr)); }
    if (amt === null || amt === 0) { errors.push(`Row ${i + 1}: no amount`); continue; }
    rows.push({ line_date: d, description: (iDesc >= 0 ? c[iDesc] : "") || "(no description)", amount: amt, reference: iRef >= 0 && c[iRef] ? c[iRef] : null });
  }
  return { rows, errors };
}

/** Suggest ledger lines that could match a statement line: same account, same signed amount, unmatched, date within ±7 days. Closest date first. */
export function matchCandidates(stmt, lines, used = new Set()) {
  return lines.filter(l => l.account_id === stmt.account_id && !l.statement_line_id && !used.has(l.id) && r2(Number(l.debit) - Number(l.credit)) === r2(stmt.amount))
    .map(l => ({ line: l, gap: Math.abs(Date.parse(l.entry_date) - Date.parse(stmt.line_date)) / 86400000 }))
    .filter(x => x.gap <= 7).sort((a, b) => a.gap - b.gap);
}
