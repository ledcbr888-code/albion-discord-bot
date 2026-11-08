function getBattleId(item) {
    return String(item?.id ?? item?.Id ?? item?.battleId ?? item?.BattleId ?? '').trim();
}

function validCursor(cursor) {
    return Boolean(
        cursor &&
        typeof cursor.after === 'string' &&
        !Number.isNaN(Date.parse(cursor.after)) &&
        (!cursor.afterId || /^\\d+$/.test(String(cursor.afterId)))
    );
}

function mergeBattleboardPendingItems({ items = [], nextCursor = null, matchesTarget = () => false, processedIds = new Set(), existingPending = [], maxPending = 1000 } = {}) {
    const processed = processedIds instanceof Set ? processedIds : new Set(processedIds || []);
    const pendingById = new Map();
    for (const item of Array.isArray(existingPending) ? existingPending : []) {
        const id = getBattleId(item);
        if (!/^\\d+$/.test(id) || processed.has(id)) continue;
        pendingById.set(id, {
            id,
            firstSeenAt: Number(item.firstSeenAt) || Date.now(),
            source: String(item.source || 'BOSS BOT Battleboard Delta API')
        });
    }

    const matchingItems = (Array.isArray(items) ? items : []).filter((item) => matchesTarget(item));
    const overflowItems = [];
    for (const item of matchingItems) {
        const id = getBattleId(item);
        if (!/^\\d+$/.test(id) || processed.has(id) || pendingById.has(id)) continue;
        if (pendingById.size >= Math.max(1, Number(maxPending) || 1000)) {
            overflowItems.push(item);
            continue;
        }
        const firstSeenText = item?._battleboardFirstSeenAt || item?.firstSeenAt || item?.first_seen_at || item?.startTime || '';
        const firstSeenAt = Number.isFinite(Date.parse(firstSeenText)) ? Date.parse(firstSeenText) : Date.now();
        pendingById.set(id, {
            id,
            firstSeenAt,
            source: 'BOSS BOT Battleboard Delta API'
        });
    }

    const canAdvance = overflowItems.length === 0 && validCursor(nextCursor);
    return {
        matchingItems,
        pendingItems: [...pendingById.values()],
        overflowItems,
        shouldAdvance: canAdvance,
        cursor: canAdvance ? {
            after: String(nextCursor.after),
            afterId: /^\\d+$/.test(String(nextCursor.afterId || '')) ? String(nextCursor.afterId) : null
        } : null
    };
}

module.exports = { mergeBattleboardPendingItems, validCursor };
