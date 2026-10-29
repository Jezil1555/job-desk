/* Job Desk v2 — shared projects, assignments, priorities, dashboard, alerts and push. Plain JS + Supabase. */
(() => {
  "use strict";

  const cfg = window.JOBDESK_CONFIG;
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  const STATUS = { todo: "To do", doing: "In progress", waiting: "Waiting", done: "Done" };
  const PRIO = { high: "Immediate", medium: "Moderate", low: "Not urgent" };
  const PRIO_HINT = { high: "Do now", medium: "This week", low: "When free" };
  const COLORS = ["#1f6aa0", "#6b4b8a", "#2e7d6b", "#c0612b", "#b3352b", "#8a6d1f", "#3d5a80", "#5f6b78"];
  const ICON = {
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>',
    people: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8.5" r="3.3"/><path d="M3 19.5c.9-3 3.2-4.6 6-4.6s5.1 1.6 6 4.6"/><circle cx="17" cy="9.5" r="2.6"/><path d="M16.5 14.6c2.3.1 4 1.5 4.6 3.9"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
    bell: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15L6 16z"/><path d="M10 20.5a2 2 0 004 0"/></svg>',
    clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.3-3.6 4.2-5.4 7.5-5.4s6.2 1.8 7.5 5.4"/></svg>',
    note: '<svg viewBox="0 0 24 24"><path d="M5 5h14v10l-4 4H5z"/><path d="M15 19v-4h4"/></svg>',
    done: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M8 12.5l3 3 5-6"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/></svg>'
  };
  const $ = id => document.getElementById(id);

  const state = {
    user: null, me: null,
    projects: [], members: [], profiles: {}, tasks: [], updates: [], notifications: [],
    route: { name: "home" },
    projectTab: {}, taskFilter: "mine", search: "",
    sheet: null, loaded: false, authMode: "signin", recovery: false,
    overdueSeen: new Set()
  };

  /* ---------- helpers ---------- */
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = n => String(n).padStart(2, "0");
  const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const dayDiff = d => Math.round((startOfDay(d) - startOfDay(new Date())) / 86400000);
  const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const fmtDay = d => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const fmtStamp = ts => {
    const d = new Date(ts), n = dayDiff(d);
    if (n === 0) return `Today ${hhmm(d)}`;
    if (n === -1) return `Yesterday ${hhmm(d)}`;
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + " " + hhmm(d);
  };
  const ago = ts => {
    const s = (Date.now() - new Date(ts)) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    if (s < 604800) return Math.floor(s / 86400) + "d ago";
    return new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  };
  const projectOf = id => state.projects.find(p => p.id === id);
  const taskOf = id => state.tasks.find(t => t.id === id);
  const nameOf = uid => { const p = state.profiles[uid]; return p ? (p.display_name || p.email.split("@")[0]) : "Someone"; };
  const shortName = uid => uid === state.user.id ? "You" : nameOf(uid);
  const initials = uid => nameOf(uid).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "?";
  const hue = uid => { let h = 0; for (const c of String(uid)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const avatar = (uid, cls = "") => `<span class="av ${cls}" style="--h:${hue(uid)}" title="${esc(nameOf(uid))}">${esc(initials(uid))}</span>`;
  const membersOf = pid => state.members.filter(m => m.project_id === pid);
  const isOwner = pid => { const p = projectOf(pid); return p && p.user_id === state.user.id; };
  const activeIds = () => new Set(state.projects.filter(p => !p.archived).map(p => p.id));
  const isMine = t => t.assignee_id === state.user.id || (!t.assignee_id && t.user_id === state.user.id);
  const isOverdue = t => t.status !== "done" && t.due_at && new Date(t.due_at) < new Date();

  function dueInfo(t) {
    if (!t.due_at) return { cls: "", label: "" };
    const d = new Date(t.due_at), n = dayDiff(d), time = t.due_all_day ? "" : " " + hhmm(d);
    if (t.status === "done") return { cls: "", label: fmtDay(d) };
    if (d < new Date()) return { cls: "over", label: n < 0 ? `Overdue ${-n}d` : `Overdue${time}` };
    if (n === 0) return { cls: "soon", label: "Today" + time };
    if (n === 1) return { cls: "soon", label: "Tomorrow" + time };
    if (n <= 3) return { cls: "soon", label: fmtDay(d) + time };
    return { cls: "", label: fmtDay(d) + time };
  }

  const PRANK = { high: 0, medium: 1, low: 2 };
  function sortTasks(list) {
    return list.slice().sort((a, b) => {
      const ad = a.status === "done", bd = b.status === "done";
      if (ad !== bd) return ad ? 1 : -1;
      if (ad && bd) return (b.done_at || "").localeCompare(a.done_at || "");
      const da = a.due_at || "9999", db = b.due_at || "9999";
      if (da !== db) return da < db ? -1 : 1;
      if (a.priority !== b.priority) return PRANK[a.priority] - PRANK[b.priority];
      return (a.sort || 0) - (b.sort || 0);
    });
  }

  let toastTimer;
  function toast(msg, action) {
    const el = $("toast");
    el.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button type="button">${esc(action.label)}</button>` : "");
    if (action) el.querySelector("button").onclick = () => { el.hidden = true; action.run(); };
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), action ? 6000 : 2600);
  }
  function fail(err, msg) {
    console.error(err);
    toast(msg || (navigator.onLine ? "That didn't save. Try again." : "You're offline. Reconnect and try again."));
    loadAll();
  }

  /* ---------- data ---------- */
  async function loadAll() {
    const uid = state.user.id;
    const [p, m, pr, t, u, n] = await Promise.all([
      sb.from("projects").select("*").order("sort").order("created_at"),
      sb.from("project_members").select("project_id, user_id, role"),
      sb.from("profiles").select("id, email, display_name"),
      sb.from("tasks").select("*"),
      sb.from("task_updates").select("id, task_id, author_id, body, kind, created_at").order("created_at", { ascending: false }).limit(400),
      sb.from("notifications").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(80)
    ]);
    if (p.error || t.error) { if (!state.loaded) renderLoadError(); return; }
    state.projects = p.data; state.members = m.data || []; state.tasks = t.data; state.updates = u.data || []; state.notifications = n.data || [];
    state.profiles = {}; (pr.data || []).forEach(x => (state.profiles[x.id] = x));
    state.me = state.profiles[uid] || { id: uid, email: state.user.email, display_name: "" };
    const first = !state.loaded;
    state.loaded = true;
    render();
    if (state.sheet) renderSheet();
    if (first) { maybeShowOverdue(); openFromHash(); ensurePushSubscription(); }
  }

  const lastNote = tid => state.updates.find(u => u.task_id === tid && u.kind === "note");

  let reloadTimer;
  const scheduleReload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(loadAll, 350); };
  let channel;
  function subscribe() {
    if (channel) sb.removeChannel(channel);
    channel = sb.channel("jobdesk-" + state.user.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, scheduleReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "project_members" }, scheduleReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, scheduleReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "task_updates" }, scheduleReload)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${state.user.id}` }, payload => {
        const n = payload.new;
        if (!state.notifications.some(x => x.id === n.id)) state.notifications.unshift(n);
        updateBadge();
        if (document.visibilityState === "visible") toast(n.title, n.url ? { label: "View", run: () => goUrl(n.url, n.id) } : null);
        scheduleReload();
      })
      .subscribe();
  }

  async function patchTask(id, fields, logText) {
    const t = taskOf(id);
    if (!t) return;
    Object.assign(t, fields);
    if (fields.status === "done") t.done_at = new Date().toISOString();
    render();
    const { error } = await sb.from("tasks").update(fields).eq("id", id);
    if (error) return fail(error, /Assignee/.test(error.message) ? "That person isn't a member of this project." : null);
    if (logText) await addUpdate(id, logText, "status");
  }

  async function addUpdate(taskId, body, kind = "note") {
    const { data, error } = await sb.from("task_updates").insert({ task_id: taskId, body, kind }).select().single();
    if (error) return fail(error);
    state.updates.unshift(data);
    render();
    if (state.sheet && state.sheet.kind === "task" && state.sheet.id === taskId) renderSheet();
  }

  function toggleDone(id) {
    const t = taskOf(id);
    if (!t) return;
    const done = t.status !== "done", prev = t.status;
    patchTask(id, { status: done ? "done" : "todo" }, done ? "Marked done" : "Reopened");
    if (done) toast("Task done", { label: "Undo", run: () => patchTask(id, { status: prev }, "Reopened") });
  }

  /* ---------- routing ---------- */
  function parseRoute() {
    const h = location.hash.replace(/^#\/?/, "").split("?")[0];
    const [a, b] = h.split("/");
    if (["tasks", "projects", "alerts", "me", "search"].includes(a)) return { name: a };
    if (a === "p" && b) return { name: "project", id: b };
    return { name: "home" };
  }
  function openFromHash() {
    const q = location.hash.split("?")[1];
    if (!q) return;
    const tid = new URLSearchParams(q).get("task");
    if (tid && taskOf(tid)) openTask(tid);
  }
  function goUrl(url, notifId) {
    if (notifId) markRead([notifId]);
    const hash = url.replace(/^\/?/, "").replace(/^#/, "#");
    if (location.hash === hash.replace(/^\//, "")) openFromHash();
    else location.hash = hash.startsWith("#") ? hash : "#" + hash;
  }
  window.addEventListener("hashchange", () => {
    state.route = parseRoute(); window.scrollTo(0, 0); closeSheet(); render(); openFromHash();
  });

  /* ---------- shell ---------- */
  function updateBadge() {
    const n = state.notifications.filter(x => !x.read_at).length;
    const b = $("alertBadge");
    b.hidden = !n; b.textContent = n > 99 ? "99+" : n;
    if ("setAppBadge" in navigator) { try { n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } catch (e) {} }
  }

  function render() {
    if (!state.user) return;
    const r = state.route;
    document.querySelectorAll(".tabbar a").forEach(a => a.classList.toggle("on", a.dataset.tab === r.name || (a.dataset.tab === "projects" && r.name === "project")));
    $("backBtn").hidden = r.name !== "project" && r.name !== "search";
    $("fab").hidden = ["me", "alerts", "search"].includes(r.name) || !state.loaded || !state.projects.some(p => !p.archived);
    const actions = $("topActions");
    actions.innerHTML = "";
    updateBadge();
    if (!state.loaded) { $("view").innerHTML = `<div class="empty">Loading…</div>`; return; }
    const searchBtn = `<a class="iconbtn" href="#/search" aria-label="Search">${ICON.search}</a>`;

    if (r.name === "home") { $("pageTitle").textContent = "Dashboard"; actions.innerHTML = searchBtn; renderHome(); }
    else if (r.name === "tasks") { $("pageTitle").textContent = "My tasks"; actions.innerHTML = searchBtn; renderTasks(); }
    else if (r.name === "projects") {
      $("pageTitle").textContent = "Projects";
      actions.innerHTML = searchBtn + `<button class="iconbtn" data-act="new-project" aria-label="New project">${ICON.plus}</button>`;
      renderProjects();
    }
    else if (r.name === "project") {
      const p = projectOf(r.id);
      if (!p) { location.hash = "#/projects"; return; }
      $("pageTitle").textContent = p.name;
      actions.innerHTML = `<button class="iconbtn" data-act="members" data-id="${p.id}" aria-label="People">${ICON.people}</button>` +
        `<button class="iconbtn" data-act="edit-project" data-id="${p.id}" aria-label="Project settings">${ICON.edit}</button>`;
      renderProject(p);
    }
    else if (r.name === "alerts") {
      $("pageTitle").textContent = "Alerts";
      if (state.notifications.some(n => !n.read_at)) actions.innerHTML = `<button class="btn sm" data-act="read-all" style="background:transparent;color:inherit;border-color:rgba(255,255,255,.25)">Mark all read</button>`;
      renderAlerts();
    }
    else if (r.name === "search") { $("pageTitle").textContent = "Search"; renderSearch(); }
    else if (r.name === "me") { $("pageTitle").textContent = "Me"; renderMe(); }
  }

  function renderLoadError() {
    $("view").innerHTML = `<div class="empty"><strong>Couldn't load your tasks</strong><span>Check your connection, then try again.</span><button class="btn primary" data-act="reload">Try again</button></div>`;
  }

  function taskCard(t, showProject = true) {
    const d = dueInfo(t), p = projectOf(t.project_id), last = lastNote(t.id), isDone = t.status === "done";
    const meta = [];
    if (showProject && p) meta.push(`<span class="proj"><i class="dot" style="background:${esc(p.color)}"></i>${esc(p.name)}</span>`);
    meta.push(`<span class="prio ${t.priority}"><i></i>${PRIO[t.priority]}</span>`);
    if (t.client) meta.push(`<span>${esc(t.client)}</span>`);
    if (t.ref) meta.push(`<span class="num">${esc(t.ref)}</span>`);
    return `<article class="task p-${t.priority} ${isDone ? "is-done" : ""}" data-act="open-task" data-id="${t.id}">
      <button class="check ${isDone ? "on" : ""}" data-act="toggle-done" data-id="${t.id}" aria-label="${isDone ? "Reopen task" : "Mark done"}">${isDone ? ICON.check : ""}</button>
      <div style="min-width:0">
        <p class="t-title">${esc(t.title)}</p>
        <div class="t-meta">${meta.join("")}</div>
        ${last ? `<div class="t-last"><time>${fmtStamp(last.created_at)}</time>${membersOf(t.project_id).length > 1 ? `<b>${esc(shortName(last.author_id))}:</b> ` : ""}${esc(last.body)}</div>` : ""}
      </div>
      <div class="t-side">
        <span class="pill ${t.status}">${STATUS[t.status]}</span>
        ${d.label ? `<span class="due ${d.cls}">${d.label}</span>` : ""}
        ${t.assignee_id ? `<span class="who">${avatar(t.assignee_id, "sm")}</span>` : ""}
      </div>
    </article>`;
  }

  const section = (title, list, opts = {}) => list.length ? `<section class="section">
      <div class="section-h"><h2 class="${opts.cls || ""}">${esc(title)}</h2><span class="c">${list.length}</span></div>
      <div class="list">${sortTasks(list).map(t => taskCard(t, opts.showProject !== false)).join("")}</div>
    </section>` : "";

  /* ---------- Dashboard ---------- */
  function renderHome() {
    const act = activeIds();
    const active = state.projects.filter(p => !p.archived);
    if (!state.projects.length) {
      $("view").innerHTML = `<div class="hello"><h2>${greeting()}, ${esc(firstName())}</h2><p>${fmtDay(new Date())}</p></div>
        <div class="empty"><strong>Start with a project</strong><span>Group your tasks by business or area, like D'Lusso, QCLOUD or Fitness Hub.</span><button class="btn primary" data-act="new-project">Create a project</button></div>`;
      return;
    }
    const ts = state.tasks.filter(t => act.has(t.project_id));
    const open = ts.filter(t => t.status !== "done"), done = ts.filter(t => t.status === "done");
    const overdue = open.filter(isOverdue);
    const pct = ts.length ? Math.round(done.length / ts.length * 100) : 0;
    const mine = open.filter(t => t.assignee_id === state.user.id);
    const delegated = open.filter(t => t.user_id === state.user.id && t.assignee_id && t.assignee_id !== state.user.id);
    const weekEnd = startOfDay(new Date()); weekEnd.setDate(weekEnd.getDate() + 7);
    const dueWeek = open.filter(t => t.due_at && new Date(t.due_at) >= new Date() && new Date(t.due_at) < weekEnd);
    const shared = active.filter(p => membersOf(p.id).length > 1);
    const pc = { high: 0, medium: 0, low: 0 }; open.forEach(t => pc[t.priority]++);

    // 7-day completions
    const days = [...Array(7)].map((_, i) => { const d = startOfDay(new Date()); d.setDate(d.getDate() - 6 + i); return d; });
    const perDay = days.map(d => ts.filter(t => t.done_at && isoDay(new Date(t.done_at)) === isoDay(d)).length);
    const maxDay = Math.max(1, ...perDay);

    const R = 50, C = 2 * Math.PI * R;
    const ring = `<div class="ring"><svg viewBox="0 0 118 118"><circle cx="59" cy="59" r="${R}" fill="none" stroke="var(--ring-track)" stroke-width="11"/>
      <circle cx="59" cy="59" r="${R}" fill="none" stroke="#5ba7dc" stroke-width="11" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct / 100)}" style="transition:stroke-dashoffset .8s"/></svg>
      <div class="lbl"><b>${pct}%</b><span>complete</span></div></div>`;

    const projRows = active.map(p => {
      const pts = state.tasks.filter(t => t.project_id === p.id);
      const pd = pts.filter(t => t.status === "done").length, po = pts.length - pd, pov = pts.filter(isOverdue).length;
      const tot = Math.max(1, pts.length);
      const mem = membersOf(p.id);
      return `<a class="prow" href="#/p/${p.id}">
        <span class="nm"><i class="dot" style="background:${esc(p.color)}"></i><span>${esc(p.name)}</span>${mem.length > 1 ? `<span class="avstack">${mem.slice(0, 4).map(m => avatar(m.user_id, "sm")).join("")}</span>` : ""}</span>
        <span class="cnt">${po} open · ${pd} done${pov ? ` · <span class="bad">${pov} late</span>` : ""}</span>
        <span class="stackbar">${pts.length ? `<i style="width:${pd / tot * 100}%;background:var(--ok)"></i><i style="width:${(po - pov) / tot * 100}%;background:${esc(p.color)}"></i><i style="width:${pov / tot * 100}%;background:var(--hi)"></i>` : ""}</span>
      </a>`;
    }).join("");

    const feed = state.updates.filter(u => { const t = taskOf(u.task_id); return t && act.has(t.project_id) && u.kind !== "system"; }).slice(0, 8);
    const feedHtml = feed.length ? `<ul class="feed">${feed.map(u => {
      const t = taskOf(u.task_id), p = projectOf(t.project_id);
      return `<li data-act="open-task" data-id="${t.id}">${avatar(u.author_id)}<div style="min-width:0">
        <div class="line1"><b>${esc(shortName(u.author_id))}</b> · ${esc(t.title)}</div>
        <div class="line2">${esc(u.body)}</div><time>${ago(u.created_at)} · ${esc(p.name)}</time></div></li>`;
    }).join("")}</ul>` : `<p style="margin:0;color:var(--muted);font-size:.88rem">Updates you and your team log will show here.</p>`;

    const totalOpen = Math.max(1, open.length);
    $("view").innerHTML = `
      <div class="hello"><h2>${greeting()}, ${esc(firstName())}</h2><p>${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}${overdue.length ? ` · <span style="color:var(--hi)">${overdue.length} overdue</span>` : ""}</p></div>
      <section class="hero">${ring}
        <div class="herostats">
          <div><b>${active.length}</b><span>Projects</span></div>
          <div><b>${open.length}</b><span>Open tasks</span></div>
          <div><b>${done.length}</b><span>Closed</span></div>
          <div class="${overdue.length ? "bad" : ""}"><b>${overdue.length}</b><span>Overdue</span></div>
        </div>
      </section>
      <div class="kpis">
        <a class="kpi" href="#/tasks" data-act="filter-tasks" data-f="mine"><span class="k">Assigned to me</span><span class="v">${mine.length}</span><span class="s">open</span></a>
        <a class="kpi" href="#/tasks" data-act="filter-tasks" data-f="delegated"><span class="k">I assigned</span><span class="v">${delegated.length}</span><span class="s">with others</span></a>
        <a class="kpi" href="#/tasks"><span class="k">Due this week</span><span class="v">${dueWeek.length}</span><span class="s">next 7 days</span></a>
        <a class="kpi" href="#/projects"><span class="k">Shared projects</span><span class="v">${shared.length}</span><span class="s">with your team</span></a>
      </div>
      <div class="two">
        <section class="panel">
          <div class="panel-h"><h3>Open by priority</h3><span>${open.length} open</span></div>
          <div class="stackbar" style="height:14px"><i style="width:${pc.high / totalOpen * 100}%;background:var(--hi)"></i><i style="width:${pc.medium / totalOpen * 100}%;background:var(--mid)"></i><i style="width:${pc.low / totalOpen * 100}%;background:var(--lo)"></i></div>
          <div class="legend"><span><i style="background:var(--hi)"></i>Immediate <b>${pc.high}</b></span><span><i style="background:var(--mid)"></i>Moderate <b>${pc.medium}</b></span><span><i style="background:var(--lo)"></i>Not urgent <b>${pc.low}</b></span></div>
        </section>
        <section class="panel">
          <div class="panel-h"><h3>Closed this week</h3><span>${perDay.reduce((a, b) => a + b, 0)} tasks</span></div>
          <div class="bars7">${days.map((d, i) => `<div class="col ${i === 6 ? "today" : ""}"><span class="n">${perDay[i] || ""}</span><span class="b ${perDay[i] ? "" : "zero"}" style="height:${Math.max(4, perDay[i] / maxDay * 70)}px"></span><span class="d">${d.toLocaleDateString("en-GB", { weekday: "narrow" })}</span></div>`).join("")}</div>
        </section>
      </div>
      <section class="panel">
        <div class="panel-h"><h3>Projects</h3><a href="#/projects">All projects</a></div>
        <div>${projRows}</div>
        <div class="legend"><span><i style="background:var(--ok)"></i>Done</span><span><i style="background:var(--accent)"></i>Open</span><span><i style="background:var(--hi)"></i>Overdue</span></div>
      </section>
      <section class="panel">
        <div class="panel-h"><h3>Recent activity</h3></div>
        ${feedHtml}
      </section>`;
  }
  function greeting() { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; }
  function firstName() { return (state.me && state.me.display_name ? state.me.display_name : state.user.email.split("@")[0]).split(" ")[0]; }

  /* ---------- My tasks ---------- */
  function renderTasks() {
    const act = activeIds();
    const f = state.taskFilter;
    let open = state.tasks.filter(t => act.has(t.project_id) && t.status !== "done");
    const counts = {
      mine: open.filter(isMine).length,
      delegated: open.filter(t => t.user_id === state.user.id && t.assignee_id && t.assignee_id !== state.user.id).length,
      all: open.length
    };
    if (f === "mine") open = open.filter(isMine);
    else if (f === "delegated") open = open.filter(t => t.user_id === state.user.id && t.assignee_id && t.assignee_id !== state.user.id);
    const g = { overdue: [], today: [], soon: [], high: [], doing: [], waiting: [], later: [] };
    open.forEach(t => {
      const d = t.due_at ? new Date(t.due_at) : null, n = d ? dayDiff(d) : null;
      if (isOverdue(t)) g.overdue.push(t);
      else if (n === 0) g.today.push(t);
      else if (n !== null && n <= 3) g.soon.push(t);
      else if (t.status === "waiting") g.waiting.push(t);
      else if (t.priority === "high") g.high.push(t);
      else if (t.status === "doing") g.doing.push(t);
      else g.later.push(t);
    });
    const labels = { mine: "Mine", delegated: "I assigned", all: "Everything" };
    const body = section("Overdue", g.overdue, { cls: "bad" }) + section("Due today", g.today) + section("Next 3 days", g.soon) +
      section("Immediate", g.high) + section("In progress", g.doing) + section("Waiting on others", g.waiting) + section("Later", g.later);
    $("view").innerHTML = `
      <div class="seg">${Object.keys(labels).map(k => `<button class="${k === f ? "on" : ""}" data-act="filter-tasks" data-f="${k}">${labels[k]}<span class="c">${counts[k]}</span></button>`).join("")}</div>
      ${body || `<div class="empty"><strong>All clear</strong><span>${f === "delegated" ? "You haven't assigned any open tasks to others." : "No open tasks here."}</span></div>`}`;
  }

  /* ---------- Projects ---------- */
  function projectStats(p) {
    const ts = state.tasks.filter(t => t.project_id === p.id);
    const open = ts.filter(t => t.status !== "done"), done = ts.length - open.length;
    return { total: ts.length, open: open.length, done, overdue: open.filter(isOverdue).length, pct: ts.length ? Math.round(done / ts.length * 100) : 0 };
  }
  function projectCard(p) {
    const s = projectStats(p), mem = membersOf(p.id);
    return `<a class="pcard" href="#/p/${p.id}" style="--pc:${esc(p.color)}">
      <div class="ptop"><h3>${esc(p.name)}</h3>${mem.length > 1 ? `<span class="avstack">${mem.slice(0, 4).map(m => avatar(m.user_id, "sm")).join("")}</span>` : ""}</div>
      <div class="nums"><span><b>${s.open}</b> open</span><span><b>${s.done}</b> done</span>${s.overdue ? `<span class="bad"><b>${s.overdue}</b> overdue</span>` : ""}${!isOwner(p.id) ? `<span class="shared">Shared with you</span>` : ""}</div>
      <div class="progress"><i style="width:${s.pct}%"></i></div>
      <div class="pfoot"><span>${s.done}/${s.total} done</span><span>${s.pct}%</span></div>
    </a>`;
  }
  function renderProjects() {
    const active = state.projects.filter(p => !p.archived), archived = state.projects.filter(p => p.archived);
    $("view").innerHTML = `
      <div class="projects">${active.map(projectCard).join("")}<button class="pcard add" data-act="new-project">+ New project</button></div>
      ${archived.length ? `<section class="section archived-h"><div class="section-h"><h2>Archived</h2><span class="c">${archived.length}</span></div><div class="projects">${archived.map(projectCard).join("")}</div></section>` : ""}`;
  }

  function renderProject(p) {
    const tab = state.projectTab[p.id] || "open";
    const ts = state.tasks.filter(t => t.project_id === p.id);
    const counts = { open: ts.filter(t => t.status !== "done").length, waiting: ts.filter(t => t.status === "waiting").length, done: ts.filter(t => t.status === "done").length, all: ts.length };
    const labels = { open: "Open", waiting: "Waiting", done: "Done", all: "All" };
    let list = ts;
    if (tab === "open") list = ts.filter(t => t.status !== "done");
    else if (tab === "waiting") list = ts.filter(t => t.status === "waiting");
    else if (tab === "done") list = ts.filter(t => t.status === "done");
    const s = projectStats(p), mem = membersOf(p.id);
    $("view").innerHTML = `
      <div class="phead">
        <div class="pmeta">
          <div class="nums"><span><b>${s.open}</b> open</span><span><b>${s.done}</b> done</span>${s.overdue ? `<span style="color:var(--hi)"><b style="color:inherit">${s.overdue}</b> overdue</span>` : ""}</div>
          <button class="btn sm" data-act="members" data-id="${p.id}"><span class="avstack">${mem.slice(0, 4).map(m => avatar(m.user_id, "sm")).join("")}</span>${mem.length > 1 ? mem.length + " people" : "Add people"}</button>
        </div>
        <div class="progress" style="--pc:${esc(p.color)}"><i style="width:${s.pct}%"></i></div>
      </div>
      ${p.archived ? `<div class="formmsg ok">This project is archived. Its tasks stay off the dashboard.</div>` : ""}
      <div class="seg">${Object.keys(labels).map(k => `<button class="${k === tab ? "on" : ""}" data-act="ptab" data-tab="${k}" data-id="${p.id}">${labels[k]}<span class="c">${counts[k]}</span></button>`).join("")}</div>
      ${list.length ? `<div class="list">${sortTasks(list).map(t => taskCard(t, false)).join("")}</div>`
        : `<div class="empty"><strong>${ts.length ? "Nothing here" : "No tasks yet"}</strong><span>${ts.length ? "Try another tab." : "Add the first task for " + esc(p.name) + "."}</span>${ts.length ? "" : `<button class="btn primary" data-act="new-task">Add task</button>`}</div>`}`;
  }

  /* ---------- Alerts ---------- */
  const ALERT_ICON = { assigned: ICON.user, update: ICON.note, overdue: ICON.clock, completed: ICON.done, added: ICON.people };
  function renderAlerts() {
    const list = state.notifications;
    $("view").innerHTML = `${pushCard()}
      ${list.length ? `<div class="alist">${list.map(n => `<article class="alert k-${esc(n.kind)} ${n.read_at ? "" : "unread"}" data-act="open-alert" data-id="${n.id}">
        <span class="ico">${ALERT_ICON[n.kind] || ICON.bell}</span>
        <div style="min-width:0"><div class="at">${esc(n.title)}</div><div class="ab">${esc(n.body)}</div></div>
        <div style="display:grid;justify-items:end;gap:4px"><time>${ago(n.created_at)}</time>${n.read_at ? "" : `<span class="dotnew"></span>`}</div>
      </article>`).join("")}</div>`
      : `<div class="empty"><strong>No alerts yet</strong><span>You'll be told here when someone assigns you a task, updates one of yours, or a deadline passes.</span></div>`}`;
  }
  async function markRead(ids) {
    const now = new Date().toISOString();
    state.notifications.forEach(n => { if (ids.includes(n.id) && !n.read_at) n.read_at = now; });
    updateBadge();
    if (state.route.name === "alerts") render();
    await sb.from("notifications").update({ read_at: now }).in("id", ids).is("read_at", null);
  }

  /* ---------- Push notifications ---------- */
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  function pushCard() {
    if (pushSupported() && Notification.permission === "granted") return "";
    if (isIOS && !isStandalone()) return `<div class="notice-card"><p><strong>Get alerts on your iPhone</strong>Add Job Desk to your Home Screen first (Share → Add to Home Screen), open it from there, then turn on notifications here.</p></div>`;
    if (!pushSupported()) return `<div class="notice-card"><p><strong>Phone alerts aren't available in this browser</strong>Open Job Desk in Chrome or Safari to get notifications.</p></div>`;
    if (Notification.permission === "denied") return `<div class="notice-card"><p><strong>Notifications are blocked</strong>Allow notifications for Job Desk in your phone or browser settings to get alerts.</p></div>`;
    return `<div class="notice-card"><p><strong>Turn on phone alerts</strong>Get notified when you're assigned a task, someone updates your task, or a deadline passes.</p><button class="btn primary" data-act="enable-push">Turn on notifications</button></div>`;
  }
  function b64ToBytes(b64) {
    const pad = "=".repeat((4 - b64.length % 4) % 4);
    const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }
  async function saveSubscription(sub) {
    const j = sub.toJSON();
    const { error } = await sb.from("push_subscriptions").upsert({ user_id: state.user.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 200) }, { onConflict: "endpoint" });
    if (error) console.error(error);
  }
  async function enablePush() {
    if (!pushSupported()) return toast("This browser can't show notifications.");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { render(); return toast("Notifications not allowed."); }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.vapidPublicKey) });
      await saveSubscription(sub);
      toast("Notifications are on");
    } catch (e) { console.error(e); toast("Couldn't turn on notifications. Try again."); }
    render();
  }
  async function ensurePushSubscription() {
    if (!pushSupported() || Notification.permission !== "granted") return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.vapidPublicKey) });
      await saveSubscription(sub);
    } catch (e) { console.error(e); }
  }

  /* ---------- Overdue popup ---------- */
  function myOverdue() { const act = activeIds(); return sortTasks(state.tasks.filter(t => act.has(t.project_id) && isMine(t) && isOverdue(t))); }
  function maybeShowOverdue() {
    const list = myOverdue();
    list.forEach(t => state.overdueSeen.add(t.id));
    let shown = null; try { shown = sessionStorage.getItem("jd-od"); } catch (e) {}
    if (!list.length || shown === isoDay(new Date()) + list.length) return;
    try { sessionStorage.setItem("jd-od", isoDay(new Date()) + list.length); } catch (e) {}
    openSheet({ kind: "overdue" });
  }
  function renderOverdueSheet() {
    const list = myOverdue();
    if (!list.length) { closeSheet(); return; }
    $("sheet").innerHTML = `<div class="grabber"></div>
      <div class="od-hero"><span class="big">${ICON.clock}</span><div><h2 style="margin:0;font-family:var(--font-display);font-size:1.25rem">${list.length} overdue task${list.length > 1 ? "s" : ""}</h2><p style="margin:2px 0 0;color:var(--muted);font-size:.9rem">These are past their deadline. Please complete them or set a new date.</p></div></div>
      <ul class="od-list">${list.slice(0, 8).map(t => `<li data-act="open-task" data-id="${t.id}"><div style="min-width:0"><div class="op">${esc((projectOf(t.project_id) || {}).name || "")}</div><div class="ot">${esc(t.title)}</div></div><span class="od">${dueInfo(t).label}</span></li>`).join("")}</ul>
      <div class="sheet-foot"><button class="btn" data-act="close-sheet">Later</button><a class="btn primary" href="#/tasks" data-act="filter-tasks" data-f="mine">Go to my tasks</a></div>`;
  }
  // while the app is open, catch deadlines that pass
  setInterval(() => {
    if (!state.loaded) return;
    myOverdue().forEach(t => {
      if (state.overdueSeen.has(t.id)) return;
      state.overdueSeen.add(t.id);
      const p = projectOf(t.project_id);
      toast(`${p ? p.name + ": " : ""}"${t.title}" is overdue`, { label: "Open", run: () => openTask(t.id) });
    });
    if (!state.sheet && ["home", "tasks", "project"].includes(state.route.name)) render();
  }, 60000);

  /* ---------- Search ---------- */
  function renderSearch() {
    const q = state.search.trim().toLowerCase();
    const hits = q ? state.tasks.filter(t => [t.title, t.client, t.ref, t.details, (projectOf(t.project_id) || {}).name, t.assignee_id && nameOf(t.assignee_id), (lastNote(t.id) || {}).body]
      .some(v => v && String(v).toLowerCase().includes(q))) : [];
    if (!$("searchInput")) {
      $("view").innerHTML = `<div class="searchbar">${ICON.search}<input class="input" id="searchInput" type="search" placeholder="Task, client, ref, person…" autocomplete="off" enterkeyhint="search"></div><div id="searchResults" style="display:grid;gap:8px"></div>`;
      $("searchInput").value = state.search;
      if (!q) setTimeout(() => $("searchInput") && $("searchInput").focus(), 50);
    }
    $("searchResults").innerHTML = q
      ? (hits.length ? `<div class="list">${sortTasks(hits).map(t => taskCard(t, true)).join("")}</div>` : `<div class="empty">No tasks match “${esc(state.search)}”.</div>`)
      : `<div class="empty">Search every project by task, client, reference, person or update.</div>`;
  }

  /* ---------- Me ---------- */
  function renderMe() {
    const owned = state.projects.filter(p => p.user_id === state.user.id).length;
    $("view").innerHTML = `
      <section class="card">
        <div style="display:flex;gap:12px;align-items:center">${avatar(state.user.id, "lg")}<div style="min-width:0"><h2 style="margin:0">${esc(nameOf(state.user.id))}</h2><p style="overflow-wrap:anywhere">${esc(state.user.email)}</p></div></div>
        <label class="field"><span>Your name (shown to people you work with)</span><input class="input" id="meName" value="${esc(state.me.display_name || "")}" maxlength="60" autocomplete="name"></label>
      </section>
      <section class="card">
        <h2>Invite friends</h2>
        <p>Anyone with the link can create their own free account with their own projects. To work together on a project, add them from that project's People button using the email they signed up with.</p>
        <div class="btnrow"><button class="btn primary" data-act="invite">Share invite link</button><button class="btn" data-act="copy-link">Copy link</button></div>
        <p class="num" style="font-size:.82rem;overflow-wrap:anywhere">${esc(location.origin)}</p>
      </section>
      ${pushCard() ? `<section class="card"><h2>Notifications</h2>${pushCard()}</section>` : `<section class="card"><h2>Notifications</h2><p>Phone alerts are on for this device.</p></section>`}
      ${isStandalone() ? "" : `<section class="card"><h2>Install on your phone</h2>
        ${isIOS ? `<ol><li>Open this page in Safari.</li><li>Tap the Share button.</li><li>Choose <strong>Add to Home Screen</strong>, then Add.</li></ol>` : `<ol><li>Open this page in Chrome.</li><li>Tap the ⋮ menu.</li><li>Choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li></ol>`}
        ${deferredInstall ? `<button class="btn primary" data-act="install">Install Job Desk</button>` : ""}</section>`}
      <section class="card"><h2>Projects</h2><p>${owned} owned by you, ${state.projects.length - owned} shared with you.</p><a class="btn" href="#/projects">Manage projects</a></section>
      <section class="card"><button class="btn" data-act="sign-out">Sign out</button></section>`;
  }
  async function shareInvite() {
    const data = { title: "Job Desk", text: "I'm using Job Desk to track tasks and projects. Create your free account here:", url: location.origin };
    if (navigator.share) { try { await navigator.share(data); return; } catch (e) { if (e.name === "AbortError") return; } }
    copyLink();
  }
  async function copyLink() {
    try { await navigator.clipboard.writeText(location.origin); toast("Link copied"); }
    catch (e) { toast("Copy this link: " + location.origin); }
  }

  /* ---------- Sheets ---------- */
  function openSheet(s) { state.sheet = s; $("sheetWrap").hidden = false; document.body.style.overflow = "hidden"; renderSheet(); }
  function closeSheet() { state.sheet = null; $("sheetWrap").hidden = true; document.body.style.overflow = ""; }
  function renderSheet() {
    const s = state.sheet;
    if (!s) return;
    if (s.kind === "task") renderTaskSheet(s);
    else if (s.kind === "project") renderProjectSheet(s);
    else if (s.kind === "members") renderMembersSheet(s);
    else if (s.kind === "overdue") renderOverdueSheet();
  }
  const sheetHead = title => `<div class="grabber"></div><div class="sheet-h"><h2>${esc(title)}</h2><button class="iconbtn" data-act="close-sheet" aria-label="Close">${ICON.close}</button></div>`;

  function openTask(id) { openSheet({ kind: "task", id }); }

  function dueParts(t) {
    if (!t.due_at) return { date: "", time: "" };
    const d = new Date(t.due_at);
    return { date: isoDay(d), time: t.due_all_day ? "" : hhmm(d) };
  }

  function renderTaskSheet(s) {
    const isNew = !s.id;
    const t = isNew ? s.draft : taskOf(s.id);
    if (!t) { closeSheet(); return; }
    const projects = state.projects.filter(p => !p.archived || p.id === t.project_id);
    const mem = membersOf(t.project_id);
    const dp = isNew ? { date: s.draft.due_date || "", time: s.draft.due_time || "" } : dueParts(t);
    const ups = isNew ? [] : state.updates.filter(u => u.task_id === t.id);
    const canDelete = !isNew && (t.user_id === state.user.id || isOwner(t.project_id));
    const draftUpdate = $("upInput") ? $("upInput").value : "";
    const focusId = document.activeElement && document.activeElement.id;
    $("sheet").innerHTML = sheetHead(isNew ? "New task" : "Task") + `
      <form id="taskForm" style="display:grid;gap:14px" novalidate>
        <label class="field"><span>Task</span><textarea class="input" id="tf-title" rows="2" required placeholder="What needs doing?" style="min-height:64px">${esc(t.title)}</textarea></label>
        <div class="field"><span>Priority</span><div class="prio-seg" role="group" aria-label="Priority">${Object.keys(PRIO).map(k => `<button type="button" class="${k} ${t.priority === k ? "on" : ""}" data-act="set-prio" data-p="${k}">${PRIO[k]}<small>${PRIO_HINT[k]}</small></button>`).join("")}</div></div>
        <div class="field"><span>Status</span><div class="status-seg" role="group" aria-label="Status">${Object.keys(STATUS).map(k => `<button type="button" class="${k} ${t.status === k ? "on" : ""}" data-act="set-status" data-s="${k}">${STATUS[k]}</button>`).join("")}</div></div>
        <div class="grid2">
          <label class="field"><span>Project</span><select class="input" id="tf-project">${projects.map(p => `<option value="${p.id}" ${p.id === t.project_id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
          <label class="field"><span>Assign to</span><select class="input" id="tf-assignee"><option value="">Unassigned</option>${mem.map(m => `<option value="${m.user_id}" ${m.user_id === t.assignee_id ? "selected" : ""}>${esc(m.user_id === state.user.id ? nameOf(m.user_id) + " (me)" : nameOf(m.user_id))}</option>`).join("")}</select></label>
        </div>
        ${mem.length < 2 ? `<p style="margin:-6px 0 0;font-size:.8rem;color:var(--muted)">To assign others, add them to this project with the People button.</p>` : ""}
        <div class="grid2">
          <label class="field"><span>Due date</span><input class="input" id="tf-date" type="date" value="${esc(dp.date)}"></label>
          <label class="field"><span>Time (optional)</span><input class="input" id="tf-time" type="time" value="${esc(dp.time)}"></label>
        </div>
        <div class="grid2">
          <label class="field"><span>Client / contact</span><input class="input" id="tf-client" value="${esc(t.client || "")}" autocomplete="off"></label>
          <label class="field"><span>Reference</span><input class="input" id="tf-ref" value="${esc(t.ref || "")}" placeholder="Job no., PO…" autocomplete="off"></label>
        </div>
        <label class="field"><span>Details</span><textarea class="input" id="tf-details" rows="3" placeholder="Notes, items, supplier…">${esc(t.details || "")}</textarea></label>
        ${isNew ? `<div class="sheet-foot"><button class="btn primary block" type="submit">Add task</button></div>` : `<p style="margin:0;font-size:.78rem;color:var(--faint)">Created by ${esc(shortName(t.user_id))} · ${fmtStamp(t.created_at)}</p>`}
      </form>
      ${isNew ? "" : `
      <section class="updates">
        <h3>Progress updates</h3>
        <form class="upform" id="upForm"><input class="input" id="upInput" placeholder="Log an update…" autocomplete="off" enterkeyhint="send"><button class="btn primary" type="submit">Log</button></form>
        ${ups.length ? `<ol class="timeline">${ups.map(u => `<li class="${u.kind}"><span class="pt"></span><div><time>${esc(shortName(u.author_id))} · ${fmtStamp(u.created_at)}</time><div class="body">${esc(u.body)}</div></div></li>`).join("")}</ol>`
          : `<p style="color:var(--muted);margin:0">No updates yet. Log what happened, who you spoke to, or what's next.</p>`}
      </section>
      ${canDelete ? `<div class="sheet-foot"><button class="btn danger" data-act="delete-task" data-id="${t.id}">${ICON.trash}${s.confirmDelete ? "Tap again to delete" : "Delete task"}</button></div>` : ""}`}`;
    if (draftUpdate && $("upInput")) $("upInput").value = draftUpdate;
    if (focusId && $(focusId) && focusId !== "tf-title") $(focusId).focus();
    if (isNew && !s.focused) { s.focused = true; setTimeout(() => $("tf-title") && $("tf-title").focus(), 60); }
  }

  function readTaskForm() {
    const date = $("tf-date").value, time = $("tf-time").value;
    let due_at = null, due_all_day = true;
    if (date) {
      const [y, m, d] = date.split("-").map(Number);
      if (time) { const [hh, mm] = time.split(":").map(Number); due_at = new Date(y, m - 1, d, hh, mm).toISOString(); due_all_day = false; }
      else due_at = new Date(y, m - 1, d, 23, 59).toISOString();
    }
    return {
      title: $("tf-title").value.trim(),
      project_id: $("tf-project").value,
      assignee_id: $("tf-assignee").value || null,
      due_at, due_all_day,
      client: $("tf-client").value.trim() || null,
      ref: $("tf-ref").value.trim() || null,
      details: $("tf-details").value.trim() || null,
      _date: date, _time: time
    };
  }

  function newTask() {
    const r = state.route;
    const pid = r.name === "project" ? r.id : (state.projects.find(p => !p.archived) || {}).id;
    openSheet({ kind: "task", id: null, draft: { title: "", project_id: pid, status: "todo", priority: "medium", assignee_id: null, client: "", ref: "", details: "" } });
  }
  function syncDraft() {
    const f = readTaskForm(), s = state.sheet;
    s.draft = { ...s.draft, title: f.title, project_id: f.project_id, assignee_id: f.assignee_id, client: f.client, ref: f.ref, details: f.details, due_date: f._date, due_time: f._time };
    if (!membersOf(s.draft.project_id).some(m => m.user_id === s.draft.assignee_id)) s.draft.assignee_id = null;
  }

  async function createTask() {
    const f = readTaskForm();
    if (!f.title) { $("tf-title").focus(); toast("Give the task a name."); return; }
    const d = state.sheet.draft;
    const row = { project_id: f.project_id, title: f.title, assignee_id: f.assignee_id, due_at: f.due_at, due_all_day: f.due_all_day, client: f.client, ref: f.ref, details: f.details, status: d.status, priority: d.priority, sort: Date.now() };
    const { data, error } = await sb.from("tasks").insert(row).select().single();
    if (error) return fail(error);
    state.tasks.push(data);
    closeSheet(); render();
    toast(f.assignee_id && f.assignee_id !== state.user.id ? `Task added and sent to ${nameOf(f.assignee_id)}` : "Task added");
  }

  function renderProjectSheet(s) {
    const p = s.id ? projectOf(s.id) : { name: "", color: COLORS[state.projects.length % COLORS.length], archived: false };
    const owner = !s.id || isOwner(s.id);
    if (s.id && !owner) {
      $("sheet").innerHTML = sheetHead(p.name) + `<p style="margin:0;color:var(--muted)">This project is shared with you by ${esc(nameOf(p.user_id))}. Only they can rename or delete it.</p>
        <div class="sheet-foot"><button class="btn danger" data-act="leave-project" data-id="${p.id}">${s.confirmLeave ? "Tap again to leave" : "Leave project"}</button></div>`;
      return;
    }
    const n = s.id ? state.tasks.filter(t => t.project_id === s.id).length : 0;
    $("sheet").innerHTML = sheetHead(s.id ? "Project settings" : "New project") + `
      <form id="projectForm" style="display:grid;gap:16px" novalidate>
        <label class="field"><span>Name</span><input class="input" id="pf-name" value="${esc(p.name)}" maxlength="80" placeholder="e.g. QCLOUD, Fitness Hub" autocomplete="off" required></label>
        <div class="field"><span>Colour</span><div class="colors">${COLORS.map((c, i) => `<label><input type="radio" name="color" id="pf-c${i}" value="${c}" ${c === p.color ? "checked" : ""}><span style="--sw:${c}"></span></label>`).join("")}</div></div>
        <div class="sheet-foot"><button class="btn primary" type="submit">${s.id ? "Save changes" : "Create project"}</button></div>
      </form>
      ${s.id ? `<section style="display:grid;gap:10px;border-top:1px solid var(--line);padding-top:16px">
        <button class="btn" data-act="archive-project" data-id="${p.id}">${p.archived ? "Restore project" : "Archive project (hide, keep tasks)"}</button>
        <button class="btn danger" data-act="delete-project" data-id="${p.id}">${ICON.trash}${s.confirmDelete ? `Tap again: delete project and ${n} task${n === 1 ? "" : "s"}` : "Delete project"}</button>
        ${s.confirmDelete ? `<p style="margin:0;font-size:.82rem;color:var(--bad)">This permanently deletes the project for everyone in it. It can't be undone.</p>` : ""}
      </section>` : ""}`;
    if (!s.id) setTimeout(() => $("pf-name") && $("pf-name").focus(), 60);
  }

  async function saveProject() {
    const name = $("pf-name").value.trim();
    if (!name) { $("pf-name").focus(); toast("Give the project a name."); return; }
    const color = (document.querySelector('input[name="color"]:checked') || {}).value || COLORS[0];
    const s = state.sheet;
    if (s.id) {
      const { error } = await sb.from("projects").update({ name, color }).eq("id", s.id);
      if (error) return fail(error);
      Object.assign(projectOf(s.id), { name, color });
      closeSheet(); render(); toast("Project saved");
    } else {
      const { data, error } = await sb.from("projects").insert({ name, color, sort: state.projects.length }).select().single();
      if (error) return fail(error);
      state.projects.push(data);
      state.members.push({ project_id: data.id, user_id: state.user.id, role: "owner" });
      closeSheet(); location.hash = "#/p/" + data.id; toast("Project created");
    }
  }

  function renderMembersSheet(s) {
    const p = projectOf(s.id);
    if (!p) { closeSheet(); return; }
    const owner = isOwner(p.id);
    const mem = membersOf(p.id).slice().sort((a, b) => (a.role === "owner" ? -1 : b.role === "owner" ? 1 : nameOf(a.user_id).localeCompare(nameOf(b.user_id))));
    $("sheet").innerHTML = sheetHead("People in " + p.name) + `
      <ul class="mlist">${mem.map(m => `<li>${avatar(m.user_id, "lg")}<div style="min-width:0"><div class="mn">${esc(nameOf(m.user_id))}${m.user_id === state.user.id ? " (you)" : ""}</div><div class="me">${esc((state.profiles[m.user_id] || {}).email || "")}</div></div>
        ${m.role === "owner" ? `<span class="role">Owner</span>` : owner ? `<button class="btn sm danger" data-act="remove-member" data-uid="${m.user_id}">${s.confirmRemove === m.user_id ? "Confirm" : "Remove"}</button>` : `<span class="role">Member</span>`}</li>`).join("")}</ul>
      ${owner ? `<form id="memberForm" style="display:grid;gap:8px">
          <label class="field"><span>Add someone by email</span><div class="addrow"><input class="input" id="mf-email" type="email" inputmode="email" placeholder="their Job Desk email" autocomplete="off"><button class="btn primary" type="submit">Add</button></div></label>
          ${s.msg ? `<div class="formmsg ${s.msg.type}">${esc(s.msg.text)}</div>` : ""}
          ${s.msg && s.msg.invite ? `<div class="btnrow"><button type="button" class="btn" data-act="invite">Send them the invite link</button></div>` : ""}
          <p style="margin:0;font-size:.8rem;color:var(--muted)">They need a Job Desk account first. Members can see every task in this project, add tasks, and log updates. They get a notification when added.</p>
        </form>` : `<p style="margin:0;color:var(--muted);font-size:.88rem">Only ${esc(nameOf(p.user_id))} can add or remove people.</p>`}`;
  }

  async function addMember() {
    const s = state.sheet, email = $("mf-email").value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) { s.msg = { type: "err", text: "Enter a valid email address." }; return renderSheet(); }
    const { data, error } = await sb.rpc("add_project_member", { p_project: s.id, p_email: email });
    if (error) {
      s.msg = /not_registered/.test(error.message) ? { type: "err", text: `${email} doesn't have a Job Desk account yet. Send them the invite link, then add them once they've signed up.`, invite: true } : { type: "err", text: error.message };
      return renderSheet();
    }
    state.profiles[data.id] = data;
    if (!state.members.some(m => m.project_id === s.id && m.user_id === data.id)) state.members.push({ project_id: s.id, user_id: data.id, role: "member" });
    s.msg = { type: "ok", text: `${data.display_name || data.email} added. They've been notified.` };
    renderSheet(); render();
  }

  /* ---------- events ---------- */
  document.addEventListener("click", async e => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act, id = el.dataset.id, s = state.sheet;
    switch (act) {
      case "toggle-done": e.stopPropagation(); toggleDone(id); break;
      case "open-task": openTask(id); break;
      case "close-sheet": closeSheet(); break;
      case "new-task": newTask(); break;
      case "new-project": openSheet({ kind: "project", id: null }); break;
      case "edit-project": openSheet({ kind: "project", id }); break;
      case "members": openSheet({ kind: "members", id }); break;
      case "ptab": state.projectTab[id] = el.dataset.tab; render(); break;
      case "filter-tasks": state.taskFilter = el.dataset.f; if (state.route.name === "tasks") render(); break;
      case "reload": loadAll(); break;
      case "sign-out": await sb.auth.signOut(); break;
      case "install": if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; render(); } break;
      case "invite": shareInvite(); break;
      case "copy-link": copyLink(); break;
      case "enable-push": enablePush(); break;
      case "read-all": markRead(state.notifications.filter(n => !n.read_at).map(n => n.id)); break;
      case "open-alert": { const n = state.notifications.find(x => x.id === id); if (n) { markRead([n.id]); if (n.url) goUrl(n.url); } break; }
      case "set-status": {
        const st = el.dataset.s;
        if (!s.id) { syncDraft(); s.draft.status = st; renderSheet(); break; }
        const t = taskOf(s.id);
        if (t && t.status !== st) { await patchTask(s.id, { status: st }, `Status → ${STATUS[st]}`); renderSheet(); }
        break;
      }
      case "set-prio": {
        const pr = el.dataset.p;
        if (!s.id) { syncDraft(); s.draft.priority = pr; renderSheet(); break; }
        const t = taskOf(s.id);
        if (t && t.priority !== pr) { await patchTask(s.id, { priority: pr }, `Priority → ${PRIO[pr]}`); renderSheet(); }
        break;
      }
      case "delete-task": {
        if (!s.confirmDelete) { s.confirmDelete = true; renderSheet(); break; }
        closeSheet();
        state.tasks = state.tasks.filter(t => t.id !== id); render();
        const { error } = await sb.from("tasks").delete().eq("id", id);
        if (error) fail(error); else toast("Task deleted");
        break;
      }
      case "archive-project": {
        const p = projectOf(id), archived = !p.archived;
        const { error } = await sb.from("projects").update({ archived }).eq("id", id);
        if (error) return fail(error);
        p.archived = archived; closeSheet(); render(); toast(archived ? "Project archived" : "Project restored");
        break;
      }
      case "delete-project": {
        if (!s.confirmDelete) { s.confirmDelete = true; renderSheet(); break; }
        const { error } = await sb.from("projects").delete().eq("id", id);
        if (error) return fail(error);
        state.projects = state.projects.filter(p => p.id !== id);
        state.tasks = state.tasks.filter(t => t.project_id !== id);
        state.members = state.members.filter(m => m.project_id !== id);
        closeSheet(); location.hash = "#/projects"; render(); toast("Project deleted");
        break;
      }
      case "leave-project": {
        if (!s.confirmLeave) { s.confirmLeave = true; renderSheet(); break; }
        const { error } = await sb.from("project_members").delete().eq("project_id", id).eq("user_id", state.user.id);
        if (error) return fail(error);
        closeSheet(); location.hash = "#/projects"; loadAll(); toast("You left the project");
        break;
      }
      case "remove-member": {
        const uid = el.dataset.uid;
        if (s.confirmRemove !== uid) { s.confirmRemove = uid; renderSheet(); break; }
        const { error } = await sb.from("project_members").delete().eq("project_id", s.id).eq("user_id", uid);
        if (error) return fail(error);
        state.members = state.members.filter(m => !(m.project_id === s.id && m.user_id === uid));
        s.confirmRemove = null; s.msg = { type: "ok", text: `${nameOf(uid)} removed. Their tasks here are now unassigned.` };
        renderSheet(); loadAll();
        break;
      }
    }
  });

  $("backBtn").addEventListener("click", () => { if (history.length > 1) history.back(); else location.hash = "#/projects"; });
  $("fab").addEventListener("click", () => newTask());

  document.addEventListener("change", e => {
    if (e.target.id === "meName") {
      const display_name = e.target.value.trim();
      sb.from("profiles").update({ display_name }).eq("id", state.user.id).then(({ error }) => {
        if (error) return fail(error);
        state.me.display_name = display_name; state.profiles[state.user.id] = { ...state.profiles[state.user.id], display_name }; toast("Name saved"); render();
      });
      return;
    }
    const s = state.sheet;
    if (!s || s.kind !== "task" || !e.target.closest("#taskForm")) return;
    if (!s.id) { if (e.target.id === "tf-project") { syncDraft(); renderSheet(); } return; }
    const t = taskOf(s.id); if (!t) return;
    const f = readTaskForm();
    if (!f.title) { toast("A task needs a name."); $("tf-title").value = t.title; return; }
    if (f.project_id !== t.project_id && f.assignee_id && !membersOf(f.project_id).some(m => m.user_id === f.assignee_id)) f.assignee_id = null;
    const changed = {}, notes = [];
    ["title", "project_id", "assignee_id", "due_at", "due_all_day", "client", "ref", "details"].forEach(k => {
      const a = f[k] ?? null, b = t[k] ?? null;
      const same = k === "due_at" ? (a && b ? new Date(a).getTime() === new Date(b).getTime() : a === b) : a === b;
      if (!same) changed[k] = f[k];
    });
    if (!Object.keys(changed).length) return;
    if ("due_at" in changed) notes.push(changed.due_at ? `Due → ${dueInfo({ ...t, ...changed, status: "todo" }).label || fmtDay(new Date(changed.due_at))}` : "Due date cleared");
    if ("project_id" in changed) notes.push(`Moved to ${(projectOf(changed.project_id) || {}).name}`);
    if ("assignee_id" in changed) notes.push(changed.assignee_id ? `Assigned to ${nameOf(changed.assignee_id)}` : "Unassigned");
    patchTask(s.id, changed, notes.join(" · ") || null).then(() => { if ("project_id" in changed || "assignee_id" in changed) renderSheet(); });
  });

  document.addEventListener("submit", e => {
    e.preventDefault();
    const id = e.target.id;
    if (id === "taskForm") { if (!state.sheet.id) createTask(); }
    else if (id === "projectForm") saveProject();
    else if (id === "memberForm") addMember();
    else if (id === "upForm") {
      const inp = $("upInput"), text = inp.value.trim();
      if (!text || !state.sheet) return;
      inp.value = ""; addUpdate(state.sheet.id, text, "note");
    }
    else if (id === "authForm") submitAuth();
  });

  document.addEventListener("input", e => { if (e.target.id === "searchInput") { state.search = e.target.value; renderSearch(); } });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && state.sheet) closeSheet(); });

  let startY = null;
  $("sheet").addEventListener("touchstart", e => { if ($("sheet").scrollTop <= 0) startY = e.touches[0].clientY; }, { passive: true });
  $("sheet").addEventListener("touchend", e => { if (startY !== null && e.changedTouches[0].clientY - startY > 110 && $("sheet").scrollTop <= 0) closeSheet(); startY = null; }, { passive: true });

  window.addEventListener("online", () => { $("offline").hidden = true; if (state.user) loadAll(); });
  window.addEventListener("offline", () => { $("offline").hidden = false; });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.user) loadAll(); });

  let deferredInstall = null;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredInstall = e; if (state.route.name === "me") render(); });

  // a tapped phone notification asks the open app to navigate
  if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", e => { if (e.data && e.data.type === "open" && e.data.url) goUrl(e.data.url); });

  /* ---------- auth ---------- */
  function renderAuth(msg) {
    const m = state.authMode;
    const titles = { signin: "Sign in", signup: "Create your free account", reset: "Reset password", newpass: "Set a new password" };
    const btn = { signin: "Sign in", signup: "Create account", reset: "Send reset link", newpass: "Save password" };
    $("auth").innerHTML = `
      <form class="auth-card" id="authForm" novalidate>
        <div class="brand"><img src="/icons/icon-192.png" width="48" height="48" alt=""><div><h1>Job Desk</h1><p>${titles[m]}</p></div></div>
        ${msg ? `<div class="formmsg ${msg.type}">${esc(msg.text)}</div>` : ""}
        ${m === "signup" ? `<label class="field"><span>Your name</span><input class="input" id="af-name" autocomplete="name" maxlength="60" required></label>` : ""}
        ${m !== "newpass" ? `<label class="field"><span>Email</span><input class="input" id="af-email" type="email" autocomplete="email" inputmode="email" required></label>` : ""}
        ${m !== "reset" ? `<label class="field"><span>${m === "newpass" ? "New password" : "Password"}</span><input class="input" id="af-pass" type="password" autocomplete="${m === "signin" ? "current-password" : "new-password"}" minlength="8" required></label>` : ""}
        <button class="btn primary block" type="submit" id="af-btn">${btn[m]}</button>
        <div class="auth-switch">
          ${m === "signin" ? `<button type="button" class="linkbtn" data-auth="signup">Create account</button><button type="button" class="linkbtn" data-auth="reset">Forgot password?</button>` : ""}
          ${m === "signup" || m === "reset" ? `<button type="button" class="linkbtn" data-auth="signin">Back to sign in</button>` : ""}
        </div>
      </form>`;
    $("auth").querySelectorAll("[data-auth]").forEach(b => b.onclick = () => { state.authMode = b.dataset.auth; renderAuth(); });
  }

  async function submitAuth() {
    const m = state.authMode;
    const email = $("af-email") ? $("af-email").value.trim() : "";
    const pass = $("af-pass") ? $("af-pass").value : "";
    const name = $("af-name") ? $("af-name").value.trim() : "";
    if (m === "signup" && !name) return renderAuthKeep({ type: "err", text: "Enter your name so people know who you are." }, email);
    if (m !== "newpass" && !/^\S+@\S+\.\S+$/.test(email)) return renderAuthKeep({ type: "err", text: "Enter a valid email address." }, email);
    if (m !== "reset" && pass.length < 8) return renderAuthKeep({ type: "err", text: "Password needs at least 8 characters." }, email);
    $("af-btn").disabled = true;
    let res;
    if (m === "signin") res = await sb.auth.signInWithPassword({ email, password: pass });
    else if (m === "signup") res = await sb.auth.signUp({ email, password: pass, options: { emailRedirectTo: location.origin, data: { display_name: name } } });
    else if (m === "reset") res = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
    else res = await sb.auth.updateUser({ password: pass });
    if (res.error) {
      const text = /invalid login/i.test(res.error.message) ? "Email or password is wrong." : /not confirmed/i.test(res.error.message) ? "Confirm your email first. Check your inbox for the link." : res.error.message;
      return renderAuthKeep({ type: "err", text }, email);
    }
    if (m === "signup" && !res.data.session) { state.authMode = "signin"; return renderAuthKeep({ type: "ok", text: "Account created. Tap the confirmation link in your email, then come back here and sign in." }, email); }
    if (m === "reset") { state.authMode = "signin"; return renderAuthKeep({ type: "ok", text: "Reset link sent. Open it on this device." }, email); }
    if (m === "newpass") { state.recovery = false; toast("Password updated"); showApp(); }
  }
  function renderAuthKeep(msg, email) { renderAuth(msg); if ($("af-email")) $("af-email").value = email || ""; }

  function showAuth() { $("boot").hidden = true; $("app").hidden = true; $("auth").hidden = false; closeSheet(); renderAuth(); }
  function showApp() {
    $("boot").hidden = true; $("auth").hidden = true; $("app").hidden = false;
    state.route = parseRoute();
    render(); loadAll(); subscribe();
    $("offline").hidden = navigator.onLine;
  }

  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") { state.recovery = true; state.user = session.user; state.authMode = "newpass"; showAuth(); return; }
    if (state.recovery) return;
    const prev = state.user && state.user.id;
    state.user = session ? session.user : null;
    if (!state.user) { state.loaded = false; state.projects = []; state.tasks = []; if (channel) sb.removeChannel(channel); showAuth(); }
    else if (prev !== state.user.id) setTimeout(showApp, 0);
  });

  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
})();
