// Capture and review for the simple money screens. Nothing is saved to your books until you press Save or Post;
// imported lines wait in a review list with their original text kept. Every save goes through fin_money_post (double entry underneath).
import { aiOn, aiCall, aiDecision } from "../assist.js";
import { esc, todayISO, fmtDate } from "../util.js";
import { state, nameOf } from "../store.js";
import { sb, run } from "../api.js";
import { ICON, $, openSheet, closeSheet, rerenderSheet, sheetHead, toast, toastError, dialog, busy } from "../ui.js";
import { safeFileName, fmtBytes } from "../insights.js";
import { money, r2, parseStatementCSV } from "../finance.js";
import { fin, loadFin, entityById, accById, partyById, accountsOf, moneyAccounts, sysAccount, canWriteFin, isFinOwner, filesOf, uploadFinFile, saveJournal, uploadPartnerDoc,
  moneyPost, moneyLinkBusiness, importAdd, importRowUpdate, importDelete, importRowsOf, saveObligation, obligationFor, addBalanceCheck } from "../finapi.js";
import { businessParties, suggest, businessAccountFor, kindNeeds, rowProblem, parseBankText, KIND_LABEL, KIND_ORDER, DEBT_KIND_LABEL, MONEY, ITEM_STATUS, CURRENCIES, toBase } from "../money.js";
import { rates } from "../views/finance.js";
import { moneyModel, groupName, debtKind, receivableItems } from "../views/money.js";

const today = () => todayISO(state.tz);
const val = id => ($(id) ? $(id).value.trim() : "");
const refresh = () => loadFin(true);
let cap = null, mf = null, rv = null, det = null;
export function moneySheetReset() { cap = null; mf = null; rv = null; det = null; }

const IN_KINDS = ["income", "business_repaid", "repayment_in", "borrowed", "transfer"], OUT_KINDS = ["spend", "paid_for_business", "debt_payment", "lent", "transfer"];
const KIND_ICON = { spend: "🛒", income: "💰", transfer: "⇄", lent: "🤝", repayment_in: "↩️", borrowed: "🏦", debt_payment: "💳", paid_for_business: "🏢", business_repaid: "🏢" };
const accName = id => (accById(id) || {}).name || "";
const biz = eid => businessParties(eid, { plinks: fin.plinks, parties: fin.parties, entities: fin.entities });
/** Businesses you can record payments for: linked to these books and you can write to their books. */
function linkedBusinesses(eid) {
  return fin.plinks.filter(k => k.mirror_entity_id === eid && canWriteFin(k.entity_id)).map(k => ({ entity_id: k.entity_id, name: (entityById(k.entity_id) || {}).name, party_id: k.mirror_party_id }));
}
const bizAccOptions = (entityId, kind, sel) => {
  const accs = accountsOf(entityId, a => a.is_active && (kind === "business_repaid" ? ["bank", "cash"].includes(a.subtype) : !MONEY.has(a.subtype) && !["income", "equity"].includes(a.type) && !["partner", "receivable", "payable"].includes(a.subtype)));
  return `<option value="">Choose…</option>` + accs.map(a => `<option value="${a.id}" ${a.id === sel ? "selected" : ""}>${esc(a.name)}</option>`).join("");
};
const accOpts = (eid, pred, sel, blank = "Choose…") => `<option value="">${blank}</option>` + accountsOf(eid, a => a.is_active && pred(a)).map(a => `<option value="${a.id}" ${a.id === sel ? "selected" : ""}>${esc(a.name)}</option>`).join("");
const partyOpts = (eid, sel) => `<option value="">Choose…</option>` + fin.parties.filter(p => p.entity_id === eid && !p.archived).map(p => `<option value="${p.id}" ${p.id === sel ? "selected" : ""}>${esc(p.name)}</option>`).join("") + `<option value="__new">+ Someone new…</option>`;
const accCcy = (id, base) => (accById(id) || {}).currency || base;
const planned = (native, ccy, base) => toBase(native, ccy, rates(), base);
const rateHint = (ccy, base) => { const k = rates()[ccy]; return k ? `your planning rate ${k} ${ccy} = 1 ${base}` : `no planning rate for ${ccy} yet (Finance → Change rates)`; };
/** Businesses you own that aren't linked to these personal books yet. */
const unlinkedBusinesses = eid => fin.entities.filter(x => x.kind === "business" && !x.archived && isFinOwner(x.id) && isFinOwner(eid) && !fin.plinks.some(k => k.entity_id === x.id && k.mirror_entity_id === eid));
const defaultMoneyAcc = eid => (moneyAccounts(eid).find(a => a.subtype === "bank") || moneyAccounts(eid)[0] || {}).id || "";
async function newParty(eid) {
  const name = await dialog({ title: "Who is it?", input: { label: "Name", required: true, placeholder: "e.g. Shahzoor, QNB" }, confirm: "Add" });
  if (!name) return null;
  const r = await run(sb.from("fin_parties").insert({ entity_id: eid, name, kind: "other" }).select().single());
  if (r.error) { toastError(r.error); return null; }
  fin.parties.push(r.data); return r.data.id;
}

