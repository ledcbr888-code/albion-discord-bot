# BOSS BOT bandwidth and delivery-row rollout (Asia only)

## Verified cause
Render logs and metrics showed escalating outbound bandwidth when a growing
tracking JSON (about 0.5 MB compact, about 1.17 MB pretty) was repeatedly
uploaded to Supabase and mirrored to GitHub (~1.13 MB base64 upload). Regular
5-minute tracked-snapshot updates and empty-event heartbeat timestamps were
unnecessarily triggering full backup operations. This change does **not** slow
the 30-second Battleboard Events feed or 60-second Official fallback scanner.

## Additive Supabase migration
`migrations/20261115_bot_reported_battles.sql` is additive. On 2026-11-15,
the Supabase project `uuemutxjpvehimuawswy` was migrated and verified:

- Legacy delivery records: **997**
- Rows imported: **997**
- Missing keys: **0**
- Row-level security: **on**
- `anon` and `authenticated` read access: **denied**

Do not delete or truncate `bot_state` during migration. The existing
`public.bot_state` table has separate insecure grants/RLS settings that need
a dedicated review; this PR does not alter them.

## Release plan — manual approval required for every Render Bot deploy

**Phase A (safe canary)**
1. Merge only after code review, CI checks and explicit Bot deployment approval.
2. Set `BOT_ROW_STORAGE_ENABLED=true` and leave
   `BOT_COMPACT_SNAPSHOT_ENABLED=false`.
3. Deploy the Bot **once**; confirm Discord READY, two Battleboard preflight
   results, tracked Guild count, 30s/60s intervals, Delivery ACK, and a
   previously delivered Battle is skipped.
4. Verify `[Bandwidth]` per-destination operation/byte counts; confirm
   GitHub emergency mirrors only on config changes or daily.

**Phase B (compact after canary)**
1. Confirm all existing per-recipient rows are rehydrated, and report sends
   generate `sent` rows (no missing backfill).
2. With separate approval for the production configuration change, keep
   `BOT_ROW_STORAGE_ENABLED=true` and set
   `BOT_COMPACT_SNAPSHOT_ENABLED=true`.
3. Supabase full bot_state snapshots now omit the large `delivered[]` field.
   Local tracking remains complete; GitHub emergency snapshots remain complete.
4. Measure Render outgoing bandwidth and report latency after 24 hours.

## Recovery and rollback rules
- In Phase A (compact OFF), row-store failures fall back to the existing full
  JSON snapshot, preserving regular Bot availability.
- In Phase B (compact ON), **never disable row storage alone**: the latest
  Supabase bot_state will deliberately have no delivered history. Row restore
  failures must block Bot startup to prevent duplicate reports.
- To exit compact mode, first set `BOT_COMPACT_SNAPSHOT_ENABLED=false`
  **while keeping row storage ON**, wait until a complete Supabase snapshot has
  been written, and verify its `delivered[]` counts before disabling the row
  feature or reverting code. When in doubt, recover the complete GitHub private
  emergency snapshot with a carefully verified row union.
- If a Discord send succeeds while row persistence is unavailable, the Bot
  preserves a legacy full snapshot and rate-limited emergency GitHub mirror.
  Exactly-once delivery cannot be made atomic with Discord; retain existing
  nonce, part IDs and Delivery ACK as additional dedupe safeguards.
- No credentials are included in GitHub snapshots or operational byte-count
  logs. Secrets remain in Render Environment Variables.

## Acceptance tests
- Syntax and Node integration tests, including a simulated restart restoring
  a sent record and proving the same Battle is not sent again.
- In-flight `sending` and `sent` row updates serialize by recipient key.
- Failure of a row upsert does not incorrectly claim the record was stored.
- Heartbeat and event cursor changes do not trigger GitHub mirrors.
- Existing CTA, AVA, weapon icons and delivery integration tests remain green.
