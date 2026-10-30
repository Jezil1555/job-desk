import { test } from "node:test";
import assert from "node:assert/strict";
import { postedLines, trialBalance, profitAndLoss, balanceSheet, cashFlow, ledger, invoiceStatus, aging, budgetVsActual, entryTotals, convert,
  parseStatementCSV, parseBankDate, parseAmount, matchCandidates, money, fiscalYearStart, monthsBetween, monthEnd } from "../../public/js/finance.js";

// A small fictional set of books (test fixture only)
const A = (id, code, type, subtype = "other") => ({ id, code, name: id, type, subtype });
const accounts = [A("bank", "1010", "asset", "bank"), A("ar", "1100", "asset", "receivable"), A("inv", "1200", "asset", "inventory"), A("eqp", "1500", "asset", "fixed_asset"),
  A("ap", "2000", "liability", "payable"), A("loan", "2200", "liability", "loan"), A("cap", "3000", "equity", "partner"), A("open", "3900", "equity"),
  A("sales", "4000", "income"), A("cogs", "5000", "expense", "cogs"), A("rent", "6000", "expense")];
let n = 0;
const J = (id, date, lines, status = "posted") => ({ j: { id, entry_date: date, status, number: ++n }, lines: lines.map(([acc, dr, cr], i) => ({ id: id + i, journal_id: id, account_id: acc, debit: dr, credit: cr, sort: i })) });
const book = [
  J("j1", "2026-09-30", [["bank", 10000, 0], ["cap", 0, 10000]]),            // partner capital in
  J("j2", "2026-10-02", [["eqp", 3000, 0], ["bank", 0, 3000]]),              // buy equipment
  J("j3", "2026-10-05", [["inv", 2000, 0], ["ap", 0, 2000]]),                // stock on credit
  J("j4", "2026-10-10", [["ar", 1500, 0], ["sales", 0, 1500], ["cogs", 600, 0], ["inv", 0, 600]]), // sale
  J("j5", "2026-10-12", [["bank", 1000, 0], ["ar", 0, 1000]]),               // customer pays part
  J("j6", "2026-10-15", [["rent", 800, 0], ["bank", 0, 800]]),               // rent
  J("j7", "2026-10-20", [["bank", 5000, 0], ["loan", 0, 5000]]),             // loan received
  J("j8", "2026-10-25", [["rent", 999, 0], ["bank", 0, 999]], "draft"),      // draft: must be ignored
];
const journals = book.map(b => b.j), lines = postedLines(book.flatMap(b => b.lines), journals);

test("only posted entries reach the reports", () => {
  assert.equal(lines.length, 16);
  assert.ok(!lines.some(l => l.journal_id === "j8"));
});

test("trial balance balances", () => {
  const tb = trialBalance(accounts, lines, "2026-10-31");
  assert.equal(tb.debit, tb.credit);
  assert.equal(tb.debit, 18500); // bank 12200 + ar 500 + inv 1400 + eqp 3000 + cogs 600 + rent 800
  assert.equal(tb.rows.find(r => r.account.id === "bank").debit, 12200);
});

test("profit and loss", () => {
  const pl = profitAndLoss(accounts, lines, "2026-10-01", "2026-10-31");
  assert.equal(pl.totalIncome, 1500); assert.equal(pl.totalCogs, 600); assert.equal(pl.grossProfit, 900);
  assert.equal(pl.totalExpenses, 800); assert.equal(pl.netProfit, 100); assert.equal(pl.grossMargin, 60);
});

test("balance sheet balances with current earnings", () => {
  const bs = balanceSheet(accounts, lines, "2026-10-31");
  assert.equal(bs.totalAssets, 12200 + 500 + 1400 + 3000);
  assert.equal(bs.totalLiabilities, 7000);
  assert.equal(bs.earnings, 100);
  assert.equal(bs.totalEquity, 10100);
  assert.ok(bs.balanced);
});

test("cash flow classifies operating, investing and financing", () => {
  const cf = cashFlow(accounts, lines, "2026-10-01", "2026-10-31");
  assert.equal(cf.opening, 10000);
  assert.deepEqual([cf.operating.net, cf.investing.net, cf.financing.net], [200, -3000, 5000]);
  assert.equal(cf.closing, 12200);
});

test("ledger runs a balance in the account's normal direction", () => {
  const lg = ledger(accounts[0], lines, "2026-10-01", "2026-10-31");
  assert.equal(lg.opening, 10000);
  assert.deepEqual(lg.rows.map(r => r.balance), [7000, 8000, 7200, 12200]);
  const ap = ledger(accounts.find(a => a.id === "ap"), lines);
  assert.equal(ap.closing, 2000);
});

