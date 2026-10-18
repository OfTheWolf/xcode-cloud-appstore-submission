-- App Store Connect integration events, separate from purchase notifications.
create table public.asc_build_events (
  event_id text primary key,
  event_type text not null check (event_type = 'buildUploadStateUpdated'),
  instance_id text not null,
  state text not null check (state in ('AWAITING_UPLOAD', 'PROCESSING', 'FAILED', 'COMPLETE')),
  payload jsonb not null,
  received_at timestamptz not null default now()
);
alter table public.asc_build_events enable row level security;
revoke all on public.asc_build_events from public, anon, authenticated;
grant select, insert on public.asc_build_events to service_role;
comment on table public.asc_build_events is
  'Authenticated build upload events. Recording COMPLETE does not authorize App Review submission.';
