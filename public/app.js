/* Job Desk — tasks and progress updates across projects. Plain JS + Supabase. */
(() => {
  "use strict";

  const cfg = window.JOBDESK_CONFIG;
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  const STATUS = { todo: "To do", doing: "In progress", waiting: "Waiting", done: "Done" };
  const COLORS = ["#1f6aa0", "#6b4b8a", "#2e7d6b", "#c0612b", "#b3352b", "#8a6d1f", "#3d5a80", "#5f6b78"];
  const TICK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const $ = id => document.getElementById(id);

  const state = {
    user: null,
    projects: [],
    tasks: [],
    lastUpdate: {},        // task_id -> latest update
    route: { name: "today" },
    projectTab: {},        // project_id -> tab
    search: "",
    sheet: null,           // { kind: 'task'|'project', id, ... }
    loaded: false,
    authMode: "signin",
    recovery: false
  };

  /* ---------- helpers ---------- */
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = n => String(n).padStart(2, "0");
  const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const daysUntil = iso => {
    if (!iso) return null;
    const [y, m, d] = iso.split("-").map(Number);
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return Math.round((new Date(y, m - 1, d) - t) / 86400000);
  };
  const fmtDay = iso => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); };
  const fmtStamp = ts => {
    const d = new Date(ts), now = new Date();
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (isoDay(d) === isoDay(now)) return `Today ${time}`;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (isoDay(d) === isoDay(y)) return `Yesterday ${time}`;
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + " " + time;
  };
  const money = n => "QAR " + Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const projectOf = id => state.projects.find(p => p.id === id);
  const owes = t => Number(t.amount) > 0 && !t.amount_settled;

  function dueInfo(t) {
    const n = daysUntil(t.due);
    if (n === null) return { cls: "", label: "" };
    if (t.status === "done") return { cls: "", label: fmtDay(t.due) };
    if (n < 0) return { cls: "over", label: `Overdue ${-n}d` };
    if (n === 0) return { cls: "soon", label: "Today" };
    if (n === 1) return { cls: "soon", label: "Tomorrow" };
    if (n <= 3) return { cls: "soon", label: fmtDay(t.due) };
    return { cls: "", label: fmtDay(t.due) };
  }

  function sortTasks(list) {
    return list.slice().sort((a, b) => {
      const ad = a.status === "done", bd = b.status === "done";
      if (ad !== bd) return ad ? 1 : -1;
      if (ad && bd) return (b.done_at || "").localeCompare(a.done_at || "");
      const da = a.due || "9999-12-31", db = b.due || "9999-12-31";
      if (da !== db) return da < db ? -1 : 1;
      if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
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
    toastTimer = setTimeout(() => (el.hidden = true), action ? 5000 : 2600);
  }
  function fail(err) {
    console.error(err);
    toast(navigator.onLine ? "That didn't save. Try again." : "You're offline. Reconnect and try again.");
    loadAll();
  }

  /* ---------- data ---------- */
  async function loadAll() {
    const [p, t, u] = await Promise.all([
      sb.from("projects").select("*").order("sort").order("created_at"),
      sb.from("tasks").select("*"),
      sb.from("task_updates").select("task_id, body, kind, created_at").eq("kind", "note").order("created_at", { ascending: false }).limit(1000)
    ]);
    if (p.error || t.error) { if (!state.loaded) renderLoadError(); return; }
    state.projects = p.data;
    state.tasks = t.data;
    state.lastUpdate = {};
    (u.data || []).forEach(r => { if (!state.lastUpdate[r.task_id]) state.lastUpdate[r.task_id] = r; });
    state.loaded = true;
    render();
  }

  let reloadTimer;
  const scheduleReload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(loadAll, 400); };
  let channel;
  function subscribe() {
    if (channel) sb.removeChannel(channel);
    channel = sb.channel("jobdesk")
      .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, scheduleReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, scheduleReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "task_updates" }, payload => {
        scheduleReload();
        if (state.sheet && state.sheet.kind === "task" && payload.new && payload.new.task_id === state.sheet.id) loadUpdates(state.sheet.id);
      })
      .subscribe();
  }

  async function patchTask(id, fields, logText) {
    const t = state.tasks.find(x => x.id === id);
    if (!t) return;
    const before = { ...t };
    Object.assign(t, fields);
    if (fields.status === "done" && before.status !== "done") t.done_at = new Date().toISOString();
    render();
    const { error } = await sb.from("tasks").update(fields).eq("id", id);
    if (error) return fail(error);
    if (logText) await addUpdate(id, logText, "status", true);
  }

  async function addUpdate(taskId, body, kind = "note", silent = false) {
    const { data, error } = await sb.from("task_updates").insert({ task_id: taskId, body, kind }).select().single();
    if (error) return fail(error);
    if (kind === "note") state.lastUpdate[taskId] = data;
    if (state.sheet && state.sheet.kind === "task" && state.sheet.id === taskId) {
      state.sheet.updates = [data, ...(state.sheet.updates || [])];
      renderSheet();
    }
    if (!silent) render();
  }

  async function loadUpdates(taskId) {
    const { data, error } = await sb.from("task_updates").select("*").eq("task_id", taskId).order("created_at", { ascending: false });
    if (error || !state.sheet || state.sheet.id !== taskId) return;
    state.sheet.updates = data;
    renderSheet();
  }

  function toggleDone(id) {
    const t = state.tasks.find(x => x.id === id);
    if (!t) return;
    const done = t.status !== "done";
    const prev = t.status;
    patchTask(id, { status: done ? "done" : "todo" }, done ? "Marked done" : "Reopened");
    if (done) toast("Task done", { label: "Undo", run: () => patchTask(id, { status: prev }, "Reopened") });
  }

  /* ---------- routing ---------- */
  function parseRoute() {
    const h = location.hash.replace(/^#\/?/, "");
    const [a, b] = h.split("/");
    if (a === "projects") return { name: "projects" };
    if (a === "p" && b) return { name: "project", id: b };
    if (a === "search") return { name: "search" };
    if (a === "settings") return { name: "settings" };
    return { name: "today" };
  }
  window.addEventListener("hashchange", () => { state.route = parseRoute(); window.scrollTo(0, 0); render(); });

  /* ---------- rendering: shell ---------- */
  function render() {
    if (!state.user) return;
    const r = state.route;
    document.querySelectorAll(".tabbar a").forEach(a => {
      const tab = a.dataset.tab;
      a.classList.toggle("on", tab === r.name || (tab === "projects" && r.name === "project"));
    });
    $("backBtn").hidden = r.name !== "project";
    $("fab").hidden = r.name === "settings" || state.projects.filter(p => !p.archived).length === 0;
    const actions = $("topActions");
    actions.innerHTML = "";

    if (!state.loaded) { $("view").innerHTML = `<div class="empty">Loading…</div>`; return; }

    if (r.name === "today") { $("pageTitle").textContent = "Today"; renderToday(); }
    else if (r.name === "projects") {
      $("pageTitle").textContent = "Projects";
      actions.innerHTML = `<button class="iconbtn" data-act="new-project" aria-label="New project"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>`;
      renderProjects();
    }
    else if (r.name === "project") {
      const p = projectOf(r.id);
      if (!p) { location.hash = "#/projects"; return; }
      $("pageTitle").textContent = p.name;
      actions.innerHTML = `<button class="iconbtn" data-act="edit-project" data-id="${p.id}" aria-label="Edit project"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg></button>`;
      renderProject(p);
    }
    else if (r.name === "search") { $("pageTitle").textContent = "Search"; renderSearch(); }
    else if (r.name === "settings") { $("pageTitle").textContent = "Me"; renderSettings(); }
  }

  function renderLoadError() {
    $("view").innerHTML = `<div class="empty"><strong>Couldn't load your tasks</strong><span>Check your connection, then try again.</span><button class="btn primary" data-act="reload">Try again</button></div>`;
  }

  function taskCard(t, showProject) {
    const d = dueInfo(t);
    const p = projectOf(t.project_id);
    const last = state.lastUpdate[t.id];
    const isDone = t.status === "done";
    const meta = [];
    if (showProject && p) meta.push(`<span class="proj"><i class="dot" style="background:${esc(p.color)}"></i>${esc(p.name)}</span>`);
    if (t.client) meta.push(`<span>${esc(t.client)}</span>`);
    if (t.ref) meta.push(`<span class="num">${esc(t.ref)}</span>`);
    return `<article class="task ${isDone ? "is-done" : ""}" data-act="open-task" data-id="${t.id}">
      <button class="check ${isDone ? "on" : ""}" data-act="toggle-done" data-id="${t.id}" aria-label="${isDone ? "Reopen task" : "Mark done"}">${isDone ? TICK : ""}</button>
      <div style="min-width:0">
        <p class="t-title">${t.urgent && !isDone ? '<span class="flag" aria-label="Urgent">⚑</span>' : ""}${esc(t.title)}</p>
        ${meta.length ? `<div class="t-meta">${meta.join("")}</div>` : ""}
        ${last ? `<div class="t-last"><time>${fmtStamp(last.created_at)}</time>${esc(last.body)}</div>` : ""}
      </div>
      <div class="t-side">
        <span class="pill ${t.status}">${STATUS[t.status]}</span>
        ${d.label ? `<span class="due ${d.cls}">${d.label}</span>` : ""}
        ${Number(t.amount) > 0 ? `<span class="amt ${t.amount_settled ? "settled" : ""}">${money(t.amount)}</span>` : ""}
      </div>
    </article>`;
  }

  const section = (title, list, opts = {}) => list.length ? `<section class="section">
      <div class="section-h"><h2 class="${opts.cls || ""}">${esc(title)}</h2><span class="c">${list.length}</span></div>
      <div class="list">${sortTasks(list).map(t => taskCard(t, opts.showProject !== false)).join("")}</div>
    </section>` : "";

  const activeProjectIds = () => new Set(state.projects.filter(p => !p.archived).map(p => p.id));

  /* ---------- Today ---------- */
  function renderToday() {
    const act = activeProjectIds();
    const open = state.tasks.filter(t => act.has(t.project_id) && t.status !== "done");
    const overdue = [], today = [], soon = [], active = [], waiting = [];
    open.forEach(t => {
      const n = daysUntil(t.due);
      if (n !== null && n < 0) overdue.push(t);
      else if (n === 0) today.push(t);
      else if (n !== null && n <= 3) soon.push(t);
      else if (t.status === "waiting") waiting.push(t);
      else if (t.urgent || t.status === "doing") active.push(t);
    });
    const weekAgo = Date.now() - 7 * 86400000;
    const doneWeek = state.tasks.filter(t => t.status === "done" && t.done_at && new Date(t.done_at) > weekAgo).length;
    const pending = open.filter(owes).reduce((s, t) => s + Number(t.amount), 0);
    const dueSoon = overdue.length + today.length + soon.length;

    if (!state.projects.length) {
      $("view").innerHTML = `<div class="empty"><strong>Start with a project</strong><span>Group your tasks by business or area, like D'Lusso, QCLOUD or Fitness Hub.</span><button class="btn primary" data-act="new-project">Create a project</button></div>`;
      return;
    }

    const body = section("Overdue", overdue, { cls: "bad" }) + section("Due today", today) + section("Next 3 days", soon) +
      section("Urgent & in progress", active) + section("Waiting on others", waiting);

    $("view").innerHTML = `
      <div class="summary">
        <div class="stat"><span class="k">Open</span><span class="v">${open.length}</span></div>
        <div class="stat"><span class="k">Due ≤ 3 days</span><span class="v ${overdue.length ? "bad" : dueSoon ? "warn" : ""}">${dueSoon}</span></div>
        <div class="stat"><span class="k">Pending QAR</span><span class="v ${pending ? "bad" : ""}">${Number(pending).toLocaleString("en-US")}</span></div>
        <div class="stat"><span class="k">Done · 7 days</span><span class="v">${doneWeek}</span></div>
      </div>
      ${body || `<div class="empty"><strong>Nothing pressing</strong><span>No overdue, due-soon or urgent tasks. Open a project to see everything.</span><a class="btn" href="#/projects">View projects</a></div>`}`;
  }

  /* ---------- Projects ---------- */
  function projectStats(p) {
    const ts = state.tasks.filter(t => t.project_id === p.id);
    const open = ts.filter(t => t.status !== "done");
    const done = ts.length - open.length;
    return {
      total: ts.length, open: open.length, done,
      overdue: open.filter(t => { const n = daysUntil(t.due); return n !== null && n < 0; }).length,
      pending: open.filter(owes).reduce((s, t) => s + Number(t.amount), 0),
      pct: ts.length ? Math.round(done / ts.length * 100) : 0
    };
  }
  function projectCard(p) {
    const s = projectStats(p);
    return `<a class="pcard" href="#/p/${p.id}" style="--pc:${esc(p.color)}">
      <h3>${esc(p.name)}</h3>
      <div class="nums"><span><b>${s.open}</b> open</span>${s.overdue ? `<span class="bad"><b>${s.overdue}</b> overdue</span>` : ""}${s.pending ? `<span class="bad"><b>${Number(s.pending).toLocaleString("en-US")}</b> QAR pending</span>` : ""}</div>
      <div class="progress"><i style="width:${s.pct}%"></i></div>
      <div class="pfoot"><span>${s.done}/${s.total} done</span><span>${s.pct}%</span></div>
    </a>`;
  }
  function renderProjects() {
    const active = state.projects.filter(p => !p.archived);
    const archived = state.projects.filter(p => p.archived);
    $("view").innerHTML = `
      <div class="projects">
        ${active.map(projectCard).join("")}
        <button class="pcard add" data-act="new-project">+ New project</button>
      </div>
      ${archived.length ? `<section class="section archived-h"><div class="section-h"><h2>Archived</h2><span class="c">${archived.length}</span></div><div class="projects">${archived.map(projectCard).join("")}</div></section>` : ""}`;
  }

  function renderProject(p) {
    const tab = state.projectTab[p.id] || "open";
    const ts = state.tasks.filter(t => t.project_id === p.id);
    const counts = {
      open: ts.filter(t => t.status !== "done").length,
      waiting: ts.filter(t => t.status === "waiting").length,
      money: ts.filter(owes).length,
      done: ts.filter(t => t.status === "done").length,
      all: ts.length
    };
    const labels = { open: "Open", waiting: "Waiting", money: "Pending QAR", done: "Done", all: "All" };
    let list = ts;
    if (tab === "open") list = ts.filter(t => t.status !== "done");
    else if (tab === "waiting") list = ts.filter(t => t.status === "waiting");
    else if (tab === "money") list = ts.filter(owes);
    else if (tab === "done") list = ts.filter(t => t.status === "done");
    const s = projectStats(p);
    const tabs = Object.keys(labels).filter(k => k !== "money" || counts.money || tab === "money");

    $("view").innerHTML = `
      <div class="phead">
        <div class="nums"><span><b>${s.open}</b> open</span><span><b>${s.done}</b> done</span>${s.overdue ? `<span style="color:var(--bad)"><b style="color:inherit">${s.overdue}</b> overdue</span>` : ""}${s.pending ? `<span><b style="color:var(--bad)">${money(s.pending)}</b> pending</span>` : ""}</div>
        <div class="progress" style="--pc:${esc(p.color)}"><i style="width:${s.pct}%"></i></div>
      </div>
      ${p.archived ? `<div class="formmsg ok">This project is archived. Its tasks stay out of Today.</div>` : ""}
      <div class="seg" role="tablist">${tabs.map(k => `<button class="${k === tab ? "on" : ""}" data-act="ptab" data-tab="${k}" data-id="${p.id}">${labels[k]}<span class="c">${counts[k]}</span></button>`).join("")}</div>
      ${list.length ? `<div class="list">${sortTasks(list).map(t => taskCard(t, false)).join("")}</div>`
        : `<div class="empty"><strong>${ts.length ? "Nothing here" : "No tasks yet"}</strong><span>${ts.length ? "Try another tab." : "Add the first task for " + esc(p.name) + "."}</span>${ts.length ? "" : `<button class="btn primary" data-act="new-task">Add task</button>`}</div>`}`;
  }

  /* ---------- Search ---------- */
  function renderSearch() {
    const q = state.search.trim().toLowerCase();
    const hits = q ? state.tasks.filter(t => [t.title, t.client, t.ref, t.details, (projectOf(t.project_id) || {}).name, (state.lastUpdate[t.id] || {}).body]
      .some(v => v && String(v).toLowerCase().includes(q))) : [];
    if (!$("searchInput")) {
      $("view").innerHTML = `
        <div class="searchbar"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
          <input class="input" id="searchInput" type="search" placeholder="Client, job no., PO, task…" autocomplete="off" enterkeyhint="search"></div>
        <div id="searchResults" style="display:grid;gap:8px"></div>`;
      const inp = $("searchInput");
      inp.value = state.search;
      if (!q) setTimeout(() => inp.focus(), 50);
    }
    $("searchResults").innerHTML = q
      ? (hits.length ? `<div class="list">${sortTasks(hits).map(t => taskCard(t, true)).join("")}</div>` : `<div class="empty">No tasks match “${esc(state.search)}”.</div>`)
      : `<div class="empty">Search across every project by client, job number, PO or update.</div>`;
  }

  /* ---------- Settings ---------- */
  function renderSettings() {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    $("view").innerHTML = `
      <section class="card">
        <h2>Account</h2>
        <p>Signed in as <strong>${esc(state.user.email)}</strong></p>
        <button class="btn" data-act="sign-out">Sign out</button>
      </section>
      ${standalone ? "" : `<section class="card">
        <h2>Install on your phone</h2>
        ${ios ? `<ol><li>Open this page in Safari.</li><li>Tap the Share button.</li><li>Choose <strong>Add to Home Screen</strong>, then Add.</li></ol>`
              : `<ol><li>Open this page in Chrome.</li><li>Tap the ⋮ menu.</li><li>Choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li></ol>`}
        ${deferredInstall ? `<button class="btn primary" data-act="install">Install Job Desk</button>` : ""}
      </section>`}
      <section class="card">
        <h2>Projects</h2>
        <p>${state.projects.filter(p => !p.archived).length} active, ${state.projects.filter(p => p.archived).length} archived. Edit or archive a project from its page.</p>
        <a class="btn" href="#/projects">Manage projects</a>
      </section>`;
  }

  /* ---------- Sheets ---------- */
  function openSheet(s) { state.sheet = s; $("sheetWrap").hidden = false; document.body.style.overflow = "hidden"; renderSheet(); }
  function closeSheet() { state.sheet = null; $("sheetWrap").hidden = true; document.body.style.overflow = ""; }

  function renderSheet() {
    const s = state.sheet;
    if (!s) return;
    if (s.kind === "task") renderTaskSheet(s);
    else renderProjectSheet(s);
  }

  function renderTaskSheet(s) {
    const isNew = !s.id;
    const t = isNew ? s.draft : state.tasks.find(x => x.id === s.id);
    if (!t) { closeSheet(); return; }
    const projects = state.projects.filter(p => !p.archived || p.id === t.project_id);
    const ups = s.updates;
    // keep a half-typed update across re-renders
    const draftUpdate = $("upInput") ? $("upInput").value : "";
    $("sheet").innerHTML = `
      <div class="grabber"></div>
      <div class="sheet-h">
        <h2>${isNew ? "New task" : "Task"}</h2>
        <button class="iconbtn" data-act="close-sheet" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      <form id="taskForm" class="sheet-body" style="display:grid;gap:14px" novalidate>
        <label class="field"><span>Task</span><textarea class="input" id="tf-title" name="title" rows="2" required placeholder="What needs doing?" style="min-height:64px">${esc(t.title)}</textarea></label>
        <div class="status-seg" role="group" aria-label="Status">${Object.keys(STATUS).map(k => `<button type="button" class="${k} ${t.status === k ? "on" : ""}" data-act="set-status" data-s="${k}">${STATUS[k]}</button>`).join("")}</div>
        <div class="grid2">
          <label class="field"><span>Project</span><select class="input" id="tf-project" name="project_id">${projects.map(p => `<option value="${p.id}" ${p.id === t.project_id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
          <label class="field"><span>Due date</span><input class="input" id="tf-due" name="due" type="date" value="${esc(t.due || "")}"></label>
        </div>
        <label class="toggle"><span>Urgent</span><input type="checkbox" id="tf-urgent" name="urgent" ${t.urgent ? "checked" : ""}></label>
        <div class="grid2">
          <label class="field"><span>Client / who</span><input class="input" id="tf-client" name="client" value="${esc(t.client || "")}" autocomplete="off"></label>
          <label class="field"><span>Ref (job, PO, inv)</span><input class="input" id="tf-ref" name="ref" value="${esc(t.ref || "")}" autocomplete="off"></label>
        </div>
        <div class="grid2">
          <label class="field"><span>Amount pending (QAR)</span><input class="input num" id="tf-amount" name="amount" type="number" inputmode="decimal" min="0" step="0.01" value="${t.amount ?? ""}"></label>
          <label class="toggle" style="align-self:end"><span>Received / settled</span><input type="checkbox" id="tf-settled" name="amount_settled" ${t.amount_settled ? "checked" : ""}></label>
        </div>
        <label class="field"><span>Details</span><textarea class="input" id="tf-details" name="details" rows="3" placeholder="Item, supplier, notes…">${esc(t.details || "")}</textarea></label>
        ${isNew ? `<div class="sheet-foot"><button class="btn primary block" type="submit">Add task</button></div>` : ""}
      </form>
      ${isNew ? "" : `
      <section class="updates">
        <h3>Progress updates</h3>
        <form class="upform" id="upForm">
          <input class="input" id="upInput" placeholder="Log an update…" autocomplete="off" enterkeyhint="send">
          <button class="btn primary" type="submit">Log</button>
        </form>
        ${!ups ? `<p style="color:var(--muted);margin:0">Loading…</p>` : ups.length ? `<ol class="timeline">${ups.map(u => `<li class="${u.kind}"><span class="pt"></span><div><time>${fmtStamp(u.created_at)}</time><div class="body">${esc(u.body)}</div></div></li>`).join("")}</ol>` : `<p style="color:var(--muted);margin:0">No updates yet. Log what happened, who you spoke to, or what's next.</p>`}
      </section>
      <div class="sheet-foot">
        <button class="btn danger" data-act="delete-task" data-id="${t.id}">${s.confirmDelete ? "Tap again to delete" : "Delete task"}</button>
      </div>`}`;
    if (draftUpdate && $("upInput")) $("upInput").value = draftUpdate;
    if (isNew && !s.focused) { s.focused = true; setTimeout(() => $("tf-title") && $("tf-title").focus(), 60); }
  }

  function readTaskForm() {
    const amt = $("tf-amount").value;
    return {
      title: $("tf-title").value.trim(),
      project_id: $("tf-project").value,
      due: $("tf-due").value || null,
      urgent: $("tf-urgent").checked,
      client: $("tf-client").value.trim() || null,
      ref: $("tf-ref").value.trim() || null,
      amount: amt === "" ? null : Number(amt),
      amount_settled: $("tf-settled").checked,
      details: $("tf-details").value.trim() || null
    };
  }

  function newTask(projectId) {
    const r = state.route;
    const pid = projectId || (r.name === "project" ? r.id : (state.projects.find(p => !p.archived) || {}).id);
    openSheet({ kind: "task", id: null, draft: { title: "", project_id: pid, status: "todo", urgent: false, due: null, client: "", ref: "", amount: null, amount_settled: false, details: "" } });
  }

  async function createTask() {
    const f = readTaskForm();
    if (!f.title) { $("tf-title").focus(); toast("Give the task a name."); return; }
    const row = { ...f, status: state.sheet.draft.status, sort: Date.now() };
    const { data, error } = await sb.from("tasks").insert(row).select().single();
    if (error) return fail(error);
    state.tasks.push(data);
    await sb.from("task_updates").insert({ task_id: data.id, body: "Task created", kind: "system" });
    closeSheet();
    render();
    toast("Task added");
  }

  function renderProjectSheet(s) {
    const p = s.id ? projectOf(s.id) : { name: "", color: COLORS[state.projects.length % COLORS.length], archived: false };
    $("sheet").innerHTML = `
      <div class="grabber"></div>
      <div class="sheet-h">
        <h2>${s.id ? "Edit project" : "New project"}</h2>
        <button class="iconbtn" data-act="close-sheet" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      <form id="projectForm" style="display:grid;gap:16px" novalidate>
        <label class="field"><span>Name</span><input class="input" id="pf-name" value="${esc(p.name)}" maxlength="80" placeholder="e.g. QCLOUD, Fitness Hub" autocomplete="off" required></label>
        <div class="field"><span>Colour</span><div class="colors">${COLORS.map((c, i) => `<label><input type="radio" name="color" id="pf-c${i}" value="${c}" ${c === p.color ? "checked" : ""}><span style="--sw:${c}"></span></label>`).join("")}</div></div>
        <div class="sheet-foot"><button class="btn primary" type="submit">${s.id ? "Save" : "Create project"}</button></div>
      </form>
      ${s.id ? `<div class="sheet-foot">
        <button class="btn" data-act="archive-project" data-id="${p.id}">${p.archived ? "Restore project" : "Archive project"}</button>
        <button class="btn danger" data-act="delete-project" data-id="${p.id}">${s.confirmDelete ? "Delete project and all its tasks?" : "Delete project"}</button>
      </div>` : ""}`;
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
      closeSheet(); location.hash = "#/p/" + data.id; toast("Project created");
    }
  }

  /* ---------- events ---------- */
  document.addEventListener("click", async e => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act, id = el.dataset.id;
    switch (act) {
      case "toggle-done": e.stopPropagation(); toggleDone(id); break;
      case "open-task": openSheet({ kind: "task", id, updates: null }); loadUpdates(id); break;
      case "close-sheet": closeSheet(); break;
      case "new-task": newTask(); break;
      case "new-project": openSheet({ kind: "project", id: null }); break;
      case "edit-project": openSheet({ kind: "project", id }); break;
      case "ptab": state.projectTab[id] = el.dataset.tab; render(); break;
      case "reload": loadAll(); break;
      case "sign-out": await sb.auth.signOut(); break;
      case "install": if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; render(); } break;
      case "set-status": {
        const s = state.sheet; const st = el.dataset.s;
        if (!s.id) { s.draft = { ...s.draft, ...readTaskForm(), status: st }; renderSheet(); break; }
        const t = state.tasks.find(x => x.id === s.id);
        if (t && t.status !== st) { await patchTask(s.id, { status: st }, `Status → ${STATUS[st]}`); renderSheet(); }
        break;
      }
      case "delete-task": {
        const s = state.sheet;
        if (!s.confirmDelete) { s.confirmDelete = true; renderSheet(); break; }
        closeSheet();
        state.tasks = state.tasks.filter(t => t.id !== id); render();
        const { error } = await sb.from("tasks").delete().eq("id", id);
        if (error) fail(error); else toast("Task deleted");
        break;
      }
      case "archive-project": {
        const p = projectOf(id); const archived = !p.archived;
        const { error } = await sb.from("projects").update({ archived }).eq("id", id);
        if (error) return fail(error);
        p.archived = archived; closeSheet(); render(); toast(archived ? "Project archived" : "Project restored");
        break;
      }
      case "delete-project": {
        const s = state.sheet;
        if (!s.confirmDelete) { s.confirmDelete = true; renderSheet(); break; }
        const { error } = await sb.from("projects").delete().eq("id", id);
        if (error) return fail(error);
        state.projects = state.projects.filter(p => p.id !== id);
        state.tasks = state.tasks.filter(t => t.project_id !== id);
        closeSheet(); location.hash = "#/projects"; toast("Project deleted");
        break;
      }
    }
  });

  $("backBtn").addEventListener("click", () => { location.hash = "#/projects"; });
  $("fab").addEventListener("click", () => newTask());

  // Autosave fields of an existing task when they change
  document.addEventListener("change", e => {
    const s = state.sheet;
    if (!s || s.kind !== "task" || !s.id || !e.target.closest("#taskForm")) return;
    const t = state.tasks.find(x => x.id === s.id); if (!t) return;
    const f = readTaskForm();
    if (!f.title) { toast("A task needs a name."); $("tf-title").value = t.title; return; }
    const changed = {}; const notes = [];
    Object.keys(f).forEach(k => { if ((f[k] ?? null) !== (t[k] ?? null) && String(f[k] ?? "") !== String(t[k] ?? "")) changed[k] = f[k]; });
    if (!Object.keys(changed).length) return;
    if ("due" in changed) notes.push(changed.due ? `Due date → ${fmtDay(changed.due)}` : "Due date cleared");
    if ("amount_settled" in changed) notes.push(changed.amount_settled ? `Received ${money(f.amount)}` : "Marked as not received");
    if ("project_id" in changed) notes.push(`Moved to ${(projectOf(changed.project_id) || {}).name}`);
    if ("urgent" in changed) notes.push(changed.urgent ? "Flagged urgent" : "Urgent flag removed");
    patchTask(s.id, changed, notes.join(" · ") || null);
  });

  document.addEventListener("submit", e => {
    e.preventDefault();
    if (e.target.id === "taskForm") createTask();
    else if (e.target.id === "projectForm") saveProject();
    else if (e.target.id === "upForm") {
      const inp = $("upInput"); const text = inp.value.trim();
      if (!text || !state.sheet) return;
      inp.value = ""; addUpdate(state.sheet.id, text, "note");
    }
    else if (e.target.id === "authForm") submitAuth();
  });

  document.addEventListener("input", e => {
    if (e.target.id === "searchInput") { state.search = e.target.value; renderSearch(); }
  });

  document.addEventListener("keydown", e => { if (e.key === "Escape" && state.sheet) closeSheet(); });

  // swipe down on the sheet's grabber area to close
  let startY = null;
  $("sheet").addEventListener("touchstart", e => { if ($("sheet").scrollTop <= 0) startY = e.touches[0].clientY; }, { passive: true });
  $("sheet").addEventListener("touchend", e => { if (startY !== null && e.changedTouches[0].clientY - startY > 110 && $("sheet").scrollTop <= 0) closeSheet(); startY = null; }, { passive: true });

  window.addEventListener("online", () => { $("offline").hidden = true; loadAll(); });
  window.addEventListener("offline", () => { $("offline").hidden = false; });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.user) loadAll(); });

  let deferredInstall = null;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredInstall = e; if (state.route.name === "settings") render(); });

  /* ---------- auth ---------- */
  function renderAuth(msg) {
    const m = state.authMode;
    const titles = { signin: "Sign in", signup: "Create your account", reset: "Reset password", newpass: "Set a new password" };
    const btn = { signin: "Sign in", signup: "Create account", reset: "Send reset link", newpass: "Save password" };
    $("auth").innerHTML = `
      <form class="auth-card" id="authForm" novalidate>
        <div class="brand"><img src="/icons/icon-192.png" width="48" height="48" alt=""><div><h1>Job Desk</h1><p>${titles[m]}</p></div></div>
        ${msg ? `<div class="formmsg ${msg.type}">${esc(msg.text)}</div>` : ""}
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
    if (m !== "newpass" && !/^\S+@\S+\.\S+$/.test(email)) return renderAuthKeep({ type: "err", text: "Enter a valid email address." }, email);
    if (m !== "reset" && pass.length < 8) return renderAuthKeep({ type: "err", text: "Password needs at least 8 characters." }, email);
    $("af-btn").disabled = true;
    let res;
    if (m === "signin") res = await sb.auth.signInWithPassword({ email, password: pass });
    else if (m === "signup") res = await sb.auth.signUp({ email, password: pass, options: { emailRedirectTo: location.origin } });
    else if (m === "reset") res = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
    else res = await sb.auth.updateUser({ password: pass });
    if (res.error) {
      const text = /invalid login/i.test(res.error.message) ? "Email or password is wrong." : /not confirmed/i.test(res.error.message) ? "Confirm your email first. Check your inbox for the link." : res.error.message;
      return renderAuthKeep({ type: "err", text }, email);
    }
    if (m === "signup" && !res.data.session) { state.authMode = "signin"; return renderAuthKeep({ type: "ok", text: "Account created. Check your email for a confirmation link, then sign in here." }, email); }
    if (m === "reset") { state.authMode = "signin"; return renderAuthKeep({ type: "ok", text: "Reset link sent. Open it on this device." }, email); }
    if (m === "newpass") { state.recovery = false; toast("Password updated"); showApp(); }
  }
  function renderAuthKeep(msg, email) { renderAuth(msg); if ($("af-email")) $("af-email").value = email || ""; }

  function showAuth() {
    $("boot").hidden = true; $("app").hidden = true; $("auth").hidden = false;
    closeSheet(); renderAuth();
  }
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
    if (!state.user) { state.projects = []; state.tasks = []; state.loaded = false; if (channel) sb.removeChannel(channel); showAuth(); }
    else if (prev !== state.user.id) showApp();
  });

  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
})();
