alter table public.wordsbook_sync_records
drop constraint if exists wordsbook_sync_records_entity_check;

alter table public.wordsbook_sync_records
add constraint wordsbook_sync_records_entity_check check (
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
);

-- API keys are device-local from this release onward.
delete from public.wordsbook_sync_records
where entity = 'settings' and record_id = 'deepseekApiKey';
