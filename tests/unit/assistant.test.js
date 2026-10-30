import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest, parseOutput, callModel, ACTIONS } from "../../supabase/functions/assistant/core.js";

test("prompts carry only the given facts and forbid invention", () => {
  const r = buildRequest("draft_message", { to: "Rashid", subject: "dispatch date", expected: "2026-10-27", channel: "whatsapp", tone: "firm" });
  assert.match(r.system, /Never invent/); assert.match(r.system, /WhatsApp/); assert.match(r.system, /firm/);
  assert.match(r.messages[0].content, /About: dispatch date/); assert.match(r.messages[0].content, /They owe me/);
  assert.match(buildRequest("action_items", { notes: "x" }).system, /Do not add deadlines/);
  assert.throws(() => buildRequest("action_items", { notes: " " }), /bad_input/);
  assert.throws(() => buildRequest("delete_everything", {}), /bad_action/);
  assert.deepEqual(ACTIONS, ["draft_message", "action_items", "weekly_narrative", "categorize"]);
});

test("model output is validated before it reaches the app", () => {
  const ai = parseOutput("action_items", 'Sure!\n{"items":[{"title":"Send PO","owner":"Adil"},{"title":""},{"nope":1},{"title":"Book slot","owner":""}]}');
  assert.deepEqual(ai.items, [{ title: "Send PO", owner: "Adil" }, { title: "Book slot", owner: null }]);
  assert.deepEqual(parseOutput("action_items", "not json").items, []);
  const input = { lines: [{ id: "s1" }, { id: "s2" }], accounts: [{ id: "a1" }, { id: "a2" }] };
  const c = parseOutput("categorize", '{"suggestions":[{"id":"s1","account_id":"a2","confidence":"high"},{"id":"s2","account_id":"hacked"},{"id":"zz","account_id":"a1"},{"id":"s2","account_id":"a1","confidence":"sure"}]}', input);
  assert.deepEqual(c.suggestions, [{ id: "s1", account_id: "a2", confidence: "high" }, { id: "s2", account_id: "a1", confidence: "low" }]);
});

test("model call: request shape and error handling (no network)", async () => {
  let sent;
  const ok = async (url, opts) => { sent = { url, ...opts, body: JSON.parse(opts.body) }; return { ok: true, json: async () => ({ content: [{ type: "text", text: "Hi Rashid" }], usage: { input_tokens: 10, output_tokens: 4 } }) }; };
  const r = await callModel({ apiKey: "k", model: "m", req: buildRequest("draft_message", { subject: "x" }), fetchImpl: ok });
  assert.equal(r.text, "Hi Rashid"); assert.equal(sent.url, "https://api.anthropic.com/v1/messages"); assert.equal(sent.headers["x-api-key"], "k"); assert.equal(sent.body.model, "m");
  const bad = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "invalid x-api-key" } }) });
  await assert.rejects(callModel({ apiKey: "k", model: "m", req: buildRequest("draft_message", { subject: "x" }), fetchImpl: bad }), /model_error: 401 invalid x-api-key/);
});
