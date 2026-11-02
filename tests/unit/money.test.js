import { test } from "node:test";
import assert from "node:assert/strict";
import { postedLines } from "../../public/js/finance.js";
import { classifyJournal, monthSummary, groupedBalances, receivableItems, parseBankMessage, parseBankText, splitMessages, suggest, businessAccountFor, rowProblem, businessParties } from "../../public/js/money.js";

// Fictional personal books (test fixture only)
const A = (id, name, type, subtype = "other") => ({ id, code: id, name, type, subtype, is_active: true });
const accounts = [A("cash", "Cash in hand", "asset", "cash"), A("bank", "Bank — current account", "asset", "bank"), A("sav", "Savings account", "asset", "bank"),
  A("owed", "Money owed to me", "asset", "receivable"), A("card", "Credit card", "liability", "card"), A("loan", "Loans & EMIs", "liability", "loan"),
  A("open", "Opening balances", "equity"), A("salary", "Salary", "income"), A("oinc", "Other income", "income"),
  A("groc", "Groceries & household", "expense"), A("trans", "Transport & fuel", "expense"), A("int", "Interest on loans & cards", "expense"), A("other", "Other expenses", "expense")];
const accById = id => accounts.find(a => a.id === id);
let n = 0;
const J = (id, date, lines) => ({ j: { id, entry_date: date, status: "posted", number: ++n }, lines: lines.map(([acc, dr, cr, party], i) => ({ id: id + i, journal_id: id, account_id: acc, party_id: party || null, debit: dr, credit: cr, sort: i })) });
const BIZ = "p-dlusso";
const book = [
  J("o", "2026-10-31", [["bank", 10000, 0], ["card", 0, 500], ["loan", 0, 20000], ["open", 10500, 0]]),
  J("s", "2026-11-01", [["bank", 15000, 0], ["salary", 0, 15000]]),
  J("g", "2026-11-02", [["groc", 320.5, 0], ["bank", 0, 320.5]]),
  J("cg", "2026-11-02", [["trans", 80, 0], ["card", 0, 80]]),                       // card spend: spending, not cash
  J("t", "2026-11-02", [["sav", 2000, 0], ["bank", 0, 2000]]),                      // own transfer
  J("cp", "2026-11-03", [["card", 580, 0], ["bank", 0, 580]]),                      // card bill
  J("e", "2026-11-03", [["loan", 1300, 0], ["int", 200, 0], ["bank", 0, 1500]]),    // EMI with interest
  J("d1", "2026-11-04", [["owed", 500, 0, BIZ], ["bank", 0, 500]]),                 // paid for Dlusso
  J("d2", "2026-11-05", [["owed", 300, 0, BIZ], ["card", 0, 300]]),                 // paid for Dlusso by card
  J("d3", "2026-11-06", [["bank", 200, 0], ["owed", 0, 200, BIZ]]),                 // Dlusso paid back
  J("x", "2026-12-01", [["groc", 50, 0], ["bank", 0, 50]])                          // next month
];
const journals = book.map(b => b.j), lines = book.flatMap(b => b.lines);
const posted = postedLines(lines, journals);
const biz = new Map([[BIZ, { entity_id: "dl", name: "Dlusso Bespoke" }]]);

test("classifyJournal attributes cash flows to the counterpart and adds up to the cash change", () => {
  const jl = id => posted.filter(l => l.journal_id === id);
  const e = classifyJournal(jl("e"), accById, biz);
  assert.equal(e.cashOut, 1500);
  assert.deepEqual(e.flows.map(f => [f.cat, f.amount]), [["debt_payment", -1300], ["spend", -200]]);
  const t = classifyJournal(jl("t"), accById, biz);
  assert.equal(t.cashNet, 0); assert.equal(t.flows[0].cat, "own_transfer");
  const d2 = classifyJournal(jl("d2"), accById, biz);
  assert.equal(d2.cashNet, 0); assert.equal(d2.bizOut, 300, "card-paid business cost is still personal money used for the business");
  assert.equal(classifyJournal(jl("d3"), accById, biz).flows[0].cat, "biz_in");
});

