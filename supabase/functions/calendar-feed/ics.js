// Builds an iCalendar (RFC 5545) document. Plain JS so the same code runs in the edge function and in unit tests.
const esc = s => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const utc = d => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
/** Fold lines longer than 75 octets (UTF-8 safe) with CRLF + space. */
export function fold(line) {
  const enc = new TextEncoder(), out = []; let cur = "", n = 0;
  for (const ch of line) { const b = enc.encode(ch).length; if (n + b > (out.length ? 74 : 75)) { out.push(cur); cur = ""; n = 0; } cur += ch; n += b; }
  out.push(cur); return out.join("\r\n ");
}
/** Local calendar date (YYYYMMDD) of an instant in a time zone — all-day items must land on the person's day, not UTC's. */
export function localDate(at, tz) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "Asia/Qatar", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
  return p.replace(/-/g, "");
}
function nextDay(yyyymmdd) { const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8) + 1)); return d.toISOString().slice(0, 10).replace(/-/g, ""); }
export function buildICS({ events, tz = "Asia/Qatar", appUrl = "https://job-desk-u8nj.onrender.com", now = new Date() }) {
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//JezzHQ//Command Centre//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Jezz HQ", `X-WR-TIMEZONE:${tz}`, "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"];
  for (const e of events || []) {
    L.push("BEGIN:VEVENT", `UID:${e.uid}@job-desk`, `DTSTAMP:${utc(now)}`);
    if (e.all_day) { const d = localDate(e.at, tz); L.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${nextDay(d)}`); }
    else { L.push(`DTSTART:${utc(e.at)}`, `DTEND:${utc(new Date(new Date(e.at).getTime() + 30 * 60000))}`); }
    L.push(`SUMMARY:${esc(e.title)}`);
    const url = appUrl + (e.url || "/");
    L.push(`DESCRIPTION:${esc((e.description ? e.description + "\n" : "") + "Open in Jezz HQ: " + url)}`, `URL:${url}`, "TRANSP:TRANSPARENT", "END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return L.map(fold).join("\r\n") + "\r\n";
}
