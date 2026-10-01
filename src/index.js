import { BotError, readLimited } from './errors.js';
import { getVideo } from './pinterest.js';
import { sendMessage, sendVideo } from './telegram.js';

const HELP='Отправь ссылку на видео Pinterest — обычную или короткую pin.it. Я пришлю MP4 со звуком без рекламы и подписок.\n\nМаксимум 49 МБ. Закрытые пины, сторонние видеохостинги и видео только в формате HLS не поддерживаются.';
function configured(env) {
  return Boolean(env.DB && env.BOT_TOKEN && env.WEBHOOK_SECRET && /^\d+$/.test(env.ALLOWED_USER_ID || '') && Number.isSafeInteger(Number(env.ALLOWED_USER_ID)) && Number(env.ALLOWED_USER_ID)>0);
}
export async function handleRequest(request, env, fetcher = fetch) {
  const path = new URL(request.url).pathname;
  if (request.method === 'GET' && path === '/health') return Response.json({ok:configured(env)}, {status:configured(env)?200:503});
  // Temporary read-only probe: one fixed public pin, no user input or credentials.
  if (request.method === 'GET' && path === '/diagnostics/pinterest') {
    const signal=AbortSignal.timeout(20_000);
    const video=await getVideo('https://www.pinterest.com/pin/914090055622372740/',fetcher,signal);
    const response=await fetcher(video.url,{redirect:'manual',signal});
    if(!response.ok)throw new Error('Public MP4 probe failed');
    const bytes=await readLimited(response,5_000_000);
    if(new TextDecoder().decode(bytes.subarray(4,8))!=='ftyp')throw new Error('Public probe did not return MP4');
    return Response.json({ok:true,pinId:video.pinId,bytes:bytes.length,format:'mp4'},{headers:{'cache-control':'no-store'}});
  }
  if (path !== '/webhook' || request.method !== 'POST') return new Response('Not found',{status:404});
  if (!configured(env)) return new Response('Bot not configured',{status:503});
  if (request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('Forbidden',{status:403});
  let update;
  try { update=JSON.parse(new TextDecoder().decode(await readLimited(request,32_000))); }
  catch { return new Response('Invalid update',{status:400}); }
  if (!update || !Number.isSafeInteger(update.update_id) || update.update_id<0) return new Response('Invalid update',{status:400});
  const message=update.message;
  if (!message || message.chat?.type !== 'private' || message.from?.is_bot ||
      String(message.from?.id)!==env.ALLOWED_USER_ID || String(message.chat?.id)!==env.ALLOWED_USER_ID || typeof message.text!=='string') return new Response('OK');
  const now=Date.now();
  try {
    const claim=await env.DB.prepare("INSERT OR IGNORE INTO updates (update_id,status,created_at) VALUES (?,'processing',?)").bind(update.update_id,now).run();
    if (!claim.meta.changes) return new Response('OK');
  } catch { return new Response('State unavailable',{status:503}); }
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),45_000);
  try {
    const text=message.text.trim();
    if (/^\/(start|help)(?:@\w+)?(?:\s|$)/i.test(text)) await sendMessage(env,message.chat.id,HELP,fetcher,controller.signal);
    else {
      const link=text.match(/https:\/\/[^\s<>"']+/i)?.[0]?.replace(/[),.!?]+$/,'');
      if (!link) throw new BotError('BAD_LINK','Пришли ссылку на видео Pinterest.');
      const video=await getVideo(link,fetcher,controller.signal);
      await sendVideo(env,message.chat.id,video,fetcher,controller.signal);
    }
    await env.DB.prepare("UPDATE updates SET status='done',finished_at=? WHERE update_id=?").bind(Date.now(),update.update_id).run();
  } catch(error) {
    const code=controller.signal.aborted?'TIMEOUT':error instanceof BotError?error.code:'REQUEST_FAILED';
    const text=code==='TIMEOUT'?'Не удалось завершить запрос за 45 секунд. Если видео не пришло, отправь ссылку новым сообщением.':
      error instanceof BotError?error.message:'Не удалось завершить запрос. Если видео не пришло, попробуй отправить ссылку новым сообщением.';
    // Never log tokens, API URLs, message text or raw upstream errors.
    console.error(JSON.stringify({event:'request_failed',update_id:update.update_id,code}));
    try { await env.DB.prepare("UPDATE updates SET status='failed',error_code=?,finished_at=? WHERE update_id=?").bind(code,Date.now(),update.update_id).run(); } catch {}
    try { await sendMessage(env,message.chat.id,text,fetcher,AbortSignal.timeout(5_000)); } catch {}
  } finally { clearTimeout(timer); }
  // Expired claims no longer need storage; Telegram retains undelivered updates at most 24 hours.
  try { await env.DB.prepare('DELETE FROM updates WHERE created_at < ?').bind(now-7*24*3600*1000).run(); } catch {}
  return new Response('OK');
}
export default { fetch(request, env) { return handleRequest(request, env); } };
