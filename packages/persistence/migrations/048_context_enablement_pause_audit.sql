alter table harness_control.context_enablements add column paused_by text, add column paused_at timestamptz;
-- A pause may amend only its own operational fields; the enabled revision remains immutable.
create function harness_control.context_enablement_pause_only() returns trigger language plpgsql as $$
begin
 if old.paused or not new.paused or new.paused_by is null or new.paused_at is null
   or (to_jsonb(new) - array['paused','paused_by','paused_at']) is distinct from (to_jsonb(old) - array['paused','paused_by','paused_at'])
 then raise exception 'context.enablement_history_immutable'; end if;
 return new;
end $$;
create trigger context_enablement_pause_only before update on harness_control.context_enablements
for each row execute function harness_control.context_enablement_pause_only();
