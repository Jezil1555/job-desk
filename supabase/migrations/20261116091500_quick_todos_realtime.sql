-- Live updates for the to-do whiteboard.
do $$ begin
  alter publication supabase_realtime add table public.quick_todos;
exception when duplicate_object then null; when undefined_object then null; end $$;
