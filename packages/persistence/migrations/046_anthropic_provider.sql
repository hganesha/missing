-- Anthropic's Messages API as a model provider kind (the official SDK transport in
-- packages/adapters/src/anthropic.ts). Existing rows are unchanged; the check only widens.
alter table harness_admin.providers drop constraint if exists providers_kind_check;
alter table harness_admin.providers add constraint providers_kind_check
  check (kind in ('openrouter', 'openai_compatible', 'anthropic', 'recorded'));
