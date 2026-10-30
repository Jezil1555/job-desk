import { test } from "node:test";
import assert from "node:assert/strict";
import { summary, allocate, ageing, byAccount, byMonth, statement, exceptions, reportStatement, reportCoa, reportAgeing, reportAudit, reportPayables, docLabel } from "../../public/js/partners.js";
import { buildXlsx, crc32, safeSheetName } from "../../public/js/xlsx.js";

// Fixture with the same shape as the Dlusso import (test data only, never read from the live database)
let n = 0;
const T = (date, type, amount, acc, extra = {}) => ({ id: "t" + (++n), txn_no: "PR-" + String(n).padStart(4, "0"), txn_type: type, direction: type === "reimbursement" ? "decrease" : "increase",
  txn_date: date, date_precision: date === "2026-09-30" ? "month" : "day", amount, account_id: acc, status: "posted", recon_status: "unverified", flags: [], mirror_journal_id: "m" + n, description: "line " + n, ...extra });
const hist = (amt, acc, extra = {}) => T("2026-09-30", "expense_funding", amt, acc, { import_key: "hist-" + n, ...extra });
const txns = [
  hist(5186, "6100", { txn_type: "salary_funding", flags: ["legacy_7066", "payroll_source_check", "best_guess_account"], legacy_ref: "Historical partner payable QAR 7,066" }),
  ...[[775, "5000"], [50, "6100"], [75, "6400"], [39.5, "1200"], [420, "6410"], [31.5, "5000"], [398, "1200"], [91, "1200"]].map(([a, c]) => hist(a, c, { flags: ["legacy_7066"], legacy_ref: "Historical partner payable QAR 7,066" })),
  hist(53, "6900", { flags: ["best_guess_account"] }), hist(1436, "5000"), hist(500, "6900", { flags: ["best_guess_account"] }),
  T("2026-10-07", "expense_funding", 68, "6900", { import_key: "hist-13", reference: "39896", beneficiary: "Blossom Trading", invoice_amount: 68, flags: ["best_guess_account"] }),
  T("2026-10-07", "expense_funding", 0.5, "6500", { import_key: "hist-14" }),
  T("2026-10-25", "salary_funding", 8500, "6100", { import_key: "add-15" }),
];
txns.push(T("2026-10-29", "reimbursement", 8000, "1010", { import_key: "add-16", settles_txn_id: txns[14].id }));
const acc = id => ({ id, code: id, name: "Account " + id });

