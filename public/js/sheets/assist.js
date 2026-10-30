// Message drafts for chasing follow-ups and waiting tasks. The person edits and sends the message themselves
// (copy, WhatsApp or email); logging that it was sent is a separate, explicit step.
import { esc, todayISO, zonedToISO } from "../util.js";
import { state, followUpById, contactById, wsById, nameOf } from "../store.js";
import { sb, run } from "../api.js";
import { ICON, $, openSheet, closeSheet, rerenderSheet, sheetHead, toast, toastError, busy } from "../ui.js";
import { followUpDraft, whatsappLink, mailtoLink } from "../smart.js";
import { aiOn, aiCall } from "../assist.js";

let d = null;
export function openDraft(kind, id) {
  const today = todayISO(state.tz), me = (state.me.display_name || "").split(" ")[0] || "";
  if (kind === "followup") {
    const f = followUpById(id); if (!f) return;
    const c = f.contact_id && contactById(f.contact_id);
    d = { kind, id, to: c ? c.name : f.counterpart || "", phone: c && c.phone, email: c && c.email, subject: f.subject, direction: f.direction, expected: f.expected_at, last: f.last_contact_at, ws: (wsById(f.workspace_id) || {}).name };
  } else {
    const t = state.taskById.get(id); if (!t) return;
    const c = t.waiting_on_contact_id && contactById(t.waiting_on_contact_id);
    d = { kind, id, to: c ? c.name : t.waiting_on || "", phone: c && c.phone, email: c && c.email, subject: t.waiting_for || t.title, direction: "they_owe", expected: null, last: null, ws: (wsById(t.workspace_id) || {}).name };
  }
  d.tone = "polite"; d.channel = d.phone ? "whatsapp" : d.email ? "email" : "whatsapp"; d.sender = me;
  d.text = followUpDraft({ kind: d.direction, to: d.to, subject: d.subject, expected: d.expected, lastContact: d.last, sender: d.sender, workspace: d.ws, tone: d.tone, today });
  openSheet(render, { wide: true });
}
function render(sh) {
  sh.innerHTML = sheetHead("Draft a message", `To ${esc(d.to || "—")} · about ${esc(d.subject)}`) + `<div class="sh-body">
    <div class="grid3"><label class="field"><span>Tone</span><select class="input" id="dr-tone"><option value="polite" ${d.tone === "polite" ? "selected" : ""}>Polite reminder</option><option value="firm" ${d.tone === "firm" ? "selected" : ""}>Firm — it's holding things up</option></select></label>
    <label class="field"><span>Send by</span><select class="input" id="dr-channel"><option value="whatsapp" ${d.channel === "whatsapp" ? "selected" : ""}>WhatsApp</option><option value="email" ${d.channel === "email" ? "selected" : ""}>Email</option></select></label>
    <label class="field"><span>${d.channel === "email" ? "Email" : "Phone (with country code)"}</span><input class="input" id="dr-to" value="${esc(d.channel === "email" ? d.email || "" : d.phone || "")}" placeholder="${d.channel === "email" ? "name@company.com" : "+974…"}"></label></div>
    <label class="field"><span>Message <small>(edit freely)</small></span><textarea class="input" id="dr-text" rows="9">${esc(d.text)}</textarea></label>
    <div class="btnrow">
      <button class="btn primary" data-act="dr-open">${d.channel === "email" ? "Open in email app" : "Open in WhatsApp"}</button>
      <button class="btn" data-act="dr-copy">Copy</button>
      ${aiOn() ? `<button class="btn" data-act="dr-ai" id="drAi">✨ Rewrite with AI</button>` : `<small class="hint">Turn on the AI assistant in Settings to get a rewritten draft.</small>`}
    </div>
    <p class="hint">Nothing is sent from Job Desk — the message opens in your own app for you to send. After sending, record it below so the log stays accurate.</p>
    <div class="btnrow"><button class="btn" data-act="dr-log">${ICON.check}I sent it — log it</button></div>
  </div>`;
}
const sync = () => { if (!$("dr-text")) return; d.text = $("dr-text").value; d.tone = $("dr-tone").value; const ch = $("dr-channel").value; const to = $("dr-to").value.trim(); if (d.channel === "email") d.email = to; else d.phone = to; d.channel = ch; };
export async function handleAssistClick(act, el) {
  if (!act.startsWith("dr-") || !d) return false;
  sync();
  if (act === "dr-copy") { try { await navigator.clipboard.writeText(d.text); toast("Copied"); } catch (e) { toastError("Couldn't copy — select the text and copy it."); } return true; }
  if (act === "dr-open") {
    if (d.channel === "whatsapp" && !String(d.phone || "").replace(/\D/g, "")) { window.open("https://wa.me/?text=" + encodeURIComponent(d.text), "_blank"); return true; }
    const subj = (d.text.match(/^Subject:\s*(.+)$/m) || [])[1] || d.subject;
    const body = d.text.replace(/^Subject:.*\n+/, "");
    window.open(d.channel === "email" ? mailtoLink(d.email, subj, body) : whatsappLink(d.phone, d.text), "_blank"); return true;
  }
  if (act === "dr-ai") {
    const btn = $("drAi"); busy(btn, true, "Writing…");
    const r = await aiCall("draft_message", { to: d.to, subject: d.subject, direction: d.direction, expected: d.expected, last_contact: d.last, tone: d.tone, channel: d.channel, sender: d.sender });
    busy(btn, false);
    if (r.error) return toastError(r.error), true;
    d.text = r.data.text; rerenderSheet(); toast("Draft rewritten — check it before sending"); return true;
  }
  if (act === "dr-log") {
    const how = d.channel === "email" ? "email" : "WhatsApp", body = `Sent by ${how}: ${d.text.replace(/\s+/g, " ").slice(0, 400)}`;
    let r;
    if (d.kind === "followup") {
      r = await run(sb.from("follow_up_logs").insert({ follow_up_id: d.id, body, contacted_at: new Date().toISOString() }));
      if (!r.error) { const u = await run(sb.from("follow_ups").update({ last_contact_at: todayISO(state.tz) }).eq("id", d.id).select().single()); if (u.data) Object.assign(followUpById(d.id), u.data); }
    } else r = await run(sb.from("task_comments").insert({ task_id: d.id, body: `Chased ${d.to || ""} — ${body}`, kind: "note" }));
    if (r.error) return toastError(r.error), true;
    closeSheet(); toast("Logged as sent"); d = null; return true;
  }
  return true;
}
export function handleAssistChange(e) {
  if (!d || !["dr-tone", "dr-channel"].includes(e.target.id)) return false;
  const prevTone = d.tone; sync();
  if (e.target.id === "dr-tone" && prevTone !== d.tone) d.text = followUpDraft({ kind: d.direction, to: d.to, subject: d.subject, expected: d.expected, lastContact: d.last, sender: d.sender, workspace: d.ws, tone: d.tone, today: todayISO(state.tz) });
  rerenderSheet(); return true;
}
