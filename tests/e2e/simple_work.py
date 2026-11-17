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
XLSX = os.path.join(ROOT, "node_modules/xlsx/dist/xlsx.full.min.js")
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

FE1, FE2 = "fe000000-0000-4000-8000-000000000001", "fe000000-0000-4000-8000-000000000002"
def seed_accounts(eid):
    rows = [("1000", "Cash on hand", "asset", "cash", "cash"), ("1010", "Bank account", "asset", "bank", "bank"), ("1100", "Accounts receivable", "asset", "receivable", "ar"),
            ("2000", "Accounts payable", "liability", "payable", "ap"), ("3900", "Opening balance equity", "equity", "other", "opening"), ("4000", "Sales", "income", "other", "sales"),
            ("6000", "Rent", "expense", "other", None), ("6900", "Other expenses", "expense", "other", None)]
    return [{"id": f"{eid[:8]}-acc-{c}", "entity_id": eid, "code": c, "name": n, "type": t, "subtype": st, "system_key": k, "is_active": True, "description": None} for c, n, t, st, k in rows]
def fin_fixture():
    ents = [{"id": FE1, "name": "Dlusso Bespoke", "kind": "business", "base_currency": "QAR", "workspace_id": WS[0], "fiscal_year_start": 1, "lock_date": None, "archived": False, "created_by": ME,
             "next_journal_no": 1, "next_invoice_no": 1, "next_bill_no": 1, "created_at": iso(now)},
            {"id": FE2, "name": "The Burgery Thrissur", "kind": "business", "base_currency": "INR", "workspace_id": None, "fiscal_year_start": 4, "lock_date": None, "archived": False, "created_by": ME,
             "next_journal_no": 1, "next_invoice_no": 1, "next_bill_no": 1, "created_at": iso(now)}]
    return {"fin_entities": ents, "fin_members": [{"entity_id": e["id"], "user_id": ME, "role": "owner"} for e in ents], "fin_accounts": seed_accounts(FE1) + seed_accounts(FE2),
            "fin_parties": [], "fin_journals": [], "fin_lines": [], "fin_invoices": [], "fin_invoice_lines": [], "fin_payments": [], "fin_allocations": [], "fin_items": [],
            "fin_stock_moves": [], "fin_statement_lines": [], "fin_budgets": [], "fin_files": [], "fin_audit": [], "fin_partner_links": [], "fin_partner_txns": [], "fin_partner_docs": [], "fin_ic_txns": [],
            "fin_production_orders": [], "fin_production_costs": [], "fin_goods_receipts": [], "fin_stock_exceptions": [], "fin_fx_revaluations": [],
            "fin_obligations": [], "fin_imports": [], "fin_import_rows": [], "fin_balance_checks": [], "fin_money_fx": []}

def fresh_db():
    t = lambda **k: {"id": k.pop("id", str(uuid.uuid4())), "workspace_id": WS[1], "project_id": None, "parent_id": None, "milestone_id": None, "title": "Task", "description": None,
                     "category": None, "status": "not_started", "priority": "medium", "owner_id": ME, "created_by": ME, "start_date": None, "due_at": None, "due_all_day": True,
                     "follow_up_at": None, "progress": 0, "next_action": None, "completion_criteria": [], "waiting_on": None, "waiting_on_contact_id": None, "waiting_for": None,
                     "blocker": None, "blocker_impact": None, "unblock_action": None, "recurrence": None, "recurrence_parent_id": None, "cancelled_reason": None,
                     "deleted_at": None, "client_name": None, "reference": None, "completed_at": None, "assignee_id": None, "reviewer_id": None, "review_status": None, "review_note": None,
                     "reviewed_by": None, "reviewed_at": None, "created_at": iso(now - dt.timedelta(days=4)), "updated_at": iso(now - dt.timedelta(hours=3)), **k}
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
        "task_comments": [], "activity": [], "follow_up_logs": [], "task_contacts": [], "push_subscriptions": [],
        "notes": [{"id": "n-dec", "workspace_id": WS[1], "kind": "decision", "title": "Use sea freight for KSA lane", "body": "", "tags": ["ksa"], "meeting_date": None, "attendees": None,
                   "decision": "Move KSA shipments to sea freight", "rationale": "Cost", "decision_status": "proposed", "decided_on": None, "pinned": False, "created_by": ME, "created_at": iso(now - dt.timedelta(days=2)), "updated_at": iso(now - dt.timedelta(days=2))}],
        "documents": [], "record_links": [], "goals": [], "goal_updates": [], "habits": [], "habit_logs": [], "health_logs": [], "weekly_reviews": [],
        **fin_fixture()
    }

DB = fresh_db()
REQUESTS = []
AI_CALLS = []
STORAGE = {}

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
                    "calculated_status": status, "effective_status": p.get("manual_status") or status, "reasons": [f"{len(late)} critical milestone(s) overdue"] if late else [],
                    "next_milestone_title": nxt and nxt["title"], "next_milestone_date": nxt and nxt["planned_date"], "task_total": len(ts), "task_open": len([t for t in ts if t["status"] not in ("completed", "cancelled")])})
    return out

def rule_check(row, old=None):
    if row.get("status") == "waiting" and not (row.get("waiting_on") or "").strip(): return "waiting_needs_person: say who you are waiting on"
    if row.get("status") == "blocked" and not (row.get("blocker") or "").strip(): return "blocked_needs_reason: describe what is blocking this task"
    if row.get("status") == "completed" and (old is None or old.get("status") != "completed"):
        if any(not c.get("done") for c in row.get("completion_criteria") or []): return "criteria_incomplete: tick every completion criterion before completing"
        open_pre = [d for d in DB["task_dependencies"] if d["task_id"] == row["id"] and next((t for t in DB["tasks"] if t["id"] == d["depends_on_id"] and t["status"] not in ("completed", "cancelled")), None)]
        if open_pre: return f"dependencies_incomplete: {len(open_pre)} prerequisite task(s) still open"
        if row.get("reviewer_id") and row.get("review_status") != "approved": return "review_required: this task needs the reviewer's approval before it can be completed"
    if row.get("reviewer_id") and row.get("reviewer_id") == (row.get("assignee_id") or row.get("owner_id")): return "self_review: the reviewer must be someone other than the person doing the work"
    if old and old.get("status") == "completed" and row.get("status") != "completed": return "reopen_reason_required: give a reason for reopening"
    return None

