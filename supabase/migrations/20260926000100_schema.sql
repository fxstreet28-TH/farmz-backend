-- FarmZ core schema.
-- Every table has RLS enabled. Clients (anon/authenticated) may only READ their own rows
-- (plus the shared daily mission board) and update their own email. All state changes go
-- through SECURITY DEFINER functions that only the service role (edge functions) can execute.

-- ---------------------------------------------------------------- players
create table public.players (
  id              uuid primary key references auth.users (id) on delete cascade,
  wallet          text not null unique check (wallet ~ '^0x[0-9a-f]{40}$'), -- lowercase
  email           text,
  coin_balance    bigint not null default 0 check (coin_balance >= 0),        -- cache of sum(coin_ledger.delta)
  claimable_farmz numeric(38, 18) not null default 0 check (claimable_farmz >= 0), -- cache of sum(farmz_ledger.delta)
  xp              int not null default 0 check (xp >= 0),
  level           int not null default 1 check (level >= 1),
  login_streak    int not null default 0,
  last_login_date date,                                   -- Asia/Bangkok calendar day
  last_active_at  timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------- farms / plots / animals
create table public.farms (
  id         uuid primary key default gen_random_uuid(),
  player_id  uuid not null unique references public.players (id) on delete cascade,
  level      int not null default 1,
  grid_size  int not null default 9 check (grid_size between 1 and 100),
  created_at timestamptz not null default now()
);

create table public.plots (
  id         uuid primary key default gen_random_uuid(),
  farm_id    uuid not null references public.farms (id) on delete cascade,
  slot       int not null,
  crop_id    text,
  planted_at timestamptz,
  ready_at   timestamptz,
  state      text not null default 'empty' check (state in ('empty', 'growing', 'ready')),
  unique (farm_id, slot),
  check ((state = 'empty') = (crop_id is null))
);

create table public.animals (
  id               uuid primary key default gen_random_uuid(),
  farm_id          uuid not null references public.farms (id) on delete cascade,
  type             text not null,
  fed_at           timestamptz,
  produce_ready_at timestamptz,
  created_at       timestamptz not null default now()
);
create index animals_farm_id_idx on public.animals (farm_id);

-- ---------------------------------------------------------------- inventory
create table public.inventory (
  id        uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players (id) on delete cascade,
  item      text not null,
  qty       int not null default 0 check (qty >= 0),
  cap       int not null default 100 check (cap > 0),
  unique (player_id, item),
  check (qty <= cap)
);

-- ---------------------------------------------------------------- missions
-- Template catalogue (config-as-data, admin editable). kind drives progress tracking.
create table public.mission_templates (
  key          text primary key,  -- e.g. harvest_20_crops
  kind         text not null check (kind in ('harvest_crops', 'feed_animals', 'sell_value', 'login_streak', 'complete_order')),
  target       int not null check (target > 0),
  reward_coin  bigint not null default 0 check (reward_coin >= 0),
  reward_farmz numeric(38, 18) not null default 0 check (reward_farmz >= 0),
  enabled      boolean not null default true
);

create table public.missions (
  id           uuid primary key default gen_random_uuid(),
  template     text not null references public.mission_templates (key),
  kind         text not null,
  reward_coin  bigint not null default 0,
  reward_farmz numeric(38, 18) not null default 0,
  active_date  date not null,
  target       int not null,
  unique (active_date, template)
);
create index missions_active_date_idx on public.missions (active_date);

create table public.mission_progress (
  id           uuid primary key default gen_random_uuid(),
  player_id    uuid not null references public.players (id) on delete cascade,
  mission_id   uuid not null references public.missions (id) on delete cascade,
  progress     int not null default 0,
  target       int not null,
  completed    boolean not null default false,
  completed_at timestamptz,
  unique (player_id, mission_id)
);
create index mission_progress_mission_idx on public.mission_progress (mission_id);

-- ---------------------------------------------------------------- ledgers (source of truth)
create table public.coin_ledger (
  id         uuid primary key default gen_random_uuid(),
  player_id  uuid not null references public.players (id) on delete cascade,
  delta      bigint not null check (delta <> 0),
  reason     text not null,
  ref        text,
  created_at timestamptz not null default now()
);
create index coin_ledger_player_idx on public.coin_ledger (player_id, created_at desc);
create index coin_ledger_ref_idx on public.coin_ledger (player_id, reason, ref);

-- Audit for claimable_farmz (mission rewards in, claims out, refunds).
create table public.farmz_ledger (
  id         uuid primary key default gen_random_uuid(),
  player_id  uuid not null references public.players (id) on delete cascade,
  delta      numeric(38, 18) not null check (delta <> 0),
  reason     text not null,
  ref        text,
  created_at timestamptz not null default now()
);
create index farmz_ledger_player_idx on public.farmz_ledger (player_id, created_at desc);

-- ---------------------------------------------------------------- claims
create table public.claims (
  id             uuid primary key default gen_random_uuid(),
  player_id      uuid not null references public.players (id) on delete cascade,
  account        text not null,                       -- lowercase wallet the signature is bound to
  amount         numeric(38, 18) not null check (amount > 0), -- FARMZ
  amount_wei     numeric(78, 0) not null check (amount_wei > 0),
  nonce          numeric(78, 0) not null,              -- uint256
  deadline       bigint not null,                      -- unix seconds
  signature      text,
  tx_hash        text,
  status         text not null default 'signed' check (status in ('signed', 'submitted', 'confirmed', 'failed')),
  failure_reason text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (account, nonce)
);
create index claims_player_idx on public.claims (player_id, created_at desc);

-- ---------------------------------------------------------------- internal (service-only)
create table public.auth_nonces (
  nonce      text primary key,
  wallet     text not null,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index auth_nonces_expires_idx on public.auth_nonces (expires_at);

create table public.action_log (
  id         bigint generated always as identity primary key,
  player_id  uuid not null references public.players (id) on delete cascade,
  action     text not null,
  created_at timestamptz not null default now()
);
create index action_log_lookup_idx on public.action_log (player_id, action, created_at desc);

-- ---------------------------------------------------------------- ledger -> balance cache
create function public._apply_coin_ledger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.players set coin_balance = coin_balance + new.delta where id = new.player_id;
  return new;
end $$;

create trigger coin_ledger_apply after insert on public.coin_ledger
  for each row execute function public._apply_coin_ledger();

create function public._apply_farmz_ledger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.players set claimable_farmz = claimable_farmz + new.delta where id = new.player_id;
  return new;
end $$;

create trigger farmz_ledger_apply after insert on public.farmz_ledger
  for each row execute function public._apply_farmz_ledger();

-- Ledgers are append-only.
create function public._forbid_mutation() returns trigger
language plpgsql set search_path = public as $$
begin
  raise exception 'FZ:LEDGER_APPEND_ONLY';
end $$;

create trigger coin_ledger_append_only before update or delete on public.coin_ledger
  for each row execute function public._forbid_mutation();
create trigger farmz_ledger_append_only before update or delete on public.farmz_ledger
  for each row execute function public._forbid_mutation();

-- ---------------------------------------------------------------- RLS
alter table public.players           enable row level security;
alter table public.farms             enable row level security;
alter table public.plots             enable row level security;
alter table public.animals           enable row level security;
alter table public.inventory         enable row level security;
alter table public.mission_templates enable row level security;
alter table public.missions          enable row level security;
alter table public.mission_progress  enable row level security;
alter table public.coin_ledger       enable row level security;
alter table public.farmz_ledger      enable row level security;
alter table public.claims            enable row level security;
alter table public.auth_nonces       enable row level security;
alter table public.action_log        enable row level security;

-- Defence in depth: clients get SELECT only (plus email update), never INSERT/UPDATE/DELETE.
revoke all on all tables in schema public from anon, authenticated;
grant select on public.players, public.farms, public.plots, public.animals, public.inventory,
  public.mission_templates, public.missions, public.mission_progress, public.coin_ledger,
  public.farmz_ledger, public.claims to authenticated;
grant update (email) on public.players to authenticated;

create policy players_select_own on public.players for select to authenticated
  using (id = (select auth.uid()));
create policy players_update_own_email on public.players for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy farms_select_own on public.farms for select to authenticated
  using (player_id = (select auth.uid()));
create policy plots_select_own on public.plots for select to authenticated
  using (exists (select 1 from public.farms f where f.id = farm_id and f.player_id = (select auth.uid())));
create policy animals_select_own on public.animals for select to authenticated
  using (exists (select 1 from public.farms f where f.id = farm_id and f.player_id = (select auth.uid())));
create policy inventory_select_own on public.inventory for select to authenticated
  using (player_id = (select auth.uid()));
create policy mission_progress_select_own on public.mission_progress for select to authenticated
  using (player_id = (select auth.uid()));
create policy coin_ledger_select_own on public.coin_ledger for select to authenticated
  using (player_id = (select auth.uid()));
create policy farmz_ledger_select_own on public.farmz_ledger for select to authenticated
  using (player_id = (select auth.uid()));
create policy claims_select_own on public.claims for select to authenticated
  using (player_id = (select auth.uid()));

-- The daily mission board is shared by everyone.
create policy mission_templates_select_all on public.mission_templates for select to authenticated using (true);
create policy missions_select_all on public.missions for select to authenticated using (true);

-- auth_nonces / action_log: RLS on, no policies => service role only.
