-- Increment 9 tests (custom fields and project templates). Run inside begin … rollback. Throwaway users and workspaces only.
create temp table r (name text, ok boolean, detail text);
create temp table ids (k text primary key, v uuid);
grant all on r, ids to authenticated;
create or replace function pg_temp.err(p_name text, p_sql text, p_code text) returns void language plpgsql as $$
begin execute p_sql; insert into r values (p_name, false, 'no error');
exception when others then insert into r values (p_name, sqlerrm like p_code || '%', sqlerrm); end $$;
grant execute on function pg_temp.err(text, text, text) to authenticated;
create or replace function pg_temp.id(k text) returns uuid language sql stable as $$ select v from ids where ids.k = $1 $$;
grant execute on function pg_temp.id(text) to authenticated;
create or replace function pg_temp.as_user(u text) returns void language sql as $$ select set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true) $$;
grant execute on function pg_temp.as_user(text) to authenticated;
insert into auth.users (id, email, aud, role, instance_id) values
 ('aaaaaaaa-0000-4000-8000-0000000009a9','i9a@example.invalid','authenticated','authenticated','00000000-0000-0000-0000-000000000000'),
 ('bbbbbbbb-0000-4000-8000-0000000009b9','i9b@example.invalid','authenticated','authenticated','00000000-0000-0000-0000-000000000000'),
 ('cccccccc-0000-4000-8000-0000000009c9','i9c@example.invalid','authenticated','authenticated','00000000-0000-0000-0000-000000000000');
insert into public.profiles (id, email, display_name, timezone) values ('aaaaaaaa-0000-4000-8000-0000000009a9', 'i9a@example.invalid', 'I9 A', 'Asia/Qatar') on conflict (id) do update set timezone = 'Asia/Qatar';
with w as (insert into public.workspaces (name, owner_id) values ('I9 Dlusso', 'aaaaaaaa-0000-4000-8000-0000000009a9') returning id) insert into ids select 'ws', id from w;
with w as (insert into public.workspaces (name, owner_id) values ('I9 Other', 'aaaaaaaa-0000-4000-8000-0000000009a9') returning id) insert into ids select 'ws2', id from w;
insert into public.workspace_members (workspace_id, user_id, role) values (pg_temp.id('ws'), 'aaaaaaaa-0000-4000-8000-0000000009a9', 'owner'),
  (pg_temp.id('ws2'), 'aaaaaaaa-0000-4000-8000-0000000009a9', 'owner'), (pg_temp.id('ws'), 'bbbbbbbb-0000-4000-8000-0000000009b9', 'viewer') on conflict do nothing;
