// Application state and a tiny event bus.
export const state = {
  user: null, me: null, prefs: {}, tz: "Asia/Qatar",
  workspaces: [], members: [], profiles: {}, projects: [], health: [], milestones: [],
  tasks: [], deps: [], followUps: [], contacts: [], notifications: [], lastComments: [], activity: [],
  taskById: new Map(), healthById: new Map(),
  loaded: false, route: { name: "home", params: {} },
  ui: { filters: {}, sort: null, mode: null, selected: new Set(), selecting: false, search: "", homeWs: "", calMode: "month", calCursor: null }
};

const handlers = {};
export function on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); }
export function emit(evt, payload) { (handlers[evt] || []).forEach(fn => fn(payload)); }

// Convenience lookups
export const wsById = id => state.workspaces.find(w => w.id === id);
export const projectById = id => state.projects.find(p => p.id === id);
export const contactById = id => state.contacts.find(c => c.id === id);
export const followUpById = id => state.followUps.find(f => f.id === id);
export const membersOf = wsId => state.members.filter(m => m.workspace_id === wsId);
export const roleIn = wsId => (state.members.find(m => m.workspace_id === wsId && m.user_id === state.user.id) || {}).role;
export const canWrite = wsId => ["owner", "member"].includes(roleIn(wsId));
export const isWsOwner = wsId => (wsById(wsId) || {}).owner_id === state.user.id;
export const activeWorkspaces = () => state.workspaces.filter(w => !w.archived);
export function nameOf(uid) {
  if (!uid) return "Unassigned";
  const p = state.profiles[uid];
  return p ? (p.display_name || p.email.split("@")[0]) : "Someone";
}
export const shortName = uid => (state.user && uid === state.user.id ? "You" : nameOf(uid));
export const subtasksOf = id => state.tasks.filter(t => t.parent_id === id && !t.deleted_at);
