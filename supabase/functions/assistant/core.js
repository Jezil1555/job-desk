// Assistant core: builds prompts and validates model output. The assistant only returns suggestions —
// it has no database access and its output is always shown to the person for review before anything is saved.
export const ACTIONS = ["draft_message", "action_items", "weekly_narrative", "categorize", "extract_money"];
const MONEY_KINDS = ["spend", "income", "transfer", "lent", "repayment_in", "borrowed", "debt_payment", "paid_for_business", "business_repaid"];
const clip = (s, n) => String(s ?? "").slice(0, n);
const SYSTEM_BASE = "You help a busy logistics professional in Qatar manage tasks, follow-ups and small businesses. " +
  "Be concise and practical. Never invent facts, names, amounts or dates that are not in the input. If something is unknown, leave it out.";

/** Build {system, messages, max_tokens} for an action. Throws on invalid input. */
export function buildRequest(action, input = {}) {
  switch (action) {
    case "draft_message": {
      const ch = input.channel === "email" ? "email" : "WhatsApp";
      const facts = [
        `Recipient: ${clip(input.to || "unknown", 80)}`, `About: ${clip(input.subject, 300)}`,
        input.direction === "i_owe" ? "I owe them this (I'm giving an update)." : "They owe me this (I'm chasing).",
        input.expected ? `Originally expected by: ${clip(input.expected, 20)}` : "", input.last_contact ? `Last contact: ${clip(input.last_contact, 20)}` : "",
        input.history ? `Recent notes (newest first):\n${clip(input.history, 1500)}` : "", input.sender ? `Sign as: ${clip(input.sender, 80)}` : ""].filter(Boolean).join("\n");
      return { max_tokens: 400, system: SYSTEM_BASE + ` Write one ${ch} message the person can edit and send themselves. ${ch === "email" ? "Start with 'Subject: …' on the first line." : "Keep it under 70 words, no subject line."} Tone: ${input.tone === "firm" ? "firm but courteous" : "warm and professional"}. Output only the message.`,
        messages: [{ role: "user", content: facts }] };
    }
    case "action_items": {
      if (!String(input.notes || "").trim()) throw new Error("bad_input: no notes");
      return { max_tokens: 800, system: SYSTEM_BASE + " Extract the concrete action items from meeting notes. Reply with JSON only: " +
        '{"items":[{"title":"short imperative task","owner":"name exactly as written in the notes or null"}]}. Do not add deadlines. Do not include items that are already done. Max 15 items.',
        messages: [{ role: "user", content: `People in this workspace: ${clip((input.people || []).join(", "), 400)}\n\nNotes:\n${clip(input.notes, 8000)}` }] };
    }
    case "weekly_narrative": {
      return { max_tokens: 500, system: SYSTEM_BASE + " Write a 4–6 sentence weekly review in the first person from the numbers and lists given: what got done, what slipped and why it matters, and what to focus on next week. Use only the facts provided.",
        messages: [{ role: "user", content: clip(JSON.stringify(input), 6000) }] };
    }
    case "categorize": {
      const lines = (input.lines || []).slice(0, 40).map(l => ({ id: String(l.id), description: clip(l.description, 160), amount: Number(l.amount) }));
      const accounts = (input.accounts || []).slice(0, 120).map(a => ({ id: String(a.id), code: clip(a.code, 12), name: clip(a.name, 80), type: a.type }));
      if (!lines.length || !accounts.length) throw new Error("bad_input: nothing to categorise");
      return { max_tokens: 1200, system: SYSTEM_BASE + " Suggest which ledger account each bank statement line most likely belongs to (negative = money out, positive = money in). " +
        'Reply with JSON only: {"suggestions":[{"id":"line id","account_id":"one of the given account ids","confidence":"high|medium|low"}]}. Omit lines you cannot judge.',
        messages: [{ role: "user", content: JSON.stringify({ lines, accounts }) }] };
    }
    case "extract_money": {
      // Read transactions from a pasted bank SMS/email, a statement (text or PDF) or a receipt photo. Suggestions only; the person reviews every line.
      const accounts = (input.accounts || []).slice(0, 150).map(a => ({ id: String(a.id), name: clip(a.name, 80), type: a.type, subtype: a.subtype }));
      const businesses = (input.businesses || []).slice(0, 10).map(b => ({ id: String(b.id), name: clip(b.name, 80) }));
      const kind = ["statement", "receipt", "sms", "email"].includes(input.kind) ? input.kind : "statement";
      const file = input.file && typeof input.file.data === "string" ? input.file : null;
      if (!file && !String(input.text || "").trim()) throw new Error("bad_input: nothing to read");
      if (file && !["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(file.media_type)) throw new Error("bad_input: unsupported file type");
      const sys = SYSTEM_BASE + ` You read personal banking documents for someone whose books are in ${clip(input.base || "QAR", 3)}. Today is ${clip(input.today, 10)}.` +
        " Extract every real money movement (ignore balances, OTPs, adverts, totals and opening/closing balance rows)." +
        (kind === "receipt" ? " This is a receipt or invoice: return ONE transaction for the total actually paid (direction out), with the shop as merchant." : "") +
        " Dates: banks in Qatar and India write day-first (03/11/26 = 3 Nov 2026). Use null if no date is shown — never guess." +
        " Amount is always positive; direction is in (money received) or out (money paid). Keep the currency shown (QAR, INR, USD…)." +
        ` For each line suggest kind (one of ${MONEY_KINDS.join(", ")}) and, where it fits, category_account_id from the person's accounts` +
        " (for spend: an expense account; income: an income account; transfer: the bank/cash/card/savings account the money moved to; debt_payment: the loan or card account)." +
        " Use paid_for_business with for_entity_id only when the text clearly names one of the person's businesses or its suppliers; salary credits are income." +
        " confidence is high only when the text makes it obvious. Put anything the person should check in note (short, plain words)." +
        ' Reply with JSON only: {"transactions":[{"txn_date":"YYYY-MM-DD or null","amount":0,"direction":"in|out","currency":"QAR","description":"short text as on the statement","merchant":"name or null",' +
        '"kind":"…","category_account_id":"id or null","for_entity_id":"id or null","confidence":"high|medium|low","note":"or null"}]}. At most 400 transactions.';
      const ctx = `Accounts: ${JSON.stringify(accounts)}\nBusinesses: ${JSON.stringify(businesses)}`;
      const content = file
        ? [{ type: file.media_type === "application/pdf" ? "document" : "image", source: { type: "base64", media_type: file.media_type, data: file.data } }, { type: "text", text: ctx + "\n\nRead the attached " + kind + "." }]
        : ctx + "\n\nText (" + kind + "):\n" + clip(input.text, 60000);
      return { max_tokens: 16000, system: sys, messages: [{ role: "user", content }] };
    }
    default: throw new Error("bad_action");
  }
}
function jsonFrom(text) { const m = String(text).match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } }
/** Validate and shape model output so the app only ever receives well-formed suggestions. */
export function parseOutput(action, text, input = {}) {
  if (action === "draft_message" || action === "weekly_narrative") return { text: String(text || "").trim().slice(0, 3000) };
  if (action === "action_items") {
    const j = jsonFrom(text); const items = Array.isArray(j && j.items) ? j.items : [];
    return { items: items.filter(i => i && typeof i.title === "string" && i.title.trim()).slice(0, 15).map(i => ({ title: i.title.trim().slice(0, 200), owner: typeof i.owner === "string" && i.owner.trim() ? i.owner.trim().slice(0, 80) : null })) };
  }
  if (action === "categorize") {
    const j = jsonFrom(text), ok = new Set((input.accounts || []).map(a => String(a.id))), lines = new Set((input.lines || []).map(l => String(l.id)));
    const s = Array.isArray(j && j.suggestions) ? j.suggestions : [];
    return { suggestions: s.filter(x => x && lines.has(String(x.id)) && ok.has(String(x.account_id))).map(x => ({ id: String(x.id), account_id: String(x.account_id), confidence: ["high", "medium", "low"].includes(x.confidence) ? x.confidence : "low" })) };
  }
  if (action === "extract_money") {
    const j = jsonFrom(text), list = Array.isArray(j && j.transactions) ? j.transactions : [];
    const accIds = new Set((input.accounts || []).map(a => String(a.id))), bizIds = new Set((input.businesses || []).map(b => String(b.id)));
    const day = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !isNaN(Date.parse(s)) ? s : null;
    return { transactions: list.slice(0, 400).map(t => {
      const amount = Math.round(Math.abs(Number(t && t.amount)) * 100) / 100, kind = MONEY_KINDS.includes(t && t.kind) ? t.kind : null;
      return { txn_date: day(t.txn_date), date_found: !!day(t.txn_date), amount, direction: t.direction === "in" ? "in" : t.direction === "out" ? "out" : null,
        currency: /^[A-Z]{3}$/.test(String(t.currency || "").toUpperCase()) ? String(t.currency).toUpperCase() : null,
        description: clip(t.description || t.merchant || "", 300).trim(), merchant: t.merchant ? clip(t.merchant, 120).trim() : null, kind,
        category_account_id: accIds.has(String(t.category_account_id)) ? String(t.category_account_id) : null,
        for_entity_id: kind && kind.includes("business") && bizIds.has(String(t.for_entity_id)) ? String(t.for_entity_id) : null,
        confidence: ["high", "medium", "low"].includes(t.confidence) ? t.confidence : "low", note: t.note ? clip(t.note, 200) : null };
    }).filter(t => t.amount > 0 && t.direction && t.description) };
  }
  return {};
}
/** Call the Anthropic Messages API. fetchImpl is injectable for tests. */
export async function callModel({ apiKey, model, req, fetchImpl = fetch }) {
  const r = await fetchImpl("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: req.max_tokens, system: req.system, messages: req.messages }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`model_error: ${r.status} ${(j.error && j.error.message) || ""}`.trim());
  const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  return { text, usage: j.usage || {} };
}
