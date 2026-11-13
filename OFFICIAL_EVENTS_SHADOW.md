# Official Events Shadow Probe

## Purpose

This is a read-only experiment to test whether the Asia GameInfo `/events` feed exposes a valid `BattleId` early enough to improve Battle discovery. It runs inside the existing `albion-discord-bot` Node.js process and reuses the existing Scheduler. It does not create a Render Service, Background Worker, Cron Job, or separate always-on process.

## API being tested

The probe calls only:

```
GET https://gameinfo-sgp.albiononline.com/api/gameinfo/events?limit=51&offset=0
```

The endpoint is documented by community-maintained Albion API references as the recent kill-event feed, with `EventId`, `TimeStamp`, and (for events associated with a large fight) `BattleId`. Albion Online does not publish a supported third-party API contract or SLA for this endpoint. Availability, response freshness, rate limiting, and BattleId coverage must therefore be measured before relying on it.

This project is currently Asia-only. The probe deliberately does not call Americas/West or Europe endpoints.

## Scheduling and isolation

- The existing Battleboard integration loop calls the probe at most once every 120 seconds.
- It is fire-and-forget and has its own in-process single-flight lock. It cannot hold up the primary 30-second Battleboard Events Feed polling cycle.
- The probe reads one page of up to 51 Events. A full 51-row response is logged as `pageCapReached=true`; it is not described as complete coverage.
- It does not read, write, or move `eventCursor`, `afterBattleId`, pending Auto-Battle events, processed-Battle IDs, report delivery state, or the Battleboard Events Feed cursor.
- It does not build a report, call Discord, enqueue a Battle, call the Summary/Detail APIs, or write to any Production Battle/Detail queue.
- A duplicate Battle ID in the same response is grouped. Only the first representative Event is stored for that Battle ID.

## Storage

The probe reuses the existing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` settings. They must target the same Supabase project that contains the Battleboard `battle_history` table; the code fails closed and does not store observations if that comparison table cannot be read.

The proposed `discovery_observations` table stores only:
- `source='official_events_shadow'` and `server='asia'`
- One `battle_id` and representative `event_id` per first-observed Battle
- Bot response-received time (`observed_at`) and the Event's in-game timestamp (`event_time`) separately
- A compact JSON object with EventId, BattleId, timestamp, Killer/Victim IDs, and source server
- Whether Battle List had already seen the Battle at first observation (NULL is reserved for unknown lookup status)
- A three-day expiry timestamp

Repeated Events for a Battle are not inserted again. Rows older than three days are deleted at most once every six hours. This avoids storing full kill payloads and bounds database growth.

The SQL under `sql/proposals/` is a proposal only. It is not applied to Supabase by this PR.

## Enablement

The probe is disabled unless this Render environment variable is explicitly set:

```
OFFICIAL_EVENTS_SHADOW_ENABLED=true
```

Do not enable it until:
1. The target `SUPABASE_URL` is verified to be the Battleboard Supabase project.
2. The proposal SQL has been reviewed and applied separately.
3. The code has been merged and deployed through the normal approval process.

No environment variables are changed by this PR. The probe remains disabled by default.

## Reading the results

Use `sql/reports/official-events-shadow-report.sql` after collecting at least 24–48 hours. A positive lead means Events were observed before Battle List first_seen_at; negative means Battle List was earlier. The report also shows the number of matched Battles and the share of matched Battles for which Events arrived first.

Treat page-capped intervals as incomplete. If the feed has no reliable BattleId, frequently rate-limits, or consistently arrives after Battle List, stop the experiment and do not promote it to a Discovery Source.
