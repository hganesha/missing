-- Reviewed case source bindings reuse immutable revisions, tenant RLS and existing grants.
alter table harness_control.context_revisions drop constraint context_revisions_kind_check;
alter table harness_control.context_revisions add constraint context_revisions_kind_check check(kind in ('connection','resource','mapping','case-binding'));
