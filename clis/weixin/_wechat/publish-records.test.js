import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
} from '@sovovs/bycli/errors';
import {
  buildDetailUrl,
  collectPublishedRecords,
  matchPublishedRecord,
  parsePublishResponse,
  positiveSafeInteger,
  validatePublishDate,
} from './publish-records.js';

const fixture = () => JSON.parse(fs.readFileSync(
  new URL('./fixtures/published-page.json', import.meta.url),
  'utf8',
));

describe('parsePublishResponse', () => {
  it('maps a published article and its private detail route', () => {
    const result = parsePublishResponse(fixture());

    expect(result.totalCount).toBe(2);
    expect(result.entries[0]).toEqual({
      title: 'Ontology Weekly',
      publishedAt: '2026-08-07',
      url: 'https://mp.weixin.qq.com/s/ontology-weekly',
      notified: 120,
      failed: 2,
      reads: 88,
      likes: 7,
      shares: 9,
      recommends: 4,
      comments: 3,
      underlines: 5,
      reprints: 1,
      msgid: '1001',
      itemIdx: '1',
      publishDate: '2026-08-07',
    });
    expect(buildDetailUrl(result.entries[0], 'token')).toContain('msgid=1001_1');
  });

  it('preserves missing article metrics as null', () => {
    expect(parsePublishResponse(fixture()).entries[1]).toMatchObject({
      msgid: '1002',
      notified: 90,
      failed: 0,
      reads: null,
      likes: null,
      shares: null,
      recommends: null,
      comments: null,
      underlines: null,
      reprints: null,
    });
  });

  it('maps only the exact normalized expired-credential response to AuthRequiredError', () => {
    expect(() => parsePublishResponse({
      base_resp: { ret: 200013, err_msg: '  INVALID CREDENTIAL  ' },
    })).toThrow(AuthRequiredError);
    expect(() => parsePublishResponse({
      base_resp: { ret: 200013, err_msg: 'unrelated failure' },
    })).toThrow(CommandExecutionError);
  });

  it.each([
    { ret: 200013, err_msg: 'INVALID   CREDENTIAL' },
    { ret: 200013, err_msg: 'unrelated failure', err_msg_en: 'invalid credential' },
    { ret: 200013, err_msg_en: 'invalid credential' },
  ])('does not broaden credential matching beyond err_msg', base_resp => {
    expect(() => parsePublishResponse({ base_resp })).toThrow(CommandExecutionError);
  });

  it('maps other non-zero response codes to CommandExecutionError', () => {
    expect(() => parsePublishResponse({
      base_resp: { ret: 99, err_msg: 'invalid credential' },
    })).toThrow(CommandExecutionError);
  });

  it('rejects damaged publish_page JSON with CommandExecutionError', () => {
    expect(() => parsePublishResponse({
      base_resp: { ret: 0 },
      publish_page: '{damaged',
    })).toThrow(CommandExecutionError);
  });

  it('maps an out-of-range finite publish timestamp to CommandExecutionError', () => {
    const publish_info = JSON.stringify({
      msgid: 1,
      sent_info: { time: 1e100 },
      sent_status: { succ: 1, fail: 0 },
      appmsg_info: [{
        itemidx: 1,
        title: 'Invalid date',
        content_url: 'https://mp.weixin.qq.com/s/invalid-date',
      }],
    });
    const publish_page = JSON.stringify({
      total_count: 1,
      publish_list: [{ publish_info }],
    });

    expect(() => parsePublishResponse({
      base_resp: { ret: 0 },
      publish_page,
    })).toThrow(CommandExecutionError);
  });

  it('accepts one nested publish_info layer and falls back to the parsed entry count', () => {
    const nestedInfo = {
      publish_info: JSON.stringify({
        msgid: 7,
        sent_info: { time: 1786032000 },
        sent_status: { succ: 1, fail: 0 },
        appmsg_info: [{
          itemidx: 2,
          title: 'Nested record',
          content_url: 'https://mp.weixin.qq.com/s/nested',
        }],
      }),
    };
    const result = parsePublishResponse({
      base_resp: { ret: 0 },
      publish_page: JSON.stringify({
        total_count: 1.5,
        publish_list: [{ publish_info: JSON.stringify(nestedInfo) }],
      }),
    });

    expect(result.totalCount).toBe(1);
    expect(result.entries[0]).toMatchObject({
      title: 'Nested record',
      msgid: '7',
      itemIdx: '2',
    });
  });

  it('skips deleted and incomplete articles but rejects an incomplete detail route', () => {
    const response = info => ({
      base_resp: { ret: 0 },
      publish_page: JSON.stringify({
        publish_list: [{ publish_info: JSON.stringify(info) }],
      }),
    });
    const base = {
      msgid: 7,
      sent_info: { time: 1786032000 },
      sent_status: { succ: 1, fail: 0 },
    };
    const parsed = parsePublishResponse(response({
      ...base,
      appmsg_info: [
        { itemidx: 1, title: 'Deleted', content_url: 'https://mp.weixin.qq.com/s/deleted', is_deleted: 1 },
        { itemidx: 2, title: '', content_url: 'https://mp.weixin.qq.com/s/no-title' },
        { itemidx: 3, title: 'No URL', content_url: '' },
      ],
    }));
    expect(parsed.entries).toEqual([]);

    expect(() => parsePublishResponse(response({
      ...base,
      msgid: undefined,
      appmsg_info: [{ itemidx: 1, title: 'Missing route', content_url: 'https://mp.weixin.qq.com/s/missing' }],
    }))).toThrow(CommandExecutionError);

    expect(() => parsePublishResponse(response({
      ...base,
      msgid: '',
      appmsg_info: [{ itemidx: 1, title: 'Empty route', content_url: 'https://mp.weixin.qq.com/s/empty' }],
    }))).toThrow(CommandExecutionError);

    expect(() => parsePublishResponse(response({
      ...base,
      appmsg_info: [{ itemidx: '', title: 'Empty item route', content_url: 'https://mp.weixin.qq.com/s/empty-item' }],
    }))).toThrow(CommandExecutionError);
  });
});

