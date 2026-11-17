// Investor Portal: one entity per investment. Project cost, investors and capital, monthly sales / P&L,
// returns received per investor, and supporting documents — as one deck per entity.
// Private to the owner; partners can be invited read-only per entity.
import { esc, todayISO, fmtDate, ago } from "../util.js";
import { state } from "../store.js";
import { ICON, emptyState, toast, toastError, openSheet, sheetHead, closeSheet, busy, dialog, rerenderSheet } from "../ui.js";
import { sb, run } from "../api.js";
import { downloadXlsx } from "../xlsx.js";
import { parseDate } from "./simpleio.js";

export const inv = { loaded: false, loading: null, entities: [], members: [], investors: [], returns: [], sales: [], daily: [], docs: [], ui: {} };
const DOC_KIND = { pl: "P/L reports", ledger: "Payment ledgers", contract: "Partner contracts", itr: "ITR filings", other: "Other documents" };
const DOC_ONE = { pl: "P/L report", ledger: "Payment ledger", contract: "Partner contract", itr: "ITR filing", other: "Other" };
let rerenderPage = () => {};

/* ---------------- data ---------------- */
export function loadInv(force = false) {
  if (inv.loading && !force) return inv.loading;
  const seq = (inv.seq = (inv.seq || 0) + 1);
  inv.loading = (async () => {
    const q = await Promise.all([
      sb.from("inv_entities").select("*").order("sort").order("created_at"),
      sb.from("inv_members").select("entity_id, user_id, role"),
      sb.from("inv_investors").select("*").order("sort").order("created_at"),
      sb.from("inv_returns").select("*").order("paid_on", { ascending: false }).limit(10000),
      sb.from("inv_sales").select("*").order("month").limit(10000),
      sb.from("inv_documents").select("*").order("created_at", { ascending: false }).limit(2000),
      sb.from("inv_daily_sales").select("id, entity_id, day, amount").order("day").limit(50000)
    ]);
    if (seq !== inv.seq) return; // a newer load started; drop these older results
    const err = q.find(r => r.error);
    if (err) { inv.error = err.error.message; inv.loading = null; rerenderPage(); return; }
    [inv.entities, inv.members, inv.investors, inv.returns, inv.sales, inv.docs, inv.daily] = q.map(r => r.data || []);
    // linked entities (e.g. a sub-investor group) read the outlet's sales from their main entity
    const linked = inv.entities.filter(e => e.sales_from);
    const ls = await Promise.all(linked.map(e => sb.rpc("inv_linked_sales", { p_entity: e.id })));
    if (seq !== inv.seq) return;
    linked.forEach((e, i) => {
      const d = ls[i].data; if (!d) return;
      e._source = d.source_name;
      inv.sales = inv.sales.filter(x => x.entity_id !== e.id).concat((d.sales || []).map(x => ({ ...x, entity_id: e.id, _linked: true })));
      inv.daily = inv.daily.filter(x => x.entity_id !== e.id).concat((d.daily || []).map(x => ({ ...x, entity_id: e.id })));
    });
    inv.loaded = true; inv.error = null; inv.loading = null; rerenderPage();
  })();
  return inv.loading;
}
const entity = id => inv.entities.find(e => e.id === id);
const isOwner = id => inv.members.some(m => m.entity_id === id && m.user_id === state.user.id && m.role === "owner");
const investorsOf = id => inv.investors.filter(x => x.entity_id === id);
const returnsOf = id => inv.returns.filter(x => x.entity_id === id);
const salesOf = id => inv.sales.filter(x => x.entity_id === id).sort((a, b) => a.month.localeCompare(b.month));
const docsOf = id => inv.docs.filter(x => x.entity_id === id);
const daysOf = (id, month) => inv.daily.filter(x => x.entity_id === id && (!month || x.day.slice(0, 7) === month.slice(0, 7)));
const sum = (a, f) => a.reduce((t, x) => t + (Number(f(x)) || 0), 0);

/* ---------------- money ---------------- */
const SYM = { INR: "₹", QAR: "QAR ", USD: "$", AED: "AED ", SAR: "SAR ", BHD: "BHD ", EUR: "€", GBP: "£" };
const trim0 = s => s.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
/** Short form for tiles and charts: ₹1.05 Cr, ₹35 L, ₹42,500. */
export function money(n, cur = "INR") {
  const v = Number(n) || 0, a = Math.abs(v), s = v < 0 ? "−" : "", sym = SYM[cur] ?? cur + " ";
  if (cur === "INR") {
    if (a >= 1e7) return `${s}${sym}${trim0((a / 1e7).toFixed(2))} Cr`;
    if (a >= 1e5) return `${s}${sym}${trim0((a / 1e5).toFixed(2))} L`;
    return `${s}${sym}${Math.round(a).toLocaleString("en-IN")}`;
  }
  if (a >= 1e6) return `${s}${sym}${trim0((a / 1e6).toFixed(2))}M`;
  if (a >= 1e4) return `${s}${sym}${trim0((a / 1e3).toFixed(1))}K`;
  return `${s}${sym}${Math.round(a).toLocaleString("en-US")}`;
}
/** Exact form for tables: ₹1,05,00,000. */
export const moneyFull = (n, cur = "INR") => { const v = Number(n) || 0; const sym = SYM[cur] ?? cur + " "; return (v < 0 ? "−" : "") + sym + Math.abs(v).toLocaleString(cur === "INR" ? "en-IN" : "en-US", { maximumFractionDigits: 2 }); };
const pct = (a, b) => b > 0 ? Math.round(a / b * 1000) / 10 : 0;
const monthLabel = (m, long = false) => m ? fmtDate(m, long ? { month: "long", year: "numeric" } : { month: "short", year: "2-digit" }) : "";
const dmy = iso => iso ? fmtDate(iso, { day: "numeric", month: "short", year: "numeric" }) : "";

/** Lakh/crore aware amount parser: "35 L", "35 lakhs", "1.05 cr", "3,500,000". */
export function parseAmount(v) {
  if (typeof v === "number") return v;
  const s = String(v || "").trim().toLowerCase().replace(/[₹,\s]|inr|rs\.?/g, "");
  if (!s) return null;
  const m = s.match(/^(-?\d+(?:\.\d+)?)(cr|crore|crores|l|lac|lacs|lakh|lakhs|k)?$/);
  if (!m) return undefined;
  const n = parseFloat(m[1]), u = m[2] || "";
  return Math.round(n * (u.startsWith("c") ? 1e7 : u.startsWith("l") ? 1e5 : u === "k" ? 1e3 : 1) * 100) / 100;
}

/* ---------------- figures ---------------- */
function figures(id) {
  const e = entity(id), ins = investorsOf(id), rs = returnsOf(id), ss = salesOf(id);
  const invested = sum(ins, x => x.amount), received = sum(rs, x => x.amount);
  const per = ins.map(x => {
    const got = sum(rs.filter(r => r.investor_id === x.id), r => r.amount);
    const cap = Number(x.amount) > 0;
    return { x, got, cap, equity: x.equity_pct === null || x.equity_pct === undefined ? null : Number(x.equity_pct), share: pct(x.amount, Number(e.project_cost) || invested), recovered: cap ? pct(got, Number(x.amount)) : null, pending: Math.max(0, Number(x.amount) - got) };
  });
  const salesTotal = sum(ss, x => x.sales), profitTotal = sum(ss.filter(x => x.net_profit != null), x => x.net_profit);
  const last = ss[ss.length - 1] || null, last6 = ss.slice(-6);
  const eqs = per.filter(p => p.equity !== null), equityTotal = Math.round(sum(eqs, p => p.equity) * 1000) / 1000;
  return { e, ins, rs, ss, invested, hasEquity: eqs.length > 0, equityTotal, capitalCount: per.filter(p => p.cap).length, received, pending: sum(per.filter(p => p.cap), p => p.pending), recovered: pct(sum(per.filter(p => p.cap), p => p.got), invested), per, salesTotal, profitTotal, last, avg6: last6.length ? sum(last6, x => x.sales) / last6.length : 0, me: per.find(p => p.x.is_me) };
}

