import { describe, expect, it } from 'vitest';

import { normalizeArticleUrl, toKnowledgeRow } from './utils.js';

describe('normalizeArticleUrl', () => {
    it('removes volatile WeChat session parameters', () => {
        expect(normalizeArticleUrl(
            'https://mp.weixin.qq.com/s?__biz=a&mid=1&idx=1&sn=b&sessionid=x&pass_ticket=y&exportkey=z&scene=305',
        )).toBe('https://mp.weixin.qq.com/s?__biz=a&mid=1&idx=1&sn=b');
        expect(normalizeArticleUrl('https://mp.weixin.qq.com/s?mid=1&SessionId=x&FontScale=100'))
            .toBe('https://mp.weixin.qq.com/s?mid=1');
    });

    it('keeps public query parameters while removing tracking parameters and fragments', () => {
        expect(normalizeArticleUrl('https://example.com/post?id=7&utm_source=ima#part'))
            .toBe('https://example.com/post?id=7');
    });

    it('returns null for internal ima and extension pages', () => {
        expect(normalizeArticleUrl('chrome://allknowledge/')).toBeNull();
        expect(normalizeArticleUrl('chrome-extension://abc/index.html')).toBeNull();
    });

    it('returns null for malformed values', () => {
        expect(normalizeArticleUrl('not a url')).toBeNull();
    });
});

describe('toKnowledgeRow', () => {
    it('builds deterministic columns and preserves nested folder paths', () => {
        expect(toKnowledgeRow({
            knowledgeBaseId: 'kb1',
            knowledgeBase: 'KB',
            folderPath: ['A', 'B'],
            title: 'T',
            url: null,
            contentType: 'PDF',
            addedDate: '8/20',
        })).toEqual({
            knowledgeBaseId: 'kb1',
            knowledgeBase: 'KB',
            folderPath: ['A', 'B'],
            title: 'T',
            url: null,
            contentType: 'PDF',
            addedDate: '8/20',
        });
    });
});