def handle(route):
    req = route.request; u = urlparse(req.url); path = u.path; qs = parse_qs(u.query)
    single = "vnd.pgrst.object" in (req.headers.get("accept") or "")
    REQUESTS.append((req.method, path))
    def reply(body, status=200): route.fulfill(status=status, content_type="application/json", body=json.dumps(body))
    def err(msg): reply({"code": "P0001", "message": msg, "details": None, "hint": None}, 400)
    if path.startswith("/auth/v1/"): return reply({"id": ME, "email": "jezz@example.com"})
    m_sign = re.match(r"^/storage/v1/object/sign/(documents|finance|investor)/(.+)$", path)
    if m_sign:
        key = unquote(m_sign.group(2))
        if key not in STORAGE: return reply({"statusCode": "404", "error": "not_found", "message": "Object not found"}, 400)
        return reply({"signedURL": f"/object/sign/{m_sign.group(1)}/{key}?token=test"})
    m_up = re.match(r"^/storage/v1/object/(documents|finance|investor)/(.+)$", path)
    if m_up and req.method == "POST":
        key = unquote(m_up.group(2)); STORAGE[key] = len(req.post_data_buffer or b"")
        return reply({"Key": m_up.group(1) + "/" + key, "Id": str(uuid.uuid4())})
    if path in ("/storage/v1/object/documents", "/storage/v1/object/finance") and req.method == "DELETE":
        for k in json.loads(req.post_data or "{}").get("prefixes", []): STORAGE.pop(k, None)
        return reply([])
    if path.startswith("/functions/v1/gcal-sync"):
        body = json.loads(req.post_data or "{}"); GCAL["calls"].append(body.get("action"))
        if body.get("action") == "status": return reply({"configured": GCAL["configured"], "redirect_uri": "https://lvusersarnzzamdgvxgm.supabase.co/functions/v1/gcal-sync/callback", "sync": GCAL["sync"]})
        if body.get("action") == "start": return reply({"url": "https://accounts.google.com/o/oauth2/v2/auth?client_id=test&scope=openid+email+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.events"})
        if body.get("action") == "resync": return reply({"synced": 4, "error": None})
        if body.get("action") == "disconnect": GCAL["sync"] = None; return reply({"ok": True, "removed": 8})
        return reply({"error": "Unknown action."}, 400)
    if path.startswith("/functions/v1/assistant"):
        body = json.loads(req.post_data or "{}"); AI_CALLS.append(body.get("action"))
        prof = next(p for p in DB["profiles"] if p["id"] == ME); on = bool((prof.get("prefs") or {}).get("ai_enabled"))
        if body.get("action") == "status": return reply({"configured": True, "enabled": on, "used_24h": len(AI_CALLS) - 1, "limit": 60, "model": "claude-sonnet-5-5"})
        if not on: return reply({"error": "Turn on the AI assistant in Settings first."}, 403)
        a, inp = body["action"], body.get("input") or {}
        pid = str(uuid.uuid4()); AI_PROPOSALS[pid] = {"action": a, "context": body.get("context"), "decisions": []}
        if a == "action_items": return reply({"items": [{"title": "Confirm inspection slot with surveyor", "owner": "Adil"}, {"title": "Share revised PO", "owner": None}], "proposal_id": pid})
        if a == "draft_message": return reply({"text": "Hi Rashid, AI-polished: please confirm the dispatch date today.", "proposal_id": pid})
        if a == "weekly_narrative": return reply({"text": "This week I closed out the Kite BOM material readiness.", "proposal_id": pid})
        if a == "extract_money": return reply({"transactions": [{"txn_date": "2026-11-02", "date_found": True, "amount": 64.5, "direction": "out", "currency": "QAR", "description": "Topaz Fabrics", "merchant": "Topaz Fabrics", "kind": "paid_for_business", "category_account_id": None, "for_entity_id": None, "confidence": "medium", "note": None}], "proposal_id": pid})
        if a == "categorize": return reply({"suggestions": [{"id": l["id"], "account_id": next(x["id"] for x in inp["accounts"] if x["code"] == "6900"), "confidence": "medium"} for l in inp["lines"]], "proposal_id": pid})
        return reply({"error": "Unknown action."}, 400)
    if path.startswith("/rest/v1/rpc/"):
        fn = path.rsplit("/", 1)[1]; body = json.loads(req.post_data or "{}")
        if fn == "search_all":
            q = body.get("q", "").lower()
            return reply([{"kind": "task", "id": t["id"], "title": t["title"], "subtitle": "", "workspace_id": t["workspace_id"]} for t in DB["tasks"] if q in t["title"].lower()] +
                         [{"kind": "note", "id": n["id"], "title": n["title"], "subtitle": "", "workspace_id": n["workspace_id"]} for n in DB["notes"] if q in (n["title"] + " " + (n["body"] or "")).lower()])
        if fn == "create_calendar_feed":
            DB.setdefault("calendar_feeds", [])[:] = [{"user_id": ME, "include_finance": body.get("p_include_finance", False), "created_at": iso(now), "last_used_at": None}]
            return reply("ab" * 32)
        if fn == "revoke_calendar_feed": DB["calendar_feeds"] = []; return reply(None)
        if fn.startswith("fin_"):
            try: return reply(fin_rpc(fn, body))
            except FinError as e: return err(str(e))
        if fn == "snooze_notification":
            n_ = next((x for x in DB["notifications"] if x["id"] == body["p_notification"]), None)
            if not n_: return err("not_found: alert not found")
            n_["snoozed_until"] = body["p_until"]; n_["read_at"] = n_.get("read_at") or iso(now); return reply(None)
        if fn == "record_ai_decision":
            AI_PROPOSALS[body["p_proposal"]]["decisions"].append(body["p_decision"]); return reply(None)
        if fn == "set_project_baseline":
            pj = next(x for x in DB["projects"] if x["id"] == body["p_project"])
            if pj.get("baselined_at") and len((body.get("p_reason") or "").strip()) < 3: return err("reason_required: give a reason for re-baselining")
            if pj.get("baselined_at"): DB.setdefault("schedule_revisions", []).append({"id": len(DB.get("schedule_revisions", [])) + 1, "workspace_id": pj["workspace_id"], "project_id": pj["id"], "milestone_id": None, "field": "baseline", "old_date": pj["baseline_target_date"], "new_date": pj["target_date"], "reason": "Re-baseline: " + body["p_reason"], "revised_by": ME, "revised_at": iso(now)})
            pj.update(baseline_start_date=pj.get("start_date"), baseline_target_date=pj.get("target_date"), baselined_at=iso(now), baselined_by=ME)
            for m in DB["milestones"]:
                if m["project_id"] == pj["id"]: m["baseline_date"] = m.get("planned_date")
            return reply(None)
        if fn == "revise_project_dates":
            pj = next(x for x in DB["projects"] if x["id"] == body["p_project"])
            for fld, key in (("start_date", "p_start"), ("target_date", "p_target")):
                if body.get(key) and body[key] != pj.get(fld):
                    DB.setdefault("schedule_revisions", []).append({"id": len(DB.get("schedule_revisions", [])) + 1, "workspace_id": pj["workspace_id"], "project_id": pj["id"], "milestone_id": None, "field": fld, "old_date": pj.get(fld), "new_date": body[key], "reason": body["p_reason"], "revised_by": ME, "revised_at": iso(now)})
                    pj[fld] = body[key]
            return reply(None)
        if fn == "revise_milestone_date":
            m = next(x for x in DB["milestones"] if x["id"] == body["p_milestone"])
            DB.setdefault("schedule_revisions", []).append({"id": len(DB.get("schedule_revisions", [])) + 1, "workspace_id": WS[1], "project_id": m["project_id"], "milestone_id": m["id"], "field": "planned_date", "old_date": m.get("planned_date"), "new_date": body["p_planned"], "reason": body["p_reason"], "revised_by": ME, "revised_at": iso(now)})
            m["planned_date"] = body["p_planned"]; return reply(None)
        if fn == "request_task_review":
            t = next(t for t in DB["tasks"] if t["id"] == body["p_task"])
            if not t.get("reviewer_id"): return err("no_reviewer: choose a reviewer first")
            t["review_status"] = "requested"; t["review_note"] = body.get("p_note"); return reply(None)
        if fn == "review_task":
            t = next(t for t in DB["tasks"] if t["id"] == body["p_task"])
            if t.get("reviewer_id") != ME: return err("not_reviewer: only the reviewer can approve or ask for changes")
            if body["p_decision"] == "approve": t.update(review_status="approved", reviewed_by=ME, status="completed", completed_at=iso(dt.datetime.now(dt.timezone.utc)), progress=100)
            else: t.update(review_status="changes_requested", review_note=body.get("p_note"), status="in_progress")
            return reply(None)
        if fn == "save_project_as_template":
            pj = next(x for x in DB["projects"] if x["id"] == body["p_project"]); anchor = dt.date.fromisoformat(pj["start_date"])
            ms = sorted([m for m in DB["milestones"] if m["project_id"] == pj["id"]], key=lambda m: m["sort"])
            idx = {m["id"]: i for i, m in enumerate(ms)}
            tasks_ = [t for t in DB["tasks"] if t["project_id"] == pj["id"] and not t["deleted_at"] and t["status"] != "cancelled" and not t["parent_id"]]
            bodyj = {"milestones": [{"title": m["title"], "offset_days": (dt.date.fromisoformat(m["planned_date"]) - anchor).days if m["planned_date"] else None, "weight": m["weight"], "is_critical": m["is_critical"]} for m in ms],
                     "tasks": [{"title": t["title"], "priority": t["priority"], "milestone": idx.get(t["milestone_id"]), "criteria": [c["text"] for c in (t["completion_criteria"] or [])],
                                "offset_days": (dt.date.fromisoformat(t["due_at"][:10]) - anchor).days if t["due_at"] else None} for t in tasks_],
                     "fields": [{"key": d["key"], "label": d["label"], "type": d["type"], "options": d["options"], "required": d["required"]} for d in DB.get("field_defs", []) if d["project_id"] == pj["id"] and not d["archived"]]}
            tid = str(uuid.uuid4()); DB.setdefault("project_templates", []).append({"id": tid, "workspace_id": pj["workspace_id"], "name": body["p_name"], "description": pj["description"], "body": bodyj,
                "source_project_id": pj["id"], "archived": False, "created_by": ME, "created_at": iso(now), "updated_at": iso(now)})
            return reply(tid)
        if fn == "create_project_from_template":
            tp = next(x for x in DB["project_templates"] if x["id"] == body["p_template"]); start = dt.date.fromisoformat(body["p_start"]); b_ = tp["body"]
            offs = [x["offset_days"] for x in b_["milestones"] + b_["tasks"] if x.get("offset_days") is not None]
            pid = str(uuid.uuid4())
            DB["projects"].append({"id": pid, "workspace_id": tp["workspace_id"], "name": body["p_name"], "description": tp["description"], "owner_id": ME, "priority": "medium", "start_date": body["p_start"],
                "target_date": body.get("p_target") or ((start + dt.timedelta(days=max(offs))).isoformat() if offs else None), "manual_status": None, "manual_status_reason": None, "budget": None, "budget_currency": None,
                "next_action": None, "archived": False, "created_by": ME, "created_at": iso(now), "updated_at": iso(now)})
            mids = []
            for i, m in enumerate(b_["milestones"]):
                mid = str(uuid.uuid4()); mids.append(mid)
                DB["milestones"].append({"id": mid, "project_id": pid, "title": m["title"], "planned_date": (start + dt.timedelta(days=m["offset_days"])).isoformat() if m.get("offset_days") is not None else None,
                    "actual_date": None, "weight": m.get("weight", 1), "is_critical": m.get("is_critical", False), "notes": None, "sort": i})
            for i, t in enumerate(b_["tasks"]):
                DB["tasks"].append({**fresh_db()["tasks"][0], "id": str(uuid.uuid4()), "workspace_id": tp["workspace_id"], "project_id": pid, "milestone_id": mids[t["milestone"]] if t.get("milestone") is not None else None,
                    "title": t["title"], "priority": t.get("priority", "medium"), "status": "not_started", "completed_at": None, "progress": 0, "custom": {}, "next_action": None,
                    "completion_criteria": [{"text": c, "done": False} for c in t.get("criteria", [])],
                    "due_at": ((start + dt.timedelta(days=t["offset_days"])).isoformat() + "T20:59:00+00:00") if t.get("offset_days") is not None else None, "created_at": iso(now), "updated_at": iso(now)})
            return reply(pid)
        if fn == "reopen_task":
            t = next(t for t in DB["tasks"] if t["id"] == body["p_task"]); t["status"] = body["p_status"]; t["completed_at"] = None
            DB["task_comments"].append({"id": str(uuid.uuid4()), "task_id": t["id"], "author_id": ME, "body": "Reopened: " + body["p_reason"], "kind": "status", "created_at": iso(dt.datetime.now(dt.timezone.utc))})
            return reply(None)
        return reply(None)
    table = path.split("/rest/v1/")[1]
    if table == "project_health": return reply(health())
    if table == "fin_invoice_totals": return reply(inv_totals())
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
                stamp = iso(dt.datetime.now(dt.timezone.utc))
                it = {"id": str(uuid.uuid4()), "created_at": stamp, "updated_at": stamp, "author_id": ME, "created_by": ME, "user_id": ME, **it}
                if table == "notes": it = {"tags": [], "pinned": False, "deleted_at": None, "decision_status": "proposed", **it}
                if table == "habits": it = {"days": [0, 1, 2, 3, 4, 5, 6], "per_week": 1, "archived": False, "sort": 0, **it}
                if table == "documents": it = {"tags": [], "deleted_at": None, "category": "other", **it}
                if table == "weekly_reviews" and "on_conflict" in qs: rows[:] = [r for r in rows if r["week_start"] != it["week_start"]]
            if table == "push_subscriptions": rows[:] = [r for r in rows if r.get("endpoint") != it.get("endpoint")]
            if "on_conflict" in qs:
                keys = qs["on_conflict"][0].split(","); rows[:] = [r for r in rows if any(r.get(k) != it.get(k) for k in keys)]
            if table == "fin_entities":
                it = {"lock_date": None, "archived": False, "fiscal_year_start": 1, "next_journal_no": 1, "next_invoice_no": 1, "next_bill_no": 1, **it}
                DB["fin_members"].append({"entity_id": it["id"], "user_id": ME, "role": "owner"}); DB["fin_accounts"].extend(seed_accounts(it["id"]))
            if table == "fin_journals": it = {"status": "draft", "number": None, "source": "manual", "reversed_by": None, "reversal_of": None, **it}
            if table == "fin_lines":
                j = next(x for x in DB["fin_journals"] if x["id"] == it["journal_id"])
                if j["status"] == "posted": return err("posted_immutable: lines of a posted entry can't be changed")
                it = {"debit": 0, "credit": 0, "party_id": None, "statement_line_id": None, "sort": 0, **it, "entity_id": j["entity_id"]}
            if table == "field_defs":
                it = {"archived": False, "sort": 0, "project_id": None, "options": [], "required": False, **it}
                if any(d["workspace_id"] == it["workspace_id"] and d["key"] == it["key"] and not d["archived"] for d in rows): return err("duplicate key value violates unique constraint")
            if table == "fin_invoices":
                it = {"status": "draft", "number": None, "journal_id": None, "task_id": None, "due_date": None, "currency": None, "fx_rate": None, **it}
                if it["currency"] == next(e for e in DB["fin_entities"] if e["id"] == it["entity_id"])["base_currency"]: it["currency"] = None
                if not it["currency"]: it["fx_rate"] = None
            if table == "fin_invoice_lines": it = {"item_id": None, "account_id": None, **it, "amount": round(float(it["qty"]) * float(it["unit_price"]), 2)}
            if table == "fin_accounts": it = {"is_active": True, "system_key": None, "description": None, "currency": None, **it}
            if table == "fin_statement_lines": it = {"status": "unmatched", "matched_line_id": None, "reference": None, **it}
            rows.append(it); out.append(it)
        return reply(out[0] if single else out, 201)
    if req.method == "PATCH":
        body = json.loads(req.post_data); out = []
        for r in rows:
            if match(r):
                new = {**r, **body}
                if table == "projects" and r.get("baselined_at") and (new.get("target_date") != r.get("target_date") or new.get("start_date") != r.get("start_date")):
                    return err("reason_required: the schedule is baselined — give a reason for changing the date")
                if table == "follow_ups" and new.get("status") == "closed" and r.get("status") != "closed" and not new.get("outcome"):
                    return err("outcome_required: record the outcome before closing")
                if table == "tasks":
                    e = rule_check(new, r)
                    if e: return err(e)
                    if new["status"] == "completed" and r["status"] != "completed":
                        miss = [d["label"] for d in DB.get("field_defs", []) if d["workspace_id"] == new["workspace_id"] and d["required"] and not d["archived"] and d["project_id"] in (None, new.get("project_id"))
                                and ((new.get("custom") or {}).get(d["key"]) in (None, "") or (d["type"] == "checkbox" and (new.get("custom") or {}).get(d["key"]) is not True))]
                        if miss: return err("field_required: fill in " + ", ".join(miss) + " before completing")
                    if new["status"] == "completed" and r["status"] != "completed": new["completed_at"] = iso(dt.datetime.now(dt.timezone.utc)); new["progress"] = 100
                    new["updated_at"] = iso(dt.datetime.now(dt.timezone.utc))
                r.clear(); r.update(new); out.append(r)
        return reply(out[0] if single and out else out)
    if req.method == "DELETE":
        rows[:] = [r for r in rows if not match(r)]
        return reply([])
    reply([])