/* ---------------- chart (single series bars, hover tooltip) ---------------- */
function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }
function barChart(points, { cur, color = "var(--accent)", negColor = "var(--high)", height = 200, empty = "No data yet.", slot = 44 } = {}) {
  if (!points.length) return `<div class="iv-chart-empty">${esc(empty)}</div>`;
  const W = Math.max(560, points.length * slot + 70), H = height, padL = 56, padR = 8, padT = 12, padB = 26;
  const maxV = niceMax(Math.max(0, ...points.map(p => p.value))), minV = Math.min(0, ...points.map(p => p.value)) < 0 ? -niceMax(-Math.min(...points.map(p => p.value))) : 0;
  const y = v => padT + (maxV - v) / (maxV - minV) * (H - padT - padB);
  const band = (W - padL - padR) / points.length, bw = Math.min(24, band - 6);
  const ticks = [minV, minV < 0 ? 0 : null, maxV / 2, maxV].filter((v, i, a) => v !== null && a.indexOf(v) === i);
  const step = Math.ceil(points.length / 12);
  const bars = points.map((p, i) => {
    const cx = padL + band * i + band / 2, x0 = cx - bw / 2, top = y(Math.max(0, p.value)), bot = y(Math.min(0, p.value)), h = Math.max(0, bot - top);
    const r = Math.min(4, h, bw / 2), pos = p.value >= 0;
    const path = h < 0.5 ? "" : pos
      ? `M${x0},${bot} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + bw - r} Q${x0 + bw},${top} ${x0 + bw},${top + r} V${bot} Z`
      : `M${x0},${top} V${bot - r} Q${x0},${bot} ${x0 + r},${bot} H${x0 + bw - r} Q${x0 + bw},${bot} ${x0 + bw},${bot - r} V${top} Z`;
    return `<g class="iv-bar" data-tip="${esc(p.tip || `${p.label}: ${moneyFull(p.value, cur)}`)}"><rect x="${padL + band * i}" y="${padT}" width="${band}" height="${H - padT - padB}" fill="transparent"/>${path ? `<path d="${path}" fill="${pos ? color : negColor}"/>` : ""}
      ${i % step === 0 || i === points.length - 1 ? `<text x="${cx}" y="${H - 8}" text-anchor="middle" class="iv-ax">${esc(p.label)}</text>` : ""}</g>`;
  }).join("");
  return `<div class="iv-chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="min-width:${Math.round(W * 0.68)}px" role="img" aria-label="Bar chart">
    ${ticks.map(v => `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="iv-grid${v === 0 ? " zero" : ""}"/><text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end" class="iv-ax">${esc(money(v, cur))}</text>`).join("")}
    ${bars}</svg></div>`;
}
let tipEl = null;
document.addEventListener("pointermove", e => {
  const g = e.target.closest && e.target.closest(".iv-bar");
  if (!g) { if (tipEl) tipEl.hidden = true; return; }
  if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "iv-tip"; document.body.appendChild(tipEl); }
  tipEl.textContent = g.dataset.tip; tipEl.hidden = false;
  const x = Math.min(window.innerWidth - tipEl.offsetWidth - 8, e.clientX + 12), yy = Math.max(8, e.clientY - tipEl.offsetHeight - 10);
  tipEl.style.left = x + "px"; tipEl.style.top = yy + "px";
});

/* ---------------- pages ---------------- */
export function renderInvestors(view, id, tab, rerender) {
  rerenderPage = rerender;
  if (!inv.loaded) {
    if (inv.error) { view.innerHTML = `<div class="banner bad">Couldn't load the Investor Portal: ${esc(inv.error)} <button class="linkbtn" data-act="inv-reload">Try again</button></div>`; return; }
    view.innerHTML = `<div class="loading"><div class="spinner"></div>Loading investor portal…</div>`; loadInv(); return;
  }
  if (!id) return renderList(view);
  const e = entity(id);
  if (!e) { view.innerHTML = emptyState("Entity not found", "It may have been deleted, or it isn't shared with you.", `<a class="btn" href="#/investors">All entities</a>`); return; }
  const owner = isOwner(id), f = figures(id);
  const tabs = { overview: "Overview", sales: "Sales", returns: "Returns", documents: `Documents · ${docsOf(id).length}`, settings: owner ? "Settings" : "Details" };
  const t = tabs[tab] ? tab : "overview";
  const body = t === "sales" ? salesTab(f, owner) : t === "returns" ? returnsTab(f, owner) : t === "documents" ? docsTab(f, owner) : t === "settings" ? settingsTab(f, owner) : overviewTab(f, owner);
  view.innerHTML = `<div class="sw iv">
    <div class="sw-head"><div><p class="crumb"><a href="#/investors">Investor Portal</a></p><h1>${esc(e.name)}</h1>
      <p class="sub">${e.description ? esc(e.description) + " · " : ""}${e.currency}${e.start_date ? ` · since ${dmy(e.start_date)}` : ""}${owner ? "" : " · shared with you (view only)"}</p></div>
      <div class="sw-actions"><button class="btn" data-act="inv-export" data-id="${id}">${ICON.download}Download Excel</button>${owner ? `<button class="btn" data-act="inv-tab" data-id="${id}" data-tab="settings">${ICON.people}Share</button>` : ""}</div></div>
    <div class="viewtabs">${Object.entries(tabs).map(([k, v]) => `<a href="#/investors/${id}/${k}" class="${k === t ? "on" : ""}">${v}</a>`).join("")}</div>
    ${body}
  </div>`;
}

function renderList(view) {
  const list = inv.entities.filter(e => !e.archived);
  view.innerHTML = `<div class="sw">
    <div class="sw-head"><div><h1>Investor Portal</h1><p class="sub">Every investment in one place: capital, sales, returns and documents.</p></div>
      <div class="sw-actions"><button class="btn primary" data-act="inv-new">${ICON.plus}New entity</button></div></div>
    ${list.length ? `<div class="iv-grid">${list.map(e => {
      const f = figures(e.id);
      return `<a class="iv-card" href="#/investors/${e.id}">
        <div class="iv-card-h"><h3>${esc(e.name)}</h3>${isOwner(e.id) ? "" : `<span class="chip">Shared</span>`}</div>
        <div class="iv-card-n"><span><small>Project cost</small><b>${money(e.project_cost || f.invested, e.currency)}</b></span><span><small>Returns received</small><b>${money(f.received, e.currency)}</b></span><span><small>Sales to date</small><b>${money(f.salesTotal, e.currency)}</b></span></div>
        <div class="iv-rec"><span class="sw-bar"><i style="width:${Math.min(100, f.recovered)}%"></i></span><small>${f.recovered}% of capital recovered · ${money(f.pending, e.currency)} pending</small></div>
      </a>`;
    }).join("")}</div>` : `<div class="sw-empty iv-empty"><b>No entities yet</b><span>Add an investment, e.g. The Burgery In - Kakkanad, with its project cost and investors.</span><button class="btn primary" data-act="inv-new">${ICON.plus}New entity</button></div>`}
  </div>`;
}

function tile(label, value, sub = "", cls = "") { return `<div class="sw-kpi iv-kpi ${cls}"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ""}</div>`; }

