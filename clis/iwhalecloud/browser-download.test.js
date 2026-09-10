import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { browserDownloadResponse } from './browser-download.js';

function binaryPage(response) {
  const window = {};
  const context = vm.createContext({ window, location: { origin: 'https://mail.iwhalecloud.com' },
    document: { cookie: 'X-OWA-CANARY=test' }, AbortSignal, Uint8Array, btoa,
    fetch: async () => response });
  return { window, evaluate: async (fn, ...args) => {
    context.args = args;
    return vm.runInContext(`(${fn.toString()})(...args)`, context);
  } };
}
describe('browser attachment transfer', () => {
  it('round-trips binary data larger than one bridge chunk and releases browser state', async () => {
    const bytes = Uint8Array.from({ length: 900000 }, (_, i) => i % 256);
    const page = binaryPage(new Response(bytes, { headers: { 'content-type': 'application/pdf' } }));
    const response = await browserDownloadResponse(page, 'att+/=');
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    expect(Object.keys(page.window)).toEqual([]);
  });
  it('preserves every byte when bridge calls are replayed, including initialization and EOF', async () => {
    const bytes = Uint8Array.from({ length: 400000 }, (_, i) => i % 251);
    const page = binaryPage(new Response(bytes));
    const evaluate = page.evaluate;
    page.evaluate = async (fn, ...args) => {
      // Concurrent timeout retry, followed by a lost-response retry.
      await Promise.all([evaluate(fn, ...args), evaluate(fn, ...args)]);
      return evaluate(fn, ...args);
    };
    const response = await browserDownloadResponse(page, 'att');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(bytes));
    expect(Object.keys(page.window)).toEqual([]);
  });
  it('releases the browser reader when a download is cancelled', async () => {
    const page = binaryPage(new Response('binary'));
    const response = await browserDownloadResponse(page, 'att');
    await response.body.cancel();
    expect(Object.keys(page.window)).toEqual([]);
  });
  it('does not create transfer state on expired login', async () => {
    const page = binaryPage(new Response('', { status: 440 }));
    expect((await browserDownloadResponse(page, 'att')).status).toBe(440);
    expect(Object.keys(page.window)).toEqual([]);
  });
});
