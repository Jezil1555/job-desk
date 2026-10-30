import { test } from "node:test";
import assert from "node:assert/strict";
import { isOverdue, isOpen, dueInDays, isReady, openPrerequisites, dependents, overduePrerequisites, taskProgress,
         completionBlockers, statusRequirements, sortTasks, viewFilter, attentionItems, milestoneVariance } from "../../public/js/logic.js";

const NOW = new Date("2026-10-29T12:00:00Z"); // 15:00 in Doha
const T = (o) => ({ id: o.id || Math.random().toString(36).slice(2), title: o.title || "t", status: "not_started", priority: "medium", owner_id: "me", created_by: "me", completion_criteria: [], progress: 0, ...o });

test("overdue only when the deadline has passed and the task is open", () => {
  assert.equal(isOverdue(T({ due_at: "2026-10-29T11:00:00Z" }), NOW), true);
  assert.equal(isOverdue(T({ due_at: "2026-10-29T13:00:00Z" }), NOW), false);
  assert.equal(isOverdue(T({ due_at: "2026-10-01T00:00:00Z", status: "completed" }), NOW), false);
  assert.equal(isOverdue(T({ due_at: "2026-10-01T00:00:00Z", status: "cancelled" }), NOW), false);
  assert.equal(isOverdue(T({ due_at: null }), NOW), false, "no deadline is never overdue");
  assert.equal(isOpen(T({ deleted_at: "2026-10-01T00:00:00Z" })), false, "binned tasks are not open");
});

test("due-in-days uses the Doha calendar", () => {
  assert.equal(dueInDays(T({ due_at: "2026-10-29T20:59:00Z" }), "Asia/Qatar", NOW), 0); // 23:59 tonight Doha
  assert.equal(dueInDays(T({ due_at: "2026-10-29T21:01:00Z" }), "Asia/Qatar", NOW), 1); // 00:01 tomorrow Doha
});

test("dependencies: a task is not ready until prerequisites are done", () => {
  const a = T({ id: "a", due_at: "2026-10-20T00:00:00Z" }), b = T({ id: "b" }), c = T({ id: "c", status: "completed" });
  const byId = new Map([a, b, c].map(t => [t.id, t]));
  const deps = [{ task_id: "b", depends_on_id: "a" }, { task_id: "b", depends_on_id: "c" }];
  assert.equal(isReady(b, deps, byId), false);
  assert.deepEqual(openPrerequisites(b, deps, byId).map(t => t.id), ["a"]);
  assert.deepEqual(dependents(a, deps, byId).map(t => t.id), ["b"]);
  assert.deepEqual(overduePrerequisites(b, deps, byId, NOW).map(t => t.id), ["a"], "overdue prerequisite is a dependency failure");
  a.status = "completed";
  assert.equal(isReady(b, deps, byId), true);
});

test("progress: calculated from subtasks, ignoring cancelled; otherwise manual", () => {
  const parent = T({ progress: 40 });
  assert.deepEqual(taskProgress(parent, []), { value: 40, basis: "manual" });
  const subs = [T({ status: "completed" }), T({ status: "in_progress" }), T({ status: "cancelled" }), T({ status: "completed" })];
  assert.deepEqual(taskProgress(parent, subs), { value: 67, basis: "subtasks" });
  assert.equal(parent.progress, 40, "manual value is never overwritten");
});

test("completion is blocked by unticked criteria, open subtasks and open prerequisites", () => {
  const t = T({ id: "x", completion_criteria: [{ text: "Supplier response recorded", done: true }, { text: "Next action documented", done: false }] });
  const pre = T({ id: "p" });
  const byId = new Map([t, pre].map(v => [v.id, v]));
  const b = completionBlockers(t, [T({ status: "in_progress" })], [{ task_id: "x", depends_on_id: "p" }], byId);
  assert.equal(b.length, 3);
  t.completion_criteria[1].done = true; pre.status = "completed";
  assert.deepEqual(completionBlockers(t, [T({ status: "completed" })], [{ task_id: "x", depends_on_id: "p" }], byId), []);
});

test("waiting and blocked need their details", () => {
  assert.ok(statusRequirements("waiting", T({})));
  assert.equal(statusRequirements("waiting", T({ waiting_on: "Supplier" })), null);
  assert.ok(statusRequirements("blocked", T({ blocker: "  " })));
  assert.equal(statusRequirements("blocked", T({ blocker: "Customs hold" })), null);
  assert.equal(statusRequirements("in_progress", T({})), null);
});

