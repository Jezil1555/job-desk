// Client for the AI assistant edge function. Suggestions only — callers must show results for review before saving anything.
import { sb } from "./api.js";
import { state } from "./store.js";

let statusCache = null, statusAt = 0;
export const aiOn = () => !!state.prefs.ai_enabled;
async function invoke(body) {
  const { data, error } = await sb.functions.invoke("assistant", { body });
  if (error) {
    let msg = "The AI assistant couldn't be reached.";
    try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (e) {}
    return { error: msg };
  }
  if (data && data.error) return { error: data.error };
  return { data };
}
export async function aiStatus(force = false) {
  if (!force && statusCache && Date.now() - statusAt < 60000) return statusCache;
  const r = await invoke({ action: "status" });
  statusCache = r.error ? { error: r.error } : r.data; statusAt = Date.now();
  return statusCache;
}
export async function aiCall(action, input, context) {
  if (!aiOn()) return { error: "Turn on the AI assistant in Settings → Integrations first." };
  const r = await invoke({ action, input, context }); statusAt = 0; return r;
}
/** Record what the person did with an AI suggestion: accepted as-is, accepted with edits, or rejected. Best-effort; never blocks the work. */
export async function aiDecision(proposalId, decision, detail) {
  if (!proposalId) return;
  try { await sb.rpc("record_ai_decision", { p_proposal: proposalId, p_decision: decision, p_detail: detail || null }); } catch (e) { /* logged server-side only when it succeeds */ }
}
/** Compare final text with the AI text: same → accepted, changed → edited. */
export const textDecision = (aiText, finalText) => (String(aiText || "").trim() === String(finalText || "").trim() ? "accepted" : "edited");
