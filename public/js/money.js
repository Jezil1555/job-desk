// Plain-language money logic for the simple Finance screens. Pure functions only (no DOM, no network) so they can be unit-tested.
// Every figure is derived from posted ledger lines; nothing here invents a balance.
import { r2, parseBankDate } from "./finance.js";

export const CASH = new Set(["cash", "bank"]);            // money you actually hold
export const MONEY = new Set(["cash", "bank", "card"]);    // accounts money moves through
export const SAVINGS = new Set(["earmarked", "investment"]);

export const KIND_LABEL = {
  spend: "Spent", income: "Income", transfer: "Moved money", lent: "Lent / paid for someone", repayment_in: "Got paid back",
  borrowed: "Borrowed", debt_payment: "Paid a loan or card", paid_for_business: "Paid for a business", business_repaid: "Business paid me back"
};
export const KIND_ORDER = ["spend", "income", "paid_for_business", "business_repaid", "transfer", "debt_payment", "lent", "repayment_in", "borrowed"];
export const DEBT_KIND_LABEL = { bank_loan: "Bank loan", credit_card: "Credit card", friend_family: "Friends & family", business: "Business", partner: "Business partner", other: "Other" };

/** The parties in these books that stand for one of your businesses (linked partner accounts or parties tied to another set of books). */
export function businessParties(entityId, { plinks = [], parties = [], entities = [] }) {
  const out = new Map();
  for (const k of plinks) if (k.mirror_entity_id === entityId && k.mirror_party_id) out.set(k.mirror_party_id, { entity_id: k.entity_id, link: k, name: (entities.find(e => e.id === k.entity_id) || {}).name });
  for (const p of parties) if (p.entity_id === entityId && p.related_entity_id && !out.has(p.id)) out.set(p.id, { entity_id: p.related_entity_id, link: null, name: (entities.find(e => e.id === p.related_entity_id) || {}).name || p.name });
  return out;
}

/**
 * Classify one posted journal from the point of view of these books.
 * Returns { cashIn, cashOut, flows: [{cat, label, amount (+in / -out), account, party}], kind, business, spend, income, card }.
 * Cash flows are attributed line by line to the counterpart, so they always add up to the change in cash & bank.
 */
export function classifyJournal(jlines, accById, bizParties) {
  const acc = l => accById(l.account_id) || {};
  const cashLines = jlines.filter(l => CASH.has(acc(l).subtype));
  const others = jlines.filter(l => !CASH.has(acc(l).subtype));
  const cashNet = r2(cashLines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0));
  const flows = [];
  let spend = 0, income = 0, business = null, bizIn = 0, bizOut = 0, card = 0;
  for (const l of others) {
    const a = acc(l), amt = r2(Number(l.credit) - Number(l.debit)); // + = money came from this line into cash
    if (a.type === "expense") spend = r2(spend + Number(l.debit) - Number(l.credit));
    if (a.type === "income") income = r2(income + Number(l.credit) - Number(l.debit));
    const biz = a.subtype === "receivable" && l.party_id && bizParties.get(l.party_id);
    if (biz) { business = biz; if (amt < 0) bizOut = r2(bizOut - amt); else bizIn = r2(bizIn + amt); }
    if (a.subtype === "card") card = r2(card + amt);
    if (!cashLines.length || !amt) continue;
    flows.push({ cat: flowCat(a, l, biz), amount: amt, account: a, party_id: l.party_id || null, business: biz || null });
  }
  if (cashLines.length && !others.length) flows.push({ cat: "own_transfer", amount: 0, account: null });
  // business funding paid by card: no cash moves, but it is still personal money used for the business
  return { cashNet, cashIn: cashNet > 0 ? cashNet : 0, cashOut: cashNet < 0 ? -cashNet : 0, flows, spend, income, business, bizOut, bizIn, card };
}
function flowCat(a, l, biz) {
  if (a.type === "income") return /salary|payroll|wage/i.test(a.name) ? "salary" : "income";
  if (a.type === "expense") return "spend";
  if (biz) return Number(l.debit) > 0 ? "biz_out" : "biz_in";
  if (a.subtype === "receivable") return Number(l.debit) > 0 ? "lent" : "repaid_to_me";
  if (a.type === "liability") return Number(l.debit) > 0 ? (a.subtype === "card" ? "card_payment" : "debt_payment") : "borrowed";
  if (SAVINGS.has(a.subtype)) return "savings";
  if (a.type === "equity") return "opening";
  return "other";
}
export const FLOW_LABEL = {
  salary: "Salary", income: "Other income", spend: "Spending", biz_out: "Paid for businesses", biz_in: "Reimbursed by businesses", lent: "Lent / paid for others",
  repaid_to_me: "Paid back to me", debt_payment: "Loan repayments", card_payment: "Credit card payments", borrowed: "Borrowed", savings: "Moved to savings & investments",
  opening: "Opening balances & adjustments", other: "Other", own_transfer: "Between my accounts"
};

