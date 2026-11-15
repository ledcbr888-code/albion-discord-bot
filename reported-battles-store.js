'use strict';

// Durable per-recipient Auto-Battle dedupe evidence. This does not change Discord
// delivery. The original tracking.json remains a fallback during migration.
function createReportedBattlesStore({ axios, baseUrl, headers, meter, pageSize = 500 } = {}) {
  if (!axios || typeof axios.get !== 'function' || typeof axios.post !== 'function') {
    throw new TypeError('Reported-battles storage needs an HTTP client');
  }
  if (!baseUrl) throw new TypeError('Supabase URL is required');
  const endpoint = String(baseUrl).replace(/\/+$/, '') + '/rest/v1/bot_reported_battles';
  const queued = new Map();
  const authHeaders = () => typeof headers === 'function' ? headers() : headers || {};
  function validId(value) { return /^\d{1,24}$/.test(String(value)); }
  function keyFor(serverId, record) {
    return [String(serverId), String(record.battleId), String(record.channelId), 'auto-battle'].join(':');
  }
  function normalizeRecord(serverId, record) {
    if (!validId(serverId) || !validId(record?.battleId) || !validId(record?.channelId)) {
      throw new TypeError('Invalid discordServerId/battleId/channelId in delivery record');
    }
    if (!record?.key || typeof record.status !== 'string') throw new TypeError('Delivery record is incomplete');
    return {
      discord_server_id: String(serverId),
      battle_id: String(record.battleId),
      channel_id: String(record.channelId),
      report_type: 'auto-battle',
      status: String(record.status),
      record: JSON.parse(JSON.stringify(record)),
      updated_at: new Date().toISOString(),
    };
  }
  async function put(serverId, record) {
    const data = normalizeRecord(serverId, record);
    const outgoing = Buffer.byteLength(JSON.stringify(data));
    try {
      await axios.post(endpoint, data, {
        timeout: 12000,
        headers: { ...authHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
        params: { on_conflict: 'discord_server_id,battle_id,channel_id,report_type' },
      });
      meter?.record?.('supabase', 'delivery-row-upsert', outgoing);
    } catch (err) {
      meter?.record?.('supabase', 'delivery-row-upsert', outgoing, 0, false);
      throw err;
    }
  }
  function save(serverId, record) {
    const snapshot = JSON.parse(JSON.stringify(record));
    const key = keyFor(serverId, snapshot);
    const previous = queued.get(key);
    // Serialize writes per recipient to prevent a slower "sending" update
    // overwriting the newer "sent" acknowledgement.
    const task = (previous || Promise.resolve()).catch(() => {}).then(() => put(serverId, snapshot));
    queued.set(key, task);
    task.finally(() => { if (queued.get(key) === task) queued.delete(key); }).catch(() => {});
    return task;
  }
  async function loadServer(serverId, limit = 2000) {
    if (!validId(serverId)) throw new TypeError('Invalid Discord server ID');
    const result = [];
    const batchSize = Math.min(1000, Math.max(1, Math.floor(pageSize)));
    let offset = 0;
    while (offset < limit) {
      const size = Math.min(batchSize, limit - offset);
      const response = await axios.get(endpoint, {
        timeout: 20000,
        headers: authHeaders(),
        params: {
          select: 'record',
          discord_server_id: 'eq.' + serverId,
          report_type: 'eq.auto-battle',
          order: 'updated_at.desc',
          limit: size,
          offset,
        },
      });
      if (!Array.isArray(response.data)) throw new Error('Unexpected reported-battles response');
      meter?.record?.('supabase', 'delivery-rows-get', 0, Buffer.byteLength(JSON.stringify(response.data)));
      for (const item of response.data) {
        if (item?.record?.key && item?.record?.battleId && item?.record?.channelId) {
          result.push(item.record);
        }
      }
      offset += response.data.length;
      if (response.data.length < size) break;
    }
    return result;
  }
  return { save, loadServer, normalizeRecord };
}
function mergeDeliveredRecords(legacy = [], stored = [], limit = 2000) {
  const records = new Map();
  for (const row of [...legacy, ...stored]) {
    if (!row || typeof row.key !== 'string') continue;
    const previous = records.get(row.key);
    if (!previous || previous.status !== 'sent' || row.status === 'sent') records.set(row.key, row);
  }
  return [...records.values()].slice(-limit);
}
module.exports = { createReportedBattlesStore, mergeDeliveredRecords };
