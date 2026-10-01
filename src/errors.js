export class BotError extends Error {
  constructor(code, message) { super(message); this.name = 'BotError'; this.code = code; }
}

export async function readLimited(response, maxBytes) {
  const length = Number(response.headers.get('content-length'));
  if (length > maxBytes) {
    await response.body?.cancel();
    throw new BotError('TOO_LARGE', 'Файл или ответ сайта превышает допустимый размер.');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const parts = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new BotError('TOO_LARGE', 'Файл или ответ сайта превышает допустимый размер.');
      parts.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}
