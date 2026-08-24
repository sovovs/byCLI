import { describe, expect, it } from 'vitest';

import { ImaReaderAuthStore } from './ima-reader';

describe('ImaReaderAuthStore', () => {
  it('accepts an ima reader request and returns only an opaque ID', () => {
    const store = new ImaReaderAuthStore();

    expect(store.capture(7, {
      url: 'https://ima.qq.com/cgi-bin/knowledge_tab_reader/get_knowledge_list',
      headers: { 'x-ima-cookie': 'IMA-TOKEN=secret', 'x-ima-bkn': '123' },
    })).toBe(true);

    const result = store.read(7);
    expect(result).toMatchObject({ authId: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('rejects a non-reader URL or missing required headers', () => {
    const store = new ImaReaderAuthStore();

    expect(store.capture(7, {
      url: 'https://example.com/cgi-bin/knowledge_tab_reader/get_knowledge_list',
      headers: { 'x-ima-cookie': 'IMA-TOKEN=secret', 'x-ima-bkn': '123' },
    })).toBe(false);
    expect(store.capture(7, {
      url: 'https://ima.qq.com/cgi-bin/knowledge_tab_reader/get_knowledge_list',
      headers: { 'x-ima-bkn': '123' },
    })).toBe(false);
  });

  it('derives x-ima-bkn from an authenticated reader cookie when the page omits it', async () => {
    const store = new ImaReaderAuthStore();
    expect(store.capture(7, {
      url: 'https://ima.qq.com/cgi-bin/knowledge_tab_reader/get_home_page_data',
      headers: { 'x-ima-cookie': 'IMA-TOKEN=secret; IMA-UID=user-1' },
    })).toBe(true);
    const auth = store.read(7);
    const result = await store.request(7, auth!.authId, '/get_knowledge_list', {}, async (headers) => headers);
    expect(result['x-ima-bkn']).toMatch(/^\d+$/);
    expect(result['x-ima-bkn']).not.toContain('secret');
  });

  it('accepts the allow-listed activity request as an ima auth source', () => {
    const store = new ImaReaderAuthStore();
    expect(store.capture(7, {
      url: 'https://ima.qq.com/cgi-bin/activity_tab/get_available_activities',
      headers: { 'x-ima-cookie': 'IMA-TOKEN=secret' },
    })).toBe(true);
  });

  it('keeps the opaque ID stable when a reader request refreshes captured headers', async () => {
    const store = new ImaReaderAuthStore();
    store.capture(7, {
      url: 'https://ima.qq.com/cgi-bin/activity_tab/get_available_activities',
      headers: { 'x-ima-cookie': 'IMA-TOKEN=first' },
    });
    const original = store.read(7)!;
    store.capture(7, {
      url: 'https://ima.qq.com/cgi-bin/knowledge_tab_reader/get_knowledge_list',
      headers: { 'x-ima-cookie': 'IMA-TOKEN=refreshed' },
    });

    expect(store.read(7)).toEqual(original);
    await expect(store.request(7, original.authId, '/get_knowledge_list', {}, async () => ({ ok: true })))
      .resolves.toEqual({ ok: true });
  });

  it('uses stored headers only through an allow-listed reader request', async () => {
    const store = new ImaReaderAuthStore();
    store.capture(7, {
      url: 'https://ima.qq.com/cgi-bin/knowledge_tab_reader/get_knowledge_list',
      headers: { 'x-ima-cookie': 'IMA-TOKEN=secret', 'x-ima-bkn': '123' },
    });
    const auth = store.read(7);
    const request = async (headers: Record<string, string>) => ({ headers, code: 0 });

    await expect(store.request(7, auth!.authId, '/get_knowledge_list', { cursor: '' }, request))
      .resolves.toMatchObject({ code: 0 });
    await expect(store.request(7, auth!.authId, '/not-allowed', {}, request))
      .rejects.toThrow('not allowed');
  });
});
