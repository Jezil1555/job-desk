// AI assistant. POST {action, input} with the user's session. Opt-in per user; returns suggestions only.
// Needs the ANTHROPIC_API_KEY secret (Supabase → Edge Functions → Secrets). Optional: AI_MODEL, AI_DAILY_LIMIT.
// Nothing is stored except a usage row (action, token counts) — never the content.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { ACTIONS, buildRequest, parseOutput, callModel } from "./core.js";

const URL_ = Deno.env.get("SUPABASE_URL")!, SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, apikey, content-type, x-client-info", "access-control-allow-methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(jwt);
  if (!u || !u.user) return json({ error: "Sign in again." }, 401);
  const uid = u.user.id;
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") || "", model = Deno.env.get("AI_MODEL") || "claude-sonnet-5-5", limit = Number(Deno.env.get("AI_DAILY_LIMIT") || 60);
  const { data: prof } = await admin.from("profiles").select("prefs").eq("id", uid).maybeSingle();
  const enabled = !!(prof && prof.prefs && prof.prefs.ai_enabled);
  const since = new Date(Date.now() - 86400000).toISOString();
  const { count } = await admin.from("ai_usage").select("id", { count: "exact", head: true }).eq("user_id", uid).gte("created_at", since);
  let body: { action?: string; input?: Record<string, unknown> } = {};
  try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400); }
  if (body.action === "status") return json({ configured: !!apiKey, enabled, used_24h: count || 0, limit, model });
  if (!apiKey) return json({ error: "The AI assistant isn't set up yet: add an ANTHROPIC_API_KEY secret to the project." }, 503);
  if (!enabled) return json({ error: "Turn on the AI assistant in Settings first." }, 403);
  if ((count || 0) >= limit) return json({ error: `Daily AI limit reached (${limit} requests in 24 hours).` }, 429);
  if (!ACTIONS.includes(body.action || "")) return json({ error: "Unknown action." }, 400);
  let reqb;
  try { reqb = buildRequest(body.action, body.input || {}); } catch (e) { return json({ error: String((e as Error).message) }, 400); }
  try {
    const out = await callModel({ apiKey, model, req: reqb });
    await admin.from("ai_usage").insert({ user_id: uid, action: body.action, input_tokens: out.usage.input_tokens ?? null, output_tokens: out.usage.output_tokens ?? null, ok: true });
    return json({ ...parseOutput(body.action!, out.text, body.input || {}), model });
  } catch (e) {
    await admin.from("ai_usage").insert({ user_id: uid, action: body.action, ok: false });
    console.error("assistant", String(e));
    return json({ error: "The AI service didn't respond properly. Try again in a moment." }, 502);
  }
});
