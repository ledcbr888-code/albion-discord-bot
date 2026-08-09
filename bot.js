const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  AttachmentBuilder
} = require('discord.js');
const axios = require('axios');
const cloudscraper = require('cloudscraper');
const cheerio = require('cheerio');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');
const express = require('express');

const TOKEN = String(process.env.BOT_TOKEN || '').trim();
const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = path.join(__dirname, 'tracking.json');

if (!TOKEN) {
  console.error('❌ BOT_TOKEN is missing.');
  process.exit(1);
}

// Start the health server independently of Discord.
const app = express();
app.get('/', (_, res) => res.status(200).send('BOSSBOT is online!'));
app.get('/health', (_, res) => res.json({ ok: true, discord: client?.isReady?.() || false }));
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Web server listening on port ${PORT}`));

// Discord only needs the Guilds intent for slash commands.
// Do NOT pass a custom https.Agent here; discord.js manages the WebSocket itself.
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  failIfNotExists: false
});

let targetPlayers = [];
let targetGuilds = [];

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return saveData();
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    targetPlayers = Array.isArray(data.players) ? data.players : [];
    targetGuilds = Array.isArray(data.guilds) ? data.guilds : [];
  } catch (e) {
    console.error('❌ tracking.json:', e.message);
  }
}
function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ players: targetPlayers, guilds: targetGuilds }, null, 2));
  } catch (e) {
    console.error('❌ save tracking:', e.message);
  }
}
loadData();

function fame(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let s = String(v).trim().toLowerCase().replace(/,/g, '');
  let m = 1;
  if (s.endsWith('b')) { m = 1e9; s = s.slice(0, -1); }
  else if (s.endsWith('m')) { m = 1e6; s = s.slice(0, -1); }
  else if (s.endsWith('k')) { m = 1e3; s = s.slice(0, -1); }
  const n = parseFloat(s.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * m) : 0;
}
function fmt(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}
function timeText(v) {
  if (!v) return 'N/A';
  const n = Number(v);
  const d = new Date(Number.isFinite(n) && String(v).trim() !== '' ? (n < 1e10 ? n * 1000 : n) : v);
  if (Number.isNaN(d.getTime())) return 'N/A';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(d).replace(',', '') + ' +07';
}
function itemId(raw) {
  if (!raw) return '';
  let s = typeof raw === 'object' ? (raw.itemId ?? raw.ItemId ?? raw.type ?? raw.Type ?? raw.id ?? raw.Id ?? raw.uniqueName ?? raw.UniqueName ?? '') : String(raw);
  s = String(s).trim();
  const m = s.match(/\/items\/([^/?#]+)/i) || s.match(/\/v1\/item\/([^/?#]+)/i);
  if (m) { try { s = decodeURIComponent(m[1]); } catch (_) {} }
  return s.replace(/\s+/g, '_').replace(/\.png(?:\?.*)?$/i, '').replace(/@(\d+)Q\d+/i, '@$1');
}
function weaponId(raw) {
  const s = itemId(raw).toUpperCase();
  if (!s || /OFF_|OFFHAND|SHIELD|TORCH|TOME|BOOK|ORB|HORN/.test(s)) return '';
  return /MAIN_|2H_|CROSSBOW|BOW|STAFF|SWORD|MACE|AXE|HAMMER|SPEAR|DAGGER|ARCANE|HOLY|NATURE|FIRE|FROST|CURSED|GLAIVE|SCYTHE|QUARTERSTAFF|WAR_GLOVE|FIST|REAVER/.test(s) ? itemId(raw) : '';
}
function getWeapon(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const list = [obj.MainHand, obj.mainHand, obj.weapon, obj.Weapon, obj.weaponId, obj.WeaponId, obj.Equipment?.MainHand, obj.equipment?.MainHand];
  for (const x of list) { const w = weaponId(x); if (w) return w; }
  return '';
}
function playerFromObject(o) {
  if (!o || typeof o !== 'object') return null;
  const name = o.name ?? o.Name ?? o.playerName ?? o.PlayerName;
  if (!name) return null;
  return {
    name: String(name),
    guild: String(o.guildName ?? o.GuildName ?? o.guild ?? o.Guild ?? ''),
    kills: Number(o.kills ?? o.Kills ?? o.kill ?? o.Kill ?? 0) || 0,
    deaths: Number(o.deaths ?? o.Deaths ?? o.death ?? o.Death ?? 0) || 0,
    fame: fame(o.killFame ?? o.killfame ?? o.fame ?? o.Fame ?? o.KillFame ?? 0),
    damage: fame(o.damage ?? o.Damage ?? o.totalDamage ?? o.TotalDamage ?? 0),
    healing: fame(o.healing ?? o.Healing ?? o.totalHealing ?? o.TotalHealing ?? 0),
    weapon: getWeapon(o)
  };
}
function parseHtml(html) {
  const $ = cheerio.load(html);
  const players = [];
  const battleTime = $('time[datetime]').attr('datetime') || $('time').first().text().trim() || null;
  $('table').each((_, table) => {
    const headers = [];
    $(table).find('thead tr').first().find('th,td').each((__, c) => headers.push($(c).text().replace(/\s+/g, ' ').trim().toLowerCase()));
    if (!headers.length) return;
    const find = (...names) => names.map(n => headers.indexOf(n)).find(i => i >= 0) ?? -1;
    const ni = find('name', 'player', 'player name');
    const gi = find('guild', 'guild name', 'alliance');
    const ki = find('kills', 'kill');
    const di = find('deaths', 'death');
    const fi = find('fame', 'kill fame', 'killfame');
    const dmi = headers.findIndex(h => /damage|dmg/.test(h));
    const hi = headers.findIndex(h => /heal|healing/.test(h));
    $(table).find('tbody tr').each((__, row) => {
      const cells = $(row).find('td').map((___, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();
      if (!cells.length) return;
      const name = ni >= 0 ? cells[ni] : cells[0];
      if (!name) return;
      let weapon = '';
      $(row).find('img,[data-item-id],[data-type],a[href*="/items/"]').each((___, el) => {
        const $el = $(el);
        const context = [$el.attr('alt'), $el.attr('title'), $el.attr('class'), $el.attr('data-slot'), $el.parent().text()].filter(Boolean).join(' ').toLowerCase();
        const raw = $el.attr('src') || $el.attr('data-src') || $el.attr('data-item-id') || $el.attr('data-type') || $el.attr('href');
        const w = weaponId(raw);
        if (w && (!weapon || /main[\s_-]?hand|weapon/.test(context))) weapon = w;
      });
      players.push({
        name, guild: gi >= 0 ? cells[gi] : '',
        kills: ki >= 0 ? parseInt(String(cells[ki]).replace(/[^\d-]/g, ''), 10) || 0 : 0,
        deaths: di >= 0 ? parseInt(String(cells[di]).replace(/[^\d-]/g, ''), 10) || 0 : 0,
        fame: fi >= 0 ? fame(cells[fi]) : 0,
        damage: dmi >= 0 ? fame(cells[dmi]) : 0,
        healing: hi >= 0 ? fame(cells[hi]) : 0,
        weapon
      });
    });
  });
  return { players, battleTime };
}
function walkPlayers(obj, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) { for (const x of obj) walkPlayers(x, out); return out; }
  const p = playerFromObject(obj);
  if (p) out.push(p);
  for (const v of Object.values(obj)) if (v && typeof v === 'object') walkPlayers(v, out);
  return out;
}
async function getBattle(id) {
  let htmlData = { players: [], battleTime: null };
  try {
    const html = await cloudscraper.get({
      url: `https://east.albionbb.com/battles/${encodeURIComponent(id)}`,
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/xhtml+xml' }
    });
    htmlData = parseHtml(html);
    const $ = cheerio.load(html);
    const next = $('script#__NEXT_DATA__').html();
    if (next) {
      try { htmlData.players.push(...walkPlayers(JSON.parse(next))); } catch (_) {}
    }
  } catch (e) {
    console.log(`⚠️ AlbionBB failed: ${e.message}`);
  }
  if (/^\d+$/.test(id)) {
    for (const host of ['https://gameinfo.albiononline.com', 'https://gameinfo-sgp.albiononline.com']) {
      try {
        const r = await axios.get(`${host}/api/gameinfo/battles/${encodeURIComponent(id)}`, { timeout: 12000 });
        if (r.data) {
          const apiPlayers = Array.isArray(r.data.players) ? r.data.players : Object.values(r.data.players || {});
          return { players: merge(htmlData.players, apiPlayers.map(playerFromObject).filter(Boolean)), time: htmlData.battleTime || r.data.startTime || r.data.endTime };
        }
      } catch (_) {}
    }
  }
  return { players: merge(htmlData.players), time: htmlData.battleTime };
}
function merge(list) {
  const map = new Map();
  for (const p of list) {
    if (!p?.name) continue;
    const k = p.name.toLowerCase();
    if (!map.has(k)) map.set(k, { ...p });
    else {
      const x = map.get(k);
      x.guild ||= p.guild;
      x.kills = Math.max(x.kills, p.kills);
      x.deaths = Math.max(x.deaths, p.deaths);
      x.fame = Math.max(x.fame, p.fame);
      x.damage = Math.max(x.damage, p.damage);
      x.healing = Math.max(x.healing, p.healing);
      x.weapon ||= p.weapon;
    }
  }
  return [...map.values()];
}
function extractId(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('Match ID ว่าง');
  if (/^https?:\/\//i.test(s)) {
    const m = s.match(/\/battles\/([^/?#]+)/i);
    if (!m) throw new Error('ลิงก์ AlbionBB ไม่ถูกต้อง');
    return m[1];
  }
  return s;
}
async function performanceImage(rows) {
  if (!rows.length) return null;
  const width = 720, card = 82, gap = 10, pad = 16;
  const canvas = createCanvas(width, pad * 2 + rows.length * card + (rows.length - 1) * gap);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#bda289'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const max = Math.max(1, ...rows.map(p => Math.max(p.damage, p.healing)));
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i], y = pad + i * (card + gap), value = Math.max(p.damage, p.healing), heal = p.healing > p.damage;
    ctx.fillStyle = '#a28c78'; ctx.beginPath(); ctx.roundRect(pad, y, width - pad * 2, card, 12); ctx.fill();
    ctx.fillStyle = heal ? '#21b293' : '#ff4d6d'; ctx.beginPath(); ctx.roundRect(pad, y, (width - pad * 2) * value / max, card, 12); ctx.fill();
    if (p.weapon) try { const img = await loadImage(`https://render.albiononline.com/v1/item/${encodeURIComponent(p.weapon)}.png`); ctx.drawImage(img, pad + 10, y + 11, 60, 60); } catch (_) {}
    ctx.fillStyle = '#000'; ctx.font = 'bold 20px sans-serif'; ctx.fillText(p.name.slice(0, 30), pad + 84, y + 34);
    ctx.font = 'bold 15px sans-serif'; ctx.fillText(`${heal ? 'HEAL' : 'DMG'}  ${fmt(value)}  (${Math.round(value / max * 100)}%)`, pad + 84, y + 59);
  }
  return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: 'top-performance.png' });
}
async function report(input, interaction) {
  try {
    const id = extractId(input);
    const data = await getBattle(id);
    if (!data.players.length) return interaction.editReply('❌ ไม่พบข้อมูลผู้เล่นในไฟต์นี้');
    const guildSet = new Set(targetGuilds.map(x => x.toLowerCase()));
    const playerSet = new Set(targetPlayers.map(x => x.toLowerCase()));
    const filtered = targetGuilds.length || targetPlayers.length
      ? data.players.filter(p => playerSet.has(p.name.toLowerCase()) || guildSet.has((p.guild || '').toLowerCase()))
      : data.players;
    if (!filtered.length) return interaction.editReply('❌ ไม่พบกิลด์หรือผู้เล่นที่ติดตามในไฟต์นี้');
    const rows = filtered.sort((a, b) => b.fame - a.fame || b.kills - a.kills);
    const totalK = rows.reduce((s, p) => s + p.kills, 0);
    const totalD = rows.reduce((s, p) => s + p.deaths, 0);
    const totalF = rows.reduce((s, p) => s + p.fame, 0);
    const lines = rows.map(p => `${p.name.slice(0, 20).padEnd(20)} ${String(p.kills).padStart(5)} ${String(p.deaths).padStart(6)} ${fmt(p.fame).padStart(8)}`);
    const text = `⚔️ **ALBIONBB BATTLE REPORT**\n🆔 Match: \`${id}\`\n🕒 ${timeText(data.time)}\n\`\`\`\nName                 Kills Deaths     Fame\n${lines.join('\n').slice(0, 1500)}\n------------------------------\nTOTAL                ${String(totalK).padStart(5)} ${String(totalD).padStart(6)} ${fmt(totalF).padStart(8)}\n\`\`\``;
    const top = [...rows].filter(p => p.damage || p.healing).sort((a, b) => Math.max(b.damage, b.healing) - Math.max(a.damage, a.healing)).slice(0, 5);
    const file = await performanceImage(top);
    await interaction.editReply(file ? { content: text, files: [file] } : { content: text });
  } catch (e) {
    console.error('❌ Battle report:', e);
    await interaction.editReply(`❌ เกิดข้อผิดพลาด: \`${e.message}\``);
  }
}

