-- Optional description and sub-items (a small checklist) on quick to-dos.
alter table public.quick_todos
  add column if not exists note text check (note is null or char_length(note) <= 4000),
  add column if not exists items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 100);
