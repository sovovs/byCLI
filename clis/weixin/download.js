/**
 * WeChat article download — export WeChat Official Account articles to Markdown.
 *
 * Ported from jackwener/wechat-article-to-markdown (JS version) to byCLI adapter.
 *
 * Usage:
 *   bycli weixin download --url "https://mp.weixin.qq.com/s/xxx" --output ./weixin
 */
import { cli, Strategy } from '@sovovs/bycli/registry';
import { downloadArticle } from '@sovovs/bycli/download/article-download';
import { AuthRequiredError } from '@sovovs/bycli/errors';
import { assertCurrentAdapterLease, withAdapterResourceLocks } from '@sovovs/bycli/adapter-coordination';
import { resolve } from 'node:path';
import { buildExtractWechatArticleContentJs } from './_wechat/article-content.js';
import {
    isTrustedSogouRedirectUrl,
    isTrustedWechatArticleUrl,
    normalizeWechatUrl,
    resolveWechatArticleUrl,
} from './_wechat/article-link.js';
import { canonicalWechatArticleIdentity, hashResourceValue } from './_wechat/article-identity.js';
import { validateDownloadedArticleRows } from './_wechat/article-artifact.js';
export { extractWechatArticleContent } from './_wechat/article-content.js';
export {
    isTrustedSogouRedirectUrl,
    isTrustedWechatArticleUrl,
    normalizeWechatUrl,
    resolveWechatArticleUrl as resolveWechatDownloadUrl,
};
/**
 * Format a WeChat article timestamp as a UTC+8 datetime string.
 * Accepts either Unix seconds or milliseconds.
 */
export function formatWechatTimestamp(rawTimestamp) {
    const ts = Number.parseInt(rawTimestamp, 10);
    if (!Number.isFinite(ts) || ts <= 0)
        return '';
    const timestampMs = rawTimestamp.length === 13 ? ts : ts * 1000;
    const d = new Date(timestampMs);
    const pad = (n) => String(n).padStart(2, '0');
    const utc8 = new Date(d.getTime() + 8 * 3600 * 1000);
    return (`${utc8.getUTCFullYear()}-` +
        `${pad(utc8.getUTCMonth() + 1)}-` +
        `${pad(utc8.getUTCDate())} ` +
        `${pad(utc8.getUTCHours())}:` +
        `${pad(utc8.getUTCMinutes())}:` +
        `${pad(utc8.getUTCSeconds())}`);
}
/**
 * Extract the raw create_time value from supported WeChat inline script formats.
 */
export function extractWechatCreateTimeValue(htmlStr) {
    const jsDecodeMatch = htmlStr.match(/create_time\s*:\s*JsDecode\('([^']+)'\)(?=[\s,;}]|$)/);
    if (jsDecodeMatch)
        return jsDecodeMatch[1];
    const directValueMatch = htmlStr.match(/create_time\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|([0-9A-Za-z]+))(?=[\s,;}]|$)/);
    if (!directValueMatch)
        return '';
    return directValueMatch[1] || directValueMatch[2] || directValueMatch[3] || '';
}
/**
 * Extract the publish time from DOM text first, then fall back to numeric create_time values.
 */
export function extractWechatPublishTime(publishTimeText, htmlStr) {
    const normalizedPublishTime = (publishTimeText || '').trim();
    if (normalizedPublishTime)
        return normalizedPublishTime;
    const rawCreateTime = extractWechatCreateTimeValue(htmlStr);
    if (!/^\d{10}$|^\d{13}$/.test(rawCreateTime))
        return '';
    return formatWechatTimestamp(rawCreateTime);
}
/**
 * Detect WeChat anti-bot / verification gate pages before we try to parse the article.
 */