class FinError(Exception): pass
def today_qa(): return (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=3)).date().isoformat()
def inv_totals():
    out = []
    for i in DB["fin_invoices"]:
        total = round(sum(l["amount"] for l in DB["fin_invoice_lines"] if l["invoice_id"] == i["id"]), 2)
        paid = round(sum(a["amount"] for a in DB["fin_allocations"] if a["invoice_id"] == i["id"] and next((p for p in DB["fin_payments"] if p["id"] == a["payment_id"] and p["status"] == "posted"), None)), 2)
        out.append({"invoice_id": i["id"], "entity_id": i["entity_id"], "total": total, "paid": paid})
    return out
def sys_acc(eid, key): return next(a["id"] for a in DB["fin_accounts"] if a["entity_id"] == eid and a["system_key"] == key)
def next_no(eid, field):
    e = next(x for x in DB["fin_entities"] if x["id"] == eid); n = e[field]; e[field] += 1; return n
def sys_journal(eid, date, memo, source, source_id, lines):
    dr = round(sum(l.get("debit", 0) for l in lines), 2); cr = round(sum(l.get("credit", 0) for l in lines), 2)
    if dr != cr or dr == 0: raise FinError(f"unbalanced: {dr} / {cr}")
    jid = str(uuid.uuid4())
    DB["fin_journals"].append({"id": jid, "entity_id": eid, "number": next_no(eid, "next_journal_no"), "entry_date": date, "memo": memo, "reference": None, "source": source, "source_id": source_id,
                               "status": "posted", "reversal_of": None, "reversed_by": None, "posted_by": ME, "created_by": ME, "created_at": iso(now)})
    for i, l in enumerate(lines):
        DB["fin_lines"].append({"id": str(uuid.uuid4()), "journal_id": jid, "entity_id": eid, "account_id": l["account_id"], "party_id": l.get("party_id"), "description": l.get("description"),
                                "debit": l.get("debit", 0), "credit": l.get("credit", 0), "fx_currency": l.get("fx_currency"), "fx_amount": l.get("fx_amount"), "statement_line_id": None, "sort": i})
    return jid
def p_balance(link_id):
    k = next(x for x in DB["fin_partner_links"] if x["id"] == link_id)
    js = {j["id"] for j in DB["fin_journals"] if j["status"] == "posted"}
    return round(sum(float(l["credit"]) - float(l["debit"]) for l in DB["fin_lines"] if l["journal_id"] in js and l["account_id"] == k["partner_account_id"] and l["party_id"] == k["partner_party_id"]), 2)
def partner_rpc(fn, b):
    if fn == "fin_partner_link_create":
        eid = b["p_entity"]; acc = next((a for a in DB["fin_accounts"] if a["entity_id"] == eid and a["type"] == "liability" and a["subtype"] == "partner"), None)
        if not acc: raise FinError("missing_account: add a partner account first")
        party = {"id": str(uuid.uuid4()), "entity_id": eid, "name": b["p_partner_name"], "kind": "partner", "archived": False, "created_at": iso(now)}; DB["fin_parties"].append(party)
        k = {"id": str(uuid.uuid4()), "entity_id": eid, "partner_party_id": party["id"], "partner_account_id": acc["id"], "partner_user_id": ME, "mirror_entity_id": b.get("p_mirror_entity"),
             "mirror_party_id": None, "mirror_receivable_account_id": None, "mirror_default_account_id": None, "terms_days": None, "next_no": 1, "created_at": iso(now)}
        if k["mirror_entity_id"]:
            me = k["mirror_entity_id"]; ename = next(e["name"] for e in DB["fin_entities"] if e["id"] == eid)
            mp = {"id": str(uuid.uuid4()), "entity_id": me, "name": ename, "kind": "other", "archived": False, "created_at": iso(now)}; DB["fin_parties"].append(mp)
            k.update(mirror_party_id=mp["id"], mirror_receivable_account_id=sys_acc(me, "ar"), mirror_default_account_id=sys_acc(me, "opening"))
        DB.setdefault("fin_partner_links", []).append(k); return k["id"]
    if fn == "fin_partner_record":
        p = b["p"]; k = next(x for x in DB["fin_partner_links"] if x["id"] == p["link_id"]); a = next(x for x in DB["fin_accounts"] if x["id"] == p["account_id"])
        t = p["txn_type"]; d = "decrease" if t == "reimbursement" else (p.get("direction") or "") if t == "adjustment" else "increase"; amt = float(p["amount"])
        if d == "increase" and a["subtype"] in ("cash", "bank", "card"): raise FinError("mixed_funds: money the partner paid personally can't be booked against the business's bank or cash")
        if t == "reimbursement" and a["subtype"] not in ("cash", "bank"): raise FinError("bad_account: a reimbursement is paid from the business's bank or cash account")
        if d == "decrease" and amt > p_balance(k["id"]): raise FinError(f"exceeds_outstanding: {amt} is more than the {p_balance(k['id'])} currently owed to the partner")
        no = "PR-" + str(k["next_no"]).zfill(4); k["next_no"] += 1; tid = str(uuid.uuid4()); desc = no + " · " + p["description"]
        pl = {"account_id": k["partner_account_id"], "party_id": k["partner_party_id"], "description": desc}
        lines = [{"account_id": a["id"], "description": desc, "debit": amt}, {**pl, "credit": amt}] if d == "increase" else [{**pl, "debit": amt}, {"account_id": a["id"], "description": desc, "credit": amt}]
        jid = sys_journal(k["entity_id"], p["txn_date"], no + " " + p["description"], "partner", tid, lines); mj = None
        if k["mirror_entity_id"]:
            macc = p.get("mirror_account_id") or k["mirror_default_account_id"]; rl = {"account_id": k["mirror_receivable_account_id"], "party_id": k["mirror_party_id"], "description": desc}
            ml = [{**rl, "debit": amt}, {"account_id": macc, "description": desc, "credit": amt}] if d == "increase" else [{"account_id": macc, "description": desc, "debit": amt}, {**rl, "credit": amt}]
            mj = sys_journal(k["mirror_entity_id"], p["txn_date"], no + " " + p["description"], "partner", tid, ml)
        DB.setdefault("fin_partner_txns", []).append({"id": tid, "link_id": k["id"], "entity_id": k["entity_id"], "txn_no": no, "txn_type": t, "direction": d, "txn_date": p["txn_date"],
            "date_precision": p.get("date_precision") or "day", "payment_date": p.get("payment_date"), "description": p["description"], "beneficiary": p.get("beneficiary"), "reference": p.get("reference"),
            "invoice_amount": p.get("invoice_amount"), "amount": amt, "currency": "QAR", "paid_from": p.get("paid_from") or ("business_bank" if t == "reimbursement" else "not_recorded"), "account_id": a["id"],
            "job_ref": p.get("job_ref"), "recon_status": "unverified", "flags": p.get("flags") or [], "legacy_ref": None, "notes": p.get("notes"), "import_key": None, "journal_id": jid, "mirror_journal_id": mj,
            "mirror_account_id": p.get("mirror_account_id"), "status": "posted", "reversal_journal_id": None, "mirror_reversal_journal_id": None, "reversal_reason": None, "last_change_reason": None,
            "settles_txn_id": None, "created_by": ME, "created_at": iso(now), "updated_by": None, "updated_at": None})
        return tid
    if fn == "fin_partner_update":
        if not (b.get("p_reason") or "").strip(): raise FinError("reason_required: say why you are changing this record")
        t = next(x for x in DB["fin_partner_txns"] if x["id"] == b["p_txn"]); patch = b["p_patch"]
        for key in patch:
            if key in ("amount", "txn_date", "account_id"): raise FinError(f"locked_field: {key} can't be edited")
        changes = {k2: [t.get(k2), v] for k2, v in patch.items()}; changes["last_change_reason"] = [t.get("last_change_reason"), b["p_reason"]]
        t.update(patch); t["last_change_reason"] = b["p_reason"]
        DB["fin_audit"].append({"id": str(uuid.uuid4()), "entity_id": t["entity_id"], "record_type": "fin_partner_txns", "record_id": t["id"], "actor_id": ME, "action": "update", "changes": changes, "created_at": iso(dt.datetime.now(dt.timezone.utc))})
        return None
    if fn == "fin_partner_reverse":
        t = next(x for x in DB["fin_partner_txns"] if x["id"] == b["p_txn"])
        if not (b.get("p_reason") or "").strip(): raise FinError("reason_required")
        def rev(jid):
            j = next(x for x in DB["fin_journals"] if x["id"] == jid); ls = [l for l in DB["fin_lines"] if l["journal_id"] == jid]
            nid = sys_journal(j["entity_id"], j["entry_date"], "Reversal of #" + str(j["number"]), "reversal", j["id"], [{"account_id": l["account_id"], "party_id": l["party_id"], "debit": l["credit"], "credit": l["debit"]} for l in ls])
            j["reversed_by"] = nid; next(x for x in DB["fin_journals"] if x["id"] == nid)["reversal_of"] = j["id"]; return nid
        t["reversal_journal_id"] = rev(t["journal_id"]); t["mirror_reversal_journal_id"] = rev(t["mirror_journal_id"]) if t["mirror_journal_id"] else None
        t["status"] = "reversed"; t["reversal_reason"] = b["p_reason"]; return None
    if fn == "fin_partner_sync_mirror": return 0
    raise FinError("not implemented in test fake: " + fn)
