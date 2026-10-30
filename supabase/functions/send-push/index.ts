// Sends a phone push for one notification to every device the recipient has registered, and records the outcome on its
// delivery row (sent / failed with a retry time / no device). Called by the database (pg_net) with a shared secret; never by
// browsers. Deployed with verify_jwt = false. Safe to call twice for the same delivery: an already-sent delivery is skipped.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const BACKOFF_MIN = [1, 5, 15, 60, 60]; // wait before attempt 2, 3, 4, 5

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
    const { notification_id, delivery_id } = await req.json();
    let delivery: { id: number; status: string; attempts: number } | null = null;
    if (delivery_id) {
      const { data } = await supabase.from("notification_deliveries").select("id, status, attempts").eq("id", delivery_id).maybeSingle();
      delivery = data;
      if (delivery && delivery.status === "sent") return Response.json({ skipped: "already sent" });
    }
    const { data: n } = await supabase.from("notifications").select("*").eq("id", notification_id).maybeSingle();
    if (!n) return new Response("not found", { status: 404 });

    const { data: subs } = await supabase.from("push_subscriptions").select("*").eq("user_id", n.user_id);
    const payload = JSON.stringify({ title: n.title, body: n.body, url: n.url || "/", tag: n.task_id || n.id, kind: n.kind });
    let sent = 0, removed = 0, lastError = "";
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
          lastError = `${code ?? "network"}: ${String((e as { body?: string }).body ?? e).slice(0, 200)}`;
          console.error("push failed", lastError);
        }
      }
    }
    if (delivery) {
      const attempts = delivery.attempts + 1, now = new Date();
      const patch = sent > 0 ? { status: "sent", attempts, sent_at: now.toISOString(), devices_sent: sent, next_attempt_at: null, last_error: null }
        : (subs ?? []).length === removed ? { status: "no_device", attempts, next_attempt_at: null, last_error: "all devices unsubscribed" }
        : { status: "failed", attempts, last_error: lastError || "unknown", next_attempt_at: new Date(now.getTime() + BACKOFF_MIN[Math.min(attempts - 1, 4)] * 60000).toISOString() };
      await supabase.from("notification_deliveries").update(patch).eq("id", delivery.id);
    }
    return Response.json({ sent, removed });
  } catch (e) {
    console.error("send-push error", String(e));
    return new Response("error", { status: 500 });
  }
});
