-- Scenario tests for the FarmZ schema + RPCs. Run against a fresh DB after 00_supabase_stub.sql
-- and all migrations (see scripts/test-sql.sh). Any failed assertion aborts with an error.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
\o /dev/null

create or replace function pg_temp.expect_error(p_sql text, p_code text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'expected FZ:% but statement succeeded: %', p_code, p_sql;
exception when others then
  if sqlerrm not like 'FZ:' || p_code || '%' and sqlerrm <> p_code and sqlstate <> p_code then
    raise exception 'expected %, got [%] %', p_code, sqlstate, sqlerrm;
  end if;
end $$;

insert into auth.users (id) values ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b');

set role service_role;
\set A '''00000000-0000-0000-0000-00000000000a'''
\set B '''00000000-0000-0000-0000-00000000000b'''
\set CROPS '''{"wheat":{"yield":2,"xp":1},"corn":{"yield":2,"xp":2}}'''
\set ANIMALS '''{"chicken":{"feed_item":"chicken_feed","feed_qty":1,"produce_seconds":1200,"produce":"egg","produce_qty":1,"xp":2}}'''

-- bootstrap: player + farm + 9 plots + 500 signup coins via ledger; streak 1
select econ_bootstrap(:A, '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa', 9, 500);
select econ_bootstrap(:B, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 9, 500);
select econ_bootstrap(:A, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 9, 500); -- idempotent
do $$ begin
  assert (select count(*) from plots p join farms f on f.id = p.farm_id where f.player_id = '00000000-0000-0000-0000-00000000000a') = 9, 'plots';
  assert (select coin_balance from players where id = '00000000-0000-0000-0000-00000000000a') = 500, 'signup balance';
  assert (select count(*) from coin_ledger where player_id = '00000000-0000-0000-0000-00000000000a') = 1, 'single signup ledger';
  assert (select login_streak from players where id = '00000000-0000-0000-0000-00000000000a') = 1, 'streak';
  assert (select count(*) from missions where active_date = _today()) = 5, 'one mission per kind';
  assert (select count(*) from mission_progress where player_id = '00000000-0000-0000-0000-00000000000a') = 5, 'progress rows';
end $$;
select pg_temp.expect_error($q$ select econ_bootstrap('00000000-0000-0000-0000-00000000000a', '0x1111111111111111111111111111111111111111', 9, 500) $q$, 'WALLET_MISMATCH');

-- plant: deducts seed cost via ledger
select econ_plant(:A, (select p.id from plots p join farms f on f.id=p.farm_id where f.player_id=:A and slot=0), 'wheat', 5, 120, 1);
do $$ begin
  assert (select coin_balance from players where id = '00000000-0000-0000-0000-00000000000a') = 495, 'seed cost';
  assert (select sum(delta) from coin_ledger where player_id = '00000000-0000-0000-0000-00000000000a') = 495, 'ledger == balance';
end $$;
-- cannot plant on occupied plot, cannot plant someone else's plot, level gate, insufficient coins
select pg_temp.expect_error(format($q$ select econ_plant(%L, %L, 'wheat', 5, 120, 1) $q$, :A, (select p.id from plots p join farms f on f.id=p.farm_id where f.player_id=:A and slot=0)), 'PLOT_NOT_EMPTY');
select pg_temp.expect_error(format($q$ select econ_plant(%L, %L, 'wheat', 5, 120, 1) $q$, :B, (select p.id from plots p join farms f on f.id=p.farm_id where f.player_id=:A and slot=1)), 'PLOT_NOT_FOUND');
select pg_temp.expect_error(format($q$ select econ_plant(%L, %L, 'strawberry', 80, 60, 5) $q$, :A, (select p.id from plots p join farms f on f.id=p.farm_id where f.player_id=:A and slot=1)), 'LEVEL_TOO_LOW');
select pg_temp.expect_error(format($q$ select econ_plant(%L, %L, 'wheat', 100000, 60, 1) $q$, :A, (select p.id from plots p join farms f on f.id=p.farm_id where f.player_id=:A and slot=1)), 'INSUFFICIENT_COINS');

-- harvest before ready_at (server time) is rejected
select pg_temp.expect_error(format($q$ select econ_harvest(%L, %L, %L) $q$, :A, (select p.id from plots p join farms f on f.id=p.farm_id where f.player_id=:A and slot=0), :CROPS), 'NOT_READY');
-- fast-forward (test only) and harvest
reset role;
update plots set ready_at = now() - interval '1 second' where crop_id = 'wheat';
set role service_role;
select econ_harvest(:A, (select p.id from plots p join farms f on f.id=p.farm_id where f.player_id=:A and slot=0), :CROPS);
do $$ begin
  assert (select qty from inventory where player_id = '00000000-0000-0000-0000-00000000000a' and item = 'wheat') = 2, 'harvest yield';
  assert (select state from plots p join farms f on f.id=p.farm_id where f.player_id='00000000-0000-0000-0000-00000000000a' and slot=0) = 'empty', 'plot cleared';
  assert (select mp.progress from mission_progress mp join missions m on m.id=mp.mission_id
           where mp.player_id='00000000-0000-0000-0000-00000000000a' and m.kind='harvest_crops' and m.active_date=_today()) = 2, 'mission progress';
end $$;
select pg_temp.expect_error(format($q$ select econ_harvest(%L, %L, %L) $q$, :A, (select p.id from plots p join farms f on f.id=p.farm_id where f.player_id=:A and slot=0), :CROPS), 'PLOT_EMPTY');

-- sell: +coin via ledger, sell_value mission progresses
select econ_sell(:A, 'wheat', 2, 4);
do $$ begin
  assert (select coin_balance from players where id = '00000000-0000-0000-0000-00000000000a') = 503, 'sell revenue';
  assert (select qty from inventory where player_id = '00000000-0000-0000-0000-00000000000a' and item = 'wheat') = 0, 'sold';
end $$;
select pg_temp.expect_error(format($q$ select econ_sell(%L, 'wheat', 1, 4) $q$, :A), 'NOT_ENOUGH_ITEMS');

-- buy feed + animal, feed, collect
select econ_buy(:A, 'chicken_feed', 3, 5, null, 0, 1);
select econ_buy(:A, 'chicken', 1, 100, 'chicken', 1, 1);
select pg_temp.expect_error(format($q$ select econ_buy(%L, 'chicken', 1, 100, 'chicken', 1, 1) $q$, :A), 'ANIMAL_LIMIT');
do $$ begin
  assert (select coin_balance from players where id = '00000000-0000-0000-0000-00000000000a') = 503 - 15 - 100, 'buy cost';
end $$;
select econ_feed(:A, (select a.id from animals a join farms f on f.id=a.farm_id where f.player_id=:A), :ANIMALS);
select pg_temp.expect_error(format($q$ select econ_feed(%L, %L, %L) $q$, :A, (select a.id from animals a join farms f on f.id=a.farm_id where f.player_id=:A), :ANIMALS), 'ALREADY_FED');
select pg_temp.expect_error(format($q$ select econ_collect(%L, %L, %L) $q$, :A, (select a.id from animals a join farms f on f.id=a.farm_id where f.player_id=:A), :ANIMALS), 'NOT_READY');
reset role;
update animals set produce_ready_at = now() - interval '1 second';
set role service_role;
select econ_collect(:A, (select a.id from animals a join farms f on f.id=a.farm_id where f.player_id=:A), :ANIMALS);
do $$ begin
  assert (select qty from inventory where player_id = '00000000-0000-0000-0000-00000000000a' and item = 'egg') = 1, 'egg';
  assert (select qty from inventory where player_id = '00000000-0000-0000-0000-00000000000a' and item = 'chicken_feed') = 2, 'feed used';
end $$;

-- inventory cap
select pg_temp.expect_error(format($q$ select econ_buy(%L, 'chicken_feed', 99, 1, null, 0, 1) $q$, :A), 'INVENTORY_FULL');

-- orders: once per day
select econ_complete_order(:A, 'test_order', '{"egg":1}', 50, 5);
select pg_temp.expect_error(format($q$ select econ_complete_order(%L, 'test_order', '{"egg":0}', 50, 5) $q$, :A), 'ORDER_ALREADY_DONE');

-- mission completion pays coin + farmz exactly once
reset role;
update mission_templates set enabled = true;
set role service_role;
do $$
declare m record;
begin
  select m2.* into m from missions m2 where m2.active_date = _today() and m2.kind = 'complete_order';
  perform mission_progress_add('00000000-0000-0000-0000-00000000000a', 'complete_order', 10);
  perform mission_progress_add('00000000-0000-0000-0000-00000000000a', 'complete_order', 10);
  assert (select completed from mission_progress where mission_id = m.id and player_id = '00000000-0000-0000-0000-00000000000a'), 'completed';
  assert (select count(*) from coin_ledger where player_id = '00000000-0000-0000-0000-00000000000a'
          and reason = 'mission' and ref = m.id::text) = 1, 'mission coin paid exactly once';
  assert (select count(*) from farmz_ledger where player_id = '00000000-0000-0000-0000-00000000000a'
          and reason = 'mission' and ref = m.id::text) = (case when m.reward_farmz > 0 then 1 else 0 end), 'mission farmz paid once';
end $$;

-- claims
reset role;
insert into farmz_ledger (player_id, delta, reason) values (:A, 1500.123456789012345678, 'test_grant');
set role service_role;
select claim_reserve(:A, '115792089237316195423570985008687907853269984665640564039457584007913129639935', 4102444800, 1000, 1, 86400);
do $$
declare c claims%rowtype;
begin
  select * into c from claims where player_id = '00000000-0000-0000-0000-00000000000a';
  assert c.amount = 1000 and c.amount_wei = 1000 * 10::numeric ^ 18, 'daily max applied, wei exact';
  assert c.account = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'account';
  assert (select claimable_farmz from players where id = c.player_id) > 500 and
         (select claimable_farmz from players where id = c.player_id) < 502, 'deducted';
end $$;
select pg_temp.expect_error(format($q$ select claim_reserve(%L, '2', 4102444800, 1000, 1, 86400) $q$, :A), 'CLAIM_PENDING');
select claim_attach_signature((select id from claims where player_id = :A), '0xsig');
select pg_temp.expect_error(format($q$ select claim_attach_signature(%L, '0xsig2') $q$, (select id from claims where player_id = :A)), 'CLAIM_NOT_SIGNABLE');
-- refund after provable expiry, then cooldown still counts only non-failed claims
select claim_fail((select id from claims where player_id = :A), 'expired', true);
do $$ begin
  assert (select claimable_farmz from players where id = '00000000-0000-0000-0000-00000000000a') > 1500, 'refunded';
end $$;
select claim_reserve(:A, '3', 4102444800, 1000, 1, 86400);
select claim_set_status((select id from claims where player_id = :A and nonce = 3), 'confirmed', '0xtx');
select pg_temp.expect_error(format($q$ select claim_reserve(%L, '4', 4102444800, 1000, 1, 86400) $q$, :A), 'CLAIM_COOLDOWN');
-- same (account, nonce) can never be issued twice
reset role;
update claims set created_at = now() - interval '2 days';
set role service_role;
select pg_temp.expect_error(format($q$ select claim_reserve(%L, '3', 4102444800, 1000, 1, 86400) $q$, :A), '23505');
select pg_temp.expect_error(format($q$ select claim_reserve(%L, '5', 4102444800, 1000, 1, 86400) $q$, :B), 'NOTHING_TO_CLAIM');

-- ledger invariants
do $$ begin
  assert not exists (select 1 from players p where coin_balance <> coalesce((select sum(delta) from coin_ledger l where l.player_id = p.id), 0)), 'coin cache == ledger';
  assert not exists (select 1 from players p where claimable_farmz <> coalesce((select sum(delta) from farmz_ledger l where l.player_id = p.id), 0)), 'farmz cache == ledger';
end $$;
select pg_temp.expect_error($q$ update coin_ledger set delta = 1 $q$, 'LEDGER_APPEND_ONLY');

-- rate limiting
reset role;
insert into action_log (player_id, action) select :B, 'sell' from generate_series(1, 30);
set role service_role;
select pg_temp.expect_error(format($q$ select econ_sell(%L, 'wheat', 1, 4) $q$, :B), 'RATE_LIMITED');
reset role;

-- ---------------------------------------------------------------- RLS / privileges
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
do $$ begin
  assert (select count(*) from players) = 1, 'sees only own player';
  assert (select count(*) from coin_ledger where player_id <> '00000000-0000-0000-0000-00000000000a') = 0, 'own ledger only';
  assert (select count(*) from plots) = 9, 'own plots only';
  assert (select count(*) from missions) >= 5, 'mission board visible';
end $$;
update players set email = 'a@example.com';              -- allowed: own email
select pg_temp.expect_error($q$ update players set coin_balance = 999999 $q$, '42501');
select pg_temp.expect_error($q$ insert into coin_ledger (player_id, delta, reason) values ('00000000-0000-0000-0000-00000000000a', 100, 'hack') $q$, '42501');
select pg_temp.expect_error($q$ update inventory set qty = 99 $q$, '42501');
select pg_temp.expect_error($q$ select econ_sell('00000000-0000-0000-0000-00000000000a', 'egg', 1, 1000) $q$, '42501');
select pg_temp.expect_error($q$ select claim_reserve('00000000-0000-0000-0000-00000000000a', '9', 1, 1, 0, 0) $q$, '42501');
select pg_temp.expect_error($q$ select * from auth_nonces $q$, '42501');
reset role;
set role anon;
select pg_temp.expect_error($q$ select * from players $q$, '42501');
reset role;
do $$ begin assert (select email from players where id = '00000000-0000-0000-0000-00000000000a') = 'a@example.com', 'email updated'; end $$;

\o
\echo ALL SQL TESTS PASSED