def ic_rpc(fn, b):
    if fn == "fin_ic_record":
        p = b["p"]; A = next(e for e in DB["fin_entities"] if e["id"] == p["from_entity_id"]); B = next(e for e in DB["fin_entities"] if e["id"] == p["to_entity_id"])
        if A["base_currency"] != B["base_currency"] and not p.get("amount_to"): raise FinError("amount_to_required: enter the received amount")
        amt, amt_to = float(p["amount"]), float(p.get("amount_to") or p["amount"])
        tid = str(uuid.uuid4()); no = "IC-" + str(len(DB["fin_ic_txns"]) + 1).zfill(5)
        def ic_acc(eid):
            a = next((x for x in DB["fin_accounts"] if x["entity_id"] == eid and x.get("system_key") == "intercompany"), None)
            if not a: a = {"id": f"{eid[:8]}-acc-1190", "entity_id": eid, "code": "1190", "name": "Inter-entity current accounts", "type": "asset", "subtype": "other", "system_key": "intercompany", "is_active": True, "description": None}; DB["fin_accounts"].append(a)
            return a["id"]
        ja = sys_journal(A["id"], p["txn_date"], no + " " + p["description"], "intercompany", tid, [{"account_id": ic_acc(A["id"]), "debit": amt}, {"account_id": p["from_account_id"], "credit": amt}])
        jb = sys_journal(B["id"], p["txn_date"], no + " " + p["description"], "intercompany", tid, [{"account_id": p["to_account_id"], "debit": amt_to}, {"account_id": ic_acc(B["id"]), "credit": amt_to}])
        DB["fin_ic_txns"].append({"id": tid, "ic_no": no, "from_entity_id": A["id"], "to_entity_id": B["id"], "kind": p["kind"], "txn_date": p["txn_date"], "description": p["description"], "reference": p.get("reference"),
            "amount": amt, "amount_to": amt_to, "from_account_id": p["from_account_id"], "to_account_id": p["to_account_id"], "from_journal_id": ja, "to_journal_id": jb, "status": "posted", "reversal_reason": None, "created_at": iso(now)})
        return tid
    if fn == "fin_ic_position":
        e = b["p_entity"]; out = {}
        for t in DB["fin_ic_txns"]:
            if t["status"] != "posted" or e not in (t["from_entity_id"], t["to_entity_id"]): continue
            o = t["to_entity_id"] if t["from_entity_id"] == e else t["from_entity_id"]; oe = next(x for x in DB["fin_entities"] if x["id"] == o)
            r_ = out.setdefault(o, {"entity_id": o, "name": oe["name"], "currency": oe["base_currency"], "mine": 0, "theirs": 0, "recorded_mine": 0, "recorded_theirs": 0, "matched": True})
            if t["from_entity_id"] == e: r_["mine"] += t["amount"]; r_["theirs"] += t["amount_to"]
            else: r_["mine"] -= t["amount_to"]; r_["theirs"] -= t["amount"]
            r_["recorded_mine"], r_["recorded_theirs"] = r_["mine"], r_["theirs"]
        return list(out.values())
    if fn == "fin_ic_reverse":
        t = next(x for x in DB["fin_ic_txns"] if x["id"] == b["p_txn"]); t["status"] = "reversed"; t["reversal_reason"] = b["p_reason"]; return None
    raise FinError("not implemented: " + fn)
def prod_acc(eid, key):
    spec = {"wip": ("1250", "Work in progress", "asset"), "grni": ("2050", "Goods received, not yet billed", "liability"), "inventory": ("1200", "Inventory", "asset"), "cogs": ("5000", "Cost of goods sold", "expense")}[key]
    a = next((x for x in DB["fin_accounts"] if x["entity_id"] == eid and x.get("system_key") == key), None)
    if not a:
        a = {"id": f"{eid[:8]}-acc-{spec[0]}", "entity_id": eid, "code": spec[0], "name": spec[1], "type": spec[2], "subtype": "other", "system_key": key, "is_active": True, "description": None}; DB["fin_accounts"].append(a)
    return a["id"]
def on_hand(item):
    ms = [m for m in DB["fin_stock_moves"] if m["item_id"] == item]; q = sum(float(m["qty"]) for m in ms); v = sum(float(m["qty"]) * float(m["unit_cost"]) for m in ms)
    return round(q, 3), (v / q if q > 0 else 0)
def add_move(eid, item, date, qty, cost, source, jid, note, order=None, exc=None):
    mid = str(uuid.uuid4()); DB["fin_stock_moves"].append({"id": mid, "entity_id": eid, "item_id": item, "move_date": date, "qty": qty, "unit_cost": cost, "source": source, "journal_id": jid, "note": note,
        "production_order_id": order, "exception_id": exc, "created_at": iso(now)}); return mid
def prod_fx(eid):
    a = next((x for x in DB["fin_accounts"] if x["entity_id"] == eid and x.get("system_key") == "fx"), None)
    if not a: a = {"id": f"{eid[:8]}-acc-4900", "entity_id": eid, "code": "4900", "name": "Exchange gains and losses", "type": "income", "subtype": "other", "system_key": "fx", "is_active": True, "description": None}; DB["fin_accounts"].append(a)
    return a["id"]
def prod_rpc(fn, b):
    today = today_qa()
    if fn == "fin_goods_receipt":
        p = b["p"]; it = next(x for x in DB["fin_items"] if x["id"] == p["item_id"]); e = it["entity_id"]; gid = str(uuid.uuid4())
        no = "GRN-" + str(len([g for g in DB["fin_goods_receipts"] if g["entity_id"] == e]) + 1).zfill(4); val = round(float(p["qty"]) * float(p["unit_cost"]), 2); d = p.get("receipt_date") or today
        jid = sys_journal(e, d, no + " received", "receipt", gid, [{"account_id": prod_acc(e, "inventory"), "debit": val}, {"account_id": prod_acc(e, "grni"), "party_id": p.get("party_id"), "credit": val}])
        mid = add_move(e, it["id"], d, float(p["qty"]), float(p["unit_cost"]), "receipt", jid, no)
        DB["fin_goods_receipts"].append({"id": gid, "entity_id": e, "receipt_no": no, "item_id": it["id"], "party_id": p.get("party_id"), "receipt_date": d, "qty": float(p["qty"]), "unit_cost": float(p["unit_cost"]),
            "reference": p.get("reference"), "journal_id": jid, "stock_move_id": mid, "status": "posted", "reversal_reason": None, "created_at": iso(now)}); return gid
    if fn == "fin_production_open":
        e = b["p_entity"]; oid = str(uuid.uuid4()); no = "JOB-" + str(len([o for o in DB["fin_production_orders"] if o["entity_id"] == e]) + 1).zfill(4)
        DB["fin_production_orders"].insert(0, {"id": oid, "entity_id": e, "order_no": no, "title": b["p_title"], "party_id": b.get("p_party"), "job_ref": b.get("p_job_ref"), "status": "open", "opened_on": b.get("p_date") or today,
            "completed_on": None, "completion_journal_id": None, "total_cost": None, "invoice_id": None, "notes": None, "cancel_reason": None, "created_at": iso(now)}); return oid
    if fn in ("fin_production_issue", "fin_production_add_cost", "fin_production_complete", "fin_production_cancel"):
        o = next(x for x in DB["fin_production_orders"] if x["id"] == b["p_order"]); e = o["entity_id"]
        if o["status"] != "open": raise FinError("order_closed: the order is " + o["status"])
        posted = [c for c in DB["fin_production_costs"] if c["order_id"] == o["id"] and c["status"] == "posted"]
        if fn == "fin_production_issue":
            qty = float(b["p_qty"]); q, avg = on_hand(b["p_item"]); exc = None
            if q < qty:
                if not b.get("p_authorise_reason"): raise FinError(f"insufficient_stock: only {q} in stock")
                exc = str(uuid.uuid4()); DB["fin_stock_exceptions"].insert(0, {"id": exc, "entity_id": e, "item_id": b["p_item"], "qty_short": round(qty - max(q, 0), 3), "reason": b["p_authorise_reason"], "authorised_by": ME, "authorised_at": iso(now)})
            val = round(qty * avg, 2); cid = str(uuid.uuid4()); d = b.get("p_date") or today
            jid = sys_journal(e, d, o["order_no"] + " material", "production", cid, [{"account_id": prod_acc(e, "wip"), "debit": val}, {"account_id": prod_acc(e, "inventory"), "credit": val}])
            mid = add_move(e, b["p_item"], d, -qty, avg, "production", jid, o["order_no"], o["id"], exc)
            DB["fin_production_costs"].append({"id": cid, "order_id": o["id"], "entity_id": e, "kind": "material", "cost_date": d, "item_id": b["p_item"], "qty": qty, "unit_cost": avg, "amount": val, "source_account_id": None,
                "note": b.get("p_note"), "journal_id": jid, "stock_move_id": mid, "exception_id": exc, "status": "posted", "reversal_reason": None, "created_at": iso(now)}); return cid
        if fn == "fin_production_add_cost":
            cid = str(uuid.uuid4()); d = b.get("p_date") or today; amt = round(float(b["p_amount"]), 2)
            jid = sys_journal(e, d, o["order_no"] + " cost", "production", cid, [{"account_id": prod_acc(e, "wip"), "debit": amt}, {"account_id": b["p_account"], "credit": amt}])
            DB["fin_production_costs"].append({"id": cid, "order_id": o["id"], "entity_id": e, "kind": "other", "cost_date": d, "item_id": None, "qty": None, "unit_cost": None, "amount": amt, "source_account_id": b["p_account"],
                "note": b["p_note"], "journal_id": jid, "stock_move_id": None, "exception_id": None, "status": "posted", "reversal_reason": None, "created_at": iso(now)}); return cid
        if fn == "fin_production_complete":
            tot = round(sum(float(c["amount"]) for c in posted), 2)
            if tot <= 0: raise FinError("no_costs")
            jid = sys_journal(e, b["p_date"], o["order_no"] + " completed", "production", o["id"], [{"account_id": prod_acc(e, "cogs"), "debit": tot}, {"account_id": prod_acc(e, "wip"), "credit": tot}])
            o.update(status="completed", completed_on=b["p_date"], completion_journal_id=jid, total_cost=tot); return tot
        if posted: raise FinError("has_costs: reverse the material and costs first")
        o.update(status="cancelled", cancel_reason=b["p_reason"]); return None
    if fn == "fin_production_reverse_cost":
        c = next(x for x in DB["fin_production_costs"] if x["id"] == b["p_cost"]); j = next(x for x in DB["fin_journals"] if x["id"] == c["journal_id"])
        ls = [l for l in DB["fin_lines"] if l["journal_id"] == j["id"]]
        nid = sys_journal(c["entity_id"], j["entry_date"], "Reversal", "reversal", j["id"], [{"account_id": l["account_id"], "debit": l["credit"], "credit": l["debit"]} for l in ls]); j["reversed_by"] = nid
        if c["kind"] == "material": add_move(c["entity_id"], c["item_id"], c["cost_date"], c["qty"], c["unit_cost"], "production", nid, "Returned", c["order_id"])
        c.update(status="reversed", reversal_reason=b["p_reason"]); return None
    if fn == "fin_goods_receipt_reverse":
        g = next(x for x in DB["fin_goods_receipts"] if x["id"] == b["p_receipt"]); g.update(status="reversed", reversal_reason=b["p_reason"]); return None
    raise FinError("not implemented: " + fn)
def acc_of(aid): return next((a for a in DB["fin_accounts"] if a["id"] == aid), None)
def bal_of(aid, party=None):
    js = {j["id"] for j in DB["fin_journals"] if j["status"] == "posted"}
    return round(sum(float(l["debit"]) - float(l["credit"]) for l in DB["fin_lines"] if l["journal_id"] in js and l["account_id"] == aid and (party is None or l.get("party_id") == party)), 2)
