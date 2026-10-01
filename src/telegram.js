import { BotError, readLimited } from './errors.js';
import { checkedMediaUrl } from './pinterest.js';

export const MAX_VIDEO_BYTES = 49_000_000;
const encoder = new TextEncoder();
const keyboard = {
  keyboard: [[{text:'Скачать видео'}],[{text:'Помощь'},{text:'Статистика'}]],
  resize_keyboard:true,
  is_persistent:true,
  input_field_placeholder:'Вставь ссылку Pinterest'
};
function apiUrl(env, method) { return `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`; }
async function apiResult(response) {
  let data;
  try { data = JSON.parse(new TextDecoder().decode(await readLimited(response, 128_000))); }
  catch { throw new BotError('TELEGRAM_API', 'Telegram вернул некорректный ответ.'); }
  if (!response.ok || !data.ok) throw new BotError('TELEGRAM_API', `Telegram не принял запрос (код ${data.error_code || response.status}).`);
  return data.result;
}
export async function sendMessage(env, chatId, text, fetcher = fetch, signal) {
  return apiResult(await fetcher(apiUrl(env,'sendMessage'), {
    method:'POST',signal,headers:{'content-type':'application/json'},
    body:JSON.stringify({chat_id:chatId,text,link_preview_options:{is_disabled:true},reply_markup:keyboard})
  }));
}
export async function sendVideo(env, chatId, video, fetcher = fetch, signal) {
  const response = await fetcher(checkedMediaUrl(video.url), {redirect:'manual',signal});
  if (!response.ok) { await response.body?.cancel(); throw new BotError('MEDIA_HTTP', `Видеосервер Pinterest вернул HTTP ${response.status}.`); }
  if (Number(response.headers.get('content-length')) > MAX_VIDEO_BYTES) {
    await response.body?.cancel(); throw new BotError('TOO_LARGE','Видео больше 49 МБ. Отправка в Telegram без уменьшения качества недоступна.');
  }
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!response.body || !['video/mp4','application/octet-stream','binary/octet-stream'].includes(type)) {
    await response.body?.cancel(); throw new BotError('MEDIA_TYPE','Вместо MP4 видеосервер вернул неподдерживаемый ответ.');
  }
  const reader = response.body.getReader();
  const boundary = `pinterest-${crypto.randomUUID()}`;
  const fields = { chat_id:String(chatId), supports_streaming:'true' };
  // Dimensions in Pinterest metadata may describe the original upload, not this MP4.
  // Telegram detects the actual dimensions from the uploaded file.
  const header = Object.entries(fields).map(([key,value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`).join('') +
    `--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="pinterest-${/^\d+$/.test(video.pinId) ? video.pinId : 'video'}.mp4"\r\nContent-Type: video/mp4\r\n\r\n`;
  async function* multipart() {
    try {
      yield encoder.encode(header);
      let count = 0;
      let inspected = false;
      let initial = [];
      let initialSize = 0;
      while (true) {
        const {done,value} = await reader.read();
        if (done) break;
        count += value.byteLength;
        if (count > MAX_VIDEO_BYTES) throw new BotError('TOO_LARGE','Видео больше 49 МБ. Загрузка прервана без уменьшения качества.');
        if (!inspected) {
          initial.push(value); initialSize += value.byteLength;
          if (initialSize < 12) continue;
          const magic = new Uint8Array(12); let offset = 0;
          for (const part of initial) { const n=Math.min(part.length,12-offset);magic.set(part.subarray(0,n),offset);offset+=n;if(offset===12)break; }
          if (new TextDecoder().decode(magic.subarray(4,8)) !== 'ftyp') throw new BotError('MEDIA_TYPE','Полученный файл не является поддерживаемым MP4.');
          inspected = true;
          for (const part of initial) yield part;
          initial=[];
        } else yield value;
      }
      if (!inspected) throw new BotError('MEDIA_TYPE','Видеофайл пуст или повреждён.');
      yield encoder.encode(`\r\n--${boundary}--\r\n`);
    } finally { await reader.cancel().catch(()=>{}); }
  }
  const iterator = multipart();
  const body = new ReadableStream({
    async pull(controller) {
      try { const {value,done}=await iterator.next();if(done)controller.close();else controller.enqueue(value); }
      catch(error) { controller.error(error); }
    },
    async cancel() { await reader.cancel().catch(()=>{});await iterator.return(); }
  });
  try {
    return await apiResult(await fetcher(apiUrl(env,'sendVideo'),{
      method:'POST',signal,headers:{'content-type':`multipart/form-data; boundary=${boundary}`},body,duplex:'half'
    }));
  } catch(error) {
    if (error.cause instanceof BotError) throw error.cause;
    throw error;
  } finally { await reader.cancel().catch(()=>{}); }
}