function overviewTab(f, owner) {
  const { e } = f, cur = e.currency, cost = Number(e.project_cost) || 0;
  const unalloc = cost && Math.abs(cost - f.invested) >= 1 ? `${money(Math.abs(cost - f.invested), cur)} ${cost > f.invested ? "not yet assigned to an investor" : "more than project cost"}` : "";
  const last12 = f.ss.slice(-12);
  const byMonth = {};
  f.rs.forEach(r => { const m = (r.period || r.paid_on).slice(0, 7) + "-01"; byMonth[m] = (byMonth[m] || 0) + Number(r.amount); });
  const rMonths = Object.keys(byMonth).sort().slice(-12);
  return `
    <div class="sw-kpis iv-kpis">
      ${tile("Total project cost", money(cost || f.invested, cur), unalloc)}
      ${tile("Total invested", money(f.invested, cur), `by ${f.capitalCount} investor${f.capitalCount === 1 ? "" : "s"}`)}
      ${tile("Returns received", money(f.received, cur), `${f.recovered}% of capital back`, "ok")}
      ${tile("Pending to recover", money(f.pending, cur), "capital not yet returned", f.pending ? "warn" : "")}
      ${tile("Sales to date", money(f.salesTotal, cur), f.ss.length ? `${f.ss.length} month${f.ss.length === 1 ? "" : "s"}` : "no months added")}
      ${tile("Avg monthly sales", money(f.avg6, cur), "last 6 months")}
    </div>
    ${f.me ? `<section class="iv-me"><div><small>My position</small><b>${esc(f.me.x.name)}</b></div>
      <div><small>Invested</small><b>${money(f.me.x.amount, cur)}</b></div>${f.me.equity !== null ? `<div><small>Equity</small><b>${f.me.equity}%</b></div>` : ""}<div><small>Capital share</small><b>${f.me.share}%</b></div>
      <div><small>Received</small><b>${money(f.me.got, cur)}</b></div><div><small>Pending</small><b>${money(f.me.pending, cur)}</b></div>
      <div class="iv-me-bar"><span class="sw-bar"><i style="width:${Math.min(100, f.me.recovered)}%"></i></span><small>${f.me.recovered}% recovered</small></div></section>` : ""}
    <section class="sw-sect"><div class="sw-sect-h"><h2>Partners & investors</h2>${owner ? `<button class="btn sm" data-act="inv-investor" data-entity="${e.id}">${ICON.plus}Add partner</button>` : ""}</div>
      ${f.hasEquity ? `<p class="hint">Capital share = part of the money put in. Equity = ownership of the business${f.equityTotal !== 100 ? ` — <span class="warn-text">equity adds up to ${f.equityTotal}%, not 100%</span>` : ""}.</p>` : ""}
      ${f.ins.length ? `<div class="iv-table-wrap"><table class="iv-table"><thead><tr><th>Partner</th><th class="r">Capital</th><th class="r">Capital share</th>${f.hasEquity ? `<th class="r">Equity</th>` : ""}<th class="r">Returns received</th><th>Recovered</th><th class="r">Pending</th></tr></thead><tbody>
        ${f.per.map(p => `<tr ${owner ? `data-act="inv-investor" data-id="${p.x.id}" data-entity="${e.id}" class="click"` : ""}><td><b>${esc(p.x.name)}</b>${p.x.is_me ? ` <span class="chip">Me</span>` : ""}${p.x.invested_on ? `<small class="faint"> · ${dmy(p.x.invested_on)}</small>` : ""}</td>
          <td class="r num">${p.cap ? moneyFull(p.x.amount, cur) : `<span class="faint">No capital</span>`}</td><td class="r num">${p.cap ? p.share + "%" : "—"}</td>${f.hasEquity ? `<td class="r num"><b>${p.equity === null ? "—" : p.equity + "%"}</b></td>` : ""}<td class="r num">${moneyFull(p.got, cur)}</td>
          <td>${p.cap ? `<span class="sw-bar"><i style="width:${Math.min(100, p.recovered)}%"></i></span> <small class="num">${p.recovered}%</small>` : `<span class="faint">—</span>`}</td><td class="r num">${p.cap ? moneyFull(p.pending, cur) : "—"}</td></tr>`).join("")}
        <tr class="tot"><td>Total</td><td class="r num">${moneyFull(f.invested, cur)}</td><td class="r num">${pct(f.invested, cost || f.invested)}%</td>${f.hasEquity ? `<td class="r num ${f.equityTotal !== 100 ? "warn-text" : ""}" title="${f.equityTotal !== 100 ? "Equity doesn't add up to 100%" : ""}">${f.equityTotal}%</td>` : ""}<td class="r num">${moneyFull(f.received, cur)}</td><td><small class="num">${f.recovered}%</small></td><td class="r num">${moneyFull(f.pending, cur)}</td></tr>
      </tbody></table></div>` : `<div class="sw-empty">No investors yet.${owner ? ` Add each investor with the amount they put in, e.g. Jezil ₹35 L.` : ""}</div>`}
    </section>
    <div class="iv-two">
      <section class="sw-sect"><div class="sw-sect-h"><h2>Monthly sales</h2><a class="linkbtn" href="#/investors/${e.id}/sales">All sales</a></div>
        <div class="iv-panel">${barChart(last12.map(s => ({ label: monthLabel(s.month), value: Number(s.sales), tip: `${monthLabel(s.month, true)} · Sales ${moneyFull(s.sales, cur)}` })), { cur, empty: "Add monthly sales to see the trend." })}</div></section>
      <section class="sw-sect"><div class="sw-sect-h"><h2>Returns received per month</h2><a class="linkbtn" href="#/investors/${e.id}/returns">All returns</a></div>
        <div class="iv-panel">${barChart(rMonths.map(m => ({ label: monthLabel(m), value: byMonth[m], tip: `${monthLabel(m, true)} · Returns ${moneyFull(byMonth[m], cur)}` })), { cur, color: "var(--ok)", empty: "Returns appear here once recorded." })}</div></section>
    </div>
    <section class="sw-sect"><div class="sw-sect-h"><h2>Latest documents</h2><a class="linkbtn" href="#/investors/${e.id}/documents">All documents</a></div>
      ${docsOf(e.id).length ? `<div class="iv-docs">${docsOf(e.id).slice(0, 5).map(docRow).join("")}</div>` : `<p class="hint">P/L reports, payment ledgers, partner contracts and ITR filings appear here.</p>`}</section>`;
}

