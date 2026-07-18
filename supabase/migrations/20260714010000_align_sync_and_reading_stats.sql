alter table public.wordsbook_sync_records
drop constraint if exists wordsbook_sync_records_entity_check;

alter table public.wordsbook_sync_records
add constraint wordsbook_sync_records_entity_check check (
  entity in (
    'dictionaryEntries', 'wordbook', 'reviewState', 'reviewLogs', 'settings',
    'aiOverrides', 'aiOverrideHistory', 'studyLists', 'studyListItems',
    'readingSessions', 'contextAttempts', 'dailyLearningSessions',
    'dailyQueueItems', 'dailyQueueAttempts'
  )
);

create or replace view public.wordsbook_reading_generation_stats
with (security_invoker = true)
as
select
  user_id,
  count(*) filter (where deleted_at is null) as reading_sessions,
  coalesce(sum(
    case
      when deleted_at is not null then 0
      when payload ? 'generationAttemptCount'
        then greatest(0, (payload ->> 'generationAttemptCount')::integer)
      when payload ->> 'status' in ('streaming', 'enriching', 'ready', 'failed', 'completed') then 1
      else 0
    end
  ), 0)::bigint as generation_attempts,
  coalesce(sum(
    case
      when deleted_at is not null then 0
      when payload ? 'successfulGenerationCount'
        then greatest(0, (payload ->> 'successfulGenerationCount')::integer)
      when payload ->> 'status' in ('ready', 'completed') then 1
      else 0
    end
  ), 0)::bigint as successful_generations,
  max(updated_at) filter (where deleted_at is null) as last_generation_at
from public.wordsbook_sync_records
where entity = 'readingSessions'
group by user_id;

revoke all on public.wordsbook_reading_generation_stats from anon;
grant select on public.wordsbook_reading_generation_stats to authenticated;
