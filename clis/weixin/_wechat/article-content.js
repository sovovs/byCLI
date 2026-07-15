/**
 * Extract the mutable WeChat article body. This function is deliberately
 * self-contained so download.js can serialize the exact same implementation
 * into page.evaluate().
 */
export function extractWechatArticleContent(document) {
  const result = { contentHtml: '', codeBlocks: [], imageUrls: [] };
  const contentEl = document.querySelector('#js_content');
  if (!contentEl) return result;

  contentEl.querySelectorAll('img').forEach(img => {
    const dataSrc = img.getAttribute('data-src');
    if (dataSrc) img.setAttribute('src', dataSrc);
  });
  contentEl.querySelectorAll('.code-snippet__line-index').forEach(node => node.remove());
  ['script', 'style', '.qr_code_pc', '.reward_area'].forEach(selector => {
    contentEl.querySelectorAll(selector).forEach(node => node.remove());
  });
  const seen = new Set();
  contentEl.querySelectorAll('img[src]').forEach(img => {
    const src = img.getAttribute('src');
    if (src && !seen.has(src)) {
      seen.add(src);
      result.imageUrls.push(src);
    }
  });
  result.contentHtml = contentEl.innerHTML;
  return result;
}

export function buildExtractWechatArticleContentJs() {
  return `(${extractWechatArticleContent.toString()})`;
}

/** Node-side HTML counterpart used by history saving; owns all body cleanup. */
export function extractWechatArticleContentFromHtml(htmlInput) {
  return { ...extractWechatArticleHtml(String(htmlInput || '')), codeBlocks: [] };
}
import { extractWechatArticleHtml } from '@sovovs/bycli/download/article-download';
