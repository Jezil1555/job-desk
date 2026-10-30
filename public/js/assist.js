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
export async function aiCall(action, input) {
  if (!aiOn()) return { error: "Turn on the AI assistant in Settings → Integrations first." };
  const r = await invoke({ action, input }); statusAt = 0; return r;
}
