// Read-only calendar feed. GET /functions/v1/calendar-feed?token=… returns text/calendar for the token's owner.
// The token is the only credential (calendar apps can't sign in); it can be revoked or replaced in Settings.
// Deployed with verify_jwt = false. Uses the service role only to call calendar_feed_events(), which checks the token hash.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { buildICS } from "./ics.js";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
  const token = new URL(req.url).searchParams.get("token") || "";
  if (!/^[a-f0-9]{64}$/.test(token)) return new Response("not found", { status: 404 });
  const { data, error } = await supabase.rpc("calendar_feed_events", { p_token: token });
  if (error) { console.error("calendar-feed", error.message); return new Response("error", { status: 500 }); }
  if (!data) return new Response("not found", { status: 404 }); // unknown or revoked link
  const body = buildICS({ events: data.events, tz: data.tz || "Asia/Qatar" });
  return new Response(req.method === "HEAD" ? null : body, {
    headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "private, max-age=900", "content-disposition": 'inline; filename="job-desk.ics"' },
  });
});
