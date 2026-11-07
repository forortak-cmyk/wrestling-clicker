create role anon; create role authenticated; create role service_role bypassrls;
    create table users (
      telegram_id bigint primary key, username text, balance bigint default 0, total_earned bigint default 0,
      click_power integer default 1, xp bigint default 0, referrer_id bigint, ref_claimed bigint default 0,
      last_spin bigint default 0, vouchers jsonb default '[]', last_sync bigint default 0,
      last_daily_claim bigint default 0, daily_streak integer default 0, last_ad_reward_claim bigint default 0,
      last_popup_reward_claim bigint default 0, channel_bonus_claimed boolean default false,
      businesses jsonb default '[]', last_business_collect bigint default 0, cap_notified boolean default false,
      bp_points bigint default 0, bp_premium boolean default false, bp_claimed_free jsonb default '[]',
      bp_claimed_premium jsonb default '[]', bp_season integer default 0
    );
    create table withdrawals (id serial primary key, telegram_id bigint, username text, full_name text not null,
      card_last4 text not null, coins_amount bigint, amd_amount bigint, status text);
    grant select, update on users to service_role;
    grant insert, select on withdrawals to service_role;
    grant usage on sequence withdrawals_id_seq to service_role;
    insert into users (telegram_id, balance, bp_points, bp_season) values (123, 500000000, 500, 1);