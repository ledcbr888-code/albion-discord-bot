'use strict';
// External, read-only HTTP smoke probes for PR review. No Discord, Supabase or Render calls.
// Keep targets fixed, requests sequential, and timeouts short. Failures are reported, not retried.
const axios = require('axios');
const cheerio = require('cheerio');

const map = 'ponitos-aiayrom'; // Identified in existing AVA code as a known valid zone
const battle = '529444205'; // Previously observed public Asia battle ID
const targets = [
  { name: 'AVA primary TH (unchanged)', url: 'https://albionbattlehub.com/th/avalon-maps/' + map, kind: 'html', timeout: 9000 },
  { name: 'AVA primary EN (unchanged)', url: 'https://albionbattlehub.com/en/avalon-maps/' + map, kind: 'html', timeout: 9000 },
  { name: 'AVA Avalon tracker (unchanged)', url: 'https://avalonroads-97617.web.app/mapas/' + map + '.html', kind: 'html', timeout: 9000 },
  { name: 'AVA Albion Online Builds (changed)', url: 'https://www.albiononlinebuilds.com/maps/avalon/' + map, kind: 'html', timeout: 9000 },
  { name: 'AVA Albion Roads (changed)', url: 'https://albionroads.com/?search=' + map, kind: 'html', timeout: 9000 },
  { name: 'AlbionBB HTML fallback (changed; manual only)', url: 'https://east.albionbb.com/battles/' + battle, kind: 'html', timeout: 9000 },
  { name: 'AlbionBB weapon fallback (changed; manual only)', url: 'https://api.albionbb.com/asia/battles/kills?ids=' + battle, kind: 'json', timeout: 9000 }
];

async function main() {
  let ok = 0;
  const results = [];
  const responses = new Map();
  for (const t of targets) {
    const started = Date.now();
    try {
      const response = await axios.get(t.url, {
        timeout: t.timeout,
        maxRedirects: 3,
        maxContentLength: 2000000,
        responseType: 'text',
        validateStatus: () => true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
          Accept: t.kind === 'json' ? 'application/json,text/plain,*/*' : 'text/html,application/xhtml+xml,*/*',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
      const body = String(response.data || '');
      const contentType = String(response.headers?.['content-type'] || '');
      const html = t.kind === 'html' ? cheerio.load(body) : null;
      const title = html ? html('title').first().text().trim().slice(0,100) : '';
      const challenge = /just a moment|checking your browser|cf-chl|captcha/i.test(body.slice(0,15000));
      const validContentType = t.kind === 'html'
        ? (/html/.test(contentType) && body.length > 200)
        : (/json/.test(contentType) && body.trim().startsWith('{') || body.trim().startsWith('['));
      const accessible = response.status >= 200 && response.status < 300 && validContentType && !challenge;
      if (accessible) ok++;
      if (response.status >= 200 && response.status < 300) responses.set(t.name, body);
      const result = {
        name: t.name, status: response.status, accessible,
        durationMs: Date.now()-started, bytes: Buffer.byteLength(body),
        contentType: contentType.slice(0,100), title, challenge
      };
      results.push(result);
      console.log('LIVE_FALLBACK_PROBE ' + JSON.stringify(result));
    } catch (error) {
      const result = { name:t.name, accessible:false, status: error.response?.status || null,
        error: error.code || error.message, durationMs:Date.now()-started };
      results.push(result);
      console.log('LIVE_FALLBACK_PROBE ' + JSON.stringify(result));
    }
  }

  // Execute the real, unchanged AVA parsing function on the live HTML captured
  // above, rather than accepting an HTTP 200 alone as proof of valid map data.
  try {
    const fs = require('node:fs');
    const vm = require('node:vm');
    const src = fs.readFileSync('index.js', 'utf8');
    const helperStart = src.indexOf('const AVA_MAP_SOURCE = ');
    const helperEnd = src.indexOf('function formatAvaConnection(', helperStart);
    const parserStart = src.indexOf('async function fetchAvaMapData(');
    const parserEnd = src.indexOf('\\nfunction avaCountLine(', parserStart);
    if ([helperStart, helperEnd, parserStart, parserEnd].some(v=>v<0)) throw Error('AVA source parsing boundaries missing');
    const runAvaParser = vm.runInNewContext(
      src.slice(helperStart, helperEnd) + '\\n' +
      src.slice(parserStart, parserEnd) + '\\nfetchAvaMapData',
      {
        axios: {get: async (url) => {
          const key = url.includes('/th/avalon-maps/') ? 'AVA primary TH (unchanged)' : 'AVA primary EN (unchanged)';
          const body = responses.get(key);
          if (!body) throw Error('Live ' + key + ' body unavailable');
          return {data: body};
        }},
        cheerio, URL, decodeURIComponent
      }
    );
    const data = await runAvaParser('Ponitos-Aiayrom');
    const totalPOIs = data.totalChests+data.totalResources+data.totalDungeons;
    console.log('LIVE_AVA_PARSED ' + JSON.stringify({
      ok: Boolean(data.tier && data.tier!=='ไม่พบข้อมูล' && totalPOIs>0),
      name: data.name?.slice(0,90), tier:data.tier, layout:data.layout,
      totalChests:data.totalChests, totalResources:data.totalResources,
      totalDungeons:data.totalDungeons, totalPOIs, hasMapImage:Boolean(data.mapImage),
      sourceUrl:data.sourceUrl
    }));
  } catch (error) {
    console.log('LIVE_AVA_PARSED '+JSON.stringify({ok:false,error:error.message}));
  }
  try {
    const response = responses.get('AlbionBB weapon fallback (changed; manual only)');
    if (response) {
      const value = JSON.parse(response);
      const events = Array.isArray(value) ? value :
        Array.isArray(value?.events) ? value.events :
        Array.isArray(value?.kills) ? value.kills : [];
      console.log('LIVE_ALBIONBB_DATA_SHAPE '+JSON.stringify({
        rootType:Array.isArray(value)?'array':typeof value,
        rootKeys:Array.isArray(value)?[]:Object.keys(value).slice(0,12),
        recognizedEvents:events.length, compatibleWithWeaponFallback:events.length>0
      }));
    }
  } catch (error) {
    console.log('LIVE_ALBIONBB_DATA_SHAPE '+JSON.stringify({error:error.message}));
  }
  const roadsBody = responses.get('AVA Albion Roads (changed)');
  if (roadsBody) {
    const text = cheerio.load(roadsBody)('body').text().toLowerCase().replace(/\\s+/g,' ');
    console.log('LIVE_AVA_ROADS_CONTENT '+JSON.stringify({
      mentionsRequestedMap:text.includes(map), bytes:Buffer.byteLength(roadsBody)
    }));
  }

  const primaryOk = results.filter(x=>x.name.startsWith('AVA primary')&&x.accessible).length;
  const fallbackOk = results.filter(x=>x.name.includes('(changed')&&x.accessible).length;
  console.log('LIVE_FALLBACK_SUMMARY ' + JSON.stringify({
    total: targets.length, accessible: ok, primaryAvaAccessible: primaryOk,
    changedSourceAccessible: fallbackOk, warning: !primaryOk ?
    'Primary AVA endpoints not reachable from GitHub runner; not a functional end-to-end /ava verdict' :
    'Primary AVA endpoints reachable from GitHub runner'
  }));
  // This is an external availability probe; a provider returning 403 is a finding,
  // not a code-test failure. The bot must still pass isolated functional tests.
}
main().catch(e => { console.error('LIVE_FALLBACK_PROBE_FATAL',e.message);process.exitCode=1; });
