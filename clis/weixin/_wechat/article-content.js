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
  contentEl.querySelectorAll('.code-snippet__fix').forEach(el => {
    el.querySelectorAll('.code-snippet__line-index').forEach(node => node.remove());
    const pre = el.querySelector('pre[data-lang]');
    const lang = pre?.getAttribute('data-lang') || '';
    const lines = [];
    el.querySelectorAll('code').forEach(code => {
      const text = code.textContent || '';
      if (!/^[ce]?ounter\(line/.test(text)) lines.push(text);
    });
    if (lines.length === 0) lines.push(el.textContent || '');
    const placeholder = `CODEBLOCK-PLACEHOLDER-${result.codeBlocks.length}`;
    result.codeBlocks.push({ lang, code: lines.join('\n') });
    const replacement = document.createElement('p');
    replacement.textContent = placeholder;
    el.replaceWith(replacement);
  });
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

function elementRange(html, openIndex) {
  const open = /^<([a-z][\w:-]*)\b[^>]*>/i.exec(html.slice(openIndex));
  if (!open) return null;
  const tag = open[1];
  const tokens = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
  tokens.lastIndex = openIndex + open[0].length;
  let depth = 1;
  for (let token; (token = tokens.exec(html));) {
    if (/^<\//.test(token[0])) depth -= 1;
    else if (!/\/\s*>$/.test(token[0])) depth += 1;
    if (depth === 0) return { innerStart: openIndex + open[0].length, innerEnd: token.index, end: tokens.lastIndex };
  }
  return null;
}

function removeElements(html, openPattern) {
  let value = html;
  while (true) {
    openPattern.lastIndex = 0;
    const match = openPattern.exec(value);
    if (!match) return value;
    const range = elementRange(value, match.index);
    if (!range) return value.slice(0, match.index);
    value = value.slice(0, match.index) + value.slice(range.end);
  }
}

export function decodeWechatEntities(value) {
  return value
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_m, raw) => String.fromCodePoint(raw[0].toLowerCase() === 'x' ? Number.parseInt(raw.slice(1), 16) : Number.parseInt(raw, 10)))
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'").replace(/&amp;/gi, '&');
}

/** Node-side HTML counterpart used by history saving; owns all body cleanup. */
export function extractWechatArticleContentFromHtml(htmlInput) {
  const source = String(htmlInput || '');
  const match = /<([a-z][\w:-]*)\b[^>]*\bid\s*=\s*(["'])js_content\2[^>]*>/i.exec(source);
  if (!match) throw new Error('WeChat article has no #js_content');
  const root = elementRange(source, match.index);
  if (!root) throw new Error('WeChat #js_content is not closed');
  let html = source.slice(root.innerStart, root.innerEnd);
  html = removeElements(html, /<(?:script|style)\b[^>]*>/gi);
  html = removeElements(html, /<[a-z][\w:-]*\b[^>]*class\s*=\s*(["'])[^"']*\b(?:qr_code_pc|reward_area)\b[^"']*\1[^>]*>/gi);
  html = html.replace(/<img\b([^>]*)>/gi, (tag, attributes) => {
    const lazy = /\bdata-src\s*=\s*(["'])(.*?)\1/i.exec(attributes);
    if (!lazy) return tag;
    const cleaned = attributes.replace(/\s+data-src\s*=\s*(["']).*?\1/ig, '').replace(/\s+src\s*=\s*(["']).*?\1/ig, '');
    return `<img${cleaned} src="${lazy[2]}">`;
  });
  const codeBlocks = [];
  while (true) {
    const codeOpen = /<[a-z][\w:-]*\b[^>]*class\s*=\s*(["'])[^"']*\bcode-snippet__fix\b[^"']*\1[^>]*>/i.exec(html);
    if (!codeOpen) break;
    const range = elementRange(html, codeOpen.index);
    if (!range) break;
    const block = html.slice(range.innerStart, range.innerEnd);
    const lang = /<pre\b[^>]*data-lang\s*=\s*(["'])(.*?)\1/i.exec(block)?.[2] || '';
    const lines = [...block.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi)]
      .map(item => decodeWechatEntities(item[1].replace(/<[^>]+>/g, '')))
      .filter(line => !/^[ce]?ounter\(line/.test(line));
    codeBlocks.push({ lang, code: lines.join('\n') });
    html = html.slice(0, codeOpen.index) + `<p>CODEBLOCK-PLACEHOLDER-${codeBlocks.length - 1}</p>` + html.slice(range.end);
  }
  const imageUrls = [...html.matchAll(/<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi)].map(item => item[2]);
  return { contentHtml: html, codeBlocks, imageUrls: [...new Set(imageUrls)] };
}