set local role authenticated;
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-0000000009a9');
-- 1. field definitions
with f as (insert into public.field_defs (workspace_id, key, label, type, options, required) values (pg_temp.id('ws'), 'fabric', 'Fabric', 'select', '{Wool,Linen," Cotton "}', false) returning id) insert into ids select 'f_fabric', id from f;
insert into public.field_defs (workspace_id, key, label, type) values (pg_temp.id('ws'), 'chest_cm', 'Chest (cm)', 'number'), (pg_temp.id('ws'), 'fitting_date', 'Fitting date', 'date');
with f as (insert into public.field_defs (workspace_id, key, label, type, required) values (pg_temp.id('ws'), 'qc_passed', 'QC passed', 'checkbox', true) returning id) insert into ids select 'f_qc', id from f;
insert into r select 'select options are trimmed', (select options = '{Cotton,Linen,Wool}' from public.field_defs where id = pg_temp.id('f_fabric')), (select options::text from public.field_defs where id = pg_temp.id('f_fabric'));
select pg_temp.err('select field needs choices', format('insert into public.field_defs (workspace_id, key, label, type) values (%L, $q$lining$q$, $q$Lining$q$, $q$select$q$)', pg_temp.id('ws')), 'new row');
select pg_temp.err('keys are unique in a workspace', format('insert into public.field_defs (workspace_id, key, label, type) values (%L, $q$fabric$q$, $q$Fabric 2$q$, $q$text$q$)', pg_temp.id('ws')), 'duplicate key');
select pg_temp.err('field type can''t change', format('update public.field_defs set type = $q$text$q$ where id = %L', pg_temp.id('f_fabric')), 'field_locked');
-- 2. values on tasks
with t as (insert into public.tasks (workspace_id, title, custom) values (pg_temp.id('ws'), 'Navy suit for Mr Khalid', '{"fabric":"Wool","chest_cm":102,"fitting_date":"2026-11-04"}') returning id) insert into ids select 't', id from t;
insert into r select 'valid values are stored', (select custom = '{"fabric":"Wool","chest_cm":102,"fitting_date":"2026-11-04"}'::jsonb from public.tasks where id = pg_temp.id('t')), null;
select pg_temp.err('select value must be a choice', format('update public.tasks set custom = custom || $q${"fabric":"Silk"}$q$ where id = %L', pg_temp.id('t')), 'bad_value');
select pg_temp.err('number field refuses text', format('update public.tasks set custom = custom || $q${"chest_cm":"102cm"}$q$ where id = %L', pg_temp.id('t')), 'bad_value');
select pg_temp.err('date field refuses a bad date', format('update public.tasks set custom = custom || $q${"fitting_date":"2026-13-40"}$q$ where id = %L', pg_temp.id('t')), '');
select pg_temp.err('unknown keys are refused', format('update public.tasks set custom = custom || $q${"colour":"navy"}$q$ where id = %L', pg_temp.id('t')), 'unknown_field');
with t as (insert into public.tasks (workspace_id, title) values (pg_temp.id('ws2'), 'Other ws task') returning id) insert into ids select 't2', id from t;
select pg_temp.err('fields from another workspace don''t apply', format('update public.tasks set custom = $q${"fabric":"Wool"}$q$ where id = %L', pg_temp.id('t2')), 'unknown_field');
update public.tasks set custom = custom || '{"chest_cm":104}' where id = pg_temp.id('t');
insert into r select 'value change is logged in task history', exists (select 1 from public.activity where entity_id = pg_temp.id('t') and action = 'fields_changed' and changes->'custom'->'chest_cm' = '[102,104]'::jsonb), null;
update public.tasks set custom = custom || '{"fitting_date":null}' where id = pg_temp.id('t');
insert into r select 'clearing a value removes it', (select not (custom ? 'fitting_date') from public.tasks where id = pg_temp.id('t')), null;
-- 3. required on completion
select pg_temp.err('required field blocks completion', format('update public.tasks set status = $q$completed$q$ where id = %L', pg_temp.id('t')), 'field_required: fill in QC passed');
update public.tasks set custom = custom || '{"qc_passed":true}' where id = pg_temp.id('t');
update public.tasks set status = 'completed' where id = pg_temp.id('t');
insert into r select 'completes once the required field is filled', (select status = 'completed' from public.tasks where id = pg_temp.id('t')), null;
-- 4. archived field: existing value kept, new values refused
update public.field_defs set archived = true where id = pg_temp.id('f_fabric');
update public.tasks set custom = custom || '{"chest_cm":105}' where id = pg_temp.id('t');
insert into r select 'archived field keeps its value when other fields change', (select custom->>'fabric' = 'Wool' and (custom->>'chest_cm')::int = 105 from public.tasks where id = pg_temp.id('t')), null;
select pg_temp.err('archived field takes no new values', format('update public.tasks set custom = custom || $q${"fabric":"Linen"}$q$ where id = %L', pg_temp.id('t')), 'unknown_field');
update public.field_defs set archived = true where id = pg_temp.id('f_qc');
-- 5. project-scoped field and template from a project
with p as (insert into public.projects (workspace_id, name, start_date) values (pg_temp.id('ws'), 'Wedding party — 6 suits', '2026-11-01') returning id) insert into ids select 'p', id from p;
with m as (insert into public.milestones (project_id, title, planned_date, weight, sort) values (pg_temp.id('p'), 'Measurements', '2026-11-03', 1, 0) returning id) insert into ids select 'm1', id from m;
with m as (insert into public.milestones (project_id, title, planned_date, weight, is_critical, sort) values (pg_temp.id('p'), 'Delivery', '2026-11-30', 2, true, 1) returning id) insert into ids select 'm2', id from m;
insert into public.field_defs (workspace_id, project_id, key, label, type, required) values (pg_temp.id('ws'), pg_temp.id('p'), 'groom_name', 'Groom', 'text', true);
insert into public.tasks (workspace_id, project_id, milestone_id, title, priority, due_at, completion_criteria, custom) values
  (pg_temp.id('ws'), pg_temp.id('p'), pg_temp.id('m1'), 'Take measurements', 'high', '2026-11-03 20:59:00+00', '[{"text":"All six measured","done":true}]', '{"groom_name":"Faisal","chest_cm":100}'),
  (pg_temp.id('ws'), pg_temp.id('p'), pg_temp.id('m2'), 'Final fitting', 'medium', '2026-11-27 20:59:00+00', '[]', '{}');
