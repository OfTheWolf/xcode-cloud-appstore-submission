create table public.asc_release_config (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  validation_only boolean not null default true,
  submission_workflow_id text,
  submission_ref_id text
);
insert into public.asc_release_config (id) values (true);
create table public.asc_release_jobs (
  upload_id text primary key,
  state text not null default 'pending' check (state in
    ('pending', 'resolving', 'dispatching', 'dispatched', 'running', 'submitted', 'skipped', 'failed')),
  build_id text unique,
  build_number text,
  version text,
  source_run_id text,
  source_sha text,
  ci_run_id text unique,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.asc_release_config enable row level security;
alter table public.asc_release_jobs enable row level security;
revoke all on public.asc_release_config, public.asc_release_jobs from public, anon, authenticated;
grant select, insert, update on public.asc_release_config, public.asc_release_jobs to service_role;

-- Each webhook event remains durable even if the Edge worker stops after accepting it.
create function public.queue_asc_release() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.state = 'COMPLETE' then
    insert into public.asc_release_jobs (upload_id) values (new.instance_id)
    on conflict (upload_id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.queue_asc_release() from public, anon, authenticated;
create trigger queue_asc_release after insert on public.asc_build_events
for each row execute function public.queue_asc_release();

-- A claim is conditional, so overlapping invocations cannot dispatch the same job.
create function public.claim_asc_dispatch(p_upload_id text) returns setof public.asc_release_jobs
language sql security definer set search_path = '' as $$
  update public.asc_release_jobs set state = 'resolving', attempts = attempts + 1,
    updated_at = now(), last_error = null
  where upload_id = p_upload_id and state = 'pending' and attempts < 12
  returning *;
$$;
revoke all on function public.claim_asc_dispatch(text) from public, anon, authenticated;
grant execute on function public.claim_asc_dispatch(text) to service_role;