/* ======================= capture ======================= */
export function openMoneyCapture(eid) {
  const e = entityById(eid); if (!e) return;
  cap = { eid, account_id: defaultMoneyAcc(eid), paste: false, working: null };
  openSheet(sh => renderCapture(sh));
}
function renderCapture(sh) {
  const e = entityById(cap.eid), ai = aiOn();
  sh.innerHTML = sheetHead("Capture", `${esc(e.name)} · you check every line before it's saved`) + `<div class="sh-body mn-capsheet">
    ${cap.working ? `<div class="banner info"><span class="spinner sm"></span> ${esc(cap.working)}</div>` : ""}
    <div class="mn-opts">
      <label class="mn-opt"><input type="file" accept="image/*" capture="environment" hidden id="mn-photo"><span class="mn-oi">📷</span><b>Snap a receipt</b><small>Opens the camera</small></label>
      <label class="mn-opt"><input type="file" accept=".csv,.xlsx,.xls,.pdf,.txt,.eml,image/*,application/pdf,text/csv" hidden id="mn-file"><span class="mn-oi">📄</span><b>Upload a statement or document</b><small>Bank statement (Excel, CSV, PDF), invoice, receipt</small></label>
      <button class="mn-opt" type="button" data-act="mn-paste"><span class="mn-oi">💬</span><b>Paste a bank SMS or email</b><small>One or many messages</small></button>
      <button class="mn-opt" type="button" data-act="mn-manual" data-entity="${cap.eid}"><span class="mn-oi">✍️</span><b>Enter it myself</b><small>Spent, received, paid for Dlusso…</small></button>
    </div>
    ${cap.paste ? `<form id="mnPaste" class="mn-pastebox"><label class="field"><span>Paste the message(s)</span><textarea class="input" id="mn-text" rows="6" placeholder="e.g. Your account XXXX1234 was debited with QAR 150.00 at LULU on 01/11/2026" autofocus></textarea></label>
      <div class="btnrow"><button class="btn primary" type="submit">Read it</button>${ai ? `<button class="btn" type="submit" data-ai="1">✨ Read with AI</button>` : ""}</div></form>` : ""}
    <label class="field"><span>Statements and bank messages are for</span><select class="input" id="mn-cap-acc">${moneyAccounts(cap.eid).map(a => `<option value="${a.id}" ${a.id === cap.account_id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label>
    <p class="hint">${ai ? "Photos and PDFs are read by the AI assistant: it sends the image or document to Anthropic and returns suggestions only." : "Excel/CSV statements and pasted SMS are read on your phone. To read photos and PDF statements, turn on the AI assistant in Settings → Integrations."}
      Lines that look like something already in your books are flagged, not added twice.</p></div>`;
}

async function processRows(raw, { source, title, rawText, reader, file, aiProposal }) {
  const e = entityById(cap.eid);
  if (!raw.length) { cap.working = null; rerenderSheet(); return toastError("No transactions with an amount were found."); }
  const accs = accountsOf(e.id), bizMap = biz(e.id);
  const history = fin.importRows.filter(r => r.entity_id === e.id && r.status === "posted").sort((a, b) => (b.posted_at || "").localeCompare(a.posted_at || ""))
    .map(r => ({ merchant: r.merchant, description: r.description, direction: r.direction, kind: r.kind, category_account_id: r.category_account_id, for_entity_id: r.for_entity_id, business_account_id: r.business_account_id }));
  for (const t of fin.ptxns) { const k = fin.plinks.find(x => x.id === t.link_id); if (k && k.mirror_entity_id === e.id && t.txn_type === "expense_funding" && t.beneficiary && t.status === "posted") history.push({ merchant: t.beneficiary, direction: "out", kind: "paid_for_business", for_entity_id: k.entity_id, business_account_id: t.account_id }); }
  const businesses = [...bizMap.values()].filter(b => b.name).map(b => ({ entity_id: b.entity_id, name: b.name, keywords: [b.name.split(/\s+/)[0]] }));
  const bizAccounts = Object.fromEntries(businesses.map(b => [b.entity_id, accountsOf(b.entity_id)]));
  const cards = moneyAccounts(e.id).filter(a => a.subtype === "card");
  const rows = raw.map(r => {
    const acc = r.card_last4 && cards.find(c => c.name.includes(r.card_last4)) ? cards.find(c => c.name.includes(r.card_last4)).id : (r.account_id || cap.account_id);
    const base = { txn_date: r.txn_date, amount: r2(r.amount), direction: r.direction, currency: r.currency || accCcy(acc, e.base_currency), description: (r.description || r.merchant || "Transaction").slice(0, 300), merchant: r.merchant || null, account_id: acc };
    const hist = suggest({ ...base }, { accounts: accs, history, businesses: [], bizAccounts: {} });
    let s = hist.confidence === "high" && history.length ? hist : null; // your own history wins
    if (!s && r.kind) s = { kind: r.kind, category_account_id: r.category_account_id || null, for_entity_id: r.for_entity_id || null, business_account_id: r.business_account_id || null, confidence: r.confidence || "medium", review_reason: r.note || null };
    if (!s) s = suggest(base, { accounts: accs, history: [], businesses, bizAccounts });
    if (s.kind === "paid_for_business" && !s.business_account_id && s.for_entity_id) s.business_account_id = businessAccountFor(base.description + " " + (base.merchant || ""), bizAccounts[s.for_entity_id] || []);
    const reasons = [s.review_reason, base.currency !== e.base_currency && accCcy(acc, e.base_currency) === e.base_currency ? `In ${base.currency} from your ${e.base_currency} account — put in the ${e.base_currency} that actually left or arrived` : null, r.date_found === false ? "No date in the message — check it" : null].filter(Boolean);
    return { ...base, ...s, confidence: reasons.length && s.confidence === "high" ? "medium" : s.confidence, review_reason: reasons.join(" · ").slice(0, 300) || null, raw: r.raw ? { text: String(r.raw).slice(0, 500) } : null };
  });
  const res = await importAdd(e.id, source, title, rawText, cap.account_id, reader, rows);
  if (res.error) { cap.working = null; rerenderSheet(); return toastError(res.error); }
  const importId = res.data;
  if (file) { const u = await uploadFinFile(file, e.id, { import_id: importId }, safeFileName); if (u.error) toastError("Saved the lines, but the file couldn't be attached: " + (u.error.message || u.error)); }
  if (aiProposal) aiDecision(aiProposal, "accepted", "imported for review");
  await refresh();
  closeSheet(); openReview(importId);
}

async function readText(text, useAi) {
  const e = entityById(cap.eid);
  const source = /^(from|subject|to):/im.test(text) || text.length > 700 ? "email" : "sms";
  const title = `${source === "email" ? "Bank email" : "Bank SMS"} · ${fmtDate(today())}`;
  if (!useAi) {
    const rows = parseBankText(text, today());
    if (rows.length) return processRows(rows, { source, title, rawText: text, reader: "rules" });
    if (!aiOn()) return toastError("Couldn't find an amount with a debit/credit in that text. Paste the full message, or enter it yourself.");
  }
  cap.working = "Reading it…"; rerenderSheet();
  const r = await aiCall("extract_money", aiInput(e, { text, kind: source }), { type: "fin_import" });
  if (r.error) { cap.working = null; rerenderSheet(); return toastError(r.error); }
  return processRows(r.data.transactions || [], { source, title, rawText: text, reader: "ai", aiProposal: r.data.proposal_id });
}
function aiInput(e, extra) {
  const accs = accountsOf(e.id, a => a.is_active).map(a => ({ id: a.id, name: a.name, type: a.type, subtype: a.subtype }));
  const businesses = linkedBusinesses(e.id).map(b => ({ id: b.entity_id, name: b.name }));
  return { ...extra, accounts: accs, businesses, base: e.base_currency, today: today() };
}
async function readFile(file, isPhoto) {
  const e = entityById(cap.eid), name = file.name || "upload", ext = (name.split(".").pop() || "").toLowerCase();
  if (file.size > 20 * 1024 * 1024) return toastError("Files can be up to 20 MB.");
  try {
    if (ext === "csv" || file.type === "text/csv") {
      const p = parseStatementCSV(await file.text());
      if (!p.rows.length) return toastError(p.errors[0] || "Couldn't read that CSV.");
      return processRows(p.rows.map(r => ({ txn_date: r.line_date, amount: Math.abs(r.amount), direction: r.amount > 0 ? "in" : "out", description: r.description, raw: [r.line_date, r.description, r.amount, r.reference].join(" | ") })),
        { source: "statement", title: name, reader: "csv", file });
    }
    if (["xlsx", "xls"].includes(ext)) {
      cap.working = "Opening the spreadsheet…"; rerenderSheet();
      const csv = await excelToCSV(file);
      const p = parseStatementCSV(csv);
      if (p.rows.length) return processRows(p.rows.map(r => ({ txn_date: r.line_date, amount: Math.abs(r.amount), direction: r.amount > 0 ? "in" : "out", description: r.description, raw: [r.line_date, r.description, r.amount, r.reference].join(" | ") })),
        { source: "statement", title: name, reader: "csv", file });
      if (!aiOn()) { cap.working = null; rerenderSheet(); return toastError(p.errors[0] || "Couldn't find Date and Amount columns in that spreadsheet."); }
      cap.working = "Reading the statement…"; rerenderSheet();
      const r = await aiCall("extract_money", aiInput(e, { text: csv.slice(0, 60000), kind: "statement" }), { type: "fin_import" });
      if (r.error) { cap.working = null; rerenderSheet(); return toastError(r.error); }
      return processRows(r.data.transactions || [], { source: "statement", title: name, reader: "ai", file, aiProposal: r.data.proposal_id });
    }
    if (["txt", "eml"].includes(ext)) return readText(await file.text(), false);
    const isImg = (file.type || "").startsWith("image/"), isPdf = ext === "pdf" || file.type === "application/pdf";
    if (!isImg && !isPdf) return toastError("Upload an Excel, CSV or PDF statement, or a photo.");
    if (!aiOn()) {
      if (isImg) { closeSheet(); return openManual(e.id, { file, note: "The photo is attached. Fill in the amount and what it was for — or turn on the AI assistant to read photos for you." }); }
      return toastError("PDF statements are read by the AI assistant (Settings → Integrations). Or download the statement from your bank app as Excel or CSV.");
    }
    cap.working = isPdf ? "Reading the PDF…" : "Reading the photo…"; rerenderSheet();
    const doc = isImg ? await imageToJpeg(file) : { media_type: "application/pdf", data: await toBase64(file) };
    if (doc.data.length > 14 * 1024 * 1024) { cap.working = null; rerenderSheet(); return toastError("That document is too large to read. Try a smaller PDF or a clearer photo."); }
    const r = await aiCall("extract_money", aiInput(e, { file: doc, kind: isPhoto || isImg ? "receipt" : "statement" }), { type: "fin_import" });
    if (r.error) { cap.working = null; rerenderSheet(); if (isImg) { closeSheet(); return openManual(e.id, { file, note: `Couldn't read it automatically (${r.error}). The photo is attached — fill in the details.` }); } return toastError(r.error); }
    const tx = r.data.transactions || [];
    if (isImg && tx.length === 1) { closeSheet(); aiDecision(r.data.proposal_id, "accepted", "receipt to form"); return openManual(e.id, { file, fromAi: tx[0] }); }
    return processRows(tx, { source: isImg ? "receipt" : "statement", title: name, reader: "ai", file, aiProposal: r.data.proposal_id });
  } catch (err) { cap.working = null; rerenderSheet(); toastError("Couldn't read that file: " + (err.message || err)); }
}
const toBase64 = file => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = rej; fr.readAsDataURL(file); });
async function imageToJpeg(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, 1800 / Math.max(img.width, img.height)), c = document.createElement("canvas");
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return { media_type: "image/jpeg", data: c.toDataURL("image/jpeg", 0.85).split(",")[1] };
  } finally { URL.revokeObjectURL(url); }
}
let xlsxLib = null;
async function excelToCSV(file) {
  if (!xlsxLib) xlsxLib = new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"; s.onload = () => res(window.XLSX); s.onerror = () => rej(new Error("couldn't load the spreadsheet reader")); document.head.appendChild(s); });
  const X = await xlsxLib, wb = X.read(await file.arrayBuffer(), { type: "array", cellDates: false });
  // the sheet with the most rows is the statement
  const best = wb.SheetNames.map(n => wb.Sheets[n]).sort((a, b) => (X.utils.sheet_to_csv(b).length) - (X.utils.sheet_to_csv(a).length))[0];
  return X.utils.sheet_to_csv(best, { FS: ",", blankrows: false, rawNumbers: false });
}

