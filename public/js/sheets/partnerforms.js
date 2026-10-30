// Partner accounts: forms and actions. Money only moves through database functions; edits need a reason and are audited.
import { esc, todayISO, fmtDate } from "../util.js";
import { state, nameOf } from "../store.js";
import { ICON, $, openSheet, closeSheet, rerenderSheet, sheetHead, toast, toastError, dialog, busy } from "../ui.js";
import { safeFileName, fmtBytes } from "../insights.js";
import { money, ACCOUNT_TYPES } from "../finance.js";
import { fin, loadFin, loadAudit, entityById, accById, journalById, canWriteFin, isFinOwner, accountsOf, ptxnById, partnerRecord, partnerUpdate, partnerReverse, partnerSyncMirror,
  partnerLinkCreate, setPartnerTerms, uploadPartnerDoc, addPartnerDocLink, partnerDocUrl, deletePartnerDoc } from "../finapi.js";
import { TXN_TYPE_LABEL, PAID_FROM_LABEL, RECON_LABEL, FLAG_LABEL, DOC_KIND_LABEL, DOC_MIME, docsOf, allocate } from "../partners.js";
import { pui, currentLink, partnerContext, partnerName, reportFor, PARTNER_REPORTS, monthLabel } from "../views/partners.js";
import { downloadXlsx } from "../xlsx.js";

const today = () => todayISO(state.tz);
const val = id => ($(id) ? $(id).value.trim() : "");
const curEntity = () => entityById(state.route.a);
const refresh = () => loadFin(true);
const accOpts = (eid, sel, pred, blank = "Choose account…") => `<option value="">${blank}</option>` + Object.entries(ACCOUNT_TYPES).map(([t, l]) => {
  const as = accountsOf(eid, a => a.type === t && a.is_active && pred(a)); return as.length ? `<optgroup label="${l}">${as.map(a => `<option value="${a.id}" ${a.id === sel ? "selected" : ""}>${esc(a.code + " " + a.name)}</option>`).join("")}</optgroup>` : ""; }).join("");
const fundingAcc = k => a => a.id !== k.partner_account_id && !["cash", "bank", "card"].includes(a.subtype) && !["income", "equity"].includes(a.type);
const repayAcc = () => a => ["cash", "bank"].includes(a.subtype);
const adjAcc = k => a => a.id !== k.partner_account_id && !["cash", "bank", "card"].includes(a.subtype);
const FRIENDLY = { mixed_funds: "Money the partner paid personally can't be booked to the business's own bank or cash.", exceeds_outstanding: null, duplicate_import: "This line was already imported.",
  "duplicate key": "This supplier invoice is already recorded for this partner.", period_locked: null, currency: null };
const err = e => { const m = (e && (e.message || e)) + ""; const k = Object.keys(FRIENDLY).find(x => m.startsWith(x)); return k && FRIENDLY[k] ? FRIENDLY[k] : m.replace(/^[a-z_]+: /, ""); };

/* ---------------- set up ---------------- */
function openSetup() {
  const e = curEntity(); if (!e || !isFinOwner(e.id)) return;
  const personal = fin.entities.filter(x => x.kind === "personal" && !x.archived && canWriteFin(x.id));
  openSheet(sh => { sh.innerHTML = sheetHead("Set up a partner account", esc(e.name)) + `<form id="ptSetup" class="sh-body" novalidate>
    <label class="field"><span>Partner's name</span><input class="input" id="ps-name" placeholder="e.g. Jezz" autofocus></label>
    <label class="field"><span>Mirror into personal books <small>(optional)</small></span><select class="input" id="ps-mirror"><option value="">Don't mirror</option>${personal.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select></label>
    <p class="hint">Uses the existing partner current account in ${esc(e.name)} (no new accounts are created). When mirrored, each transaction also posts to "Money owed to me" in your personal books, tagged to ${esc(e.name)}, so both sides always show the same balance.</p>
    <div class="sheet-foot"><button class="btn primary block" type="submit" id="psSave">Set up</button></div></form>`; });
}

