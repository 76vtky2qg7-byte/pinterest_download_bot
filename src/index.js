import { BotError, readLimited } from './errors.js';
import { getVideo } from './pinterest.js';
import { sendMessage, sendVideo } from './telegram.js';

const HELP='Отправь ссылку на видео Pinterest — обычную или короткую pin.it. Я пришлю MP4 со звуком без рекламы и подписок.\n\nМаксимум 49 МБ. Закрытые пины, сторонние видеохостинги и видео только в формате HLS не поддерживаются.';
const HISTORY_MS=7*24*3600*1000;
async function prepareDownloadHistory(env) {
  // Add classification without changing the existing update-state table or
  // requiring the owner to run a dashboard migration during this update.
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS download_requests (update_id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL)').run();
}
function configured(env) {
  return Boolean(env.DB && env.BOT_TOKEN && env.WEBHOOK_SECRET && /^\d+$/.test(env.ALLOWED_USER_ID || '') && Number.isSafeInteger(Number(env.ALLOWED_USER_ID)) && Number(env.ALLOWED_USER_ID)>0);
}
export async function handleRequest(request, env, fetcher = fetch) {
  const path = new URL(request.url).pathname;
  if (request.method === 'GET' && path === '/health') return Response.json({ok:configured(env),version:'2026-10-01-telegram-menu'}, {status:configured(env)?200:503});
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
  let downloadHistoryReady=false;
  try {
    const text=message.text.trim();
    if (/^\/(start|help|menu)(?:@\w+)?(?:\s|$)/i.test(text) || text==='Помощь') await sendMessage(env,message.chat.id,HELP,fetcher,controller.signal);
    else if (text==='Скачать видео' || /^\/download(?:@\w+)?(?:\s|$)/i.test(text)) {
      await sendMessage(env,message.chat.id,'Пришли ссылку на видео Pinterest.\n\nВ Pinterest нажми «Поделиться» → «Копировать ссылку» и вставь её сюда.',fetcher,controller.signal);
    } else if (text==='Статистика' || /^\/stats(?:@\w+)?(?:\s|$)/i.test(text)) {
      await prepareDownloadHistory(env);downloadHistoryReady=true;
      const counts=await env.DB.prepare("SELECT COALESCE(SUM(u.status='done'),0) AS completed, COALESCE(SUM(u.status='failed'),0) AS failed, COALESCE(SUM(u.status='processing'),0) AS unfinished FROM download_requests d JOIN updates u ON u.update_id=d.update_id WHERE d.created_at>=?").bind(now-HISTORY_MS).first();
      await sendMessage(env,message.chat.id,`Статистика за последние 7 дней\n\nСкачано видео: ${counts.completed}\nОшибок скачивания: ${counts.failed}\nНе завершены: ${counts.unfinished}\n\nУчёт ведётся с обновления меню. Более ранние скачивания не включены.`,fetcher,controller.signal);
    }
    else {
      const link=text.match(/https:\/\/[^\s<>"']+/i)?.[0]?.replace(/[),.!?]+$/,'');
      if (!link) throw new BotError('BAD_LINK','Пришли ссылку на видео Pinterest.');
      await prepareDownloadHistory(env);downloadHistoryReady=true;
      await env.DB.prepare('INSERT INTO download_requests (update_id,created_at) VALUES (?,?)').bind(update.update_id,now).run();
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
  try { await env.DB.prepare('DELETE FROM updates WHERE created_at < ?').bind(now-HISTORY_MS).run(); } catch {}
  if(downloadHistoryReady) {
    try { await env.DB.prepare('DELETE FROM download_requests WHERE created_at < ?').bind(now-HISTORY_MS).run(); } catch {}
  }
  return new Response('OK');
}
export default { fetch(request, env) { return handleRequest(request, env); } };