/* ======================= enter it myself ======================= */
export function openManual(eid, preset = {}) {
  const e = entityById(eid); if (!e) return;
  const bz = linkedBusinesses(eid);
  const a = preset.fromAi || {};
  const foreign = a.currency && a.currency !== e.base_currency;
  mf = { eid, kind: preset.kind || a.kind || "spend", txn_date: a.txn_date || today(), amount: foreign ? "" : (a.amount || ""), native: foreign ? a.amount : "", baseTouched: false,
    account_id: preset.account_id || defaultMoneyAcc(eid), category_account_id: preset.category_account_id || a.category_account_id || "",
    party_id: preset.party_id || "", for_entity_id: preset.for_entity_id || a.for_entity_id || (bz[0] || {}).entity_id || "", business_account_id: preset.business_account_id || a.business_account_id || "", interest: "",
    description: preset.description || a.description || "", merchant: a.merchant || "", reference: "", file: preset.file || null, note: preset.note || (preset.fromAi ? "Read from the photo — check the details before saving." : null),
    currency: a.currency || e.base_currency, toNative: "", bizAmount: "" };
  if (foreign && mf.native) mf.amount = planned(mf.native, mf.currency, e.base_currency) ?? "";
  if (mf.kind === "paid_for_business" && !mf.business_account_id && mf.for_entity_id) mf.business_account_id = businessAccountFor(mf.description + " " + mf.merchant, accountsOf(mf.for_entity_id)) || "";
  if (!mf.category_account_id && !kindNeeds(mf.kind).business) mf.category_account_id = suggest({ description: mf.description, merchant: mf.merchant, direction: IN_KINDS.includes(mf.kind) && mf.kind !== "transfer" ? "in" : "out" }, { accounts: accountsOf(eid) }).category_account_id || "";
  openSheet(sh => renderManual(sh));
}
/** What the currency fields look like for the current form state. */
function manualCcy(e) {
  const base = e.base_currency, ac = accCcy(mf.account_id, base);
  if (ac !== base) mf.currency = ac;
  const foreign = mf.currency !== base;
  const cat = accById(mf.category_account_id), catCcy = cat ? (cat.currency || base) : base;
  const toForeign = mf.kind === "transfer" && cat && catCcy !== mf.currency && catCcy !== base;
  const bizE = kindNeeds(mf.kind).business && entityById(mf.for_entity_id), bc = bizE ? bizE.base_currency : base;
  const needBiz = !!bizE && bc !== base && bc !== mf.currency;
  return { base, ac, foreign, lockCcy: ac !== base, cat, catCcy, toForeign, bc, needBiz, fromBaseAcc: ac === base };
}
function renderManual(sh) {
  const e = entityById(mf.eid), n = kindNeeds(mf.kind), bz = linkedBusinesses(mf.eid), cx = manualCcy(e), unlinked = n.business ? unlinkedBusinesses(mf.eid) : [];
  const moneyOpts = moneyAccounts(mf.eid).filter(a => n.moneyCard || a.subtype !== "card");
  const ccyOpts = [...new Set([cx.base, ...Object.keys(rates()).filter(k => k !== "base"), ...CURRENCIES])];
  const baseLabel = mf.kind === "transfer" && cx.foreign && cx.catCcy === cx.base ? `${cx.base} received` : cx.fromBaseAcc ? `${cx.base} that left your account` : `${cx.base} equivalent`;
  sh.innerHTML = sheetHead("Enter it myself", `${esc(e.name)} · reports in ${e.base_currency}`) + `<form id="mnManual" class="sh-body" novalidate>
    ${mf.note ? `<div class="banner info">${esc(mf.note)}</div>` : ""}
    <div class="mn-kinds-pick" role="radiogroup">${KIND_ORDER.map(k => `<button type="button" class="chip-btn ${mf.kind === k ? "on" : ""}" data-act="mn-kind" data-kind="${k}">${KIND_ICON[k]} ${KIND_LABEL[k]}</button>`).join("")}</div>
    <div class="mn-amtrow">
      <label class="field mn-ccy"><span>Currency</span><select class="input" id="mm-ccy" ${cx.lockCcy ? "disabled" : ""}>${ccyOpts.map(c => `<option ${c === mf.currency ? "selected" : ""}>${c}</option>`).join("")}</select></label>
      ${cx.foreign ? `<label class="field"><span>Amount (${mf.currency})</span><input class="input num mn-bigamt" type="number" step="0.01" min="0.01" inputmode="decimal" id="mm-native" value="${esc(mf.native)}" ${mf.native ? "" : "autofocus"}></label>`
        : `<label class="field"><span>Amount (${cx.base})</span><input class="input num mn-bigamt" type="number" step="0.01" min="0.01" inputmode="decimal" id="mm-amount" value="${esc(mf.amount)}" ${mf.amount ? "" : "autofocus"}></label>`}
      <label class="field"><span>Date</span><input class="input" type="date" id="mm-date" value="${esc(mf.txn_date)}"></label></div>
    ${cx.foreign ? `<label class="field"><span>${baseLabel}</span><input class="input num" type="number" step="0.01" min="0.01" inputmode="decimal" id="mm-amount" value="${esc(mf.amount)}"></label>
      <p class="hint" id="mm-ratehint">${mf.baseTouched ? `Using your figure (rate ${mf.native && mf.amount ? (Number(mf.native) / Number(mf.amount)).toFixed(4) : "—"}).` : `Filled from ${rateHint(mf.currency, cx.base)}${cx.fromBaseAcc ? " — change it to what your bank actually took" : ""}.`}</p>` : ""}
    ${cx.toForeign ? `<label class="field"><span>Arrived in ${esc(cx.cat.name)} (${cx.catCcy})</span><input class="input num" type="number" step="0.01" min="0.01" id="mm-tonative" value="${esc(mf.toNative)}"></label>` : ""}
    <label class="field"><span>${mf.kind === "paid_for_business" ? "What was it?" : "Description"}</span><input class="input" id="mm-desc" value="${esc(mf.description)}" placeholder="${mf.kind === "paid_for_business" ? "e.g. Topaz fabric 10 m" : mf.kind === "income" ? "e.g. November salary" : "e.g. Weekly shopping"}"></label>
    <div class="grid2">
      <label class="field"><span>${n.money}</span><select class="input" id="mm-acc">${moneyOpts.map(a => `<option value="${a.id}" ${a.id === mf.account_id ? "selected" : ""}>${esc(a.name)}${a.currency ? ` (${a.currency})` : ""}</option>`).join("")}</select></label>
      ${n.business ? `<label class="field"><span>Business</span><select class="input" id="mm-biz">${bz.length ? bz.map(b => `<option value="${b.entity_id}" ${b.entity_id === mf.for_entity_id ? "selected" : ""}>${esc(b.name)} (${(entityById(b.entity_id) || {}).base_currency})</option>`).join("") : `<option value="">No linked business</option>`}</select></label>`
        : `<label class="field"><span>${n.category}</span><select class="input" id="mm-cat">${accOpts(mf.eid, n.catFilter, mf.category_account_id)}</select></label>`}
    </div>
    ${n.business && unlinked.length ? `<div class="btnrow">${unlinked.map(b => `<button type="button" class="btn sm" data-act="mn-link-biz" data-biz="${b.id}">${ICON.link}Link ${esc(b.name)} (${b.base_currency})</button>`).join("")}</div>` : ""}
    ${cx.needBiz ? `<label class="field"><span>Amount in ${cx.bc} <small>(as ${esc((entityById(mf.for_entity_id) || {}).name)} records it)</small></span><input class="input num" type="number" step="0.01" min="0.01" id="mm-bizamt" value="${esc(mf.bizAmount)}"></label>` : ""}
    ${n.business ? (bz.length ? `<label class="field"><span>${n.bizLabel}</span><select class="input" id="mm-bizacc">${bizAccOptions(mf.for_entity_id, mf.kind, mf.business_account_id)}</select></label>
        <p class="hint">${mf.kind === "paid_for_business" ? `Your money goes down, ${esc((entityById(mf.for_entity_id) || {}).name || "the business")} owes you more, and it's booked in the business's own books too. It isn't counted as your spending.` : "Money owed to you goes down in both books. It isn't income."}${cx.bc !== cx.base ? ` The business keeps ${cx.bc}; your books keep ${cx.base} — any exchange difference is cleared when it's fully repaid.` : ""}</p>`
      : `<p class="hint bad-text">No business is linked to these books yet${unlinked.length ? " — link one above." : ". Set up the partner account in the business's books first."}</p>`) : ""}
    ${n.party ? `<label class="field"><span>${n.party}${["lent", "repayment_in"].includes(mf.kind) ? "" : " <small>(optional)</small>"}</span><select class="input" id="mm-party">${partyOpts(mf.eid, mf.party_id)}</select></label>` : ""}
    ${n.interest ? `<label class="field"><span>Of which interest in ${cx.base} <small>(if you know it)</small></span><input class="input num" type="number" step="0.01" min="0" id="mm-int" value="${esc(mf.interest)}"></label>` : ""}
    <div class="grid2"><label class="field"><span>Shop / paid to <small>(optional)</small></span><input class="input" id="mm-merchant" value="${esc(mf.merchant)}"></label>
      <label class="field"><span>Reference <small>(optional)</small></span><input class="input" id="mm-ref" value="${esc(mf.reference)}" placeholder="Invoice / receipt no."></label></div>
    <div class="field"><span>Receipt or invoice <small>(optional)</small></span><div class="btnrow">
      <label class="btn sm filebtn">📷 Take photo<input type="file" accept="image/*" capture="environment" hidden id="mm-photo"></label>
      <label class="btn sm filebtn">${ICON.download}Choose file<input type="file" hidden id="mm-file"></label>
      ${mf.file ? `<span class="chip">📎 ${esc(mf.file.name || "photo")} <button type="button" class="linkbtn" data-act="mn-unfile">remove</button></span>` : ""}</div></div>
    <div class="sheet-foot"><button class="btn primary block" type="submit" id="mmSave">Save</button></div></form>`;
}
function syncManual() {
  if (!mf || !$("mnManual")) return;
  mf.amount = val("mm-amount"); mf.txn_date = val("mm-date"); mf.description = val("mm-desc"); mf.account_id = val("mm-acc"); mf.merchant = val("mm-merchant"); mf.reference = val("mm-ref");
  if ($("mm-ccy") && !$("mm-ccy").disabled) mf.currency = val("mm-ccy");
  if ($("mm-native")) mf.native = val("mm-native");
  if ($("mm-tonative")) mf.toNative = val("mm-tonative");
  if ($("mm-bizamt")) mf.bizAmount = val("mm-bizamt");
  if ($("mm-cat")) mf.category_account_id = val("mm-cat");
  if ($("mm-biz")) mf.for_entity_id = val("mm-biz");
  if ($("mm-bizacc")) mf.business_account_id = val("mm-bizacc");
  if ($("mm-party")) mf.party_id = val("mm-party") === "__new" ? "" : val("mm-party");
  if ($("mm-int")) mf.interest = val("mm-int");
}
async function submitManual(form) {
  syncManual();
  const e = entityById(mf.eid), cx = manualCcy(e);
  const p = { entity_id: e.id, kind: mf.kind, txn_date: mf.txn_date, amount: Number(mf.amount), account_id: mf.account_id, category_account_id: mf.category_account_id || null, party_id: mf.party_id || null,
    for_entity_id: kindNeeds(mf.kind).business ? mf.for_entity_id : null, business_account_id: kindNeeds(mf.kind).business ? mf.business_account_id : null, interest: mf.interest ? Number(mf.interest) : null,
    description: mf.description || mf.merchant, merchant: mf.merchant || null, reference: mf.reference || null };
  if (cx.foreign) {
    if (!(Number(mf.native) > 0)) return toastError(`Enter the ${mf.currency} amount.`);
    if (!(Number(mf.amount) > 0)) return toastError(`Enter the ${cx.base} amount too — ${rateHint(mf.currency, cx.base)}.`);
    Object.assign(p, { currency: mf.currency, fx_amount: Number(mf.native), rate_source: mf.baseTouched ? (cx.fromBaseAcc ? "actual" : "entered") : "planning" });
  }
  if (cx.toForeign) { if (!(Number(mf.toNative) > 0)) return toastError(`Enter how much arrived in ${cx.catCcy}.`); p.to_fx_amount = Number(mf.toNative); }
  if (cx.needBiz) { if (!(Number(mf.bizAmount) > 0)) return toastError(`Enter the ${cx.bc} amount the business records.`); p.business_amount = Number(mf.bizAmount); }
  const prob = rowProblem({ ...p, amount: cx.foreign ? mf.native : p.amount, base_amount: p.amount }, cx.base);
  if (prob) return toastError(prob);
  const btn = $("mmSave"); busy(btn, true);
  const r = await moneyPost(p);
  if (r.error) { busy(btn, false); return toastError(r.error); }
  if (mf.file) await attachAfterPost(mf.file, e.id, r.data, mf.kind);
  busy(btn, false);
  const label = KIND_LABEL[mf.kind], kind = mf.kind;
  await refresh(); closeSheet();
  toast(`Saved: ${label} ${cx.foreign ? money(p.fx_amount, p.currency) + " (" + money(p.amount, e.base_currency) + ")" : money(p.amount, e.base_currency)}${kind === "paid_for_business" ? " — added to what the business owes you" : ""}`);
}
async function attachAfterPost(file, eid, res, kind) {
  let u;
  if (res.partner_txn_id) { const t = fin.ptxns.find(x => x.id === res.partner_txn_id) || { id: res.partner_txn_id, entity_id: (fin.plinks.find(k => k.mirror_entity_id === eid && k.entity_id === mf.for_entity_id) || {}).entity_id };
    u = await uploadPartnerDoc(file, t, kind === "paid_for_business" ? "supplier_invoice" : "payment_proof", safeFileName); }
  else u = await uploadFinFile(file, eid, { journal_id: res.journal_id }, safeFileName);
  if (u && u.error) toastError("Saved, but the receipt couldn't be attached: " + (u.error.message || u.error));
}