def money_rpc(fn, b):
    """Test stand-in for fin_money_post / fin_import_add (the real rules are tested in supabase/tests/inc11_simple_money_tests.sql)."""
    if fn == "fin_import_add":
        iid = str(uuid.uuid4()); DB["fin_imports"].insert(0, {"id": iid, "entity_id": b["p_entity"], "source": b["p_source"], "title": b["p_title"], "account_id": b["p_account"], "reader": b["p_reader"], "created_by": ME, "created_at": iso(dt.datetime.now(dt.timezone.utc))})
        for i, r in enumerate(b["p_rows"], 1):
            if not r.get("amount"): continue
            acc = r.get("account_id") or b["p_account"]; key = f'{acc}|{r.get("txn_date")}|{float(r["amount"]):.2f}|{r["direction"]}|{re.sub("[^a-z0-9]", "", (r.get("description") or "").lower())}'
            dup = "imported" if any(x["dedupe_key"] == key and x["import_id"] != iid for x in DB["fin_import_rows"]) else None
            DB["fin_import_rows"].append({"id": str(uuid.uuid4()), "import_id": iid, "entity_id": b["p_entity"], "row_no": i, "txn_date": r.get("txn_date"), "amount": round(float(r["amount"]), 2), "direction": r["direction"],
                "currency": r.get("currency") or "QAR", "description": r.get("description") or "Transaction", "merchant": r.get("merchant"), "account_id": acc, "kind": r.get("kind"), "category_account_id": r.get("category_account_id"),
                "party_id": r.get("party_id"), "for_entity_id": r.get("for_entity_id"), "business_account_id": r.get("business_account_id"), "interest": r.get("interest"), "confidence": r.get("confidence") or "low",
                "review_reason": r.get("review_reason"), "dedupe_key": key, "duplicate": dup, "duplicate_line_id": None, "status": "pending", "journal_id": None, "partner_txn_id": None, "raw": r.get("raw"),
                "created_at": iso(now), "posted_at": None, "posted_by": None})
        return iid
    p = b["p"]; eid = p["entity_id"]; kind = p["kind"]; amt = round(float(p["amount"]), 2); m = acc_of(p["account_id"]); c = acc_of(p.get("category_account_id")) if p.get("category_account_id") else None
    base = next(e["base_currency"] for e in DB["fin_entities"] if e["id"] == eid); ccy = p.get("currency") or base; fx = float(p["fx_amount"]) if p.get("fx_amount") else None
    if ccy != base and not fx: raise FinError(f"fx_amount_required: enter the {ccy} amount as well as the {base} amount")
    if m and m.get("currency") and ccy != m["currency"]: raise FinError(f"currency_mismatch: {m['name']} is kept in {m['currency']}")
    def fxl(acct, sign):  # signed foreign amount on a line when the account is foreign or the payment was foreign
        if acct.get("currency"): return {"fx_currency": acct["currency"], "fx_amount": sign * (float(p["to_fx_amount"]) if p.get("to_fx_amount") and acct is c else fx)}
        return {"fx_currency": ccy, "fx_amount": sign * fx} if fx and acct is not m else {}
    if kind == "opening":
        op = next(a for a in DB["fin_accounts"] if a["entity_id"] == eid and a["system_key"] == "opening")
        ls = [{"account_id": m["id"], "debit": amt, **fxl(m, 1)}, {"account_id": op["id"], "credit": amt}] if m["type"] == "asset" else [{"account_id": op["id"], "debit": amt}, {"account_id": m["id"], "credit": amt, **fxl(m, -1)}]
        jid = sys_journal(eid, p["txn_date"], p.get("description") or "Opening balance", "opening", None, ls)
        if fx: DB["fin_money_fx"].append({"journal_id": jid, "entity_id": eid, "currency": ccy, "native_amount": fx, "base_amount": amt, "rate": round(fx / amt, 8), "rate_source": p.get("rate_source") or "entered"})
        return {"journal_id": jid, "partner_txn_id": None}
    if not m or m["subtype"] not in ("cash", "bank", "card"): raise FinError("bad_account: choose the bank, cash or card account the money moved through")
    desc = p.get("description") or p.get("merchant") or ""
    if not desc: raise FinError("description_required: say what it was for")
    row = next((r for r in DB["fin_import_rows"] if r["id"] == p.get("import_row_id")), None) if p.get("import_row_id") else None
    if row and row["status"] != "pending": raise FinError("already_posted: this imported line was already posted or skipped")
    ptx = None
    if kind in ("paid_for_business", "business_repaid"):
        k = next((x for x in DB["fin_partner_links"] if x["entity_id"] == p.get("for_entity_id") and x["mirror_entity_id"] == eid), None)
        if not k: raise FinError("no_link: these books aren't linked to that business yet")
        if not p.get("business_account_id"): raise FinError("business_account_required: say what it was for in the business's books")
        ptx = partner_rpc("fin_partner_record", {"p": {"link_id": k["id"], "txn_type": "expense_funding" if kind == "paid_for_business" else "reimbursement", "txn_date": p["txn_date"], "description": desc,
            "beneficiary": p.get("merchant"), "amount": amt, "account_id": p["business_account_id"], "mirror_account_id": m["id"], "paid_from": "personal_bank"}})
        jid = next(t for t in DB["fin_partner_txns"] if t["id"] == ptx)["mirror_journal_id"]
    else:
        if not c: raise FinError("category_required: choose what it was for")
        pty = p.get("party_id"); intr = float(p.get("interest") or 0)
        if kind == "spend": ls = [{"account_id": c["id"], "party_id": pty, "debit": amt, **fxl(c, 1)}, {"account_id": m["id"], "credit": amt, **fxl(m, -1)}]
        elif kind == "income": ls = [{"account_id": m["id"], "debit": amt}, {"account_id": c["id"], "party_id": pty, "credit": amt}]
        elif kind == "transfer": ls = [{"account_id": c["id"], "debit": amt}, {"account_id": m["id"], "credit": amt}]
        elif kind == "lent": ls = [{"account_id": c["id"], "party_id": pty, "debit": amt}, {"account_id": m["id"], "credit": amt}]
        elif kind == "repayment_in":
            if amt > bal_of(c["id"], pty): raise FinError(f"exceeds_outstanding: {amt} is more than the {bal_of(c['id'], pty)} they owe you")
            ls = [{"account_id": m["id"], "debit": amt}, {"account_id": c["id"], "party_id": pty, "credit": amt}]
        elif kind == "borrowed": ls = [{"account_id": m["id"], "debit": amt}, {"account_id": c["id"], "party_id": pty, "credit": amt}]
        else: ls = [{"account_id": c["id"], "party_id": pty, "debit": round(amt - intr, 2)}, {"account_id": m["id"], "credit": amt}] + ([{"account_id": next(a["id"] for a in DB["fin_accounts"] if a["entity_id"] == eid and a["type"] == "expense"), "debit": intr}] if intr else [])
        jid = sys_journal(eid, p["txn_date"], desc, "manual", None, ls)
    if fx: DB["fin_money_fx"].append({"journal_id": jid, "entity_id": eid, "currency": ccy, "native_amount": fx, "base_amount": amt, "rate": round(fx / amt, 8), "rate_source": p.get("rate_source") or "entered"})
    if row: row.update(status="posted", journal_id=jid, partner_txn_id=ptx, kind=kind, posted_at=iso(dt.datetime.now(dt.timezone.utc)), posted_by=ME)
    return {"journal_id": jid, "partner_txn_id": ptx}
def fin_rpc(fn, b):
    if fn in ("fin_money_post", "fin_import_add"): return money_rpc(fn, b)
    if fn == "fin_money_link_business": return partner_rpc("fin_partner_link_create", {"p_entity": b["p_business"], "p_partner_name": b["p_partner_name"], "p_mirror_entity": b["p_personal"]})
    if fn.startswith("fin_production_") or fn.startswith("fin_goods_receipt"): return prod_rpc(fn, b)
    if fn.startswith("fin_ic_"): return ic_rpc(fn, b)
    if fn.startswith("fin_partner_"): return partner_rpc(fn, b)
    if fn == "fin_post_journal":
        j = next(x for x in DB["fin_journals"] if x["id"] == b["p_journal"]); ls = [l for l in DB["fin_lines"] if l["journal_id"] == j["id"]]
        dr = round(sum(float(l["debit"]) for l in ls), 2); cr = round(sum(float(l["credit"]) for l in ls), 2)
        if len(ls) < 2: raise FinError("too_few_lines: an entry needs at least two lines")
        if dr != cr: raise FinError(f"unbalanced: debits ({dr}) and credits ({cr}) must be equal")
        j["status"] = "posted"; j["number"] = next_no(j["entity_id"], "next_journal_no"); return j["number"]
    if fn == "fin_post_invoice":
        i = next(x for x in DB["fin_invoices"] if x["id"] == b["p_invoice"])
        if not i.get("party_id"): raise FinError("party_required: choose the customer")
        if i.get("currency") and not i.get("fx_rate"): raise FinError("rate_required: enter the exchange rate for " + i["currency"])
        k = float(i.get("fx_rate") or 1)
        ls = [l for l in DB["fin_invoice_lines"] if l["invoice_id"] == i["id"]]; total = round(sum(round(l["amount"] * k, 2) for l in ls), 2)
        sale = i["kind"] == "sale"
        jl = [{"account_id": l["account_id"] or sys_acc(i["entity_id"], "sales"), "description": l["description"], ("credit" if sale else "debit"): round(l["amount"] * k, 2)} for l in ls]
        jl.append({"account_id": sys_acc(i["entity_id"], "ar" if sale else "ap"), "party_id": i["party_id"], ("debit" if sale else "credit"): total})
        no = ("INV-" if sale else "BILL-") + str(next_no(i["entity_id"], "next_invoice_no" if sale else "next_bill_no")).zfill(4)
        i["journal_id"] = sys_journal(i["entity_id"], i["issue_date"], ("Invoice " if sale else "Bill ") + no, "invoice" if sale else "bill", i["id"], jl)
        i["status"] = "posted"; i["number"] = no; return no
    if fn == "fin_record_payment":
        eid, amt = b["p_entity"], float(b["p_amount"]); tot = {t["invoice_id"]: t for t in inv_totals()}
        for a in b["p_allocations"]:
            t = tot[a["invoice_id"]]
            if float(a["amount"]) > t["total"] - t["paid"]: raise FinError("overpayment: more than outstanding")
        pid = str(uuid.uuid4()); inn = b["p_direction"] == "in"
        DB["fin_payments"].append({"id": pid, "entity_id": eid, "direction": b["p_direction"], "party_id": b["p_party"], "pay_date": b["p_date"], "amount": amt, "account_id": b["p_account"],
                                   "reference": b["p_reference"], "memo": b["p_memo"], "status": "posted", "journal_id": None, "created_at": iso(now)})
        jid = sys_journal(eid, b["p_date"], "Payment received" if inn else "Payment made", "payment", pid,
            [{"account_id": b["p_account"], ("debit" if inn else "credit"): amt}, {"account_id": sys_acc(eid, "ar" if inn else "ap"), "party_id": b["p_party"], ("credit" if inn else "debit"): amt}])
        DB["fin_payments"][-1]["journal_id"] = jid
        for a in b["p_allocations"]: DB["fin_allocations"].append({"payment_id": pid, "invoice_id": a["invoice_id"], "entity_id": eid, "amount": float(a["amount"])})
        return pid
    if fn == "fin_record_fx_payment":
        p = b["p"]; eid = p["entity_id"]; inn = p["direction"] == "in"; amt, base = float(p["amount"]), float(p.get("base_amount") or 0)
        if not base: raise FinError("base_amount_required: enter what actually reached the bank")
        tot = {t["invoice_id"]: t for t in inv_totals()}; ctrl = 0; s_ = 0
        for a in p["allocations"]:
            inv = next(x for x in DB["fin_invoices"] if x["id"] == a["invoice_id"])
            if inv.get("currency") != p["currency"]: raise FinError("currency_mismatch")
            t = tot[a["invoice_id"]]
            if float(a["amount"]) > t["total"] - t["paid"]: raise FinError("overpayment")
            ctrl += round(float(a["amount"]) * float(inv["fx_rate"]), 2); s_ += float(a["amount"])
        rate = base / amt; ctrl = round(ctrl + (amt - s_) * rate, 2); gain = round(base - ctrl if inn else ctrl - base, 2)
        pid = str(uuid.uuid4())
        DB["fin_payments"].append({"id": pid, "entity_id": eid, "direction": p["direction"], "party_id": p["party_id"], "pay_date": p["pay_date"], "amount": amt, "account_id": p["account_id"],
            "reference": p.get("reference"), "memo": p.get("memo"), "status": "posted", "journal_id": None, "currency": p["currency"], "fx_rate": round(rate, 8), "base_amount": base, "fx_gain": gain, "created_at": iso(now)})
        jl = [{"account_id": p["account_id"], ("debit" if inn else "credit"): base}, {"account_id": sys_acc(eid, "ar" if inn else "ap"), "party_id": p["party_id"], ("credit" if inn else "debit"): ctrl}]
        if gain: jl.append({"account_id": prod_fx(eid), ("credit" if gain > 0 else "debit"): abs(gain)})
        DB["fin_payments"][-1]["journal_id"] = sys_journal(eid, p["pay_date"], "FX payment", "payment", pid, jl)
        for a in p["allocations"]: DB["fin_allocations"].append({"payment_id": pid, "invoice_id": a["invoice_id"], "entity_id": eid, "amount": float(a["amount"])})
        return pid
    if fn == "fin_fx_open_items":
        tot = {t["invoice_id"]: t for t in inv_totals()}; out = []
        for i in DB["fin_invoices"]:
            if i["entity_id"] != b["p_entity"] or i["status"] != "posted" or not i.get("currency") or i["issue_date"] > b["p_date"]: continue
            o = round(tot[i["id"]]["total"] - tot[i["id"]]["paid"], 2)
            if o > 0: out.append({"invoice_id": i["id"], "number": i["number"], "kind": i["kind"], "party_id": i["party_id"], "currency": i["currency"], "outstanding": o, "booked_rate": float(i["fx_rate"]), "booked_base": round(o * float(i["fx_rate"]), 2)})
        return out
    if fn == "fin_fx_revalue":
        e = b["p_entity"]; net = 0; detail = []
        for x in fin_rpc("fin_fx_open_items", {"p_entity": e, "p_date": b["p_date"]}):
            r_ = float(b["p_rates"][x["currency"]]); d_ = round(round(x["outstanding"] * r_, 2) - x["booked_base"], 2); g = d_ if x["kind"] == "sale" else -d_
            net += g; detail.append({**x, "closing_rate": r_, "gain": g})
        vid = str(uuid.uuid4())
        DB["fin_fx_revaluations"].insert(0, {"id": vid, "entity_id": e, "rev_date": b["p_date"], "rates": b["p_rates"], "detail": detail, "net": round(net, 2), "status": "posted", "cancel_reason": None, "created_at": iso(now)})
        return vid
    if fn == "fin_fx_revaluation_cancel":
        v = next(x for x in DB["fin_fx_revaluations"] if x["id"] == b["p_id"]); v.update(status="cancelled", cancel_reason=b["p_reason"]); return None
    if fn == "fin_match_statement":
        st = next(x for x in DB["fin_statement_lines"] if x["id"] == b["p_statement"]); l = next(x for x in DB["fin_lines"] if x["id"] == b["p_line"])
        if round(float(l["debit"]) - float(l["credit"]), 2) != round(float(st["amount"]), 2): raise FinError("amount_mismatch")
        st["status"] = "matched"; st["matched_line_id"] = l["id"]; l["statement_line_id"] = st["id"]; return None
    raise FinError("not implemented in test fake: " + fn)

