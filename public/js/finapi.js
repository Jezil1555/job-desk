// Finance data layer: loads every set of books the user belongs to and wraps the posting functions.
// All money-moving actions go through database functions that enforce double-entry rules.
import { state, emit } from "./store.js";
import { sb, run } from "./api.js";
import { postedLines } from "./finance.js";

export const fin = {
  loaded: false, loading: null, error: null,
  entities: [], members: [], accounts: [], parties: [], journals: [], lines: [], invoices: [], invLines: [], totals: new Map(),
  payments: [], allocations: [], items: [], moves: [], statement: [], budgets: [], files: [], audit: [],
  posted: [] // posted lines with entry_date, recomputed after each load
};
const PAGE = 1000;
async function all(q) { // page through results so large ledgers aren't silently truncated
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await q().range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < PAGE) return out;
  }
}
export function loadFin(force = false) {
  if (fin.loading && !force) return fin.loading;
  fin.loading = (async () => {
    try {
      const [entities, members, accounts, parties, journals, lines, invoices, invLines, totals, payments, allocations, items, moves, statement, budgets, files] = await Promise.all([
        all(() => sb.from("fin_entities").select("*").order("created_at")),
        all(() => sb.from("fin_members").select("entity_id, user_id, role")),
        all(() => sb.from("fin_accounts").select("*").order("code")),
        all(() => sb.from("fin_parties").select("*").order("name")),
        all(() => sb.from("fin_journals").select("*").order("entry_date", { ascending: false }).order("number", { ascending: false, nullsFirst: true })),
        all(() => sb.from("fin_lines").select("*").order("journal_id").order("sort")),
        all(() => sb.from("fin_invoices").select("*").order("issue_date", { ascending: false })),
        all(() => sb.from("fin_invoice_lines").select("*").order("invoice_id").order("sort")),
        all(() => sb.from("fin_invoice_totals").select("*").order("invoice_id")),
        all(() => sb.from("fin_payments").select("*").order("pay_date", { ascending: false })),
        all(() => sb.from("fin_allocations").select("*").order("payment_id")),
        all(() => sb.from("fin_items").select("*").order("name")),
        all(() => sb.from("fin_stock_moves").select("*").order("move_date")),
        all(() => sb.from("fin_statement_lines").select("*").order("line_date", { ascending: false })),
        all(() => sb.from("fin_budgets").select("*").order("month")),
        all(() => sb.from("fin_files").select("*").order("created_at", { ascending: false }))
      ]);
      Object.assign(fin, { entities, members, accounts, parties, journals, lines, invoices, invLines, payments, allocations, items, moves, statement, budgets, files,
        totals: new Map(totals.map(t => [t.invoice_id, t])), loaded: true, error: null });
      fin.posted = postedLines(lines, journals);
    } catch (e) { fin.error = e; console.error(e); }
    fin.loading = null;
    emit("fin");
  })();
  return fin.loading;
}
export async function loadAudit(entityId) {
  const r = await run(sb.from("fin_audit").select("*").eq("entity_id", entityId).order("created_at", { ascending: false }).limit(150));
  fin.audit = r.data || []; return r;
}

/* ---------- lookups ---------- */
export const entityById = id => fin.entities.find(e => e.id === id);
export const accById = id => fin.accounts.find(a => a.id === id);
export const partyById = id => fin.parties.find(p => p.id === id);
export const journalById = id => fin.journals.find(j => j.id === id);
export const invoiceById = id => fin.invoices.find(i => i.id === id);
export const paymentById = id => fin.payments.find(p => p.id === id);
export const itemById = id => fin.items.find(i => i.id === id);
export const finRole = eid => (fin.members.find(m => m.entity_id === eid && m.user_id === state.user.id) || {}).role;
export const canWriteFin = eid => ["owner", "bookkeeper"].includes(finRole(eid));
export const isFinOwner = eid => finRole(eid) === "owner";
export const accountsOf = (eid, pred = () => true) => fin.accounts.filter(a => a.entity_id === eid && pred(a));
export const moneyAccounts = eid => accountsOf(eid, a => ["cash", "bank", "card"].includes(a.subtype) && a.is_active);
export const sysAccount = (eid, key) => fin.accounts.find(a => a.entity_id === eid && a.system_key === key);
export const linesOf = eid => fin.posted.filter(l => l.entity_id === eid);
export const linesOfJournal = jid => fin.lines.filter(l => l.journal_id === jid).sort((a, b) => a.sort - b.sort);
export const invLinesOf = iid => fin.invLines.filter(l => l.invoice_id === iid).sort((a, b) => a.sort - b.sort);
export const filesOf = (field, id) => fin.files.filter(f => f[field] === id);
export const invoicesForTask = tid => fin.invoices.filter(i => i.task_id === tid);
export function stockOf(itemId) {
  const ms = fin.moves.filter(m => m.item_id === itemId);
  const qty = ms.reduce((s, m) => s + Number(m.qty), 0), val = ms.reduce((s, m) => s + Number(m.qty) * Number(m.unit_cost), 0);
  return { qty: Math.round(qty * 1000) / 1000, avg: qty > 0 ? val / qty : 0, value: qty > 0 ? Math.round(val * 100) / 100 : 0 };
}

