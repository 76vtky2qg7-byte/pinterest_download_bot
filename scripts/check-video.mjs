import { writeFile } from 'node:fs/promises';
import { getVideo } from '../src/pinterest.js';
import { readLimited } from '../src/errors.js';
import { MAX_VIDEO_BYTES } from '../src/telegram.js';
const input=process.argv[2];
if(!input) { console.error('Использование: npm run check:video -- https://pin.it/15s01XzaL [sample.mp4]');process.exit(1); }
try {
  const signal=AbortSignal.timeout(60_000);
  const video=await getVideo(input,fetch,signal);
  const response=await fetch(video.url,{signal,redirect:'manual'});
  if(!response.ok)throw Error(`Видеосервер вернул HTTP ${response.status}`);
  const bytes=await readLimited(response,MAX_VIDEO_BYTES);
  if(new TextDecoder().decode(bytes.subarray(4,8))!=='ftyp')throw Error('Ответ не является MP4');
  const path=process.argv[3] || 'sample.mp4';
  await writeFile(path,bytes);
  console.log(JSON.stringify({pinId:video.pinId,bytes:bytes.length,path},null,2));
} catch(error) { console.error(error.message);process.exitCode=1; }
