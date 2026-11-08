function getBattleId(item) {
    return String(item?.id ?? item?.Id ?? item?.battleId ?? item?.BattleId ?? '').trim();
}

function validCursor(cursor) {
    return Boolean(
        cursor &&
        typeof cursor.after === 'string' &&
        !Number.isNaN(Date.parse(cursor.after)) &&
        (!cursor.afterId || /^\d+$/.test(String(cursor.afterId)))
    );
}

function evaluateBattleboardDeltaPage({ items = [], nextCursor = null, matchesTarget = () => false, processedIds = new Set() } = {}) {
    const processed = processedIds instanceof Set ? processedIds : new Set(processedIds || []);
    const matchingItems = (Array.isArray(items) ? items : []).filter((item) => matchesTarget(item));
    const pendingItems = matchingItems.filter((item) => {
        const id = getBattleId(item);
        return /^\d+$/.test(id) && !processed.has(id);
    });
    const canAdvance = pendingItems.length === 0 && validCursor(nextCursor);
    return {
        matchingItems,
        pendingItems,
        shouldAdvance: canAdvance,
        cursor: canAdvance ? {
            after: String(nextCursor.after),
            afterId: /^\d+$/.test(String(nextCursor.afterId || '')) ? String(nextCursor.afterId) : null
        } : null
    };
}

module.exports = { evaluateBattleboardDeltaPage, validCursor };