export function detectWechatAccessIssue(pageText, htmlStr) {
    const normalizedText = (pageText || '').replace(/\s+/g, ' ').trim();
    if (/环境异常/.test(normalizedText) &&
        /(完成验证后即可继续访问|去验证)/.test(normalizedText)) {
        return 'environment verification required';
    }
    if (/secitptpage\/verify\.html/.test(htmlStr) || /id=["']js_verify["']/.test(htmlStr)) {
        return 'environment verification required';
    }
    return '';
}
export function pickFirstWechatMetaText(...candidates) {
    for (const candidate of candidates) {
        const normalized = (candidate || '').replace(/\s+/g, ' ').trim();
        if (normalized && normalized !== 'Name cleared')
            return normalized;
    }
    return '';
}
/**
 * Build a self-contained helper for execution inside page.evaluate().
 */
export function buildExtractWechatPublishTimeJs() {
    return `(${function extractWechatPublishTimeInPage(publishTimeText, htmlStr) {
        function formatWechatTimestamp(rawTimestamp) {
            const ts = Number.parseInt(rawTimestamp, 10);
            if (!Number.isFinite(ts) || ts <= 0)
                return '';
            const timestampMs = rawTimestamp.length === 13 ? ts : ts * 1000;
            const d = new Date(timestampMs);
            const pad = (n) => String(n).padStart(2, '0');
            const utc8 = new Date(d.getTime() + 8 * 3600 * 1000);
            return (`${utc8.getUTCFullYear()}-` +
                `${pad(utc8.getUTCMonth() + 1)}-` +
                `${pad(utc8.getUTCDate())} ` +
                `${pad(utc8.getUTCHours())}:` +
                `${pad(utc8.getUTCMinutes())}:` +
                `${pad(utc8.getUTCSeconds())}`);
        }
        function extractWechatCreateTimeValue(html) {
            const jsDecodeMatch = html.match(/create_time\s*:\s*JsDecode\('([^']+)'\)(?=[\s,;}]|$)/);
            if (jsDecodeMatch)
                return jsDecodeMatch[1];
            const directValueMatch = html.match(/create_time\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|([0-9A-Za-z]+))(?=[\s,;}]|$)/);
            if (!directValueMatch)
                return '';
            return directValueMatch[1] || directValueMatch[2] || directValueMatch[3] || '';
        }
        const normalizedPublishTime = (publishTimeText || '').trim();
        if (normalizedPublishTime)
            return normalizedPublishTime;
        const rawCreateTime = extractWechatCreateTimeValue(htmlStr);
        if (!/^\d{10}$|^\d{13}$/.test(rawCreateTime))
            return '';
        return formatWechatTimestamp(rawCreateTime);
    }.toString()})`;
}
/**
 * Build a self-contained access-issue detector for execution inside page.evaluate().
 */
export function buildDetectWechatAccessIssueJs() {
    return `(${function detectWechatAccessIssueInPage(pageText, htmlStr) {
        const normalizedText = (pageText || '').replace(/\s+/g, ' ').trim();
        if (/环境异常/.test(normalizedText) &&
            /(完成验证后即可继续访问|去验证)/.test(normalizedText)) {
            return 'environment verification required';
        }
        if (/secitptpage\/verify\.html/.test(htmlStr) || /id=["']js_verify["']/.test(htmlStr)) {
            return 'environment verification required';
        }
        return '';
    }.toString()})`;
}
// ============================================================
// CLI Registration
// ============================================================
cli({
    site: 'weixin',
    name: 'download',
    access: 'read',
    description: '下载微信公众号文章为 Markdown 格式',
    domain: 'mp.weixin.qq.com',
    strategy: Strategy.COOKIE,
    adapterConcurrency: { isolatedTabs: true, maxParallel: 3 },
    args: [
        { name: 'url', required: true, help: 'WeChat article URL (mp.weixin.qq.com/s/xxx)' },
        { name: 'output', default: './weixin-articles', help: 'Output directory' },
        { name: 'download-images', type: 'boolean', default: true, help: 'Download images locally' },
    ],
    columns: ['title', 'author', 'publish_time', 'status', 'size', 'saved', 'source_url', 'resolved_url'],
    func: async (page, kwargs) => {
        const { sourceUrl, resolvedUrl, alreadyNavigated } = await resolveWechatArticleUrl(page, kwargs.url);
        const outputDir = resolve(kwargs.output ?? './weixin-articles');
        return withAdapterResourceLocks([
            `article:${canonicalWechatArticleIdentity(resolvedUrl)}`,
            `output:${hashResourceValue(outputDir)}`,
        ], async () => {
        // Navigate and wait for content to load. Sogou resolution already lands on the article.
        if (!alreadyNavigated)
            await page.goto(resolvedUrl);
        await page.wait(5);
        // Extract article data in browser context
        const data = await page.evaluate(`
      (() => {
        const result = {
          title: '',
          author: '',
          publishTime: '',
          errorHint: '',
          contentHtml: '',
          codeBlocks: [],
          imageUrls: []
        };

        const pickFirstText = (...selectors) => {
          for (const selector of selectors) {
            const text = document.querySelector(selector)?.textContent?.replace(/\\s+/g, ' ').trim() || '';
            if (text && text !== 'Name cleared') return text;
          }
          return '';
        };

        // WeChat has multiple article templates. Newer pages use #js_text_title.
        result.title = pickFirstText(
          '#activity-name',
          '#js_text_title',
          '.rich_media_title',
        );

        result.author = pickFirstText(
          '#js_name',
          '.wx_follow_nickname',
          '#profileBt .profile_nickname',
          '.rich_media_meta.rich_media_meta_nickname',
          '.rich_media_meta_nickname',
        );

        // Publish time: prefer the rendered DOM text, then fall back to numeric create_time values.
        const publishTimeEl = document.querySelector('#publish_time');
        const extractWechatPublishTime = ${buildExtractWechatPublishTimeJs()};
        result.publishTime = extractWechatPublishTime(
          publishTimeEl ? publishTimeEl.textContent : '',
          document.documentElement.innerHTML,
        );

        const detectWechatAccessIssue = ${buildDetectWechatAccessIssueJs()};
        result.errorHint = detectWechatAccessIssue(
          document.body ? document.body.innerText : '',
          document.documentElement.innerHTML,
        );
        if (result.errorHint) return result;

        const extractWechatArticleContent = ${buildExtractWechatArticleContentJs()};
        Object.assign(result, extractWechatArticleContent(document));
        return result;
      })()
    `);
        if (data?.errorHint === 'environment verification required') {
            throw new AuthRequiredError(
                'mp.weixin.qq.com',
                'WeChat article page requires environment verification. Complete it in the open browser tab and run the command again.',
            );
        }
        const rows = await downloadArticle({
            title: data?.title || '',
            author: data?.author,
            publishTime: data?.publishTime,
            sourceUrl: resolvedUrl,
            contentHtml: data?.contentHtml || '',
            codeBlocks: data?.codeBlocks,
            imageUrls: data?.imageUrls,
        }, {
            output: outputDir,
            downloadImages: kwargs['download-images'],
            imageHeaders: { Referer: 'https://mp.weixin.qq.com/' },
            frontmatterLabels: { author: '公众号' },
            detectImageExt: (url) => {
                const m = url.match(/wx_fmt=(\w+)/) || url.match(/\.(\w{3,4})(?:\?|$)/);
                return m ? m[1] : 'png';
            },
            secureMarkdown: true,
            beforePublish: assertCurrentAdapterLease,
        });
        const validatedRows = await validateDownloadedArticleRows(rows, outputDir);
        return validatedRows.map(row => ({ ...row, source_url: sourceUrl, resolved_url: resolvedUrl }));
        });
    },
});
