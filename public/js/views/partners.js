// Partner accounts screens (inside a business's books): dashboard, ledger, accounts, documents, reconciliation, statement & reports.
// Every figure comes from posted partner transactions, cross-checked against both ledgers.
import { esc, todayISO, fmtDate } from "../util.js";
import { state, nameOf } from "../store.js";
import { ICON, emptyState, section } from "../ui.js";
import { money, r2, natural, SUBTYPE_LABEL } from "../finance.js";
import { fin, entityById, accById, partyById, canWriteFin, isFinOwner, accountsOf, linesOf, partnerLinksOf, partnerTxnsOf, partnerDocsOf, partnerLedgerBalances } from "../finapi.js";
import { summary, ageing, byAccount, byMonth, statement, exceptions, TXN_TYPE_LABEL, RECON_LABEL, FLAG_LABEL, DOC_KIND_LABEL, docsOf, signed, AGE_BUCKETS,
  reportStatement, reportPayables, reportCoa, reportAgeing, reportAudit } from "../partners.js";

export const PARTNER_VIEWS = { dashboard: "Dashboard", ledger: "Transaction ledger", accounts: "Chart of accounts", documents: "Supporting documents", reconciliation: "Reconciliation", statement: "Statement & reports" };
export const PARTNER_REPORTS = { statement: "Monthly partner statement", payables: "Partner payables report", coa: "COA-wise receivable summary", audit: "Transaction & document audit trail", ageing: "Outstanding receivable ageing" };
export const pui = () => (state.ui.partner = state.ui.partner || { link: null, q: "", type: "", show: "posted", docFilter: "pending", month: null, report: "statement" });
const today = () => todayISO(state.tz);
const tile = (n, label, cls = "", href = "") => `<${href ? `a href="${href}"` : "div"} class="tile ${cls}"><span class="tn">${n}</span><span class="tl">${label}</span></${href ? "a" : "div"}>`;
export const currentLink = e => { const ls = partnerLinksOf(e.id), u = pui(); return ls.find(k => k.id === u.link) || ls[0] || null; };
export const partnerName = k => (partyById(k.partner_party_id) || {}).name || "Partner";
const accName = id => { const a = accById(id); return a ? `${a.code} ${a.name}` : "—"; };

/** Everything the screens and exports need for one partner account. */
export function partnerContext(e, k) {
  const txns = partnerTxnsOf(k.id), docs = partnerDocsOf(k.id), bal = partnerLedgerBalances(k);
  const otherLines = fin.posted.filter(l => l.account_id === k.partner_account_id && l.party_id === k.partner_party_id && l.journal && !["partner", "reversal"].includes(l.journal.source))
    .map(l => ({ number: l.journal.number, amount: Number(l.credit) - Number(l.debit) }));
  const ls = linesOf(e.id);
  const bankNegative = accountsOf(e.id, a => ["bank", "cash"].includes(a.subtype)).map(a => ({ a, b: r2(natural(a, ls.filter(l => l.account_id === a.id).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0))) }))
    .filter(x => x.b < 0).map(x => ({ account: `${x.a.code} ${x.a.name}`, balance: x.b }));
  const sum = summary(txns, docs, { asOf: today(), termsDays: k.terms_days });
  const ex = exceptions(txns, docs, { hasMirror: !!k.mirror_entity_id && bal.mirrorVisible, bizBalance: bal.biz, mirrorBalance: bal.mirror, otherLines, bankNegative });
  return { e, k, txns, docs, bal, sum, ex, partner: partnerName(k), mirror: k.mirror_entity_id ? entityById(k.mirror_entity_id) : null };
}

