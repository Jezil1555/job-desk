// Partner accounts: pure calculations over partner transactions (no DOM, no network) so they can be unit-tested.
// "increase" = the business owes the partner more (partner paid on its behalf); "decrease" = the business paid the partner back.
// Only posted transactions count; reversed ones stay on record for the audit trail.

export const TXN_TYPE_LABEL = { expense_funding: "Expense funding", salary_funding: "Salary funding", reimbursement: "Reimbursement", adjustment: "Adjustment" };
export const PAID_FROM_LABEL = { personal_bank: "Personal bank", personal_cash: "Personal cash", personal_card: "Personal card", other: "Other", not_recorded: "Not recorded", business_bank: "Business bank", business_cash: "Business cash" };
export const RECON_LABEL = { unverified: "Unverified", verified: "Verified", disputed: "Disputed" };
export const DOC_KIND_LABEL = { supplier_invoice: "Supplier invoice", cash_receipt: "Cash receipt", bank_transfer: "Bank transfer proof", card_payment: "Card payment proof", salary_record: "Salary payment record", payment_proof: "Payment proof", other: "Other" };
export const FLAG_LABEL = { legacy_7066: "Part of historical QAR 7,066", payroll_source_check: "Verify payroll source & liability", best_guess_account: "Account is a best guess", month_only_date: "Month only — exact date unknown" };
export const PROOF_KINDS = new Set(["cash_receipt", "bank_transfer", "card_payment", "salary_record", "payment_proof"]);
export const DOC_MIME = { "application/pdf": "PDF", "image/jpeg": "JPG", "image/png": "PNG", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel", "application/vnd.ms-excel": "Excel", "text/csv": "CSV" };

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
export const posted = ts => ts.filter(t => t.status === "posted");
export const signed = t => (t.direction === "decrease" ? -1 : 1) * Number(t.amount);
const byDate = (a, b) => (a.txn_date < b.txn_date ? -1 : a.txn_date > b.txn_date ? 1 : a.txn_no < b.txn_no ? -1 : a.txn_no > b.txn_no ? 1 : 0);
export const isHistorical = t => (t.import_key || "").startsWith("hist-");
export const monthKey = d => String(d).slice(0, 7);
export const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
export const docsOf = (docs, txnId) => docs.filter(d => d.txn_id === txnId);
export const docLabel = (docs, txnId) => (docsOf(docs, txnId).length ? null : "Document Pending");
export const dateLabel = (t, fmt = d => d) => t.date_precision === "month" ? `${new Date(t.txn_date + "T00:00:00Z").toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" })} (exact date unavailable)` : fmt(t.txn_date);

/** Dashboard figures. termsDays null = no reimbursement terms agreed, so nothing is "overdue". */
export function summary(txns, docs = [], { asOf, termsDays = null } = {}) {
  const p = posted(txns), inc = p.filter(t => t.direction === "increase");
  const historical = r2(inc.filter(isHistorical).reduce((s, t) => s + Number(t.amount), 0));
  const additional = r2(inc.filter(t => !isHistorical(t)).reduce((s, t) => s + Number(t.amount), 0));
  const reimbursed = r2(p.filter(t => t.txn_type === "reimbursement").reduce((s, t) => s + Number(t.amount), 0));
  const adjustments = r2(p.filter(t => t.txn_type === "adjustment").reduce((s, t) => s + signed(t), 0));
  const outstanding = r2(p.reduce((s, t) => s + signed(t), 0));
  const unverified = p.filter(t => t.recon_status !== "verified").length;
  const missingDocs = p.filter(t => !docsOf(docs, t.id).length).length;
  const ag = asOf ? ageing(txns, asOf, termsDays) : null;
  return { historical, additional, reimbursed, adjustments, outstanding, unverified, missingDocs, count: p.length, reversed: txns.length - p.length,
    overdue: termsDays === null || termsDays === undefined ? null : ag ? r2(ag.rows.filter(r => r.overdue).reduce((s, r) => s + r.open, 0)) : null };
}

/** Apply each reimbursement / decreasing adjustment to the funding line it names, then oldest-first. */
export function allocate(txns) {
  const p = posted(txns).slice().sort(byDate);
  const funding = p.filter(t => t.direction === "increase").map(t => ({ t, open: Number(t.amount), settledBy: [] }));
  const byId = new Map(funding.map(f => [f.t.id, f]));
  let unapplied = 0;
  for (const d of p.filter(t => t.direction === "decrease")) {
    let left = Number(d.amount);
    const take = (f) => { const x = Math.min(f.open, left); if (x <= 0) return; f.open = r2(f.open - x); left = r2(left - x); f.settledBy.push({ txn_no: d.txn_no, id: d.id, amount: r2(x) }); };
    if (d.settles_txn_id && byId.has(d.settles_txn_id)) take(byId.get(d.settles_txn_id));
    for (const f of funding) { if (left <= 0) break; take(f); }
    unapplied = r2(unapplied + left);
  }
  return { funding, unapplied };
}

export const AGE_BUCKETS = ["0–30 days", "31–60 days", "61–90 days", "Over 90 days"];
export function ageing(txns, asOf, termsDays = null) {
  const { funding } = allocate(txns);
  const rows = funding.filter(f => f.open > 0).map(f => {
    const days = Math.max(0, daysBetween(f.t.txn_date, asOf));
    const bucket = days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3;
    return { t: f.t, open: f.open, days, bucket, approx: f.t.date_precision === "month", overdue: termsDays !== null && termsDays !== undefined && days > termsDays, settledBy: f.settledBy };
  });
  const totals = AGE_BUCKETS.map((_, i) => r2(rows.filter(r => r.bucket === i).reduce((s, r) => s + r.open, 0)));
  return { rows, totals, total: r2(totals.reduce((s, x) => s + x, 0)) };
}

/** Funding and reimbursements grouped by the business-side account. */
export function byAccount(txns, accById) {
  const m = new Map();
  for (const t of posted(txns)) {
    const a = accById(t.account_id) || { id: t.account_id, code: "?", name: "Unknown account" };
    const row = m.get(a.id) || { account: a, funded: 0, repaid: 0, count: 0 };
    if (t.direction === "increase") row.funded = r2(row.funded + Number(t.amount)); else row.repaid = r2(row.repaid + Number(t.amount));
    row.count++; m.set(a.id, row);
  }
  return [...m.values()].sort((x, y) => String(x.account.code).localeCompare(String(y.account.code)));
}

export function byMonth(txns) {
  const m = new Map();
  for (const t of posted(txns).slice().sort(byDate)) {
    const k = monthKey(t.txn_date), row = m.get(k) || { month: k, funded: 0, repaid: 0 };
    if (t.direction === "increase") row.funded = r2(row.funded + Number(t.amount)); else row.repaid = r2(row.repaid + Number(t.amount));
    m.set(k, row);
  }
  let bal = 0;
  return [...m.values()].sort((a, b) => a.month.localeCompare(b.month)).map(r => { bal = r2(bal + r.funded - r.repaid); return { ...r, net: r2(r.funded - r.repaid), closing: bal }; });
}

/** Partner statement for a date range: opening balance, each line with running balance, closing balance. */
export function statement(txns, from, to) {
  const p = posted(txns).slice().sort(byDate);
  const opening = r2(p.filter(t => t.txn_date < from).reduce((s, t) => s + signed(t), 0));
  let bal = opening;
  const lines = p.filter(t => t.txn_date >= from && t.txn_date <= to).map(t => { bal = r2(bal + signed(t)); return { t, inc: t.direction === "increase" ? Number(t.amount) : 0, dec: t.direction === "decrease" ? Number(t.amount) : 0, balance: bal }; });
  return { opening, lines, funded: r2(lines.reduce((s, l) => s + l.inc, 0)), repaid: r2(lines.reduce((s, l) => s + l.dec, 0)), closing: bal };
}

/**
 * Exception checks. Nothing here changes data; each item explains what to look at.
 * ctx: { bizBalance, mirrorBalance, hasMirror, otherLines: [{journal, amount}], bankNegative: [{account, balance}] }
 */
export function exceptions(txns, docs = [], ctx = {}) {
  const out = [], p = posted(txns), money = n => r2(n).toFixed(2);
  const add = (code, severity, title, detail, ts = []) => out.push({ code, severity, title, detail, txns: ts.map(t => t.id), refs: ts.map(t => t.txn_no) });
  // duplicates
  const byRef = new Map();
  for (const t of p) if (t.reference) { const k = t.reference.trim().toLowerCase(); byRef.set(k, [...(byRef.get(k) || []), t]); }
  for (const [ref, ts] of byRef) if (ts.length > 1) {
    const sameAmt = ts.filter(t => ts.some(u => u !== t && Number(u.amount) === Number(t.amount)));
    if (sameAmt.length > 1) add("dup_amount_ref", "high", `Same amount and reference ${ref.toUpperCase()}`, `${sameAmt.length} lines share reference ${ref.toUpperCase()} and amount ${money(sameAmt[0].amount)}. This may be counted twice.`, sameAmt);
    else add("dup_invoice", "medium", `Invoice number ${ref.toUpperCase()} used more than once`, `${ts.length} lines use the same invoice/reference number. Check they are different invoices.`, ts);
  }
  const seen = new Map();
  for (const t of p) if (!t.reference) { const k = [t.txn_date, Number(t.amount), (t.beneficiary || t.description || "").trim().toLowerCase(), t.direction].join("|"); seen.set(k, [...(seen.get(k) || []), t]); }
  for (const ts of seen.values()) if (ts.length > 1) add("dup_amount_date", "medium", "Possible duplicate", `${ts.length} lines have the same date, amount and payee with no reference.`, ts);
  // evidence & amounts
  const noProof = p.filter(t => t.direction === "increase" && !docsOf(docs, t.id).some(d => PROOF_KINDS.has(d.kind)));
  if (noProof.length) add("missing_proof", "medium", "Payment evidence missing", `${noProof.length} funding line${noProof.length > 1 ? "s have" : " has"} no bank transfer, card, cash receipt or salary payment record attached.`, noProof);
  const noDoc = p.filter(t => !docsOf(docs, t.id).length);
  if (noDoc.length) add("document_pending", "info", "Document Pending", `${noDoc.length} line${noDoc.length > 1 ? "s have" : " has"} no supporting document at all.`, noDoc);
  const mism = p.filter(t => t.invoice_amount !== null && t.invoice_amount !== undefined && t.invoice_amount !== "" && r2(t.invoice_amount) !== r2(t.amount));
  if (mism.length) add("amount_mismatch", "medium", "Paid amount differs from invoice", mism.map(t => `${t.txn_no}: paid ${money(t.amount)} vs invoice ${money(t.invoice_amount)}`).join("; "), mism);
  // reimbursements beyond what was owed at the time
  let bal = 0; const over = [];
  for (const t of p.slice().sort(byDate)) { bal = r2(bal + signed(t)); if (bal < 0) over.push(t); }
  if (over.length) add("reimb_exceeds", "high", "Reimbursed more than was owed", `The running balance goes below zero at ${over.map(t => t.txn_no).join(", ")}.`, over);
  // both books
  if (ctx.hasMirror && ctx.bizBalance !== undefined && ctx.mirrorBalance !== undefined && r2(ctx.bizBalance) !== r2(ctx.mirrorBalance))
    add("books_differ", "high", "Business payable and personal receivable differ", `Business books: ${money(ctx.bizBalance)} owed to the partner. Personal books: ${money(ctx.mirrorBalance)} receivable. Difference ${money(ctx.bizBalance - ctx.mirrorBalance)}.`);
  const unmirrored = ctx.hasMirror ? p.filter(t => !t.mirror_journal_id) : [];
  if (unmirrored.length) add("mirror_pending", "medium", "Not yet in the partner's personal books", `${unmirrored.length} line${unmirrored.length > 1 ? "s were" : " was"} recorded by a bookkeeper; the partner needs to post them to their personal books.`, unmirrored);
  if (ctx.otherLines && ctx.otherLines.length) add("other_entries", "high", "Other entries on the partner account", `${ctx.otherLines.length} entr${ctx.otherLines.length > 1 ? "ies" : "y"} outside this module also post to the partner account for this partner (${ctx.otherLines.map(x => "#" + x.number).join(", ")}). Check they don't double-count these transactions.`);
  // flags carried from the records
  const flagged = f => p.filter(t => (t.flags || []).includes(f));
  const legacyGroups = new Map();
  for (const t of p) if (t.legacy_ref) legacyGroups.set(t.legacy_ref, [...(legacyGroups.get(t.legacy_ref) || []), t]);
  for (const [ref, ts] of legacyGroups) add("legacy_overlap", "info", ref, `${ts.length} lines totalling ${money(ts.reduce((s, t) => s + Number(t.amount), 0))} make up this historical balance. Don't post that balance again as a separate payable, or it will be counted twice.`, ts);
  const pay = flagged("payroll_source_check");
  if (pay.length) add("payroll_source_check", "high", "Payroll funding needs source and liability verification", `${pay.map(t => `${t.txn_no} (${money(t.amount)})`).join(", ")}: confirm where the money came from and which payroll liability it settled. Correct by reversal if needed.`, pay);
  const guess = flagged("best_guess_account");
  if (guess.length) add("best_guess_account", "medium", "Account chosen as a best guess", `${guess.map(t => t.txn_no).join(", ")}: confirm the right account. To change it, reverse and record again.`, guess);
  const mo = p.filter(t => t.date_precision === "month");
  if (mo.length) add("month_only_date", "info", "Exact dates unavailable", `${mo.length} line${mo.length > 1 ? "s are" : " is"} dated to the month only (shown as the month end). Add the payment date when it's known.`, mo);
  for (const b of ctx.bankNegative || []) add("bank_negative", "medium", `${b.account} shows a negative balance`, `Balance ${money(b.balance)}. Usually the opening bank balance hasn't been entered yet.`);
  const order = { high: 0, medium: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

/* ---------------- report tables (used for screen, Excel and print) ---------------- */
const col = (label, money = false) => ({ label, money });
export function reportStatement(txns, from, to, { partner, business, currency }) {
  const s = statement(txns, from, to), rows = [["", "Opening balance", "", "", "", null, null, s.opening]];
  for (const l of s.lines) rows.push([l.t.txn_no, l.t.description, l.t.txn_date + (l.t.date_precision === "month" ? " (month only)" : ""), l.t.beneficiary || "", l.t.reference || "", l.inc || null, l.dec || null, l.balance]);
  rows.push(["", "Totals / closing balance", "", "", "", s.funded, s.repaid, s.closing]);
  return { title: `Partner statement — ${partner}`, subtitle: `${business} owes ${partner} · ${from} to ${to} · ${currency}`, columns: [col("Txn"), col("Description"), col("Date"), col("Supplier / payee"), col("Reference"), col("Paid by partner", true), col("Reimbursed", true), col("Balance owed", true)], rows, bold: new Set([0, rows.length - 1]), summary: s };
}
export function reportPayables(txns, accById, { partner, business, currency, asOf }) {
  const rows = byAccount(txns, accById).map(r => [`${r.account.code} ${r.account.name}`, r.count, r.funded || null, r.repaid || null, r2(r.funded - r.repaid)]);
  const tot = summary(txns).outstanding;
  rows.push(["Due to " + partner + " (partner current account)", null, null, null, tot]);
  return { title: `${business} — partner payables`, subtitle: `Amount ${business} owes ${partner} as at ${asOf} · ${currency}`, columns: [col("Account"), col("Lines"), col("Funded by partner", true), col("Repaid to partner", true), col("Net", true)], rows, bold: new Set([rows.length - 1]) };
}
export function reportCoa(txns, accById, { partner, currency }) {
  const rows = byAccount(txns, accById).filter(r => r.funded).map(r => [r.account.code, r.account.name, r.count, r.funded]);
  rows.push(["", "Total funded by " + partner, null, r2(rows.reduce((s, r) => s + r[3], 0))]);
  return { title: "Receivable by account (COA)", subtitle: `What ${partner}'s money paid for · ${currency}`, columns: [col("Code"), col("Account"), col("Lines"), col("Funded", true)], rows, bold: new Set([rows.length - 1]) };
}
export function reportAgeing(txns, asOf, termsDays, { partner, currency }) {
  const a = ageing(txns, asOf, termsDays);
  const rows = a.rows.map(r => [r.t.txn_no, r.t.description, r.t.txn_date + (r.approx ? " (month only)" : ""), r.days, AGE_BUCKETS[r.bucket], r.settledBy.map(s => `${s.txn_no} ${s.amount.toFixed(2)}`).join(", "), r.open, termsDays === null ? "No terms agreed" : r.overdue ? "Overdue" : "Within terms"]);
  rows.push(["", "Total outstanding", "", null, "", "", a.total, ""]);
  return { title: "Outstanding receivable ageing", subtitle: `${partner} · as at ${asOf} · ${currency}${termsDays === null ? " · no reimbursement terms agreed, so nothing is marked overdue" : ` · terms ${termsDays} days`}`,
    columns: [col("Txn"), col("Description"), col("Date"), col("Age (days)"), col("Bucket"), col("Settled by"), col("Open", true), col("Status")], rows, bold: new Set([rows.length - 1]), ageing: a };
}
export function reportAudit(txns, docs, audit, { nameOf = id => id || "", accName = id => id }) {
  const rows = [];
  for (const t of txns.slice().sort(byDate)) {
    const ds = docsOf(docs, t.id);
    rows.push([t.txn_no, t.txn_date, TXN_TYPE_LABEL[t.txn_type], t.description, signed(t), accName(t.account_id), t.status === "reversed" ? `Reversed: ${t.reversal_reason || ""}` : "Posted", RECON_LABEL[t.recon_status],
      ds.length ? ds.map(d => `${DOC_KIND_LABEL[d.kind]}: ${d.title}`).join("; ") : "Document Pending", (t.flags || []).map(f => FLAG_LABEL[f] || f).join("; ")]);
  }
  const changes = audit.filter(a => a.record_type === "fin_partner_txns" && a.action === "update").map(a => {
    const t = txns.find(x => x.id === a.record_id) || {}, c = a.changes || {};
    const fields = Object.keys(c).filter(k => !["updated_at", "updated_by", "last_change_reason"].includes(k));
    return [t.txn_no || "", a.created_at, nameOf(a.actor_id), fields.map(k => `${k}: ${JSON.stringify(c[k][0])} → ${JSON.stringify(c[k][1])}`).join("; "), c.last_change_reason ? c.last_change_reason[1] : ""];
  });
  return { title: "Transaction & document audit trail", subtitle: "Every transaction with its documents, and every change with who, when and why",
    columns: [col("Txn"), col("Date"), col("Type"), col("Description"), col("Amount (+ owed / − repaid)", true), col("Account"), col("Status"), col("Verification"), col("Documents"), col("Flags")], rows,
    changes: { columns: [col("Txn"), col("When"), col("Who"), col("Change (previous → new)"), col("Reason")], rows: changes } };
}
