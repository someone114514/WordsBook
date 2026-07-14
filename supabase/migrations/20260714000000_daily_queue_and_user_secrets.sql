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

create table if not exists public.wordsbook_user_secrets (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  secret_value text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

create index if not exists wordsbook_user_secrets_user_id_idx
on public.wordsbook_user_secrets (user_id);

alter table public.wordsbook_user_secrets enable row level security;
revoke all on table public.wordsbook_user_secrets from anon;
grant select, insert, update, delete on table public.wordsbook_user_secrets to authenticated;

drop policy if exists "users read own wordsbook secrets" on public.wordsbook_user_secrets;
create policy "users read own wordsbook secrets" on public.wordsbook_user_secrets
for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "users insert own wordsbook secrets" on public.wordsbook_user_secrets;
create policy "users insert own wordsbook secrets" on public.wordsbook_user_secrets
for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists "users update own wordsbook secrets" on public.wordsbook_user_secrets;
create policy "users update own wordsbook secrets" on public.wordsbook_user_secrets
for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists "users delete own wordsbook secrets" on public.wordsbook_user_secrets;
create policy "users delete own wordsbook secrets" on public.wordsbook_user_secrets
for delete to authenticated using (user_id = (select auth.uid()));

delete from public.wordsbook_sync_records
where entity = 'settings' and record_id = 'deepseekApiKey';
