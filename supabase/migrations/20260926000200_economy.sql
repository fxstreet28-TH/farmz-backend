-- Server-authoritative game logic. Every function here is SECURITY DEFINER and executable by
-- service_role only (see bottom). Edge functions authenticate the player, resolve game config
-- (crops/animals/items from supabase/functions/_shared/config.ts) and call these RPCs.
-- Time always comes from the DB clock (now()), never from the client.
-- Errors are raised as 'FZ:<CODE>' and mapped to HTTP responses by the edge layer.

-- ---------------------------------------------------------------- helpers
create function public._today() returns date
language sql stable set search_path = public as $$
  select (now() at time zone 'Asia/Bangkok')::date
$$;

create function public._fz(p_code text, p_detail text default null) returns void
language plpgsql set search_path = public as $$
begin
  raise exception using message = 'FZ:' || p_code, detail = coalesce(p_detail, '');
end $$;

-- Per-player action rate limits (max actions per 60 s window).
create function public._rate_limit(p_action text) returns int
language sql immutable set search_path = public as $$
  select case p_action
    when 'plant' then 120 when 'harvest' then 120 when 'feed' then 120 when 'collect' then 120
    when 'sell' then 30 when 'buy' then 30 when 'order' then 10 when 'claim' then 5
    when 'checkin' then 10 when 'mission' then 60
    else 60 end
$$;

create function public._throttle(p_player uuid, p_action text) returns void
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  select count(*) into n from action_log
   where player_id = p_player and action = p_action and created_at > now() - interval '60 seconds';
  if n >= _rate_limit(p_action) then
    perform _fz('RATE_LIMITED', p_action);
  end if;
  insert into action_log (player_id, action) values (p_player, p_action);
  update players set last_active_at = now() where id = p_player;
end $$;

create function public._coin(p_player uuid, p_delta bigint, p_reason text, p_ref text) returns void
language plpgsql security definer set search_path = public as $$
declare bal bigint;
begin
  if p_delta = 0 then return; end if;
  select coin_balance into bal from players where id = p_player for update;
  if not found then perform _fz('PLAYER_NOT_FOUND'); end if;
  if bal + p_delta < 0 then
    perform _fz('INSUFFICIENT_COINS', format('need %s, have %s', -p_delta, bal));
  end if;
  insert into coin_ledger (player_id, delta, reason, ref) values (p_player, p_delta, p_reason, p_ref);
end $$;