const commands = [
  new SlashCommandBuilder().setName('check').setDescription('ตรวจสอบสถิติและรายการติดตาม')
    .addSubcommand(s => s.setName('battles').setDescription('เช็กไฟต์จาก AlbionBB').addStringOption(o => o.setName('link_or_id').setDescription('ลิงก์หรือ Match ID').setRequired(true)))
    .addSubcommand(s => s.setName('guilds').setDescription('แสดงกิลด์ที่ติดตาม'))
    .addSubcommand(s => s.setName('members').setDescription('แสดงผู้เล่นที่ติดตาม')),
  new SlashCommandBuilder().setName('add').setDescription('เพิ่มรายการติดตาม')
    .addSubcommand(s => s.setName('guild').setDescription('เพิ่มกิลด์').addStringOption(o => o.setName('name').setDescription('ชื่อกิลด์').setRequired(true)))
    .addSubcommand(s => s.setName('player').setDescription('เพิ่มผู้เล่น').addStringOption(o => o.setName('name').setDescription('ชื่อผู้เล่น').setRequired(true))),
  new SlashCommandBuilder().setName('remove').setDescription('ลบรายการติดตาม')
    .addSubcommand(s => s.setName('guild').setDescription('ลบกิลด์').addStringOption(o => o.setName('name').setDescription('ชื่อกิลด์').setRequired(true)))
    .addSubcommand(s => s.setName('player').setDescription('ลบผู้เล่น').addStringOption(o => o.setName('name').setDescription('ชื่อผู้เล่น').setRequired(true)))
].map(x => x.toJSON());

