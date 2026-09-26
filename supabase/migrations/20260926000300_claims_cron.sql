-- Claim bookkeeping for FarmZClaim (EIP-712). The edge function `claim-request` generates the
-- nonce/deadline, calls claim_reserve (atomic: checks + deducts claimable_farmz), signs, then
-- stores the signature with claim_attach_signature. Failed/expired claims are refunded.

create function public.claim_reserve(p_player uuid, p_nonce text, p_deadline bigint,
                                     p_max_amount numeric, p_min_amount numeric, p_cooldown_seconds int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  pl players%rowtype;
  amt numeric(38, 18);
  last_at timestamptz;
  c claims%rowtype;
begin
  perform _throttle(p_player, 'claim');
  select * into pl from players where id = p_player for update;
  if not found then perform _fz('PLAYER_NOT_FOUND'); end if;

  if exists (select 1 from claims where player_id = p_player and status in ('signed', 'submitted')) then
    perform _fz('CLAIM_PENDING');
  end if;

  select max(created_at) into last_at from claims where player_id = p_player and status <> 'failed';
  if last_at is not null and last_at > now() - make_interval(secs => p_cooldown_seconds) then
    perform _fz('CLAIM_COOLDOWN', (last_at + make_interval(secs => p_cooldown_seconds))::text);
  end if;

  amt := trunc(least(pl.claimable_farmz, p_max_amount), 18);
  if amt <= 0 or amt < p_min_amount then
    perform _fz('NOTHING_TO_CLAIM', format('claimable %s, minimum %s', pl.claimable_farmz, p_min_amount));
  end if;

  insert into claims (player_id, account, amount, amount_wei, nonce, deadline, status)
  values (p_player, pl.wallet, amt, (amt * 1000000000000000000)::numeric(78, 0), p_nonce::numeric(78, 0),
          p_deadline, 'signed')
  returning * into c;
  perform _farmz(p_player, -amt, 'claim', c.id::text);

  return jsonb_build_object('id', c.id, 'account', c.account, 'amount', c.amount::text,
                            'amount_wei', c.amount_wei::text, 'nonce', c.nonce::text, 'deadline', c.deadline);
end $$;

create function public.claim_attach_signature(p_claim uuid, p_signature text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update claims set signature = p_signature, updated_at = now()
   where id = p_claim and status = 'signed' and signature is null;
  if not found then perform _fz('CLAIM_NOT_SIGNABLE'); end if;
end $$;

-- Marks a claim failed. p_refund returns the amount to claimable_farmz — only pass true when the
-- nonce is provably unused on-chain after the deadline (or the signature was never handed out).
create function public.claim_fail(p_claim uuid, p_reason text, p_refund boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c claims%rowtype;
begin
  select * into c from claims where id = p_claim for update;
  if not found then perform _fz('CLAIM_NOT_FOUND'); end if;
  if c.status not in ('signed', 'submitted') then return to_jsonb(c); end if;
  update claims set status = 'failed', failure_reason = p_reason, updated_at = now()
   where id = p_claim returning * into c;
  if p_refund then
    perform _farmz(c.player_id, c.amount, 'claim_refund', c.id::text);
  end if;
  return to_jsonb(c);
end $$;

create function public.claim_set_status(p_claim uuid, p_status text, p_tx_hash text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c claims%rowtype;
begin
  if p_status not in ('submitted', 'confirmed') then perform _fz('BAD_STATUS'); end if;
  update claims set status = p_status, tx_hash = coalesce(p_tx_hash, tx_hash), updated_at = now()
   where id = p_claim and status in ('signed', 'submitted')
   returning * into c;
  if not found then
    select * into c from claims where id = p_claim;
  end if;
  return to_jsonb(c);
end $$;

-- ---------------------------------------------------------------- privileges
-- Only the service role (edge functions) may execute any function in public.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- ---------------------------------------------------------------- seed: mission templates
insert into public.mission_templates (key, kind, target, reward_coin, reward_farmz) values
  ('harvest_20_crops',          'harvest_crops',  20,  150, 0),
  ('harvest_50_crops',          'harvest_crops',  50,  400, 1),
  ('feed_5_animals',            'feed_animals',    5,  100, 0),
  ('feed_15_animals',           'feed_animals',   15,  300, 0.5),
  ('sell_produce_value_300',    'sell_value',    300,  150, 0),
  ('sell_produce_value_1000',   'sell_value',   1000,  400, 1),
  ('login_streak_3',            'login_streak',    3,  100, 0.5),
  ('login_streak_7',            'login_streak',    7,  300, 2),
  ('complete_order_1',          'complete_order',  1,  100, 0),
  ('complete_order_3',          'complete_order',  3,  300, 1)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- cron (00:00 Asia/Bangkok = 17:00 UTC)
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('farmz-daily-missions', '0 17 * * *', 'select public.generate_daily_missions()');
  else
    raise notice 'pg_cron not available; schedule public.generate_daily_missions() manually';
  end if;
end $$;