/** Group posted lines into journals: Map(journal_id → { journal, lines }). */
export function byJournal(lines) {
  const m = new Map();
  for (const l of lines) { if (!m.has(l.journal_id)) m.set(l.journal_id, { journal: l.journal, lines: [] }); m.get(l.journal_id).lines.push(l); }
  return m;
}

/** Month summary for personal books, from posted lines dated within [from, to]. */
export function monthSummary(lines, accById, bizParties, from, to) {
  const inP = lines.filter(l => l.entry_date >= from && l.entry_date <= to);
  const sum = { salary: 0, otherIncome: 0, spending: 0, byCategory: new Map(), bizPaid: 0, bizRepaid: 0, byBusiness: new Map(), repayments: 0, interest: 0,
    lent: 0, repaidToMe: 0, borrowed: 0, savings: 0, cashIn: 0, cashOut: 0, flowsIn: new Map(), flowsOut: new Map(), opening: 0 };
  for (const { lines: jl } of byJournal(inP).values()) {
    const c = classifyJournal(jl, accById, bizParties);
    for (const l of jl) {
      const a = accById(l.account_id) || {};
      if (a.type === "income") { const v = r2(Number(l.credit) - Number(l.debit)); if (/salary|payroll|wage/i.test(a.name)) sum.salary = r2(sum.salary + v); else sum.otherIncome = r2(sum.otherIncome + v); }
      if (a.type === "expense") { const v = r2(Number(l.debit) - Number(l.credit)); sum.spending = r2(sum.spending + v); sum.byCategory.set(a.id, r2((sum.byCategory.get(a.id) || 0) + v)); if (/interest/i.test(a.name)) sum.interest = r2(sum.interest + v); }
    }
    if (c.business) {
      const key = c.business.entity_id, b = sum.byBusiness.get(key) || { name: c.business.name, paid: 0, repaid: 0 };
      b.paid = r2(b.paid + c.bizOut); b.repaid = r2(b.repaid + c.bizIn); sum.byBusiness.set(key, b);
      sum.bizPaid = r2(sum.bizPaid + c.bizOut); sum.bizRepaid = r2(sum.bizRepaid + c.bizIn);
    }
    for (const f of c.flows) {
      if (f.cat === "own_transfer") continue;
      if (f.cat === "debt_payment" || f.cat === "card_payment") sum.repayments = r2(sum.repayments - f.amount);
      if (f.cat === "lent") sum.lent = r2(sum.lent - f.amount);
      if (f.cat === "repaid_to_me") sum.repaidToMe = r2(sum.repaidToMe + f.amount);
      if (f.cat === "borrowed") sum.borrowed = r2(sum.borrowed + f.amount);
      if (f.cat === "savings") sum.savings = r2(sum.savings - f.amount);
      if (f.cat === "opening") sum.opening = r2(sum.opening + f.amount);
      const target = f.amount > 0 ? sum.flowsIn : sum.flowsOut;
      target.set(f.cat, r2((target.get(f.cat) || 0) + Math.abs(f.amount)));
    }
    sum.cashIn = r2(sum.cashIn + c.cashIn); sum.cashOut = r2(sum.cashOut + c.cashOut);
  }
  sum.income = r2(sum.salary + sum.otherIncome);
  sum.saved = r2(sum.income - sum.spending);
  sum.netCash = r2(sum.cashIn - sum.cashOut);
  return sum;
}