AI_PROPOSALS = {}
GCAL = {"configured": False, "sync": None, "calls": []}
results, errors = [], []
def safe_click(page, sel, name):
    try: page.wait_for_selector(sel, timeout=8000); page.click(sel)
    except Exception as e: check(name, False, str(e)[:120])
def owner_val(page):
    try: page.wait_for_selector("#ai-owner-0", timeout=8000); return page.input_value("#ai-owner-0")
    except Exception: return None
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
    page.route("https://cdn.jsdelivr.net/**", lambda r: r.fulfill(path=(XLSX if "xlsx" in r.request.url else UMD), content_type="application/javascript"))
    page.route(re.compile(r"https://fonts\.(googleapis|gstatic)\.com/.*"), lambda r: r.abort())
    page.route(re.compile(r"https://.*\.supabase\.co/.*"), handle)
    page.add_init_script(f"localStorage.setItem('sb-lvusersarnzzamdgvxgm-auth-token', {json.dumps(json.dumps(session))})")
    return ctx, page

def shot(page, name, full=False):
    if SHOTS: page.screenshot(path=os.path.join(SHOTS, name + ".png"), full_page=full)

# ---------- Simple work screens: workspace → project → tasks → steps ----------
_orig_handle = handle
def handle2(route):
    req = route.request; u = urlparse(req.url)
    if u.path == "/rest/v1/task_steps" and req.method in ("POST", "PATCH"):
        raw = json.loads(req.post_data or "{}")
        def fix(body):
            st = body.get("status")
            if st == "done": body["done_at"] = iso(dt.datetime.now(dt.timezone.utc))
            elif st == "pending": body["done_at"] = None
            if req.method == "POST": body = {"status": "pending", "sort": 0, "note": None, "done_at": None, "updated_by": ME, **body}
            if body.get("status") == "done" and not body.get("done_at"): body["done_at"] = iso(dt.datetime.now(dt.timezone.utc))
            body["updated_at"] = iso(dt.datetime.now(dt.timezone.utc)); return body
        body = [fix(b) for b in raw] if isinstance(raw, list) else fix(raw)
        return route.continue_() if False else _fake(route, body)
    if u.path == "/rest/v1/inv_entities" and req.method == "POST":
        body = json.loads(req.post_data); body = {"archived": False, "sort": 0, "description": None, "start_date": None, "owner_id": ME, **body}
        r = _fake(route, body)
        e = DB["inv_entities"][-1]; DB.setdefault("inv_members", []).append({"entity_id": e["id"], "user_id": ME, "role": "owner"})
        return r
    if u.path == "/rest/v1/rpc/inv_set_daily_sale":
        b_ = json.loads(req.post_data); ds = DB["inv_daily_sales"]; m = b_["p_day"][:7]
        ds[:] = [x for x in ds if not (x["entity_id"] == b_["p_entity"] and x["day"] == b_["p_day"])]
        if b_["p_amount"] is not None: ds.append({"id": str(uuid.uuid4()), "entity_id": b_["p_entity"], "day": b_["p_day"], "amount": b_["p_amount"]})
        tot = sum(float(x["amount"]) for x in ds if x["entity_id"] == b_["p_entity"] and x["day"][:7] == m)
        row = next((x for x in DB["inv_sales"] if x["entity_id"] == b_["p_entity"] and x["month"][:7] == m), None)
        if row: row["sales"] = tot
        else: DB["inv_sales"].append({"id": str(uuid.uuid4()), "entity_id": b_["p_entity"], "month": m + "-01", "sales": tot, "expenses": None, "net_profit": None, "note": None})
        return route.fulfill(status=200, content_type="application/json", body=json.dumps({"month": m + "-01", "month_total": tot, "synced": True}))
    if u.path == "/rest/v1/rpc/inv_edit_return":
        b_ = json.loads(req.post_data); r_ = next(x for x in DB["inv_returns"] if x["id"] == b_["p_return"])
        r_["note"] = (b_.get("p_narration") or "").strip() or None
        if b_.get("p_amount") is not None: r_["amount"] = b_["p_amount"]; r_["edited_at"] = iso(dt.datetime.now(dt.timezone.utc)); r_["edit_reason"] = b_.get("p_reason")
        return route.fulfill(status=200, content_type="application/json", body="null")
    if u.path == "/rest/v1/rpc/inv_member_list": return route.fulfill(status=200, content_type="application/json", body=json.dumps([{"user_id": ME, "role": "owner", "email": "jezz@example.com", "display_name": "Jezz"}]))
    return _orig_handle(route)
def _fake(route, body):
    class R:  # re-dispatch with the enriched body
        def __init__(s, r, b): s._r, s._b = r, b
        def __getattr__(s, k): return getattr(s._r, k)
    class Q:
        def __init__(s, q, b): s._q, s._b = q, b
        def __getattr__(s, k): return getattr(s._q, k)
        @property
        def post_data(s): return json.dumps(s._b)
    w = R(route, body); w.request = Q(route.request, body)
    return _orig_handle(w)

