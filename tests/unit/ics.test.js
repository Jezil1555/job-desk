import { test } from "node:test";
import assert from "node:assert/strict";
import { buildICS, fold, localDate } from "../../supabase/functions/calendar-feed/ics.js";

test("iCal output: timed and all-day events, escaping, CRLF", () => {
  const ics = buildICS({ now: new Date("2026-10-30T06:00:00Z"), tz: "Asia/Qatar", events: [
    { uid: "task-due-1", title: "Due: Book container; urgent, today", at: "2026-10-30T12:00:00Z", all_day: false, description: "QCLOUD\nNext: call agent", url: "/#/t/1" },
    { uid: "ms-2", title: "Milestone: Customs clearance", at: "2026-11-02T00:00:00+00:00", all_day: true, url: "/#/p/9" },
    { uid: "task-due-3", title: "Due late night", at: "2026-10-30T22:30:00Z", all_day: true } ] });
  const flat = ics.replace(/\r\n /g, ""); // unfold continuation lines before matching content
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")); assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.match(ics, /DTSTART:20261030T120000Z\r\nDTEND:20261030T123000Z/);
  assert.match(flat, /SUMMARY:Due: Book container\\; urgent\\, today/);
  assert.match(flat, /DESCRIPTION:QCLOUD\\nNext: call agent\\nOpen in Job Desk: https:\/\/job-desk-u8nj.onrender.com\/#\/t\/1/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261102\r\nDTEND;VALUE=DATE:20261103/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261031/); // 22:30 UTC is already 31 Oct in Doha
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 3);
  assert.ok(ics.split("\r\n").every(l => new TextEncoder().encode(l).length <= 75));
});
test("long lines fold at 75 octets without splitting characters", () => {
  const f = fold("SUMMARY:" + "ملاحظة ".repeat(30));
  assert.ok(f.split("\r\n").every(l => new TextEncoder().encode(l).length <= 75));
  assert.equal(f.split("\r\n ").join(""), "SUMMARY:" + "ملاحظة ".repeat(30));
  assert.equal(localDate("2026-12-31T21:30:00Z", "Asia/Qatar"), "20270101");
});