test("monthSummary: income, spending, business money, repayments and net cash for November", () => {
  const s = monthSummary(posted, accById, biz, "2026-11-01", "2026-11-30");
  assert.equal(s.salary, 15000);
  assert.equal(s.spending, 320.5 + 80 + 200, "spending includes card purchases and loan interest");
  assert.equal(s.interest, 200);
  assert.equal(s.bizPaid, 800); assert.equal(s.bizRepaid, 200);
  assert.equal(s.byBusiness.get("dl").paid, 800);
  assert.equal(s.repayments, 580 + 1300, "card bill and loan principal");
  assert.equal(s.savings, 0, "a transfer to a savings bank account is between my accounts");
  assert.equal(s.saved, 15000 - 600.5);
  assert.equal(s.netCash, 15000 - 320.5 - 580 - 1500 - 500 + 200, "transfers between own cash/bank accounts net to zero");
  assert.equal(s.flowsOut.get("biz_out"), 500, "only the bank-paid part is cash out");
  assert.equal(s.flowsIn.get("biz_in"), 200);
  assert.ok(!s.flowsOut.has("own_transfer"));
});

test("groupedBalances and receivableItems: FIFO repayments per item", () => {
  const g = groupedBalances(posted, accById, a => a.subtype === "receivable", 1);
  assert.equal(g.length, 1); assert.equal(g[0].balance, 600); assert.equal(g[0].party_id, BIZ);
  const r = receivableItems(g[0].lines);
  assert.deepEqual(r.items.map(i => [i.original, i.received, i.outstanding, i.status]), [[500, 200, 300, "part"], [300, 0, 300, "open"]]);
  assert.equal(r.total, 600);
  const liab = groupedBalances(posted, accById, a => a.type === "liability", -1);
  assert.equal(liab.find(x => x.account.id === "loan").balance, 18700);
  assert.equal(liab.find(x => x.account.id === "card").balance, 300);
});

test("parseBankMessage reads common Qatar bank SMS formats", () => {
  const a = parseBankMessage("Your account XXXX1234 has been debited with QAR 150.00 at LULU HYPERMARKET on 01/11/2026. Avl Bal QAR 9,850.00", "2026-11-02");
  assert.deepEqual([a.direction, a.amount, a.currency, a.merchant, a.txn_date, a.card_last4, a.balance], ["out", 150, "QAR", "LULU HYPERMARKET", "2026-11-01", "1234", 9850]);
  const b = parseBankMessage("QAR 15,000.00 credited to your A/C ...5678 on 01-Nov-26 - SALARY", "2026-11-02");
  assert.deepEqual([b.direction, b.amount, b.txn_date, b.merchant], ["in", 15000, "2026-11-01", "Salary"]);
  const c = parseBankMessage("Dear Customer, your Credit Card ending 4417 was used for QR 45.25 at WOQOD AL WAKRA on 02/11/26", "2026-11-02");
  assert.deepEqual([c.direction, c.amount, c.currency, c.merchant, c.card_last4], ["out", 45.25, "QAR", "WOQOD AL WAKRA", "4417"]);
  const d = parseBankMessage("Purchase of 120.50 QAR at TALABAT using card ***4417", "2026-11-02");
  assert.deepEqual([d.direction, d.amount, d.merchant, d.date_found, d.txn_date], ["out", 120.5, "TALABAT", false, "2026-11-02"]);
  assert.equal(parseBankMessage("Your OTP for QAR 50.00 transaction is 123456", "2026-11-02"), null);
  const t = parseBankText("Debited QAR 10 at A on 01/11/2026\n\nDebited QAR 20 at B on 02/11/2026\nRandom line without money", "2026-11-03");
  assert.equal(t.length, 2); assert.equal(splitMessages("").length, 0);
});

