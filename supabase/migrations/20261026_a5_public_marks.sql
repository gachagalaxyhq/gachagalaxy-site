-- A5: public, read-only Gacha Mark records. No user data. Writes = service role only.
begin;
create table if not exists public.marks (
  grader       text not null default 'PSA' check (grader in ('PSA')),
  cert         text not null check (cert ~ '^[0-9]{6,12}$'),
  card_name    text not null,
  card_no      text,
  set_name     text,
  year         text,
  grade        text not null,
  grade_label  text,
  low_usd      numeric(12,2) not null,
  point_usd    numeric(12,2) not null,
  high_usd     numeric(12,2) not null,
  confidence   smallint not null check (confidence between 0 and 100),
  prices_used  integer,
  price_basis  text not null default 'asks',
  img_url      text,
  qr_svg       text,
  network      text not null check (network in ('robinhood-mainnet','robinhood-testnet')),
  kind         text not null default 'mark' check (kind in ('mark','example')),
  revoked      boolean not null default false,
  revoked_reason text,
  visible      boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (grader, cert)
);
create table if not exists public.mark_events (
  id           bigint generated always as identity primary key,
  grader       text not null,
  cert         text not null,
  published_at timestamptz not null,
  low_usd      numeric(12,2) not null,
  point_usd    numeric(12,2) not null,
  high_usd     numeric(12,2) not null,
  chain_id     integer not null,
  registry     text not null,
  tx           text not null check (tx ~ '^0x[0-9a-fA-F]{64}$'),
  explorer     text not null,
  unique (chain_id, tx),
  foreign key (grader, cert) references public.marks (grader, cert) on delete cascade
);
create index if not exists mark_events_cert_idx on public.mark_events (grader, cert, published_at desc);
alter table public.marks enable row level security;
alter table public.mark_events enable row level security;
drop policy if exists "public read visible marks" on public.marks;
create policy "public read visible marks" on public.marks for select to anon, authenticated using (visible);
drop policy if exists "public read events of visible marks" on public.mark_events;
create policy "public read events of visible marks" on public.mark_events for select to anon, authenticated
  using (exists (select 1 from public.marks m where m.grader = mark_events.grader and m.cert = mark_events.cert and m.visible));
revoke all on public.marks, public.mark_events from anon, authenticated;
grant select on public.marks, public.mark_events to anon, authenticated;
commit;
