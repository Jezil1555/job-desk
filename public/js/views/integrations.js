// Settings → Integrations: private calendar link and the opt-in AI assistant.
import { esc, fmtDateTime, ago } from "../util.js";
import { state } from "../store.js";
import { sb, run, savePrefs } from "../api.js";
import { ICON, $, toast, toastError, dialog, section } from "../ui.js";
import { aiStatus } from "../assist.js";

const cfg = window.JOBDESK_CONFIG;
const ig = () => (state.ui.ig = state.ui.ig || { feed: undefined, newUrl: null, ai: null });
const feedUrl = token => `${cfg.supabaseUrl}/functions/v1/calendar-feed?token=${token}`;

export function integrationsHtml() {
  const s = ig();
  if (s.feed === undefined) { s.feed = null; run(sb.from("calendar_feeds").select("include_finance, created_at, last_used_at").maybeSingle()).then(r => { s.feed = r.data || false; repaint(); }); }
  if (state.prefs.ai_enabled && !s.ai) { s.ai = { loading: true }; aiStatus(true).then(st => { s.ai = st; repaint(); }); }
  return section("Calendar", `<div id="ig-cal">${calHtml()}</div>`) + section("AI assistant", `<div id="ig-ai">${aiHtml()}</div>`);
}
function repaint() { const a = $("ig-cal"), b = $("ig-ai"); if (a) a.innerHTML = calHtml(); if (b) b.innerHTML = aiHtml(); }
function calHtml() {
  const s = ig();
  if (s.feed === null) return `<p class="hint">Loading…</p>`;
  const url = s.newUrl;
  return `<p class="calm">Subscribe to your deadlines, follow-ups and milestones from Google Calendar, Apple Calendar or Outlook. It's read-only and updates about every hour.</p>
  ${url ? `<div class="banner ok"><b>Your private calendar link</b> — copy it now; for safety it isn't shown again.<div class="copyrow"><input class="input" readonly id="ig-url" value="${esc(url)}"><button class="btn" data-act="ig-copy">Copy</button></div>
    <ul class="plain"><li><b>iPhone / Mac:</b> <a href="${esc(url.replace(/^https:/, "webcal:"))}">Add to Apple Calendar</a></li><li><b>Google Calendar</b> (on a computer): Other calendars → + → From URL → paste the link.</li></ul></div>` : ""}
  ${s.feed ? `<p>${ICON.done} Calendar link is on${s.feed.include_finance ? " (includes bills due)" : ""}. Created ${fmtDateTime(s.feed.created_at, state.tz)}${s.feed.last_used_at ? ` · last fetched ${ago(s.feed.last_used_at)}` : " · not fetched yet"}.</p>
    <div class="btnrow"><button class="btn" data-act="ig-cal-new">Make a new link</button><button class="btn danger" data-act="ig-cal-off">Turn off</button></div>
    <p class="hint">Anyone with the link can see these calendar entries, so keep it private. Making a new link stops the old one working.</p>`
  : `<label class="check"><input type="checkbox" id="ig-fin"> Include bills due (from books you keep)</label>
    <div class="btnrow"><button class="btn primary" data-act="ig-cal-new">Create calendar link</button></div>`}`;
}
function aiHtml() {
  const s = ig(), on = !!state.prefs.ai_enabled, st = s.ai;
  return `<label class="check"><input type="checkbox" id="ig-ai-on" ${on ? "checked" : ""}> Use the AI assistant</label>
  <p class="hint">When you press an AI button, only the text needed for that request is sent to Anthropic's Claude API (for example the meeting notes you're summarising, or the bank lines you're categorising). Nothing is sent automatically, nothing is stored by Job Desk except a usage count, and every result is a suggestion you review — the assistant can't create tasks, change dates, post entries or send messages.</p>
  ${on ? (!st || st.loading ? `<p class="hint">Checking…</p>` : st.error ? `<p class="bad-text">${esc(st.error)}</p>` : st.configured
    ? `<p>${ICON.done} Ready · ${st.used_24h} of ${st.limit} requests used in the last 24 hours · model ${esc(st.model)}</p>`
    : `<div class="banner warn"><b>Needs an API key.</b> In the Supabase dashboard open Edge Functions → Secrets and add <code>ANTHROPIC_API_KEY</code> with a key from console.anthropic.com. Then reload this page.</div>`) : ""}
  <p class="hint">Where it helps: rewriting chase messages, suggesting action items from meeting notes, drafting your weekly review, and suggesting accounts for bank lines.</p>`;
}
export async function handleIntegrationsClick(act, el) {
  const s = ig();
  switch (act) {
    case "ig-copy": { const i = $("ig-url"); try { await navigator.clipboard.writeText(i.value); toast("Copied"); } catch (e) { i.select(); toast("Press Ctrl/Cmd+C to copy"); } return true; }
    case "ig-cal-new": {
      if (s.feed && !(await dialog({ title: "Make a new calendar link?", text: "The current link will stop working; calendars using it need the new one.", confirm: "Make new link" }))) return true;
      const fin = $("ig-fin") ? $("ig-fin").checked : !!(s.feed && s.feed.include_finance);
      const r = await run(sb.rpc("create_calendar_feed", { p_include_finance: fin }));
      if (r.error) return toastError(r.error), true;
      s.newUrl = feedUrl(r.data); s.feed = { include_finance: fin, created_at: new Date().toISOString(), last_used_at: null }; repaint(); return true;
    }
    case "ig-cal-off": {
      if (!(await dialog({ title: "Turn off the calendar link?", text: "Calendars subscribed to it will stop updating.", confirm: "Turn off", danger: true }))) return true;
      const r = await run(sb.rpc("revoke_calendar_feed")); if (r.error) return toastError(r.error), true;
      s.feed = false; s.newUrl = null; repaint(); toast("Calendar link turned off"); return true;
    }
  }
  return false;
}
export async function handleIntegrationsChange(e) {
  if (e.target.id !== "ig-ai-on") return false;
  const on = e.target.checked;
  const r = await savePrefs({ ai_enabled: on }); if (r && r.error) return toastError(r.error), true;
  ig().ai = null; toast(on ? "AI assistant on" : "AI assistant off");
  const b = $("ig-ai"); if (b) b.innerHTML = aiHtml(); if (on) aiStatus(true).then(st => { ig().ai = st; repaint(); });
  return true;
}
