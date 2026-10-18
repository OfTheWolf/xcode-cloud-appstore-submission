-- Integration test for the deployed queue; all synthetic records roll back.
begin;
insert into public.asc_build_events(event_id, event_type, instance_id, state, payload)
values ('queue-integration-complete', 'buildUploadStateUpdated', 'queue-integration-upload', 'COMPLETE', '{}')
on conflict (event_id) do nothing;
insert into public.asc_build_events(event_id, event_type, instance_id, state, payload)
values ('queue-integration-complete-duplicate', 'buildUploadStateUpdated', 'queue-integration-upload', 'COMPLETE', '{}')
on conflict (event_id) do nothing;
do $$
begin
  if (select count(*) from public.asc_release_jobs where upload_id = 'queue-integration-upload') <> 1 then
    raise exception 'Duplicate upload queued multiple jobs';
  end if;
  if (select count(*) from public.claim_asc_dispatch('queue-integration-upload')) <> 1 then
    raise exception 'First dispatch claim failed';
  end if;
  if (select count(*) from public.claim_asc_dispatch('queue-integration-upload')) <> 0 then
    raise exception 'Second dispatch claim was allowed';
  end if;
  if has_table_privilege('anon', 'public.asc_release_jobs', 'SELECT') or
     has_table_privilege('authenticated', 'public.asc_release_jobs', 'SELECT') then
    raise exception 'Release jobs are readable by app clients';
  end if;
end;
$$;
rollback;
select 'queue integration assertions passed; synthetic records rolled back' as result;
