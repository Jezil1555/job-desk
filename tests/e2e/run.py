"""End-to-end UI test: drives the real frontend in headless Chromium against an in-memory
fake of the Supabase REST API (the real database is tested separately in supabase/tests).

Usage:  npm i --no-save @supabase/supabase-js@2.45.4 && python3 tests/e2e/run.py [--shots DIR]
Exit code 0 = all checks passed.
"""
import json, os, re, sys, threading, time, uuid, functools, http.server, datetime as dt
from urllib.parse import urlparse, parse_qs, unquote
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PUB = os.path.join(ROOT, "public")
UMD = os.path.join(ROOT, "node_modules/@supabase/supabase-js/dist/umd/supabase.js")
SHOTS = sys.argv[sys.argv.index("--shots") + 1] if "--shots" in sys.argv else None
if SHOTS: os.makedirs(SHOTS, exist_ok=True)

http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(http.server.SimpleHTTPRequestHandler, directory=PUB))
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{PORT}"

ME, ADIL = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
now = dt.datetime.now(dt.timezone.utc)
iso = lambda d: d.isoformat().replace("+00:00", "Z")
WS = ["aaaaaaa1-0000-4000-8000-000000000001", "aaaaaaa1-0000-4000-8000-000000000002", "aaaaaaa1-0000-4000-8000-000000000003"]
P1 = "bbbbbbb1-0000-4000-8000-000000000001"

def fresh_db():
    t = lambda **k: {"id": k.pop("id", str(uuid.uuid4())), "workspace_id": WS[1], "project_id": None, "parent_id": None, "milestone_id": None, "title": "Task", "description": None,
                     "category": None, "status": "not_started", "priority": "medium", "owner_id": ME, "created_by": ME, "start_date": None, "due_at": None, "due_all_day": True,
                     "follow_up_at": None, "progress": 0, "next_action": None, "completion_criteria": [], "waiting_on": None, "waiting_on_contact_id": None, "waiting_for": None,
                     "blocker": None, "blocker_impact": None, "unblock_action": None, "recurrence": None, "recurrence_parent_id": None, "cancelled_reason": None,
                     "deleted_at": None, "client_name": None, "reference": None, "completed_at": None, "created_at": iso(now - dt.timedelta(days=4)), "updated_at": iso(now - dt.timedelta(hours=3)), **k}
    return {
        "workspaces": [
            {"id": WS[0], "owner_id": ME, "name": "D'Lusso & Mediate", "color": "#6b4b8a", "kind": "business", "archived": False, "sort": 0, "description": None},
            {"id": WS[1], "owner_id": ME, "name": "QCLOUD", "color": "#1f6aa0", "kind": "professional", "archived": False, "sort": 1, "description": "Logistics"},
            {"id": WS[2], "owner_id": ME, "name": "Personal & Family", "color": "#5f6b78", "kind": "personal", "archived": False, "sort": 10, "description": None}],
        "workspace_members": [{"workspace_id": w, "user_id": ME, "role": "owner"} for w in WS] + [{"workspace_id": WS[1], "user_id": ADIL, "role": "member"}],
        "profiles": [{"id": ME, "email": "jezz@example.com", "display_name": "Jezz", "timezone": "Asia/Qatar", "prefs": {}},
                     {"id": ADIL, "email": "adil@example.com", "display_name": "Adil Rahman", "timezone": "Asia/Qatar", "prefs": {}}],
        "projects": [{"id": P1, "workspace_id": WS[1], "name": "Kite BOM delivery", "description": "Cabling BOM for site", "owner_id": ME, "priority": "high",
                      "start_date": "2026-10-01", "target_date": "2026-11-30", "manual_status": None, "manual_status_reason": None, "budget": None, "budget_currency": None,
                      "next_action": "Confirm revised dispatch date", "archived": False, "created_by": ME, "created_at": iso(now), "updated_at": iso(now)}],
        "milestones": [{"id": str(uuid.uuid4()), "project_id": P1, "title": "Material readiness", "planned_date": "2026-10-20", "actual_date": "2026-10-22", "weight": 1, "is_critical": False, "notes": None, "sort": 0},
                       {"id": str(uuid.uuid4()), "project_id": P1, "title": "Customs clearance", "planned_date": "2026-10-27", "actual_date": None, "weight": 2, "is_critical": True, "notes": None, "sort": 1}],
        "tasks": [
            t(id="t-over", title="Follow up with supplier on delayed shipment", priority="critical", project_id=P1, due_at=iso(now - dt.timedelta(days=1)), next_action="Request written update and recovery plan"),
            t(id="t-wait", title="Customs BOE clearance", status="waiting", waiting_on="Clearing agent", project_id=P1, follow_up_at=iso(now - dt.timedelta(hours=1))),
            t(id="t-crit", title="Book container", priority="high", completion_criteria=[{"text": "Booking confirmation saved", "done": False}], due_at=iso(now + dt.timedelta(days=2))),
            t(id="t-inbox", title="Look into new freight forwarder", status="inbox", workspace_id=WS[2]),
            t(id="t-done", title="Send PO to supplier", status="completed", completed_at=iso(now - dt.timedelta(days=1))),
            t(id="t-deleg", title="Prepare GRN for site", owner_id=ADIL, project_id=P1),
        ],
        "task_dependencies": [{"task_id": "t-crit", "depends_on_id": "t-over"}],
        "follow_ups": [{"id": "f-1", "workspace_id": WS[1], "task_id": None, "project_id": P1, "contact_id": None, "counterpart": "Al Muthawa Trading", "subject": "Revised dispatch date",
                        "direction": "they_owe", "last_contact_at": "2026-10-26", "expected_at": "2026-10-27", "next_follow_up_at": iso(now - dt.timedelta(hours=2)), "escalate_at": None,
                        "status": "open", "notes": None, "document_url": None, "owner_id": ME, "created_by": ME, "closed_at": None, "created_at": iso(now), "updated_at": iso(now)}],
        "contacts": [], "notifications": [{"id": str(uuid.uuid4()), "user_id": ME, "kind": "overdue", "title": "Overdue: Follow up with supplier", "body": "QCLOUD", "url": "/#/t/t-over", "task_id": "t-over", "follow_up_id": None, "read_at": None, "created_at": iso(now)}],
        "task_comments": [], "activity": [], "follow_up_logs": [], "task_contacts": [], "push_subscriptions": []
    }

