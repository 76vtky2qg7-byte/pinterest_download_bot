import { BotError, readLimited } from './errors.js';

const suffixes = new Set('com fr de ch jp cl ca it co.uk nz ru com.au at pt co.kr es com.mx dk ph th com.uy co nl info kr ie vn com.vn ec mx in pe co.at hu co.in co.nz id com.ec com.py tw be uk com.bo com.pe'.split(' '));
export function isPinterestHost(host) {
  const match = host.match(/^(?:(?:www|[a-z]{2})\.)?pinterest\.(.+)$/);
  return Boolean(match && suffixes.has(match[1]));
}
function checkedUrl(input, short = false) {
  let url;
  try { url = new URL(input); } catch { throw new BotError('BAD_LINK', 'Пришли ссылку на видео Pinterest.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !(isPinterestHost(url.hostname) || (short && ['pin.it', 'api.pinterest.com'].includes(url.hostname)))) {
    throw new BotError('BAD_LINK', 'Поддерживаются только HTTPS-ссылки Pinterest и pin.it.');
  }
  if (url.hostname === 'api.pinterest.com' && !/^\/url_shortener\/[a-zA-Z0-9]+\/redirect\/?$/.test(url.pathname)) {
    throw new BotError('BAD_LINK', 'Неподдерживаемое перенаправление Pinterest.');
  }
  return url;
}
export async function resolvePin(input, fetcher = fetch, signal) {
  let url = checkedUrl(input, true);
  for (let n = 0; n < 6; n++) {
    const match = url.pathname.match(/^\/pin\/(?:[\w-]+--)?(\d+)(?:\/|$)/);
    if (isPinterestHost(url.hostname) && match) return { id: match[1], url: `https://www.pinterest.com/pin/${match[1]}/` };
    if (!['pin.it', 'api.pinterest.com'].includes(url.hostname)) throw new BotError('BAD_LINK', 'Нужна ссылка на отдельный пин с видео.');
    const response = await fetcher(url.href, { redirect: 'manual', signal });
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (![301,302,303,307,308].includes(response.status) || !location) throw new BotError('REDIRECT', 'Не удалось раскрыть короткую ссылку Pinterest.');
    url = checkedUrl(new URL(location, url).href, true);
  }
  throw new BotError('REDIRECT', 'Слишком много перенаправлений Pinterest.');
}
export function checkedMediaUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new BotError('NO_MP4', 'Pinterest не предоставил MP4-файл.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !(url.hostname === 'pinimg.com' || url.hostname.endsWith('.pinimg.com')) || !url.pathname.toLowerCase().endsWith('.mp4')) {
    throw new BotError('NO_MP4', 'Для этого пина нет поддерживаемого MP4-файла.');
  }
  return url.href;
}
function candidate(value, durationMilliseconds = false) {
  if (!value || typeof value !== 'object') return null;
  let url;
  try { url = checkedMediaUrl(value.url || value.contentUrl); } catch { return null; }
  const dimension = v => Math.max(0, parseInt(v, 10) || 0);
  let duration = 0;
  if (typeof value.duration === 'number') duration = value.duration / (durationMilliseconds ? 1000 : 1);
  else {
    const m = String(value.duration || '').match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/);
    if (m) duration = Number(m[1] || 0)*3600 + Number(m[2] || 0)*60 + Number(m[3] || 0);
  }
  return { url, width: dimension(value.width), height: dimension(value.height), duration };
}
function collectFormats(pin, out) {
  // Only the pin's recognized media fields, never arbitrary descendant objects.
  const lists = [pin.videos?.video_list,pin.videos?.videoList,pin.video?.videoList,pin.video?.video_list];
  for (const story of [pin.story_pin_data,pin.storyPinData]) {
    for (const page of Array.isArray(story?.pages) ? story.pages : []) {
      for (const block of Array.isArray(page?.blocks) ? page.blocks : []) {
        lists.push(block.video?.video_list,block.video?.videoList);
      }
    }
  }
  for (const list of lists) {
    if (!list || typeof list !== 'object') continue;
    for (const format of Object.values(list)) { const c=candidate(format,true);if(c)out.push(c); }
  }
}
export function parseVideo(html, pinId) {
  const candidates = [];
  const dedicated = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = match[1];
    const id = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1];
    const isRelay = /\bdata-relay-completed-request\s*=\s*["']true["']/i.test(attrs);
    if (!isRelay && !['video-snippet', '__PWS_DATA__', '__PWS_INITIAL_PROPS__'].includes(id)) continue;
    let json = match[2];
    if (isRelay) {
      // Pinterest streams Relay results as a registration call. Parse only its
      // literal JSON argument; never execute scripts from the remote page.
      const payload = json.match(/^\s*window\.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__\(\s*"(?:\\.|[^"\\])*"\s*,\s*(\{[\s\S]*\})\s*\)\s*;\s*$/);
      if (!payload) continue;
      json = payload[1];
    }
    let data;
    try { data = JSON.parse(json); } catch { continue; }
    if (id === 'video-snippet') {
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) if (item['@type'] === 'VideoObject') { const c = candidate(item); if (c) dedicated.push(c); }
    } else {
      function visit(value, depth = 0) {
        if (!value || typeof value !== 'object' || depth > 40) return;
        if (String(value.id) === pinId || String(value.entityId) === pinId) { collectFormats(value, candidates); return; }
        for (const child of Object.values(value)) visit(child, depth + 1);
      }
      visit(data);
    }
  }
  const all = [...candidates, ...dedicated];
  if (!all.length) throw new BotError('NO_MP4', 'Не найден MP4 этого пина. Он может быть закрыт, удалён или доступен только как поток HLS.');
  all.sort((a,b) => b.width*b.height - a.width*a.height);
  return all[0];
}
export async function getVideo(input, fetcher = fetch, signal) {
  const pin = await resolvePin(input, fetcher, signal);
  const response = await fetcher(pin.url, { redirect: 'manual', signal, headers: { 'accept': 'text/html' } });
  if (!response.ok) { await response.body?.cancel(); throw new BotError('PINTEREST_HTTP', `Pinterest вернул HTTP ${response.status}. Попробуй позже.`); }
  const html = new TextDecoder().decode(await readLimited(response, 5_000_000));
  try {
    return { ...parseVideo(html, pin.id), pinId: pin.id };
  } catch (error) {
    if (!(error instanceof BotError) || error.code !== 'NO_MP4') throw error;
    // Only bounded structural facts, never upstream text, cookies or media URLs.
    const ids = [...html.matchAll(/<script\b[^>]*\bid\s*=\s*["']([\w-]{1,60})["']/gi)].map(m=>m[1]).slice(0,12);
    const count = pattern => [...html.matchAll(pattern)].length;
    throw new BotError('NO_MP4', `Pinterest не отдал распознаваемый MP4. Пришли этот ответ для диагностики.\n[diag1 pin=${pin.id}; html=${html.length}; scripts=${count(/<script\b/gi)}; mp4=${count(/\.mp4/gi)}; hls=${count(/\.m3u8/gi)}; schema=${html.includes('video-snippet')?1:0}; rsc=${html.includes('self.__next_f.push')?1:0}; ids=${ids.join(',') || '-'}]`);
  }
}
