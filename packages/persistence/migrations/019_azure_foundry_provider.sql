alter table harness_admin.providers drop constraint if exists providers_kind_check;
alter table harness_admin.providers add constraint providers_kind_check
  check (kind in ('openrouter', 'openai_compatible', 'azure_foundry', 'recorded'));