DB = fresh_db()
REQUESTS = []

def health():
    out = []
    for p in DB["projects"]:
        ts = [t for t in DB["tasks"] if t["project_id"] == p["id"] and not t["deleted_at"]]
        ms = [m for m in DB["milestones"] if m["project_id"] == p["id"]]
        wt = sum(m["weight"] for m in ms); wd = sum(m["weight"] for m in ms if m["actual_date"])
        late = [m for m in ms if not m["actual_date"] and m["planned_date"] and m["planned_date"] < now.date().isoformat()]
        status = "blocked" if any(m["is_critical"] for m in late) else "at_risk" if late else "on_track"
        nxt = next((m for m in sorted(ms, key=lambda m: m["planned_date"] or "9") if not m["actual_date"]), None)
        out.append({"project_id": p["id"], "workspace_id": p["workspace_id"], "progress": round(100 * wd / wt) if wt else None, "progress_basis": "milestones" if ms else "none",
                    "calculated_status": status, "effective_status": p["manual_status"] or status, "reasons": [f"{len(late)} critical milestone(s) overdue"] if late else [],
                    "next_milestone_title": nxt and nxt["title"], "next_milestone_date": nxt and nxt["planned_date"], "task_total": len(ts), "task_open": len([t for t in ts if t["status"] not in ("completed", "cancelled")])})
    return out

