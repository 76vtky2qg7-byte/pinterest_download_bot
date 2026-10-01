import test from 'node:test';
import assert from 'node:assert/strict';

// Literal fixtures pin user-visible contracts, not implementation structure.
import { resolvePin, parseVideo, getVideo } from '../src/pinterest.js';
const mp4 = 'https://v1.pinimg.com/videos/example_720w.mp4';
const primary = (url = mp4) => `<script id="video-snippet" type="application/ld+json">${JSON.stringify({'@type':'VideoObject',contentUrl:url,width:'720 px',height:'1280 px',duration:'PT16S','@id':'https://www.pinterest.com/pin/999/'})}</script>`;

test('ordinary and regional pin URLs normalize without share parameters', async () => {
  for (const u of ['https://ru.pinterest.com/pin/914090055622372740/sent/?sender=123', 'https://www.pinterest.co.uk/pin/title--914090055622372740/']) {
    assert.equal((await resolvePin(u)).url, 'https://www.pinterest.com/pin/914090055622372740/');
  }
});
test('reject arbitrary websites, credentials, ports and deceptive host suffixes', async () => {
  for (const u of ['https://pinterest.com.evil.test/pin/123/', 'https://evilpinterest.com/pin/123/', 'https://user@pinterest.com/pin/123/', 'https://pinterest.com:8080/pin/123/', 'http://pinterest.com/pin/123/', 'https://pinterest.com/board/']) await assert.rejects(()=>resolvePin(u));
});
test('short links follow Pinterest redirect but never fetch external destination', async () => {
  const calls=[];
  const fetcher=async u=>{calls.push(String(u));return new Response(null,{status:302,headers:{location:'https://ru.pinterest.com/pin/123/sent/?x=1'}});};
  assert.equal((await resolvePin('https://pin.it/15s01XzaL',fetcher)).id,'123');
  assert.deepEqual(calls,['https://pin.it/15s01XzaL']);
  await assert.rejects(()=>resolvePin('https://pin.it/abc',async()=>new Response(null,{status:302,headers:{location:'https://evil.test/'}})));
});
test('redirect loop stops within a bounded number of requests', async () => {
  let n=0; await assert.rejects(()=>resolvePin('https://pin.it/a',async()=>{n++;return new Response(null,{status:302,headers:{location:'https://pin.it/a'}});}));
  assert.ok(n<=6);
});
test('dedicated video schema supports repins while excluding recommendation videos', () => {
  const html=`<script type="application/ld+json">{"@type":"VideoObject","contentUrl":"https://v1.pinimg.com/recommendation.mp4"}</script>${primary()}`;
  assert.deepEqual(parseVideo(html,'123'),{url:mp4,width:720,height:1280,duration:16});
});
test('legacy pin data chooses largest published MP4 of requested pin only', () => {
  const html=`<script id="__PWS_DATA__" type="application/json">${JSON.stringify({pins:[{id:'123',videos:{video_list:{small:{url:mp4,width:360,height:640},large:{url:'https://v1.pinimg.com/large.mp4',width:720,height:1280,duration:16000}}}},{id:'999',videos:{video_list:{other:{url:'https://v1.pinimg.com/other.mp4',width:4000,height:4000}}}}]})}</script>`;
  assert.equal(parseVideo(html,'123').url,'https://v1.pinimg.com/large.mp4');
});
test('nested recommendation inside requested pin never replaces its own video',()=>{
  const pin={id:'123',videos:{video_list:{own:{url:mp4,width:720,height:1280}}},related_pins:[{id:'999',videos:{video_list:{other:{url:'https://v1.pinimg.com/unrelated.mp4',width:4000,height:4000}}}}]};
  const html=`<script id="__PWS_DATA__" type="application/json">${JSON.stringify(pin)}</script>`;
  assert.equal(parseVideo(html,'123').url,mp4);
});
test('only HLS, unrelated video, unsafe CDN or malformed data never invent MP4', () => {
  for(const html of [primary('https://v1.pinimg.com/a.m3u8'),primary('https://pinimg.com.evil.test/a.mp4'),'<script id="video-snippet">{bad}</script>','<script type="application/ld+json">{"contentUrl":"https://v1.pinimg.com/other.mp4"}</script>']) assert.throws(()=>parseVideo(html,'123'));
});
test('HTTP extraction validates response and rejects excessive HTML', async () => {
  assert.equal((await getVideo('https://pinterest.com/pin/123/',async()=>new Response(primary()))).url,mp4);
  await assert.rejects(()=>getVideo('https://pinterest.com/pin/123/',async()=>new Response('forbidden',{status:403})));
  await assert.rejects(()=>getVideo('https://pinterest.com/pin/123/',async()=>new Response('x',{headers:{'content-length':'9000000'}})));
});
