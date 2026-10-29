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
    sb.from("activity").select("*").order("created_at", { ascending: false }).limit(60)
  ]);
  const err = q.find(r => r.error);
  if (err) throw err.error;
  const [ws, mem, prof, proj, health, ms, tasks, deps, fus, contacts, notes, comments, activity] = q.map(r => r.data || []);
  Object.assign(state, {
    workspaces: ws, members: mem, projects: proj, health, milestones: ms, tasks, deps, followUps: fus, contacts,
    notifications: notes, lastComments: comments, activity, loaded: true, loadedAt: Date.now()
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
  ["workspaces", "workspace_members", "projects", "milestones", "tasks", "task_dependencies", "task_comments", "follow_ups", "follow_up_logs", "contacts"]
    .forEach(t => channel.on("postgres_changes", { event: "*", schema: "public", table: t }, reload));
  channel.on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${state.user.id}` }, p => {
    if (!state.notifications.some(n => n.id === p.new.id)) state.notifications.unshift(p.new);
    emit("notifications"); onNotification && onNotification(p.new);
  });
  channel.subscribe();
}
export function unsubscribe() { if (channel) sb.removeChannel(channel); channel = null; }
