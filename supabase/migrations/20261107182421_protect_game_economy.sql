-- Additive migration. Existing users, balances, vouchers and withdrawals are retained.
begin;
create unique index if not exists users_telegram_id_unique_idx on public.users (telegram_id);
alter table public.users add column if not exists revision bigint not null default 0;
create table if not exists public.game_operations (
  telegram_id bigint not null,
  operation_id text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (telegram_id, operation_id)
);
create table if not exists public.telegram_payments (
  charge_id text primary key,
  telegram_id bigint not null,
  product text not null check (product in ('pass', 'coins')),
  coins bigint not null check (coins >= 0),
  stars integer not null check (stars > 0),
  created_at timestamptz not null default now()
);
alter table public.game_operations enable row level security;
alter table public.telegram_payments enable row level security;
revoke all on public.game_operations, public.telegram_payments from anon, authenticated;
grant select, insert on public.game_operations, public.telegram_payments to service_role;

create table if not exists public.ad_reward_sessions (
  id uuid primary key,
  telegram_id bigint not null,
  track text not null check (track in ('ad', 'popup')),
  verified boolean not null default false,
  provider_event_id text unique,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.ad_reward_sessions enable row level security;
alter table public.users enable row level security;
alter table public.withdrawals enable row level security;
revoke all on public.ad_reward_sessions, public.users, public.withdrawals from anon, authenticated;
grant select, insert, update on public.ad_reward_sessions, public.users, public.withdrawals to service_role;
do $$ declare seq text; begin
  seq := pg_get_serial_sequence('public.withdrawals', 'id');
  if seq is not null then execute format('grant usage on sequence %s to service_role', seq); end if;
end $$;

-- Every writer, including payment callbacks and maintenance scripts, invalidates stale reads.
create or replace function public.bump_game_revision()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.revision := old.revision + 1;
  return new;
end;
$$;
create trigger game_revision_before_update before update on public.users
  for each row execute function public.bump_game_revision();
revoke execute on function public.bump_game_revision() from public, anon, authenticated;

create or replace function public.commit_game_operation(
  p_telegram_id bigint, p_revision bigint, p_changes jsonb,
  p_operation_id text, p_extra jsonb default '{}', p_withdrawal jsonb default null, p_ad_session uuid default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  current_user_row public.users;
  updated_user public.users;
  previous jsonb;
  result jsonb;
  column_names text;
  merged jsonb;
  ad_session public.ad_reward_sessions;
begin
  if p_operation_id is null or length(p_operation_id) < 16 or length(p_operation_id) > 120 then
    raise exception 'Invalid operation ID';
  end if;
  select * into strict current_user_row from public.users where telegram_id = p_telegram_id for update;
  select response into previous from public.game_operations
    where telegram_id = p_telegram_id and operation_id = p_operation_id;
  if found then return previous; end if;
  if current_user_row.revision <> p_revision then
    raise exception 'Concurrent update' using errcode = '40001';
  end if;
  if jsonb_typeof(p_changes) <> 'object' or p_changes = '{}' then raise exception 'Invalid changes'; end if;
  if exists (select 1 from jsonb_object_keys(p_changes) as k(key) where key not in (
    'balance','total_earned','click_power','xp','referrer_id','ref_claimed','last_spin','vouchers',
    'last_sync','last_daily_claim','daily_streak','last_ad_reward_claim','last_popup_reward_claim',
    'channel_bonus_claimed','businesses','last_business_collect','cap_notified',
    'bp_points','bp_premium','bp_claimed_free','bp_claimed_premium','bp_season'
  )) then raise exception 'Invalid user field'; end if;
  if p_ad_session is not null then
    select * into ad_session from public.ad_reward_sessions where id = p_ad_session and telegram_id = p_telegram_id for update;
    if not found or not ad_session.verified or ad_session.claimed_at is not null or
      ad_session.created_at < now() - interval '15 minutes' or
      (ad_session.track = 'ad' and not (p_changes ? 'last_ad_reward_claim')) or
      (ad_session.track = 'popup' and not (p_changes ? 'last_popup_reward_claim')) then
      raise exception 'Ad reward is not verified';
    end if;
    update public.ad_reward_sessions set claimed_at = now() where id = p_ad_session;
  elsif p_changes ? 'last_ad_reward_claim' or p_changes ? 'last_popup_reward_claim' then
    raise exception 'Ad reward receipt required';
  end if;
  merged := to_jsonb(current_user_row) || p_changes;
  if (merged->>'balance')::numeric < 0 then raise exception 'Insufficient balance'; end if;
  select string_agg(format('%I', key), ', ' order by key) into column_names from jsonb_object_keys(p_changes) as k(key);
  execute format('update public.users set (%s) = (select %s from jsonb_populate_record(null::public.users, $1)) where telegram_id = $2 returning *', column_names, column_names)
    into updated_user using merged, p_telegram_id;
  if p_withdrawal is not null then
    if (p_withdrawal->>'coins_amount')::bigint < 250000000 or
      (p_withdrawal->>'amd_amount')::bigint <> floor((p_withdrawal->>'coins_amount')::numeric * 750 / 250000000) then
      raise exception 'Invalid withdrawal';
    end if;
    insert into public.withdrawals (telegram_id, username, full_name, card_last4, coins_amount, amd_amount, status)
    values (p_telegram_id, p_withdrawal->>'username', p_withdrawal->>'full_name', p_withdrawal->>'card_last4',
      (p_withdrawal->>'coins_amount')::bigint, (p_withdrawal->>'amd_amount')::bigint, 'pending');
  end if;
  result := coalesce(p_extra, '{}') || jsonb_build_object('ok', true, 'user', to_jsonb(updated_user));
  insert into public.game_operations (telegram_id, operation_id, response) values (p_telegram_id, p_operation_id, result);
  return result;
end;
$$;
revoke execute on function public.commit_game_operation(bigint,bigint,jsonb,text,jsonb,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.commit_game_operation(bigint,bigint,jsonb,text,jsonb,jsonb,uuid) to service_role;

create or replace function public.credit_telegram_payment(
  p_charge_id text, p_telegram_id bigint, p_product text, p_coins bigint, p_stars integer, p_season integer
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  existing public.telegram_payments;
  player public.users;
begin
  if p_charge_id is null or p_charge_id = '' or p_product not in ('pass', 'coins') or
    p_stars <= 0 or p_coins < 0 or (p_product = 'coins' and p_coins = 0) then
    raise exception 'Invalid payment';
  end if;
  select * into strict player from public.users where telegram_id = p_telegram_id for update;
  insert into public.telegram_payments (charge_id, telegram_id, product, coins, stars)
    values (p_charge_id, p_telegram_id, p_product, p_coins, p_stars) on conflict (charge_id) do nothing;
  if not found then
    select * into strict existing from public.telegram_payments where charge_id = p_charge_id;
    if existing.telegram_id <> p_telegram_id or existing.product <> p_product or
      existing.coins <> p_coins or existing.stars <> p_stars then raise exception 'Receipt mismatch'; end if;
    return jsonb_build_object('credited', false);
  end if;
  if p_product = 'coins' then
    update public.users set balance = coalesce(balance, 0) + p_coins,
      total_earned = coalesce(total_earned, 0) + p_coins where telegram_id = p_telegram_id;
  else
    -- A first purchase after season rollover must survive the next game load.
    update public.users set bp_premium = true, bp_season = p_season,
      bp_points = case when bp_season = p_season then bp_points else 0 end,
      bp_claimed_free = case when bp_season = p_season then bp_claimed_free else (jsonb_populate_record(null::public.users, '{"bp_claimed_free":[]}')).bp_claimed_free end,
      bp_claimed_premium = case when bp_season = p_season then bp_claimed_premium else (jsonb_populate_record(null::public.users, '{"bp_claimed_premium":[]}')).bp_claimed_premium end
    where telegram_id = p_telegram_id;
  end if;
  return jsonb_build_object('credited', true);
end;
$$;
revoke execute on function public.credit_telegram_payment(text,bigint,text,bigint,integer,integer) from public, anon, authenticated;
grant execute on function public.credit_telegram_payment(text,bigint,text,bigint,integer,integer) to service_role;
create index if not exists users_referrer_lookup_idx on public.users (referrer_id);
notify pgrst, 'reload schema';
commit;
