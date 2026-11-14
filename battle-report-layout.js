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

module.exports = { normalizeGuildLabel, selectAutoBattleGuildSummaryRows, WEAPON_CARD_TEXT_LAYOUT };
