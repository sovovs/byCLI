import { CommandExecutionError } from '@sovovs/bycli/errors';

const RICH_NODE_PATTERN = /<(?:p|h[1-6]|strong|em|a|ul|ol|table|img|div|section|span)\b/i;

function plainTextFromHtml(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/\s+/gu, ' ')
    .trim();
}

function clipboardWriteScript(html, text) {
  return `(() => {
    const html = ${JSON.stringify(html)};
    const text = ${JSON.stringify(text)};
    if (!navigator.clipboard || typeof navigator.clipboard.write !== 'function' || typeof ClipboardItem !== 'function') {
      return { ok: false, reason: 'Clipboard API is unavailable' };
    }
    const item = new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    });
    return navigator.clipboard.write([item])
      .then(() => ({ ok: true }))
      .catch(error => ({ ok: false, reason: error && error.message ? error.message : String(error) }));
  })()`;
}

function editorReadScript() {
  return `(() => {
    const ueditor = document.querySelector('#ueditor_0');
    const iframeBody = ueditor?.tagName === 'IFRAME' ? ueditor.contentDocument?.body : null;
    const scopedEditors = [...document.querySelectorAll('#js_ueditor [contenteditable="true"], #js_editor [contenteditable="true"]')];
    const visibleEditors = scopedEditors.filter(node => node.offsetParent !== null);
    const editor = iframeBody || (ueditor?.matches?.('[contenteditable="true"]') ? ueditor : null)
      || visibleEditors[visibleEditors.length - 1];
    if (!editor) return { ok: false, reason: 'contenteditable editor not found' };
    const warning = [...document.querySelectorAll('.weui-desktop-dialog__wrp, .weui-desktop-dialog')]
      .some(dialog => {
        const wrap = dialog.closest('.weui-desktop-dialog__wrp') || dialog;
        return window.getComputedStyle(wrap).display !== 'none'
          && wrap.offsetHeight > 0
          && (dialog.innerText || '').includes('\u5b89\u5168\u9690\u60a3');
      });
    return { ok: true, warning, html: editor.innerHTML || '', text: editor.innerText || editor.textContent || '' };
  })()`;
}

export async function pasteHtmlThroughClipboard(page, html, {
  origin = 'https://mp.weixin.qq.com',
  platform = process.platform,
} = {}) {
  if (typeof page?.cdp !== 'function') {
    throw new CommandExecutionError('Rich HTML paste requires Browser Bridge CDP support');
  }
  if (typeof page?.evaluate !== 'function' || typeof page?.nativeKeyPress !== 'function' || typeof page?.nativeClick !== 'function') {
    throw new CommandExecutionError('Rich HTML paste requires page evaluation and native key support');
  }

  const source = String(html ?? '');
  if (!source.trim()) throw new CommandExecutionError('Rich HTML content must not be empty');

  if (typeof page.focusWindow === 'function') {
    try { await page.focusWindow(); } catch { /* the native paste will report focus failures */ }
  }

  try {
    await page.cdp('Browser.grantPermissions', {
      origin,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!message.includes('CDP method not permitted: Browser.grantPermissions')) {
      throw new CommandExecutionError(`Could not grant clipboard permission: ${message}`);
    }
  }

  const editorLocation = await page.evaluate(`(() => {
    const ueditor = document.querySelector('#ueditor_0');
    const iframeBody = ueditor?.tagName === 'IFRAME' ? ueditor.contentDocument?.body : null;
    const scopedEditors = [...document.querySelectorAll('#js_ueditor [contenteditable="true"], #js_editor [contenteditable="true"]')];
    const visibleEditors = scopedEditors.filter(node => node.offsetParent !== null);
    const editor = iframeBody || (ueditor?.matches?.('[contenteditable="true"]') ? ueditor : null)
      || visibleEditors[visibleEditors.length - 1];
    if (!editor) return { ok: false, reason: 'contenteditable editor not found' };
    const rect = (ueditor?.tagName === 'IFRAME' ? ueditor : editor).getBoundingClientRect();
    return {
      ok: rect.width > 0 && rect.height > 0,
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    };
  })()`);
  if (!editorLocation?.ok) throw new CommandExecutionError(`Could not locate rich-text editor: ${editorLocation?.reason ?? 'unknown error'}`);

  if (typeof page.focusWindow === 'function') {
    try { await page.focusWindow(); } catch { /* the clipboard write reports the actionable error */ }
  }
  const x = Math.round(editorLocation.rect.x + editorLocation.rect.width / 2);
  const y = Math.round(editorLocation.rect.y + editorLocation.rect.height / 2);
  await page.nativeClick(x, y);

  const written = await page.evaluate(clipboardWriteScript(source, plainTextFromHtml(source)));
  if (!written?.ok) throw new CommandExecutionError(`Could not write HTML to clipboard: ${written?.reason ?? 'unknown error'}`);

  const shortcut = platform === 'darwin' ? ['Meta'] : ['Ctrl'];
  try {
    await page.nativeKeyPress('v', shortcut);
  } catch {
    const modifiers = platform === 'darwin' ? 4 : 2;
    await page.cdp('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'v', code: 'KeyV', modifiers,
      windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86,
    });
    await page.cdp('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'v', code: 'KeyV', modifiers,
      windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86,
    });
  }
  if (typeof page.wait === 'function') await page.wait(1);

  const result = await page.evaluate(editorReadScript());
  if (result?.warning) {
    throw new CommandExecutionError('WeChat displayed its editor-integrity warning after rich HTML paste; the draft was not saved');
  }
  if (!result?.ok || !String(result.text ?? '').trim() || !RICH_NODE_PATTERN.test(String(result.html ?? ''))) {
    const actualHtml = String(result?.html ?? '');
    const actualText = String(result?.text ?? '');
    const tags = [...actualHtml.matchAll(/<([a-z0-9]+)/giu)].map(match => match[1].toLowerCase());
    throw new CommandExecutionError(
      `rich HTML content was not retained by the editor (htmlLength=${actualHtml.length}, textLength=${actualText.length}, tags=${tags.join(',') || 'none'})`,
    );
  }
  return { html: result.html, text: result.text };
}

export { plainTextFromHtml };
