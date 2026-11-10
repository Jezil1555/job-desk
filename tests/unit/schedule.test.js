import { test } from "node:test";
import assert from "node:assert/strict";
import { taskSchedule, projectSchedule, delayText } from "../../public/js/logic.js";

const NOW = new Date("2026-11-16T09:00:00Z"); // 16 Nov, 12:00 Qatar
const due = d => d + "T20:59:00Z";             // 23:59 Qatar that day

test("completed a day after target = 1d late (the 15 → 16 Nov example)", () => {
  const s = taskSchedule({ status: "completed", due_at: due("2026-11-15"), baseline_due_at: due("2026-11-15"), actual_date: "2026-11-16" }, "Asia/Qatar", NOW);
  assert.equal(s.target, "2026-11-15"); assert.equal(s.actual, "2026-11-16"); assert.equal(s.delay, 1); assert.equal(s.state, "late");
});
test("open and past target keeps counting days late", () => {
  const s = taskSchedule({ status: "in_progress", due_at: due("2026-11-13") }, "Asia/Qatar", NOW);
  assert.equal(s.delay, 3); assert.equal(s.state, "running_late");
});
test("early, on time, due today and planned", () => {
  assert.equal(taskSchedule({ status: "completed", due_at: due("2026-11-15"), actual_date: "2026-11-13" }, "Asia/Qatar", NOW).delay, -2);
  assert.equal(taskSchedule({ status: "completed", due_at: due("2026-11-15"), actual_date: "2026-11-15" }, "Asia/Qatar", NOW).state, "ontime");
  assert.equal(taskSchedule({ status: "not_started", due_at: due("2026-11-16") }, "Asia/Qatar", NOW).state, "due_today");
  assert.equal(taskSchedule({ status: "not_started", due_at: due("2026-11-20") }, "Asia/Qatar", NOW).state, "planned");
});
test("slip = target moved against the original baseline", () => {
  const s = taskSchedule({ status: "not_started", due_at: due("2026-11-20"), baseline_due_at: due("2026-11-15") }, "Asia/Qatar", NOW);
  assert.equal(s.baseline, "2026-11-15"); assert.equal(s.slip, 5);
});
test("project finish forecast and delay against the baseline", () => {
  const ps = projectSchedule([
    { id: 1, status: "completed", due_at: due("2026-11-10"), baseline_due_at: due("2026-11-10"), actual_date: "2026-11-11" },
    { id: 2, status: "in_progress", due_at: due("2026-11-15"), baseline_due_at: due("2026-11-15") },
    { id: 3, status: "cancelled", due_at: due("2026-11-30") },
    { id: 4, status: "not_started", due_at: null, parent_id: 2 }
  ], "Asia/Qatar", NOW);
  assert.equal(ps.baseline, "2026-11-15"); assert.equal(ps.forecast, "2026-11-16"); assert.equal(ps.delay, 1);
  assert.equal(ps.total, 2); assert.equal(ps.done, 1); assert.equal(ps.late, 1); assert.equal(ps.finished, null);
});
test("delay wording", () => { assert.equal(delayText(2), "2d late"); assert.equal(delayText(-1), "1d early"); assert.equal(delayText(0), "On time"); assert.equal(delayText(null), ""); });