function publishResponse({ msgid, itemIdx = 1, title, url, time = 1786032000, totalCount = 1 }) {
  return {
    base_resp: { ret: 0 },
    publish_page: JSON.stringify({
      total_count: totalCount,
      publish_list: [{
        publish_info: JSON.stringify({
          msgid,
          sent_info: { time },
          sent_status: { succ: 1, fail: 0 },
          appmsg_info: [{ itemidx: itemIdx, title, content_url: url }],
        }),
      }],
    }),
  };
}

function record(overrides = {}) {
  return {
    title: 'Ontology Weekly',
    publishedAt: '2026-08-07',
    publishDate: '2026-08-07',
    url: 'https://mp.weixin.qq.com/s/ontology-weekly?__biz=abc&mid=1&idx=1&sn=xyz',
    msgid: '1001',
    itemIdx: '1',
    ...overrides,
  };
}

describe('positiveSafeInteger', () => {
  it('uses the fallback and accepts a positive safe integer', () => {
    expect(positiveSafeInteger(undefined, 'limit', 10)).toBe(10);
    expect(positiveSafeInteger(2, 'limit', 10)).toBe(2);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2'])('rejects invalid values', value => {
    expect(() => positiveSafeInteger(value, 'limit', 10))
      .toThrow(new ArgumentError('limit must be a positive safe integer'));
  });
});