/* ---------- writes (each returns {data}|{error}) ---------- */
const rpc = (fn, args) => run(sb.rpc(fn, args));
export const postJournal = id => rpc("fin_post_journal", { p_journal: id });
export const reverseJournal = (id, reason, date) => rpc("fin_reverse_journal", { p_journal: id, p_reason: reason, p_date: date || null });
export const postInvoice = id => rpc("fin_post_invoice", { p_invoice: id });
export const voidInvoice = (id, reason, date) => rpc("fin_void_invoice", { p_invoice: id, p_reason: reason, p_date: date || null });
export const recordPayment = a => rpc("fin_record_payment", { p_entity: a.entity_id, p_direction: a.direction, p_party: a.party_id || null, p_date: a.pay_date, p_amount: a.amount,
  p_account: a.account_id, p_reference: a.reference || null, p_memo: a.memo || null, p_allocations: a.allocations || [] });
export const voidPayment = (id, reason) => rpc("fin_void_payment", { p_payment: id, p_reason: reason });
export const matchStatement = (st, line) => rpc("fin_match_statement", { p_statement: st, p_line: line });
export const unmatchStatement = st => rpc("fin_unmatch_statement", { p_statement: st });
export const addFinMember = (eid, email, role) => rpc("fin_add_member", { p_entity: eid, p_email: email, p_role: role });
export const stockAdjust = a => rpc("fin_stock_adjust", { p_item: a.item_id, p_date: a.date, p_qty: a.qty, p_unit_cost: a.unit_cost ?? null, p_kind: a.kind, p_reason: a.reason });

/** Create a draft journal with lines; optionally post it straight away (the user pressed "Save & post"). Draft is removed if lines fail. */
export async function saveJournal({ id, entity_id, entry_date, memo, reference, source = "manual" }, lines, post) {
  let jid = id;
  if (jid) {
    const u = await run(sb.from("fin_journals").update({ entry_date, memo, reference: reference || null }).eq("id", jid));
    if (u.error) return u;
    const d = await run(sb.from("fin_lines").delete().eq("journal_id", jid));
    if (d.error) return d;
  } else {
    const r = await run(sb.from("fin_journals").insert({ entity_id, entry_date, memo, reference: reference || null, source }).select().single());
    if (r.error) return r;
    jid = r.data.id;
  }
  const rows = lines.filter(l => l.account_id && ((Number(l.debit) || 0) > 0 || (Number(l.credit) || 0) > 0))
    .map((l, i) => ({ journal_id: jid, entity_id, account_id: l.account_id, party_id: l.party_id || null, description: l.description || null, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0, sort: i }));
  const li = await run(sb.from("fin_lines").insert(rows));
  if (li.error) { if (!id) await sb.from("fin_journals").delete().eq("id", jid); return li; }
  if (post) { const p = await postJournal(jid); if (p.error) return { error: p.error, draftId: jid }; }
  return { data: { id: jid } };
}
export async function deleteDraftJournal(id) { return run(sb.from("fin_journals").delete().eq("id", id)); }

export async function saveInvoice(inv, lines) {
  let id = inv.id;
  const head = { party_id: inv.party_id || null, party_reference: inv.party_reference || null, issue_date: inv.issue_date, due_date: inv.due_date || null, notes: inv.notes || null, task_id: inv.task_id || null };
  if (id) { const u = await run(sb.from("fin_invoices").update(head).eq("id", id)); if (u.error) return u;
    const d = await run(sb.from("fin_invoice_lines").delete().eq("invoice_id", id)); if (d.error) return d; }
  else { const r = await run(sb.from("fin_invoices").insert({ ...head, entity_id: inv.entity_id, kind: inv.kind }).select().single()); if (r.error) return r; id = r.data.id; }
  const rows = lines.filter(l => l.description && Number(l.qty) > 0).map((l, i) => ({ invoice_id: id, entity_id: inv.entity_id, item_id: l.item_id || null, description: l.description,
    qty: Number(l.qty), unit_price: Number(l.unit_price) || 0, account_id: l.account_id || null, sort: i }));
  if (rows.length) { const li = await run(sb.from("fin_invoice_lines").insert(rows)); if (li.error) return li; }
  return { data: { id } };
}

export async function uploadFinFile(file, entityId, target, safeName) {
  if (file.size > 25 * 1024 * 1024) return { error: "Files can be up to 25 MB." };
  const path = `${entityId}/${crypto.randomUUID()}/${safeName(file.name)}`;
  const up = await run(sb.storage.from("finance").upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false }));
  if (up.error) return up;
  const r = await run(sb.from("fin_files").insert({ entity_id: entityId, ...target, title: file.name, storage_path: path, mime_type: file.type || null, size_bytes: file.size }).select().single());
  if (r.error) { await sb.storage.from("finance").remove([path]); return r; }
  fin.files.unshift(r.data); return r;
}
export async function finFileUrl(f) {
  const r = await run(sb.storage.from("finance").createSignedUrl(f.storage_path, 600));
  return r.error ? r : { data: r.data.signedUrl };
}
export async function deleteFinFile(f) {
  const r = await run(sb.from("fin_files").delete().eq("id", f.id)); if (r.error) return r;
  await sb.storage.from("finance").remove([f.storage_path]);
  fin.files = fin.files.filter(x => x.id !== f.id); return r;
}