/* --- sales --- */
function salesRange(ss, r) {
  if (!ss.length || r === "all") return ss;
  const lastM = ss[ss.length - 1].month, [ly, lm] = lastM.split("-").map(Number);
  if (/^\d{4}$/.test(r)) return ss.filter(s => s.month.startsWith(r));
  const n = r === "6m" ? 6 : 12;
  const from = new Date(Date.UTC(ly, lm - 1 - (n - 1), 1)).toISOString().slice(0, 10);
  return ss.filter(s => s.month >= from);
}
function salesTab(f, owner) {
  const { e } = f, cur = e.currency, r = inv.ui.salesRange || "12m";
  const years = [...new Set(f.ss.map(s => s.month.slice(0, 4)))].sort().reverse();
  const ss = salesRange(f.ss, r);
  const tSales = sum(ss, x => x.sales), tExp = sum(ss.filter(x => x.expenses != null), x => x.expenses), tProfit = sum(ss.filter(x => x.net_profit != null), x => x.net_profit);
  const best = ss.reduce((b, s) => !b || Number(s.sales) > Number(b.sales) ? s : b, null);
  return `<div class="iv-filters"><label class="field-inline">Show <select class="input sm" id="inv-sales-range">
      ${[["6m", "Last 6 months"], ["12m", "Last 12 months"], ["all", "All time"], ...years.map(y => [y, y])].map(([k, v]) => `<option value="${k}" ${k === r ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      ${e.sales_from ? `<span class="iv-fbtns hint">Sales and P&L come from <b>${esc(e._source || "the main entity")}</b>${owner ? " — update them there" : ""}.</span>` : owner ? `<span class="iv-fbtns"><button class="btn sm primary" data-act="inv-sale" data-entity="${e.id}">${ICON.plus}Add month</button><button class="btn sm" data-act="inv-sales-import" data-entity="${e.id}">${ICON.download}Upload Excel</button></span>` : ""}</div>
    <div class="sw-kpis iv-kpis">${tile("Sales", money(tSales, cur), `${ss.length} month${ss.length === 1 ? "" : "s"}`)}${tile("Expenses", money(tExp, cur))}${tile("Net profit", money(tProfit, cur), tSales ? `${pct(tProfit, tSales)}% margin` : "", tProfit < 0 ? "bad" : "ok")}${tile("Best month", best ? money(best.sales, cur) : "—", best ? monthLabel(best.month, true) : "")}</div>
    <div class="iv-two">
      <section class="sw-sect"><h2>Sales trend</h2><div class="iv-panel">${barChart(ss.map(s => ({ label: monthLabel(s.month), value: Number(s.sales), tip: `${monthLabel(s.month, true)} · Sales ${moneyFull(s.sales, cur)}` })), { cur, empty: "No sales in this range." })}</div></section>
      <section class="sw-sect"><h2>Net profit trend</h2><div class="iv-panel">${barChart(ss.filter(s => s.net_profit != null).map(s => ({ label: monthLabel(s.month), value: Number(s.net_profit), tip: `${monthLabel(s.month, true)} · Net profit ${moneyFull(s.net_profit, cur)}` })), { cur, color: "var(--info)", empty: "Add net profit to see the trend." })}</div></section>
    </div>
    <section class="sw-sect"><h2>Month by month</h2><p class="hint">Tap a month to see each day's sales.</p>
    ${ss.length ? `<div class="iv-table-wrap"><table class="iv-table"><thead><tr><th>Month</th><th class="r">Sales</th><th class="r">Expenses</th><th class="r">Net profit</th><th class="r">Margin</th><th>Note</th></tr></thead><tbody>
      ${ss.slice().reverse().map(s => { const nd = daysOf(e.id, s.month).length; return `<tr class="click" data-act="inv-month" data-entity="${e.id}" data-month="${s.month}" title="See day by day"><td>${monthLabel(s.month, true)} <small class="faint">${nd ? `· ${nd} days ›` : "›"}</small></td><td class="r num">${moneyFull(s.sales, cur)}</td><td class="r num">${s.expenses == null ? "—" : moneyFull(s.expenses, cur)}</td>
        <td class="r num ${Number(s.net_profit) < 0 ? "bad-text" : ""}">${s.net_profit == null ? "—" : moneyFull(s.net_profit, cur)}</td><td class="r num">${s.net_profit == null || !Number(s.sales) ? "—" : pct(s.net_profit, s.sales) + "%"}</td><td class="small">${esc(s.note || "")}</td></tr>`; }).join("")}
      <tr class="tot"><td>Total</td><td class="r num">${moneyFull(tSales, cur)}</td><td class="r num">${moneyFull(tExp, cur)}</td><td class="r num">${moneyFull(tProfit, cur)}</td><td class="r num">${tSales ? pct(tProfit, tSales) + "%" : "—"}</td><td></td></tr>
    </tbody></table></div>` : `<div class="sw-empty">No sales figures yet.${owner ? " Add a month, or upload an Excel of past months." : ""}</div>`}</section>`;
}

/* --- returns --- */
function returnsTab(f, owner) {
  const { e } = f, cur = e.currency, who = inv.ui.retWho || "", yr = inv.ui.retYear || "";
  const years = [...new Set(f.rs.map(r => r.paid_on.slice(0, 4)))].sort().reverse();
  const rs = f.rs.filter(r => (!who || r.investor_id === who) && (!yr || r.paid_on.startsWith(yr)));
  const name = id => (f.ins.find(x => x.id === id) || {}).name || "—";
  return `<div class="iv-filters">
      <label class="field-inline">Investor <select class="input sm" id="inv-ret-who"><option value="">All investors</option>${f.ins.map(x => `<option value="${x.id}" ${x.id === who ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
      <label class="field-inline">Year <select class="input sm" id="inv-ret-year"><option value="">All years</option>${years.map(y => `<option ${y === yr ? "selected" : ""}>${y}</option>`).join("")}</select></label>
      ${owner && f.ins.length ? `<span class="iv-fbtns"><button class="btn sm primary" data-act="inv-return" data-entity="${e.id}">${ICON.plus}Record returns</button><button class="btn sm" data-act="inv-doc-new" data-entity="${e.id}" data-kind="ledger">${ICON.download}Add payment ledger</button></span>` : ""}</div>
    <div class="iv-per">${f.per.map(p => `<div class="iv-per-c ${who === p.x.id ? "on" : ""}"><b>${esc(p.x.name)}${p.equity !== null ? ` <small class="faint">· ${p.equity}% equity</small>` : ""}</b>${p.cap ? `<span>${money(p.got, cur)} <small>of ${money(p.x.amount, cur)}</small></span><span class="sw-bar"><i style="width:${Math.min(100, p.recovered)}%"></i></span><small>${p.recovered}% recovered · ${money(p.pending, cur)} pending</small>` : `<span>${money(p.got, cur)} <small>received</small></span><small>No capital invested</small>`}</div>`).join("")}</div>
    <section class="sw-sect"><h2>Payments received <span class="c">${rs.length}</span></h2>
    ${rs.length ? `<div class="iv-table-wrap"><table class="iv-table"><thead><tr><th>Paid on</th><th>For month</th><th>Investor</th><th class="r">Amount</th><th>Note</th>${owner ? "<th></th>" : ""}</tr></thead><tbody>
      ${rs.map(r => `<tr><td>${dmy(r.paid_on)}</td><td>${r.period ? monthLabel(r.period, true) : "—"}</td><td>${esc(name(r.investor_id))}</td><td class="r num">${moneyFull(r.amount, cur)}</td><td class="small">${esc(r.note || "")}</td>${owner ? `<td class="r"><button class="iconbtn sm sw-del" data-act="inv-return-del" data-id="${r.id}" aria-label="Delete payment">${ICON.trash}</button></td>` : ""}</tr>`).join("")}
      <tr class="tot"><td colspan="3">Total</td><td class="r num">${moneyFull(sum(rs, r => r.amount), cur)}</td><td colspan="${owner ? 2 : 1}"></td></tr>
    </tbody></table></div>` : `<div class="sw-empty">${f.ins.length ? "No returns recorded yet." : "Add investors first (Settings), then record returns."}</div>`}</section>
    ${docsOf(e.id).some(d => d.kind === "ledger") ? `<section class="sw-sect"><h2>Payment ledgers</h2><div class="iv-docs">${docsOf(e.id).filter(d => d.kind === "ledger").map(docRow).join("")}</div></section>` : ""}`;
}

/* --- documents --- */
function docRow(d) {
  const own = isOwner(d.entity_id);
  return `<div class="iv-doc"><span class="kico">${ICON.notes}</span><div class="tmain"><button class="linkbtn iv-doc-t" data-act="inv-doc-open" data-id="${d.id}">${esc(d.title)}</button><small class="faint">${DOC_ONE[d.kind]}${d.period ? " · " + monthLabel(d.period, true) : ""} · added ${ago(d.created_at)}${d.size_bytes ? ` · ${Math.max(1, Math.round(d.size_bytes / 1024))} KB` : ""}</small></div>
    ${own ? `<button class="iconbtn sm sw-del" data-act="inv-doc-del" data-id="${d.id}" aria-label="Delete document">${ICON.trash}</button>` : ""}</div>`;
}
function docsTab(f, owner) {
  const ds = docsOf(f.e.id);
  return `${owner ? `<div class="iv-filters"><span class="iv-fbtns"><button class="btn sm primary" data-act="inv-doc-new" data-entity="${f.e.id}">${ICON.plus}Upload document</button></span></div>` : ""}
    ${Object.entries(DOC_KIND).map(([k, label]) => { const xs = ds.filter(d => d.kind === k); return `<section class="sw-sect"><div class="sw-sect-h"><h2>${label} <span class="c">${xs.length}</span></h2>${owner ? `<button class="linkbtn" data-act="inv-doc-new" data-entity="${f.e.id}" data-kind="${k}">+ Add</button>` : ""}</div>
      ${xs.length ? `<div class="iv-docs">${xs.map(docRow).join("")}</div>` : `<p class="hint">None yet.</p>`}</section>`; }).join("")}`;
}

/* --- settings --- */
function settingsTab(f, owner) {
  const { e } = f, cur = e.currency;
  if (!owner) return `<section class="sw-sect"><h2>Details</h2><p>Project cost: <b>${moneyFull(e.project_cost || 0, cur)}</b></p><p class="hint">You have view-only access. The owner keeps the figures up to date.</p></section>`;
  const mem = inv.ui.memberList && inv.ui.memberList.id === e.id ? inv.ui.memberList.rows : null, pend = mem ? inv.ui.memberList.pending : [];
  if (!mem) loadMembers(e.id);
  return `<div class="iv-two">
    <section class="sw-sect iv-panel"><h2>Entity</h2>
      <form class="iv-form" id="inv-entity-form" data-id="${e.id}">
        <label class="field"><span>Name</span><input class="input" name="name" value="${esc(e.name)}" maxlength="120" required></label>
        <label class="field"><span>Description (optional)</span><input class="input" name="description" value="${esc(e.description || "")}" maxlength="2000"></label>
        <div class="grid2"><label class="field"><span>Total project cost</span><input class="input" name="cost" value="${e.project_cost ?? ""}" inputmode="decimal" placeholder="e.g. 1.05 Cr or 10500000"></label>
        <label class="field"><span>Currency</span><select class="input" name="currency">${["INR", "QAR", "BHD", "AED", "SAR", "USD", "EUR", "GBP"].map(c => `<option ${c === cur ? "selected" : ""}>${c}</option>`).join("")}</select></label></div>
        <label class="field"><span>Start date (optional)</span><input class="input" type="date" name="start" value="${e.start_date || ""}"></label>
        <button class="btn primary">Save</button>
      </form></section>
    <section class="sw-sect iv-panel"><div class="sw-sect-h"><h2>Partners & investors</h2><button class="btn sm" data-act="inv-investor" data-entity="${e.id}">${ICON.plus}Add</button></div>
      ${f.ins.length ? `<div class="iv-docs">${f.per.map(p => `<div class="iv-doc click" data-act="inv-investor" data-id="${p.x.id}" data-entity="${e.id}" role="button" tabindex="0"><div class="tmain"><b>${esc(p.x.name)}</b>${p.x.is_me ? ` <span class="chip">Me</span>` : ""}<small class="faint">${p.cap ? `${moneyFull(p.x.amount, cur)} · ${p.share}% of capital` : "No capital"}${p.equity !== null ? ` · ${p.equity}% equity` : ""}</small></div><span class="faint">Edit</span></div>`).join("")}</div>` : `<p class="hint">No investors yet.</p>`}
      <h2 class="iv-h2">Shared with</h2>
      <p class="hint">People you add here can see this entity only — read-only. They can't see your other entities, workspaces or Finance. If they haven't signed up yet, they get access as soon as they do.</p>
      ${mem ? `<div class="iv-docs">${mem.map(m => `<div class="iv-doc"><div class="tmain"><b>${esc(m.display_name || m.email)}</b><small class="faint">${esc(m.email)} · ${m.role === "owner" ? "Owner" : "View only"}</small></div>${m.role === "viewer" ? `<button class="btn sm danger" data-act="inv-unshare" data-entity="${e.id}" data-user="${m.user_id}">Remove</button>` : ""}</div>`).join("")}
        ${pend.map(p => `<div class="iv-doc"><div class="tmain"><b>${esc(p.email)}</b><small class="faint">Invited · gets view-only access when they sign up</small></div><button class="btn sm danger" data-act="inv-uninvite" data-entity="${e.id}" data-email="${esc(p.email)}">Cancel</button></div>`).join("")}</div>` : `<p class="hint">Loading…</p>`}
      <form class="iv-share" id="inv-share-form" data-id="${e.id}"><input class="input" type="email" name="email" placeholder="partner@email.com" required autocomplete="off"><button class="btn">Share</button></form>
    </section></div>
    <section class="sw-sect iv-danger"><h2>Delete entity</h2><p class="hint">Deletes this entity with all its investors, sales, returns and documents, for everyone it's shared with.</p><button class="btn danger" data-act="inv-delete" data-id="${e.id}">${ICON.trash}Delete entity</button></section>`;
}
async function loadMembers(id) {
  const [r, p] = await Promise.all([run(sb.rpc("inv_member_list", { p_entity: id })), run(sb.from("inv_pending_invites").select("email, created_at").eq("entity_id", id))]);
  inv.ui.memberList = { id, rows: r.data || [], pending: p.data || [] }; rerenderPage();
}

/* ---------------- sheets (forms) ---------------- */
function newEntity() {
  openSheet(sh => {
    sh.innerHTML = sheetHead("New entity", "An investment you want to track, e.g. a restaurant outlet.") + `<form class="sh-body" id="invNew">
      <label class="field"><span>Name</span><input class="input" name="name" maxlength="120" required autofocus placeholder="e.g. The Burgery In - Kakkanad"></label>
      <div class="grid2"><label class="field"><span>Total project cost</span><input class="input" name="cost" inputmode="decimal" placeholder="e.g. 1.05 Cr"></label>
      <label class="field"><span>Currency</span><select class="input" name="currency">${["INR", "QAR", "BHD", "AED", "SAR", "USD"].map(c => `<option>${c}</option>`).join("")}</select></label></div>
      <label class="field"><span>Investors <small>(one per line: name and amount, e.g. "Jezil 35 L")</small></span><textarea class="input" name="investors" rows="4" placeholder="Steeja 35 L&#10;Jezil 35 L&#10;Nihan 35 L"></textarea></label>
      <label class="field"><span>Which one is you? (optional)</span><input class="input" name="me" placeholder="e.g. Jezil"></label>
      <p class="dlg-err" id="invNewErr" hidden></p>
      <div class="sheet-foot"><button class="btn primary block">Create</button></div></form>`;
    sh.querySelector("#invNew").onsubmit = async ev => {
      ev.preventDefault(); ev.stopPropagation();
      const fm = ev.target, err = sh.querySelector("#invNewErr"), b = fm.querySelector(".primary");
      const cost = parseAmount(fm.cost.value);
      if (cost === undefined) { err.textContent = "Project cost isn't a number. Try 1.05 Cr, 105 L or 10500000."; err.hidden = false; return; }
      const lines = fm.investors.value.split("\n").map(s => s.trim()).filter(Boolean), rows = [];
      for (const l of lines) {
        const m = l.match(/^(.*?)[\s:–-]+([₹\d.,]+\s*(?:cr|crore|crores|l|lac|lacs|lakh|lakhs|k)?)$/i);
        const amt = m && parseAmount(m[2]);
        if (!m || amt === undefined || amt === null) { err.textContent = `Couldn't read "${l}". Write a name then an amount, e.g. "Jezil 35 L".`; err.hidden = false; return; }
        rows.push({ name: m[1].trim(), amount: amt });
      }
      busy(b, true, "Creating…");
      const r = await run(sb.from("inv_entities").insert({ name: fm.name.value.trim(), project_cost: cost, currency: fm.currency.value, owner_id: state.user.id, sort: inv.entities.length }).select().single());
      if (r.error) { busy(b, false); return toastError(r.error); }
      if (rows.length) {
        const me = fm.me.value.trim().toLowerCase();
        const ri = await run(sb.from("inv_investors").insert(rows.map((x, i) => ({ entity_id: r.data.id, name: x.name, amount: x.amount, is_me: !!me && x.name.toLowerCase() === me, sort: i }))));
        if (ri.error) toastError("Entity created, but investors couldn't be added: " + ri.error);
      }
      await loadInv(true); busy(b, false); closeSheet(); location.hash = "#/investors/" + r.data.id;
    };
  });
}
function investorForm(entityId, id) {
  const x = id ? inv.investors.find(i => i.id === id) : null, e = entity(entityId);
  openSheet(sh => {
    sh.innerHTML = sheetHead(x ? "Edit investor" : "Add investor", esc(e.name)) + `<form class="sh-body" id="invInv">
      <label class="field"><span>Name</span><input class="input" name="name" value="${esc(x ? x.name : "")}" maxlength="120" required autofocus></label>
      <div class="grid3"><label class="field"><span>Capital invested (${e.currency})</span><input class="input" name="amount" value="${x ? x.amount : ""}" inputmode="decimal" placeholder="e.g. 35 L, or 0"></label>
      <label class="field"><span>Equity % (optional)</span><input class="input" name="equity" value="${x && x.equity_pct !== null && x.equity_pct !== undefined ? Number(x.equity_pct) : ""}" inputmode="decimal" placeholder="e.g. 24"></label>
      <label class="field"><span>Invested on (optional)</span><input class="input" type="date" name="on" value="${x && x.invested_on || ""}"></label></div>
      <p class="hint">Equity is the ownership share. It can differ from capital, e.g. an operating partner with equity but no capital.</p>
      <label class="check"><input type="checkbox" name="me" ${x && x.is_me ? "checked" : ""}> This is me (shows "My position" on the dashboard)</label>
      <label class="field"><span>Note (optional)</span><input class="input" name="note" value="${esc(x && x.note || "")}" maxlength="1000"></label>
      <div class="sheet-foot">${x ? `<button type="button" class="btn danger" id="invInvDel">${ICON.trash}Delete</button>` : ""}<button class="btn primary block">Save</button></div></form>`;
    sh.querySelector("#invInv").onsubmit = async ev => {
      ev.preventDefault(); ev.stopPropagation();
      const fm = ev.target, amt = parseAmount(fm.amount.value) ?? 0, eqS = fm.equity.value.trim().replace("%", ""), eq = eqS === "" ? null : Number(eqS);
      if (amt === undefined) return toastError("Capital isn't a number. Try 35 L, 3500000 or 0.");
      if (eq !== null && (isNaN(eq) || eq < 0 || eq > 100)) return toastError("Equity should be a percentage between 0 and 100.");
      const row = { name: fm.name.value.trim(), amount: amt, equity_pct: eq, invested_on: fm.on.value || null, is_me: fm.me.checked, note: fm.note.value.trim() || null };
      const b = fm.querySelector(".primary"); busy(b);
      const r = x ? await run(sb.from("inv_investors").update(row).eq("id", x.id)) : await run(sb.from("inv_investors").insert({ ...row, entity_id: entityId, sort: investorsOf(entityId).length }));
      busy(b, false); if (r.error) return toastError(r.error);
      await loadInv(true); closeSheet(); toast(x ? "Investor saved" : "Investor added");
    };
    const del = sh.querySelector("#invInvDel");
    if (del) del.onclick = async () => {
      const n = returnsOf(entityId).filter(r => r.investor_id === x.id).length;
      if (!await dialog({ title: `Delete ${x.name}?`, text: n ? `Their ${n} recorded return payment(s) are deleted too. This can't be undone.` : "This can't be undone.", confirm: "Delete", danger: true })) return;
      const r = await run(sb.from("inv_investors").delete().eq("id", x.id)); if (r.error) return toastError(r.error);
      await loadInv(true); closeSheet(); toast("Investor deleted");
    };
  });
}
function saleForm(entityId, id) {
  const s = id ? inv.sales.find(x => x.id === id) : null, e = entity(entityId);
  const last = salesOf(entityId).slice(-1)[0];
  const nextM = last ? (() => { const [y, m] = last.month.split("-").map(Number); return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7); })() : todayISO(state.tz).slice(0, 7);
  openSheet(sh => {
    sh.innerHTML = sheetHead(s ? "Edit month" : "Add month", esc(e.name)) + `<form class="sh-body" id="invSale">
      <label class="field"><span>Month</span><input class="input" type="month" name="month" value="${s ? s.month.slice(0, 7) : nextM}" required ${s ? "disabled" : ""}></label>
      <div class="grid3"><label class="field"><span>Sales</span><input class="input" name="sales" value="${s ? s.sales : ""}" inputmode="decimal" required placeholder="e.g. 9.5 L"></label>
      <label class="field"><span>Expenses</span><input class="input" name="exp" value="${s && s.expenses != null ? s.expenses : ""}" inputmode="decimal"></label>
      <label class="field"><span>Net profit</span><input class="input" name="profit" value="${s && s.net_profit != null ? s.net_profit : ""}" inputmode="decimal" placeholder="sales − expenses"></label></div>
      <p class="hint">Leave net profit empty and it's worked out as sales minus expenses. Amounts in ${e.currency}; you can type 9.5 L.</p>
      <label class="field"><span>Note (optional)</span><input class="input" name="note" value="${esc(s && s.note || "")}" maxlength="1000"></label>
      <div class="sheet-foot">${s ? `<button type="button" class="btn danger" id="invSaleDel">${ICON.trash}Delete</button>` : ""}<button class="btn primary block">Save</button></div></form>`;
    sh.querySelector("#invSale").onsubmit = async ev => {
      ev.preventDefault(); ev.stopPropagation();
      const fm = ev.target, sales = parseAmount(fm.sales.value), exp = parseAmount(fm.exp.value), pr = parseAmount(fm.profit.value);
      if ([sales, exp, pr].includes(undefined) || sales === null) return toastError("Check the amounts: numbers only, or with L / Cr.");
      const row = { sales, expenses: exp, net_profit: pr ?? (exp !== null ? Math.round((sales - exp) * 100) / 100 : null), note: fm.note.value.trim() || null };
      const b = fm.querySelector(".primary"); busy(b);
      const r = s ? await run(sb.from("inv_sales").update(row).eq("id", s.id)) : await run(sb.from("inv_sales").upsert({ ...row, entity_id: entityId, month: fm.month.value + "-01" }, { onConflict: "entity_id,month" }));
      busy(b, false); if (r.error) return toastError(r.error);
      await loadInv(true); closeSheet(); toast("Saved");
    };
    const del = sh.querySelector("#invSaleDel");
    if (del) del.onclick = async () => {
      if (!await dialog({ title: `Delete ${monthLabel(s.month, true)}?`, text: "This can't be undone.", confirm: "Delete", danger: true })) return;
      const r = await run(sb.from("inv_sales").delete().eq("id", s.id)); if (r.error) return toastError(r.error);
      await loadInv(true); closeSheet(); toast("Month deleted");
    };
  });
}
function returnForm(entityId) {
  const e = entity(entityId), ins = investorsOf(entityId), today = todayISO(state.tz);
  openSheet(sh => {
    sh.innerHTML = sheetHead("Record returns", esc(e.name)) + `<form class="sh-body" id="invRet">
      <div class="grid2"><label class="field"><span>Paid on</span><input class="input" type="date" name="paid" value="${today}" max="${today}" required></label>
      <label class="field"><span>For month (optional)</span><input class="input" type="month" name="period" value="${today.slice(0, 7)}"></label></div>
      <p class="hint">Enter what each investor received. Leave blank for anyone who didn't get a payment.</p>
      <div class="iv-retlines">${ins.map(x => `<label class="iv-retline"><span>${esc(x.name)}${x.is_me ? ` <span class="chip">Me</span>` : ""}</span><input class="input" name="amt-${x.id}" inputmode="decimal" placeholder="${e.currency} amount"></label>`).join("")}</div>
      <label class="field"><span>Note (optional)</span><input class="input" name="note" maxlength="1000" placeholder="e.g. October profit share, bank transfer"></label>
      <div class="sheet-foot"><button class="btn primary block">Save</button></div></form>`;
    sh.querySelector("#invRet").onsubmit = async ev => {
      ev.preventDefault(); ev.stopPropagation();
      const fm = ev.target, rows = [];
      for (const x of ins) {
        const a = parseAmount(fm["amt-" + x.id].value);
        if (a === undefined) return toastError(`${x.name}: amount isn't a number`);
        if (a) rows.push({ entity_id: entityId, investor_id: x.id, paid_on: fm.paid.value, period: fm.period.value ? fm.period.value + "-01" : null, amount: a, note: fm.note.value.trim() || null });
      }
      if (!rows.length) return toastError("Enter at least one amount.");
      const b = fm.querySelector(".primary"); busy(b);
      const r = await run(sb.from("inv_returns").insert(rows)); busy(b, false);
      if (r.error) return toastError(r.error);
      await loadInv(true); closeSheet(); toast(`Recorded ${rows.length} payment${rows.length === 1 ? "" : "s"}`);
    };
  });
}
function docForm(entityId, kind = "pl") {
  const e = entity(entityId);
  openSheet(sh => {
    sh.innerHTML = sheetHead("Upload document", esc(e.name)) + `<form class="sh-body" id="invDoc">
      <label class="field"><span>Type</span><select class="input" name="kind">${Object.entries(DOC_ONE).map(([k, v]) => `<option value="${k}" ${k === kind ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      <label class="field"><span>File (PDF, Excel, image — up to 25 MB)</span><input class="input" type="file" name="file" required accept=".pdf,.xlsx,.xls,.csv,.doc,.docx,image/*"></label>
      <div class="grid2"><label class="field"><span>Title</span><input class="input" name="title" maxlength="200" placeholder="Defaults to the file name"></label>
      <label class="field"><span>For month (optional)</span><input class="input" type="month" name="period"></label></div>
      <div class="sheet-foot"><button class="btn primary block">Upload</button></div></form>`;
    sh.querySelector("#invDoc").onsubmit = async ev => {
      ev.preventDefault(); ev.stopPropagation();
      const fm = ev.target, file = fm.file.files[0]; if (!file) return;
      if (file.size > 25 * 1024 * 1024) return toastError("Files can be up to 25 MB.");
      const b = fm.querySelector(".primary"); busy(b, true, "Uploading…");
      const id = crypto.randomUUID(), path = `${entityId}/${id}/${file.name.replace(/[^\w.\- ]+/g, "_").slice(-120)}`;
      const up = await run(sb.storage.from("investor").upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false }));
      if (up.error) { busy(b, false); return toastError(up.error); }
      const r = await run(sb.from("inv_documents").insert({ id, entity_id: entityId, kind: fm.kind.value, title: fm.title.value.trim() || file.name, period: fm.period.value ? fm.period.value + "-01" : null, storage_path: path, mime_type: file.type || null, size_bytes: file.size }));
      if (r.error) { await sb.storage.from("investor").remove([path]); busy(b, false); return toastError(r.error); }
      await loadInv(true); busy(b, false); closeSheet(); toast("Document uploaded");
    };
  });
}

/* ---------------- one month, day by day ---------------- */
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function monthSheet(entityId, month) {
  const e = entity(entityId), cur = e.currency, owner = isOwner(entityId);
  openSheet(sh => {
    const m = inv.sales.find(x => x.entity_id === entityId && x.month === month);
    const ds = daysOf(entityId, month);
    const total = sum(ds, d => d.amount), avg = ds.length ? total / ds.length : 0;
    const best = ds.reduce((b, d) => !b || Number(d.amount) > Number(b.amount) ? d : b, null), low = ds.reduce((b, d) => !b || Number(d.amount) < Number(b.amount) ? d : b, null);
    const byWd = WD.map((n, i) => { const xs = ds.filter(d => new Date(d.day + "T12:00:00Z").getUTCDay() === i); return { n, avg: xs.length ? sum(xs, d => d.amount) / xs.length : 0, c: xs.length }; }).filter(w => w.c);
    const topWd = byWd.reduce((b, w) => !b || w.avg > b.avg ? w : b, null);
    const dayLbl = d => `${Number(d.day.slice(8))} ${WD[new Date(d.day + "T12:00:00Z").getUTCDay()]}`;
    sh.innerHTML = sheetHead(monthLabel(month, true), esc(e.name)) + `<div class="sh-body iv-month">
      <div class="sw-kpis iv-kpis">${tile("Sales", money(m ? m.sales : total, cur), ds.length ? `${ds.length} day${ds.length === 1 ? "" : "s"} recorded` : "month total")}
        ${ds.length ? tile("Average per day", money(avg, cur)) + tile("Best day", money(best.amount, cur), dmy(best.day)) + tile("Lowest day", money(low.amount, cur), dmy(low.day)) : ""}
        ${m && m.net_profit != null ? tile("Net profit", money(m.net_profit, cur), Number(m.sales) ? `${pct(m.net_profit, m.sales)}% margin` : "", Number(m.net_profit) < 0 ? "bad" : "ok") : ""}</div>
      ${m && ds.length && Math.abs(total - Number(m.sales)) >= 1 ? `<div class="banner warn">Days add up to ${moneyFull(total, cur)}, but the month total says ${moneyFull(m.sales, cur)}.</div>` : ""}
      ${ds.length ? `<div class="iv-panel">${barChart(ds.map(d => ({ label: String(Number(d.day.slice(8))), value: Number(d.amount), tip: `${WD[new Date(d.day + "T12:00:00Z").getUTCDay()]} ${dmy(d.day)} · ${moneyFull(d.amount, cur)}` })), { cur, slot: 22 })}</div>
        ${topWd ? `<p class="hint">Strongest weekday this month: <b>${topWd.n}</b> (avg ${money(topWd.avg, cur)}). ${byWd.map(w => `${w.n} ${money(w.avg, cur)}`).join(" · ")}</p>` : ""}
        <div class="iv-table-wrap"><table class="iv-table"><thead><tr><th>Day</th><th class="r">Sales</th><th class="r">vs daily avg</th></tr></thead><tbody>
          ${ds.map(d => { const v = avg ? Math.round((Number(d.amount) / avg - 1) * 100) : 0; return `<tr><td>${dayLbl(d)} <small class="faint">${fmtDate(d.day, { month: "short" })}</small></td><td class="r num">${moneyFull(d.amount, cur)}</td><td class="r num ${v < -25 ? "bad-text" : v > 25 ? "ok-text" : "faint"}">${v > 0 ? "+" : ""}${v}%</td></tr>`; }).join("")}
          <tr class="tot"><td>Total</td><td class="r num">${moneyFull(total, cur)}</td><td></td></tr></tbody></table></div>` :
        `<div class="sw-empty">No day-by-day figures for this month.${owner ? " Upload a daily sales Excel (Date, Amount) from the Sales tab." : ""}</div>`}
      ${owner && m && !e.sales_from ? `<div class="sheet-foot"><button class="btn" data-act="inv-sale" data-id="${m.id}" data-entity="${entityId}">Edit month figures</button></div>` : ""}
    </div>`;
  }, { wide: true });
}

/* ---------------- sales Excel upload ---------------- */
let salesImp = null, xlsxLib = null;
const loadReader = () => xlsxLib || (xlsxLib = new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"; s.onload = () => res(window.XLSX); s.onerror = () => { xlsxLib = null; rej(new Error("Couldn't load the Excel reader.")); }; document.head.appendChild(s); }));
function salesTemplate(e) {
  downloadXlsx(`Sales-template-${e.name.replace(/[^\w\- ]+/g, "").replace(/\s+/g, "-")}.xlsx`, [
    { name: "Sales", columns: ["Month", "Sales", "Expenses", "Net profit", "Note"].map(label => ({ label })), rows: [] },
    { name: "How to fill", columns: [{ label: "Sales upload", width: 100 }], rows: [["One row per month. Month as MM/YYYY (e.g. 10/2026) or a date in that month."], ["Sales is required. Expenses and Net profit are optional; if Net profit is empty it is worked out as Sales − Expenses."], ["Amounts as plain numbers (950000) or with L / Cr (9.5 L)."], ["A month that already exists is updated with the new figures."], ["Have daily sales? Use a sheet with two columns, Date and Amount (one row per day). J. Desk adds up each month for you and lets you see every day."]] }
  ]);
}
function salesImport(entityId) {
  salesImp = { entityId, rows: null, errors: [] };
  openSheet(sh => {
    const e = entity(entityId), p = salesImp;
    const exist = new Set(salesOf(entityId).map(s => s.month));
    sh.innerHTML = sheetHead("Upload sales from Excel", esc(e.name)) + `<div class="sh-body">
      ${!p.rows ? `<p>Monthly file: one row per month with <b>Month, Sales, Expenses, Net profit, Note</b>. Daily file: one row per day with <b>Date, Amount</b> — month totals are worked out for you. <button class="linkbtn" data-act="inv-sales-template" data-entity="${entityId}">${ICON.download} Download template</button></p>
        <label class="btn primary block sw-file">${ICON.plus}Choose Excel file<input type="file" id="inv-sales-file" accept=".xlsx,.xls,.csv" hidden></label>
        ${p.errors.length ? `<div class="banner bad">${p.errors.map(esc).join("<br>")}</div>` : ""}` :
      `<p>${p.daily ? `<b>${p.daily.length}</b> days across ` : ""}${p.rows.length} month(s) ready: <b>${p.rows.filter(r => !exist.has(r.month)).length}</b> new, <b>${p.rows.filter(r => exist.has(r.month)).length}</b> will be updated. Nothing is saved until you confirm.</p>
        ${p.errors.length ? `<div class="banner bad"><b>${p.errors.length} row(s) skipped:</b><br>${p.errors.slice(0, 10).map(esc).join("<br>")}</div>` : ""}
        <div class="iv-table-wrap"><table class="iv-table"><thead><tr><th>Month</th>${p.daily ? `<th class="r">Days</th>` : ""}<th class="r">Sales</th>${p.daily ? "" : `<th class="r">Expenses</th><th class="r">Net profit</th>`}<th></th></tr></thead><tbody>
        ${p.rows.map(r => `<tr><td>${monthLabel(r.month, true)}</td>${p.daily ? `<td class="r num">${r.days}</td>` : ""}<td class="r num">${moneyFull(r.sales, e.currency)}</td>${p.daily ? "" : `<td class="r num">${r.expenses == null ? "—" : moneyFull(r.expenses, e.currency)}</td><td class="r num">${r.net_profit == null ? "—" : moneyFull(r.net_profit, e.currency)}</td>`}<td><small class="faint">${exist.has(r.month) ? "update" : "new"}</small></td></tr>`).join("")}</tbody></table></div>
        ${p.daily ? `<p class="hint">Month totals are set to the sum of the days. Expenses and net profit you've entered are kept.</p>` : ""}
        <div class="sheet-foot"><button class="btn" data-act="inv-sales-reset">Choose another file</button><button class="btn primary block" data-act="inv-sales-confirm">Confirm and save</button></div>`}
    </div>`;
  }, { wide: true, onClose: () => { salesImp = null; } });
}
async function readSalesFile(file) {
  const X = await loadReader(), wb = X.read(await file.arrayBuffer(), { type: "array" });
  const name = wb.SheetNames.find(n => n.toLowerCase() === "sales") || wb.SheetNames[0];
  const rows = X.utils.sheet_to_json(wb.Sheets[name], { defval: "", raw: true });
  const out = [], errors = [], seen = new Set();
  const get = (r, k) => { const key = Object.keys(r).find(x => x.trim().toLowerCase() === k); return key ? r[key] : ""; };
  const heads = rows.length ? Object.keys(rows[0]).map(k => k.trim().toLowerCase()) : [];
  if (heads.includes("date") && (heads.includes("amount") || heads.includes("sales")) && !heads.includes("month")) {
    // daily file: one row per day → days + month totals
    const days = [];
    rows.forEach((r, i) => {
      const line = i + 2, dv = get(r, "date"), av = heads.includes("amount") ? get(r, "amount") : get(r, "sales");
      if ((dv === "" || dv === null) && (av === "" || av === null)) return;
      if (av === "" || av === null) return; // future dates left blank in the sheet
      const day = parseDate(dv), amount = parseAmount(av);
      if (!day) return errors.push(`Row ${line}: date "${dv}" not recognised`);
      if (amount === undefined || amount === null) return errors.push(`Row ${line}: amount "${av}" isn't a number`);
      if (seen.has(day)) return errors.push(`Row ${line}: ${dmy(day)} appears twice; the first row is used`);
      seen.add(day); days.push({ day, amount });
    });
    const months = {};
    days.forEach(d => { const m = d.day.slice(0, 8) + "01"; months[m] = (months[m] || { month: m, sales: 0, days: 0 }); months[m].sales = Math.round((months[m].sales + d.amount) * 100) / 100; months[m].days++; });
    return { daily: days.sort((a, b) => a.day.localeCompare(b.day)), rows: Object.values(months).sort((a, b) => a.month.localeCompare(b.month)), errors };
  }
  rows.forEach((r, i) => {
    const line = i + 2, mv = get(r, "month");
    if (mv === "" && get(r, "sales") === "") return;
    let month = null;
    const ms = String(mv).trim().match(/^(\d{1,2})[\/\-.](\d{4})$/);
    if (ms) month = `${ms[2]}-${ms[1].padStart(2, "0")}-01`;
    else { const d = parseDate(mv) || parseDate("1 " + String(mv).trim()); if (d) month = d.slice(0, 8) + "01"; }
    if (!month) return errors.push(`Row ${line}: month "${mv}" not recognised (use MM/YYYY)`);
    const sales = parseAmount(get(r, "sales")), exp = parseAmount(get(r, "expenses")), pr = parseAmount(get(r, "net profit"));
    if (sales === undefined || sales === null) return errors.push(`Row ${line}: sales "${get(r, "sales")}" isn't a number`);
    if (exp === undefined || pr === undefined) return errors.push(`Row ${line}: expenses or net profit isn't a number`);
    if (seen.has(month)) return errors.push(`Row ${line}: ${monthLabel(month, true)} appears twice; the first row is used`);
    seen.add(month);
    out.push({ month, sales, expenses: exp, net_profit: pr ?? (exp !== null ? Math.round((sales - exp) * 100) / 100 : null), note: String(get(r, "note") || "").trim() || null });
  });
  return { rows: out.sort((a, b) => a.month.localeCompare(b.month)), errors };
}

/* ---------------- Excel export ---------------- */
function exportEntity(id) {
  const f = figures(id), { e } = f, cur = e.currency;
  const name = x => (f.ins.find(i => i.id === x) || {}).name || "";
  downloadXlsx(`${e.name.replace(/[^\w\- ]+/g, "").replace(/\s+/g, "-")}-investor-report-${todayISO(state.tz)}.xlsx`, [
    { name: "Summary", columns: [{ label: "Item", width: 32 }, { label: `Amount (${cur})`, money: true, width: 20 }, { label: "Note", width: 40 }], rows: [
      ["Total project cost", Number(e.project_cost) || 0, ""], ["Total invested", f.invested, `${f.ins.length} investors`], ["Returns received", f.received, `${f.recovered}% of capital`],
      ["Pending to recover", f.pending, ""], ["Sales to date", f.salesTotal, `${f.ss.length} months`], ["Net profit to date", f.profitTotal, ""], ["Average monthly sales (last 6)", Math.round(f.avg6), ""]] },
    { name: "Investors", columns: ["Partner", "Capital", "Capital share %", "Equity %", "Returns received", "Recovered %", "Pending", "Invested on", "Note"].map((label, i) => ({ label, money: [1, 4, 6].includes(i) })),
      rows: f.per.map(p => [p.x.name, Number(p.x.amount), p.cap ? p.share : null, p.equity, p.got, p.recovered, p.cap ? p.pending : null, p.x.invested_on ? dmy(p.x.invested_on) : "", p.x.note || ""]) },
    { name: "Sales", columns: ["Month", "Sales", "Expenses", "Net profit", "Margin %", "Note"].map((label, i) => ({ label, money: i >= 1 && i <= 3 })),
      rows: f.ss.map(s => [monthLabel(s.month, true), Number(s.sales), s.expenses == null ? null : Number(s.expenses), s.net_profit == null ? null : Number(s.net_profit), s.net_profit == null || !Number(s.sales) ? null : pct(s.net_profit, s.sales), s.note || ""]) },
    { name: "Returns", columns: ["Paid on", "For month", "Investor", "Amount", "Note"].map((label, i) => ({ label, money: i === 3 })),
      rows: f.rs.slice().sort((a, b) => a.paid_on.localeCompare(b.paid_on)).map(r => [dmy(r.paid_on), r.period ? monthLabel(r.period, true) : "", name(r.investor_id), Number(r.amount), r.note || ""]) },
    { name: "Daily sales", columns: [{ label: "Date" }, { label: "Day" }, { label: "Sales", money: true }], rows: daysOf(id).map(d => [dmy(d.day), WD[new Date(d.day + "T12:00:00Z").getUTCDay()], Number(d.amount)]) },
    { name: "Documents", columns: ["Type", "Title", "For month", "Added"].map(label => ({ label })), rows: docsOf(id).map(d => [DOC_ONE[d.kind], d.title, d.period ? monthLabel(d.period, true) : "", dmy(d.created_at.slice(0, 10))]) }
  ]);
}

/* ---------------- events ---------------- */
export async function handleInvClick(act, el) {
  if (!act.startsWith("inv-")) return false;
  const id = el.dataset.id, ent = el.dataset.entity;
  switch (act) {
    case "inv-reload": inv.error = null; loadInv(true); rerenderPage(); break;
    case "inv-new": newEntity(); break;
    case "inv-tab": location.hash = `#/investors/${id}/${el.dataset.tab}`; break;
    case "inv-investor": investorForm(ent, id); break;
    case "inv-sale": saleForm(ent, id); break;
    case "inv-return": returnForm(ent); break;
    case "inv-return-del": {
      const r0 = inv.returns.find(r => r.id === id); if (!r0) break;
      if (!await dialog({ title: "Delete this payment?", text: `${moneyFull(r0.amount, entity(r0.entity_id).currency)} paid on ${dmy(r0.paid_on)}. This can't be undone.`, confirm: "Delete", danger: true })) break;
      const r = await run(sb.from("inv_returns").delete().eq("id", id)); if (r.error) { toastError(r.error); break; }
      await loadInv(true); toast("Payment deleted"); break;
    }
    case "inv-doc-new": docForm(ent, el.dataset.kind); break;
    case "inv-doc-open": {
      const d = inv.docs.find(x => x.id === id); if (!d) break;
      const win = window.open("", "_blank");
      const r = await run(sb.storage.from("investor").createSignedUrl(d.storage_path, 600));
      if (r.error) { if (win) win.close(); toastError(r.error); break; }
      if (win) { win.opener = null; win.location = r.data.signedUrl; } else location.href = r.data.signedUrl;
      break;
    }
    case "inv-doc-del": {
      const d = inv.docs.find(x => x.id === id); if (!d) break;
      if (!await dialog({ title: `Delete "${d.title}"?`, text: "The file is removed permanently. This can't be undone.", confirm: "Delete", danger: true })) break;
      const r = await run(sb.from("inv_documents").delete().eq("id", id)); if (r.error) { toastError(r.error); break; }
      await sb.storage.from("investor").remove([d.storage_path]);
      await loadInv(true); toast("Document deleted"); break;
    }
    case "inv-sales-import": salesImport(ent); break;
    case "inv-sales-template": salesTemplate(entity(ent)); break;
    case "inv-sales-reset": salesImp.rows = null; salesImp.daily = null; salesImp.errors = []; rerenderSheet(); break;
    case "inv-month": monthSheet(ent, el.dataset.month); break;
    case "inv-sales-confirm": {
      busy(el, true, "Saving…");
      if (salesImp.daily) {
        for (let i = 0; i < salesImp.daily.length; i += 500) {
          const rd = await run(sb.from("inv_daily_sales").upsert(salesImp.daily.slice(i, i + 500).map(x => ({ ...x, entity_id: salesImp.entityId })), { onConflict: "entity_id,day" }));
          if (rd.error) { busy(el, false); toastError(rd.error); return true; }
        }
      }
      const r = await run(sb.from("inv_sales").upsert(salesImp.rows.map(x => salesImp.daily ? { entity_id: salesImp.entityId, month: x.month, sales: x.sales } : { ...x, entity_id: salesImp.entityId }), { onConflict: "entity_id,month" }));
      busy(el, false); if (r.error) { toastError(r.error); break; }
      const n = salesImp.rows.length; await loadInv(true); closeSheet(); toast(`Saved ${n} month(s)`); break;
    }
    case "inv-export": exportEntity(id); break;
    case "inv-unshare": {
      if (!await dialog({ title: "Stop sharing with this person?", text: "They lose access to this entity straight away.", confirm: "Remove", danger: true })) break;
      const r = await run(sb.from("inv_members").delete().eq("entity_id", ent).eq("user_id", el.dataset.user)); if (r.error) { toastError(r.error); break; }
      inv.ui.memberList = null; await loadInv(true); toast("Access removed"); break;
    }
    case "inv-uninvite": {
      if (!await dialog({ title: "Cancel this invite?", text: `${el.dataset.email} won't get access when they sign up.`, confirm: "Cancel invite", danger: true })) break;
      const r = await run(sb.from("inv_pending_invites").delete().eq("entity_id", ent).eq("email", el.dataset.email)); if (r.error) { toastError(r.error); break; }
      inv.ui.memberList = null; rerenderPage(); toast("Invite cancelled"); break;
    }
    case "inv-delete": {
      const e = entity(id);
      const typed = await dialog({ title: `Delete "${e.name}" permanently?`, text: "All investors, sales, returns and documents are deleted, for everyone it's shared with. Type the entity name to confirm.", input: { label: "Entity name", required: true }, confirm: "Delete permanently", danger: true });
      if (typed === null) break;
      if (typed !== e.name) { toastError("The name didn't match. Nothing was deleted."); break; }
      const paths = docsOf(id).map(d => d.storage_path);
      const r = await run(sb.from("inv_entities").delete().eq("id", id)); if (r.error) { toastError(r.error); break; }
      if (paths.length) await sb.storage.from("investor").remove(paths);
      await loadInv(true); location.hash = "#/investors"; toast("Entity deleted"); break;
    }
  }
  return true;
}
export async function handleInvChange(e) {
  const t = e.target;
  if (t.id === "inv-sales-range") { inv.ui.salesRange = t.value; rerenderPage(); return true; }
  if (t.id === "inv-ret-who") { inv.ui.retWho = t.value; rerenderPage(); return true; }
  if (t.id === "inv-ret-year") { inv.ui.retYear = t.value; rerenderPage(); return true; }
  if (t.id === "inv-sales-file" && salesImp) {
    const file = t.files[0]; if (!file) return true;
    try { const r = await readSalesFile(file); salesImp.daily = r.daily || null; salesImp.rows = r.rows.length ? r.rows : null; salesImp.errors = r.rows.length ? r.errors : (r.errors.length ? r.errors : ["No rows found in the Sales sheet."]); }
    catch (err) { salesImp.errors = [err.message || "Couldn't read that file."]; }
    rerenderSheet(); return true;
  }
  return false;
}
export async function handleInvSubmit(form) {
  if (form.id === "inv-entity-form") {
    const f = form.elements, cost = parseAmount(f.cost.value);
    if (cost === undefined) { toastError("Project cost isn't a number. Try 1.05 Cr or 10500000."); return true; }
    const b = form.querySelector("button"); busy(b);
    const r = await run(sb.from("inv_entities").update({ name: f.name.value.trim(), description: f.description.value.trim() || null, project_cost: cost, currency: f.currency.value, start_date: f.start.value || null }).eq("id", form.dataset.id));
    busy(b, false); if (r.error) { toastError(r.error); return true; }
    await loadInv(true); toast("Saved"); return true;
  }
  if (form.id === "inv-share-form") {
    const b = form.querySelector("button"); busy(b, true, "Sharing…");
    const r = await run(sb.rpc("inv_add_viewer", { p_entity: form.dataset.id, p_email: form.elements.email.value }));
    busy(b, false);
    if (r.error) { toastError(/not_registered/.test(r.raw && r.raw.message || r.error) ? "No J. Desk account with that email. Ask them to sign up first, then share again." : r.error); return true; }
    inv.ui.memberList = null; await loadInv(true); toast(r.data.pending ? `Invited ${r.data.email} — they'll get access when they sign up` : `Shared with ${r.data.email} (view only)`); return true;
  }
  return false;
}