describe('collectPublishedRecords', () => {
  it('fetches the authenticated JSON endpoint directly and paginates without browser capture', async () => {
    const page = {
      fetchJson: vi.fn()
        .mockResolvedValueOnce(publishResponse({
          msgid: 1, title: 'First', url: 'https://mp.weixin.qq.com/s/first', totalCount: 11,
        }))
        .mockResolvedValueOnce(publishResponse({
          msgid: 2, title: 'Second', url: 'https://mp.weixin.qq.com/s/second', totalCount: 11,
        })),
      wait: vi.fn(async () => undefined),
    };

    const result = await collectPublishedRecords(page, {
      token: 'token +/=', limit: 11, maxPages: 3, timeout: 4,
    });

    expect(page.fetchJson).toHaveBeenCalledTimes(2);
    const [firstUrl, firstOptions] = page.fetchJson.mock.calls[0];
    const [secondUrl, secondOptions] = page.fetchJson.mock.calls[1];
    expect(firstUrl).toBe(
      'https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&f=json&begin=0&count=10&token=token+%2B%2F%3D&lang=zh_CN',
    );
    expect(secondUrl).toBe(
      'https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&f=json&begin=10&count=10&token=token+%2B%2F%3D&lang=zh_CN',
    );
    expect(firstOptions).toEqual({ timeoutMs: 4000 });
    expect(secondOptions).toEqual({ timeoutMs: 4000 });
    expect(result.map(item => item.title)).toEqual(['First', 'Second']);
  });

  it('encodes an adversarial token without changing the trusted endpoint or adding parameters', async () => {
    const startNetworkCapture = vi.fn();
    const goto = vi.fn();
    const page = {
      startNetworkCapture,
      goto,
      fetchJson: vi.fn(async () => publishResponse({
        msgid: 1, title: 'Trusted', url: 'https://mp.weixin.qq.com/s/trusted',
      })),
    };

    await collectPublishedRecords(page, {
      token: 'secret&sub=evil&f=html&begin=999#fragment', limit: 1,
    });
    const replayUrl = new URL(page.fetchJson.mock.calls[0][0]);
    expect(replayUrl.origin).toBe('https://mp.weixin.qq.com');
    expect(replayUrl.pathname).toBe('/cgi-bin/appmsgpublish');
    expect(replayUrl.searchParams.get('f')).toBe('json');
    expect(replayUrl.searchParams.get('sub')).toBe('list');
    expect(replayUrl.searchParams.get('token')).toBe('secret&sub=evil&f=html&begin=999#fragment');
    expect(replayUrl.searchParams.get('begin')).toBe('0');
    expect(replayUrl.searchParams.get('count')).toBe('10');
    expect(replayUrl.searchParams.get('lang')).toBe('zh_CN');
    expect([...replayUrl.searchParams.keys()].sort()).toEqual(
      ['begin', 'count', 'f', 'lang', 'sub', 'token'].sort(),
    );
    expect(startNetworkCapture).not.toHaveBeenCalled();
    expect(goto).not.toHaveBeenCalled();
  });

  it('deduplicates article routes and stops after the requested limit', async () => {
    const page = {
      fetchJson: vi.fn()
        .mockResolvedValueOnce(publishResponse({
          msgid: 1, title: 'First', url: 'https://mp.weixin.qq.com/s/first', totalCount: 30,
        }))
        .mockResolvedValueOnce(publishResponse({
          msgid: 1, title: 'Duplicate', url: 'https://mp.weixin.qq.com/s/duplicate', totalCount: 30,
        }))
        .mockResolvedValueOnce(publishResponse({
          msgid: 2, title: 'Second', url: 'https://mp.weixin.qq.com/s/second', totalCount: 30,
        })),
    };

    const result = await collectPublishedRecords(page, { token: 'token', limit: 2, maxPages: 5 });
    expect(page.fetchJson).toHaveBeenCalledTimes(3);
    expect(result.map(item => item.msgid)).toEqual(['1', '2']);
  });

  it('continues after a page whose only articles are filtered out', async () => {
    const deletedPage = {
      base_resp: { ret: 0 },
      publish_page: JSON.stringify({
        total_count: 20,
        publish_list: [{
          publish_info: JSON.stringify({
            msgid: 1,
            sent_info: { time: 1786032000 },
            sent_status: { succ: 1, fail: 0 },
            appmsg_info: [{
              itemidx: 1,
              title: 'Deleted',
              content_url: 'https://mp.weixin.qq.com/s/deleted',
              is_deleted: 1,
            }],
          }),
        }],
      }),
    };
    const page = {
      fetchJson: vi.fn()
        .mockResolvedValueOnce(deletedPage)
        .mockResolvedValueOnce(publishResponse({
          msgid: 2, title: 'Second page', url: 'https://mp.weixin.qq.com/s/second-page', totalCount: 20,
        })),
    };

    const result = await collectPublishedRecords(page, { token: 'token', limit: 1, maxPages: 2 });

    expect(page.fetchJson).toHaveBeenCalledTimes(2);
    expect(new URL(page.fetchJson.mock.calls[1][0]).searchParams.get('begin')).toBe('10');
    expect(result.map(item => item.title)).toEqual(['Second page']);
  });

  it('rejects a page without authenticated JSON fetch support', async () => {
    await expect(collectPublishedRecords({}, { token: 'token' })).rejects.toBeInstanceOf(CommandExecutionError);
  });

  it('throws EmptyResultError when Weixin returns no records', async () => {
    const page = {
      fetchJson: vi.fn(async () => ({
        base_resp: { ret: 0 },
        publish_page: JSON.stringify({ total_count: 0, publish_list: [] }),
      })),
    };

    await expect(collectPublishedRecords(page, { token: 'token' })).rejects.toMatchObject({
      code: 'EMPTY_RESULT',
      hint: 'No published records were returned by Weixin.',
    });
  });
});

