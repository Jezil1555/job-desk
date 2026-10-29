revoke execute on function public.is_project_member(uuid), public.is_project_owner(uuid), public.shares_project(uuid), public.can_see_task(uuid) from public, anon;
grant execute on function public.is_project_member(uuid), public.is_project_owner(uuid), public.shares_project(uuid), public.can_see_task(uuid) to authenticated;
revoke execute on function public.actor_name() from public, anon, authenticated;
revoke execute on function public.add_project_member(uuid, text) from public, anon;