export function renderPartners(e, sub = "dashboard") {
  const links = partnerLinksOf(e.id), w = canWriteFin(e.id);
  if (!links.length) {
    return isFinOwner(e.id) ? `<section class="sect getting-started"><div class="sect-h"><h2>Partner accounts</h2></div>
      <p>Track money a partner pays personally on behalf of ${esc(e.name)} — expenses, salaries — and what the business pays back. Each line posts to the partner current account, and can be mirrored into the partner's personal books so both sides always agree.</p>
      <button class="btn primary" data-act="pt-setup">${ICON.plus}Set up a partner account</button></section>`
      : emptyState("No partner accounts", "The owner of these books can set one up.");
  }
  const k = currentLink(e), c = partnerContext(e, k);
  if (!PARTNER_VIEWS[sub]) sub = "dashboard";
  const body = { dashboard, ledger, accounts, documents, reconciliation, statementView }[sub === "statement" ? "statementView" : sub](c);
  return `
  <div class="ptn-head noprint">
    ${links.length > 1 ? `<select class="input" data-act="pt-link" aria-label="Partner">${links.map(x => `<option value="${x.id}" ${x.id === k.id ? "selected" : ""}>${esc(partnerName(x))}</option>`).join("")}</select>` : `<h2>${esc(c.partner)} <small class="hint">partner current account</small></h2>`}
    <div class="btnrow">${w ? `<button class="btn primary" data-act="pt-new">${ICON.plus}Record transaction</button>` : ""}${isFinOwner(e.id) ? `<button class="btn" data-act="pt-setup">Add partner</button>` : ""}</div>
  </div>
  <div class="viewtabs sm noprint">${Object.entries(PARTNER_VIEWS).map(([v, l]) => `<a href="#/finance/${e.id}/partners/${v}" class="${v === sub ? "on" : ""}">${l}${v === "reconciliation" && c.ex.some(x => x.severity === "high") ? ` <b class="cnt">${c.ex.filter(x => x.severity === "high").length}</b>` : ""}</a>`).join("")}</div>
  ${body}`;
}

const M = (c, n) => money(n, c.e.base_currency);
const agreeBanner = c => {
  if (!c.k.mirror_entity_id) return `<div class="banner info">Only the business side is kept here (no personal books linked).</div>`;
  if (!c.bal.mirrorVisible) return `<div class="banner info">The partner's personal books are private to them, so the two-book check runs on their side.</div>`;
  return r2(c.bal.biz) === r2(c.bal.mirror) && r2(c.bal.biz) === c.sum.outstanding
    ? `<div class="banner ok">${ICON.done} Both books agree: ${esc(c.e.name)} owes ${esc(c.partner)} ${M(c, c.bal.biz)}, and ${esc(c.mirror.name)} shows the same amount receivable.</div>`
    : `<div class="banner bad">The books don't agree — business ${M(c, c.bal.biz)}, personal ${M(c, c.bal.mirror)}, partner ledger ${M(c, c.sum.outstanding)}. <a href="#/finance/${c.e.id}/partners/reconciliation">Reconcile</a></div>`;
};

