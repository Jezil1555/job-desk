-- =====================================================================================
-- Phase 2: notes & documents (private storage), record links, goals & habits,
-- health logs (strictly private), weekly reviews, wider search.
-- Additive only: no existing table or data is changed.
-- =====================================================================================

-- immutable helper so tags can feed a generated search column
create or replace function public.tags_text(t text[])
returns text language sql immutable parallel safe set search_path = '' as $$ select coalesce(array_to_string(t, ' '), '') $$;

-- ---------- notes, meetings, decisions ----------
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null default 'note' check (kind in ('note','meeting','decision')),
  title text not null check (char_length(title) between 1 and 200),
  body text not null default '',
  tags text[] not null default '{}',
  meeting_date date,
  attendees text,
  decision text,
  rationale text,
  decision_status text check (decision_status in ('proposed','decided','superseded')),
  decided_on date,
  pinned boolean not null default false,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  search tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(decision, '') || ' ' || public.tags_text(tags)), 'B') ||
    setweight(to_tsvector('simple', coalesce(body, '') || ' ' || coalesce(rationale, '') || ' ' || coalesce(attendees, '')), 'C')
  ) stored,
  constraint decision_fields check (kind <> 'decision' or char_length(coalesce(decision, '')) > 0)
);
create index notes_ws_idx on public.notes(workspace_id, updated_at desc) where deleted_at is null;
create index notes_search_idx on public.notes using gin(search);
create index notes_tags_idx on public.notes using gin(tags);

-- ---------- documents (files in private storage, or external links) ----------
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  kind text not null check (kind in ('file','link')),
  storage_path text unique,
  mime_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  url text,
  category text not null default 'other' check (category in ('invoice','receipt','delivery','compliance','contract','correspondence','report','photo','other')),
  tags text[] not null default '{}',
  notes text,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint document_target check ((kind = 'file' and storage_path is not null) or (kind = 'link' and url ~* '^https?://')),
  constraint document_path_in_workspace check (storage_path is null or storage_path like workspace_id::text || '/%')
);
create index documents_ws_idx on public.documents(workspace_id, created_at desc) where deleted_at is null;

-- ---------- links between knowledge and work records ----------
create table public.record_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  from_type text not null check (from_type in ('note','document')),
  from_id uuid not null,
  to_type text not null check (to_type in ('task','project','contact','follow_up','note')),
  to_id uuid not null,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (from_type, from_id, to_type, to_id)
);
create index record_links_to_idx on public.record_links(to_type, to_id);
create index record_links_from_idx on public.record_links(from_type, from_id);

-- every linked record must exist in the same workspace (no cross-workspace leaks)
create or replace function public.record_links_check()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_from uuid; v_to uuid;
begin
  v_from := case new.from_type when 'note' then (select workspace_id from public.notes where id = new.from_id)
                               when 'document' then (select workspace_id from public.documents where id = new.from_id) end;
  v_to := case new.to_type when 'task' then (select workspace_id from public.tasks where id = new.to_id)
                           when 'project' then (select workspace_id from public.projects where id = new.to_id)
                           when 'contact' then (select workspace_id from public.contacts where id = new.to_id)
                           when 'follow_up' then (select workspace_id from public.follow_ups where id = new.to_id)
                           when 'note' then (select workspace_id from public.notes where id = new.to_id) end;
  if v_from is null or v_to is null then raise exception 'link_target_missing: the linked record does not exist'; end if;
  if v_from <> new.workspace_id or v_to <> new.workspace_id then raise exception 'link_cross_workspace: records must be in the same workspace'; end if;
  return new;
end $$;
create trigger record_links_check before insert or update on public.record_links for each row execute function public.record_links_check();

-- clean up links when either side is deleted
create or replace function public.record_links_cleanup()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_type text := case tg_table_name when 'notes' then 'note' when 'documents' then 'document' when 'tasks' then 'task'
                                         when 'projects' then 'project' when 'contacts' then 'contact' when 'follow_ups' then 'follow_up' end;
begin
  delete from public.record_links where (from_type = v_type and from_id = old.id) or (to_type = v_type and to_id = old.id);
  return old;
end $$;
create trigger notes_links_cleanup after delete on public.notes for each row execute function public.record_links_cleanup();
create trigger documents_links_cleanup after delete on public.documents for each row execute function public.record_links_cleanup();
create trigger tasks_links_cleanup after delete on public.tasks for each row execute function public.record_links_cleanup();
create trigger projects_links_cleanup after delete on public.projects for each row execute function public.record_links_cleanup();
create trigger contacts_links_cleanup after delete on public.contacts for each row execute function public.record_links_cleanup();
create trigger follow_ups_links_cleanup after delete on public.follow_ups for each row execute function public.record_links_cleanup();

