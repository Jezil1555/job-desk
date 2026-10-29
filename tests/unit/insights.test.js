import { test } from "node:test";
import assert from "node:assert/strict";
import { weekStartOf, weekDays, habitDueOn, habitStreak, habitRate, goalProgress, extractActionItems, weeklyReport, ownerWorkload, milestoneReport, toCSV, safeFileName, fmtBytes } from "../../public/js/insights.js";

test("weeks start on Sunday", () => {
  assert.equal(weekStartOf("2026-10-29"), "2026-10-25"); // Thursday → Sunday
  assert.equal(weekStartOf("2026-10-25"), "2026-10-25");
  assert.deepEqual(weekDays("2026-10-25"), ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"]);
});

test("habit schedule", () => {
  const gym = { schedule: "days", days: [0, 2, 4] }; // Sun, Tue, Thu
  assert.equal(habitDueOn(gym, "2026-10-29"), true);
  assert.equal(habitDueOn(gym, "2026-10-30"), false);
  assert.equal(habitDueOn({ schedule: "daily" }, "2026-10-30"), true);
});

test("daily streak: unfinished today does not break it, a missed day does", () => {
  const h = { schedule: "daily" };
  assert.equal(habitStreak(h, ["2026-10-26", "2026-10-27", "2026-10-28"], "2026-10-29"), 3);
  assert.equal(habitStreak(h, ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"], "2026-10-29"), 4);
  assert.equal(habitStreak(h, ["2026-10-26", "2026-10-28"], "2026-10-29"), 1);
  assert.equal(habitStreak(h, [], "2026-10-29"), 0);
});

test("specific-days streak skips non-scheduled days", () => {
  const h = { schedule: "days", days: [0, 2, 4] };
  // Thu 22, Sun 25, Tue 27 done; today Thu 29 not yet done
  assert.equal(habitStreak(h, ["2026-10-22", "2026-10-25", "2026-10-27"], "2026-10-29"), 3);
});

test("weekly streak counts weeks that met the target", () => {
  const h = { schedule: "weekly", per_week: 2 };
  const done = ["2026-10-12", "2026-10-14", "2026-10-19", "2026-10-21", "2026-10-26"]; // weeks of 11th and 18th met; current week 1/2
  assert.equal(habitStreak(h, done, "2026-10-29"), 2);
  assert.equal(habitStreak(h, [...done, "2026-10-27"], "2026-10-29"), 3);
});

test("habit completion rate", () => {
  assert.equal(habitRate({ schedule: "daily" }, ["2026-10-01", "2026-10-02"], "2026-10-01", "2026-10-04"), 50);
  assert.equal(habitRate({ schedule: "days", days: [4] }, ["2026-10-29"], "2026-10-25", "2026-10-31"), 100);
  assert.equal(habitRate({ schedule: "weekly", per_week: 4 }, ["2026-10-25", "2026-10-26"], "2026-10-25", "2026-10-31"), 50);
  assert.equal(habitRate({ schedule: "daily" }, [], "2026-10-05", "2026-10-01"), null);
});

test("goal progress", () => {
  assert.equal(goalProgress({ target_value: 8, current_value: 2 }), 25);
  assert.equal(goalProgress({ target_value: 8, current_value: 12 }), 100);
  assert.equal(goalProgress({ target_value: null, current_value: 2 }), null);
  assert.equal(goalProgress({ status: "achieved", target_value: null }), 100);
});

test("meeting action items are extracted but never invent owners or dates", () => {
  const items = extractActionItems(`Discussed KSA lane.
- [ ] Send revised PO to supplier @Adil
- [x] Already sent invoice
TODO: chase customs broker
Action: book inspection
-> confirm delivery slot
Plain line, not an action`);
  assert.deepEqual(items.map(i => i.title), ["Send revised PO to supplier @Adil", "chase customs broker", "book inspection", "confirm delivery slot"]);
  assert.equal(items[0].owner_hint, "Adil");
  assert.equal(items[1].owner_hint, null);
  assert.ok(items.every(i => !("due_at" in i)));
});

test("weekly report counts only stored facts", () => {
  const now = new Date("2026-10-29T10:00:00Z");
  const tasks = [
    { id: 1, status: "completed", completed_at: "2026-10-26T08:00:00Z", created_at: "2026-10-20T08:00:00Z", priority: "medium" },
    { id: 2, status: "in_progress", due_at: "2026-10-27T15:00:00Z", created_at: "2026-10-25T08:00:00Z", priority: "high" },
    { id: 3, status: "blocked", created_at: "2026-10-01T08:00:00Z", priority: "low" },
    { id: 4, status: "completed", completed_at: "2026-10-10T08:00:00Z", created_at: "2026-10-01T08:00:00Z", priority: "low" },
    { id: 5, status: "not_started", due_at: "2026-11-03T08:00:00Z", created_at: "2026-10-01T08:00:00Z", priority: "medium" },
    { id: 6, status: "in_progress", deleted_at: "2026-10-26T00:00:00Z", created_at: "2026-10-26T08:00:00Z", priority: "critical" }
  ];
  const r = weeklyReport({ tasks, from: "2026-10-25", to: "2026-10-31", tz: "Asia/Qatar", now });
  assert.deepEqual(r.completed.map(t => t.id), [1]);
  assert.deepEqual(r.carried.map(t => t.id), [2]);
  assert.deepEqual(r.created.map(t => t.id), [2]);
  assert.deepEqual(r.overdue.map(t => t.id), [2]);
  assert.deepEqual(r.blocked.map(t => t.id), [3]);
  assert.equal(r.completionRate, 50);
  assert.deepEqual(r.nextWeek.map(t => t.id), [2, 5]); // slipped high-priority work first, then next week's due work; blocked undated low-priority work is not listed
});

test("owner workload", () => {
  const now = new Date("2026-10-29T10:00:00Z");
  const rows = ownerWorkload([
    { owner_id: "a", status: "in_progress", priority: "high", due_at: "2026-10-01T00:00:00Z" },
    { owner_id: "a", status: "waiting", priority: "low" },
    { owner_id: "b", status: "blocked", priority: "critical" },
    { owner_id: "b", status: "completed", priority: "critical" }
  ], now);
  assert.deepEqual(rows[0], { owner_id: "a", open: 2, overdue: 1, high: 1, blocked: 0, waiting: 1 });
  assert.deepEqual(rows[1], { owner_id: "b", open: 1, overdue: 0, high: 1, blocked: 1, waiting: 0 });
});

test("milestone plan vs actual", () => {
  const now = new Date("2026-10-29T10:00:00Z");
  const [a, b, c] = milestoneReport([
    { title: "PO", planned_date: "2026-10-01", actual_date: "2026-10-04" },
    { title: "Dispatch", planned_date: "2026-10-20", actual_date: null },
    { title: "Delivery", planned_date: "2026-11-20", actual_date: null }
  ], "Asia/Qatar", now);
  assert.equal(a.variance_days, 3); assert.equal(a.state, "achieved");
  assert.equal(b.variance_days, 9); assert.equal(b.state, "overdue");
  assert.equal(c.state, "pending"); assert.equal(c.variance_days, null);
});

test("CSV escaping and safe file names", () => {
  assert.equal(toCSV([{ a: 'He said "hi"', b: "x,y" }, { a: null, b: 2 }], [{ key: "a", label: "A" }, { key: "b", label: "B" }]), 'A,B\n"He said ""hi""","x,y"\n,2');
  assert.equal(safeFileName("Invoice #12 (final).pdf"), "Invoice_12_final_.pdf");
  assert.equal(safeFileName("../../etc/passwd"), ".._.._etc_passwd");
  assert.equal(fmtBytes(2048), "2 KB");
});