describe('matchPublishedRecord', () => {
  const records = [
    record(),
    record({
      title: 'Ontology Weekly Special',
      url: 'https://mp.weixin.qq.com/s/special',
      msgid: '1002',
      publishedAt: '2026-08-08',
      publishDate: '2026-08-08',
    }),
    record({
      title: 'Other News', url: 'https://mp.weixin.qq.com/s/other', msgid: '1003',
    }),
  ];

  it('matches a trusted article URL while ignoring tracking parameters', () => {
    expect(matchPublishedRecord(
      records,
      `${records[0].url}&scene=42#from-share`,
    )).toBe(records[0]);
  });

  it('prefers an exact normalized title over substring matches', () => {
    expect(matchPublishedRecord(records, '  Ontology   Weekly ')).toBe(records[0]);
  });

  it('returns a unique title substring', () => {
    expect(matchPublishedRecord(records, 'Special')).toBe(records[1]);
  });

  it('filters by an exact publish date before matching', () => {
    expect(matchPublishedRecord(records, 'Ontology', '2026-08-08')).toBe(records[1]);
  });

  it('does not treat an untrusted URL-like query as a title', () => {
    const untrusted = 'http://mp.weixin.qq.com/s/not-trusted';
    expect(() => matchPublishedRecord([
      record({ title: untrusted }),
    ], untrusted)).toThrow(EmptyResultError);
  });

  it('filters dates using publishedAt only', () => {
    expect(() => matchPublishedRecord([
      record({ publishedAt: undefined, publishDate: '2026-08-07' }),
    ], 'Ontology Weekly', '2026-08-07')).toThrow(EmptyResultError);
  });

  it('throws typed errors for no match and ambiguity', () => {
    expect(() => matchPublishedRecord(records, 'Missing')).toThrow(EmptyResultError);
    expect(() => matchPublishedRecord(records, 'Ontology')).toThrow(ArgumentError);
    try {
      matchPublishedRecord(records, 'Ontology');
    } catch (error) {
      expect(error.message).toContain('2026-08-07 Ontology Weekly');
      expect(error.message).toContain('complete URL or --date');
    }
  });

  it.each([
    ['', undefined, 'query'],
    ['Ontology', '2026-8-8', 'date'],
    ['Ontology', '2026-13-01', 'date'],
    ['Ontology', '2026-02-30', 'date'],
  ])('rejects invalid matching input', (query, date, expected) => {
    expect(() => matchPublishedRecord(records, query, date)).toThrow(ArgumentError);
    try {
      matchPublishedRecord(records, query, date);
    } catch (error) {
      expect(error.message).toContain(expected);
    }
  });

  it('accepts a real leap day', () => {
    const leapDayRecord = record({
      publishedAt: '2028-02-29',
      publishDate: '2028-02-29',
    });
    expect(matchPublishedRecord([leapDayRecord], 'Ontology Weekly', '2028-02-29'))
      .toBe(leapDayRecord);
  });
});

describe('validatePublishDate', () => {
  it('preserves an omitted date and returns a valid calendar date as a string', () => {
    expect(validatePublishDate(undefined)).toBeUndefined();
    expect(validatePublishDate('2028-02-29')).toBe('2028-02-29');
  });

  it.each(['2026-8-8', '2026-02-30'])('rejects invalid publish date %s', date => {
    expect(() => validatePublishDate(date)).toThrow(ArgumentError);
    expect(() => validatePublishDate(date)).toThrow('date must use YYYY-MM-DD');
  });
});

describe('buildDetailUrl', () => {
  it('builds the exact private analytics detail route', () => {
    expect(buildDetailUrl(record({ msgid: '10', itemIdx: '2' }), 'token +/=')).toBe(
      'https://mp.weixin.qq.com/misc/appmsganalysis?action=detailpage&msgid=10_2&publish_date=2026-08-07&type=int&pageVersion=1&token=token+%2B%2F%3D&lang=zh_CN',
    );
  });
});