function dashboard(c) {
  const s = c.sum, base = `#/finance/${c.e.id}/partners`;
  const coa = byAccount(c.txns, accById).filter(r => r.funded), maxF = Math.max(1, ...coa.map(r => r.funded));
  const months = byMonth(c.txns), high = c.ex.filter(x => x.severity === "high");
  return `${agreeBanner(c)}
  <div class="tiles">
    ${tile(M(c, s.outstanding), `Outstanding — owed to ${esc(c.partner)}`, s.outstanding > 0 ? "warn" : "ok", base + "/statement")}
    ${tile(M(c, s.historical), "Historical funding (imported)", "", base + "/ledger")}
    ${tile(M(c, s.additional), "Additional funding")}
    ${tile(M(c, s.reimbursed), "Reimbursed by the business")}
    ${tile(s.unverified, "Unverified transactions", s.unverified ? "warn" : "", base + "/ledger")}
    ${tile(s.missingDocs, "Document Pending", s.missingDocs ? "warn" : "", base + "/documents")}
    ${tile(s.overdue === null ? "—" : M(c, s.overdue), s.overdue === null ? "Overdue: no repayment terms set" : `Overdue (over ${c.k.terms_days} days)`, s.overdue ? "bad" : "")}
    ${tile(c.ex.length, "Exceptions to review", high.length ? "bad" : c.ex.length ? "warn" : "ok", base + "/reconciliation")}
  </div>
  ${isFinOwner(c.e.id) ? `<p class="hint noprint">Repayment terms: ${c.k.terms_days === null || c.k.terms_days === undefined ? "none agreed" : c.k.terms_days + " days"} · <button class="linkbtn" data-act="pt-terms">Change</button></p>` : ""}
  ${high.length ? `<div class="banner warn">${high.map(x => `<b>${esc(x.title)}.</b> ${esc(x.detail)}`).join("<br>")}</div>` : ""}
  <div class="grid-2">
    ${section("Receivable by account", coa.length ? `<div class="tablewrap"><table class="rtable"><thead><tr><th>Account</th><th></th><th class="num">Funded</th></tr></thead><tbody>
      ${coa.map(r => `<tr><td>${esc(r.account.code + " " + r.account.name)}</td><td style="width:35%"><span class="bar"><i style="width:${(r.funded / maxF * 100).toFixed(1)}%"></i></span></td><td class="num">${M(c, r.funded)}</td></tr>`).join("")}
      </tbody></table></div><p class="hint">What the partner's money paid for. Reimbursements are paid from the business bank and reduce the balance, not these costs.</p>` : `<p class="calm">Nothing recorded yet.</p>`)}
    ${section("Receivable by month", months.length ? `<div class="tablewrap"><table class="rtable"><thead><tr><th>Month</th><th class="num">Funded</th><th class="num">Reimbursed</th><th class="num">Balance</th></tr></thead><tbody>
      ${months.map(r => `<tr><td>${monthLabel(r.month)}</td><td class="num">${M(c, r.funded)}</td><td class="num">${r.repaid ? M(c, r.repaid) : "—"}</td><td class="num"><b>${M(c, r.closing)}</b></td></tr>`).join("")}
      </tbody></table></div>` : `<p class="calm">Nothing recorded yet.</p>`)}
  </div>`;
}
export const monthLabel = m => new Date(m + "-01T00:00:00Z").toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

const flagChips = t => (t.flags || []).filter(f => f !== "month_only_date").map(f => `<span class="chip warn" title="${esc(FLAG_LABEL[f] || f)}">${esc(FLAG_LABEL[f] || f)}</span>`).join(" ");
export const docCell = (c, t) => { const ds = docsOf(c.docs, t.id);
  return ds.length ? ds.map(d => `<button class="linkbtn" data-act="pt-doc-open" data-id="${d.id}" title="${esc(DOC_KIND_LABEL[d.kind])}">${ICON.link}${esc(d.title)}</button>`).join("<br>") : `<span class="pill inv-unpaid">Document Pending</span>`; };
const dateCell = t => t.date_precision === "month" ? `${monthLabel(t.txn_date.slice(0, 7)).replace(/^(\w{3})\w*/, "$1")}<br><small class="hint">exact date unavailable</small>` : fmtDate(t.txn_date);

function ledger(c) {
  const u = pui(), q = u.q.trim().toLowerCase();
  let ts = c.txns.slice();
  if (u.show === "posted") ts = ts.filter(t => t.status === "posted"); else if (u.show === "reversed") ts = ts.filter(t => t.status === "reversed");
  else if (u.show === "unverified") ts = ts.filter(t => t.status === "posted" && t.recon_status !== "verified");
  if (u.type) ts = ts.filter(t => t.txn_type === u.type);
  if (q) ts = ts.filter(t => [t.txn_no, t.description, t.beneficiary, t.reference, t.job_ref, t.notes, accName(t.account_id)].join(" ").toLowerCase().includes(q));
  let bal = 0; const running = new Map(); for (const t of c.txns.filter(t => t.status === "posted").sort((a, b) => (a.txn_date + a.txn_no).localeCompare(b.txn_date + b.txn_no))) { bal = r2(bal + signed(t)); running.set(t.id, bal); }
  return `<div class="kfilters btnrow noprint">
    <input class="input" type="search" placeholder="Search supplier, reference, description…" value="${esc(u.q)}" data-act="pt-q" id="pt-q">
    <select class="input" data-act="pt-type"><option value="">All types</option>${Object.entries(TXN_TYPE_LABEL).map(([k, l]) => `<option value="${k}" ${u.type === k ? "selected" : ""}>${l}</option>`).join("")}</select>
    <select class="input" data-act="pt-show">${[["posted", "Posted"], ["unverified", "Unverified only"], ["reversed", "Reversed"], ["all", "Everything"]].map(([k, l]) => `<option value="${k}" ${u.show === k ? "selected" : ""}>${l}</option>`).join("")}</select>
    <button class="btn" data-act="pt-xlsx" data-r="ledger">${ICON.download}Excel</button></div>
  ${ts.length ? `<div class="tablewrap"><table class="rtable ptn-ledger"><thead><tr><th>Txn</th><th>Date</th><th>Description</th><th>Account · type</th><th class="num">Owed +/−</th><th class="num">Balance</th><th>Documents</th><th>Status</th></tr></thead><tbody>
    ${ts.map(t => `<tr class="clickrow ${t.status === "reversed" ? "muted" : ""}" data-act="pt-open" data-id="${t.id}">
      <td><b>${esc(t.txn_no)}</b></td><td>${dateCell(t)}${t.payment_date ? `<br><small class="hint">paid ${fmtDate(t.payment_date)}</small>` : ""}</td>
      <td>${esc(t.description)}${t.beneficiary ? `<br><small class="hint">${esc(t.beneficiary)}${t.reference ? " · " + esc(t.reference) : ""}</small>` : t.reference ? `<br><small class="hint">${esc(t.reference)}</small>` : ""} ${flagChips(t)}</td>
      <td><small>${esc(accName(t.account_id))}<br><span class="hint">${TXN_TYPE_LABEL[t.txn_type]}</span></small></td>
      <td class="num ${t.direction === "decrease" ? "ok-text" : ""}">${t.direction === "decrease" ? "−" : ""}${M(c, t.amount)}</td><td class="num">${running.has(t.id) ? M(c, running.get(t.id)) : "—"}</td>
      <td>${docCell(c, t)}</td><td>${t.status === "reversed" ? `<span class="pill inv-void">Reversed</span>` : `<span class="pill ${t.recon_status === "verified" ? "inv-paid" : t.recon_status === "disputed" ? "inv-overdue" : "inv-partial"}">${RECON_LABEL[t.recon_status]}</span>`}</td></tr>`).join("")}
    </tbody></table></div>` : `<p class="calm">No transactions match.</p>`}
  <p class="hint">Posted transactions can't be edited in amount, date or account, or deleted. Open one to reverse it with a reason; the original stays on record.</p>`;
}

