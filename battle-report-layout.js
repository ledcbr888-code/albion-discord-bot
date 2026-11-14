'use strict';

// Keep presentation-only selection separate from Battle Fame eligibility.
// This function receives guild rows already grounded in the Official Battle
// detail. It does not invent missing guilds or change the tracked roster.
function normalizeGuildLabel(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function selectAutoBattleGuildSummaryRows(guilds, highlightedGuildNames = [], topLimit = 4) {
  const ordered = [...(Array.isArray(guilds) ? guilds : [])]
    .filter(g => g && typeof g === 'object' && normalizeGuildLabel(g.name))
    .sort((a, b) =>
      (Number(b.killFame) || 0) - (Number(a.killFame) || 0) ||
      (Number(b.kills) || 0) - (Number(a.kills) || 0) ||
      (Number(b.deaths) || 0) - (Number(a.deaths) || 0)
    );
  const cap = Math.max(0, Math.min(4, Number(topLimit) || 4));
  const selected = ordered.slice(0, cap);
  const names = new Set((Array.isArray(highlightedGuildNames) ? highlightedGuildNames : [])
    .map(normalizeGuildLabel).filter(Boolean));
  const included = new Set(selected.map(g => normalizeGuildLabel(g.name)));
  for (const guild of ordered) {
    const normalized = normalizeGuildLabel(guild.name);
    if (!names.has(normalized) || included.has(normalized)) continue;
    selected.push(guild); // tracked Guild below Top 4, appended last
    included.add(normalized);
  }
  return selected;
}

// Shared, battle-wide stats for Auto-Battle reports triggered by /add guild.
// Once computed from the FULL Official Battle roster, the same object is
// supplied to every weapon-image page (and image fallback). Page slicing must
// never change totals, top killer or top fame.
// Manual reports and /add player-only reports keep their previous behavior.
function summarizeEntireBattleForGuildPages(players, officialBattle = {}) {
  const roster = Array.isArray(players) ? players.filter(p => p && typeof p === 'object') : [];
  const finiteNonnegative = (value, fallback) =>
    value !== undefined && value !== null && value !== '' &&
    Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback;
  const sum = key => roster.reduce((total, p) => total + finiteNonnegative(p[key], 0), 0);
  const topBy = key => roster.reduce((best, p) => {
    if (!best || finiteNonnegative(p[key], 0) > finiteNonnegative(best[key], 0)) return p;
    return best;
  }, null);
  const topKiller = topBy('kills');
  const mvp = topBy('fame');
  return {
    totalKills: finiteNonnegative(officialBattle.totalKills, sum('kills')),
    totalDeaths: finiteNonnegative(officialBattle.totalDeaths, sum('deaths')),
    totalFame: finiteNonnegative(officialBattle.totalFame, sum('fame')),
    playerCount: finiteNonnegative(officialBattle.totalPlayers, roster.length),
    topKiller: {
      name: String(topKiller?.displayName || topKiller?.name || 'N/A'),
      kills: finiteNonnegative(topKiller?.kills, 0)
    },
    mvp: {
      name: String(mvp?.displayName || mvp?.name || 'N/A'),
      fame: finiteNonnegative(mvp?.fame, 0)
    }
  };
}

// All offsets are relative to the card top at y. Keep four visual bands
// separated vertically: weapon image (bottom y+149), player name, guild,
// K/D counters, then Fame pill (starts at y+243 for 282px card).
const WEAPON_CARD_TEXT_LAYOUT = Object.freeze({
  weaponBottom: 149,
  nameBaseline: 179,
  nameFontSize: 22,
  guildBaseline: 204,
  guildFontSize: 14,
  kdBaseline: 230,
  kdFontSize: 17,
  famePillTop: 243,
});

module.exports = { normalizeGuildLabel, selectAutoBattleGuildSummaryRows, summarizeEntireBattleForGuildPages, WEAPON_CARD_TEXT_LAYOUT };
