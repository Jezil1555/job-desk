-- Undo 20261030230000_ai_proposals (the AI history is lost — export it first). Deploy the previous assistant function too.
select cron.unschedule('jobdesk-ai-expire');
drop function if exists public.record_ai_decision(uuid, text, jsonb);
drop function if exists public.expire_ai_proposals();
drop table if exists public.ai_proposals;