create function public._farmz(p_player uuid, p_delta numeric, p_reason text, p_ref text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_delta = 0 then return; end if;
  insert into farmz_ledger (player_id, delta, reason, ref) values (p_player, p_delta, p_reason, p_ref);
end $$;

create function public._inv_add(p_player uuid, p_item text, p_qty int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_qty <= 0 then perform _fz('BAD_QTY'); end if;
  begin
    insert into inventory (player_id, item, qty) values (p_player, p_item, p_qty)
    on conflict (player_id, item) do update set qty = inventory.qty + excluded.qty;
  exception when check_violation then
    perform _fz('INVENTORY_FULL', p_item);
  end;
end $$;

create function public._inv_remove(p_player uuid, p_item text, p_qty int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_qty <= 0 then perform _fz('BAD_QTY'); end if;
  update inventory set qty = qty - p_qty where player_id = p_player and item = p_item and qty >= p_qty;
  if not found then perform _fz('NOT_ENOUGH_ITEMS', p_item); end if;
end $$;

create function public._add_xp(p_player uuid, p_xp int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_xp <= 0 then return; end if;
  update players set xp = xp + p_xp, level = ((xp + p_xp) / 100) + 1 where id = p_player;
end $$;

create function public._farm_id(p_player uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare fid uuid;
begin
  select id into fid from farms where player_id = p_player;
  if fid is null then perform _fz('FARM_NOT_FOUND'); end if;
  return fid;
end $$;

-- ---------------------------------------------------------------- daily missions
-- Picks one template per kind for the day (deterministic per date), then creates
-- mission_progress for players active in the last 7 days. Scheduled by pg_cron at
-- 00:00 Asia/Bangkok; also invoked lazily if the cron has not run yet for today.
create function public.generate_daily_missions(p_date date default null) returns int
language plpgsql security definer set search_path = public as $$
declare d date := coalesce(p_date, _today()); n int;
begin
  if not exists (select 1 from missions where active_date = d) then
    insert into missions (template, kind, reward_coin, reward_farmz, active_date, target)
    select distinct on (kind) key, kind, reward_coin, reward_farmz, d, target
      from mission_templates where enabled
     order by kind, md5(key || d::text)
    on conflict (active_date, template) do nothing;
  end if;

  insert into mission_progress (player_id, mission_id, target)
  select p.id, m.id, m.target
    from players p cross join missions m
   where m.active_date = d and p.last_active_at > now() - interval '7 days'
  on conflict (player_id, mission_id) do nothing;
  get diagnostics n = row_count;

  -- housekeeping
  delete from auth_nonces where expires_at < now() - interval '1 day';
  delete from action_log where created_at < now() - interval '2 days';
  return n;
end $$;

create function public._ensure_player_missions(p_player uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d date := _today();
begin
  if not exists (select 1 from missions where active_date = d) then
    perform generate_daily_missions(d);
  end if;
  insert into mission_progress (player_id, mission_id, target)
  select p_player, m.id, m.target from missions m where m.active_date = d
  on conflict (player_id, mission_id) do nothing;
end $$;

-- Adds progress to today's missions of the given kind; pays out on completion.
-- p_mode 'add' increments, 'max' sets progress to max(progress, amount) (login streak).
create function public._mission_bump(p_player uuid, p_kind text, p_amount int, p_mode text default 'add')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record;
  newp int;
  done jsonb := '[]'::jsonb;
begin
  if p_amount <= 0 then return done; end if;
  perform _ensure_player_missions(p_player);
  for r in
    select mp.id as mp_id, mp.progress, mp.target, m.id as mission_id, m.template, m.reward_coin, m.reward_farmz
      from mission_progress mp join missions m on m.id = mp.mission_id
     where mp.player_id = p_player and m.active_date = _today() and m.kind = p_kind and not mp.completed
     for update of mp
  loop
    newp := case when p_mode = 'max' then greatest(r.progress, p_amount) else r.progress + p_amount end;
    newp := least(newp, r.target);
    if newp >= r.target then
      update mission_progress set progress = newp, completed = true, completed_at = now() where id = r.mp_id;
      perform _coin(p_player, r.reward_coin, 'mission', r.mission_id::text);
      perform _farmz(p_player, r.reward_farmz, 'mission', r.mission_id::text);
      done := done || jsonb_build_object('mission_id', r.mission_id, 'template', r.template,
                'reward_coin', r.reward_coin, 'reward_farmz', r.reward_farmz::text);
    elsif newp <> r.progress then
      update mission_progress set progress = newp where id = r.mp_id;
    end if;
  end loop;
  return done;
end $$;

-- Internal entry point (edge function `mission-progress`, service role only).
create function public.mission_progress_add(p_player uuid, p_kind text, p_amount int) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform _throttle(p_player, 'mission');
  return jsonb_build_object('completed', _mission_bump(p_player, p_kind, p_amount, 'add'));
end $$;

-- ---------------------------------------------------------------- state
create function public.game_state(p_player uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare fid uuid := _farm_id(p_player);
begin
  update plots set state = 'ready' where farm_id = fid and state = 'growing' and ready_at <= now();
  perform _ensure_player_missions(p_player);
  return jsonb_build_object(
    'server_time', now(),
    'player', (select jsonb_build_object('id', id, 'wallet', wallet, 'email', email,
                 'coin_balance', coin_balance, 'claimable_farmz', claimable_farmz::text,
                 'xp', xp, 'level', level, 'login_streak', login_streak)
                 from players where id = p_player),
    'farm', (select to_jsonb(f) from farms f where f.id = fid),
    'plots', coalesce((select jsonb_agg(to_jsonb(p) order by p.slot) from plots p where p.farm_id = fid), '[]'),
    'animals', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from animals a where a.farm_id = fid), '[]'),
    'inventory', coalesce((select jsonb_agg(jsonb_build_object('item', item, 'qty', qty, 'cap', cap) order by item)
                  from inventory where player_id = p_player and qty > 0), '[]'),
    'missions', coalesce((select jsonb_agg(jsonb_build_object('mission_id', m.id, 'template', m.template,
                  'kind', m.kind, 'progress', mp.progress, 'target', mp.target, 'completed', mp.completed,
                  'reward_coin', m.reward_coin, 'reward_farmz', m.reward_farmz::text) order by m.kind)
                  from mission_progress mp join missions m on m.id = mp.mission_id
                  where mp.player_id = p_player and m.active_date = _today()), '[]')
  );
end $$;

-- ---------------------------------------------------------------- bootstrap / check-in
-- Creates the player (+farm, plots, signup bonus) on first login and updates the login streak.
create function public.econ_bootstrap(p_player uuid, p_wallet text, p_grid_size int, p_start_coins bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  w text := lower(p_wallet);
  fid uuid;
  today date := _today();
  v_last date;
  streak int;
  done jsonb;
begin
  insert into players (id, wallet) values (p_player, w) on conflict (id) do nothing;
  if found then
    insert into farms (player_id, grid_size) values (p_player, p_grid_size) returning id into fid;
    insert into plots (farm_id, slot) select fid, s from generate_series(0, p_grid_size - 1) s;
    perform _coin(p_player, p_start_coins, 'signup_bonus', null);
  elsif (select wallet from players where id = p_player) <> w then
    perform _fz('WALLET_MISMATCH');
  end if;

  perform _throttle(p_player, 'checkin');
  select last_login_date, login_streak into v_last, streak from players where id = p_player for update;
  if v_last is distinct from today then
    streak := case when v_last = today - 1 then streak + 1 else 1 end;
    update players set login_streak = streak, last_login_date = today where id = p_player;
  end if;

  done := _mission_bump(p_player, 'login_streak', streak, 'max');
  return jsonb_build_object('player_id', p_player, 'login_streak', streak, 'completed_missions', done);
end $$;

-- ---------------------------------------------------------------- crops
create function public.econ_plant(p_player uuid, p_plot uuid, p_crop text, p_seed_cost bigint,
                                  p_grow_seconds int, p_min_level int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare pl plots%rowtype; lvl int;
begin
  perform _throttle(p_player, 'plant');
  select p.* into pl from plots p join farms f on f.id = p.farm_id
   where p.id = p_plot and f.player_id = p_player for update of p;
  if not found then perform _fz('PLOT_NOT_FOUND'); end if;
  if pl.state <> 'empty' then perform _fz('PLOT_NOT_EMPTY'); end if;
  select level into lvl from players where id = p_player;
  if lvl < p_min_level then perform _fz('LEVEL_TOO_LOW', format('requires level %s', p_min_level)); end if;
  if p_seed_cost <= 0 or p_grow_seconds <= 0 then perform _fz('BAD_CONFIG'); end if;

  perform _coin(p_player, -p_seed_cost, 'plant:' || p_crop, p_plot::text);
  update plots set crop_id = p_crop, planted_at = now(),
                   ready_at = now() + make_interval(secs => p_grow_seconds), state = 'growing'
   where id = p_plot returning * into pl;
  return to_jsonb(pl);
end $$;

-- p_crops: {"<crop>": {"yield": int, "xp": int}, ...}
create function public.econ_harvest(p_player uuid, p_plot uuid, p_crops jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pl plots%rowtype; cfg jsonb; qty int; done jsonb;
begin
  perform _throttle(p_player, 'harvest');
  select p.* into pl from plots p join farms f on f.id = p.farm_id
   where p.id = p_plot and f.player_id = p_player for update of p;
  if not found then perform _fz('PLOT_NOT_FOUND'); end if;
  if pl.state = 'empty' then perform _fz('PLOT_EMPTY'); end if;
  if pl.ready_at > now() then
    perform _fz('NOT_READY', format('ready_at %s', pl.ready_at));
  end if;
  cfg := p_crops -> pl.crop_id;
  if cfg is null then perform _fz('UNKNOWN_CROP', pl.crop_id); end if;
  qty := (cfg ->> 'yield')::int;

  perform _inv_add(p_player, pl.crop_id, qty);
  update plots set crop_id = null, planted_at = null, ready_at = null, state = 'empty' where id = p_plot;
  perform _add_xp(p_player, coalesce((cfg ->> 'xp')::int, 0));
  done := _mission_bump(p_player, 'harvest_crops', qty);
  return jsonb_build_object('item', pl.crop_id, 'qty', qty, 'completed_missions', done);
end $$;

-- ---------------------------------------------------------------- animals
-- p_animals: {"<type>": {"feed_item": text, "feed_qty": int, "produce_seconds": int,
--                        "produce": text, "produce_qty": int, "xp": int}, ...}
create function public.econ_feed(p_player uuid, p_animal uuid, p_animals jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a animals%rowtype; cfg jsonb; done jsonb;
begin
  perform _throttle(p_player, 'feed');
  select an.* into a from animals an join farms f on f.id = an.farm_id
   where an.id = p_animal and f.player_id = p_player for update of an;
  if not found then perform _fz('ANIMAL_NOT_FOUND'); end if;
  if a.produce_ready_at is not null then perform _fz('ALREADY_FED'); end if;
  cfg := p_animals -> a.type;
  if cfg is null then perform _fz('UNKNOWN_ANIMAL', a.type); end if;

  perform _inv_remove(p_player, cfg ->> 'feed_item', (cfg ->> 'feed_qty')::int);
  update animals set fed_at = now(),
                     produce_ready_at = now() + make_interval(secs => (cfg ->> 'produce_seconds')::int)
   where id = p_animal returning * into a;
  done := _mission_bump(p_player, 'feed_animals', 1);
  return jsonb_build_object('animal', to_jsonb(a), 'completed_missions', done);
end $$;

create function public.econ_collect(p_player uuid, p_animal uuid, p_animals jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a animals%rowtype; cfg jsonb; qty int;
begin
  perform _throttle(p_player, 'collect');
  select an.* into a from animals an join farms f on f.id = an.farm_id
   where an.id = p_animal and f.player_id = p_player for update of an;
  if not found then perform _fz('ANIMAL_NOT_FOUND'); end if;
  if a.produce_ready_at is null then perform _fz('NOT_FED'); end if;
  if a.produce_ready_at > now() then perform _fz('NOT_READY', format('ready_at %s', a.produce_ready_at)); end if;
  cfg := p_animals -> a.type;
  if cfg is null then perform _fz('UNKNOWN_ANIMAL', a.type); end if;
  qty := (cfg ->> 'produce_qty')::int;

  perform _inv_add(p_player, cfg ->> 'produce', qty);
  update animals set produce_ready_at = null where id = p_animal;
  perform _add_xp(p_player, coalesce((cfg ->> 'xp')::int, 0));
  return jsonb_build_object('item', cfg ->> 'produce', 'qty', qty);
end $$;

-- ---------------------------------------------------------------- market
-- Anti-farm: selling unusually often within 10 minutes pays diminishing returns.
create function public.econ_sell(p_player uuid, p_item text, p_qty int, p_unit_price bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare recent int; factor numeric; revenue bigint; done jsonb;
begin
  if p_qty <= 0 or p_qty > 1000 then perform _fz('BAD_QTY'); end if;
  if p_unit_price <= 0 then perform _fz('NOT_SELLABLE', p_item); end if;
  select count(*) into recent from action_log
   where player_id = p_player and action = 'sell' and created_at > now() - interval '10 minutes';
  perform _throttle(p_player, 'sell');
  factor := case when recent >= 40 then 0.25 when recent >= 20 then 0.5 else 1 end;

  perform _inv_remove(p_player, p_item, p_qty);
  revenue := floor(p_qty * p_unit_price * factor);
  if revenue > 0 then
    perform _coin(p_player, revenue, 'sell:' || p_item, p_qty::text);
    done := _mission_bump(p_player, 'sell_value', revenue::int);
  end if;
  return jsonb_build_object('item', p_item, 'qty', p_qty, 'revenue', revenue, 'price_factor', factor,
                            'completed_missions', coalesce(done, '[]'::jsonb));
end $$;

-- p_animal_type non-null => buying an animal (qty animals added to the farm, capped at p_max_animals).
create function public.econ_buy(p_player uuid, p_item text, p_qty int, p_unit_price bigint,
                                p_animal_type text, p_max_animals int, p_min_level int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare fid uuid := _farm_id(p_player); owned int; lvl int;
begin
  if p_qty <= 0 or p_qty > 100 then perform _fz('BAD_QTY'); end if;
  if p_unit_price <= 0 then perform _fz('BAD_CONFIG'); end if;
  perform _throttle(p_player, 'buy');
  select level into lvl from players where id = p_player;
  if lvl < p_min_level then perform _fz('LEVEL_TOO_LOW', format('requires level %s', p_min_level)); end if;

  perform _coin(p_player, -(p_unit_price * p_qty), 'buy:' || p_item, p_qty::text);
  if p_animal_type is not null then
    perform 1 from farms where id = fid for update;  -- serialize animal purchases
    select count(*) into owned from animals where farm_id = fid and type = p_animal_type;
    if owned + p_qty > p_max_animals then perform _fz('ANIMAL_LIMIT', format('max %s', p_max_animals)); end if;
    insert into animals (farm_id, type) select fid, p_animal_type from generate_series(1, p_qty);
  else
    perform _inv_add(p_player, p_item, p_qty);
  end if;
  return jsonb_build_object('item', p_item, 'qty', p_qty, 'cost', p_unit_price * p_qty);
end $$;

-- p_items: {"<item>": qty, ...}. Each order can be completed once per (Bangkok) day.
create function public.econ_complete_order(p_player uuid, p_order text, p_items jsonb,
                                           p_reward_coin bigint, p_reward_xp int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare k text; v jsonb; v_ref text := p_order || ':' || _today()::text; done jsonb;
begin
  perform _throttle(p_player, 'order');
  perform 1 from players where id = p_player for update;
  if exists (select 1 from coin_ledger where player_id = p_player and reason = 'order' and ref = v_ref) then
    perform _fz('ORDER_ALREADY_DONE', p_order);
  end if;
  for k, v in select * from jsonb_each(p_items) loop
    perform _inv_remove(p_player, k, (v #>> '{}')::int);
  end loop;
  perform _coin(p_player, p_reward_coin, 'order', v_ref);
  perform _add_xp(p_player, p_reward_xp);
  done := _mission_bump(p_player, 'complete_order', 1);
  return jsonb_build_object('order', p_order, 'reward_coin', p_reward_coin, 'completed_missions', done);
end $$;
