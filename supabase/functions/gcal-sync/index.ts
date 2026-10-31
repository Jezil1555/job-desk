// Live Google Calendar sync for tasks. Deployed with verify_jwt = false; every route checks its own credentials.
//   POST /gcal-sync            {action: status|start|resync|disconnect}  — signed-in user (Authorization: Bearer <session>)
//   GET  /gcal-sync/callback   ?code&state                              — Google's redirect after the user agrees
//   POST /gcal-sync/task       {task_id, users}                         — the database trigger (x-gcal-secret)
// Needs secrets GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Optional APP_URL (default the Render site).
// Only calendar events are touched (scope calendar.events); refresh tokens are stored in a table no client can read.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { KINDS, eventId, desiredEvents, signState, verifyState, authUrl, emailFromIdToken } from "./core.js";

const SB_URL = Deno.env.get("SUPABASE_URL")!, SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") || "", CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";
const APP_URL = (Deno.env.get("APP_URL") || "https://job-desk-u8nj.onrender.com").replace(/\/$/, "");
const REDIRECT = `${SB_URL}/functions/v1/gcal-sync/callback`;
const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, apikey, content-type, x-client-info", "access-control-allow-methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "content-type": "application/json" } });
const back = (q: string) => new Response(null, { status: 302, headers: { location: `${APP_URL}/#/settings?gcal=${q}` } });

let secret: string | null = null;
async function getSecret() {
  if (secret) return secret;
  const { data, error } = await admin.rpc("get_gcal_config");
  if (error) throw error;
  secret = (data as Record<string, string>).gcal_secret; return secret!;
}