test("suggest: history first, then business names, then rules; unknowns flagged for review", () => {
  const ctx = { accounts, history: [{ merchant: "Topaz Fabrics", kind: "paid_for_business", for_entity_id: "dl", business_account_id: "dl-inv" }],
    businesses: [{ entity_id: "dl", name: "Dlusso Bespoke", keywords: ["dlusso"] }], bizAccounts: { dl: [{ id: "dl-inv", name: "Inventory", type: "asset", subtype: "inventory" }, { id: "dl-bank", name: "Bank account", type: "asset", subtype: "bank" }, { id: "dl-oth", name: "Other expenses", type: "expense", subtype: "other" }] } };
  assert.equal(suggest({ merchant: "Topaz Fabrics", description: "TOPAZ FABRICS", direction: "out" }, ctx).kind, "paid_for_business");
  const dl = suggest({ description: "Transfer from DLUSSO BESPOKE", direction: "in" }, ctx);
  assert.deepEqual([dl.kind, dl.for_entity_id, dl.business_account_id], ["business_repaid", "dl", "dl-bank"]);
  const sal = suggest({ description: "SALARY NOV", direction: "in" }, ctx);
  assert.deepEqual([sal.kind, sal.category_account_id, sal.confidence], ["income", "salary", "high"]);
  assert.equal(suggest({ merchant: "LULU HYPERMARKET", direction: "out" }, ctx).category_account_id, "groc");
  assert.equal(suggest({ description: "ATM CASH WITHDRAWAL", direction: "out" }, ctx).category_account_id, "cash");
  const unk = suggest({ description: "XYZ TRADING", direction: "out" }, ctx);
  assert.equal(unk.category_account_id, "other"); assert.ok(unk.review_reason);
  assert.equal(businessAccountFor("DHL express", [{ id: "t", name: "Transport & delivery", type: "expense", subtype: "other" }, { id: "b", name: "Bank account", type: "asset", subtype: "bank" }]), "t");
  assert.equal(businessAccountFor("fabric", [{ id: "b", name: "Bank account", type: "asset", subtype: "bank" }]), null, "never suggests a business bank account for personal money");
});

test("rowProblem names what is missing in plain words", () => {
  const base = { kind: "spend", amount: 10, txn_date: "2026-11-01", account_id: "bank", category_account_id: "groc" };
  assert.equal(rowProblem(base), null);
  assert.equal(rowProblem({ ...base, account_id: null }), "Choose the bank, cash or card account");
  assert.equal(rowProblem({ ...base, kind: "lent", category_account_id: "owed" }), "Who owes you");
  assert.equal(rowProblem({ ...base, kind: "paid_for_business", for_entity_id: "dl" }), "What it was for (in the business's books)");
  assert.equal(rowProblem({ ...base, kind: "transfer", category_account_id: "bank" }), "Choose two different accounts");
});

test("businessParties finds linked businesses from partner links and related parties", () => {
  const m = businessParties("pers", { plinks: [{ entity_id: "dl", mirror_entity_id: "pers", mirror_party_id: "p1" }], parties: [{ id: "p2", entity_id: "pers", related_entity_id: "fh", name: "Fitness Hub" }], entities: [{ id: "dl", name: "Dlusso Bespoke" }, { id: "fh", name: "Fitness Hub" }] });
  assert.equal(m.get("p1").name, "Dlusso Bespoke"); assert.equal(m.get("p2").entity_id, "fh");
});

import { toBase, fromBase, nativeBalance, journalFx, budgetActual } from "../../public/js/money.js";
test("currency helpers: planning-rate conversion, native balances, budget actuals", () => {
  const rates = { base: "QAR", INR: 26.10, BHD: 0.1035 };
  assert.equal(toBase(2610, "INR", rates, "QAR"), 100);
  assert.equal(toBase(10, "BHD", rates, "QAR"), 96.62);
  assert.equal(toBase(10, "USD", rates, "QAR"), null, "no planning rate → no guess");
  assert.equal(fromBase(100, "INR", rates, "QAR"), 2610);
  const inr = { id: "inr", currency: "INR" };
  const ls = [{ account_id: "inr", fx_currency: "INR", fx_amount: 52000, debit: 1992.34, credit: 0, entry_date: "2026-11-01" }, { account_id: "inr", fx_currency: "INR", fx_amount: -5000, debit: 0, credit: 191.57, entry_date: "2026-11-02" }];
  assert.equal(nativeBalance(ls, inr), 47000);
  assert.equal(nativeBalance(ls, { id: "x" }), null);
  assert.deepEqual(journalFx([], { currency: "INR", native_amount: 5000, rate_source: "planning" }, "QAR"), { ccy: "INR", amount: 5000, planning: true });
  const ex = [{ account_id: "fam", debit: 191.57, credit: 0, fx_currency: "INR", fx_amount: 5000, entry_date: "2026-11-02" }, { account_id: "fam", debit: 100, credit: 0, entry_date: "2026-11-03" }];
  const b = budgetActual(ex, "fam", "INR", rates, "QAR", "2026-11-01", "2026-11-30");
  assert.deepEqual(b, { base: 291.57, native: 7610, estimated: true });
  assert.deepEqual(budgetActual(ex, "fam", "QAR", rates, "QAR", "2026-11-01", "2026-11-30"), { base: 291.57, native: 291.57, estimated: false });
});