/* ======================= review imported lines ======================= */
export function openReview(importId) {
  const imp = fin.imports.find(i => i.id === importId); if (!imp) return toastError("That import is no longer there.");
  const rows = importRowsOf(importId);
  const base = (entityById(imp.entity_id) || {}).base_currency;
  rows.forEach(r => withBase(r, base));
  rv = { importId, eid: imp.entity_id, sel: new Set(rows.filter(r => r.status === "pending" && !r.duplicate && !rowProblem(r, base)).map(r => r.id)), results: {} };
  openSheet(sh => renderReview(sh), { wide: true });
}
function renderReview(sh) {
  const imp = fin.imports.find(i => i.id === rv.importId), e = entityById(rv.eid);
  if (!imp) { sh.innerHTML = sheetHead("Review") + `<div class="sh-body"><p>This import was removed.</p></div>`; return; }
  const rows = importRowsOf(rv.importId), pend = rows.filter(r => r.status === "pending"), done = rows.filter(r => r.status !== "pending");
  const files = filesOf("import_id", imp.id);
  const nSel = pend.filter(r => rv.sel.has(r.id)).length;
  sh.innerHTML = sheetHead("Check before saving", `${esc(imp.title)} · ${pend.length} to review${done.length ? ` · ${done.length} done` : ""}`) + `<div class="sh-body mn-reviewsheet">
    ${files.length ? `<p class="hint">Original: ${files.map(f => `<button class="linkbtn" data-act="fin-file-open" data-id="${f.id}">${esc(f.title)}</button>`).join(", ")}</p>` : ""}
    ${pend.some(r => r.duplicate) ? `<div class="banner warn">Lines marked <b>Possible duplicate</b> look like something already in your books or already imported. They're unticked — skip them unless you're sure they're new.</div>` : ""}
    ${pend.length ? `<div class="mn-rvbar"><label class="chk"><input type="checkbox" data-act="mn-rv-all" ${nSel === pend.length ? "checked" : ""}> Select all</label><span class="hint">${nSel} selected</span></div>
    <div class="mn-rvlist">${pend.map(r => reviewRow(e, r)).join("")}</div>
    <div class="sheet-foot mn-rvfoot"><button class="btn primary" data-act="mn-rv-post" ${nSel ? "" : "disabled"}>Save ${nSel} to my books</button><button class="btn" data-act="mn-rv-skip" ${nSel ? "" : "disabled"}>Skip ${nSel}</button>
      ${!done.some(r => r.status === "posted") ? `<button class="btn ghost" data-act="mn-rv-delete">Discard this import</button>` : ""}</div>`
    : `<div class="banner ok">${ICON.done} Everything here is done.</div>`}
    ${done.length ? `<details class="mn-settled" ${pend.length ? "" : "open"}><summary>Done (${done.length})</summary><div class="list compact">${done.map(r => `<div class="trow ${r.status === "skipped" ? "muted" : ""}" ${r.journal_id ? `data-act="fin-open-journal" data-id="${r.journal_id}" role="button" tabindex="0"` : ""}>
      <div class="tmain"><div class="ttitle">${esc(r.description)}</div><div class="tmeta">${r.txn_date ? fmtDate(r.txn_date) : ""} · ${r.status === "posted" ? `saved as ${esc(KIND_LABEL[r.kind] || "")}` : "skipped"}</div></div>
      <div class="tside"><b class="num mn-amt ${r.direction}">${r.direction === "in" ? "+" : "−"}${money(r.amount, e.base_currency)}</b>${r.status === "skipped" ? `<button class="btn sm" data-act="mn-rv-unskip" data-id="${r.id}">Restore</button>` : ""}</div></div>`).join("")}</div></details>` : ""}
  </div>`;
}
/** Foreign lines get a planning-rate base amount to start with (shown, flagged, editable); nothing is saved until changed or posted. */
function withBase(r, base) {
  if (r.currency && r.currency !== base && r.base_amount == null && r.status === "pending") { const b = planned(r.amount, r.currency, base); if (b) { r.base_amount = b; r.rate_source = r.rate_source || "planning"; r._planned = true; } }
  return r;
}
function reviewRow(e, r) {
  withBase(r, e.base_currency);
  const n = kindNeeds(r.kind), kinds = r.direction === "in" ? IN_KINDS : OUT_KINDS, bz = linkedBusinesses(e.id), prob = rowProblem(r, e.base_currency), err = rv.results[r.id];
  const foreign = r.currency && r.currency !== e.base_currency, bizE = n.business && entityById(r.for_entity_id), needBiz = bizE && bizE.base_currency !== e.base_currency && bizE.base_currency !== r.currency;
  const dupLine = r.duplicate_line_id && fin.lines.find(l => l.id === r.duplicate_line_id), dupJ = dupLine && fin.journals.find(j => j.id === dupLine.journal_id);
  const f = (field, html) => `<label class="field sm"><span>${field}</span>${html}</label>`;
  const sel = (id, opts) => `<select class="input sm" data-rv="${id}" data-row="${r.id}">${opts}</select>`;
  return `<div class="mn-rv ${r.duplicate ? "dup" : ""} ${r.confidence === "low" ? "low" : ""} ${r.kind === "paid_for_business" || r.kind === "business_repaid" ? "biz" : ""}">
    <label class="mn-rvsel"><input type="checkbox" data-act="mn-rv-sel" data-id="${r.id}" ${rv.sel.has(r.id) ? "checked" : ""} aria-label="Select"></label>
    <div class="mn-rvmain">
      <div class="mn-rvtop"><b>${esc(r.description)}</b><b class="num mn-amt ${r.direction}">${r.direction === "in" ? "+" : "−"}${money(r.amount, r.currency || e.base_currency)}</b></div>
      <div class="tmeta">${r.txn_date ? fmtDate(r.txn_date, { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "no date"}${r.merchant && r.merchant !== r.description ? ` · ${esc(r.merchant)}` : ""} · ${esc(accName(r.account_id) || "no account")}${r.confidence !== "high" ? ` · <span class="hint">${r.confidence} confidence</span>` : ""}</div>
      ${r.duplicate ? `<p class="mn-flag dup">Possible duplicate: ${r.duplicate === "imported" ? "the same line was imported before" : `already in your books${dupJ ? ` (#${dupJ.number} ${esc(dupJ.memo)} on ${fmtDate(dupJ.entry_date)})` : ""}`}</p>` : ""}
      ${r.review_reason ? `<p class="mn-flag">${esc(r.review_reason)}</p>` : ""}
      ${err ? `<p class="mn-flag bad">${esc(err)}</p>` : ""}
      <div class="mn-rvfields">
        ${f("What was it", sel("kind", kinds.map(k => `<option value="${k}" ${k === r.kind ? "selected" : ""}>${KIND_LABEL[k]}</option>`).join("")))}
        ${n.business ? f("Business", sel("for_entity_id", `<option value="">Choose…</option>` + bz.map(b => `<option value="${b.entity_id}" ${b.entity_id === r.for_entity_id ? "selected" : ""}>${esc(b.name)}</option>`).join("")))
            + (r.for_entity_id ? f(n.bizLabel, sel("business_account_id", bizAccOptions(r.for_entity_id, r.kind, r.business_account_id))) : "")
          : f(r.kind === "transfer" ? (r.direction === "in" ? "Moved from" : "Moved to") : n.category, sel("category_account_id", accOpts(e.id, n.catFilter, r.category_account_id)))}
        ${n.party ? f(n.party, sel("party_id", partyOpts(e.id, r.party_id))) : ""}
        ${n.interest ? f("Interest", `<input class="input sm num" type="number" step="0.01" min="0" data-rv="interest" data-row="${r.id}" value="${r.interest ?? ""}">`) : ""}
        ${f(r.direction === "in" ? "Into" : "From", sel("account_id", accOpts(e.id, a => MONEY.has(a.subtype), r.account_id)))}
        ${f("Date", `<input class="input sm" type="date" data-rv="txn_date" data-row="${r.id}" value="${r.txn_date || ""}">`)}
        ${f(`Amount (${r.currency || e.base_currency})`, `<input class="input sm num" type="number" step="0.01" min="0.01" data-rv="amount" data-row="${r.id}" value="${r.amount}">`)}
        ${foreign ? f(`${e.base_currency} ${accCcy(r.account_id, e.base_currency) === e.base_currency ? "that left / arrived" : "equivalent"}${r.rate_source === "planning" ? " · planning rate" : ""}`, `<input class="input sm num" type="number" step="0.01" min="0.01" data-rv="base_amount" data-row="${r.id}" value="${r.base_amount ?? ""}">`) : ""}
        ${needBiz ? f(`Amount in ${bizE.base_currency} (business)`, `<input class="input sm num" type="number" step="0.01" min="0.01" data-rv="_bizamt" data-row="${r.id}" value="${r._bizamt ?? ""}">`) : ""}
      </div>
      ${prob ? `<p class="hint">Still needed: ${esc(prob)}</p>` : ""}
    </div></div>`;
}
async function reviewField(el) {
  const r = fin.importRows.find(x => x.id === el.dataset.row); if (!r) return;
  let v = el.value, field = el.dataset.rv;
  if (field === "party_id" && v === "__new") { v = await newParty(rv.eid); if (!v) { rerenderSheet(); return; } }
  if (field === "_bizamt") { r._bizamt = Number(v) || null; rerenderSheet(); return; } // used when posting only
  const patch = { [field]: v === "" ? null : (["amount", "interest", "base_amount"].includes(field) ? Number(v) : v) };
  const base = entityById(rv.eid).base_currency;
  if (field === "base_amount") { patch.rate_source = accCcy(r.account_id, base) === base ? "actual" : "entered"; delete r._planned; }
  if (field === "amount" && r.currency && r.currency !== base && (r._planned || r.rate_source === "planning")) { patch.base_amount = planned(Number(v), r.currency, base); patch.rate_source = "planning"; }
  if (field === "kind") { patch.category_account_id = null; patch.for_entity_id = null; patch.business_account_id = null;
    const e = entityById(rv.eid), s = suggest({ ...r, kind: v }, { accounts: accountsOf(e.id) });
    if (v === r.kind) delete patch.category_account_id;
    if (["paid_for_business", "business_repaid"].includes(v)) { const b = linkedBusinesses(e.id)[0]; if (b) { patch.for_entity_id = b.entity_id; patch.business_account_id = v === "paid_for_business" ? businessAccountFor(r.description + " " + (r.merchant || ""), accountsOf(b.entity_id)) : (accountsOf(b.entity_id, a => a.subtype === "bank")[0] || {}).id || null; } }
    else if (s.kind === v) patch.category_account_id = s.category_account_id;
    else if (v === "transfer") patch.category_account_id = null; }
  if (field === "for_entity_id" && v) patch.business_account_id = r.kind === "paid_for_business" ? businessAccountFor(r.description + " " + (r.merchant || ""), accountsOf(v)) : (accountsOf(v, a => a.subtype === "bank")[0] || {}).id || null;
  Object.assign(r, patch); delete rv.results[r.id];
  if (!rowProblem(r, base) && !r.duplicate) rv.sel.add(r.id);
  rerenderSheet();
  const u = await importRowUpdate(r.id, patch);
  if (u.error) toastError(u.error);
}
async function postSelected(btn) {
  const e = entityById(rv.eid), rows = importRowsOf(rv.importId).filter(r => r.status === "pending" && rv.sel.has(r.id));
  const blocked = rows.filter(r => rowProblem(r, e.base_currency));
  if (blocked.length) { blocked.forEach(r => rv.results[r.id] = rowProblem(r, e.base_currency)); rerenderSheet(); return toastError(`${blocked.length} line${blocked.length > 1 ? "s need" : " needs"} more detail first.`); }
  busy(btn, true, `Saving 0 of ${rows.length}…`);
  let ok = 0;
  for (const r of rows) {
    // money that came in on a transfer: the other account is where it came from
    const swap = r.kind === "transfer" && r.direction === "in";
    const foreign = r.currency && r.currency !== e.base_currency;
    const p = { entity_id: e.id, kind: r.kind, txn_date: r.txn_date, amount: Number(foreign ? r.base_amount : r.amount), account_id: swap ? r.category_account_id : r.account_id, category_account_id: swap ? r.account_id : r.category_account_id,
      party_id: r.party_id, for_entity_id: r.for_entity_id, business_account_id: r.business_account_id, interest: r.interest, description: r.description, merchant: r.merchant, import_row_id: r.id,
      currency: foreign ? r.currency : null, fx_amount: foreign ? Number(r.amount) : null, rate_source: foreign ? (r.rate_source || "planning") : null, business_amount: r._bizamt || null };
    const res = await moneyPost(p);
    if (res.error) rv.results[r.id] = String(res.error.message || res.error).replace(/^[a-z_]+: /, ""); else { ok++; rv.sel.delete(r.id); }
    btn.textContent = `Saving ${ok} of ${rows.length}…`;
  }
  await refresh(); rerenderSheet();
  const failed = rows.length - ok;
  if (failed) toastError(`${ok} saved, ${failed} need${failed > 1 ? "" : "s"} attention.`); else toast(`${ok} saved to your books`);
}
async function skipSelected() {
  const ids = [...rv.sel];
  const r = await run(sb.from("fin_import_rows").update({ status: "skipped" }).in("id", ids));
  if (r.error) return toastError(r.error);
  rv.sel.clear(); await refresh(); rerenderSheet(); toast(`${ids.length} skipped`);
}

/* ======================= owed to me: one person or business ======================= */
function findGroup(eid, key, side) { const m = moneyModel(entityById(eid)); return { m, g: (side === "owed" ? m.owed : m.owe).find(x => x.key === key) }; }
export function openOwed(eid, key) { det = { eid, key, side: "owed" }; openSheet(sh => renderOwed(sh), { wide: true }); }
function itemDocs(j) {
  const fs = filesOf("journal_id", j.id).map(f => ({ title: f.title, act: "fin-file-open", id: f.id }));
  const ps = j.source === "partner" ? fin.pdocs.filter(d => d.txn_id === j.source_id).map(d => ({ title: d.title, act: "pt-doc-open", id: d.id })) : [];
  return [...fs, ...ps];
}
function renderOwed(sh) {
  const e = entityById(det.eid), { m, g } = findGroup(det.eid, det.key, "owed");
  if (!g) { sh.innerHTML = sheetHead("Owed to me") + `<div class="sh-body"><p>Nothing found.</p></div>`; return; }
  const b = m.biz.get(g.party_id), r = receivableItems(g.lines), o = obligationFor(g.account.id, g.party_id), w = canWriteFin(e.id);
  const orig = r2(r.items.reduce((s, i) => s + i.original, 0)), back = r2(r.repayments.reduce((s, x) => s + x.amount, 0));
  const link = b && b.link, terms = link && link.terms_days;
  sh.innerHTML = sheetHead(groupName(g), `${b ? "Your business · " : ""}${esc(g.account.name)}`) + `<div class="sh-body">
    <div class="mn-cards sm"><div class="mn-card"><span class="mn-l">${b ? "Paid by me" : "Lent / paid"}</span><span class="mn-n num">${money(orig, e.base_currency)}</span></div>
      <div class="mn-card in"><span class="mn-l">Paid back</span><span class="mn-n num">${money(back, e.base_currency)}</span></div>
      <div class="mn-card ${g.balance > 0 ? "biz" : ""}"><span class="mn-l">Still owed to me</span><span class="mn-n num">${money(g.balance, e.base_currency)}</span></div></div>
    ${w ? `<div class="btnrow"><button class="btn primary" data-act="mn-owed-repaid">${ICON.plus}Record a repayment</button><button class="btn" data-act="mn-owed-more">${ICON.plus}${b ? "I paid for it again" : "Lent more"}</button><button class="btn" data-act="mn-owed-print">Print / share statement</button></div>` : `<div class="btnrow"><button class="btn" data-act="mn-owed-print">Print / share statement</button></div>`}
    <form id="mnOwedMeta" class="mn-meta"><label class="field sm"><span>Expected back by</span><input class="input sm" type="date" id="mo-exp" value="${o && o.expected_date || ""}" ${w ? "" : "disabled"}></label>
      ${terms ? `<span class="hint">Business terms: ${terms} days</span>` : ""}
      <label class="field sm grow"><span>Note</span><input class="input sm" id="mo-notes" value="${esc(o && o.notes || "")}" ${w ? "" : "disabled"} placeholder="e.g. Agreed to repay after the Riyad order"></label>${w ? `<button class="btn sm" type="submit">Save</button>` : ""}</form>
    <h3 class="mn-h3">Item by item</h3>
    <p class="hint">Repayments are applied to the oldest items first.</p>
    <div class="mn-items">${r.items.slice().reverse().map(it => { const j = it.line.journal, docs = itemDocs(j);
      return `<div class="mn-item ${it.status}"><div class="mn-itop"><div><b>${esc(j.memo)}</b><div class="tmeta">${fmtDate(it.date, { day: "numeric", month: "short", year: "numeric" })} · #${j.number}${j.reference ? " · " + esc(j.reference) : ""}</div></div>
        <span class="pill inv-${it.status === "paid" ? "paid" : it.status === "part" ? "partial" : "unpaid"}">${ITEM_STATUS[it.status]}</span></div>
        <div class="mn-inums"><span>Amount <b class="num">${money(it.original, e.base_currency)}</b></span><span>Paid back <b class="num">${money(it.received, e.base_currency)}</b></span><span>Outstanding <b class="num">${money(it.outstanding, e.base_currency)}</b></span></div>
        <div class="mn-idocs">${docs.map(d => `<button class="linkbtn" data-act="${d.act}" data-id="${d.id}">📎 ${esc(d.title)}</button>`).join("") || `<span class="hint">No receipt</span>`}
          ${w ? `<label class="btn sm filebtn">📷 Add receipt<input type="file" accept="image/*,application/pdf" hidden data-act="mn-attach" data-journal="${j.id}"></label>` : ""}
          <button class="linkbtn" data-act="fin-open-journal" data-id="${j.id}">Details</button></div></div>`; }).join("") || `<p class="calm">No items.</p>`}</div>
    ${r.repayments.length ? `<h3 class="mn-h3">Repayments</h3><div class="list compact">${r.repayments.slice().reverse().map(x => `<div class="trow" data-act="fin-open-journal" data-id="${x.line.journal_id}" role="button" tabindex="0"><div class="tmain"><div class="ttitle">${esc(x.line.journal.memo)}</div><div class="tmeta">${fmtDate(x.date)}</div></div><div class="tside"><b class="num ok-text">+${money(x.amount, e.base_currency)}</b></div></div>`).join("")}</div>` : ""}
    ${o ? docsBlock(e, o) : ""}
  </div>`;
}
function docsBlock(e, o) {
  const fs = filesOf("obligation_id", o.id), w = canWriteFin(e.id);
  return `<h3 class="mn-h3">Supporting documents</h3><div class="mn-idocs">${fs.map(f => `<span class="chip">📎 <button class="linkbtn" data-act="fin-file-open" data-id="${f.id}">${esc(f.title)}</button> <small>${fmtBytes(f.size_bytes || 0)}</small>${w ? ` <button class="iconbtn sm" data-act="fin-file-del" data-id="${f.id}" aria-label="Remove">${ICON.trash}</button>` : ""}</span>`).join("") || `<span class="hint">None yet</span>`}
    ${w ? `<label class="btn sm filebtn">📷 Add document<input type="file" accept="image/*,application/pdf" hidden data-act="mn-attach-obl" data-id="${o.id}"></label>` : ""}</div>`;
}
function printOwed() {
  const e = entityById(det.eid), { m, g } = findGroup(det.eid, det.key, "owed"); if (!g) return;
  const r = receivableItems(g.lines), w = window.open("", "_blank");
  if (!w) return toastError("Allow pop-ups to print the statement.");
  const rows = r.items.map(it => { const j = it.line.journal, docs = itemDocs(j);
    return `<tr><td>${fmtDate(it.date, { day: "numeric", month: "short", year: "numeric" })}</td><td>${esc(j.memo)}${j.reference ? `<br><small>${esc(j.reference)}</small>` : ""}</td><td class="n">${money(it.original)}</td><td class="n">${money(it.received)}</td><td class="n">${money(it.outstanding)}</td><td>${ITEM_STATUS[it.status]}</td><td><small>${docs.map(d => esc(d.title)).join("<br>") || "—"}</small></td></tr>`; }).join("");
  w.document.write(`<!doctype html><meta charset="utf-8"><title>Statement — ${esc(groupName(g))}</title><style>body{font:13px system-ui,sans-serif;margin:32px;color:#1b1a19}h1{font-size:20px;margin:0}p{color:#555}table{border-collapse:collapse;width:100%;margin-top:16px}th,td{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}.n{text-align:right;font-variant-numeric:tabular-nums}tfoot td{font-weight:700;border-top:2px solid #1b1a19}</style>
    <h1>Statement of amounts owed — ${esc(groupName(g))}</h1><p>From ${esc(nameOf(state.user.id))} · ${esc(e.name)} · ${e.base_currency} · as of ${fmtDate(today(), { day: "numeric", month: "long", year: "numeric" })}</p>
    <table><thead><tr><th>Date</th><th>Description</th><th class="n">Amount</th><th class="n">Paid back</th><th class="n">Outstanding</th><th>Status</th><th>Supporting document</th></tr></thead><tbody>${rows}</tbody>
    <tfoot><tr><td colspan="2">Total</td><td class="n">${money(r.items.reduce((s, i) => s + i.original, 0))}</td><td class="n">${money(r.items.reduce((s, i) => s + i.received, 0))}</td><td class="n">${money(g.balance)}</td><td colspan="2"></td></tr></tfoot></table>
    <p>Repayments are applied to the oldest items first. Documents listed are held in J. Desk and can be shared on request.</p><script>setTimeout(()=>print(),300)<\/script>`);
  w.document.close();
}

/* ======================= I owe: one loan / card / person ======================= */
export function openOwe(eid, key) { det = { eid, key, side: "owe" }; openSheet(sh => renderOwe(sh), { wide: true }); }
function renderOwe(sh) {
  const e = entityById(det.eid), { g } = findGroup(det.eid, det.key, "owe");
  if (!g) { sh.innerHTML = sheetHead("I owe") + `<div class="sh-body"><p>Nothing found.</p></div>`; return; }
  const o = obligationFor(g.account.id, g.party_id), w = canWriteFin(e.id), kind = debtKind(g);
  const lines = [...g.lines].sort((a, b) => b.entry_date.localeCompare(a.entry_date));
  sh.innerHTML = sheetHead(groupName(g), `${DEBT_KIND_LABEL[kind]} · ${esc(g.account.name)}`) + `<div class="sh-body">
    <div class="mn-cards sm"><div class="mn-card out"><span class="mn-l">Still owe</span><span class="mn-n num">${money(g.balance, e.base_currency)}</span></div>
      <div class="mn-card"><span class="mn-l">Original amount</span><span class="mn-n num">${money(o && o.original_amount != null ? o.original_amount : g.credits, e.base_currency)}</span><span class="mn-s">${o && o.original_amount != null ? "as you entered it" : "total borrowed / charged in your books"}</span></div>
      <div class="mn-card in"><span class="mn-l">Paid so far</span><span class="mn-n num">${money(g.debits, e.base_currency)}</span></div></div>
    ${w ? `<div class="btnrow"><button class="btn primary" data-act="mn-owe-pay">${ICON.plus}Record a payment</button></div>` : ""}
    <form id="mnObl" class="review-form"><h3 class="mn-h3">Details</h3>
      <div class="grid2"><label class="field"><span>Type</span><select class="input" id="ob-kind" ${w ? "" : "disabled"}>${Object.entries(DEBT_KIND_LABEL).map(([k, l]) => `<option value="${k}" ${k === kind ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="field"><span>Name</span><input class="input" id="ob-name" value="${esc(o ? o.name : groupName(g))}" ${w ? "" : "disabled"}></label></div>
      <div class="grid2"><label class="field"><span>Original amount</span><input class="input num" type="number" step="0.01" min="0" id="ob-orig" value="${o && o.original_amount != null ? o.original_amount : ""}" ${w ? "" : "disabled"}></label>
        <label class="field"><span>Monthly instalment</span><input class="input num" type="number" step="0.01" min="0" id="ob-inst" value="${o && o.installment != null ? o.installment : ""}" ${w ? "" : "disabled"}></label></div>
      <div class="grid2"><label class="field"><span>Due every month on day</span><input class="input num" type="number" min="1" max="31" id="ob-day" value="${o && o.due_day || ""}" ${w ? "" : "disabled"}></label>
        <label class="field"><span>Or due on <small>(one-off)</small></span><input class="input" type="date" id="ob-date" value="${o && o.due_date || ""}" ${w ? "" : "disabled"}></label></div>
      <div class="grid2"><label class="field"><span>Interest rate % <small>(optional)</small></span><input class="input num" type="number" step="0.001" min="0" id="ob-rate" value="${o && o.interest_rate != null ? o.interest_rate : ""}" ${w ? "" : "disabled"}></label>
        <label class="field"><span>Note</span><input class="input" id="ob-notes" value="${esc(o && o.notes || "")}" ${w ? "" : "disabled"}></label></div>
      ${w ? `<div class="btnrow"><button class="btn" type="submit" id="obSave">Save details</button></div>` : ""}</form>
    ${o ? docsBlock(e, o) : (w ? `<p class="hint">Save the details to attach the loan agreement or card statement.</p>` : "")}
    <h3 class="mn-h3">History</h3><div class="list compact">${lines.map(l => `<div class="trow" data-act="fin-open-journal" data-id="${l.journal_id}" role="button" tabindex="0"><div class="tmain"><div class="ttitle">${esc(l.journal.memo)}</div><div class="tmeta">${fmtDate(l.entry_date)}</div></div>
      <div class="tside"><b class="num ${Number(l.debit) ? "ok-text" : "bad-text"}">${Number(l.debit) ? `paid ${money(l.debit, e.base_currency)}` : `+${money(l.credit, e.base_currency)} owed`}</b></div></div>`).join("") || `<p class="calm">Nothing posted yet.</p>`}</div>
  </div>`;
}
async function saveOwe() {
  const e = entityById(det.eid), { g } = findGroup(det.eid, det.key, "owe"), o = obligationFor(g.account.id, g.party_id);
  const num = id => val(id) === "" ? null : Number(val(id));
  const r = await saveObligation({ id: o && o.id, entity_id: e.id, side: "i_owe", account_id: g.account.id, party_id: g.party_id, kind: val("ob-kind"), name: val("ob-name") || groupName(g),
    original_amount: num("ob-orig"), installment: num("ob-inst"), due_day: num("ob-day"), due_date: val("ob-date"), interest_rate: num("ob-rate"), notes: val("ob-notes"), expected_date: o && o.expected_date });
  if (r.error) return toastError(r.error);
  await refresh(); rerenderSheet(); toast("Details saved");
}
async function saveOwedMeta() {
  const e = entityById(det.eid), { g } = findGroup(det.eid, det.key, "owed"), o = obligationFor(g.account.id, g.party_id);
  const r = await saveObligation({ ...(o || {}), id: o && o.id, entity_id: e.id, side: "owed_to_me", account_id: g.account.id, party_id: g.party_id, kind: o ? o.kind : (moneyModel(e).biz.has(g.party_id) ? "business" : "other"),
    name: o ? o.name : groupName(g), expected_date: val("mo-exp"), notes: val("mo-notes") });
  if (r.error) return toastError(r.error);
  await refresh(); rerenderSheet(); toast("Saved");
}
async function ensureObligation(eid, key, side) {
  const { g } = findGroup(eid, key, side), o = obligationFor(g.account.id, g.party_id); if (o) return o;
  const r = await saveObligation({ entity_id: eid, side: side === "owed" ? "owed_to_me" : "i_owe", account_id: g.account.id, party_id: g.party_id, kind: side === "owe" ? debtKind(g) : "other", name: groupName(g) });
  if (r.error) { toastError(r.error); return null; }
  fin.obligations.push(r.data); return r.data;
}

/* ======================= add an amount already owed (opening balance) ======================= */
function openAddExisting(eid, side) {
  const e = entityById(eid);
  det = { eid, side: side === "owed_to_me" ? "owed_existing" : "owe_existing" };
  const owe = side === "i_owe";
  openSheet(sh => { sh.innerHTML = sheetHead(owe ? "Add an existing loan or debt" : "Add an amount already owed to you", `${esc(e.name)} · recorded as an opening balance, not as spending or income`) + `<form id="mnExisting" class="sh-body" data-side="${side}" novalidate>
    ${owe ? `<label class="field"><span>Type</span><select class="input" id="ex-kind">${Object.entries(DEBT_KIND_LABEL).filter(([k]) => k !== "partner").map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>` : ""}
    <label class="field"><span>${owe ? "Owed to" : "Who owes you"}</span><select class="input" id="ex-party">${partyOpts(eid, "")}</select></label>
    <div class="grid2"><label class="field"><span>Amount owed today (${e.base_currency})</span><input class="input num" type="number" step="0.01" min="0.01" id="ex-amt"></label>
      <label class="field"><span>As of</span><input class="input" type="date" id="ex-date" value="${today()}"></label></div>
    ${owe ? `<div class="grid2"><label class="field"><span>Original amount <small>(optional)</small></span><input class="input num" type="number" step="0.01" min="0" id="ex-orig"></label>
      <label class="field"><span>Monthly instalment <small>(optional)</small></span><input class="input num" type="number" step="0.01" min="0" id="ex-inst"></label></div>
      <label class="field"><span>Due every month on day <small>(optional)</small></span><input class="input num" type="number" min="1" max="31" id="ex-day"></label>`
      : `<label class="field"><span>Expected back by <small>(optional)</small></span><input class="input" type="date" id="ex-exp"></label>`}
    <label class="field"><span>Note <small>(optional)</small></span><input class="input" id="ex-notes"></label>
    <p class="hint">Use this for amounts that existed before you started using J. Desk. New borrowing or lending: use Capture instead, so the bank side is recorded too.</p>
    <div class="sheet-foot"><button class="btn primary block" type="submit" id="exSave">Save</button></div></form>`; });
}
const oweAccountFor = (eid, kind) => {
  const by = (pred) => accountsOf(eid, a => a.is_active && pred(a))[0];
  return (kind === "credit_card" && by(a => a.subtype === "card")) || (kind === "friend_family" && by(a => a.subtype === "loan" && /friend|family/i.test(a.name)))
    || (kind === "bank_loan" && by(a => a.subtype === "loan" && !/friend|family/i.test(a.name))) || by(a => a.system_key === "ap") || by(a => a.type === "liability");
};
async function submitExisting(form) {
  const eid = det.eid, e = entityById(eid), owe = form.dataset.side === "i_owe";
  let party = val("ex-party"); if (party === "__new") party = "";
  const amt = r2(val("ex-amt")), date = val("ex-date");
  if (!party) return toastError(owe ? "Say who you owe." : "Say who owes you.");
  if (!(amt > 0)) return toastError("Enter the amount.");
  const kind = owe ? val("ex-kind") : null, open = sysAccount(eid, "opening");
  const acc = owe ? oweAccountFor(eid, kind) : (accountsOf(eid, a => a.subtype === "receivable" && a.is_active && /money owed/i.test(a.name))[0] || accountsOf(eid, a => a.subtype === "receivable" && a.is_active)[0]);
  if (!acc || !open) return toastError("These books are missing the account needed — add it under Advanced → Chart of accounts.");
  const pn = (partyById(party) || {}).name || "";
  const btn = $("exSave"); busy(btn, true);
  const lines = owe ? [{ account_id: open.id, debit: amt, description: "Opening balance" }, { account_id: acc.id, party_id: party, credit: amt, description: `Owed to ${pn}` }]
    : [{ account_id: acc.id, party_id: party, debit: amt, description: `Owed by ${pn}` }, { account_id: open.id, credit: amt, description: "Opening balance" }];
  const r = await saveJournal({ entity_id: eid, entry_date: date || today(), memo: owe ? `Existing debt: ${pn}` : `Existing amount owed by ${pn}`, source: "opening" }, lines, true);
  if (r.error) { busy(btn, false); return toastError(r.error); }
  const num = id => val(id) === "" ? null : Number(val(id));
  const o = obligationFor(acc.id, party);
  const s = await saveObligation({ id: o && o.id, entity_id: eid, side: owe ? "i_owe" : "owed_to_me", account_id: acc.id, party_id: party, kind: owe ? kind : "other", name: pn,
    original_amount: owe ? num("ex-orig") : null, installment: owe ? num("ex-inst") : null, due_day: owe ? num("ex-day") : null, expected_date: owe ? null : val("ex-exp"), notes: val("ex-notes") });
  if (s.error) toastError("Saved the balance, but not the details: " + (s.error.message || s.error));
  busy(btn, false); await refresh(); closeSheet(); toast("Saved");
}

/* ======================= add an account (any currency) ======================= */
const ACC_TYPES = { bank: ["Bank account", "asset", "bank", 1030], cash: ["Cash", "asset", "cash", 1001], card: ["Credit card", "liability", "card", 2110], earmarked: ["Savings pot", "asset", "earmarked", 1410],
  investment: ["Investment", "asset", "investment", 1310], loan: ["Loan", "liability", "loan", 2260] };
function openNewAccount(eid) {
  const e = entityById(eid), ccys = [...new Set([e.base_currency, ...Object.keys(rates()).filter(k => k !== "base"), ...CURRENCIES])];
  det = { eid, side: "new_account" };
  openSheet(sh => { sh.innerHTML = sheetHead("Add an account", `${esc(e.name)} · e.g. Indian bank (INR), Bahrain cash (BHD), a second QAR card`) + `<form id="mnNewAcc" class="sh-body" novalidate>
    <label class="field"><span>Name</span><input class="input" id="na-name" placeholder="e.g. Federal Bank NRO" autofocus></label>
    <div class="grid2"><label class="field"><span>Type</span><select class="input" id="na-type">${Object.entries(ACC_TYPES).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join("")}</select></label>
      <label class="field"><span>Currency</span><select class="input" id="na-ccy">${ccys.map(c => `<option ${c === e.base_currency ? "selected" : ""}>${c}</option>`).join("")}</select></label></div>
    <h3 class="mn-h3">Balance today <small class="hint">(optional)</small></h3>
    <div class="grid2"><label class="field"><span id="na-ballbl">Balance (${e.base_currency})</span><input class="input num" type="number" step="0.01" min="0" id="na-bal"></label>
      <label class="field"><span>As of</span><input class="input" type="date" id="na-date" value="${today()}"></label></div>
    <label class="field" id="na-basewrap" hidden><span>${e.base_currency} equivalent</span><input class="input num" type="number" step="0.01" min="0" id="na-base"><small class="hint" id="na-hint"></small></label>
    <p class="hint">The account keeps its own currency, so its balance is always exact in that currency; your reports show it in ${e.base_currency}. Card and loan balances are what you owe.</p>
    <div class="sheet-foot"><button class="btn primary block" type="submit" id="naSave">Add account</button></div></form>`; });
}
async function submitNewAccount() {
  const e = entityById(det.eid), name = val("na-name"), t = ACC_TYPES[val("na-type")], ccy = val("na-ccy"), bal = Number(val("na-bal") || 0), baseAmt = Number(val("na-base") || 0);
  if (!name) return toastError("Give the account a name.");
  const foreign = ccy !== e.base_currency;
  if (bal > 0 && foreign && !(baseAmt > 0)) return toastError(`Enter the ${e.base_currency} equivalent — ${rateHint(ccy, e.base_currency)}.`);
  const used = new Set(accountsOf(e.id).map(a => a.code)); let code = t[3]; while (used.has(String(code))) code++;
  const btn = $("naSave"); busy(btn, true);
  const r = await run(sb.from("fin_accounts").insert({ entity_id: e.id, code: String(code), name, type: t[1], subtype: t[2], currency: foreign ? ccy : null }).select().single());
  if (r.error) { busy(btn, false); return toastError(r.error); }
  fin.accounts.push(r.data);
  if (bal > 0) {
    const p = await moneyPost({ entity_id: e.id, kind: "opening", txn_date: val("na-date") || today(), account_id: r.data.id, amount: foreign ? baseAmt : bal, currency: foreign ? ccy : null, fx_amount: foreign ? bal : null,
      rate_source: foreign ? ($("na-base").dataset.touched ? "entered" : "planning") : null, description: `${name} opening balance` });
    if (p.error) { busy(btn, false); await refresh(); return toastError("Account added, but the balance wasn't saved: " + (p.error.message || p.error)); }
  }
  busy(btn, false); await refresh(); closeSheet(); toast(`${name} added`);
}

/* ======================= budgets in any currency ======================= */
export async function saveBudgets(eid, month, rows) {
  const e = entityById(eid), up = [], del = [];
  for (const x of rows) {
    if (!(x.native > 0)) { del.push(x.account_id); continue; }
    const amount = x.ccy === e.base_currency ? r2(x.native) : planned(x.native, x.ccy, e.base_currency);
    if (amount === null) return { error: `No planning rate for ${x.ccy} — add it under Finance → Change rates first.` };
    up.push({ entity_id: eid, account_id: x.account_id, month, amount, native_currency: x.ccy === e.base_currency ? null : x.ccy, native_amount: x.ccy === e.base_currency ? null : r2(x.native) });
  }
  if (up.length) { const r = await run(sb.from("fin_budgets").upsert(up, { onConflict: "account_id,month" })); if (r.error) return r; }
  if (del.length) { const r = await run(sb.from("fin_budgets").delete().eq("month", month).in("account_id", del)); if (r.error) return r; }
  return { data: true };
}

/* ======================= what the bank shows ======================= */
function openBalanceCheck(eid, accId) {
  const a = accById(accId), e = entityById(eid), card = a.subtype === "card";
  openSheet(sh => { sh.innerHTML = sheetHead(card ? "Card statement balance" : "What the bank shows", `${esc(a.name)} · kept apart from your books, so differences show up`) + `<form id="mnBalCheck" class="sh-body" data-acc="${accId}" data-entity="${eid}" novalidate>
    <div class="grid2"><label class="field"><span>${card ? "Amount owed on the card" : "Balance in the bank app"} (${a.currency || e.base_currency})</span><input class="input num" type="number" step="0.01" id="bc-bal" autofocus></label>
      <label class="field"><span>On</span><input class="input" type="date" id="bc-date" value="${today()}"></label></div>
    <label class="field"><span>Note <small>(optional)</small></span><input class="input" id="bc-note"></label>
    <p class="hint">Nothing in your books changes. If the numbers differ, something is missing — upload the statement with Capture to find it.</p>
    <div class="sheet-foot"><button class="btn primary block" type="submit">Save</button></div></form>`; });
}

/* ======================= events ======================= */
export async function handleMoneyClick(act, el, rerender) {
  if (!act.startsWith("mn-")) return false;
  const eid = el.dataset.entity || (det && det.eid) || (mf && mf.eid) || (cap && cap.eid) || state.route.a;
  switch (act) {
    case "mn-capture": { const target = el.dataset.entity || (state.route.name === "finance" && entityById(state.route.a) && entityById(state.route.a).kind === "personal" ? state.route.a : personalBooksId());
      if (!el.dataset.entity && $("capForm")) closeSheet(); openMoneyCapture(target); return true; }
    case "mn-paste": cap.paste = !cap.paste; rerenderSheet(); return true;
    case "mn-manual": { if (cap) { closeSheet(); cap = null; } openManual(eid, { kind: el.dataset.kind || undefined }); return true; }
    case "mn-kind": syncManual(); mf.kind = el.dataset.kind; mf.category_account_id = ""; mf.party_id = mf.party_id || "";
      if (kindNeeds(mf.kind).business) { const b = linkedBusinesses(mf.eid); mf.for_entity_id = mf.for_entity_id || (b[0] || {}).entity_id || "";
        mf.business_account_id = mf.for_entity_id ? (mf.kind === "paid_for_business" ? businessAccountFor(mf.description + " " + mf.merchant, accountsOf(mf.for_entity_id)) : (accountsOf(mf.for_entity_id, a => a.subtype === "bank")[0] || {}).id) || "" : ""; }
      else mf.category_account_id = suggest({ description: mf.description, merchant: mf.merchant, direction: IN_KINDS.includes(mf.kind) && mf.kind !== "transfer" ? "in" : "out" }, { accounts: accountsOf(mf.eid) }).kind === mf.kind ? suggest({ description: mf.description, merchant: mf.merchant, direction: IN_KINDS.includes(mf.kind) && mf.kind !== "transfer" ? "in" : "out" }, { accounts: accountsOf(mf.eid) }).category_account_id || "" : "";
      if (!kindNeeds(mf.kind).moneyCard && (accById(mf.account_id) || {}).subtype === "card") mf.account_id = defaultMoneyAcc(mf.eid);
      rerenderSheet(); return true;
    case "mn-link-biz": { const r = await moneyLinkBusiness(mf ? mf.eid : eid, el.dataset.biz); if (r.error) return toastError(r.error), true;
      await refresh(); syncManual(); if (mf) { mf.for_entity_id = el.dataset.biz; mf.business_account_id = mf.kind === "paid_for_business" ? businessAccountFor(mf.description + " " + mf.merchant, accountsOf(el.dataset.biz)) || "" : (accountsOf(el.dataset.biz, a => a.subtype === "bank")[0] || {}).id || ""; }
      rerenderSheet(); toast(`${(entityById(el.dataset.biz) || {}).name} linked to your personal books`); return true; }
    case "mn-unfile": syncManual(); mf.file = null; rerenderSheet(); return true;
    case "mn-review": openReview(el.dataset.id); return true;
    case "mn-rv-sel": if (el.checked) rv.sel.add(el.dataset.id); else rv.sel.delete(el.dataset.id); rerenderSheet(); return true;
    case "mn-rv-all": { const pend = importRowsOf(rv.importId).filter(r => r.status === "pending"); if (el.checked) pend.forEach(r => rv.sel.add(r.id)); else rv.sel.clear(); rerenderSheet(); return true; }
    case "mn-rv-post": await postSelected(el); return true;
    case "mn-rv-skip": await skipSelected(); return true;
    case "mn-rv-unskip": { const r = await importRowUpdate(el.dataset.id, { status: "pending" }); if (r.error) return toastError(r.error), true; await refresh(); rerenderSheet(); return true; }
    case "mn-rv-delete": { if (!(await dialog({ title: "Discard this import?", text: "The lines are removed from the review list. Nothing in your books changes.", confirm: "Discard", danger: true }))) return true;
      const r = await importDelete(rv.importId); if (r.error) return toastError(r.error), true; await refresh(); closeSheet(); toast("Import discarded"); return true; }
    case "mn-filter": { const u = state.ui.money = state.ui.money || {}; u.filter = el.dataset.f; if (state.route.params && state.route.params.get("f")) location.hash = `#/finance/${state.route.a}/transactions`; else rerender(); return true; }
    case "mn-month": { const u = state.ui.money = state.ui.money || {}; u.month = el.dataset.m; rerender(); return true; }
    case "mn-owed": openOwed(eid, el.dataset.key); return true;
    case "mn-owe": openOwe(eid, el.dataset.key); return true;
    case "mn-owed-print": printOwed(); return true;
    case "mn-owed-repaid": case "mn-owed-more": {
      const { m, g } = findGroup(det.eid, det.key, "owed"), b = m.biz.get(g.party_id), more = act === "mn-owed-more";
      if (b && b.link) openManual(det.eid, { kind: more ? "paid_for_business" : "business_repaid", for_entity_id: b.entity_id });
      else openManual(det.eid, { kind: more ? "lent" : "repayment_in", category_account_id: g.account.id, party_id: g.party_id });
      return true; }
    case "mn-owe-pay": { const { g } = findGroup(det.eid, det.key, "owe");
      if (g.account.subtype === "card") openManual(det.eid, { kind: "transfer", category_account_id: g.account.id, description: "Credit card payment" });
      else openManual(det.eid, { kind: "debt_payment", category_account_id: g.account.id, party_id: g.party_id, description: `Payment to ${groupName(g)}` });
      return true; }
    case "mn-add-existing": openAddExisting(eid, el.dataset.side); return true;
    case "mn-balcheck": openBalanceCheck(eid, el.dataset.acc); return true;
    case "mn-new-account": openNewAccount(eid); return true;
    case "mn-budget-save": { const f = $("mnBudget"); if (!f) return true; const rows = [...f.querySelectorAll("[data-bacc]")].map(tr => ({ account_id: tr.dataset.bacc, ccy: tr.querySelector("select").value, native: Number(tr.querySelector("input").value || 0) }));
      busy(el, true); const r = await saveBudgets(eid, f.dataset.month, rows); busy(el, false); if (r.error) return toastError(r.error), true; await refresh(); rerender(); toast("Budget saved"); return true; }
    case "mn-budget-copy": { const m = el.dataset.month, src = fin.budgets.filter(b => b.entity_id === eid && b.month === m); if (!src.length) return toastError("Save this month's budget first."), true;
      const [y, mo] = m.split("-").map(Number), rows = [];
      for (let k = mo + 1; k <= 12; k++) { const mm = `${y}-${String(k).padStart(2, "0")}-01`; src.forEach(b => rows.push({ entity_id: eid, account_id: b.account_id, month: mm, amount: b.amount, native_currency: b.native_currency, native_amount: b.native_amount })); }
      if (!rows.length) return toast("Nothing left in this year to copy to."), true;
      const r = await run(sb.from("fin_budgets").upsert(rows, { onConflict: "account_id,month" })); if (r.error) return toastError(r.error), true; await refresh(); rerender(); toast("Copied to the rest of the year"); return true; }
  }
  return false;
}
const personalBooksId = () => (fin.entities.find(e => e.kind === "personal" && !e.archived && canWriteFin(e.id)) || {}).id;
export async function handleMoneyChange(ev, rerender) {
  const t = ev.target, id = t.id;
  if (id === "mn-cap-acc") { cap.account_id = t.value; return true; }
  if (id === "na-ccy") { const e = entityById(det.eid), f = t.value !== e.base_currency; $("na-basewrap").hidden = !f; $("na-ballbl").textContent = `Balance (${t.value})`; $("na-hint").textContent = f ? `Filled from ${rateHint(t.value, e.base_currency)}.` : "";
    if (f && val("na-bal")) $("na-base").value = planned(val("na-bal"), t.value, e.base_currency) ?? ""; return true; }
  if (id === "mn-photo" || id === "mn-file") { const f = t.files[0]; if (f) { cap.working = "Reading…"; rerenderSheet(); await readFile(f, id === "mn-photo"); } return true; }
  if (id === "mm-photo" || id === "mm-file") { syncManual(); mf.file = t.files[0] || mf.file; rerenderSheet(); return true; }
  if (id === "mm-party" && t.value === "__new") { syncManual(); const p = await newParty(mf.eid); mf.party_id = p || ""; rerenderSheet(); return true; }
  if (id === "ex-party" && t.value === "__new") { const p = await newParty(det.eid); if (p) { t.insertAdjacentHTML("afterbegin", ""); t.innerHTML = partyOpts(det.eid, p); } else t.value = ""; return true; }
  if (id === "mm-biz") { syncManual(); mf.business_account_id = mf.kind === "paid_for_business" ? businessAccountFor(mf.description + " " + mf.merchant, accountsOf(mf.for_entity_id)) || "" : (accountsOf(mf.for_entity_id, a => a.subtype === "bank")[0] || {}).id || ""; rerenderSheet(); return true; }
  if (t.dataset && t.dataset.rv) { await reviewField(t); return true; }
  if (t.dataset && t.dataset.act === "mn-attach") { const f = t.files[0]; if (!f) return true; toast(`Uploading ${f.name}…`);
    const j = fin.journals.find(x => x.id === t.dataset.journal); let u;
    if (j.source === "partner") { const pt = fin.ptxns.find(x => x.id === j.source_id); u = pt ? await uploadPartnerDoc(f, pt, "supplier_invoice", safeFileName) : { error: "That business entry isn't visible to you." }; }
    else u = await uploadFinFile(f, j.entity_id, { journal_id: j.id }, safeFileName);
    if (u.error) return toastError(u.error), true; rerenderSheet(); toast("Receipt attached"); return true; }
  if (t.dataset && t.dataset.act === "mn-attach-obl") { const f = t.files[0]; if (!f) return true; const o = fin.obligations.find(x => x.id === t.dataset.id); toast(`Uploading ${f.name}…`);
    const u = await uploadFinFile(f, o.entity_id, { obligation_id: o.id }, safeFileName); if (u.error) return toastError(u.error), true; rerenderSheet(); toast("Document attached"); return true; }
  if (id === "mm-bizacc") { mf.bizPicked = true; syncManual(); return true; }
  if (["mm-acc", "mm-cat", "mm-ccy"].includes(id)) { syncManual(); if (id !== "mm-cat" || mf.kind === "transfer") { if (id === "mm-ccy") { mf.native = ""; mf.amount = ""; mf.baseTouched = false; } rerenderSheet(); } return true; }
  if (["mm-date", "mm-amount", "mm-native", "mm-tonative", "mm-bizamt"].includes(id)) { syncManual(); return true; }
  return false;
}
export function handleMoneyInput(ev, keepFocus) {
  const t = ev.target;
  if (t.id === "na-bal" && $("na-basewrap") && !$("na-basewrap").hidden && !$("na-base").dataset.touched) { const e = entityById(det.eid); $("na-base").value = planned(t.value, val("na-ccy"), e.base_currency) ?? ""; return true; }
  if (t.id === "na-base") { t.dataset.touched = "1"; return true; }
  if (t.id === "mn-q") { (state.ui.money = state.ui.money || {}).q = t.value; keepFocus("mn-q"); return true; }
  if (t.id === "mm-native" && mf && !mf.baseTouched && $("mm-amount")) { const e = entityById(mf.eid), b = planned(t.value, mf.currency, e.base_currency); $("mm-amount").value = b ?? ""; return true; }
  if (t.id === "mm-amount" && mf && $("mm-native")) { mf.baseTouched = true; const h = $("mm-ratehint"); if (h && Number(t.value) > 0 && Number(val("mm-native")) > 0) h.textContent = `Using your figure (rate ${(Number(val("mm-native")) / Number(t.value)).toFixed(4)}).`; return true; }
  if (t.id === "mm-desc" || t.id === "mm-merchant") {
    if (mf && mf.kind === "paid_for_business" && $("mm-bizacc") && (!$("mm-bizacc").value || !mf.bizPicked)) { const g = businessAccountFor(val("mm-desc") + " " + val("mm-merchant"), accountsOf(val("mm-biz"))); if (g) $("mm-bizacc").value = g; }
    return true;
  }
  return !!(t.closest && t.closest("#mnManual, #mnObl, #mnOwedMeta, #mnExisting, #mnBalCheck, #mnPaste, #mnNewAcc, #mnBudget"));
}
export async function handleMoneySubmit(form, rerender, submitter) {
  switch (form.id) {
    case "mnPaste": { const text = val("mn-text"); if (!text) return toastError("Paste a message first."), true; await readText(text, !!(submitter && submitter.dataset.ai)); return true; }
    case "mnManual": await submitManual(form); return true;
    case "mnObl": await saveOwe(); return true;
    case "mnOwedMeta": await saveOwedMeta(); return true;
    case "mnExisting": await submitExisting(form); return true;
    case "mnNewAcc": await submitNewAccount(); return true;
    case "mnBalCheck": { const bal = val("bc-bal"); if (bal === "") return toastError("Enter the balance."), true; const a = accById(form.dataset.acc);
      const r = await addBalanceCheck(form.dataset.entity, a.id, val("bc-date") || today(), a.subtype === "card" ? -Math.abs(Number(bal)) : Number(bal), val("bc-note"));
      if (r.error) return toastError(r.error), true; await refresh(); closeSheet(); toast("Saved"); return true; }
  }
  return false;
}
export { ensureObligation };
