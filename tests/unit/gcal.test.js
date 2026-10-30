import { test } from "node:test";
import assert from "node:assert/strict";
import { eventId, desiredEvents, localDate, signState, verifyState, authUrl, emailFromIdToken } from "../../supabase/functions/gcal-sync/core.js";

const U = "d4422500-0000-4000-8000-000000000001", OTHER = "d4422500-0000-4000-8000-000000000002";
const task = (x = {}) => ({ id: "aaaaaaaa-1111-4222-8333-444444444444", title: "Book container", status: "not_started", deleted_at: null, due_at: null, due_all_day: false, follow_up_at: null,
  next_action: null, waiting_on: null, owner_id: U, created_by: U, ...x });

test("event ids are deterministic and valid for Google (base32hex)", () => {
  const a = eventId("aaaaaaaa-1111-4222-8333-444444444444", "due");
  assert.equal(a, eventId("AAAAAAAA-1111-4222-8333-444444444444", "due"));
  assert.notEqual(a, eventId("aaaaaaaa-1111-4222-8333-444444444444", "followup"));
  assert.match(a, /^[0-9a-v]{5,1024}$/);
});
test("timed deadline becomes a 30-minute event in Doha time", () => {
  const e = desiredEvents(task({ due_at: "2026-10-31T07:00:00Z", next_action: "Call EVS" }), U, { appUrl: "https://app.example", workspace: "QCLOUD" });
  assert.equal(e.due.summary, "Due: Book container");
  assert.deepEqual(e.due.start, { dateTime: "2026-10-31T07:00:00Z", timeZone: "Asia/Qatar" });
  assert.equal(e.due.end.dateTime, "2026-10-31T07:30:00.000Z");
  assert.ok(e.due.description.includes("Next: Call EVS") && e.due.description.includes("https://app.example/#/t/"));
  assert.equal(e.followup, null);
});
test("all-day deadline uses the local date, not the UTC date", () => {
  // 22:30 UTC on 30 Oct is already 31 Oct in Doha
  const e = desiredEvents(task({ due_at: "2026-10-30T22:30:00Z", due_all_day: true }), U);
  assert.deepEqual(e.due.start, { date: "2026-10-31" });
  assert.deepEqual(e.due.end, { date: "2026-11-01" });
  assert.equal(localDate("2026-10-30T20:59:00Z", "Asia/Qatar"), "2026-10-30");
});
test("follow-up becomes its own event", () => {
  const e = desiredEvents(task({ follow_up_at: "2026-11-02T06:00:00Z", waiting_on: "Clearing agent" }), U);
  assert.equal(e.followup.summary, "Follow up: Book container");
  assert.ok(e.followup.description.includes("Waiting on: Clearing agent"));
});
test("completed, cancelled, deleted or someone else's tasks have no events", () => {
  const d = { due_at: "2026-10-31T07:00:00Z", follow_up_at: "2026-11-01T07:00:00Z" };
  for (const t of [task({ ...d, status: "completed" }), task({ ...d, status: "cancelled" }), task({ ...d, deleted_at: "2026-10-30T00:00:00Z" }), task({ ...d, owner_id: OTHER }), null])
    assert.deepEqual(desiredEvents(t, U), { due: null, followup: null });
  assert.ok(desiredEvents(task({ ...d, owner_id: null }), U).due, "falls back to creator when unassigned");
});
test("signed state: accepts its own, rejects tampering and expiry", async () => {
  const s = await signState(U, "secret-1", 600, 1_000_000_000_000);
  assert.equal(await verifyState(s, "secret-1", 1_000_000_000_000), U);
  assert.equal(await verifyState(s, "other-secret", 1_000_000_000_000), null);
  assert.equal(await verifyState(s.replace(U, OTHER), "secret-1", 1_000_000_000_000), null);
  assert.equal(await verifyState(s, "secret-1", 1_000_000_000_000 + 601_000), null);
  assert.equal(await verifyState("garbage", "secret-1"), null);
});
test("auth URL asks only for calendar events + email, offline", () => {
  const u = new URL(authUrl({ clientId: "cid", redirectUri: "https://x/cb", state: "s" }));
  assert.equal(u.searchParams.get("scope"), "openid email https://www.googleapis.com/auth/calendar.events");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("redirect_uri"), "https://x/cb");
});
test("email read from id token payload", () => {
  const payload = Buffer.from(JSON.stringify({ email: "jezz@example.com" })).toString("base64url");
  assert.equal(emailFromIdToken(`h.${payload}.s`), "jezz@example.com");
  assert.equal(emailFromIdToken("bad"), null);
});