/** Balances grouped by account + person. pred(account) picks which accounts. sign: +1 for assets, -1 for liabilities. */
export function groupedBalances(lines, accById, pred, sign = 1) {
  const m = new Map();
  for (const l of lines) {
    const a = accById(l.account_id); if (!a || !pred(a)) continue;
    const key = a.id + "|" + (l.party_id || "");
    const g = m.get(key) || { key, account: a, party_id: l.party_id || null, balance: 0, debits: 0, credits: 0, lines: [] };
    g.balance = r2(g.balance + sign * (Number(l.debit) - Number(l.credit)));
    g.debits = r2(g.debits + Number(l.debit)); g.credits = r2(g.credits + Number(l.credit));
    g.lines.push(l); m.set(key, g);
  }
  return [...m.values()];
}

/**
 * Money owed to me, item by item. Repayments are applied to the oldest amounts first (FIFO), so each original amount shows
 * how much has come back and what is still outstanding. Lines must be one account + one person.
 */
export function receivableItems(lines) {
  const sorted = [...lines].sort((a, b) => (a.entry_date || "").localeCompare(b.entry_date || "") || ((a.journal && a.journal.number) || 0) - ((b.journal && b.journal.number) || 0));
  const items = [], repayments = [];
  for (const l of sorted) {
    const d = r2(Number(l.debit)), c = r2(Number(l.credit));
    if (d > 0) items.push({ line: l, date: l.entry_date, original: d, received: 0, outstanding: d });
    if (c > 0) repayments.push({ line: l, date: l.entry_date, amount: c });
  }
  let pool = r2(repayments.reduce((s, r) => s + r.amount, 0));
  for (const it of items) { const take = Math.min(pool, it.outstanding); it.received = r2(take); it.outstanding = r2(it.original - take); pool = r2(pool - take); }
  for (const it of items) it.status = it.outstanding <= 0.004 ? "paid" : it.received > 0 ? "part" : "open";
  return { items, repayments, unapplied: pool, total: r2(items.reduce((s, i) => s + i.outstanding, 0) - pool) };
}
export const ITEM_STATUS = { open: "Outstanding", part: "Part paid", paid: "Paid back" };

/* ======================= reading bank SMS / email text ======================= */
const CCY = "QAR|QR|INR|RS\\.?|USD|AED|SAR|KWD|BHD|OMR|EUR|GBP";
const AMT_RE = new RegExp(`(?:\\b(${CCY})\\.?\\s*([\\d,]+(?:\\.\\d{1,2})?))|(?:([\\d,]+(?:\\.\\d{1,2})?)\\s*(${CCY})\\b)`, "i");
const DATE_RES = [/\b(\d{4}-\d{1,2}-\d{1,2})\b/, /\b(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})\b/, /\b(\d{1,2}[\s\-\/][A-Za-z]{3,9}[\s\-\/,]+\d{2,4})\b/];
const normCcy = c => { c = String(c || "").toUpperCase().replace(/\.$/, ""); return c === "QR" ? "QAR" : c === "RS" ? "INR" : c; };

/** Split pasted text into separate messages (blank lines, or a new "Dear …"/date-stamped line starting a new message). */
export function splitMessages(text) {
  const t = String(text || "").replace(/\r/g, "").trim();
  if (!t) return [];
  let parts = t.split(/\n\s*\n+/);
  if (parts.length === 1) parts = t.split(/\n(?=(?:dear\b|\[?\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}|your\b|qar\b|purchase\b|txn\b|transaction\b))/i);
  return parts.map(s => s.replace(/\s+/g, " ").trim()).filter(s => AMT_RE.test(s));
}

