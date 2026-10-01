import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { handleRequest } from '../src/index.js';
import { sendVideo } from '../src/telegram.js';

test('Workers execution context is never mistaken for the network transport',async(t)=>{
  const {env,sql}=environment();let sends=0;
  t.mock.method(globalThis,'fetch',async()=>{sends++;return Response.json({ok:true,result:{message_id:1}});});
  const response=await worker.fetch(request(update()),env,{waitUntil(){},passThroughOnException(){}});
  assert.equal(response.status,200);assert.equal(sends,1);
  assert.equal(sql.prepare('SELECT status FROM updates').get().status,'done');sql.close();
});

function environment() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../migrations/0001_updates.sql', import.meta.url),'utf8'));
  // D1's external interface, backed by actual SQLite and the actual migration.
  const DB={prepare(query){return {bind(...values){return {async run(){const r=sql.prepare(query).run(...values);return {success:true,meta:{changes:Number(r.changes)}};}};}};}};
  return {env:{DB,BOT_TOKEN:'test-token',WEBHOOK_SECRET:'test-secret',ALLOWED_USER_ID:'123'},sql};
}
const request=(update,secret='test-secret')=>new Request('https://bot.example/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':secret},body:JSON.stringify(update)});
const update=(id=1,user=123,text='/start')=>({update_id:id,message:{message_id:id,chat:{id:user,type:'private'},from:{id:user,is_bot:false},text}});
const bytes=new Uint8Array([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,65,66,67]);
const video={url:'https://v1.pinimg.com/example.mp4',pinId:'321',duration:16};
const primary='<script id="video-snippet" type="application/ld+json">{"@type":"VideoObject","contentUrl":"https://v1.pinimg.com/example.mp4"}</script>';

test('wrong webhook secret and foreign users never reach Telegram or database claim',async()=>{
  const {env,sql}=environment();
  const noNetwork=()=>{throw Error('network forbidden');};
  assert.equal((await handleRequest(request(update(),'wrong'),env,noNetwork)).status,403);
  assert.equal((await handleRequest(request(update(2,456)),env,noNetwork)).status,200);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM updates').get().n,0); sql.close();
});
test('start responds and duplicate/concurrent update is claimed only once',async()=>{
  const {env,sql}=environment(); let sends=0;
  const network=async(u,opts)=>{assert.ok(String(u).endsWith('/sendMessage'));assert.equal(JSON.parse(opts.body).chat_id,123);sends++;return Response.json({ok:true,result:{message_id:10}});};
  const responses=await Promise.all([handleRequest(request(update()),env,network),handleRequest(request(update()),env,network)]);
  assert.deepEqual(responses.map(r=>r.status),[200,200]);assert.equal(sends,1);
  assert.equal(sql.prepare('SELECT status FROM updates WHERE update_id=1').get().status,'done');sql.close();
});
test('missing configuration fails closed; malformed request and wrong routes are rejected',async()=>{
  const {env,sql}=environment();
  assert.equal((await handleRequest(request(update()),{...env,ALLOWED_USER_ID:''})).status,503);
  assert.equal((await handleRequest(new Request('https://bot.example/webhook',{method:'POST',headers:{'x-telegram-bot-api-secret-token':'test-secret'},body:'not json'}),env)).status,400);
  assert.equal((await handleRequest(new Request('https://bot.example/not-a-route'),env)).status,404);sql.close();
});
test('streamed multipart upload preserves exact source bytes and chat destination',async()=>{
  const {env,sql}=environment();let delivered;
  const network=async(u,opts)=>{
    if(String(u)===video.url)return new Response(bytes,{headers:{'content-type':'video/mp4','content-length':String(bytes.length)}});
    assert.ok(String(u).endsWith('/sendVideo'));
    const form=await new Request('https://local.invalid',{...opts,duplex:'half'}).formData();
    assert.equal(form.get('chat_id'),'123'); assert.equal(form.get('supports_streaming'),'true');
    delivered=new Uint8Array(await form.get('video').arrayBuffer());
    return Response.json({ok:true,result:{message_id:42}});
  };
  await sendVideo(env,123,video,network);
  assert.deepEqual(delivered,bytes);sql.close();
});
test('known oversized file, unknown-length overflow and HTML response cannot be sent as video',async()=>{
  const {env,sql}=environment();
  await assert.rejects(()=>sendVideo(env,123,video,async()=>new Response(bytes,{headers:{'content-type':'video/mp4','content-length':'50000000'}})),{code:'TOO_LARGE'});
  await assert.rejects(()=>sendVideo(env,123,video,async()=>new Response('<html>error</html>',{headers:{'content-type':'text/html'}})),{code:'MEDIA_TYPE'});
  const large=new Uint8Array(49_000_001);large.set(bytes);
  await assert.rejects(()=>sendVideo(env,123,video,async(u,opts)=>{
    if(String(u)===video.url)return new Response(large,{headers:{'content-type':'video/mp4'}});
    await new Response(opts.body).arrayBuffer();return Response.json({ok:true});
  }),{code:'TOO_LARGE'});sql.close();
});
test('real webhook flow extracts primary video and records delivered result',async()=>{
  const {env,sql}=environment();let delivered=false;
  const network=async(u,opts)=>{
    if(String(u)==='https://www.pinterest.com/pin/321/')return new Response(primary);
    if(String(u)===video.url)return new Response(bytes,{headers:{'content-type':'video/mp4'}});
    if(String(u).endsWith('/sendVideo')){const f=await new Request('https://local.invalid',{...opts,duplex:'half'}).formData();assert.deepEqual(new Uint8Array(await f.get('video').arrayBuffer()),bytes);delivered=true;}
    return Response.json({ok:true,result:{message_id:42}});
  };
  assert.equal((await handleRequest(request(update(1,123,'Скачай https://pinterest.com/pin/321/')),env,network)).status,200);
  assert.equal(delivered,true);assert.equal(sql.prepare('SELECT status FROM updates').get().status,'done');sql.close();
});
test('Pinterest failure is explained and never masquerades as successful delivery',async()=>{
  const {env,sql}=environment();const messages=[];
  const network=async(u,opts)=>{
    if(String(u).includes('pinterest.com'))return new Response('no',{status:403});
    assert.ok(String(u).endsWith('/sendMessage'));messages.push(JSON.parse(opts.body).text);return Response.json({ok:true,result:{message_id:42}});
  };
  await handleRequest(request(update(1,123,'https://pinterest.com/pin/321/')),env,network);
  assert.ok(messages.some(m=>m.includes('403')));
  assert.deepEqual({...sql.prepare('SELECT status,error_code FROM updates').get()},{status:'failed',error_code:'PINTEREST_HTTP'});sql.close();
});
test('Telegram API error is surfaced without automatic second upload',async()=>{
  const {env,sql}=environment();let uploads=0;
  await assert.rejects(()=>sendVideo(env,123,video,async(u,opts)=>{
    if(String(u)===video.url)return new Response(bytes,{headers:{'content-type':'video/mp4'}});
    uploads++;await new Response(opts.body).arrayBuffer();return Response.json({ok:false,error_code:400,description:'Bad Request'});
  }),{code:'TELEGRAM_API'});
  assert.equal(uploads,1);sql.close();
});