/* ---------------- Google API ---------------- */
class GoogleAuthError extends Error {}
const tokenCache = new Map<string, { token: string; exp: number }>();
async function accessToken(uid: string) {
  const c = tokenCache.get(uid); if (c && c.exp > Date.now() + 60000) return c.token;
  const { data: t } = await admin.from("gcal_tokens").select("refresh_token").eq("user_id", uid).maybeSingle();
  if (!t) throw new GoogleAuthError("Not connected");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: t.refresh_token, grant_type: "refresh_token" }) });
  const j = await r.json();
  if (!r.ok) throw (j.error === "invalid_grant" ? new GoogleAuthError("Google access was removed or expired — reconnect Google Calendar in Settings.") : new Error("token " + r.status + " " + (j.error || "")));
  tokenCache.set(uid, { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
  return j.access_token as string;
}
async function gapi(uid: string, method: string, path: string, body?: unknown) {
  const tok = await accessToken(uid);
  const r = await fetch("https://www.googleapis.com/calendar/v3" + path, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { tokenCache.delete(uid); throw new GoogleAuthError("Google access was removed — reconnect Google Calendar in Settings."); }
  return r;
}
const calPath = (cal: string) => `/calendars/${encodeURIComponent(cal)}/events`;
/** Create or update an event with a fixed id (PATCH; if missing, INSERT; if the id exists but was deleted, PATCH restores it). */
async function upsertEvent(uid: string, cal: string, ev: Record<string, unknown>) {
  const id = ev.id as string;
  let r = await gapi(uid, "PATCH", `${calPath(cal)}/${id}`, ev);
  if (r.status === 404 || r.status === 410) {
    r = await gapi(uid, "POST", calPath(cal), ev);
    if (r.status === 409) r = await gapi(uid, "PATCH", `${calPath(cal)}/${id}`, ev);
  }
  if (!r.ok) throw new Error(`calendar ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
async function deleteEvent(uid: string, cal: string, id: string) {
  const r = await gapi(uid, "DELETE", `${calPath(cal)}/${id}`);
  if (!r.ok && r.status !== 404 && r.status !== 410) throw new Error(`calendar delete ${r.status}`);
}

/* ---------------- sync one task for one user ---------------- */
async function syncTask(taskId: string, uid: string, sync: { calendar_id: string }, tz: string) {
  const { data: task } = await admin.from("tasks").select("id, title, status, deleted_at, due_at, due_all_day, follow_up_at, next_action, waiting_on, owner_id, created_by, workspace_id").eq("id", taskId).maybeSingle();
  let ws = "";
  if (task) { const { data: w } = await admin.from("workspaces").select("name").eq("id", task.workspace_id).maybeSingle(); ws = w?.name || ""; }
  const want = desiredEvents(task, uid, { tz, workspace: ws, appUrl: APP_URL }) as Record<string, Record<string, unknown> | null>;
  for (const k of KINDS) {
    if (want[k]) await upsertEvent(uid, sync.calendar_id, want[k]!);
    else await deleteEvent(uid, sync.calendar_id, eventId(taskId, k));
  }
}
async function mark(uid: string, err: unknown) {
  if (!err) return admin.from("calendar_sync").update({ status: "connected", last_error: null, last_synced_at: new Date().toISOString() }).eq("user_id", uid);
  const auth = err instanceof GoogleAuthError;
  console.error("gcal", uid, String(err));
  return admin.from("calendar_sync").update({ status: auth ? "error" : "connected", last_error: String((err as Error).message || err).slice(0, 300) }).eq("user_id", uid);
}
async function userCtx(uid: string) {
  const [{ data: s }, { data: p }] = await Promise.all([admin.from("calendar_sync").select("*").eq("user_id", uid).maybeSingle(), admin.from("profiles").select("timezone").eq("id", uid).maybeSingle()]);
  return { sync: s, tz: p?.timezone || "Asia/Qatar" };
}
async function resyncAll(uid: string) {
  const { sync, tz } = await userCtx(uid); if (!sync) return { synced: 0 };
  const { data: all } = await admin.from("tasks").select("id, due_at, follow_up_at").or(`owner_id.eq.${uid},and(owner_id.is.null,created_by.eq.${uid})`).is("deleted_at", null)
    .not("status", "in", "(completed,cancelled)");
  const tasks = (all || []).filter(t => t.due_at || t.follow_up_at);
  let n = 0, err: unknown = null;
  for (const t of tasks) { try { await syncTask(t.id, uid, sync, tz); n++; } catch (e) { err = e; if (e instanceof GoogleAuthError) break; } }
  await mark(uid, err);
  return { synced: n, error: err ? String((err as Error).message) : null };
}

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname;
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    /* -------- database trigger -------- */
    if (path.endsWith("/task")) {
      if (req.method !== "POST" || req.headers.get("x-gcal-secret") !== (await getSecret())) return new Response("forbidden", { status: 403 });
      const { task_id, users } = await req.json();
      for (const uid of (users || []) as string[]) {
        const { sync, tz } = await userCtx(uid);
        if (!sync || sync.status !== "connected") continue;
        try { await syncTask(task_id, uid, sync, tz); await mark(uid, null); } catch (e) { await mark(uid, e); }
      }
      return json({ ok: true });
    }
    /* -------- Google redirect -------- */
    if (path.endsWith("/callback")) {
      const q = new URL(req.url).searchParams;
      if (q.get("error")) return back("cancelled");
      const uid = await verifyState(q.get("state"), await getSecret());
      if (!uid || !q.get("code")) return back("expired");
      const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: q.get("code")!, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT, grant_type: "authorization_code" }) });
      const j = await r.json();
      if (!r.ok || !j.refresh_token) { console.error("gcal callback", r.status, j.error); return back("failed"); }
      if (!String(j.scope || "").includes("calendar.events")) return back("noscope");
      await admin.from("gcal_tokens").upsert({ user_id: uid, refresh_token: j.refresh_token, updated_at: new Date().toISOString() });
      await admin.from("calendar_sync").upsert({ user_id: uid, google_email: emailFromIdToken(j.id_token || ""), calendar_id: "primary", status: "connected", last_error: null, connected_at: new Date().toISOString() });
      tokenCache.set(uid, { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
      await resyncAll(uid);
      return back("connected");
    }
    /* -------- signed-in user actions -------- */
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(jwt);
    if (!u?.user) return json({ error: "Sign in again." }, 401);
    const uid = u.user.id, configured = !!(CLIENT_ID && CLIENT_SECRET);
    const { action } = await req.json().catch(() => ({ action: "" }));
    if (action === "status") { const { sync } = await userCtx(uid); return json({ configured, redirect_uri: REDIRECT, sync: sync ? { google_email: sync.google_email, status: sync.status, last_error: sync.last_error, last_synced_at: sync.last_synced_at, connected_at: sync.connected_at } : null }); }
    if (!configured) return json({ error: "Google Calendar isn't set up yet: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets." }, 503);
    if (action === "start") return json({ url: authUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT, state: await signState(uid, await getSecret()), loginHint: u.user.email }) });
    if (action === "resync") return json(await resyncAll(uid));
    if (action === "disconnect") {
      // remove the events Jezz HQ created, then forget the token
      const { sync } = await userCtx(uid);
      let removed = 0;
      if (sync) {
        const { data: tasks } = await admin.from("tasks").select("id").or(`owner_id.eq.${uid},created_by.eq.${uid}`);
        try { for (const t of tasks || []) for (const k of KINDS) { await deleteEvent(uid, sync.calendar_id, eventId(t.id, k)); removed++; } } catch (e) { console.error("gcal disconnect cleanup", String(e)); }
        const { data: tk } = await admin.from("gcal_tokens").select("refresh_token").eq("user_id", uid).maybeSingle();
        if (tk) await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(tk.refresh_token), { method: "POST" }).catch(() => {});
      }
      await admin.from("gcal_tokens").delete().eq("user_id", uid);
      await admin.from("calendar_sync").delete().eq("user_id", uid);
      tokenCache.delete(uid);
      return json({ ok: true, removed });
    }
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    console.error("gcal-sync", String(e));
    return path.endsWith("/callback") ? back("failed") : json({ error: "Calendar sync failed. Try again in a moment." }, 500);
  }
});
