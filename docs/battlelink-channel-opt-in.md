# BattleLink channel opt-in hotfix

**Issue:** `messageCreate` used
`if (dedicatedBattleLinkChannel && message.channel.id !== dedicatedBattleLinkChannel) return`.
When `battleLinkChannelId` was null or missing, the condition was false
and AlbionBB links from *every* channel reached `message.reply()` and
`processBattleReport()`.

**Fix:** Fail closed unless the current Discord guild has explicitly
configured `battleLinkChannelId` matching the actual message channel ID.
Enforce the check **before** URL matching, embed suppression, cooldown,
usage tracking, reply and battle-detail fetching.

- `/battlelink setup channel:#a` allows automatic processing in `#a` only.
- `#b` or another Discord guild never triggers `#a`'s setting.
- Unset or `/battlelink remove`: no automatic processing in any channel.
- Changing the configured channel takes effect without a data migration.
- `/check battles` manual processing, AVA/Bandit/Auto-Battle, source
  limits, report rendering and persistence are untouched.
- The guard is pure, logs nothing and stores no new records.

**Deployment:** Not authorized by this PR. Backup Tracking and deploy
only after user approval; do not restart or mutate CoalByte as part of CI.