def rule_check(row, old=None):
    if row.get("status") == "waiting" and not (row.get("waiting_on") or "").strip(): return "waiting_needs_person: say who you are waiting on"
    if row.get("status") == "blocked" and not (row.get("blocker") or "").strip(): return "blocked_needs_reason: describe what is blocking this task"
    if row.get("status") == "completed" and (old is None or old.get("status") != "completed"):
        if any(not c.get("done") for c in row.get("completion_criteria") or []): return "criteria_incomplete: tick every completion criterion before completing"
        open_pre = [d for d in DB["task_dependencies"] if d["task_id"] == row["id"] and next((t for t in DB["tasks"] if t["id"] == d["depends_on_id"] and t["status"] not in ("completed", "cancelled")), None)]
        if open_pre: return f"dependencies_incomplete: {len(open_pre)} prerequisite task(s) still open"
    if old and old.get("status") == "completed" and row.get("status") != "completed": return "reopen_reason_required: give a reason for reopening"
    return None

def handle(route):
    req = route.request; u = urlparse(req.url); path = u.path; qs = parse_qs(u.query)
    single = "vnd.pgrst.object" in (req.headers.get("accept") or "")
    REQUESTS.append((req.method, path))
    def reply(body, status=200): route.fulfill(status=status, content_type="application/json", body=json.dumps(body))
    def err(msg): reply({"code": "P0001", "message": msg, "details": None, "hint": None}, 400)
    if path.startswith("/auth/v1/"): return reply({"id": ME, "email": "jezz@example.com"})
    if path.startswith("/rest/v1/rpc/"):
        fn = path.rsplit("/", 1)[1]; body = json.loads(req.post_data or "{}")
        if fn == "search_all":
            q = body.get("q", "").lower()
            return reply([{"kind": "task", "id": t["id"], "title": t["title"], "subtitle": "", "workspace_id": t["workspace_id"]} for t in DB["tasks"] if q in t["title"].lower()])
        if fn == "reopen_task":
            t = next(t for t in DB["tasks"] if t["id"] == body["p_task"]); t["status"] = body["p_status"]; t["completed_at"] = None
            DB["task_comments"].append({"id": str(uuid.uuid4()), "task_id": t["id"], "author_id": ME, "body": "Reopened: " + body["p_reason"], "kind": "status", "created_at": iso(dt.datetime.now(dt.timezone.utc))})
            return reply(None)
        return reply(None)
    table = path.split("/rest/v1/")[1]
    if table == "project_health": return reply(health())
    rows = DB.setdefault(table, [])
    def match(r):
        for k, v in qs.items():
            if k in ("select", "order", "limit", "or", "on_conflict", "columns"): continue
            v = v[0]
            if v.startswith("eq."):
                if str(r.get(k)).lower() != unquote(v[3:]).lower() and str(r.get(k)) != unquote(v[3:]): return False
            elif v.startswith("is.null") and r.get(k) is not None: return False
            elif v.startswith("in.("):
                vals = v[4:-1].split(",")
                if str(r.get(k)) not in vals: return False
        return True
    if req.method == "GET":
        out = [r for r in rows if match(r)]
        return reply(out[0] if single and out else (None if single else out))
    if req.method == "POST":
        body = json.loads(req.post_data); items = body if isinstance(body, list) else [body]; out = []
        for it in items:
            if table == "tasks":
                it = {**fresh_db()["tasks"][0], "id": str(uuid.uuid4()), "created_by": ME, "owner_id": ME, "project_id": None, "title": "", "priority": "medium", "status": "not_started", "due_at": None, "next_action": None, "completed_at": None, **it, "created_at": iso(dt.datetime.now(dt.timezone.utc)), "updated_at": iso(dt.datetime.now(dt.timezone.utc))}
                e = rule_check(it)
                if e: return err(e)
            else:
                it = {"id": str(uuid.uuid4()), "created_at": iso(dt.datetime.now(dt.timezone.utc)), "author_id": ME, "created_by": ME, **it}
            if table == "push_subscriptions": rows[:] = [r for r in rows if r.get("endpoint") != it.get("endpoint")]
            rows.append(it); out.append(it)
        return reply(out[0] if single else out, 201)
    if req.method == "PATCH":
        body = json.loads(req.post_data); out = []
        for r in rows:
            if match(r):
                new = {**r, **body}
                if table == "tasks":
                    e = rule_check(new, r)
                    if e: return err(e)
                    if new["status"] == "completed" and r["status"] != "completed": new["completed_at"] = iso(dt.datetime.now(dt.timezone.utc)); new["progress"] = 100
                    new["updated_at"] = iso(dt.datetime.now(dt.timezone.utc))
                r.clear(); r.update(new); out.append(r)
        return reply(out[0] if single and out else out)
    if req.method == "DELETE":
        rows[:] = [r for r in rows if not match(r)]
        return reply([])
    reply([])