/* ---------------- record ---------------- */
let draftType = "expense_funding";
function openRecord(type) {
  const e = curEntity(), k = currentLink(e); if (!k) return;
  draftType = type || draftType;
  const m = k.mirror_entity_id && fin.entities.find(x => x.id === k.mirror_entity_id), mirrorWrite = m && canWriteFin(m.id);
  const open = allocate(fin.ptxns.filter(t => t.link_id === k.id)).funding.filter(f => f.open > 0);
  openSheet(sh => {
    const t = draftType, isRe = t === "reimbursement", isAdj = t === "adjustment";
    sh.innerHTML = sheetHead("Record partner transaction", `${esc(e.name)} · ${esc(partnerName(k))} · ${e.base_currency}`) + `<form id="ptRecord" class="sh-body" novalidate>
    <label class="field"><span>Type</span><select class="input" id="pr-type" data-act="pr-type">${Object.entries(TXN_TYPE_LABEL).map(([v, l]) => `<option value="${v}" ${v === t ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    ${isAdj ? `<label class="field"><span>Effect</span><select class="input" id="pr-dir"><option value="increase">Increases what the business owes ${esc(partnerName(k))}</option><option value="decrease">Decreases what the business owes ${esc(partnerName(k))}</option></select></label>` : ""}
    <div class="grid2"><label class="field"><span>${isRe ? "Reimbursement date" : "Expense / transaction date"}</span><input class="input" type="date" id="pr-date" value="${today()}"></label>
      <label class="field"><span>Payment date <small>(when money moved, if known)</small></span><input class="input" type="date" id="pr-paydate"></label></div>
    <label class="check"><input type="checkbox" id="pr-month"> Only the month is known — I'll enter the month end and it will be shown as "exact date unavailable"</label>
    <label class="field"><span>Description</span><input class="input" id="pr-desc" maxlength="300" placeholder="${isRe ? "Reimbursement from the business" : "e.g. Fabric from Al Balai"}"></label>
    <div class="grid2"><label class="field"><span>${isRe ? "Paid by" : "Supplier / beneficiary"}</span><input class="input" id="pr-ben"></label>
      <label class="field"><span>Invoice / reference no.</span><input class="input" id="pr-ref"></label></div>
    <div class="grid2"><label class="field"><span>Amount paid (${e.base_currency})</span><input class="input num" type="number" step="0.01" min="0.01" id="pr-amt"></label>
      ${!isRe ? `<label class="field"><span>Invoice amount <small>(if different)</small></span><input class="input num" type="number" step="0.01" min="0" id="pr-inv"></label>` : ""}</div>
    <label class="field"><span>${isRe ? "Paid from (business bank or cash)" : isAdj ? "Counter account" : "Post to (expense, inventory or liability)"}</span>
      <select class="input" id="pr-acc">${accOpts(e.id, null, isRe ? repayAcc() : isAdj ? adjAcc(k) : fundingAcc(k))}</select></label>
    ${!isRe ? `<label class="field"><span>Paid from (partner's money)</span><select class="input" id="pr-from">${["personal_bank", "personal_cash", "personal_card", "other", "not_recorded"].map(v => `<option value="${v}" ${v === "not_recorded" ? "selected" : ""}>${PAID_FROM_LABEL[v]}</option>`).join("")}</select></label>` : ""}
    ${isRe && open.length ? `<label class="field"><span>Settles <small>(optional — otherwise oldest first)</small></span><select class="input" id="pr-settles"><option value="">Oldest first</option>${open.map(f => `<option value="${f.t.id}">${esc(f.t.txn_no)} · ${esc(f.t.description)} · ${money(f.open, e.base_currency)} open</option>`).join("")}</select></label>` : ""}
    ${mirrorWrite ? `<label class="field"><span>In my personal books, ${isRe ? "received into" : "paid from"}</span><select class="input" id="pr-macc">${accOpts(m.id, null, a => ["cash", "bank", "card"].includes(a.subtype) || a.system_key === "opening", `Default: ${esc((accById(k.mirror_default_account_id) || {}).name || "Opening balances")}`)}</select></label>` : ""}
    <div class="grid2"><label class="field"><span>Project / job no.</span><input class="input" id="pr-job"></label><label class="field"><span>Notes</span><input class="input" id="pr-notes"></label></div>
    <p class="hint">Posting creates the double entry now${mirrorWrite ? " in both books" : ""}. Amount, date and account can't be edited afterwards — mistakes are reversed with a reason. Attach the invoice and payment proof after saving.</p>
    <div class="sheet-foot"><button class="btn primary block" type="submit" id="prSave">Post transaction</button></div></form>`;
  }, { wide: true });
}
async function submitRecord() {
  const e = curEntity(), k = currentLink(e), t = val("pr-type"), btn = $("prSave");
  let date = val("pr-date"); const monthOnly = $("pr-month") && $("pr-month").checked;
  if (!date) return toastError("Enter the date (if only the month is known, tick the box).");
  if (monthOnly) { const [y, mm] = date.split("-").map(Number); date = new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10); }
  const amt = Number(val("pr-amt"));
  if (!(amt > 0)) return toastError("Enter the amount.");
  if (!val("pr-desc")) return toastError("Add a description.");
  if (!val("pr-acc")) return toastError("Choose the account.");
  const p = { link_id: k.id, txn_type: t, txn_date: date, date_precision: monthOnly ? "month" : "day", payment_date: val("pr-paydate") || null, description: val("pr-desc"),
    beneficiary: val("pr-ben") || null, reference: val("pr-ref") || null, amount: amt, invoice_amount: val("pr-inv") || null, account_id: val("pr-acc"), paid_from: val("pr-from") || null,
    job_ref: val("pr-job") || null, notes: val("pr-notes") || null, mirror_account_id: val("pr-macc") || null, flags: monthOnly ? ["month_only_date"] : [] };
  if (t === "adjustment") p.direction = val("pr-dir");
  if (t === "reimbursement" || p.direction === "decrease") { // the database checks this too; catching it here gives a clearer message
    const owed = partnerContext(e, k).bal.biz;
    if (amt > owed) return toastError(`${money(amt, e.base_currency)} is more than the ${money(owed, e.base_currency)} currently owed to ${partnerName(k)}.`);
  }
  busy(btn, true, "Posting…");
  const r = await partnerRecord(p);
  if (r.error) { busy(btn, false); return toastError(err(r.error)); }
  const settles = val("pr-settles");
  if (settles) { const u = await partnerUpdate(r.data, { settles_txn_id: settles }, "Set when recorded: reimbursement settles this funding line"); if (u.error) toastError(err(u.error)); }
  await refresh(); closeSheet(); openTxn(r.data); toast("Posted");
}

/* ---------------- one transaction ---------------- */
let historyFor = null;
function openTxn(id, focus) {
  openSheet(sh => {
    const t = ptxnById(id); if (!t) { sh.innerHTML = sheetHead("Not found", ""); return; }
    const e = entityById(t.entity_id), k = fin.plinks.find(x => x.id === t.link_id), w = canWriteFin(e.id), ds = docsOf(fin.pdocs, t.id), M = n => money(n, e.base_currency);
    const j = journalById(t.journal_id), mj = journalById(t.mirror_journal_id), rj = journalById(t.reversal_journal_id), settles = t.settles_txn_id && ptxnById(t.settles_txn_id);
    const settledBy = fin.ptxns.filter(x => x.settles_txn_id === t.id && x.status === "posted");
    const hist = fin.audit.filter(a => a.record_type === "fin_partner_txns" && a.record_id === t.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const kv = (l, v) => v ? `<dt>${l}</dt><dd>${v}</dd>` : "";
    sh.innerHTML = sheetHead(`${t.txn_no} · ${t.description}`, `${esc(e.name)} · ${TXN_TYPE_LABEL[t.txn_type]}${t.status === "reversed" ? " · reversed" : ""}`) + `<div class="sh-body">
      ${t.status === "reversed" ? `<div class="banner warn">Reversed${t.reversal_reason ? `: ${esc(t.reversal_reason)}` : ""}. It no longer counts in any balance; the original stays on record.</div>` : ""}
      <div class="tiles"><div class="tile ${t.direction === "decrease" ? "ok" : "warn"}"><span class="tn">${t.direction === "decrease" ? "−" : "+"}${M(t.amount)}</span><span class="tl">${t.direction === "decrease" ? "Reduces" : "Adds to"} what ${esc(e.name)} owes ${esc(partnerName(k))}</span></div></div>
      <dl class="kv">
        ${kv("Transaction date", t.date_precision === "month" ? `${monthLabel(t.txn_date.slice(0, 7))} — <b>exact date unavailable</b> (posted on ${fmtDate(t.txn_date)})` : fmtDate(t.txn_date))}
        ${kv("Payment date", t.payment_date ? fmtDate(t.payment_date) : `<span class="hint">Not recorded</span>`)}
        ${kv("Supplier / payee", esc(t.beneficiary || ""))}${kv("Invoice / reference", esc(t.reference || ""))}
        ${kv("Invoice amount", t.invoice_amount !== null && t.invoice_amount !== undefined ? M(t.invoice_amount) + (Number(t.invoice_amount) !== Number(t.amount) ? ` <span class="pill inv-partial">differs from paid</span>` : "") : "")}
        ${kv("Account", esc((accById(t.account_id) || {}).code + " " + (accById(t.account_id) || {}).name))}
        ${kv("Paid from", PAID_FROM_LABEL[t.paid_from])}${kv("Project / job", esc(t.job_ref || ""))}
        ${kv("Verification", `<span class="pill ${t.recon_status === "verified" ? "inv-paid" : t.recon_status === "disputed" ? "inv-overdue" : "inv-partial"}">${RECON_LABEL[t.recon_status]}</span>`)}
        ${kv("Flags", (t.flags || []).map(f => `<span class="chip warn">${esc(FLAG_LABEL[f] || f)}</span>`).join(" "))}${kv("Historical balance", esc(t.legacy_ref || ""))}
        ${kv("Settles", settles ? `<button class="linkbtn" data-act="pt-open" data-id="${settles.id}">${esc(settles.txn_no)} ${esc(settles.description)}</button>` : "")}
        ${kv("Settled by", settledBy.map(x => `<button class="linkbtn" data-act="pt-open" data-id="${x.id}">${esc(x.txn_no)}</button>`).join(", "))}
        ${kv("Notes", esc(t.notes || ""))}
        ${kv("Business entry", j ? `<button class="linkbtn" data-act="fin-open-journal" data-id="${j.id}">#${j.number}</button>` : "")}
        ${kv("Personal books entry", t.mirror_journal_id ? (mj ? `#${mj.number}` : "Posted (private)") : k.mirror_entity_id ? `<span class="hint">Not yet posted</span>` : "")}
        ${kv("Reversal entry", rj ? `<button class="linkbtn" data-act="fin-open-journal" data-id="${rj.id}">#${rj.number}</button>` : "")}
        ${kv("Recorded", `${fmtDate(t.created_at.slice(0, 10))} by ${esc(nameOf(t.created_by))}`)}
      </dl>
      <section class="sub" id="pt-docs"><div class="sub-h"><h3>Supporting documents</h3><span class="c">${ds.length}</span></div>
        ${ds.map(d => `<div class="krow"><span class="kico">${d.url ? ICON.link : ICON.download}</span><div><span class="chip">${esc(DOC_KIND_LABEL[d.kind])}</span> <button class="linkbtn" data-act="pt-doc-open" data-id="${d.id}">${esc(d.title)}</button>
          <small class="hint">${d.url ? "link" : (DOC_MIME[d.mime_type] || "") + " · " + fmtBytes(d.size_bytes || 0)}</small></div>${w ? `<button class="iconbtn sm" data-act="pt-doc-del" data-id="${d.id}" aria-label="Remove">${ICON.trash}</button>` : ""}</div>`).join("") || `<p><span class="pill inv-unpaid">Document Pending</span></p>`}
        ${w ? `<div class="btnrow"><select class="input" id="pd-kind" aria-label="Document type">${Object.entries(DOC_KIND_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
          <label class="btn sm filebtn">${ICON.download}Attach file<input type="file" hidden accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.csv,application/pdf,image/jpeg,image/png" data-act="pt-attach" data-id="${t.id}"></label>
          <button class="btn sm" data-act="pt-doc-link" data-id="${t.id}">${ICON.link}Add link</button></div>` : ""}</section>
      ${w && t.status === "posted" ? `<section class="sub"><div class="sub-h"><h3>Actions</h3></div><div class="btnrow">
        ${t.recon_status !== "verified" ? `<button class="btn sm" data-act="pt-verify" data-id="${t.id}" data-s="verified">${ICON.check}Mark verified</button>` : `<button class="btn sm" data-act="pt-verify" data-id="${t.id}" data-s="unverified">Mark unverified</button>`}
        ${t.recon_status !== "disputed" ? `<button class="btn sm" data-act="pt-verify" data-id="${t.id}" data-s="disputed">Dispute</button>` : ""}
        <button class="btn sm" data-act="pt-edit" data-id="${t.id}">Edit details</button>
        <button class="btn sm danger" data-act="pt-reverse" data-id="${t.id}">Reverse…</button></div>
        <p class="hint">Edits need a reason and are recorded with the previous and new value. To change the amount, date or account, reverse and record again.</p></section>` : ""}
      <section class="sub"><div class="sub-h"><h3>History</h3>${historyFor === e.id ? "" : `<button class="linkbtn" data-act="pt-history" data-id="${e.id}">Load</button>`}</div>
        ${historyFor === e.id ? (hist.length ? `<ul class="plain small">${hist.map(a => `<li>${new Date(a.created_at).toLocaleString("en-GB", { timeZone: state.tz })} · ${esc(a.actor_id ? nameOf(a.actor_id) : "System")} · ${a.action === "insert" ? "recorded" :
          Object.keys(a.changes || {}).filter(x => !["updated_at", "updated_by", "last_change_reason"].includes(x)).map(x => `${esc(x)}: ${esc(JSON.stringify(a.changes[x][0]))} → ${esc(JSON.stringify(a.changes[x][1]))}`).join("; ")}${a.changes && a.changes.last_change_reason ? ` — <i>${esc(a.changes.last_change_reason[1] || "")}</i>` : ""}</li>`).join("")}</ul>` : `<p class="hint">No changes.</p>`) : ""}</section>
    </div>`;
    if (focus === "docs") setTimeout(() => $("pt-docs") && $("pt-docs").scrollIntoView({ block: "start" }), 50);
  }, { wide: true });
}
function openEdit(id) {
  const t = ptxnById(id), e = entityById(t.entity_id);
  const open = t.direction === "decrease" ? allocate(fin.ptxns.filter(x => x.link_id === t.link_id)).funding.filter(f => f.open > 0 || f.t.id === t.settles_txn_id) : [];
  openSheet(sh => { sh.innerHTML = sheetHead(`Edit ${t.txn_no}`, "Amount, date and account are locked") + `<form id="ptEdit" class="sh-body" data-id="${t.id}" novalidate>
    <label class="field"><span>Description</span><input class="input" id="pe-desc" value="${esc(t.description)}" maxlength="300"></label>
    <div class="grid2"><label class="field"><span>Supplier / beneficiary</span><input class="input" id="pe-ben" value="${esc(t.beneficiary || "")}"></label><label class="field"><span>Invoice / reference</span><input class="input" id="pe-ref" value="${esc(t.reference || "")}"></label></div>
    <div class="grid2"><label class="field"><span>Payment date</span><input class="input" type="date" id="pe-pay" value="${t.payment_date || ""}"></label><label class="field"><span>Invoice amount</span><input class="input num" type="number" step="0.01" min="0" id="pe-inv" value="${t.invoice_amount ?? ""}"></label></div>
    <div class="grid2"><label class="field"><span>Paid from</span><select class="input" id="pe-from">${Object.entries(PAID_FROM_LABEL).map(([v, l]) => `<option value="${v}" ${v === t.paid_from ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="field"><span>Project / job no.</span><input class="input" id="pe-job" value="${esc(t.job_ref || "")}"></label></div>
    ${t.direction === "decrease" ? `<label class="field"><span>Settles</span><select class="input" id="pe-settles"><option value="">Oldest first</option>${open.map(f => `<option value="${f.t.id}" ${f.t.id === t.settles_txn_id ? "selected" : ""}>${esc(f.t.txn_no)} · ${esc(f.t.description)}</option>`).join("")}</select></label>` : ""}
    <fieldset class="field"><legend>Flags</legend>${Object.entries(FLAG_LABEL).map(([f, l]) => `<label class="check"><input type="checkbox" class="pe-flag" value="${f}" ${(t.flags || []).includes(f) ? "checked" : ""}> ${esc(l)}</label>`).join("")}</fieldset>
    <label class="field"><span>Notes</span><textarea class="input" id="pe-notes" rows="2">${esc(t.notes || "")}</textarea></label>
    <label class="field"><span>Reason for this change <small>(required, kept in the audit trail)</small></span><input class="input" id="pe-reason" required></label>
    <div class="sheet-foot"><button class="btn primary block" type="submit" id="peSave">Save changes</button></div></form>`; });
}
async function submitEdit(form) {
  const t = ptxnById(form.dataset.id), reason = val("pe-reason");
  if (!reason) return toastError("Give a reason for the change.");
  const next = { description: val("pe-desc"), beneficiary: val("pe-ben") || null, reference: val("pe-ref") || null, payment_date: val("pe-pay") || null, invoice_amount: val("pe-inv") === "" ? null : Number(val("pe-inv")),
    paid_from: val("pe-from"), job_ref: val("pe-job") || null, notes: val("pe-notes") || null, flags: [...document.querySelectorAll(".pe-flag:checked")].map(x => x.value) };
  if ($("pe-settles")) next.settles_txn_id = val("pe-settles") || null;
  const norm = v => v === undefined || v === "" ? null : v;
  const patch = {}; for (const [kk, v] of Object.entries(next)) { const cur = kk === "invoice_amount" && t[kk] !== null && t[kk] !== undefined ? Number(t[kk]) : t[kk]; if (JSON.stringify(norm(cur)) !== JSON.stringify(norm(v))) patch[kk] = v; }
  if (!Object.keys(patch).length) return toastError("Nothing changed.");
  if (!next.description) return toastError("Description can't be empty.");
  const btn = $("peSave"); busy(btn, true);
  const r = await partnerUpdate(t.id, patch, reason); busy(btn, false);
  if (r.error) return toastError(err(r.error));
  await refresh(); if (historyFor === t.entity_id) await loadAudit(t.entity_id); closeSheet(); toast("Saved");
}

/* ---------------- exports ---------------- */
function exportXlsx(which) {
  const e = curEntity(), k = currentLink(e), c = partnerContext(e, k), u = pui(), mo = u.month || today().slice(0, 7);
  const toSheet = (name, rep) => ({ name, columns: rep.columns, rows: rep.rows, bold: rep.bold });
  const fname = s => `${e.name}-${partnerName(k)}-${s}-${today()}`.replace(/[^\w.-]+/g, "-");
  if (which === "ledger") {
    const cols = ["Txn", "Type", "Transaction date", "Date precision", "Payment date", "Description", "Supplier / beneficiary", "Reference", "Invoice amount", "Amount", "Owed +/−", "Currency", "Paid from", "Account code", "Account", "Project / job", "Verification", "Status", "Reversal reason", "Settles", "Flags", "Historical balance", "Documents", "Notes"]
      .map(l => ({ label: l, money: ["Invoice amount", "Amount", "Owed +/−"].includes(l) }));
    const rows = c.txns.map(t => { const a = accById(t.account_id) || {}, ds = docsOf(c.docs, t.id);
      return [t.txn_no, TXN_TYPE_LABEL[t.txn_type], t.txn_date, t.date_precision === "month" ? "Month only — exact date unavailable" : "Exact", t.payment_date || "", t.description, t.beneficiary || "", t.reference || "",
        t.invoice_amount === null || t.invoice_amount === undefined ? null : Number(t.invoice_amount), Number(t.amount), t.status === "posted" ? (t.direction === "decrease" ? -1 : 1) * Number(t.amount) : 0, t.currency, PAID_FROM_LABEL[t.paid_from],
        a.code || "", a.name || "", t.job_ref || "", RECON_LABEL[t.recon_status], t.status === "reversed" ? "Reversed" : "Posted", t.reversal_reason || "", (ptxnById(t.settles_txn_id) || {}).txn_no || "",
        (t.flags || []).map(f => FLAG_LABEL[f] || f).join("; "), t.legacy_ref || "", ds.length ? ds.map(d => `${DOC_KIND_LABEL[d.kind]}: ${d.title}`).join("; ") : "Document Pending", t.notes || ""]; });
    rows.push([{ v: "Outstanding", bold: true }, ...Array(9).fill(null), { v: c.sum.outstanding, bold: true, money: true }]);
    return downloadXlsx(fname("ledger"), [{ name: "Ledger", columns: cols, rows }]);
  }
  if (which === "all") {
    const sheets = Object.entries(PARTNER_REPORTS).flatMap(([key, label]) => { const rep = reportFor(c, key, mo); const out = [toSheet(label, rep)]; if (rep.changes) out.push({ name: "Audit changes", columns: rep.changes.columns, rows: rep.changes.rows }); return out; });
    sheets.push({ name: "Exceptions", columns: [{ label: "Severity" }, { label: "Check" }, { label: "Detail" }, { label: "Transactions" }], rows: c.ex.map(x => [x.severity, x.title, x.detail, x.refs.join(", ")]) });
    return downloadXlsx(fname("reports"), sheets);
  }
  const rep = reportFor(c, which, mo), sheets = [toSheet(PARTNER_REPORTS[which], rep)];
  if (rep.changes) sheets.push({ name: "Changes", columns: rep.changes.columns, rows: rep.changes.rows });
  downloadXlsx(fname(which === "statement" ? `statement-${mo}` : which), sheets);
}

/* ---------------- handlers ---------------- */
export async function handlePartnerClick(act, el, rerender) {
  const id = el.dataset.id;
  switch (act) {
    case "pt-setup": openSetup(); return true;
    case "pt-new": openRecord(); return true;
    case "pt-open": openTxn(id, el.dataset.focus); return true;
    case "pt-edit": openEdit(id); return true;
    case "pt-history": { historyFor = id; const r = await loadAudit(id); if (r.error) toastError(r.error); rerenderSheet(); return true; }
    case "pt-load-audit": { const r = await loadAudit(state.route.a); if (r.error) toastError(r.error); historyFor = state.route.a; rerender(); return true; }
    case "pt-verify": { const s = el.dataset.s, t = ptxnById(id);
      const reason = await dialog({ title: `${s === "verified" ? "Mark verified" : s === "disputed" ? "Dispute" : "Mark unverified"} — ${t.txn_no}`, text: "Say what you checked (kept in the audit trail).", input: { label: "Reason", required: true }, confirm: "Save" });
      if (!reason) return true;
      const r = await partnerUpdate(id, { recon_status: s }, reason); if (r.error) return toastError(err(r.error)), true;
      await refresh(); rerenderSheet(); toast(RECON_LABEL[s]); return true; }
    case "pt-reverse": { const t = ptxnById(id);
      const reason = await dialog({ title: `Reverse ${t.txn_no}?`, text: `This posts an opposite entry${t.mirror_journal_id ? " in both books" : ""}, linked to the original, which stays on record. ${money(t.amount, t.currency)} will ${t.direction === "increase" ? "no longer be owed" : "be owed again"}.`,
        input: { label: "Reason", required: true }, confirm: "Reverse", danger: true });
      if (!reason) return true;
      const r = await partnerReverse(id, reason); if (r.error) return toastError(err(r.error)), true;
      await refresh(); rerenderSheet(); toast("Reversed"); return true; }
    case "pt-doc-open": { const d = fin.pdocs.find(x => x.id === id), win = window.open("", "_blank"); const r = await partnerDocUrl(d);
      if (r.error) { if (win) win.close(); return toastError(r.error), true; } if (win) { win.opener = null; win.location = r.data; } else location.href = r.data; return true; }
    case "pt-doc-del": { const d = fin.pdocs.find(x => x.id === id); if (!(await dialog({ title: `Remove "${d.title}"?`, text: "The removal is recorded in the audit trail.", confirm: "Remove", danger: true }))) return true;
      const r = await deletePartnerDoc(d); if (r.error) return toastError(r.error), true; rerenderSheet(); return true; }
    case "pt-doc-link": { const t = ptxnById(id);
      const url = await dialog({ title: "Link a document", text: "Paste a link to the document (e.g. a shared drive file). Only real links — leave it as Document Pending if you don't have one.", input: { label: "https://…", required: true }, confirm: "Add" });
      if (!url) return true; if (!/^https?:\/\/\S+$/i.test(url.trim())) return toastError("That isn't a web link."), true;
      const r = await addPartnerDocLink(t, val("pd-kind") || "other", url.trim().replace(/^https?:\/\//, "").slice(0, 120), url.trim());
      if (r.error) return toastError(r.error), true; rerenderSheet(); return true; }
    case "pt-sync": { const k = currentLink(curEntity()); const r = await partnerSyncMirror(k.id); if (r.error) return toastError(err(r.error)), true;
      await refresh(); toast(`${r.data} posted to your personal books`); return true; }
    case "pt-terms": { const k = currentLink(curEntity());
      const v = await dialog({ title: "Repayment terms", text: `How many days does the business have to reimburse ${partnerName(k)}? Leave empty if no terms are agreed — then nothing is shown as overdue.`, input: { label: "Days", placeholder: "e.g. 30" }, confirm: "Save" });
      if (v === null || v === undefined) return true;
      const days = String(v).trim() === "" ? null : Number(v);
      if (days !== null && !(Number.isInteger(days) && days >= 0 && days <= 3650)) return toastError("Enter a whole number of days."), true;
      const r = await setPartnerTerms(k.id, days); if (r.error) return toastError(r.error), true; await refresh(); toast(days === null ? "No terms set" : `Terms: ${days} days`); return true; }
    case "pt-xlsx": exportXlsx(el.dataset.r); return true;
    case "pt-print": window.print(); return true;
  }
  return false;
}
export async function handlePartnerChange(ev, rerender) {
  const el = ev.target, act = el.dataset.act, u = pui();
  switch (act) {
    case "pt-link": u.link = el.value; rerender(); return true;
    case "pt-type": u.type = el.value; rerender(); return true;
    case "pt-show": u.show = el.value; rerender(); return true;
    case "pt-docfilter": u.docFilter = el.value; rerender(); return true;
    case "pt-report": u.report = el.value; if (el.value === "audit") await loadAudit(state.route.a); rerender(); return true;
    case "pt-month": if (el.value) { u.month = el.value; rerender(); } return true;
    case "pr-type": draftType = el.value; rerenderSheet(); return true;
    case "pt-attach": { const f = el.files && el.files[0]; if (!f) return true; const t = ptxnById(el.dataset.id);
      const r = await uploadPartnerDoc(f, t, val("pd-kind") || "other", safeFileName); el.value = "";
      if (r.error) return toastError(r.error), true; toast("Attached"); rerenderSheet(); return true; }
  }
  return false;
}
export function handlePartnerInput(ev, keepFocus) {
  if (ev.target.dataset.act !== "pt-q") return false;
  pui().q = ev.target.value; keepFocus("pt-q"); return true;
}
export async function handlePartnerSubmit(form) {
  switch (form.id) {
    case "ptSetup": { const e = curEntity(), name = val("ps-name"); if (!name) return toastError("Enter the partner's name."), true;
      const btn = $("psSave"); busy(btn, true); const r = await partnerLinkCreate(e.id, name, val("ps-mirror") || null); busy(btn, false);
      if (r.error) return toastError(err(r.error)), true; pui().link = r.data; await refresh(); closeSheet(); toast("Partner account ready"); return true; }
    case "ptRecord": await submitRecord(); return true;
    case "ptEdit": await submitEdit(form); return true;
  }
  return false;
}