function accounts(c) {
  const used = byAccount(c.txns, accById), pacc = accById(c.k.partner_account_id), m = c.mirror;
  const mrec = accById(c.k.mirror_receivable_account_id), mparty = partyById(c.k.mirror_party_id), mdef = accById(c.k.mirror_default_account_id);
  return `${section("Control accounts", `<div class="tablewrap"><table class="rtable"><thead><tr><th>Books</th><th>Account</th><th>Kind</th><th>Tagged to</th><th class="num">Balance</th></tr></thead><tbody>
    <tr><td>${esc(c.e.name)}</td><td><b>${esc(pacc ? pacc.code + " " + pacc.name : "—")}</b></td><td>Liability — due to partner</td><td>${esc(c.partner)}</td><td class="num">${M(c, c.bal.biz)}</td></tr>
    ${m ? `<tr><td>${esc(m.name)}</td><td><b>${esc(mrec ? mrec.code + " " + mrec.name : "Private")}</b></td><td>Asset — due from business</td><td>${esc(mparty ? mparty.name : c.e.name)}</td><td class="num">${c.bal.mirror === null ? "Private" : M(c, c.bal.mirror)}</td></tr>` : ""}
    </tbody></table></div>
    <p class="hint">The partner balance is a balance-sheet control account, not income or expense. Reimbursements debit it and credit the business bank — never revenue, never a second expense.${mdef ? ` In the personal books, money paid out is credited to <b>${esc(mdef.code + " " + mdef.name)}</b> unless a personal bank, cash or card account is chosen on the transaction.` : ""}</p>`)}
  ${section("Accounts these transactions post to", used.length ? `<div class="tablewrap"><table class="rtable"><thead><tr><th>Code</th><th>Account</th><th>Type</th><th class="num">Lines</th><th class="num">Funded by partner</th><th class="num">Repaid</th></tr></thead><tbody>
    ${used.map(r => `<tr><td>${esc(r.account.code)}</td><td>${esc(r.account.name)}${r.account.description ? `<br><small class="hint">${esc(r.account.description)}</small>` : ""}</td><td>${esc(SUBTYPE_LABEL[r.account.subtype] || r.account.type)}</td><td class="num">${r.count}</td><td class="num">${r.funded ? M(c, r.funded) : "—"}</td><td class="num">${r.repaid ? M(c, r.repaid) : "—"}</td></tr>`).join("")}
    </tbody></table></div>` : `<p class="calm">Nothing recorded yet.</p>`, { right: `<a class="more" href="#/finance/${c.e.id}/accounts">Full chart of accounts</a>` })}`;
}