select pg_temp.err('project fields only apply inside that project', format('update public.tasks set custom = $q${"groom_name":"x"}$q$ where id = %L', pg_temp.id('t2')), 'unknown_field');
insert into ids select 'tpl', public.save_project_as_template(pg_temp.id('p'), 'Wedding party', null);
insert into r select 'template keeps structure, not data', (select body->'tasks'->0->>'title' = 'Take measurements' and (body->'tasks'->0->>'offset_days')::int = 2 and (body->'tasks'->0->>'milestone')::int = 0
  and body->'tasks'->0->'criteria' = '["All six measured"]'::jsonb and not (body->'tasks'->0 ? 'custom') and (body->'milestones'->1->>'offset_days')::int = 29
  and body->'fields'->0->>'key' = 'groom_name' from public.project_templates where id = pg_temp.id('tpl')), (select body::text from public.project_templates where id = pg_temp.id('tpl'));
-- 6. new project from the template
select pg_temp.err('a start date is required', format('select public.create_project_from_template(%L, $q$x$q$, null)', pg_temp.id('tpl')), 'start_required');
insert into ids select 'np', public.create_project_from_template(pg_temp.id('tpl'), 'Al Thani wedding', '2027-01-10');
insert into r select 'project dates counted from the chosen start', (select start_date = '2027-01-10' and target_date = '2027-02-08' and baseline_target_date is null from public.projects where id = pg_temp.id('np')), null;
insert into r select 'milestones recreated with dates and weights', (select count(*) = 2 and bool_and(case title when 'Measurements' then planned_date = '2027-01-12' else planned_date = '2027-02-08' and weight = 2 and is_critical end) from public.milestones where project_id = pg_temp.id('np')), null;
insert into r select 'tasks recreated, open, unticked, due at 23:59 Doha on the offset day', (select count(*) = 2 and bool_and(status <> 'completed' and custom = '{}'::jsonb) from public.tasks where project_id = pg_temp.id('np'))
  and (select (due_at at time zone 'Asia/Qatar') = '2027-01-12 23:59' and completion_criteria = '[{"text":"All six measured","done":false}]'::jsonb and milestone_id = (select id from public.milestones where project_id = pg_temp.id('np') and title = 'Measurements')
       from public.tasks where project_id = pg_temp.id('np') and title = 'Take measurements'), null;
insert into r select 'the project''s own field is reused, not duplicated', (select count(*) = 1 from public.field_defs where workspace_id = pg_temp.id('ws') and key = 'groom_name' and not archived), null;
insert into r select 'creation is recorded', exists (select 1 from public.activity where entity_id = pg_temp.id('np') and action = 'created_from_template'), null;
-- 7. validation and access
select pg_temp.err('bad template bodies are refused', format('insert into public.project_templates (workspace_id, name, body) values (%L, $q$x$q$, $q${"tasks":[{"title":"a","milestone":3}]}$q$)', pg_temp.id('ws')), 'bad_template');
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-0000000009b9');
insert into r select 'viewers can see templates and fields', (select count(*) from public.project_templates where workspace_id = pg_temp.id('ws')) = 1 and (select count(*) from public.field_defs where workspace_id = pg_temp.id('ws')) >= 4, null;
select pg_temp.err('viewers can''t use templates', format('select public.create_project_from_template(%L, $q$x$q$, $q$2027-01-01$q$)', pg_temp.id('tpl')), 'forbidden');
select pg_temp.err('viewers can''t add fields', format('insert into public.field_defs (workspace_id, key, label, type) values (%L, $q$v$q$, $q$V$q$, $q$text$q$)', pg_temp.id('ws')), 'new row');
select pg_temp.as_user('cccccccc-0000-4000-8000-0000000009c9');
insert into r select 'outsiders see no templates or fields', (select count(*) from public.project_templates) + (select count(*) from public.field_defs) = 0, null;
select pg_temp.err('outsiders can''t use templates', format('select public.create_project_from_template(%L, $q$x$q$, $q$2027-01-01$q$)', pg_temp.id('tpl')), 'not_found');
reset role;
select count(*) filter (where ok) passed, count(*) total, json_agg(json_build_object('n', name, 'd', detail)) filter (where not ok) failures from r;