/** Read one bank message. Returns {txn_date, amount, currency, direction, merchant, description, card_last4, balance} or null. */
export function parseBankMessage(msg, today) {
  const s = String(msg || "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  // ignore OTPs and balance-only notices
  if (/\b(otp|one[- ]time password|verification code)\b/i.test(s)) return null;
  const am = s.match(AMT_RE);
  if (!am) return null;
  const amount = r2(Number((am[2] || am[3]).replace(/,/g, "")));
  if (!(amount > 0)) return null;
  const currency = normCcy(am[1] || am[4]);
  const low = s.toLowerCase().replace(/credit card/g, "card").replace(/debit card/g, "card");
  const inWords = /\b(credited|credit(?:ed)? to|received|deposit(?:ed)?|refund(?:ed)?|salary|reversal|cash ?back|incoming)\b/, outWords = /\b(debited|debit(?:ed)? from|purchase|spent|paid|payment|withdraw[a-z]*|used|transfer(?:red)? to|sent|pos|atm)\b/;
  let direction = null;
  const iIn = low.search(inWords), iOut = low.search(outWords);
  if (iIn >= 0 && (iOut < 0 || iIn < iOut)) direction = "in"; else if (iOut >= 0) direction = "out";
  if (!direction) return null;
  // balance mentioned after the amount ("Avl bal QAR 1,234") must not be taken as the amount — AMT_RE takes the first, which is the transaction
  let balance = null; const bm = s.match(new RegExp(`(?:avl\\.?|available|avail\\.?)\\s*(?:bal(?:ance)?)?[:\\s]*(?:${CCY})?\\.?\\s*([\\d,]+(?:\\.\\d{1,2})?)`, "i"));
  if (bm) balance = r2(Number(bm[1].replace(/,/g, "")));
  let merchant = null;
  const mm = s.match(/\b(?:at|@)\s+([A-Za-z0-9][\w&'.\-*\/ ]{1,40}?)(?=\s+(?:on|using|via|with|for|ref|dated|avl|available|card|w\.e\.f)\b|[.,;]|$)/i)
    || (direction === "out" ? s.match(/\b(?:to|towards|beneficiary)\s+([A-Za-z][\w&'.\- ]{1,40}?)(?=\s+(?:on|using|via|with|ref|from|avl|available|account|a\/c)\b|[.,;]|$)/i)
                            : s.match(/\b(?:from|by)\s+([A-Za-z][\w&'.\- ]{1,40}?)(?=\s+(?:on|using|via|with|ref|to|avl|available|account|a\/c)\b|[.,;]|$)/i));
  if (mm) merchant = mm[1].trim().replace(/\s{2,}/g, " ");
  if (merchant && /^(your|the|a|an|account|a\/c|card)$/i.test(merchant)) merchant = null;
  if (!merchant && /salary/i.test(s)) merchant = "Salary";
  let txn_date = null;
  for (const re of DATE_RES) { const dm = s.match(re); if (dm) { txn_date = parseBankDate(dm[1].replace(/,/g, " ").replace(/\s+/g, " ")); if (txn_date) break; } }
  const cm = s.match(/(?:card|a\/c|acct|account)[^\d]{0,20}?(\d{4})\b/i);
  const description = (merchant || (direction === "in" ? "Money received" : "Payment")) + (/\batm\b/i.test(s) ? " (ATM)" : "");
  return { txn_date: txn_date || today || null, date_found: !!txn_date, amount, currency, direction, merchant, description, card_last4: cm ? cm[1] : null, balance, raw: s.slice(0, 500) };
}
export function parseBankText(text, today) {
  return splitMessages(text).map(m => parseBankMessage(m, today)).filter(Boolean);
}

/* ======================= suggesting what a transaction was ======================= */
const RULES = [
  { re: /\b(salary|payroll|wps|sal\s?cr)\b/i, dir: "in", kind: "income", cat: /salary/i, conf: "high" },
  { re: /\b(atm|cash withdrawal|cash wdl)\b/i, dir: "out", kind: "transfer", to: "cash", conf: "high" },
  { re: /\b(credit card payment|card payment|cc payment|card bill)\b/i, dir: "out", kind: "transfer", to: "card", conf: "medium" },
  { re: /\b(loan|emi|instal+ment|finance payment)\b/i, dir: "out", kind: "debt_payment", liab: /loan/i, conf: "medium" },
  { re: /\b(lulu|carrefour|monoprix|al ?meera|spar|safari|hypermarket|supermarket|grocery|grand mall|family food|baqala|bakery|megamart|ansar)\b/i, kind: "spend", cat: /grocer/i, conf: "high" },
  { re: /\b(woqod|petrol|fuel|uber|karwa|careem|parking|metro|taxi|garage|tyre|car wash|mowasalat)\b/i, kind: "spend", cat: /transport|fuel/i, conf: "high" },
  { re: /\b(ooredoo|vodafone|kahramaa|internet|electricity|water bill|mobile bill|recharge)\b/i, kind: "spend", cat: /utilit|telecom/i, conf: "high" },
  { re: /\b(rent|landlord|real estate|tenancy)\b/i, kind: "spend", cat: /housing|rent/i, conf: "medium" },
  { re: /\b(school|nursery|tuition|academy|kindergarten|uniform)\b/i, kind: "spend", cat: /education|child/i, conf: "medium" },
  { re: /\b(pharmacy|clinic|hospital|hamad|medical|dental|insurance|aster|wellcare)\b/i, kind: "spend", cat: /medical|insurance/i, conf: "medium" },
  { re: /\b(remit|western union|al ?zaman|lari exchange|city exchange|al ?dar exchange|exchange house|send money|transfer to india)\b/i, dir: "out", kind: "spend", cat: /family|remit/i, conf: "medium" },
  { re: /\b(restaurant|cafe|coffee|talabat|snoonu|rafeeq|cinema|netflix|spotify|hotel|airways|airline|booking\.com|flydubai|indigo|air india|mcdonald|kfc)\b/i, kind: "spend", cat: /leisure|travel/i, conf: "medium" },
  { re: /\b(interest|finance charge|late fee)\b/i, dir: "out", kind: "spend", cat: /interest/i, conf: "medium" },
  { re: /\b(charge|fee|commission|vat on)\b/i, dir: "out", kind: "spend", cat: /bank.*charges|charges/i, conf: "medium" }
];
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Suggest kind + category for an imported line. Order: your own history (same merchant) → business names → rules → leave for review.
 * ctx: { accounts (these books), history: [{merchant, description, kind, category_account_id, for_entity_id, business_account_id}], businesses: [{entity_id, name, keywords[]}],
 *        bizAccounts: entity_id → accounts }
 */
export function suggest(row, ctx) {
  const text = `${row.merchant || ""} ${row.description || ""}`, key = norm(row.merchant || row.description);
  const out = { kind: null, category_account_id: null, for_entity_id: null, business_account_id: null, confidence: "low", review_reason: null };
  const accs = ctx.accounts || [], find = (pred) => (accs.find(a => a.is_active !== false && pred(a)) || {}).id || null;
  // 1. history: the last time you posted the same merchant
  const h = key && (ctx.history || []).find(x => norm(x.merchant || x.description) === key && (!x.direction || x.direction === row.direction));
  if (h && h.kind) return { ...out, kind: h.kind, category_account_id: h.category_account_id || null, for_entity_id: h.for_entity_id || null, business_account_id: h.business_account_id || null, confidence: "high" };
  // 2. a business you run, named or known by keyword
  for (const b of ctx.businesses || []) {
    const words = [b.name, ...(b.keywords || [])].filter(Boolean).map(w => norm(w)).filter(w => w.length >= 4);
    if (words.some(w => norm(text).includes(w))) {
      const kind = row.direction === "in" ? "business_repaid" : "paid_for_business";
      return { ...out, kind, for_entity_id: b.entity_id, business_account_id: kind === "paid_for_business" ? businessAccountFor(text, (ctx.bizAccounts || {})[b.entity_id] || []) : bizBank((ctx.bizAccounts || {})[b.entity_id] || []), confidence: "medium",
        review_reason: `Looks like ${b.name} — check it was paid for the business` };
    }
  }
  // 3. rules
  for (const r of RULES) {
    if (r.dir && r.dir !== row.direction) continue;
    if (!r.re.test(text)) continue;
    if (r.kind === "income") return { ...out, kind: "income", category_account_id: find(a => a.type === "income" && r.cat.test(a.name)) || find(a => a.type === "income"), confidence: r.conf };
    if (r.kind === "transfer") {
      const to = r.to === "cash" ? find(a => a.subtype === "cash") : find(a => a.subtype === "card");
      return { ...out, kind: "transfer", category_account_id: to, confidence: to ? r.conf : "low", review_reason: to ? null : "Choose the account the money moved to" };
    }
    if (r.kind === "debt_payment") return { ...out, kind: "debt_payment", category_account_id: find(a => a.type === "liability" && r.liab.test(a.name)) || find(a => a.subtype === "loan"), confidence: r.conf, review_reason: "Check which loan, and add the interest if you know it" };
    const cat = find(a => a.type === "expense" && r.cat.test(a.name));
    if (cat) return { ...out, kind: "spend", category_account_id: cat, confidence: r.conf };
  }
  // 4. unknown
  if (row.direction === "in") return { ...out, kind: "income", category_account_id: find(a => a.type === "income" && /other/i.test(a.name)) || find(a => a.type === "income"), review_reason: "Money in — salary, income, or someone paying you back?" };
  return { ...out, kind: "spend", category_account_id: find(a => a.type === "expense" && /other/i.test(a.name)), review_reason: "Not sure what this was — pick a category" };
}
/** Business account to book a personal payment against, from what it was for. Never a bank, cash, card, income or equity account. */
export function businessAccountFor(text, accs) {
  const ok = accs.filter(a => a.is_active !== false && !MONEY.has(a.subtype) && !["income", "equity"].includes(a.type) && a.subtype !== "partner" && !["receivable", "payable"].includes(a.subtype));
  const pick = re => (ok.find(a => re.test(a.name)) || {}).id;
  if (/\b(fabric|cloth|textile|topaz|blossom|thread|button|lining|material)\b/i.test(text)) return pick(/inventory|stock|fabric/i) || null;
  if (/\b(dhl|aramex|fedex|courier|freight|shipping|delivery|cargo)\b/i.test(text)) return pick(/transport|delivery|freight/i) || null;
  if (/\b(rent|landlord)\b/i.test(text)) return pick(/rent/i) || null;
  if (/\b(salary|wages|tailor|staff)\b/i.test(text)) return pick(/salar|wage|staff/i) || null;
  if (/\b(licen[cs]e|ministry|moci|government|baladiya)\b/i.test(text)) return pick(/licen|government/i) || null;
  if (/\b(instagram|facebook|meta|ads?|marketing|print)\b/i.test(text)) return pick(/marketing/i) || null;
  if (/\b(woqod|petrol|fuel|car|vehicle)\b/i.test(text)) return pick(/vehicle|transport/i) || null;
  return pick(/^other/i) || null;
}
const bizBank = accs => (accs.find(a => a.subtype === "bank" && a.is_active !== false) || accs.find(a => a.subtype === "cash" && a.is_active !== false) || {}).id || null;

/** Which fields a kind needs, in plain words — used by the forms and the review list. */
export function kindNeeds(kind) {
  return {
    spend: { category: "What for", catFilter: a => a.type === "expense" || ["fixed_asset", "investment", "earmarked"].includes(a.subtype), money: "Paid from", moneyCard: true },
    income: { category: "Income type", catFilter: a => a.type === "income", money: "Received into", moneyCard: false },
    transfer: { category: "Moved to", catFilter: a => ["cash", "bank", "card", "earmarked", "investment"].includes(a.subtype), money: "Moved from", moneyCard: true },
    lent: { category: "Recorded under", catFilter: a => a.subtype === "receivable", money: "Paid from", moneyCard: true, party: "Who owes you" },
    repayment_in: { category: "Recorded under", catFilter: a => a.subtype === "receivable", money: "Received into", moneyCard: false, party: "Who paid you back" },
    borrowed: { category: "Owed under", catFilter: a => a.type === "liability" && a.subtype !== "card", money: "Received into", moneyCard: false, party: "Who lent it" },
    debt_payment: { category: "Loan or card", catFilter: a => a.type === "liability", money: "Paid from", moneyCard: false, party: "Paid to", interest: true },
    paid_for_business: { business: true, bizLabel: "What it was for (in the business's books)", money: "Paid from", moneyCard: true },
    business_repaid: { business: true, bizLabel: "Business paid from", money: "Received into", moneyCard: false }
  }[kind] || {};
}

/* ======================= currencies ======================= */
export const CURRENCIES = ["QAR", "INR", "BHD", "AED", "SAR", "KWD", "OMR", "USD", "EUR", "GBP"];
/** Convert an amount in `ccy` to the base currency using planning rates ({INR: 26.10} = 26.10 INR per 1 base). Null when no rate is set. */
export function toBase(native, ccy, rates, base) {
  if (!ccy || ccy === base) return r2(native);
  const k = Number((rates || {})[ccy]); return k > 0 ? r2(Number(native) / k) : null;
}
export function fromBase(amount, ccy, rates, base) {
  if (!ccy || ccy === base) return r2(amount);
  const k = Number((rates || {})[ccy]); return k > 0 ? r2(Number(amount) * k) : null;
}
/** An account's balance in its own currency (signed like debit − credit), from the foreign amounts on its lines. */
export function nativeBalance(lines, acc) {
  if (!acc || !acc.currency) return null;
  return r2(lines.filter(l => l.account_id === acc.id && l.fx_currency === acc.currency).reduce((s, l) => s + Number(l.fx_amount || 0), 0));
}
/** The foreign amount of a journal for display: from the rate record, else the first foreign line. */
export function journalFx(jlines, fxRow, base) {
  if (fxRow) return { ccy: fxRow.currency, amount: Number(fxRow.native_amount), planning: fxRow.rate_source === "planning" };
  const l = jlines.find(x => x.fx_currency && x.fx_currency !== base && x.fx_amount);
  return l ? { ccy: l.fx_currency, amount: Math.abs(Number(l.fx_amount)), planning: false } : null;
}
/** Budget vs actual for one category in the budget's own currency. Actual uses the foreign amount where the line has it, else converts at the planning rate. */
export function budgetActual(lines, accountId, ccy, rates, base, from, to) {
  let base_ = 0, native = 0, estimated = false;
  for (const l of lines) {
    if (l.account_id !== accountId || l.entry_date < from || l.entry_date > to) continue;
    const b = Number(l.debit) - Number(l.credit); base_ += b;
    if (!ccy || ccy === base) continue;
    if (l.fx_currency === ccy && l.fx_amount != null) native += Number(l.fx_amount);
    else { const c = fromBase(b, ccy, rates, base); if (c === null) return { base: r2(base_), native: null, estimated: true }; native += c; estimated = true; }
  }
  return { base: r2(base_), native: ccy && ccy !== base ? r2(native) : r2(base_), estimated };
}

/** Check a review/manual row is complete enough to post. Returns a plain-words problem or null. */
export function rowProblem(r, base) {
  if (!r.kind) return "Say what it was";
  if (!(Number(r.amount) > 0)) return "Amount missing";
  if (base && r.currency && r.currency !== base && !(Number(r.base_amount) > 0)) return `${base} amount missing`;
  if (!r.txn_date) return "Date missing";
  if (!r.account_id) return "Choose the bank, cash or card account";
  const n = kindNeeds(r.kind);
  if (n.business) { if (!r.for_entity_id) return "Choose the business"; if (!r.business_account_id) return n.bizLabel; return null; }
  if (!r.category_account_id) return n.category;
  if (n.party && ["lent", "repayment_in"].includes(r.kind) && !r.party_id) return n.party;
  if (r.kind === "transfer" && r.category_account_id === r.account_id) return "Choose two different accounts";
  return null;
}

/** Same key the database uses to spot the same transaction twice (account | date | amount | direction | description letters/digits). For display only. */
export const looseKey = r => [r.account_id || "-", r.txn_date || "-", r2(r.amount).toFixed(2), r.direction, norm(r.description).replace(/ /g, "")].join("|");