test("invoice status and ageing never assume a due date", () => {
  const today = "2026-10-29";
  assert.equal(invoiceStatus({ status: "posted", due_date: "2026-10-01" }, { total: 100, paid: 0 }, today), "overdue");
  assert.equal(invoiceStatus({ status: "posted", due_date: null }, { total: 100, paid: 40 }, today), "partial");
  assert.equal(invoiceStatus({ status: "posted" }, { total: 100, paid: 100 }, today), "paid");
  assert.equal(invoiceStatus({ status: "void" }, { total: 100, paid: 0 }, today), "void");
  const inv = [{ id: 1, status: "posted", due_date: "2026-10-20" }, { id: 2, status: "posted", due_date: "2026-07-01" }, { id: 3, status: "posted", due_date: null }, { id: 4, status: "draft", due_date: "2026-01-01" }, { id: 5, status: "posted", due_date: "2026-11-30" }];
  const t = new Map([[1, { total: 500, paid: 100 }], [2, { total: 300, paid: 0 }], [3, { total: 50, paid: 0 }], [4, { total: 9, paid: 0 }], [5, { total: 70, paid: 0 }]]);
  const ag = aging(inv, t, today);
  assert.deepEqual(ag.buckets, { current: 70, d1_30: 400, d31_60: 0, d61_90: 0, d90: 300, no_due: 50 });
  assert.equal(ag.total, 820);
});

test("budget vs actual: favourable is positive for both income and expenses", () => {
  const rows = budgetVsActual(accounts, [{ account_id: "rent", month: "2026-10-01", amount: 1000 }, { account_id: "sales", month: "2026-10-01", amount: 2000 }], lines, ["2026-10-01"]);
  const rent = rows.find(r => r.account.id === "rent"), sales = rows.find(r => r.account.id === "sales");
  assert.deepEqual([rent.actual, rent.variance, rent.pct], [800, 200, 80]);
  assert.deepEqual([sales.actual, sales.variance], [1500, -500]);
});

test("entry editor checks", () => {
  assert.ok(entryTotals([{ account_id: "a", debit: 10 }, { account_id: "b", credit: 10 }]).ok);
  const bad = entryTotals([{ account_id: "a", debit: 10 }, { account_id: "b", credit: 9 }]);
  assert.equal(bad.ok, false); assert.equal(bad.diff, 1);
  assert.equal(entryTotals([{ account_id: "a", debit: 10, credit: 10 }, { account_id: "b", credit: 0 }]).ok, false);
  assert.equal(entryTotals([{ account_id: "", debit: 10 }, { account_id: "b", credit: 10 }]).ok, false);
});

test("management-rate conversion (26.10 INR = 1 QAR)", () => {
  const rates = { base: "QAR", INR: 26.10 };
  assert.equal(convert(26100, "INR", "QAR", rates), 1000);
  assert.equal(convert(1000, "QAR", "INR", rates), 26100);
  assert.equal(convert(5, "USD", "QAR", rates), null);
});

test("bank dates are read day-first", () => {
  assert.equal(parseBankDate("05/10/2026"), "2026-10-05");
  assert.equal(parseBankDate("5-Oct-2026"), "2026-10-05");
  assert.equal(parseBankDate("05 Oct 26"), "2026-10-05");
  assert.equal(parseBankDate("2026-10-05"), "2026-10-05");
  assert.equal(parseBankDate("31/02/2026"), null);
  assert.equal(parseAmount("1,250.50"), 1250.5); assert.equal(parseAmount("(300.00)"), -300); assert.equal(parseAmount("-12"), -12); assert.equal(parseAmount("45.00 Dr"), -45);
});

test("statement CSV with Debit/Credit columns and a preamble", () => {
  const csv = `Account,QNB Current 0123\nPeriod,Oct 2026\n\nTxn Date,Value Date,Description,Debit,Credit,Balance\n01/10/2026,01/10/2026,"POS DOHA, QA",45.00,,955.00\n02/10/2026,02/10/2026,TT FROM AL NOOR,,1000.00,1955.00\nClosing balance,,,,,1955.00`;
  const r = parseStatementCSV(csv);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rows.map(x => [x.line_date, x.description, x.amount]), [["2026-10-01", "POS DOHA, QA", -45], ["2026-10-02", "TT FROM AL NOOR", 1000]]);
});

test("statement CSV with a signed Amount column", () => {
  const r = parseStatementCSV("Date;Narration;Amount;Ref\n2026-10-03;UPI rent;-25000;R1\n2026-10-04;Salary;150000;");
  assert.deepEqual(r.rows.map(x => [x.amount, x.reference]), [[-25000, "R1"], [150000, null]]);
  assert.ok(parseStatementCSV("foo,bar\n1,2").errors.length);
});

test("match candidates: same account and amount, within a week, closest first", () => {
  const st = { account_id: "bank", amount: 1000, line_date: "2026-10-13" };
  const c = matchCandidates(st, lines);
  assert.equal(c.length, 1); assert.equal(c[0].line.journal_id, "j5");
  assert.equal(matchCandidates({ ...st, line_date: "2026-11-30" }, lines).length, 0);
});

test("formatting and periods", () => {
  assert.equal(money(-1234.5, "QAR"), "−QAR 1,234.50");
  assert.equal(money(1234.5, "INR", { paren: true }), "INR 1,234.50");
  assert.equal(fiscalYearStart("2026-03-15", 4), "2025-04-01");
  assert.equal(fiscalYearStart("2026-10-29", 1), "2026-01-01");
  assert.deepEqual(monthsBetween("2026-11-01", "2027-02-01"), ["2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01"]);
  assert.equal(monthEnd("2026-02-01"), "2026-02-28");
});
