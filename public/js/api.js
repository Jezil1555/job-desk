// Data access: one Supabase client, one loader, and small write helpers.
// Every write waits for the server before the UI reports success.
import { friendlyError } from "./util.js";
import { state, emit } from "./store.js";

const cfg = window.JOBDESK_CONFIG;
export const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

const DAY = 86400000;

/** Load everything the signed-in user can see. Completed tasks older than 120 days load on demand. */
export async function loadAll() {
  const uid = state.user.id;
  const since = new Date(Date.now() - 120 * DAY).toISOString();
  const q = await Promise.all([
    sb.from("workspaces").select("*").order("sort").order("created_at"),
    sb.from("workspace_members").select("workspace_id, user_id, role"),
    sb.from("profiles").select("id, email, display_name, timezone, prefs"),
    sb.from("projects").select("*").order("created_at"),
    sb.from("project_health").select("*"),
    sb.from("milestones").select("*").order("planned_date", { nullsFirst: false }),
    sb.from("tasks").select("*").is("deleted_at", null).or(`status.not.in.(completed,cancelled),completed_at.gte."${since}",updated_at.gte."${since}"`).limit(5000),
    sb.from("task_dependencies").select("task_id, depends_on_id"),
    sb.from("follow_ups").select("*").or(`status.in.(open,escalated),closed_at.gte."${since}"`).order("next_follow_up_at", { nullsFirst: false }),
    sb.from("contacts").select("*").eq("archived", false).order("name"),
    sb.from("notifications").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(80),
    sb.from("task_comments").select("id, task_id, author_id, body, kind, created_at").eq("kind", "note").order("created_at", { ascending: false }).limit(400),
    sb.from("activity").select("*").order("created_at", { ascending: false }).limit(60),
    sb.from("notes").select("id, workspace_id, kind, title, body, tags, meeting_date, attendees, decision, rationale, decision_status, decided_on, pinned, created_by, created_at, updated_at").is("deleted_at", null).order("updated_at", { ascending: false }).limit(400),
    sb.from("documents").select("*").is("deleted_at", null).order("created_at", { ascending: false }).limit(400),
    sb.from("record_links").select("*"),
    sb.from("goals").select("*").order("created_at"),
    sb.from("habits").select("*").order("sort").order("created_at"),
    sb.from("habit_logs").select("habit_id, log_date, value, note").gte("log_date", new Date(Date.now() - 400 * DAY).toISOString().slice(0, 10)),
    sb.from("health_logs").select("*").gte("log_date", new Date(Date.now() - 400 * DAY).toISOString().slice(0, 10)).order("log_date", { ascending: false }),
    sb.from("weekly_reviews").select("*").order("week_start", { ascending: false }).limit(26)
  ]);
  const err = q.find(r => r.error);
  if (err) throw err.error;
  const [ws, mem, prof, proj, health, ms, tasks, deps, fus, contacts, notifs, comments, activity, notesK, docs, links, goals, habits, habitLogs, healthLogs, reviews] = q.map(r => r.data || []);
  Object.assign(state, {
    workspaces: ws, members: mem, projects: proj, health, milestones: ms, tasks, deps, followUps: fus, contacts,
    notifications: notifs, lastComments: comments, activity, notes: notesK, documents: docs, links, goals, habits, habitLogs, healthLogs, reviews,
    loaded: true, loadedAt: Date.now()
  });
  state.profiles = {}; prof.forEach(p => (state.profiles[p.id] = p));
  state.me = state.profiles[uid] || { id: uid, email: state.user.email, display_name: "", timezone: "Asia/Qatar", prefs: {} };
  state.prefs = Object.assign({ dashboard_hidden: [], saved_views: [], default_ws: null, task_sort: "smart", task_mode: "list" }, state.me.prefs || {});
  state.tz = state.me.timezone || "Asia/Qatar";
  reindex();
  emit("data");
}

export function reindex() {
  state.taskById = new Map(state.tasks.map(t => [t.id, t]));
  state.healthById = new Map(state.health.map(h => [h.project_id, h]));
}

/** Older completed tasks for the Completed view. */
export async function loadOlderCompleted() {
  const since = new Date(Date.now() - 120 * DAY).toISOString();
  const { data, error } = await sb.from("tasks").select("*").is("deleted_at", null).in("status", ["completed", "cancelled"]).lt("completed_at", since).order("completed_at", { ascending: false }).limit(500);
  if (error) throw error;
  const have = new Set(state.tasks.map(t => t.id));
  data.forEach(t => { if (!have.has(t.id)) state.tasks.push(t); });
  reindex(); emit("data");
  return data.length;
}

/** Run a write; returns {data} or {error: friendly message}. Never claims success early. */
export async function run(promise) {
  try {
    const { data, error } = await promise;
    if (error) return { error: friendlyError(error), raw: error };
    return { data };
  } catch (e) {
    return { error: friendlyError(e), raw: e };
  }
}