client.once('ready', async () => {
  console.log(`🟢 BOT ONLINE: ${client.user.tag}`);
  console.log(`🆔 Bot ID: ${client.user.id}`);
  console.log(`🏠 Servers: ${client.guilds.cache.size}`);
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Slash commands registered.');
  } catch (e) {
    console.error('❌ Slash command registration:', e.message);
  }
});

client.on('debug', m => console.log(`🔎 Discord: ${m}`));
client.on('warn', m => console.warn(`⚠️ Discord: ${m}`));
client.on('error', e => console.error('❌ Discord client:', e));
client.on('shardError', e => console.error('❌ Gateway shard error:', e));
client.on('shardDisconnect', (event, id) => console.error(`❌ Gateway disconnected shard ${id}:`, event?.code, event?.reason || ''));
client.on('shardReconnecting', id => console.error(`🔄 Gateway reconnecting shard ${id}...`));

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;
  const sub = interaction.options.getSubcommand();
  if (cmd === 'check') {
    if (sub === 'guilds') return interaction.reply(targetGuilds.length ? `🛡️ **กิลด์ที่ติดตาม (${targetGuilds.length})**\n${targetGuilds.map((x, i) => `${i + 1}. ${x}`).join('\n')}` : '🛡️ ไม่มีกิลด์ในระบบติดตาม');
    if (sub === 'members') return interaction.reply(targetPlayers.length ? `📋 **ผู้เล่นที่ติดตาม (${targetPlayers.length})**\n${targetPlayers.map((x, i) => `${i + 1}. ${x}`).join('\n')}` : '📋 ไม่มีผู้เล่นในระบบติดตาม');
    if (sub === 'battles') { await interaction.deferReply(); return report(interaction.options.getString('link_or_id'), interaction); }
  }
  if (cmd === 'add' || cmd === 'remove') {
    const name = interaction.options.getString('name').trim();
    const list = sub === 'guild' ? targetGuilds : targetPlayers;
    const label = sub === 'guild' ? 'กิลด์' : 'ผู้เล่น';
    const exists = list.some(x => x.toLowerCase() === name.toLowerCase());
    if (cmd === 'add') {
      if (exists) return interaction.reply({ content: `⚠️ ${label} **${name}** มีอยู่แล้ว`, ephemeral: true });
      list.push(name); saveData(); return interaction.reply(`✅ เพิ่ม${label} **${name}** แล้ว`);
    }
    if (!exists) return interaction.reply({ content: `❌ ไม่พบ${label} **${name}**`, ephemeral: true });
    if (sub === 'guild') targetGuilds = targetGuilds.filter(x => x.toLowerCase() !== name.toLowerCase());
    else targetPlayers = targetPlayers.filter(x => x.toLowerCase() !== name.toLowerCase());
    saveData(); return interaction.reply(`🗑️ ลบ${label} **${name}** แล้ว`);
  }
});

console.log('🔄 Attempting to login to Discord...');
console.log(`🔑 BOT_TOKEN loaded: ${TOKEN ? 'YES' : 'NO'}`);
console.log(`🔑 BOT_TOKEN length: ${TOKEN.length}`);
console.log('🛡️ Gateway intents: Guilds=ON ONLY');
console.log('🌐 Starting Discord Gateway login...');
// Never print any portion of the Discord token.
client.login(TOKEN).catch(e => {
  console.error('❌ Discord login failed:', e?.message || e);
  process.exit(1);
});

process.on('unhandledRejection', e => console.error('❌ Unhandled rejection:', e));
process.on('uncaughtException', e => console.error('❌ Uncaught exception:', e));
