import { test } from "node:test";
import assert from "node:assert/strict";
import { zonedToISO, zonedDate, zonedTime, daysFromToday, addDays, friendlyError, esc, todayISO } from "../../public/js/util.js";

test("Qatar wall-clock time converts to UTC (UTC+3, no DST)", () => {
  assert.equal(zonedToISO("2026-10-31", "23:59", "Asia/Qatar"), "2026-10-31T20:59:00.000Z");
  assert.equal(zonedToISO("2026-01-01", "00:00", "Asia/Qatar"), "2025-12-31T21:00:00.000Z");
});

test("Kolkata (UTC+5:30) and London across DST convert correctly", () => {
  assert.equal(zonedToISO("2026-06-15", "09:00", "Asia/Kolkata"), "2026-06-15T03:30:00.000Z");
  assert.equal(zonedToISO("2026-07-01", "09:00", "Europe/London"), "2026-07-01T08:00:00.000Z"); // BST
  assert.equal(zonedToISO("2026-12-01", "09:00", "Europe/London"), "2026-12-01T09:00:00.000Z"); // GMT
});

test("UTC instants display as the zone's calendar date and time", () => {
  assert.equal(zonedDate("2026-10-31T21:30:00Z", "Asia/Qatar"), "2026-11-01");
  assert.equal(zonedTime("2026-10-31T21:30:00Z", "Asia/Qatar"), "00:30");
  assert.equal(zonedDate("2026-10-31T21:30:00Z", "UTC"), "2026-10-31");
});

test("days from today are measured in the user's zone", () => {
  const now = new Date("2026-10-29T22:00:00Z"); // already 30 Oct 01:00 in Doha
  assert.equal(todayISO("Asia/Qatar", now), "2026-10-30");
  assert.equal(daysFromToday("2026-10-30", "Asia/Qatar", now), 0);
  assert.equal(daysFromToday("2026-10-29", "Asia/Qatar", now), -1);
  assert.equal(daysFromToday("2026-11-06", "Asia/Qatar", now), 7);
  assert.equal(daysFromToday(null), null);
});

test("addDays crosses month and year boundaries", () => {
  assert.equal(addDays("2026-12-30", 3), "2027-01-02");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("database rule errors become readable sentences", () => {
  assert.equal(friendlyError({ message: "criteria_incomplete: tick every completion criterion before completing" }), "Tick every completion criterion before completing.");
  assert.equal(friendlyError({ message: "new row violates row-level security policy for table \"tasks\"" }), "You don't have permission to change this.");
  assert.match(friendlyError(new TypeError("Failed to fetch")), /offline/);
});

test("HTML escaping covers all special characters", () => {
  assert.equal(esc(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assert.equal(esc(null), "");
});
