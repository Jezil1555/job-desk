// Sends a phone push for one notification row to every device the recipient has registered.
// Called by the database (pg_net) with a shared secret; never by browsers. Deployed with verify_jwt = false.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

let config: Record<string, string> | null = null;
async function getConfig() {
  if (config) return config;
  const { data, error } = await supabase.rpc("get_push_config");
  if (error) throw error;
  config = data as Record<string, string>;
  webpush.setVapidDetails("https://job-desk-u8nj.onrender.com", config.vapid_public, config.vapid_private);
  return config;
}

Deno.serve(async (req) => {
  try {
    const cfg = await getConfig();
    if (req.method !== "POST" || req.headers.get("x-push-secret") !== cfg.push_secret) {
      return new Response("forbidden", { status: 403 });
    }
    const { notification_id } = await req.json();
    const { data: n } = await supabase.from("notifications").select("*").eq("id", notification_id).maybeSingle();
    if (!n) return new Response("not found", { status: 404 });

    const { data: subs } = await supabase.from("push_subscriptions").select("*").eq("user_id", n.user_id);
    const payload = JSON.stringify({ title: n.title, body: n.body, url: n.url || "/", tag: n.task_id || n.id, kind: n.kind });
    let sent = 0, removed = 0;
    for (const s of subs ?? []) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400, urgency: "high" });
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) {
          await supabase.from("push_subscriptions").delete().eq("id", s.id);
          removed++;
        } else {
          console.error("push failed", code, (e as { body?: string }).body ?? String(e));
        }
      }
    }
    return Response.json({ sent, removed });
  } catch (e) {
    console.error("send-push error", String(e));
    return new Response("error", { status: 500 });
  }
});