function documents(c) {
  const u = pui();
  let ts = c.txns.filter(t => t.status === "posted");
  if (u.docFilter === "pending") ts = ts.filter(t => !docsOf(c.docs, t.id).length); else if (u.docFilter === "attached") ts = ts.filter(t => docsOf(c.docs, t.id).length);
  const w = canWriteFin(c.e.id);
  return `<div class="kfilters btnrow noprint"><select class="input" data-act="pt-docfilter">${[["pending", "Document Pending"], ["attached", "With documents"], ["all", "All"]].map(([k, l]) => `<option value="${k}" ${u.docFilter === k ? "selected" : ""}>${l}</option>`).join("")}</select>
    <span class="hint">PDF, JPG, PNG or Excel, up to 25 MB. Files are private; links open for 10 minutes.</span></div>
  ${ts.length ? `<div class="tablewrap"><table class="rtable"><thead><tr><th>Txn</th><th>Description</th><th class="num">Amount</th><th>Documents</th>${w ? "<th></th>" : ""}</tr></thead><tbody>
    ${ts.map(t => `<tr><td><button class="linkbtn" data-act="pt-open" data-id="${t.id}"><b>${esc(t.txn_no)}</b></button></td><td>${esc(t.description)}${t.beneficiary ? `<br><small class="hint">${esc(t.beneficiary)}</small>` : ""}</td><td class="num">${M(c, t.amount)}</td>
      <td>${docsOf(c.docs, t.id).map(d => `<div><span class="chip">${esc(DOC_KIND_LABEL[d.kind])}</span> <button class="linkbtn" data-act="pt-doc-open" data-id="${d.id}">${esc(d.title)}</button></div>`).join("") || `<span class="pill inv-unpaid">Document Pending</span>`}</td>
      ${w ? `<td><button class="btn sm" data-act="pt-open" data-id="${t.id}" data-focus="docs">Attach</button></td>` : ""}</tr>`).join("")}</tbody></table></div>`
    : `<p class="calm">${u.docFilter === "pending" ? `${ICON.done} Every transaction has a document.` : "Nothing here."}</p>`}`;
}

const SEV = { high: ["bad", "Needs action"], medium: ["warn", "Check"], info: ["info", "For information"] };
function reconciliation(c) {
  const m = c.mirror, pendingMirror = c.txns.filter(t => t.status === "posted" && !t.mirror_journal_id).length;
  const canSync = m && canWriteFin(m.id) && pendingMirror;
  const row = (label, v, ok) => `<tr><td>${label}</td><td class="num"><b>${v === null ? "Private" : M(c, v)}</b></td><td>${v === null ? "" : ok ? `<span class="pill inv-paid">Agrees</span>` : `<span class="pill inv-overdue">Differs</span>`}</td></tr>`;
  return `${section("Two-book check", `<div class="tablewrap"><table class="rtable"><tbody>
    ${row(`Partner ledger (posted transactions)`, c.sum.outstanding, true)}
    ${row(`${esc(c.e.name)} — ${esc(accName(c.k.partner_account_id))}, ${esc(c.partner)}`, c.bal.biz, r2(c.bal.biz) === c.sum.outstanding)}
    ${m ? row(`${esc(m.name)} — ${esc(accName(c.k.mirror_receivable_account_id))}`, c.bal.mirror, c.bal.mirror !== null && r2(c.bal.mirror) === c.sum.outstanding) : ""}
    </tbody></table></div>
    ${canSync ? `<p>${pendingMirror} transaction${pendingMirror > 1 ? "s are" : " is"} not yet in your personal books. <button class="btn sm primary" data-act="pt-sync">Post to my personal books</button></p>` : ""}`)}
  ${section("Exceptions", c.ex.length ? `<div class="list">${c.ex.map(x => `<div class="trow ex-${x.severity}"><span class="pill ${SEV[x.severity][0] === "bad" ? "inv-overdue" : SEV[x.severity][0] === "warn" ? "inv-partial" : "inv-unpaid"}">${SEV[x.severity][1]}</span>
      <div class="tmain"><div class="ttitle">${esc(x.title)}</div><div class="tmeta">${esc(x.detail)}</div>
      ${x.txns.length ? `<div class="chips">${x.txns.slice(0, 20).map((id, i) => `<button class="chip" data-act="pt-open" data-id="${id}">${esc(x.refs[i])}</button>`).join("")}${x.txns.length > 20 ? ` <small>+${x.txns.length - 20} more</small>` : ""}</div>` : ""}</div></div>`).join("")}</div>`
    : `<p class="calm">${ICON.done} No exceptions.</p>`, { right: `<span class="c">${c.ex.length}</span>` })}
  <p class="hint">These checks never change your records. Fix a wrong line by reversing it (with a reason) and recording it again; historical lines are never altered silently.</p>`;
}

