-- Additive migration: do not remove or modify the existing bot_state JSON.
-- Run before enabling BOT_ROW_STORAGE_ENABLED in Render.
BEGIN;
CREATE TABLE IF NOT EXISTS public.bot_reported_battles (
    discord_server_id text NOT NULL,
    battle_id text NOT NULL,
    channel_id text NOT NULL,
    report_type text NOT NULL DEFAULT 'auto-battle',
    status text NOT NULL,
    record jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (discord_server_id, battle_id, channel_id, report_type)
);
CREATE INDEX IF NOT EXISTS bot_reported_battles_recent_idx
    ON public.bot_reported_battles(discord_server_id, updated_at DESC);

-- This is bot-internal delivery evidence, NOT a public client table.
ALTER TABLE public.bot_reported_battles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bot_reported_battles FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bot_reported_battles TO service_role;

-- Import all existing sent and below-threshold records before cutover.
-- Unique recipient key is critical: a Battle can be sent to multiple channels.
INSERT INTO public.bot_reported_battles (
  discord_server_id, battle_id, channel_id, report_type, status, record
)
SELECT g.key, d.value->>'battleId', d.value->>'channelId',
       'auto-battle', d.value->>'status', d.value
FROM public.bot_state AS root
CROSS JOIN LATERAL jsonb_each(root.payload->'guilds') AS g(key, value)
CROSS JOIN LATERAL jsonb_array_elements(
  COALESCE(g.value->'battleboardState'->'delivered', '[]'::jsonb)
) AS d(value)
WHERE root.id = 'albion-discord-bot'
  AND d.value->>'battleId' ~ '^[0-9]+$'
  AND d.value->>'channelId' ~ '^[0-9]+$'
  AND d.value->>'key' IS NOT NULL
  AND d.value->>'status' IS NOT NULL
ON CONFLICT (discord_server_id,battle_id,channel_id,report_type)
DO NOTHING;
COMMIT;

-- Validate before enabling BOT_ROW_STORAGE_ENABLED:
-- SELECT discord_server_id, status, count(*) FROM public.bot_reported_battles GROUP BY 1,2;
-- SELECT count(*) FROM public.bot_reported_battles;
-- Do not delete delivered entries from bot_state during the migration.
