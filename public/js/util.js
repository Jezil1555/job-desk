// Formatting and time-zone helpers. Pure functions (no DOM), unit-tested in tests/unit.
// Timestamps are stored in UTC; everything is displayed in the user's configured zone (default Asia/Qatar).

export const DEFAULT_TZ = "Asia/Qatar";

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const pad = n => String(n).padStart(2, "0");

const dtfCache = new Map();
function dtf(tz) {
  if (!dtfCache.has(tz)) {
    dtfCache.set(tz, new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  }
  return dtfCache.get(tz);
}

/** Wall-clock parts of an instant in a zone: {y,m,d,hh,mm,ss} (month 1-12). */
export function zonedParts(date, tz = DEFAULT_TZ) {
  const p = {};
  for (const { type, value } of dtf(tz).formatToParts(new Date(date))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute, ss: +p.second };
}

/** Offset (ms) of a zone at an instant: local wall clock minus UTC. */
export function tzOffset(date, tz = DEFAULT_TZ) {
  const z = zonedParts(date, tz);
  const asUTC = Date.UTC(z.y, z.m - 1, z.d, z.hh, z.mm, z.ss);
  return asUTC - Math.floor(new Date(date).getTime() / 1000) * 1000;
}

/** Convert a wall-clock date ("YYYY-MM-DD") + time ("HH:MM") in a zone to an ISO UTC string. */
export function zonedToISO(dateStr, timeStr = "00:00", tz = DEFAULT_TZ) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = (timeStr || "00:00").split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - tzOffset(guess, tz);
  t = guess - tzOffset(t, tz); // second pass handles DST edges
  return new Date(t).toISOString();
}

/** Calendar date ("YYYY-MM-DD") of an instant in a zone. */
export function zonedDate(date, tz = DEFAULT_TZ) {
  const z = zonedParts(date, tz);
  return `${z.y}-${pad(z.m)}-${pad(z.d)}`;
}
export const zonedTime = (date, tz = DEFAULT_TZ) => { const z = zonedParts(date, tz); return `${pad(z.hh)}:${pad(z.mm)}`; };
export const todayISO = (tz = DEFAULT_TZ, now = new Date()) => zonedDate(now, tz);

/** Whole days from today (in zone) to a "YYYY-MM-DD" date. Negative = past. */
export function daysFromToday(dateStr, tz = DEFAULT_TZ, now = new Date()) {
  if (!dateStr) return null;
  const a = Date.UTC(...todayISO(tz, now).split("-").map((v, i) => (i === 1 ? +v - 1 : +v)));
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - a) / 86400000);
}
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
export function weekdayOf(dateStr) { const [y, m, d] = dateStr.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }

export function fmtDate(dateStr, opts = { weekday: "short", day: "numeric", month: "short" }) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
}
export function fmtDateTime(iso, tz = DEFAULT_TZ, withYear = false) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-GB", { timeZone: tz, day: "numeric", month: "short", year: withYear ? "numeric" : undefined, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}
export function relDay(dateStr, tz = DEFAULT_TZ, now = new Date()) {
  const n = daysFromToday(dateStr, tz, now);
  if (n === null) return "";
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  if (n > 1 && n < 7) return fmtDate(dateStr, { weekday: "long" });
  return fmtDate(dateStr, Math.abs(n) > 300 ? { day: "numeric", month: "short", year: "numeric" } : undefined);
}
export function ago(iso, now = Date.now()) {
  const s = (now - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 604800) return Math.floor(s / 86400) + "d ago";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
export const fmtNum = n => Number(n || 0).toLocaleString("en-US");
export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/** Turn a database exception into a sentence a person can act on. */
export function friendlyError(err) {
  const msg = (err && (err.message || err.error_description)) || String(err || "");
  const m = msg.match(/^([a-z_]+):\s*(.+)$/);
  if (m) return m[2].charAt(0).toUpperCase() + m[2].slice(1) + ".";
  if (/violates row-level security|permission denied/i.test(msg)) return "You don't have permission to change this.";
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return "You're offline or the server can't be reached. Nothing was saved.";
  if (/duplicate key/i.test(msg)) return "That already exists.";
  if (/not_registered/.test(msg)) return "That email doesn't have a Jezz HQ account yet.";
  return msg || "Something went wrong. Nothing was saved.";
}
