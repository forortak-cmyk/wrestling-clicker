# Wrestling Clicker

Telegram Mini App with clicks, character development, auto-clicker, referrals,
roulette, daily/channel/ad rewards, passive businesses, vouchers, withdrawals,
seasonal battle pass, Telegram Stars purchases, support and an admin panel.
All original pages, images and game features are retained.

## Run checks

Node.js 24 is recommended.

```sh
npm ci
npm test
npm run test:browser
```

Browser tests use `/usr/bin/chromium` by default. Set `CHROMIUM_EXECUTABLE_PATH`
when using another installed Chromium binary. They run the real game handler and
Supabase JS client against a local PostgREST test adapter backed by PostgreSQL
(PGlite). They do not call the live game, charge Stars or send Telegram messages.

## Deploy the fixes without interrupting the live game

Use a preview branch first. **Do not deploy the new API to production before the
migration and callback configuration are ready.** The connected Supabase account
available during this repair did not include the game project's default ref
`bgrvgzgqtryudztngkqm`. No production database was changed.

1. Confirm `SUPABASE_URL` in the existing Vercel deployment. If it overrides the
   source default, use that project's existing database. Inspect `users` and
   `withdrawals` there before applying the migration. It assumes the fields
   already used by the original game API; it does not recreate or drop them.
2. Apply `supabase/migrations/20261107182421_protect_game_economy.sql` to that
   database using your usual Supabase migration workflow. Back up the database
   first. The migration adds revision tracking, operation receipts, payment
   receipts, ad reward sessions and restricted server RPCs. Existing user data
   is retained. `telegram_id` must uniquely identify each user; duplicate IDs
   cause the migration to stop rather than silently remove or merge players.
3. Copy the variable names in `.env.example` into the preview/production Vercel
   configuration as appropriate. Keep service-role keys and callback secrets
   server-only. Never commit secret values.
4. Set `TELEGRAM_WEBHOOK_SECRET` to a random URL-safe secret (1–256 characters,
   letters, digits, `_` and `-`). Configure the same value as `secret_token` in
   Telegram's `setWebhook`, retaining the existing bot and webhook URL. Preserve
   existing `allowed_updates` and include `message` and `pre_checkout_query`.
   The webhook fails closed with 503 when the secret is missing and rejects
   unsigned calls. For a preview, use a separate test bot; do not move the live
   bot webhook to a preview URL.
5. Configure the ad network's **server-to-server reward notification**, mapping
   the SDK `ymid` to `sessionId` and its unique reward event ID to `eventId`:
   `https://YOUR_HOST/api/ad-callback?key=SECRET&event=reward&sessionId=YMID&eventId=EVENT_ID`.
   This is a mapping contract, not literal provider macro syntax: use the real
   network macros and verify that the selected placement forwards `ymid`.
   The same callback also accepts POST JSON with these fields and the secret
   in `x-ad-callback-secret`. Configure it only for an earned reward, not for
   an impression or click. Keep the callback URL secret in the network settings.
   If a popup placement cannot report verified rewards, it must not be used
   for rewarded coins until a supported placement/adapter is configured.
   Ordinary interstitial ads continue independently. Both reward buttons remain;
   without a configured callback, the server refuses unverified coin claims.
6. If voucher offers are active, configure `VOUCHER_CATALOG_JSON` with their
   existing server-approved prices and descriptions. No active voucher catalogue
   existed in the checked-in UI. Example:
   `[ { "id": "gym_pass", "sponsor": "Gym", "prize": "Day pass", "cost": 100000 } ]`.
   The endpoint supports `voucherId` and the legacy sponsor/prize match, but
   ignores the client-supplied price. Previously issued vouchers are untouched.
7. Verify a real Telegram load, click save, upgrade, daily reward, business
   collection, verified ad reward, Stars purchase and withdrawal on the preview.
   Re-deliver the same payment update and verify that no second credit occurs.
   Then deploy the matching frontend and API together. A purchase arriving
   during database failure returns 500 so Telegram retries it.

## Data consistency and access

All game mutations use a revision check and a per-player operation ID. The RPC
locks the player row, rejects stale writes and commits the updated user and
operation receipt together. Withdrawals are inserted in that same transaction;
no broad cleanup can reject someone else's pending application. Payments use a
unique Telegram charge ID and increment balance atomically. Premium purchases
reset stale season progress before activating the new pass.

The browser serializes game requests, saves clicks periodically during continuous
play, retains failed click batches in memory and retries the same operation ID.
Unacknowledged local clicks remain visible while a save is in flight. A browser
process killed before saving can still lose unsent in-memory clicks; this is not
an offline game/save system.

Users, withdrawals and receipt tables are restricted to server-side service-role
access. Telegram identity is verified on the server. Browser-supplied user IDs,
prices and ad completion claims do not authorize credits.

Admin statistics and referrals read all pages; Star history requests every page.
Broadcasts use batches of at most 100 users with a cursor so a large audience
can span multiple function invocations. Keep the admin page open until sending
finishes. Interrupted broadcasts are not a durable delivery queue, and Telegram
network timeouts can leave an individual delivery uncertain.

Operation receipts retain the original response for safe retries. Plan receipt
retention with a retry window before deleting historical receipts; never purge
payment charge IDs if duplicate updates may be delivered. No automatic data
cleanup is introduced by this change.