/* statement + 5 reports */
export function reportFor(c, key, month) {
  const u = pui(), mo = month || u.month || today().slice(0, 7), from = mo + "-01", to = endOfMonth(mo), meta = { partner: c.partner, business: c.e.name, currency: c.e.base_currency, asOf: today() };
  switch (key) {
    case "payables": return reportPayables(c.txns, accById, meta);
    case "coa": return reportCoa(c.txns, accById, meta);
    case "ageing": return reportAgeing(c.txns, today(), c.k.terms_days, meta);
    case "audit": return reportAudit(c.txns, c.docs, fin.audit.filter(a => a.entity_id === c.e.id), { nameOf: id => id ? nameOf(id) : "System", accName });
    default: return reportStatement(c.txns, from, to, meta);
  }
}
export const endOfMonth = m => { const [y, mm] = m.split("-").map(Number); return new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10); };
const cellHtml = (v, colMoney, c) => v === null || v === undefined || v === "" ? "" : typeof v === "number" && colMoney ? M(c, v) : esc(String(v));
export function reportTableHtml(rep, c) {
  const t = (cols, rows, bold = new Set()) => `<div class="tablewrap"><table class="rtable fs"><thead><tr>${cols.map(x => `<th class="${x.money ? "num" : ""}">${esc(x.label)}</th>`).join("")}</tr></thead><tbody>
    ${rows.map((r, i) => `<tr class="${bold.has(i) ? "total" : ""}">${r.map((v, j) => `<td class="${cols[j] && cols[j].money ? "num" : ""}">${bold.has(i) ? "<b>" : ""}${cellHtml(v, cols[j] && cols[j].money, c)}${bold.has(i) ? "</b>" : ""}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${cols.length}" class="calm">Nothing in this period.</td></tr>`}</tbody></table></div>`;
  return `<div class="report"><h2>${esc(rep.title)}</h2><p class="sub">${esc(rep.subtitle)}</p>${t(rep.columns, rep.rows, rep.bold)}
    ${rep.changes ? `<h3>Changes</h3>${rep.changes.rows.length ? t(rep.changes.columns, rep.changes.rows) : `<p class="calm">No edits recorded.</p>`}` : ""}
    <p class="hint print-only">Printed ${fmtDate(today())} from Jezz HQ · figures from posted entries only.</p></div>`;
}
function statementView(c) {
  const u = pui(), mo = u.month || today().slice(0, 7), key = u.report || "statement", rep = reportFor(c, key, mo);
  return `<div class="kfilters btnrow noprint">
    <select class="input" data-act="pt-report">${Object.entries(PARTNER_REPORTS).map(([k, l]) => `<option value="${k}" ${key === k ? "selected" : ""}>${l}</option>`).join("")}</select>
    ${key === "statement" ? `<input class="input" type="month" value="${mo}" data-act="pt-month" aria-label="Month">` : ""}
    <button class="btn" data-act="pt-xlsx" data-r="${key}">${ICON.download}Excel</button><button class="btn" data-act="pt-xlsx" data-r="all">${ICON.download}All reports (Excel)</button>
    <button class="btn" data-act="pt-print">Print / PDF</button></div>
  ${key === "audit" && !fin.audit.some(a => a.entity_id === c.e.id) ? `<p class="hint noprint">Loading change history… <button class="linkbtn" data-act="pt-load-audit">Load</button></p>` : ""}
  ${reportTableHtml(rep, c)}`;
}
