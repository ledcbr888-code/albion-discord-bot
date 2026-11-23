'use strict';

// Automatic /battlelink is opt-in per Discord server. A missing or removed
// setting must never mean "all channels". No REST, state writes or side effects.
function isConfiguredBattleLinkChannel(guildId, channelId, guildConfig) {
    if (typeof guildId !== 'string' || !guildId.trim()) return false;
    if (typeof channelId !== 'string' || !channelId.trim()) return false;
    const configured = guildConfig?.battleLinkChannelId;
    return typeof configured === 'string' && configured.length > 0 && channelId === configured;
}

module.exports = { isConfiguredBattleLinkChannel };
