-- A linked entity (e.g. a sub-investor group) shows the outlet's sales and P&L from its main entity,
-- without its members becoming members of the main entity (so they can't see its investors, returns or documents).
alter table public.inv_entities add column if not exists sales_from uuid references public.inv_entities(id) on delete set null;
alter table public.inv_entities add constraint inv_entities_sales_from_not_self check (sales_from is null or sales_from <> id);
create index if not exists inv_entities_sales_from_idx on public.inv_entities(sales_from);

create or replace function public.inv_linked_sales(p_entity uuid) returns json language plpgsql stable security definer set search_path = '' as $$
declare v_src uuid;
begin
  if not public.is_inv_member(p_entity) then return null; end if;
  select sales_from into v_src from public.inv_entities where id = p_entity;
  if v_src is null then return null; end if;
  return json_build_object(
    'source_name', (select name from public.inv_entities where id = v_src),
    'sales', coalesce((select json_agg(json_build_object('id', s.id, 'month', s.month, 'sales', s.sales, 'expenses', s.expenses, 'net_profit', s.net_profit, 'note', s.note) order by s.month) from public.inv_sales s where s.entity_id = v_src), '[]'::json),
    'daily', coalesce((select json_agg(json_build_object('id', d.id, 'day', d.day, 'amount', d.amount) order by d.day) from public.inv_daily_sales d where d.entity_id = v_src), '[]'::json));
end $$;
revoke execute on function public.inv_linked_sales(uuid) from public, anon;
grant execute on function public.inv_linked_sales(uuid) to authenticated;