test("smart sort: open first, then deadline, then priority; tasks without deadline last", () => {
  const list = [T({ id: "1", due_at: null, priority: "critical" }), T({ id: "2", due_at: "2026-11-02T00:00:00Z", priority: "low" }),
                T({ id: "3", due_at: "2026-11-01T00:00:00Z", priority: "low" }), T({ id: "4", status: "completed", completed_at: "2026-10-01T00:00:00Z" }),
                T({ id: "5", due_at: "2026-11-01T00:00:00Z", priority: "high" })];
  assert.deepEqual(sortTasks(list).map(t => t.id), ["5", "3", "2", "1", "4"]);
  assert.deepEqual(sortTasks(list, "priority").map(t => t.id), ["1", "5", "3", "2", "4"]);
});

test("views select the right tasks", () => {
  const tasks = [
    T({ id: "over", due_at: "2026-10-28T00:00:00Z" }),
    T({ id: "today", due_at: "2026-10-29T20:00:00Z" }),
    T({ id: "inbox", status: "inbox" }),
    T({ id: "wait", status: "waiting", waiting_on: "X" }),
    T({ id: "deleg", owner_id: "bob" }),
    T({ id: "fu", follow_up_at: "2026-10-29T06:00:00Z" }),
    T({ id: "done", status: "completed" })
  ];
  const ids = v => tasks.filter(viewFilter(v, "me", "Asia/Qatar", NOW)).map(t => t.id).sort();
  assert.deepEqual(ids("today"), ["fu", "over", "today"]);
  assert.deepEqual(ids("overdue"), ["over"]);
  assert.deepEqual(ids("inbox"), ["inbox"]);
  assert.deepEqual(ids("waiting"), ["wait"]);
  assert.deepEqual(ids("delegated"), ["deleg"]);
  assert.deepEqual(ids("completed"), ["done"]);
  assert.ok(!ids("all").includes("done"));
});

test("attention ranks overdue critical above escalations above at-risk projects", () => {
  const items = attentionItems({
    tasks: [T({ id: "c", priority: "critical", due_at: "2026-10-28T00:00:00Z" }), T({ id: "l", priority: "low" })],
    followUps: [{ id: "f", status: "escalated" }],
    health: [{ project_id: "p", effective_status: "at_risk", reasons: ["1 milestone(s) overdue"] }],
    projects: [{ id: "p", name: "P", archived: false }],
    milestones: [], uid: "me", tz: "Asia/Qatar", now: NOW
  });
  assert.deepEqual(items.map(i => i.id), ["c", "f", "p"]);
});

test("milestone variance from real dates only", () => {
  assert.equal(milestoneVariance({ planned_date: "2026-10-10", actual_date: "2026-10-13" }), 3);
  assert.equal(milestoneVariance({ planned_date: "2026-10-10", actual_date: "2026-10-08" }), -2);
  assert.equal(milestoneVariance({ planned_date: null }), null);
  assert.equal(milestoneVariance({ planned_date: "2026-10-27", actual_date: null }, "Asia/Qatar", NOW), 2);
  assert.equal(milestoneVariance({ planned_date: "2026-11-27", actual_date: null }, "Asia/Qatar", NOW), null, "future open milestone isn't late");
});

test("a task with a reviewer can't be completed until approved", async () => {
  const { completionBlockers, doerOf, involves } = await import("../../public/js/logic.js");
  const t = { id: "r1", status: "in_progress", completion_criteria: [], reviewer_id: "u2", review_status: "requested", owner_id: "u1", assignee_id: "u3" };
  assert.deepEqual(completionBlockers(t, [], [], new Map()), ["the reviewer hasn't approved it yet"]);
  assert.deepEqual(completionBlockers({ ...t, review_status: "approved" }, [], [], new Map()), []);
  assert.equal(doerOf(t), "u3"); assert.equal(doerOf({ ...t, assignee_id: null }), "u1");
  assert.ok(involves(t, "u1") && involves(t, "u2") && involves(t, "u3") && !involves(t, "u4"));
  assert.ok(!involves({ ...t, review_status: "approved" }, "u2"));
});
