# Discord Bot — BOSS BOT Battleboard API setup

This integration changes **Auto-Battle only** to read Battle summaries and complete Battle details from the BOSS BOT Albion Battleboard cache.

## Render environment variables

Set these in the Discord Bot Render service. Keep the key private.

| Key | Value |
| --- | --- |
| \`BOT_API_KEY\` | The exact same random key configured in the Battleboard Vercel project. Do not paste it into GitHub or Discord. |
| \`BATTLEBOARD_API_URL\` | Optional. Omit this after the Battleboard API is deployed to Production; the bot defaults to \`https://albion-battleboard-clone-1.vercel.app\`. For Preview testing, set it to the exact Preview deployment hostname shown by Vercel (not the Vercel dashboard URL). |

The Vercel API and Render bot must use the same \`BOT_API_KEY\`.

## How Auto-Battle behaves

- \`GET /api/bot-battles?server=asia&limit=100&offset=0\` supplies recent Battle summaries from the seven-day shared Supabase history.
- \`GET /api/bot-battle-detail?server=asia&id={battleId}\` supplies the cached detail.
- HTTP \`202\`, or HTTP \`200\` with \`complete: false\`, means the report is not ready. The bot waits and retries; it does not send a partial report.
- Only HTTP \`200\` with \`complete: true\` is used to build and send the Auto-Battle report.
- Auto-Battle does not call Official GameInfo or AlbionBB directly for Battle List, Battle Detail, or weapon enrichment. MainHand is read from the Battleboard detail cache.
- Manual BattleLink/report behavior is unchanged by this integration.

## Rollout order

1. Apply/verify the Battleboard Supabase migration and Vercel \`BOT_API_KEY\`.
2. Deploy the Battleboard Preview and copy its exact Preview hostname.
3. Set Render \`BOT_API_KEY\` to the same secret and \`BATTLEBOARD_API_URL\` to that Preview hostname. Do not paste the key into chat.
4. Deploy this bot branch to a Preview/staging service first, check its logs and one real Auto-Battle report, then merge/deploy Production only after verification.
5. Once the Battleboard API is merged and deployed to Production, remove the optional Render \`BATTLEBOARD_API_URL\` override (or set it to the Production website URL) and redeploy the bot.

The key is read only by the Node.js server process and is never returned to Discord messages or browser code.