results, errors = [], []
def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail and not cond else ""))

session = {"access_token": "x", "token_type": "bearer", "expires_in": 3600, "expires_at": int(time.time()) + 36000, "refresh_token": "r",
           "user": {"id": ME, "email": "jezz@example.com", "aud": "authenticated"}}

def new_page(browser, w, h, scheme="light"):
    ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=2, color_scheme=scheme, service_workers="block", timezone_id="Asia/Qatar")
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" and "ERR_FAILED" not in m.text and "WebSocket" not in m.text and "websocket" not in m.text else None)
    page.route("https://cdn.jsdelivr.net/**", lambda r: r.fulfill(path=UMD, content_type="application/javascript"))
    page.route(re.compile(r"https://fonts\.(googleapis|gstatic)\.com/.*"), lambda r: r.abort())
    page.route(re.compile(r"https://.*\.supabase\.co/.*"), handle)
    page.add_init_script(f"localStorage.setItem('sb-lvusersarnzzamdgvxgm-auth-token', {json.dumps(json.dumps(session))})")
    return ctx, page

def shot(page, name, full=False):
    if SHOTS: page.screenshot(path=os.path.join(SHOTS, name + ".png"), full_page=full)

with sync_playwright() as pw:
    b = pw.chromium.launch()

    # ---------- signed-out ----------
    ctx = b.new_context(viewport={"width": 390, "height": 844}, service_workers="block")
    pg = ctx.new_page(); pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    pg.route("https://cdn.jsdelivr.net/**", lambda r: r.fulfill(path=UMD, content_type="application/javascript"))
    pg.route(re.compile(r"https://.*\.supabase\.co/.*"), handle)
    pg.goto(BASE + "/"); pg.wait_for_selector("#authForm", timeout=8000)
    check("sign-in screen renders when signed out", pg.is_visible("#af-email") and pg.is_visible("#af-pass"))
    pg.click("#af-btn"); check("sign-in validates email before calling the server", "valid email" in pg.inner_text("#authForm"))
    ctx.close()

    # ---------- desktop ----------
    ctx, page = new_page(b, 1360, 900)
    page.goto(BASE + "/#/home"); page.wait_for_selector(".tiles", timeout=10000)
    check("desktop sidebar shows all 9 sections", page.locator(".sidenav nav a").count() == 9)
    check("Command Centre shows real overdue count", page.inner_text(".tile.bad .tn").strip() == "1")
    check("attention list ranks overdue critical task first", "Follow up with supplier" in page.locator(".attn-row").first.inner_text())
    check("project health shows blocked (critical milestone overdue)", "Blocked" in page.inner_text(".ph-list"))
    shot(page, "01-home-desktop", True)

    # Quick capture without a deadline
    page.keyboard.press("n"); page.wait_for_selector("#capForm")
    page.fill("#cap-title", "Call Hydromaster about cargo pants sample")
    page.click("#capSave"); page.wait_for_selector("text=Capture another")
    created = [t for t in DB["tasks"] if t["title"] == "Call Hydromaster about cargo pants sample"]
    check("quick capture saves to the server", len(created) == 1)
    check("captured task has no invented deadline or follow-up", created and created[0]["due_at"] is None and created[0]["follow_up_at"] is None)
    check("captured task defaults: inbox, medium, owner = me", created and created[0]["status"] == "inbox" and created[0]["priority"] == "medium" and created[0]["owner_id"] == ME)
    page.click("text=Capture another"); page.fill("#cap-title", "Renew trade licence")
    page.check('input[value="not_started"]', force=True)
    page.click('[data-act="cap-more"]'); page.click('[data-act="cap-quick"][data-f="due"][data-n="7"]')
    page.select_option("#cap-priority", "high"); page.click("#capSave"); page.wait_for_selector("text=Capture another")
    t2 = next((t for t in DB["tasks"] if t["title"] == "Renew trade licence"), None)
    check("capture with deadline stores a UTC timestamp at 23:59 Doha", t2 and t2["due_at"] and t2["due_at"].endswith("T20:59:00.000Z"), str(t2 and t2["due_at"]))
    check("capture as 'Ready to work' sets Not started + High", t2 and t2["status"] == "not_started" and t2["priority"] == "high")
    page.click('[data-act="close-sheet"] >> nth=0')

    # Completion rules
    page.goto(BASE + "/#/tasks/all"); page.wait_for_selector(".list")
    page.click('.trow[data-id="t-crit"] .tcheck'); page.wait_for_selector(".toast.error")
    check("completion blocked by unticked criteria + open prerequisite (client message)", "criteri" in page.inner_text("#toast") and "prerequisite" in page.inner_text("#toast"))
    check("blocked completion didn't change the task", next(t for t in DB["tasks"] if t["id"] == "t-crit")["status"] == "not_started")

    # Open task, set waiting needs a person
    page.click('.trow[data-id="t-over"]'); page.wait_for_selector("#tf-title")
    check("task panel shows next action", page.input_value("#tf-next_action") == "Request written update and recovery plan")
    page.select_option("#tf-status", "waiting"); page.wait_for_selector(".dlg")
    page.click('.dlg [data-r="1"]'); check("waiting requires who you're waiting on", page.is_visible("#dlgErr"))
    page.fill("#dlgIn", "Al Muthawa Trading"); page.click('.dlg [data-r="1"]')
    page.wait_for_timeout(400)
    tov = next(t for t in DB["tasks"] if t["id"] == "t-over")
    check("status → Waiting saved with waiting_on", tov["status"] == "waiting" and tov["waiting_on"] == "Al Muthawa Trading")
    # follow-up date
    page.fill("#tf-fu-d", "2026-11-03"); page.fill("#tf-fu-t", "10:00"); page.locator("#tf-fu-t").dispatch_event("change")
    page.wait_for_timeout(400)
    check("follow-up date stored as UTC (10:00 Doha = 07:00Z)", (tov.get("follow_up_at") or "").startswith("2026-11-03T07:00"), str(tov.get("follow_up_at")))
    # add criterion + subtask + comment
    page.fill("#critInput", "Supplier response recorded"); page.click("#critForm button"); page.wait_for_timeout(300)
    check("completion criterion added", any(c["text"] == "Supplier response recorded" for c in tov["completion_criteria"]))
    page.click('[data-act="task-tab"][data-tab="plan"]'); page.fill("#subInput", "Email supplier for written update"); page.click("#subForm button"); page.wait_for_timeout(400)
    check("subtask created under the task", any(t["parent_id"] == "t-over" for t in DB["tasks"]))
    page.click('[data-act="task-tab"][data-tab="updates"]'); page.fill("#upInput", "Spoke to Rashid, written update promised by Sunday"); page.click("#upForm button"); page.wait_for_timeout(400)
    check("progress update logged", any(c["body"].startswith("Spoke to Rashid") for c in DB["task_comments"]))
    shot(page, "02-task-panel")
    page.keyboard.press("Escape")

    # Reopen requires a reason
    page.goto(BASE + "/#/tasks/completed"); page.wait_for_selector(".list")
    page.click('.trow[data-id="t-done"] .tcheck'); page.wait_for_selector(".dlg")
    page.click('.dlg [data-r="1"]'); check("reopen requires a reason", page.is_visible("#dlgErr"))
    page.fill("#dlgIn", "Supplier rejected the PO"); page.click('.dlg [data-r="1"]'); page.wait_for_timeout(500)
    td = next(t for t in DB["tasks"] if t["id"] == "t-done")
    check("reopen recorded with reason via RPC", td["status"] == "in_progress" and any("Supplier rejected" in c["body"] for c in DB["task_comments"]))

    # Board
    page.goto(BASE + "/#/tasks/all"); page.click('[data-act="task-mode"][data-m="board"]'); page.wait_for_selector(".board")
    check("board shows status columns", page.locator(".bcol").count() == 6)
    shot(page, "03-board")
    page.click('[data-act="task-mode"][data-m="list"]')

    # Project page
    page.goto(BASE + f"/#/p/{P1}"); page.wait_for_selector(".proj-hero")
    check("project shows milestone-weighted progress 33%", "33%" in page.inner_text(".proj-hero"))
    check("milestone variance shows days late from real dates", "2d late" in page.inner_text(".mslist"))
    shot(page, "04-project", True)

    # Follow-ups & calendar & search
    page.goto(BASE + "/#/followups"); page.wait_for_selector(".sect")
    check("follow-up due now is surfaced", "Follow up now" in page.inner_text("#view"))
    page.goto(BASE + "/#/calendar"); page.wait_for_selector(".cal-month")
    check("calendar month grid renders 42 days", page.locator(".cal-cell").count() == 42)
    shot(page, "05-calendar")
    page.goto(BASE + "/#/search"); page.fill("#global-q", "container"); page.wait_for_selector(".srow", timeout=4000)
    check("search returns matching task", "Book container" in page.inner_text("#searchResults"))
    page.goto(BASE + "/#/finance"); page.wait_for_selector(".planned")
    check("finance page is honest about not being built", "Not built yet" in page.inner_text("#view"))

    # Settings: hide a dashboard section persists to profile prefs
    page.goto(BASE + "/#/settings"); page.wait_for_selector(".settings")
    page.uncheck('[data-act="toggle-section"][data-k="activity"]'); page.wait_for_timeout(300)
    check("dashboard customisation saved to profile", "activity" in (next(p for p in DB["profiles"] if p["id"] == ME)["prefs"].get("dashboard_hidden") or []))
    page.goto(BASE + "/#/home"); page.wait_for_selector(".tiles")
    check("hidden section no longer shown", "Recent activity" not in page.inner_text("#view"))
    ctx.close()

    # ---------- phone, light + dark ----------
    for scheme in ["light", "dark"]:
        ctx, page = new_page(b, 390, 844, scheme)
        page.goto(BASE + "/#/home"); page.wait_for_selector(".tiles", timeout=10000)
        check(f"phone ({scheme}): bottom nav visible, sidebar hidden", page.is_visible("#bottomnav") and not page.is_visible("#sidenav"))
        overflow = page.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1")
        check(f"phone ({scheme}): no horizontal scroll on home", not overflow)
        shot(page, f"06-home-phone-{scheme}", True)
        if scheme == "light":
            page.click(".bn-capture"); page.wait_for_selector("#capForm"); shot(page, "07-capture-phone")
            page.keyboard.press("Escape")
            page.goto(BASE + "/#/tasks/today"); page.wait_for_selector(".viewtabs")
            check("phone: no horizontal scroll on tasks", not page.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"))
            shot(page, "08-tasks-phone", True)
            page.click('.trow[data-id="t-wait"]'); page.wait_for_selector("#tf-title"); shot(page, "09-task-phone")
        ctx.close()
    b.close()

srv.shutdown()
errs = [e for e in errors if "favicon" not in e]
check("no JavaScript errors in the console", not errs, "; ".join(errs[:5]))
failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
sys.exit(1 if failed else 0)