create trigger notes_touch before update on public.notes for each row execute function public.touch_updated_at();
create trigger notes_audit after insert or update or delete on public.notes for each row execute function public.generic_audit();
create trigger documents_audit after insert or update or delete on public.documents for each row execute function public.generic_audit();

-- ---------- private storage bucket for documents ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('documents', 'documents', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

-- object path: <workspace_id>/<document_id>/<file name>
create or replace function public.storage_ws(path text)
returns uuid language plpgsql immutable set search_path = '' as $$
begin
  return (string_to_array(path, '/'))[1]::uuid;
exception when others then return null;
end $$;

create policy "documents bucket: members read" on storage.objects for select to authenticated
  using (bucket_id = 'documents' and public.is_ws_member(public.storage_ws(name)));
create policy "documents bucket: writers upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and public.can_write_ws(public.storage_ws(name)));
create policy "documents bucket: writers delete" on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and public.can_write_ws(public.storage_ws(name)));

-- ---------- goals, habits, health logs: private to the person (never shared) ----------
create table public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  parent_id uuid references public.goals(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  description text,
  horizon text not null default 'long_term' check (horizon in ('long_term','yearly','quarterly','monthly','weekly')),
  category text not null default 'other' check (category in ('career','business','health','finance','learning','family','personal','other')),
  target_value numeric(14,2),
  current_value numeric(14,2),
  unit text,
  start_date date,
  due_date date,
  status text not null default 'active' check (status in ('active','achieved','dropped')),
  achieved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint goal_not_own_parent check (parent_id is null or parent_id <> id)
);
create index goals_user_idx on public.goals(user_id);

create table public.goal_updates (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references public.goals(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  value numeric(14,2),
  note text,
  created_at timestamptz not null default now()
);
create index goal_updates_goal_idx on public.goal_updates(goal_id, created_at desc);

create table public.habits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  category text not null default 'personal' check (category in ('health','fitness','learning','family','work','finance','personal','other')),
  schedule text not null default 'daily' check (schedule in ('daily','days','weekly')),
  days int[] not null default '{0,1,2,3,4,5,6}',          -- 0 = Sunday … 6 = Saturday (used when schedule = 'days')
  per_week int not null default 1 check (per_week between 1 and 7), -- used when schedule = 'weekly'
  target_value numeric(10,2),
  unit text,
  goal_id uuid references public.goals(id) on delete set null,
  archived boolean not null default false,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  constraint habit_days check (days <@ '{0,1,2,3,4,5,6}' and cardinality(days) between 1 and 7)
);
create index habits_user_idx on public.habits(user_id);

create table public.habit_logs (
  habit_id uuid not null references public.habits(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  log_date date not null,
  value numeric(10,2),
  note text,
  created_at timestamptz not null default now(),
  primary key (habit_id, log_date)
);
create index habit_logs_user_idx on public.habit_logs(user_id, log_date desc);

create table public.health_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  log_date date not null,
  kind text not null check (kind in ('weight','workout','walk','wellness')),
  value numeric(10,2),
  unit text,
  duration_min int check (duration_min is null or duration_min between 0 and 1440),
  note text,
  created_at timestamptz not null default now(),
  constraint health_value check (kind = 'wellness' or value is not null or duration_min is not null)
);
create index health_logs_user_idx on public.health_logs(user_id, log_date desc);

create table public.weekly_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  week_start date not null,
  wins text, issues text, priorities text, notes text,
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, week_start)
);

create or replace function public.goals_before_write()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if new.status = 'achieved' and (tg_op = 'INSERT' or old.status <> 'achieved') then new.achieved_at := now(); end if;
  if new.status <> 'achieved' then new.achieved_at := null; end if;
  if new.parent_id is not null and not exists (select 1 from public.goals where id = new.parent_id and user_id = new.user_id) then
    raise exception 'bad_parent: an objective must sit under one of your own goals';
  end if;
  return new;
end $$;
create trigger goals_before_write before insert or update on public.goals for each row execute function public.goals_before_write();
create trigger weekly_reviews_touch before update on public.weekly_reviews for each row execute function public.touch_updated_at();

create or replace function public.habit_logs_check()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.habits where id = new.habit_id and user_id = new.user_id) then
    raise exception 'not_your_habit: you can only log your own habits';
  end if;
  if new.log_date > (now() at time zone 'Asia/Qatar')::date + 1 then raise exception 'future_log: you can''t log a habit in the future'; end if;
  return new;
end $$;
create trigger habit_logs_check before insert or update on public.habit_logs for each row execute function public.habit_logs_check();

