// Rule-based helpers (no AI): read dates, owners, workspaces and priority typed into Quick Capture,
// and build the daily briefing. Everything parsed is shown to the person as removable chips before saving.
import { addDays, weekdayOf, todayISO, zonedDate, DEFAULT_TZ } from "./util.js";

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const DAYS = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MON_RE = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const DAY_RE = "sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?";
const DATE_RE = `(?:day after tomorrow|today|tonight|eod|tomorrow|tmrw|tmr|end of (?:the )?month|eom|next week|in\\s+\\d{1,3}\\s+(?:days?|weeks?|months?)|(?:next\\s+|this\\s+)?(?:${DAY_RE})|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MON_RE})(?:\\s+\\d{4})?|(?:${MON_RE})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}[\\/.]\\d{1,2}(?:[\\/.]\\d{2,4})?)`;
const TIME_RE = `(?:\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)|\\d{1,2}:\\d{2}|noon|midday)`;
const pad = n => String(n).padStart(2, "0");

function monthNum(s) { s = s.toLowerCase(); return MONTHS[s.slice(0, 4)] || MONTHS[s.slice(0, 3)]; }
function validDate(y, m, d) { const dt = new Date(Date.UTC(y, m - 1, d)); return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null; }
/** Resolve a written date relative to today (YYYY-MM-DD). Dates without a year roll forward to the next occurrence. */
export function resolveDate(text, today) {
  const s = text.toLowerCase().trim().replace(/\s+/g, " ");
  const [ty] = today.split("-").map(Number);
  if (s === "today" || s === "tonight" || s === "eod") return today;
  if (s === "tomorrow" || s === "tmrw" || s === "tmr") return addDays(today, 1);
  if (s === "day after tomorrow") return addDays(today, 2);
  if (/^(end of (the )?month|eom)$/.test(s)) { const [y, m] = today.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }
  if (s === "next week") return addDays(today, 7 - weekdayOf(today)); // start of next week (Sunday)
  let m = s.match(/^in (\d{1,3}) (day|week|month)s?$/);
  if (m) { const n = +m[1]; if (m[2] === "day") return addDays(today, n); if (m[2] === "week") return addDays(today, 7 * n);
    const [y, mo, d] = today.split("-").map(Number); const t = new Date(Date.UTC(y, mo - 1 + n, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    return validDate(t.getUTCFullYear(), t.getUTCMonth() + 1, Math.min(d, last)); }
  m = s.match(new RegExp(`^(next |this )?(${DAY_RE})$`));
  if (m) { // bare or "next" weekday = the coming one (a week ahead if it's today); "this" weekday may be today
    const want = DAYS[m[2].slice(0, 3)], cur = weekdayOf(today); let diff = (want - cur + 7) % 7;
    if (diff === 0 && m[1] !== "this ") diff = 7;
    return addDays(today, diff); }
  m = s.match(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)? (${MON_RE})(?: (\\d{4}))?$`)) || null;
  let day, mon, yr;
  if (m) { day = +m[1]; mon = monthNum(m[2]); yr = m[3] ? +m[3] : null; }
  else if ((m = s.match(new RegExp(`^(${MON_RE}) (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?$`)))) { day = +m[2]; mon = monthNum(m[1]); yr = m[3] ? +m[3] : null; }
  else if ((m = s.match(/^(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?$/))) { day = +m[1]; mon = +m[2]; yr = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : null; } // day first (GCC/India)
  if (!day || !mon) return null;
  if (yr) return validDate(yr, mon, day);
  const thisYear = validDate(ty, mon, day);
  if (!thisYear) return null;
  return thisYear < today ? validDate(ty + 1, mon, day) : thisYear;
}
export function resolveTime(text) {
  const s = text.toLowerCase().replace(/\s+/g, "");
  if (s === "noon" || s === "midday") return "12:00";
  let m = s.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (m) { let h = +m[1]; const mi = +(m[2] || 0); if (h < 1 || h > 12 || mi > 59) return null; if (m[3] === "pm" && h < 12) h += 12; if (m[3] === "am" && h === 12) h = 0; return `${pad(h)}:${pad(mi)}`; }
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m && +m[1] < 24 && +m[2] < 60) return `${pad(+m[1])}:${m[2]}`;
  return null;
}

const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
/**
 * Parse a capture line. Returns the cleaned title plus anything recognised, and a list of chips describing each.
 * ctx: { today, workspaces:[{id,name}], members:[{user_id,name}], disabled:Set of chip kinds the person removed }
 */
export function parseCapture(text, ctx) {
  const today = ctx.today, off = ctx.disabled || new Set();
  let s = " " + String(text || "") + " ";
  const out = { chips: [] };
  const take = (re, fn) => { const m = s.match(re); if (!m) return false; if (fn(m) === false) return false; s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length); return true; };
  // priority
  if (!off.has("priority")) take(/\s(!!!|!critical|!urgent|!!|!high|!medium|!med|!low)(?=\s)/i, m => {
    const k = m[1].toLowerCase(); out.priority = ["!!!", "!critical", "!urgent"].includes(k) ? "critical" : ["!!", "!high"].includes(k) ? "high" : k === "!low" ? "low" : "medium";
    out.chips.push({ kind: "priority", text: m[1], label: `Priority: ${out.priority[0].toUpperCase() + out.priority.slice(1)}` }); });
  // workspace
  if (!off.has("workspace")) take(/\s#([\p{L}\d][\p{L}\d&'._-]*)(?=\s)/u, m => {
    const q = norm(m[1]); const w = (ctx.workspaces || []).find(x => norm(x.name).startsWith(q)) || (ctx.workspaces || []).find(x => norm(x.name).includes(q));
    if (!w) return false; out.workspace_id = w.id; out.chips.push({ kind: "workspace", text: m[0].trim(), label: `Workspace: ${w.name}` }); });
  // owner
  if (!off.has("owner")) take(/\s@([\p{L}][\p{L}.'-]*)(?=\s)/u, m => {
    const q = norm(m[1]); const p = (ctx.members || []).find(x => norm(x.name).startsWith(q)) || (ctx.members || []).find(x => norm(x.name).includes(q));
    if (!p) return false; out.owner_id = p.user_id; out.chips.push({ kind: "owner", text: m[0].trim(), label: `Owner: ${p.name}` }); });
  // follow-up date: "follow up fri 10am", "chase on 5 nov"
  if (!off.has("follow_up")) take(new RegExp(`\\s(?:follow[\\s-]?up|f\\/u|chase)\\s+(?:on\\s+|by\\s+)?(${DATE_RE})(?:\\s+(?:at\\s+)?(${TIME_RE}))?(?=[\\s,.;]|$)`, "i"), m => {
    const d = resolveDate(m[1], today); if (!d) return false; out.fu_d = d; out.fu_t = m[2] ? resolveTime(m[2]) || "" : "";
    out.chips.push({ kind: "follow_up", text: m[0].trim(), label: `Follow up: ${chipDate(d, out.fu_t, today)}` }); });
  // due date: "by fri", "due 5 nov", "tomorrow 3pm", "on 12/11"
  if (!off.has("due")) take(new RegExp(`\\s(?:(?:by|due|before|on)\\s+)?(${DATE_RE})(?:\\s+(?:at\\s+)?(${TIME_RE}))?(?=[\\s,.;]|$)`, "i"), m => {
    const d = resolveDate(m[1], today); if (!d) return false; out.due_d = d; out.due_t = m[2] ? resolveTime(m[2]) || "" : (/^(tonight|eod)$/i.test(m[1]) ? (m[1].toLowerCase() === "eod" ? "17:00" : "20:00") : "");
    out.chips.push({ kind: "due", text: m[0].trim(), label: `Due: ${chipDate(d, out.due_t, today)}` }); });
  // a time on its own ("at 3pm") means today — shown as a chip so it can be removed
  if (!off.has("due") && !out.due_d) take(new RegExp(`\\sat\\s+(${TIME_RE})(?=[\\s,.;]|$)`, "i"), m => {
    const t = resolveTime(m[1]); if (!t) return false; out.due_d = today; out.due_t = t; out.chips.push({ kind: "due", text: m[0].trim(), label: `Due: ${chipDate(today, t, today)}` }); });
  out.title = s.replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1").replace(/[\s,;:-]+$/, "").trim();
  return out;
}
export function chipDate(d, t, today) {
  const rel = d === today ? "today" : d === addDays(today, 1) ? "tomorrow" : new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  return rel + (t ? " " + t : "");
}

/* ---------- daily briefing (rule-based, from stored records only) ---------- */
export function dailyBriefing({ name, tasks, followUps = [], habitsDue = 0, habitsDone = 0, billsDue = [], uid, tz = DEFAULT_TZ, now = new Date() }) {
  const today = todayISO(tz, now), hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(now));
  const greeting = `${hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"}${name ? ", " + name : ""}.`;
  const open = tasks.filter(t => !t.deleted_at && !["completed", "cancelled"].includes(t.status) && (!uid || t.owner_id === uid));
  const overdue = open.filter(t => t.due_at && new Date(t.due_at) < now).sort((a, b) => a.due_at.localeCompare(b.due_at));
  const dueToday = open.filter(t => t.due_at && new Date(t.due_at) >= now && zonedDate(t.due_at, tz) === today);
  const chase = open.filter(t => t.follow_up_at && new Date(t.follow_up_at) <= now).length + followUps.filter(f => ["open", "escalated"].includes(f.status) && f.next_follow_up_at && new Date(f.next_follow_up_at) <= now).length;
  const blocked = open.filter(t => t.status === "blocked").length, inbox = open.filter(t => t.status === "inbox").length;
  const parts = [];
  if (overdue.length) { const days = Math.max(1, Math.round((now - new Date(overdue[0].due_at)) / 86400000)); parts.push(`${overdue.length} overdue (oldest: “${overdue[0].title}”, ${days} day${days > 1 ? "s" : ""} late)`); }
  if (dueToday.length) parts.push(`${dueToday.length} due today`);
  if (chase) parts.push(`${chase} follow-up${chase > 1 ? "s" : ""} to chase`);
  if (blocked) parts.push(`${blocked} blocked`);
  if (billsDue.length) parts.push(`${billsDue.length} bill${billsDue.length > 1 ? "s" : ""} due this week`);
  if (habitsDue) parts.push(`${habitsDone}/${habitsDue} habits done`);
  if (inbox) parts.push(`${inbox} in your inbox to sort`);
  const focus = overdue[0] || dueToday.sort((a, b) => ({ critical: 0, high: 1, medium: 2, low: 3 }[a.priority] - { critical: 0, high: 1, medium: 2, low: 3 }[b.priority]))[0] || null;
  return { greeting, summary: parts.length ? parts.join(" · ") : "Nothing overdue or due today.", focus, counts: { overdue: overdue.length, dueToday: dueToday.length, chase, blocked, inbox } };
}

/* ---------- message drafts (templates; the person edits and sends them) ---------- */
export function followUpDraft({ kind = "follow_up", to, subject, expected, lastContact, sender, workspace, tone = "polite", today }) {
  const hi = to ? `Hi ${to.split(/\s+/)[0]},` : "Hi,";
  const exp = expected ? ` (expected ${expected < today ? "by " + fmt(expected) + " — now overdue" : "by " + fmt(expected)})` : "";
  const last = lastContact ? ` following up on our conversation on ${fmt(lastContact)}` : "";
  const sign = sender ? `\n\nThanks,\n${sender}${workspace ? "\n" + workspace : ""}` : "\n\nThanks";
  if (kind === "i_owe") return `${hi}\n\nQuick update on ${subject}: I'm working on it and will come back to you shortly.${sign}`;
  if (tone === "firm") return `${hi}\n\nI'm${last || " following up"} regarding ${subject}${exp}. This is now holding up our work — please confirm today when we can expect it, or let me know what's blocking it.${sign}`;
  return `${hi}\n\nHope you're well. I'm${last || " following up"} regarding ${subject}${exp}. Could you please share an update and a confirmed date?${sign}`;
}
const fmt = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
export const whatsappLink = (phone, text) => `https://wa.me/${String(phone || "").replace(/[^\d]/g, "")}?text=${encodeURIComponent(text)}`;
export const mailtoLink = (email, subject, text) => `mailto:${encodeURIComponent(email || "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
