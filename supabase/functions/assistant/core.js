// Assistant core: builds prompts and validates model output. The assistant only returns suggestions —
// it has no database access and its output is always shown to the person for review before anything is saved.
export const ACTIONS = ["draft_message", "action_items", "weekly_narrative", "categorize"];
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
