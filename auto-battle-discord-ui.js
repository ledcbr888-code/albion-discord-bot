'use strict';

// The caller supplies a public Battle viewer URL. The button labels the
// destination, not the report's statistical data source. URLs occur only in
// a Discord Link Button, never in message content.
function buildAutoBattleLinkComponents(reportLink) {
    const match = /^\[(\d{1,20})\]\((https:\/\/[^\s)]+)\)$/.exec(String(reportLink));
    if (!match) throw new Error('Invalid validated Auto-Battle report link');
    const url = new URL(match[2]);
    const primary = url.hostname === 'www.albionzvz.com' || url.hostname === 'albionzvz.com';
    const official = url.hostname === 'albiononline.com';
    if ((!primary && !official) || url.username || url.password || url.port) {
        throw new Error('Unexpected Auto-Battle report link host');
    }
    return [{ type: 1, components: [{
        type: 2, style: 5,
        label: primary ? '🔗 เปิด Battle บน AlbionZvZ Asia' : 'Battle · Official Albion',
        url: match[2]
    }] }];
}

module.exports = { buildAutoBattleLinkComponents };
