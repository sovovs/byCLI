import { describe, expect, it } from 'vitest';
import { CommandExecutionError } from '@sovovs/bycli/errors';
import {
  articleMetricsSections,
  collectArticleMetrics,
  normalizeArticleMetrics,
} from './article-metrics.js';

// Captured from a live mp.weixin.qq.com article analysis page (2026-08-17 article).
const LIVE_PAYLOAD = {
  readUsers: 94,
  avgReadSeconds: 28,
  finishedReadRatio: 0.478723406792,
  newFollowers: 0,
  listenUsers: 0,
  listenPlays: 0,
  shares: 2,
  zaikan: 0,
  likes: 0,
  rewardFen: 0,
  rewardYuanFallback: null,
  comments: 0,
  collections: 1,
};

describe('article metrics normalization', () => {
  it('keeps the reading and interaction counters observed on a live article', () => {
    expect(normalizeArticleMetrics(LIVE_PAYLOAD)).toEqual({
      readUsers: 94,
      avgReadSeconds: 28,
      avgReadMinutes: 0.47,
      finishedReadRatio: 0.478723,
      newFollowers: 0,
      listenUsers: 0,
      listenPlays: 0,
      shares: 2,
      zaikan: 0,
      likes: 0,
      rewardYuan: 0,
      comments: 0,
      collections: 1,
    });
  });

  it('converts the reward amount from fen to yuan', () => {
    expect(normalizeArticleMetrics({ ...LIVE_PAYLOAD, rewardFen: 1234 }).rewardYuan).toBe(12.34);
  });

  it('falls back to the rendered reward amount when the payload omits it', () => {
    expect(normalizeArticleMetrics({
      ...LIVE_PAYLOAD, rewardFen: null, rewardYuanFallback: 8,
    }).rewardYuan).toBe(8);
  });

  it('reports missing counters as null instead of zero', () => {
    expect(normalizeArticleMetrics({ readUsers: 5, collections: null }))
      .toMatchObject({ readUsers: 5, likes: null, comments: null, avgReadMinutes: null });
  });

  it('rejects a payload that exposes no counters at all', () => {
    expect(() => normalizeArticleMetrics({ readUsers: null, likes: null }))
      .toThrow(CommandExecutionError);
    expect(() => normalizeArticleMetrics(null)).toThrow(CommandExecutionError);
  });

  it('groups the counters into the two Markdown report sections', () => {
    expect(articleMetricsSections(normalizeArticleMetrics(LIVE_PAYLOAD))).toEqual({
      阅读: {
        阅读人数: 94, 平均阅读时长分钟: 0.47, 完读率: '47.87%', 新增关注: 0, 听全文人数: 0,
      },
      互动: {
        分享人数: 2, 在看人数: 0, 点赞人数: 0, 赞赏金额元: 0, 留言条数: 0, 收藏人数: 1,
      },
    });
  });

  it('reads counters through page.evaluate and tolerates a changed layout', async () => {
    await expect(collectArticleMetrics({ evaluate: async () => LIVE_PAYLOAD }))
      .resolves.toMatchObject({ readUsers: 94, collections: 1 });
    await expect(collectArticleMetrics({ evaluate: async () => ({}) })).resolves.toBeNull();
    await expect(collectArticleMetrics({})).resolves.toBeNull();
  });
});
