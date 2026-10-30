-- A reimbursement (or decreasing adjustment) can name the funding line it settles, so ageing and statements
-- apply it there instead of oldest-first. This is allocation metadata only: it never changes amounts or postings.
alter table public.fin_partner_txns add column settles_txn_id uuid references public.fin_partner_txns(id);

create or replace function public.fin_partner_update(p_txn uuid, p_patch jsonb, p_reason text) returns void language plpgsql security definer set search_path = '' as $$
declare t public.fin_partner_txns; s public.fin_partner_txns; k text; v_settles uuid;
begin
  select * into t from public.fin_partner_txns where id = p_txn for update;
  if not found then raise exception 'not_found'; end if;
  if not public.can_write_fin(t.entity_id) then raise exception 'forbidden'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required: say why you are changing this record'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('payment_date','beneficiary','reference','invoice_amount','paid_from','job_ref','notes','recon_status','flags','legacy_ref','description','settles_txn_id') then
      raise exception 'locked_field: % can''t be edited — reverse the transaction and record it again', k;
    end if;
  end loop;
  v_settles := case when p_patch ? 'settles_txn_id' then nullif(p_patch->>'settles_txn_id', '')::uuid else t.settles_txn_id end;
  if p_patch ? 'settles_txn_id' and v_settles is not null then
    if t.direction <> 'decrease' then raise exception 'bad_settles: only reimbursements or decreasing adjustments settle a funding line'; end if;
    select * into s from public.fin_partner_txns where id = v_settles;
    if s.link_id is distinct from t.link_id or s.direction <> 'increase' or s.status <> 'posted' then raise exception 'bad_settles: choose a posted funding line from the same partner account'; end if;
  end if;
  update public.fin_partner_txns set
    payment_date = case when p_patch ? 'payment_date' then nullif(p_patch->>'payment_date', '')::date else payment_date end,
    beneficiary = case when p_patch ? 'beneficiary' then nullif(trim(p_patch->>'beneficiary'), '') else beneficiary end,
    reference = case when p_patch ? 'reference' then nullif(trim(p_patch->>'reference'), '') else reference end,
    invoice_amount = case when p_patch ? 'invoice_amount' then nullif(p_patch->>'invoice_amount', '')::numeric else invoice_amount end,
    paid_from = case when p_patch ? 'paid_from' then p_patch->>'paid_from' else paid_from end,
    job_ref = case when p_patch ? 'job_ref' then nullif(trim(p_patch->>'job_ref'), '') else job_ref end,
    notes = case when p_patch ? 'notes' then nullif(p_patch->>'notes', '') else notes end,
    recon_status = case when p_patch ? 'recon_status' then p_patch->>'recon_status' else recon_status end,
    flags = case when p_patch ? 'flags' then coalesce(array(select jsonb_array_elements_text(p_patch->'flags')), '{}') else flags end,
    legacy_ref = case when p_patch ? 'legacy_ref' then nullif(p_patch->>'legacy_ref', '') else legacy_ref end,
    description = case when p_patch ? 'description' then trim(p_patch->>'description') else description end,
    settles_txn_id = v_settles,
    last_change_reason = p_reason, updated_by = (select auth.uid()), updated_at = now()
  where id = p_txn;
end $$;
revoke execute on function public.fin_partner_update(uuid, jsonb, text) from public, anon;
grant execute on function public.fin_partner_update(uuid, jsonb, text) to authenticated;
