-- Separate list membership from learning activation. Existing large legacy
-- imports are kept in the list but paused when they have never been reviewed.
update public.wordsbook_sync_records
set
  payload = jsonb_set(jsonb_set(payload, '{learningEnabled}', '1'::jsonb, true), '{autoActivate}', '0'::jsonb, true),
  updated_at = now(),
  source_client_id = 'server:learning-activation-migration'
where entity = 'studyListItems'
  and deleted_at is null
  and not (payload ? 'learningEnabled');

with legacy_candidates as (
  select
    memberships.user_id,
    memberships.record_id,
    count(*) over (partition by memberships.user_id) as unreviewed_count
  from public.wordsbook_sync_records memberships
  join public.wordsbook_sync_records lists
    on lists.user_id = memberships.user_id
   and lists.entity = 'studyLists'
   and lists.record_id = memberships.payload ->> 'listId'
   and lists.deleted_at is null
   and coalesce((lists.payload ->> 'studyEnabled')::integer, 0) = 1
  left join public.wordsbook_sync_records states
    on states.user_id = memberships.user_id
   and states.entity = 'reviewState'
   and states.record_id = memberships.payload ->> 'wordId'
   and states.deleted_at is null
  where memberships.entity = 'studyListItems'
    and memberships.deleted_at is null
    and coalesce(memberships.payload ->> 'source', 'migration') = 'migration'
    and coalesce((states.payload ->> 'reps')::integer, (states.payload ->> 'totalReviews')::integer, 0) = 0
)
update public.wordsbook_sync_records memberships
set
  payload = jsonb_set(jsonb_set(memberships.payload, '{learningEnabled}', '0'::jsonb, true), '{autoActivate}', '1'::jsonb, true),
  updated_at = now(),
  source_client_id = 'server:learning-activation-migration'
from legacy_candidates
where memberships.user_id = legacy_candidates.user_id
  and memberships.record_id = legacy_candidates.record_id
  and legacy_candidates.unreviewed_count >= 200
  and memberships.entity = 'studyListItems'
  and memberships.deleted_at is null
  and coalesce(memberships.payload ->> 'source', 'migration') = 'migration';

update public.wordsbook_sync_records
set
  payload = jsonb_set(jsonb_set(payload, '{learningEnabled}', '0'::jsonb, true), '{autoActivate}', '1'::jsonb, true),
  updated_at = now(),
  source_client_id = 'server:learning-activation-migration'
where entity = 'studyListItems'
  and deleted_at is null
  and payload ->> 'source' = 'import';
