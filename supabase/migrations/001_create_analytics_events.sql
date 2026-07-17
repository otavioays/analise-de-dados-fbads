create extension if not exists pgcrypto;

create table if not exists public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique,
  event_name text not null check (event_name ~ '^[a-z][a-z0-9_]{0,63}$'),
  visitor_id uuid not null,
  session_id uuid not null,
  client_timestamp timestamptz not null,
  received_at timestamptz not null default now(),

  page_url text not null,
  page_path text,
  page_title text,
  referrer text,

  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  fbclid text,

  device_type text check (
    device_type is null or device_type in ('mobile', 'tablet', 'desktop')
  ),
  screen_width integer check (
    screen_width is null or (screen_width >= 0 and screen_width <= 20000)
  ),
  language text,
  properties jsonb not null default '{}'::jsonb
);

create index if not exists analytics_events_received_at_idx
  on public.analytics_events (received_at desc);

create index if not exists analytics_events_event_name_idx
  on public.analytics_events (event_name, received_at desc);

create index if not exists analytics_events_session_id_idx
  on public.analytics_events (session_id, client_timestamp);

create index if not exists analytics_events_visitor_id_idx
  on public.analytics_events (visitor_id, client_timestamp);

create index if not exists analytics_events_campaign_idx
  on public.analytics_events (utm_campaign, utm_content, received_at desc);

alter table public.analytics_events enable row level security;

comment on table public.analytics_events is
  'Private first-party events collected by the conversion tracker. Writes occur through the server-side service role.';
