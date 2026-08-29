import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { ArgumentError, CommandExecutionError } from '@sovovs/bycli/errors';
import { parseWechatHtmlFragment, serializeWechatHtml } from '@sovovs/bycli/download/article-download';

const DROP_TAGS = new Set(['base', 'embed', 'form', 'iframe', 'link', 'meta', 'object', 'script', 'style', 'template']);
const ALLOWED_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'i', 'img', 'li', 'ol', 'p', 'pre', 'section', 'span', 'strong', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
]);
const IMPORTANT_STYLE_PROPERTIES = new Set([
  'background', 'background-color', 'border', 'border-radius', 'color', 'display',
  'font-size', 'line-height', 'margin', 'margin-bottom', 'padding', 'text-align', 'text-indent',
  'vertical-align',
]);

export function htmlToPlainText(html) {
  return String(html ?? '')
    .replace(/<(?:br)\b[^>]*>/giu, '\n')
    .replace(/<\/(?:p|div|section|h[1-6]|li|tr|blockquote|table)>/giu, '\n')
    .replace(/<[^>]*>/gu, '')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/[\t \f\v]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function attributes(node) {
  return Array.isArray(node.attrs) ? node.attrs : [];
}

function setAttribute(node, name, value) {
  const attr = attributes(node).find(item => item.name === name);
  if (attr) attr.value = value;
  else node.attrs.push({ name, value });
}

function removeAttribute(node, name) {
  node.attrs = attributes(node).filter(attr => attr.name !== name);
}

function normalizeStyle(value) {
  return String(value ?? '')
    .replace(/box-shadow\s*:[^;]+;?/giu, '')
    .replace(/text-shadow\s*:[^;]+;?/giu, '')
    .replace(/background\s*:\s*linear-gradient\([^;]+\);?/giu, '')
    .replace(/background\s*:\s*([#a-z0-9(),.%\s-]+);/giu, 'background-color: $1;')
    .split(';')
    .map(declaration => declaration.trim())
    .filter(Boolean)
    .map(declaration => {
      const separator = declaration.indexOf(':');
      if (separator < 0) return '';
      const property = declaration.slice(0, separator).trim().toLowerCase();
      let valuePart = declaration.slice(separator + 1).trim();
      if (property === 'text-indent') valuePart = '0';
      if (IMPORTANT_STYLE_PROPERTIES.has(property) && !/!important$/iu.test(valuePart)) {
        valuePart += ' !important';
      }
      return `${property}: ${valuePart}`;
    })
    .filter(Boolean)
    .join('; ');
}

function convertBackgroundSection(node) {
  const tag = String(node.tagName ?? node.nodeName ?? '').toLowerCase();
  if (tag !== 'section' && tag !== 'div') return;
  const styleAttr = attributes(node).find(attr => attr.name === 'style');
  const style = String(styleAttr?.value ?? '');
  if (!style || !/background(?:-color)?\s*:/iu.test(style) || /font-family\s*:/iu.test(style)) return;

  const children = node.childNodes ?? [];
  const td = {
    nodeName: 'td', tagName: 'td', namespaceURI: 'http://www.w3.org/1999/xhtml',
    attrs: [{ name: 'style', value: normalizeStyle(style) }], childNodes: children,
  };
  const tr = {
    nodeName: 'tr', tagName: 'tr', namespaceURI: 'http://www.w3.org/1999/xhtml',
    attrs: [], childNodes: [td],
  };
  node.nodeName = 'table';
  node.tagName = 'table';
  node.attrs = [{
    name: 'style',
    value: 'width: 100% !important; border-collapse: separate !important; border-spacing: 0 !important; border-radius: 10px !important; overflow: hidden !important',
  }];
  node.childNodes = [tr];
}

function safeUrl(value, { image = false } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.startsWith('javascript:') || raw.startsWith('data:')) return null;
  if (image && raw.startsWith('blob:')) return null;
  if (!image && !/^(?:https?:|mailto:)/iu.test(raw)) return null;
  return raw;
}

function validatedImageSource(node, { allowRemoteImages = false } = {}) {
  const source = attributes(node).find(attr => attr.name === 'src')?.value;
  const url = safeUrl(source, { image: true });
  if (!url) throw new CommandExecutionError('HTML contains an unsupported image source');
  const isHttpsRemote = /^https:\/\//iu.test(url);
  const isHttpRemote = /^http:\/\//iu.test(url);
  const isRemote = isHttpsRemote || isHttpRemote;
  if (isRemote && !allowRemoteImages) {
    throw new CommandExecutionError('API mode requires HTML images to be local files');
  }
  return { url, isRemote };
}

function validateImageSources(node, options) {
  if (!node || typeof node !== 'object') return;
  const tag = String(node.tagName ?? node.nodeName ?? '').toLowerCase();
  if (tag === 'img') validatedImageSource(node, options);
  for (const child of node.childNodes ?? []) validateImageSources(child, options);
}

export function validateHtmlImageSources(html, { allowRemoteImages = false } = {}) {
  const fragment = parseWechatHtmlFragment(String(html ?? ''));
  for (const node of fragment.childNodes ?? []) validateImageSources(node, { allowRemoteImages });
}

function sanitizeAttributes(node) {
  for (const attr of [...attributes(node)]) {
    const name = attr.name.toLowerCase();
    if (name.startsWith('on') || name === 'id' || name === 'class' || name === 'srcset') {
      removeAttribute(node, attr.name);
      continue;
    }
    if (name === 'style') {
      const style = normalizeStyle(String(attr.value ?? '')
        .replace(/url\s*\([^)]*\)/giu, '')
        .replace(/expression\s*\([^)]*\)/giu, '')
        .replace(/-moz-binding\s*:[^;]+;?/giu, ''));
      if (style) setAttribute(node, 'style', style);
      else removeAttribute(node, attr.name);
      continue;
    }
    if (name === 'href') {
      const url = safeUrl(attr.value);
      if (url) setAttribute(node, 'href', url);
      else removeAttribute(node, attr.name);
      continue;
    }
    if (name === 'src' && node.tagName === 'img') continue;
    if (name !== 'alt' && name !== 'title' && name !== 'target' && name !== 'rel') {
      removeAttribute(node, attr.name);
    }
  }
}

async function sanitizeNode(node, options) {
  if (!node || typeof node !== 'object') return;
  if (node.nodeName === '#text') return;
  if (node.nodeName === '#comment') {
    node.nodeName = '#text';
    node.value = '';
    delete node.data;
    return;
  }

  const tag = String(node.tagName ?? node.nodeName ?? '').toLowerCase();
  if (DROP_TAGS.has(tag)) {
    node.childNodes = [];
    node.tagName = 'div';
    node.nodeName = 'div';
    node.attrs = [];
  } else if (!ALLOWED_TAGS.has(tag)) {
    node.tagName = 'span';
    node.nodeName = 'span';
    sanitizeAttributes(node);
  } else {
    sanitizeAttributes(node);
  }

  convertBackgroundSection(node);

  if (tag === 'img') {
    const { url } = validatedImageSource(node, options);
    const resolved = await options.resolveImage(url);
    if (!resolved) throw new CommandExecutionError(`Could not upload HTML image: ${url}`);
    setAttribute(node, 'src', resolved);
  }

  for (const child of node.childNodes ?? []) await sanitizeNode(child, options);
}

export function loadDraftContent({ content, contentFile, contentFormat = 'text' }) {
  const format = String(contentFormat ?? 'text').toLowerCase();
  if (!['html', 'html-text', 'text'].includes(format)) throw new ArgumentError('content-format must be html, html-text, or text');
  if (contentFile) {
    const filePath = nodePath.resolve(String(contentFile));
    let fileContent;
    try {
      fileContent = nodeFs.readFileSync(filePath, 'utf8');
    } catch {
      throw new ArgumentError(`content-file must be a readable file: ${filePath}`);
    }
    if (!fileContent.trim()) throw new ArgumentError('content-file must not be empty');
    return {
      format: format === 'html-text' ? 'text' : format,
      content: format === 'html-text' ? htmlToPlainText(fileContent) : fileContent,
      filePath,
    };
  }
  const value = String(content ?? '');
  if (!value.trim()) throw new ArgumentError('content or content-file must not be empty');
  return {
    format: format === 'html-text' ? 'text' : format,
    content: format === 'html-text' ? htmlToPlainText(value) : value,
    filePath: null,
  };
}

export async function prepareHtmlContent(html, {
  baseDir = process.cwd(),
  resolveImage,
  allowRemoteImages = false,
} = {}) {
  if (typeof resolveImage !== 'function') throw new ArgumentError('resolveImage is required for HTML content');
  const fragment = parseWechatHtmlFragment(String(html ?? ''));
  for (const node of fragment.childNodes ?? []) validateImageSources(node, { allowRemoteImages });
  const imageResolver = async source => {
    const absolute = /^https?:\/\//iu.test(source) ? source : nodePath.resolve(baseDir, source);
    return resolveImage(absolute);
  };
  for (const node of fragment.childNodes ?? []) {
    await sanitizeNode(node, {
      resolveImage: imageResolver,
      allowRemoteImages,
    });
  }
  return { html: serializeWechatHtml(fragment) };
}
