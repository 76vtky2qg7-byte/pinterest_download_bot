import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

let muted = false;
const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
const rl = process.stdin.isTTY ? createInterface({ input:process.stdin,output,terminal:true }) : null;
async function setting(name, prompt, secret = false) {
  if (process.env[name]) return process.env[name].trim();
  if (!rl) throw Error(`Задай переменную ${name} перед запуском.`);
  process.stdout.write(prompt);
  muted = secret;
  const result=(await rl.question('')).trim();
  muted=false;process.stdout.write('\n');
  if (!result) throw Error(`Не заполнено ${name}.`);
  return result;
}
try {
  const botUrl = new URL(await setting('BOT_URL','URL Worker из результата deploy (https://...workers.dev): '));
  if (botUrl.protocol !== 'https:' || botUrl.username || botUrl.password || botUrl.search || botUrl.hash || !['','/'].includes(botUrl.pathname)) throw Error('Нужен корневой HTTPS-адрес Worker без параметров.');
  const token=await setting('BOT_TOKEN','Токен BotFather (ввод скрыт): ',true);
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw Error('Некорректный формат токена BotFather.');
  const secret=await setting('WEBHOOK_SECRET','WEBHOOK_SECRET, который сохранён в Cloudflare (ввод скрыт): ',true);
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw Error('WEBHOOK_SECRET: 32–256 букв, цифр, символов _ или -.');
  async function api(method,body) {
    let response;
    try { response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20_000)}); }
    catch { throw Error('Не удалось подключиться к Telegram. Токен не выводится в журнал.'); }
    const data=await response.json();
    if (!response.ok || !data.ok) throw Error(`Ошибка Telegram API (${data.error_code || response.status}). Проверь токен и параметры.`);
    return data.result;
  }
  const health=await fetch(new URL('/health',botUrl),{signal:AbortSignal.timeout(15_000)});
  if (!health.ok || !(await health.json()).ok) throw Error('Worker ещё не настроен: проверь DB и три секретных переменных.');
  const bot=await api('getMe',{});
  await api('setWebhook',{url:new URL('/webhook',botUrl).href,secret_token:secret,allowed_updates:['message'],max_connections:1,drop_pending_updates:false});
  await api('setMyCommands',{commands:[{command:'start',description:'Начать скачивание видео Pinterest'},{command:'help',description:'Как пользоваться ботом'}]});
  const info=await api('getWebhookInfo',{});
  if(info.url!==new URL('/webhook',botUrl).href)throw Error('Telegram не подтвердил адрес webhook.');
  console.log(`Webhook подключён. Открой https://t.me/${bot.username} и отправь /start.`);
  console.log('Проверь отправку https://pin.it/15s01XzaL. До получения MP4 бот не считается проверенным в Telegram.');
} catch(error) { console.error(error.message);process.exitCode=1; }
finally { muted=false;rl?.close(); }