-- ---------- RLS ----------
alter table public.notes enable row level security;
alter table public.documents enable row level security;
alter table public.record_links enable row level security;
alter table public.goals enable row level security;
alter table public.goal_updates enable row level security;
alter table public.habits enable row level security;
alter table public.habit_logs enable row level security;
alter table public.health_logs enable row level security;
alter table public.weekly_reviews enable row level security;

create policy "notes: members read" on public.notes for select to authenticated using (public.is_ws_member(workspace_id));
create policy "notes: writers add" on public.notes for insert to authenticated with check (created_by = (select auth.uid()) and public.can_write_ws(workspace_id));
create policy "notes: writers edit" on public.notes for update to authenticated using (public.can_write_ws(workspace_id)) with check (public.can_write_ws(workspace_id));
create policy "notes: author or owner deletes" on public.notes for delete to authenticated using (created_by = (select auth.uid()) or public.is_ws_owner(workspace_id));

create policy "documents: members read" on public.documents for select to authenticated using (public.is_ws_member(workspace_id));
create policy "documents: writers add" on public.documents for insert to authenticated with check (created_by = (select auth.uid()) and public.can_write_ws(workspace_id));
create policy "documents: writers edit" on public.documents for update to authenticated using (public.can_write_ws(workspace_id)) with check (public.can_write_ws(workspace_id));
create policy "documents: uploader or owner deletes" on public.documents for delete to authenticated using (created_by = (select auth.uid()) or public.is_ws_owner(workspace_id));

create policy "links: members read" on public.record_links for select to authenticated using (public.is_ws_member(workspace_id));
create policy "links: writers add" on public.record_links for insert to authenticated with check (public.can_write_ws(workspace_id));
create policy "links: writers remove" on public.record_links for delete to authenticated using (public.can_write_ws(workspace_id));

create policy "goals: own only" on public.goals for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "goal updates: own only" on public.goal_updates for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()) and exists (select 1 from public.goals g where g.id = goal_id and g.user_id = (select auth.uid())));
create policy "habits: own only" on public.habits for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "habit logs: own only" on public.habit_logs for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "health logs: own only" on public.health_logs for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "weekly reviews: own only" on public.weekly_reviews for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke execute on function public.record_links_check(), public.record_links_cleanup(), public.habit_logs_check(), public.goals_before_write() from public, anon, authenticated;

-- ---------- search: include notes (full-text) and documents ----------
create or replace function public.search_all(q text)
returns table (kind text, id uuid, title text, subtitle text, workspace_id uuid)
language sql stable security invoker set search_path = '' as $$
  with s as (select '%' || replace(replace(trim(q), '%', ''), '_', '') || '%' as p,
                    plainto_tsquery('simple', trim(q)) as tq)
  (select 'task'::text, t.id, t.title, coalesce(t.reference, t.client_name, t.next_action, ''), t.workspace_id from public.tasks t, s
    where t.deleted_at is null and (t.title ilike s.p or t.description ilike s.p or t.reference ilike s.p or t.client_name ilike s.p or t.next_action ilike s.p) limit 40)
  union all
  (select 'project'::text, p.id, p.name, coalesce(p.description, ''), p.workspace_id from public.projects p, s where p.name ilike s.p or p.description ilike s.p limit 15)
  union all
  (select 'follow_up'::text, f.id, f.subject, coalesce(f.counterpart, ''), f.workspace_id from public.follow_ups f, s where f.subject ilike s.p or f.counterpart ilike s.p or f.notes ilike s.p limit 15)
  union all
  (select 'contact'::text, c.id, c.name, coalesce(c.organisation, ''), c.workspace_id from public.contacts c, s where c.name ilike s.p or c.organisation ilike s.p or c.email ilike s.p limit 15)
  union all
  (select 'note'::text, n.id, n.title, left(coalesce(nullif(n.decision, ''), n.body), 120), n.workspace_id from public.notes n, s
    where n.deleted_at is null and (n.search @@ s.tq or n.title ilike s.p or public.tags_text(n.tags) ilike s.p)
    order by ts_rank(n.search, s.tq) desc limit 20)
  union all
  (select 'document'::text, d.id, d.title, d.category || coalesce(' · ' || d.notes, ''), d.workspace_id from public.documents d, s
    where d.deleted_at is null and (d.title ilike s.p or d.notes ilike s.p or public.tags_text(d.tags) ilike s.p) limit 15)
  union all
  (select 'comment'::text, c.task_id, t.title, left(c.body, 120), t.workspace_id from public.task_comments c join public.tasks t on t.id = c.task_id, s
    where c.kind = 'note' and c.body ilike s.p and t.deleted_at is null limit 15);
$$;

alter publication supabase_realtime add table public.notes, public.documents, public.record_links;
