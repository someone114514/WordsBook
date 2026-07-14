create table if not exists public.sync_allowed_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.sync_allowed_users enable row level security;
revoke all on table public.sync_allowed_users from anon, authenticated;
grant select on table public.sync_allowed_users to authenticated;

drop policy if exists "WordsBook users can select own allowlist row" on public.sync_allowed_users;
create policy "WordsBook users can select own allowlist row"
on public.sync_allowed_users
for select
to authenticated
using (user_id = (select auth.uid()));

create table if not exists public.wordsbook_sync_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  entity text not null check (
    entity in (
      'dictionaryEntries',
      'wordbook',
      'reviewState',
      'reviewLogs',
      'settings',
      'aiOverrides',
      'aiOverrideHistory',
      'studyLists',
      'studyListItems',
      'readingSessions',
      'contextAttempts'
    )
  ),
  record_id text not null,
  payload jsonb,
  updated_at timestamptz not null,
  deleted_at timestamptz,
  source_client_id text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, entity, record_id),
  check (payload is not null or deleted_at is not null)
);

create index if not exists wordsbook_sync_records_user_entity_updated_idx
on public.wordsbook_sync_records (user_id, entity, updated_at desc);

alter table public.wordsbook_sync_records enable row level security;

grant select, insert, update, delete on table public.wordsbook_sync_records to authenticated;
revoke all on table public.wordsbook_sync_records from anon;

drop policy if exists "WordsBook sync users can select own rows" on public.wordsbook_sync_records;
create policy "WordsBook sync users can select own rows"
on public.wordsbook_sync_records
for select
to authenticated
using (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.sync_allowed_users
    where sync_allowed_users.user_id = (select auth.uid())
  )
);

drop policy if exists "WordsBook sync users can insert own rows" on public.wordsbook_sync_records;
create policy "WordsBook sync users can insert own rows"
on public.wordsbook_sync_records
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.sync_allowed_users
    where sync_allowed_users.user_id = (select auth.uid())
  )
);

drop policy if exists "WordsBook sync users can update own rows" on public.wordsbook_sync_records;
create policy "WordsBook sync users can update own rows"
on public.wordsbook_sync_records
for update
to authenticated
using (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.sync_allowed_users
    where sync_allowed_users.user_id = (select auth.uid())
  )
)
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.sync_allowed_users
    where sync_allowed_users.user_id = (select auth.uid())
  )
);

drop policy if exists "WordsBook sync users can delete own rows" on public.wordsbook_sync_records;
create policy "WordsBook sync users can delete own rows"
on public.wordsbook_sync_records
for delete
to authenticated
using (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.sync_allowed_users
    where sync_allowed_users.user_id = (select auth.uid())
  )
);

-- After creating your Supabase Auth user, allow only that user to sync:
-- insert into public.sync_allowed_users (user_id) values ('00000000-0000-0000-0000-000000000000');
