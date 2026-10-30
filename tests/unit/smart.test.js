import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDate, resolveTime, parseCapture, dailyBriefing, followUpDraft, whatsappLink } from "../../public/js/smart.js";

const T = "2026-10-29"; // a Thursday
const ctx = { today: T, workspaces: [{ id: "w1", name: "QCLOUD" }, { id: "w2", name: "D'Lusso & Mediate" }, { id: "w3", name: "The Burgery Thrissur" }],
  members: [{ user_id: "u1", name: "Jezz" }, { user_id: "u2", name: "Adil Rahman" }] };

test("relative and written dates", () => {
  assert.equal(resolveDate("today", T), "2026-10-29");
  assert.equal(resolveDate("tomorrow", T), "2026-10-30");
  assert.equal(resolveDate("fri", T), "2026-10-30");
  assert.equal(resolveDate("thursday", T), "2026-11-05");      // same weekday = next week
  assert.equal(resolveDate("this thu", T), "2026-10-29");
  assert.equal(resolveDate("sunday", T), "2026-11-01");
  assert.equal(resolveDate("next week", T), "2026-11-01");     // GCC week starts Sunday
  assert.equal(resolveDate("in 3 days", T), "2026-11-01");
  assert.equal(resolveDate("in 2 weeks", T), "2026-11-12");
  assert.equal(resolveDate("in 1 month", "2026-01-31"), "2026-02-28");
  assert.equal(resolveDate("5 nov", T), "2026-11-05");
  assert.equal(resolveDate("Nov 5th", T), "2026-11-05");
  assert.equal(resolveDate("3 jan", T), "2027-01-03");          // past date rolls to next year
  assert.equal(resolveDate("12/11", T), "2026-11-12");          // day first
  assert.equal(resolveDate("31/02", T), null);
  assert.equal(resolveDate("end of month", T), "2026-10-31");
  assert.deepEqual(["3pm", "9:30am", "15:45", "noon", "12am", "13pm"].map(resolveTime), ["15:00", "09:30", "15:45", "12:00", "00:00", null]);
});

test("capture line: everything typed is recognised and removed from the title", () => {
  const r = parseCapture("Call Adil about BOE tomorrow 3pm #qcloud @adil !high", ctx);
  assert.equal(r.title, "Call Adil about BOE");
  assert.deepEqual([r.due_d, r.due_t, r.workspace_id, r.owner_id, r.priority], ["2026-10-30", "15:00", "w1", "u2", "high"]);
  assert.equal(r.chips.length, 4);
});

test("follow-up and due dates are told apart", () => {
  const r = parseCapture("Send revised PO to Al Muthawa by 5 nov follow up mon 10am #dlusso", ctx);
  assert.equal(r.title, "Send revised PO to Al Muthawa");
  assert.deepEqual([r.due_d, r.fu_d, r.fu_t, r.workspace_id], ["2026-11-05", "2026-11-02", "10:00", "w2"]);
});

test("no date is invented when none is written", () => {
  const r = parseCapture("Look into new freight forwarder", ctx);
  assert.equal(r.due_d, undefined); assert.equal(r.fu_d, undefined); assert.equal(r.chips.length, 0);
  assert.equal(r.title, "Look into new freight forwarder");
});

test("unknown #tags and @names stay in the title", () => {
  const r = parseCapture("Check #nonexistent with @nobody", ctx);
  assert.equal(r.title, "Check #nonexistent with @nobody"); assert.equal(r.chips.length, 0);
});

test("removed chips are not re-applied", () => {
  const r = parseCapture("Pay rent fri !high", { ...ctx, disabled: new Set(["due"]) });
  assert.equal(r.due_d, undefined); assert.equal(r.priority, "high"); assert.equal(r.title, "Pay rent fri");
});

test("a lone time means today, and is shown as a chip", () => {
  const r = parseCapture("Team call at 4pm", ctx);
  assert.deepEqual([r.title, r.due_d, r.due_t], ["Team call", T, "16:00"]);
});

test("daily briefing counts only stored facts", () => {
  const now = new Date("2026-10-29T06:00:00Z"); // 09:00 Doha
  const b = dailyBriefing({ name: "Jezz", uid: "u1", now, tz: "Asia/Qatar", habitsDue: 2, habitsDone: 1, billsDue: [{}],
    tasks: [{ title: "Late one", owner_id: "u1", status: "in_progress", due_at: "2026-10-26T10:00:00Z" }, { title: "Today", owner_id: "u1", status: "not_started", priority: "high", due_at: "2026-10-29T14:00:00Z" },
            { title: "Someone else's", owner_id: "u2", status: "not_started", due_at: "2026-10-20T10:00:00Z" }, { title: "Chase", owner_id: "u1", status: "waiting", follow_up_at: "2026-10-29T05:00:00Z" }] });
  assert.equal(b.greeting, "Good morning, Jezz.");
  assert.match(b.summary, /^1 overdue \(oldest: “Late one”, 3 days late\) · 1 due today · 1 follow-up to chase · 1 bill due this week · 1\/2 habits done$/);
  assert.equal(b.focus.title, "Late one");
  assert.equal(dailyBriefing({ tasks: [], now, tz: "Asia/Qatar" }).summary, "Nothing overdue or due today.");
});

test("message drafts and share links", () => {
  const d = followUpDraft({ to: "Rashid Khan", subject: "the revised dispatch date", expected: "2026-10-27", sender: "Jezz", workspace: "QCLOUD", today: T });
  assert.match(d, /^Hi Rashid,/); assert.match(d, /now overdue/); assert.match(d, /Thanks,\nJezz\nQCLOUD$/);
  assert.match(followUpDraft({ subject: "x", tone: "firm", today: T }), /holding up/);
  assert.equal(whatsappLink("+974 5555 1234", "Hi there"), "https://wa.me/97455551234?text=Hi%20there");
});

test("snooze times are computed in the person's time zone", async () => {
  const { snoozeUntil } = await import("../../public/js/smart.js");
  const now = Date.parse("2026-10-30T19:00:00Z"); // Fri 22:00 in Doha
  assert.equal(snoozeUntil("1h", "Asia/Qatar", now), "2026-10-30T20:00:00.000Z");
  assert.equal(snoozeUntil("tomorrow", "Asia/Qatar", now), "2026-10-31T06:00:00.000Z"); // Sat 09:00 Doha
  assert.equal(snoozeUntil("monday", "Asia/Qatar", now), "2026-11-02T06:00:00.000Z");   // Mon 09:00 Doha
  assert.equal(snoozeUntil("monday", "Asia/Qatar", Date.parse("2026-11-02T03:00:00Z")), "2026-11-09T06:00:00.000Z"); // on a Monday → next Monday
});
