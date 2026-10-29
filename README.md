# Job Desk

Personal task and progress tracker across projects (D'Lusso & Mediate, QCLOUD, Fitness Hub, The Burgery, and any you add). Installable on iPhone and Android as a home-screen app.

- **Frontend:** plain HTML/CSS/JS in `public/`, no build step. Installable PWA with offline app shell.
- **Backend:** Supabase project `job-desk` (Mumbai). Tables `projects`, `tasks`, `task_updates`, all with row-level security so each login only sees its own rows. Live sync via Supabase Realtime.
- **Hosting:** Render static site, publishes `public/`. Auto-deploys on push to `main`.

## Changing things

- Supabase URL and public key live in `public/config.js`.
- After changing app files, bump `CACHE` in `public/sw.js` so installed phones pick up the new version.
