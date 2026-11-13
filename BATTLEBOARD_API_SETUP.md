# Discord Bot — BOSS BOT Battleboard API setup

This integration changes **Auto-Battle only** to read Battle summaries and complete Battle details from the BOSS BOT Albion Battleboard cache.

## Render environment variables

Set these in the Discord Bot Render service. Keep the key private.

| Key | Value |
| --- | --- |
| `BOT_API_KEY` | The exact same random key configured in the Battleboard Vercel project. Do not paste it into GitHub or Discord. |
| `BATTLEBOARD_API_URL` | Optional. Omit this after the Battleboard APIs are in Production; the bot defaults to `https://albion-battleboard-clone-1.vercel.app`. For Preview testing, set it to the exact Vercel Preview deployment hostname. |

The Vercel API and Render bot must use the same `BOT_API_KEY`.

## Auto-Battle data flow

- `GET /api/bot-battle-updates?server=asia&mode=bootstrap` initializes a per-Tracker cursor without replaying the seven-day archive.
- `GET /api/bot-battle-updates?server=asia&mode=delta&after=...&afterId=...&limit=100` supplies the next page of new Battle summaries.
- The bot stores a separate cursor on each Auto-Battle Tracker in the existing tracking backup, so it survives restarts.
- A cursor does **not** advance past a page while a matching Battle remains unprocessed. If the bot restarts while a Battle Detail is pending, it re-reads that page instead of losing the Battle.
- `GET /api/bot-battle-detail?server=asia&id={battleId}` supplies the cached detail.
- HTTP `202`, or HTTP `200` with `complete: false`, means the report is not ready. The bot waits and retries; it does not send a partial report.
- Only HTTP `200` with `complete: true` is used to build and send the Auto-Battle report.
- Auto-Battle does not call Official GameInfo or AlbionBB directly for Battle List, Battle Detail, or weapon enrichment. MainHand is read from the Battleboard detail cache.
- Manual BattleLink/manual report lookup, Fame thresholds, tracked guild/player filters, report image generation, and Discord delivery remain in place. AVA, CTA, Bandit and Daily are not changed.

## Rollout order

1. Verify the authenticated Bot API and shared Supabase cache are ready on Battleboard Preview.
2. Set Render `BOT_API_KEY` to the same secret and `BATTLEBOARD_API_URL` to the exact Preview hostname. Do not paste the key into chat.
3. Test the new bot branch in a separate Render staging service, including API 202/retry, bot restart with an unprocessed cursor page, duplicate prevention, and one real Auto-Battle report.
4. Only after all tests pass, configure the live Render service and deploy the bot with explicit approval.
5. After the Battleboard Bot API is in Production, remove the optional Preview URL override or point it at `https://albion-battleboard-clone-1.vercel.app`.

The key is read only by the Node.js server process and is never returned to Discord messages or browser code.
