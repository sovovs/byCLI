import { randomUUID } from 'node:crypto';
import { CommandExecutionError, TimeoutError } from '@sovovs/bycli/errors';

// Stream through Chrome's authenticated connection and certificate trust store.
// Only a 192 KiB chunk crosses the Browser Bridge at once; no cookie export.
export async function browserDownloadResponse(page, attachmentId) {
  const key = `__bycliAttachment_${randomUUID().replaceAll('-', '')}`;
  const start = await page.evaluate(async (id, stateKey) => {
    if (location.origin !== 'https://mail.iwhalecloud.com') return { status: 401 };
    const cookie = document.cookie.split(';').map(x => x.trim()).find(x => x.startsWith('X-OWA-CANARY='));
    if (!cookie) return { status: 401 };
    if (window[stateKey]) return window[stateKey].start;
    const state = { pending: new Uint8Array(0), sequence: -1 };
    window[stateKey] = state;
    state.start = (async () => {
      try {
        const response = await fetch(`/owa/service.svc/s/GetFileAttachment?id=${encodeURIComponent(id)}`, {
          credentials: 'same-origin', redirect: 'manual', signal: AbortSignal.timeout(120000),
          headers: { 'X-OWA-CANARY': decodeURIComponent(cookie.slice('X-OWA-CANARY='.length)) },
        });
        // Cross-origin/manual redirects are opaque in browsers (status 0).
        if (response.status !== 200 || !response.body) {
          await response.body?.cancel();
          delete window[stateKey];
          return { status: response.status || 401 };
        }
        state.reader = response.body.getReader();
        return { status: response.status, contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
      } catch (error) {
        delete window[stateKey];
        return { failed: true, timeout: error.name === 'TimeoutError' || error.name === 'AbortError' };
      }
    })();
    return state.start;
  }, attachmentId, key);
  if (start?.timeout) throw new TimeoutError('OWA attachment request', 120);
  if (!start || start.failed) throw new CommandExecutionError('Could not open the OWA attachment download');
  if (start.status !== 200) return new Response(null, { status: start.status });
  const cleanup = async () => {
    await page.evaluate(async stateKey => {
      const state = window[stateKey];
      delete window[stateKey];
      if (state?.reader) await state.reader.cancel().catch(() => {});
    }, key);
  };
  let sequence = 0;
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await page.evaluate(async (stateKey, requestedSequence) => {
          const state = window[stateKey];
          if (!state) return { missing: true };
          // Bridge retries must return the same in-flight or completed chunk.
          if (state.sequence === requestedSequence) return state.chunk;
          if (requestedSequence !== state.sequence + 1) return { missing: true };
          state.sequence = requestedSequence;
          state.chunk = (async () => {
            if (!state.pending.length) {
              const result = await state.reader.read();
              if (result.done) return { done: true };
              state.pending = result.value;
            }
            const bytes = state.pending.subarray(0, 196608);
            state.pending = state.pending.subarray(bytes.length);
            let binary = '';
            for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
            return { base64: btoa(binary) };
          })();
          return state.chunk;
        }, key, sequence++);
        if (chunk?.done) {
          await cleanup();
          controller.close();
        } else if (typeof chunk?.base64 === 'string') controller.enqueue(Buffer.from(chunk.base64, 'base64'));
        else throw new CommandExecutionError('OWA attachment transfer was interrupted; retry download');
      } catch (error) {
        await cleanup().catch(() => {});
        controller.error(error);
      }
    },
    cancel: cleanup,
  }, { highWaterMark: 0 }), { headers: { 'content-type': start.contentType } });
}