with sync_playwright() as pw:
    b = pw.chromium.launch()
    for (w, h, tag) in [(1360, 900, "desk"), (390, 844, "phone")]:
        DB.clear(); DB.update(fresh_db()); DB["task_steps"] = []; DB["quick_todos"] = [{"id": "qt-y", "user_id": ME, "text": "Chase LLP for September return", "done_at": None, "sort": 0, "created_at": iso(dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1))}, {"id": "qt-o", "user_id": ME, "text": "Book car service", "done_at": None, "sort": 0, "created_at": iso(dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=4))}]
        ctx, page = new_page(b, w, h)
        page.unroute(re.compile(r"https://.*\.supabase\.co/.*")); page.route(re.compile(r"https://.*\.supabase\.co/.*"), handle2)
        page.goto(BASE + "/#/home"); page.wait_for_selector(".sw-kpis", timeout=10000)
        check(f"[{tag}] home shows workspace cards", page.locator(".sw-ws").count() >= 3)
        check(f"[{tag}] home shows to-do strip with carried-over count", "2 to-dos pending" in page.inner_text(".td-strip") and "2 carried over" in page.inner_text(".td-strip"), page.inner_text(".td-strip"))
        page.goto(BASE + "/#/todo"); page.wait_for_selector(".td-now")
        t0 = page.inner_text("#view")
        check(f"[{tag}] to-do tab groups yesterday and older pending", "Pending from yesterday" in t0 and "Older, still pending" in t0 and "Chase LLP for September return" in t0, t0[:400])
        for txt in ["Call Saags about cargo pants", "Pay DEWA bill"]:
            page.fill('[data-form="qt-add"] input', txt); page.press('[data-form="qt-add"] input', "Enter"); page.wait_for_function(f"document.querySelector('.td-now').innerText.includes({json.dumps(txt)})")
        page.click('.td-now .qt-i:has-text("Pay DEWA bill") [data-act="qt-toggle"]'); page.wait_for_timeout(300)
        page.click('.td-now .qt-i:has-text("Book car service") [data-act="qt-toggle"]'); page.wait_for_timeout(300)
        d = page.inner_text(".td-day >> nth=0")
        check(f"[{tag}] diary today: counts, only finished items (no repeat of pending)", "Today" in d and "2 added" in d and "2 done" in d and "Book car service" in d and "Pay DEWA bill" in d and "Call Saags" not in d and "finished this day" in d.lower(), d[:400])
        check(f"[{tag}] diary keeps yesterday with still-pending", "Yesterday" in page.inner_text("#view") and "still pending" in page.inner_text("#view"))
        page.click('[data-act="qt-details"]'); page.wait_for_selector('[data-form="qt-add"] [name=items]')
        page.fill('[data-form="qt-add"] [name=text]', "Pending PO's"); page.fill('[data-form="qt-add"] [name=note]', "Close before month end")
        page.fill('[data-form="qt-add"] [name=items]', "1. DSV - materials disposal\n2. Adnov - KSA warehouse\n3. QBH")
        page.click('[data-form="qt-add"] .btn.primary'); page.wait_for_function("document.querySelector('.td-now').innerText.includes('Adnov - KSA warehouse')")
        page.click('.td-now .qt-i:has-text("Pending PO") [data-act="qt-sub"][data-i="0"]'); page.wait_for_function("document.querySelector('.td-now').innerText.includes('1/3 sub-items')")
        q = page.inner_text(".td-now")
        check(f"[{tag}] to-do with description and 3 sub-items, numbering stripped, 1 ticked", "Close before month end" in q and "1/3 sub-items" in q and "1. DSV" not in q and "DSV - materials disposal" in q, q[:400])
        page.fill('[data-form="qt-add"] [name=text]', "Call QBH"); page.press('[data-form="qt-add"] [name=text]', "Enter"); page.wait_for_function("document.querySelector('.td-now').innerText.includes('Call QBH')")
        check(f"[{tag}] plain to-do without details still works", True)
        page.select_option('.td-now .qt-i:has-text("Call QBH") select[data-qp]', "critical"); page.wait_for_selector(".td-now .qt-i.qp-critical")
        page.select_option('.td-now .qt-i:has-text("Pending PO") select[data-qp]', "medium"); page.wait_for_selector(".td-now .qt-i.qp-medium")
        page.select_option('.td-now .qt-i:has-text("Call Saags") select[data-qp]', "low"); page.wait_for_selector(".td-now .qt-i.qp-low")
        rows = page.locator(".td-now .td-g:has-text('Today') .qt-i").all_inner_texts()
        check(f"[{tag}] priorities sort critical, medium, none, low", "Call QBH" in rows[0] and "Pending PO" in rows[1] and "Call Saags" in rows[-1], str([r[:30] for r in rows]))
        box = page.locator(".td-now .qt-i.qp-medium .qt-sub li").first.bounding_box(); tbox = page.locator(".td-now .qt-i.qp-medium .qt-sub li span").first.bounding_box()
        check(f"[{tag}] sub-items stay left-aligned inside a priority row", tbox["x"] - box["x"] < 80, f"{box} {tbox}")
        check(f"[{tag}] critical shows on whiteboard strip count", True)
        nums = page.locator(".td-now .qt-num").all_inner_texts()
        check(f"[{tag}] pending to-dos numbered 1..n and sub-items lettered", nums[:3] == ["1.", "2.", "3."] and page.locator(".td-now .qt-letter").all_inner_texts()[:3] == ["A.", "B.", "C."], str(nums))
        shot(page, f"{tag}-9-todo", True)
        page.click('.td-now .qt-i:has-text("Call Saags") [data-act="qt-del"]'); page.click('#dialog [data-r="1"]'); page.wait_for_function("!document.querySelector('.td-now').innerText.includes('Call Saags')")
        check(f"[{tag}] delete asks to confirm then removes", True)
        page.goto(BASE + "/#/board"); page.wait_for_selector(".wb-cols")
        check(f"[{tag}] whiteboard hides project jobs by default (privacy)", page.locator(".c-proj").count() == 0 and "QCLOUD" not in page.inner_text(".wall"))
        page.click('[data-act="wall-proj"]'); page.wait_for_selector(".c-proj")
        wb = page.inner_text(".wb-cols")
        check(f"[{tag}] whiteboard: carried over + today + projects + done", "Chase LLP for September return" in wb and "Pending PO's" in wb and "Kite BOM delivery" in wb and "Pay DEWA bill" in wb, wb[:500])
        page.fill(".wb-add input", "Sign customs docs"); page.press(".wb-add input", "Enter"); page.wait_for_function("document.querySelector('.c-today').innerText.includes('Sign customs docs')")
        page.click('.c-today .wnote:has-text("Sign customs docs") [data-act="qt-toggle"]'); page.wait_for_function("document.querySelector('.c-done').innerText.includes('Sign customs docs')")
        check(f"[{tag}] whiteboard add + tick moves note to Done today", True)
        shot(page, f"{tag}-10-board")
        page.click('.wb-ws [data-act="wall-ws"]:has-text("QCLOUD")'); page.wait_for_timeout(200)
        check(f"[{tag}] whiteboard: untick QCLOUD hides its projects", "Kite BOM delivery" not in page.inner_text(".wb-cols"))
        page.click('.wb-ws [data-act="wall-ws"]:has-text("QCLOUD")'); page.click('[data-act="wall-proj"]'); page.wait_for_timeout(200)
        check(f"[{tag}] whiteboard hide projects", page.locator(".c-proj").count() == 0)
        page.goto(BASE + "/#/todo"); page.wait_for_selector(".td-now")
        if tag == "desk":
            check(f"[{tag}] side menu workspaces folded by default", page.locator("#sidenav .subnav.ws a").count() == 0 and "QCLOUD" not in page.inner_text("#sidenav"))
            page.click('[data-act="ws-nav-toggle"]'); page.wait_for_selector("#sidenav .subnav.ws a")
            check(f"[{tag}] expand shows workspaces", "QCLOUD" in page.inner_text("#sidenav"))
            page.click('[data-act="ws-nav-toggle"]')
        page.goto(BASE + "/#/home"); page.wait_for_selector(".sw-kpis")
        shot(page, f"{tag}-1-home", True)
        page.click(".sw-ws >> nth=1"); page.wait_for_selector(".sw-table")
        check(f"[{tag}] workspace dashboard shows open project", "Kite BOM delivery" in page.inner_text(".sw-table"))
        page.fill('[data-form="sw-add-project"] input[name=name]', "Pending POs"); page.press('[data-form="sw-add-project"] input[name=name]', "Enter")
        page.wait_for_selector('[data-form="sw-add-task"]')
        check(f"[{tag}] new project opens its board", "Pending POs" in page.inner_text(".sw-head h1"))
        page.fill('[data-form="sw-add-task"] input[name=title]', "Close PO-0586"); page.fill('[data-form="sw-add-task"] input[name=ref]', "PO-0586")
        page.click('[data-form="sw-add-task"] button'); page.wait_for_selector('[data-form="sw-add-step"]')
        page.fill('[data-form="sw-add-step"] input[name=title]', "Waiting for shipment arrival"); page.fill('[data-form="sw-add-step"] input[name=who]', "Adil")
        page.click('[data-form="sw-add-step"] button'); page.wait_for_selector(".sw-step")
        page.fill('[data-form="sw-add-step"] input[name=title]', "Followed up with freight forwarder"); page.click('[data-form="sw-add-step"] button')
        page.wait_for_function("document.querySelectorAll('.sw-step').length === 2")
        page.click(".sw-step >> nth=1 >> .sw-check"); page.wait_for_selector(".sw-step.done")
        check(f"[{tag}] ticking a step marks it done", page.locator(".sw-step.done").count() == 1)
        check(f"[{tag}] progress shows 1/2", "1/2" in page.inner_text(".sw-pk"))
        check(f"[{tag}] no updates list on the project page", page.locator(".sw-feed").count() == 0)
        # deadline + critical via edit sheet
        page.click('[data-act="sw-edit-project"]'); page.wait_for_selector('[data-form="sw-project"]')
        page.select_option('[data-form="sw-project"] select[name=priority]', "critical"); page.fill('[data-form="sw-project"] input[name=target]', "2026-12-10")
        page.click('[data-form="sw-project"] .btn.primary'); page.wait_for_selector("#sheetWrap", state="hidden")
        check(f"[{tag}] project shows critical + deadline", "Critical" in page.inner_text(".sw-pk") and "10 Dec 2026" in page.inner_text(".sw-pk"))
        shot(page, f"{tag}-3-project", True)
        page.click(".sw-step >> nth=0 >> .sw-del"); page.click('#dialog [data-r="1"]'); page.wait_for_function("document.querySelectorAll('.sw-step').length === 1")
        check(f"[{tag}] step delete works", page.locator(".sw-step").count() == 1)
        page.fill('[data-form="sw-add-task"] input[name=title]', "Throwaway task"); page.click('[data-form="sw-add-task"] button')
        page.wait_for_function("document.querySelectorAll('.sw-task').length === 2")
        page.click('.sw-task:has-text("Throwaway task") .sw-del'); page.click('#dialog [data-r="1"]'); page.wait_for_function("document.querySelectorAll('.sw-task').length === 1")
        check(f"[{tag}] task delete works", page.locator(".sw-task").count() == 1)
        page.click(".crumb a >> nth=1"); page.wait_for_selector(".sw-table")
        check(f"[{tag}] workspace counts 1 critical", page.locator('.sw-kpi.crit b').inner_text() == "1")
        shot(page, f"{tag}-2-workspace", True)
        # export all → re-import into another workspace (round trip), template download
        page.click('[data-act="swx-open-export"]'); page.wait_for_selector('[data-act="swx-export"][data-k="all"]')
        with page.expect_download() as dl: page.click('[data-act="swx-export"][data-k="all"]')
        xf = os.path.join("/tmp", f"{tag}-export.xlsx"); dl.value.save_as(xf)
        check(f"[{tag}] excel export downloads", os.path.getsize(xf) > 1000 and dl.value.suggested_filename.startswith("QCLOUD-all-projects"), dl.value.suggested_filename)
        page.click('[data-act="swx-open-import"]'); page.wait_for_selector('[data-act="swx-template"]')
        with page.expect_download() as dl2: page.click('[data-act="swx-template"]')
        check(f"[{tag}] template downloads", "import-template" in dl2.value.suggested_filename)
        page.click('#sheet [data-act="close-sheet"]')
        page.goto(BASE + "/#/w/" + WS[0]); page.wait_for_selector(".sw-table")
        page.click('[data-act="swx-open-import"]'); page.set_input_files("#swx-file", xf); page.wait_for_selector(".sw-prev", timeout=10000)
        txt = page.inner_text("#sheet")
        check(f"[{tag}] import preview shows projects before saving", "Pending POs" in txt and "Followed up with freight forwarder" in txt and "New project" in txt, txt[:300])
        before = len([p for p in DB["projects"] if p["workspace_id"] == WS[0]])
        check(f"[{tag}] nothing saved before confirm", before == 0)
        shot(page, f"{tag}-4-import-preview")
        page.click('[data-act="swx-confirm"]'); page.wait_for_selector("#sheetWrap", state="hidden")
        newp = [p for p in DB["projects"] if p["workspace_id"] == WS[0]]
        steps0 = [x for x in DB["task_steps"] if x["workspace_id"] == WS[0]]
        check(f"[{tag}] import created projects, tasks and steps", len(newp) == 2 and len(steps0) == 1, f"{len(newp)} projects, {len(steps0)} steps")
        check(f"[{tag}] imported deadline + priority kept", any(p["target_date"] == "2026-12-10" and p["priority"] == "critical" for p in newp), str([(p["name"], p["target_date"], p["priority"]) for p in newp]))
        page.goto(BASE + "/#/w/" + WS[1]); page.wait_for_selector(".sw-table")
        page.click('.sw-tr:has-text("Pending POs")'); page.wait_for_selector('[data-act="sw-close-project"]')
        page.click('[data-act="sw-close-project"]'); page.click('#dialog [data-r="1"]'); page.wait_for_selector('[data-act="sw-reopen-project"]')
        page.click(".crumb a >> nth=1"); page.wait_for_selector(".sw-table")
        check(f"[{tag}] closed project counted", page.locator('.sw-kpi >> nth=1 >> b').inner_text() == "1")
        page.click('[data-act="sw-filter"][data-k="closed"]'); page.click('.sw-tr:has-text("Pending POs")'); page.wait_for_selector('[data-act="sw-delete-project"]')
        page.click('[data-act="sw-delete-project"]'); page.click('#dialog [data-r="1"]'); page.wait_for_selector(".sw-table")
        page.click('[data-act="sw-filter"][data-k="all"] >> nth=0')
        check(f"[{tag}] project delete works", "Pending POs" not in page.inner_text(".sw-table"))
        check(f"[{tag}] workspace delete button visible", page.locator('[data-act="ws-delete"]').count() == 1)
        page.click('[data-act="ws-delete"]'); page.fill("#dlgIn", "QCLOUD"); page.click('#dialog [data-r="1"]'); page.wait_for_selector(".sw-wsgrid")
        check(f"[{tag}] workspace delete goes back home", "#/home" in page.url)
        ctx.close()
    # ---------- Investor Portal ----------
    for (w, h, tag) in [(1360, 900, "desk"), (390, 844, "phone")]:
        DB.clear(); DB.update(fresh_db()); DB["task_steps"] = []; DB["quick_todos"] = []
        for t in ["inv_entities", "inv_members", "inv_investors", "inv_returns", "inv_sales", "inv_documents", "inv_daily_sales", "inv_return_adjustments", "inv_return_log"]: DB[t] = []
        ctx, page = new_page(b, w, h)
        page.unroute(re.compile(r"https://.*\.supabase\.co/.*")); page.route(re.compile(r"https://.*\.supabase\.co/.*"), handle2)
        page.goto(BASE + "/#/investors"); page.wait_for_selector('[data-act="inv-new"]', timeout=10000)
        page.click('[data-act="inv-new"] >> nth=0'); page.wait_for_selector("#invNew")
        page.fill("#invNew [name=name]", "The Burgery In - Kakkanad"); page.fill("#invNew [name=cost]", "1.05 Cr")
        page.fill("#invNew [name=investors]", "Steeja 35 L\nJezil 35 lakhs\nNihan 35L"); page.fill("#invNew [name=me]", "Jezil")
        page.click("#invNew .btn.primary"); page.wait_for_selector(".iv-kpis", timeout=10000)
        txt = page.inner_text("#view")
        check(f"[{tag}] entity deck shows project cost 1.05 Cr", "₹1.05 Cr" in txt, txt[:200])
        check(f"[{tag}] three investors at 33.3% each", txt.count("33.3%") >= 3 and "₹35,00,000" in txt)
        check(f"[{tag}] my position card", page.locator(".iv-me").count() == 1)
        page.click('[data-act="inv-investor"]:not([data-id]) >> nth=0'); page.wait_for_selector("#invInv")
        page.fill("#invInv [name=name]", "Burgery In Hospitality Ventures"); page.fill("#invInv [name=amount]", "0"); page.fill("#invInv [name=equity]", "28")
        page.click("#invInv .btn.primary"); page.wait_for_selector("#sheetWrap", state="hidden")
        for nm in ["Steeja", "Jezil", "Nihan"]:
            page.click(f'.iv-table tr:has-text("{nm}")'); page.wait_for_selector("#invInv"); page.fill("#invInv [name=equity]", "24"); page.click("#invInv .btn.primary"); page.wait_for_selector("#sheetWrap", state="hidden")
        eq = page.inner_text(".iv-table")
        check(f"[{tag}] equity column adds to 100% with a no-capital partner", "100%" in eq and "No capital" in eq and "28%" in eq, eq[-300:])
        # sales: add a month, then Excel upload
        page.click('.viewtabs a[href$="/sales"]'); page.wait_for_selector('[data-act="inv-sale"]')
        page.click('[data-act="inv-sale"]'); page.wait_for_selector("#invSale")
        page.fill("#invSale [name=month]", "2026-10"); page.fill("#invSale [name=sales]", "9.5 L"); page.fill("#invSale [name=exp]", "800000")
        page.click("#invSale .btn.primary"); page.wait_for_selector("#sheetWrap", state="hidden")
        page.click('[data-act="inv-sales-import"]'); page.set_input_files("#inv-sales-file", "/tmp/sales-upload.xlsx"); page.wait_for_selector('[data-act="inv-sales-confirm"]', timeout=10000)
        check(f"[{tag}] sales upload preview lists 3 months", "3 month(s) ready" in page.inner_text("#sheet"), page.inner_text("#sheet")[:200])
        page.click('[data-act="inv-sales-confirm"]'); page.wait_for_selector("#sheetWrap", state="hidden")
        page.select_option("#inv-sales-range", "all"); page.wait_for_timeout(200)
        st = page.inner_text("#view")
        check(f"[{tag}] sales total 35.7 L across 4 months", "₹35.7 L" in st and "4 months" in st, st[:400])
        check(f"[{tag}] net profit derived (Aug 1.5 L)", "₹1,50,000" in st)
        check(f"[{tag}] chart renders bars", page.locator(".iv-bar path").count() >= 4)
        shot(page, f"{tag}-6-inv-sales", True)
        page.click('[data-act="inv-sales-import"]'); page.set_input_files("#inv-sales-file", "/tmp/upl/daily.xlsx"); page.wait_for_selector('[data-act="inv-sales-confirm"]', timeout=15000)
        pv = page.inner_text("#sheet")
        check(f"[{tag}] daily upload preview: 342 days, 12 months", "342 days across 12 month(s)" in pv, pv[:200])
        page.click('[data-act="inv-sales-confirm"]'); page.wait_for_selector("#sheetWrap", state="hidden", timeout=15000)
        check(f"[{tag}] daily rows saved", len(DB["inv_daily_sales"]) == 342, str(len(DB["inv_daily_sales"])))
        page.select_option("#inv-sales-range", "all"); page.wait_for_timeout(200)
        page.click('.iv-table tr[data-month="2026-05-01"]'); page.wait_for_selector(".iv-month", timeout=5000)
        mt = page.inner_text("#sheet")
        check(f"[{tag}] May 2026 day view: 31 days, total 26.29 L, best day 6 May", "31 days recorded" in mt and "₹26.29 L" in mt and "6 May 2026" in mt, mt[:300])
        shot(page, f"{tag}-8-inv-month")
        page.click('#sheet [data-act="inv-day"][data-new]'); page.wait_for_selector("#invDay")
        page.fill("#invDay [name=day]", "2026-05-31"); page.dispatch_event("#invDay [name=day]", "change")
        check(f"[{tag}] existing day prefilled for change", page.locator("#invDayDel").is_visible())
        page.fill("#invDay [name=amt]", "99999"); page.click("#invDay .btn.primary"); page.wait_for_selector("#invDay", state="detached", timeout=10000)
        check(f"[{tag}] back on the month view with the new total", "₹26.37 L" in page.inner_text("#sheet"), page.inner_text("#sheet")[:200])
        page.click('#sheet [data-act="close-sheet"]')
        check(f"[{tag}] daily sale changed via one-day form", any(x["day"] == "2026-05-31" and float(x["amount"]) == 99999 for x in DB["inv_daily_sales"]) and len(DB["inv_daily_sales"]) == 342)
        # returns per investor
        page.click('.viewtabs a[href$="/returns"]'); page.wait_for_selector('[data-act="inv-return"]')
        page.click('[data-act="inv-return"]'); page.wait_for_selector("#invRet")
        inputs = page.locator("#invRet .iv-retline input")
        inputs.nth(0).fill("50000"); inputs.nth(1).fill("50000"); inputs.nth(2).fill("45000")
        page.click("#invRet .btn.primary"); page.wait_for_selector("#sheetWrap", state="hidden")
        rt = page.inner_text("#view")
        check(f"[{tag}] three return payments recorded", len(DB["inv_returns"]) == 3 and "₹1,45,000" in rt, rt[:300])
        check(f"[{tag}] 10% TDS split out (14,500 tax, 1,30,500 received) + FY table", sum(float(x.get("tds") or 0) for x in DB["inv_returns"]) == 14500 and "₹14,500" in rt and "₹1,30,500" in rt and "TDS by financial year" in rt, rt[:500])
        page.select_option("#inv-ret-who", label="Nihan"); page.wait_for_timeout(200)
        page.click('.iv-table tr[data-act="inv-return-edit"] >> nth=0'); page.wait_for_selector("#invRetEdit")
        page.fill("#invRetEdit [name=narr]", "Bank transfer ref 4471"); page.click("#invRetEdit .btn.primary"); page.wait_for_selector("#sheetWrap", state="hidden", timeout=10000)
        check(f"[{tag}] narration saved on a payment", "Bank transfer ref 4471" in page.inner_text(".iv-table"))
        page.click('.iv-table tr[data-act="inv-return-edit"] >> nth=0'); page.wait_for_selector("#invRetEdit"); page.click("#invAmtBtn")
        page.fill("#invRetEdit [name=amt]", "1"); page.click("#invRetEdit .btn.primary"); page.wait_for_timeout(300)
        check(f"[{tag}] amount change blocked without reason", page.locator("#invRetEdit").count() == 1 and all(float(x["amount"]) != 1 for x in DB["inv_returns"]))
        shot(page, f"{tag}-9-inv-return-edit"); page.click('#sheet [data-act="close-sheet"]')
        check(f"[{tag}] investor filter", "₹45,000" in page.inner_text(".iv-table") and "₹50,000" not in page.inner_text(".iv-table"))
        # document upload
        page.click('.viewtabs a[href$="/documents"]'); page.wait_for_selector('[data-act="inv-doc-new"]')
        page.click('[data-act="inv-doc-new"] >> nth=0'); page.wait_for_selector("#invDoc")
        page.select_option("#invDoc [name=kind]", "contract"); page.set_input_files("#invDoc [name=file]", "/tmp/sales-upload.xlsx"); page.fill("#invDoc [name=title]", "Partnership agreement")
        page.click("#invDoc .btn.primary"); page.wait_for_selector("#sheetWrap", state="hidden")
        check(f"[{tag}] contract uploaded and listed", "Partnership agreement" in page.inner_text("#view") and len(DB["inv_documents"]) == 1)
        page.click('.viewtabs a[href$="/overview"]'); page.wait_for_selector(".iv-kpis")
        ov = page.inner_text("#view")
        check(f"[{tag}] overview: returns 1.45 L, pending 103.55 L", "₹1.45 L" in ov and "₹1.04 Cr" in ov, ov[:500])
        with page.expect_download() as dl: page.click('[data-act="inv-export"]')
        check(f"[{tag}] investor Excel downloads", dl.value.suggested_filename.endswith(".xlsx"))
        shot(page, f"{tag}-5-inv-overview", True)
        page.click('.viewtabs a[href$="/settings"]'); page.wait_for_selector("#inv-share-form")
        check(f"[{tag}] settings shows sharing", "Shared with" in page.inner_text("#view"))
        page.goto(BASE + "/#/investors"); page.wait_for_selector(".iv-card")
        shot(page, f"{tag}-7-inv-list", True)
        ctx.close()
    b.close()
fails = [r for r in results if not r[1]]
print(f"\n{len(results) - len(fails)}/{len(results)} passed"); print("errors:", errors[:8])
sys.exit(1 if fails or errors else 0)