export async function updateTask(id, fields) {
  const r = await run(sb.from("tasks").update(fields).eq("id", id).select().single());
  if (r.data) { const i = state.tasks.findIndex(t => t.id === id); if (i >= 0) state.tasks[i] = r.data; reindex(); emit("data"); refreshHealthSoon(); }
  return r;
}
export async function createTask(row) {
  const r = await run(sb.from("tasks").insert(row).select().single());
  if (r.data) { state.tasks.push(r.data); reindex(); emit("data"); refreshHealthSoon(); }
  return r;
}
export async function reopenTask(id, reason, status = "in_progress") {
  const r = await run(sb.rpc("reopen_task", { p_task: id, p_reason: reason, p_status: status }));
  if (!r.error) await refreshTask(id);
  return r;
}
export async function requestReview(id, note) {
  const r = await run(sb.rpc("request_task_review", { p_task: id, p_note: note || null }));
  if (!r.error) await refreshTask(id);
  return r;
}
export async function reviewTask(id, decision, note) {
  const r = await run(sb.rpc("review_task", { p_task: id, p_decision: decision, p_note: note || null }));
  if (!r.error) await refreshTask(id);
  return r;
}
export async function refreshTask(id) {
  const { data } = await sb.from("tasks").select("*").eq("id", id).maybeSingle();
  if (data) { const i = state.tasks.findIndex(t => t.id === id); if (i >= 0) state.tasks[i] = data; else state.tasks.push(data); reindex(); emit("data"); }
}

let healthTimer;
export function refreshHealthSoon() {
  clearTimeout(healthTimer);
  healthTimer = setTimeout(async () => {
    const { data } = await sb.from("project_health").select("*");
    if (data) { state.health = data; reindex(); emit("data"); }
  }, 500);
}

export async function savePrefs(patch) {
  state.prefs = { ...state.prefs, ...patch };
  const r = await run(sb.from("profiles").update({ prefs: state.prefs }).eq("id", state.user.id));
  return r;
}

let channel, reloadTimer;
export function subscribe(onNotification) {
  if (channel) sb.removeChannel(channel);
  const reload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => loadAll().catch(() => {}), 400); };
  channel = sb.channel("cc-" + state.user.id);
  ["workspaces", "workspace_members", "projects", "milestones", "tasks", "task_dependencies", "task_comments", "follow_ups", "follow_up_logs", "contacts", "notes", "documents", "record_links"]
    .forEach(t => channel.on("postgres_changes", { event: "*", schema: "public", table: t }, reload));
  channel.on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${state.user.id}` }, p => {
    if (!state.notifications.some(n => n.id === p.new.id)) state.notifications.unshift(p.new);
    emit("notifications"); onNotification && onNotification(p.new);
  });
  channel.subscribe();
}
export function unsubscribe() { if (channel) sb.removeChannel(channel); channel = null; }

/* ---------- Phase 2 helpers ---------- */
/** Records linked to/from an entity. Returns [{type, id, link}] for the other side. */
export function linksFor(type, id) {
  const out = [];
  for (const l of state.links) {
    if (l.to_type === type && l.to_id === id) out.push({ type: l.from_type, id: l.from_id, link: l });
    else if (l.from_type === type && l.from_id === id) out.push({ type: l.to_type, id: l.to_id, link: l });
  }
  return out;
}
export async function addLink(workspace_id, from_type, from_id, to_type, to_id) {
  if (state.links.some(l => l.from_type === from_type && l.from_id === from_id && l.to_type === to_type && l.to_id === to_id)) return { data: null };
  const r = await run(sb.from("record_links").insert({ workspace_id, from_type, from_id, to_type, to_id }).select().single());
  if (r.data) { state.links.push(r.data); emit("data"); }
  return r;
}
export async function removeLink(linkId) {
  const r = await run(sb.from("record_links").delete().eq("id", linkId));
  if (!r.error) { state.links = state.links.filter(l => l.id !== linkId); emit("data"); }
  return r;
}

/** Upload a file to private storage and record it. Removes the stored object if the record can't be saved. */
export async function uploadDocument(file, { workspace_id, title, category = "other", tags = [], notes = null }, safeName) {
  if (file.size > 25 * 1024 * 1024) return { error: "Files can be up to 25 MB." };
  const id = crypto.randomUUID();
  const path = `${workspace_id}/${id}/${safeName(file.name)}`;
  const up = await run(sb.storage.from("documents").upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false }));
  if (up.error) return up;
  const r = await run(sb.from("documents").insert({ id, workspace_id, title: title || file.name, kind: "file", storage_path: path, mime_type: file.type || null, size_bytes: file.size, category, tags, notes }).select().single());
  if (r.error) { await sb.storage.from("documents").remove([path]); return r; }
  state.documents.unshift(r.data); emit("data");
  return r;
}
/** Short-lived signed URL (10 minutes) — files are never public. */
export async function documentUrl(doc) {
  if (doc.kind === "link") return { data: doc.url };
  const r = await run(sb.storage.from("documents").createSignedUrl(doc.storage_path, 600));
  return r.error ? r : { data: r.data.signedUrl };
}
export async function deleteDocument(doc) {
  const r = await run(sb.from("documents").delete().eq("id", doc.id));
  if (r.error) return r;
  if (doc.kind === "file") await sb.storage.from("documents").remove([doc.storage_path]);
  state.documents = state.documents.filter(d => d.id !== doc.id);
  state.links = state.links.filter(l => !(l.from_type === "document" && l.from_id === doc.id));
  emit("data");
  return r;
}
