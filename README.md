# Job Desk — personal command centre

Tasks, projects, follow-ups and notes & documents, goals & habits, reports and double-entry finance across QCloud, Dlusso, Fitness Hub, The Burgery and personal life. Installable on iPhone and Android.

- **Live:** https://job-desk-u8nj.onrender.com
- **Frontend:** plain ES modules in `public/` (no build step), installable PWA, push notifications.
- **Backend:** Supabase project `job-desk` — Postgres with row-level security, Auth, Realtime, Edge Function `send-push`, pg_cron reminders.
- **Hosting:** Render static site, auto-deploys on push to `main`.

## Docs
- `docs/RULES.md` — task, project, follow-up, reminder and access rules
- `docs/IMPLEMENTATION_LOG.md` — what changed, what was verified, open issues

## Development
```bash
npm test                                  # unit tests (rules, time zones)
npm run check                             # syntax-check every module
npm i --no-save @supabase/supabase-js@2.45.4 && python3 tests/e2e/run.py   # UI end-to-end (needs Python Playwright)
psql "$DATABASE_URL" -f supabase/tests/phase1_tests.sql   # database tests (rolled back; also phase2/phase3)
# local: create a db, run supabase/tests/local/stubs.sql, the migrations, then the test file
```
Migrations live in `supabase/migrations/` and are applied in order. After changing app files, bump `CACHE` in `public/sw.js` so installed phones update.
