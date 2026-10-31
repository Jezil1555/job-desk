// Pure helpers for Google Calendar sync (no network). Shared by the edge function and unit tests.

export const SCOPES = "openid email https://www.googleapis.com/auth/calendar.events";
export const KINDS = ["due", "followup"];

/** Deterministic Google event id per task and kind (base32hex alphabet: 0-9a-v), so retries never duplicate events. */
export const eventId = (taskId, kind) => "jd" + String(taskId).replace(/-/g, "").toLowerCase() + (kind === "due" ? "d" : "f");

/** Local calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(iso, tz) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const g = t => p.find(x => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}
const nextDay = d => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
const plusMin = (iso, m) => new Date(new Date(iso).getTime() + m * 60000).toISOString();

/**
 * Which events a task should have in this user's calendar right now.
 * task: { id, title, status, deleted_at, due_at, due_all_day, follow_up_at, next_action, waiting_on, owner_id, created_by }
 * Returns { due: eventBody|null, followup: eventBody|null }.
 */
export function desiredEvents(task, userId, { tz = "Asia/Qatar", workspace = "", appUrl = "" } = {}) {
  const none = { due: null, followup: null };
  if (!task || task.deleted_at || ["completed", "cancelled"].includes(task.status)) return none;
  if ((task.owner_id || task.created_by) !== userId) return none;
  const link = appUrl ? `${appUrl.replace(/\/$/, "")}/#/t/${task.id}` : "";
  const base = (kind, lines) => ({
    id: eventId(task.id, kind),
    description: [workspace && `Workspace: ${workspace}`, ...lines, link && `Open in Jezz HQ: ${link}`].filter(Boolean).join("\n"),
    status: "confirmed",
    transparency: "transparent",
    extendedProperties: { private: { jobdesk_task: task.id, jobdesk_kind: kind } },
    source: link ? { title: "Jezz HQ", url: link } : undefined
  });
  const at = (iso, allDay, mins) => allDay
    ? { start: { date: localDate(iso, tz) }, end: { date: nextDay(localDate(iso, tz)) } }
    : { start: { dateTime: iso, timeZone: tz }, end: { dateTime: plusMin(iso, mins), timeZone: tz } };
  const out = { ...none };
  if (task.due_at) out.due = { ...base("due", [task.next_action && `Next: ${task.next_action}`]), summary: `Due: ${task.title}`, ...at(task.due_at, !!task.due_all_day, 30) };
  if (task.follow_up_at) out.followup = { ...base("followup", [task.waiting_on && `Waiting on: ${task.waiting_on}`]), summary: `Follow up: ${task.title}`, ...at(task.follow_up_at, false, 15) };
  return out;
}

/* ---- signed OAuth state: user id + expiry, HMAC-SHA256 with the shared secret ---- */
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}
export async function signState(userId, secret, ttlSec = 600, now = Date.now()) {
  const body = `${userId}.${Math.floor(now / 1000) + ttlSec}`;
  return `${body}.${await hmac(secret, body)}`;
}
export async function verifyState(state, secret, now = Date.now()) {
  const parts = String(state || "").split(".");
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  if (!/^[0-9a-f-]{36}$/.test(uid) || !(Number(exp) > now / 1000)) return null;
  const good = await hmac(secret, `${uid}.${exp}`);
  if (good.length !== sig.length) return null;
  let diff = 0; for (let i = 0; i < good.length; i++) diff |= good.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? uid : null;
}

export function authUrl({ clientId, redirectUri, state, loginHint }) {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPES, access_type: "offline", prompt: "consent", include_granted_scopes: "true", state });
  if (loginHint) q.set("login_hint", loginHint);
  return "https://accounts.google.com/o/oauth2/v2/auth?" + q.toString();
}
/** Email from a Google id_token (already received directly from Google over TLS, so the signature isn't re-checked). */
export function emailFromIdToken(idToken) {
  try { const p = idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"); return JSON.parse(atob(p + "=".repeat((4 - p.length % 4) % 4))).email || null; } catch { return null; }
}