test("dashboard totals reconcile to 9,623.50", () => {
  const s = summary(txns, [], { asOf: "2026-10-30" });
  assert.equal(s.historical, 9123.5);
  assert.equal(s.additional, 8500);
  assert.equal(s.reimbursed, 8000);
  assert.equal(s.outstanding, 9623.5);
  assert.equal(s.historical + s.additional - s.reimbursed, s.outstanding);
  assert.equal(s.missingDocs, 16);
  assert.equal(s.unverified, 16);
  assert.equal(s.overdue, null, "no terms agreed → nothing overdue");
});
test("historical 7,066 lines are exactly the first nine", () => {
  const legacy = txns.filter(t => t.flags.includes("legacy_7066"));
  assert.equal(legacy.length, 9);
  assert.equal(Math.round(legacy.reduce((s, t) => s + t.amount, 0) * 100) / 100, 7066);
});
test("the 8,000 reimbursement settles the September salary line, not the oldest", () => {
  const { funding, unapplied } = allocate(txns);
  const sal = funding.find(f => f.t.amount === 8500), first = funding[0];
  assert.equal(sal.open, 500);
  assert.equal(first.open, 5186);
  assert.equal(unapplied, 0);
  assert.deepEqual(sal.settledBy.map(s => s.amount), [8000]);
});
test("without a settles link reimbursements apply oldest-first", () => {
  const plain = txns.map(t => ({ ...t, settles_txn_id: null }));
  const { funding } = allocate(plain);
  assert.equal(funding[0].open, 0);
  assert.equal(funding[1].open, 0); // 5186 + 775 + 50 + 75 + 39.5 + 420 + 31.5 + 398 + 91 = 7066, remaining 934 into line 10+
  assert.equal(Math.round(funding.reduce((s, f) => s + f.open, 0) * 100) / 100, 9623.5);
});
test("ageing buckets total the outstanding and mark month-only dates as approximate", () => {
  const a = ageing(txns, "2026-10-30");
  assert.equal(a.total, 9623.5);
  assert.equal(a.totals[0], 9623.5); // all within 30 days of 30 Oct
  assert.ok(a.rows.filter(r => r.t.date_precision === "month").every(r => r.approx));
  assert.ok(a.rows.every(r => !r.overdue));
  const later = ageing(txns, "2027-01-15", 30);
  assert.ok(later.rows.every(r => r.overdue));
});
test("reversed lines don't count", () => {
  const withRev = [...txns, T("2026-10-28", "expense_funding", 999, "6900", { status: "reversed" })];
  assert.equal(summary(withRev).outstanding, 9623.5);
  assert.equal(summary(withRev).reversed, 1);
});
test("COA and month summaries", () => {
  const rows = byAccount(txns, acc);
  assert.equal(rows.find(r => r.account.id === "6100").funded, 13736);
  assert.equal(rows.find(r => r.account.id === "1010").repaid, 8000);
  assert.equal(rows.find(r => r.account.id === "1200").funded, 528.5);
  const m = byMonth(txns);
  assert.deepEqual(m.map(r => [r.month, r.funded, r.repaid, r.closing]), [["2026-09", 9055, 0, 9055], ["2026-10", 8568.5, 8000, 9623.5]]);
});
test("monthly statement carries the opening balance", () => {
  const s = statement(txns, "2026-10-01", "2026-10-31");
  assert.equal(s.opening, 9055);
  assert.equal(s.funded, 8568.5);
  assert.equal(s.repaid, 8000);
  assert.equal(s.closing, 9623.5);
  assert.equal(s.lines.at(-1).balance, 9623.5);
});
test("exceptions: flags, missing evidence, books agree", () => {
  const ex = exceptions(txns, [], { hasMirror: true, bizBalance: 9623.5, mirrorBalance: 9623.5, bankNegative: [{ account: "1010 Bank account", balance: -8000 }] });
  const codes = ex.map(e => e.code);
  assert.ok(codes.includes("payroll_source_check"));
  assert.ok(codes.includes("best_guess_account"));
  assert.ok(codes.includes("legacy_overlap"));
  assert.ok(codes.includes("missing_proof"));
  assert.ok(codes.includes("month_only_date"));
  assert.ok(codes.includes("bank_negative"));
  assert.ok(!codes.includes("books_differ"));
  assert.ok(!codes.includes("reimb_exceeds"));
  assert.ok(!codes.includes("amount_mismatch"));
  assert.equal(ex.find(e => e.code === "legacy_overlap").detail.includes("7066.00"), true);
  assert.equal(ex.find(e => e.code === "best_guess_account").refs.length, 4);
  assert.equal(ex[0].severity, "high");
});
test("exceptions: duplicates, mismatches, over-reimbursement, books differ", () => {
  const bad = [T("2026-10-01", "expense_funding", 100, "6900", { reference: "INV-9", invoice_amount: 120 }), T("2026-10-02", "expense_funding", 100, "6900", { reference: "inv-9" }),
    T("2026-10-03", "expense_funding", 50, "6900", { beneficiary: "X" }), T("2026-10-03", "expense_funding", 50, "6900", { beneficiary: "x" }),
    T("2026-10-04", "reimbursement", 400, "1010")];
  const codes = exceptions(bad, [], { hasMirror: true, bizBalance: -100, mirrorBalance: 0 }).map(e => e.code);
  for (const c of ["dup_amount_ref", "dup_amount_date", "amount_mismatch", "reimb_exceeds", "books_differ"]) assert.ok(codes.includes(c), c);
  const proofDoc = [{ txn_id: bad[0].id, kind: "bank_transfer" }];
  assert.equal(exceptions(bad, proofDoc).find(e => e.code === "missing_proof").txns.includes(bad[0].id), false);
});
test("missing documents read 'Document Pending' (no invented links)", () => {
  assert.equal(docLabel([], "t1"), "Document Pending");
  assert.equal(docLabel([{ txn_id: "t1" }], "t1"), null);
});
test("report tables total correctly", () => {
  const st = reportStatement(txns, "2026-09-01", "2026-10-31", { partner: "Jezz", business: "Dlusso", currency: "QAR" });
  assert.equal(st.rows.at(-1)[7], 9623.5);
  assert.equal(reportCoa(txns, acc, { partner: "Jezz", currency: "QAR" }).rows.at(-1)[3], 17623.5);
  assert.equal(reportAgeing(txns, "2026-10-30", null, { partner: "Jezz", currency: "QAR" }).rows.at(-1)[6], 9623.5);
  assert.equal(reportPayables(txns, acc, { partner: "Jezz", business: "Dlusso", currency: "QAR", asOf: "2026-10-30" }).rows.at(-1)[4], 9623.5);
  const au = reportAudit(txns, [], [{ record_type: "fin_partner_txns", action: "update", record_id: txns[15].id, actor_id: "u", created_at: "2026-10-30T10:00:00Z",
    changes: { settles_txn_id: [null, txns[14].id], last_change_reason: [null, "Import: reimbursement is for the September salary funding"] } }], {});
  assert.equal(au.rows.length, 16);
  assert.ok(au.rows.every(r => r[8] === "Document Pending"));
  assert.equal(au.changes.rows[0][4], "Import: reimbursement is for the September salary funding");
});
test("xlsx: valid zip with sheets, CRC and safe names", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  const used = new Set();
  assert.equal(safeSheetName("Statement: Jezz/Oct", used), "Statement  Jezz Oct");
  assert.equal(safeSheetName("Statement: Jezz/Oct", used), "Statement  Jezz Oct 2");
  const z = buildXlsx([{ name: "A", columns: [{ label: "x" }, { label: "y", money: true }], rows: [["a & <b>", 1.5], [{ v: "Total", bold: true }, 1.5]] }]);
  assert.deepEqual([...z.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const text = new TextDecoder().decode(z);
  assert.ok(text.includes("xl/worksheets/sheet1.xml") && text.includes("a &amp; &lt;b&gt;") && text.includes("<v>1.5</v>"));
});
