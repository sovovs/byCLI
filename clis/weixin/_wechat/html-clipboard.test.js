import { describe, expect, it, vi } from 'vitest';
import { pasteHtmlThroughClipboard } from './html-clipboard.js';

function createPage(editorResult = { ok: true, html: '<p><strong>Rich</strong></p>', text: 'Rich' }) {
  return {
    cdp: vi.fn().mockResolvedValue({}),
    evaluate: vi.fn().mockImplementation(async script => {
      if (script.includes('navigator.clipboard.write')) return { ok: true };
      if (script.includes('editor.focus')) return { ok: true, rect: { x: 120, y: 240, width: 600, height: 300 } };
      if (script.includes('contenteditable')) return editorResult;
      return true;
    }),
    focusWindow: vi.fn().mockResolvedValue(undefined),
    nativeClick: vi.fn().mockResolvedValue(undefined),
    nativeKeyPress: vi.fn().mockResolvedValue(undefined),
  };
}

describe('weixin HTML clipboard paste', () => {
  it('writes both HTML and plain text and pastes with the platform shortcut', async () => {
    const page = createPage();

    await expect(pasteHtmlThroughClipboard(page, '<p><strong>Rich</strong></p>', {
      origin: 'https://mp.weixin.qq.com',
      platform: 'darwin',
    })).resolves.toMatchObject({ html: '<p><strong>Rich</strong></p>', text: 'Rich' });

    expect(page.cdp).toHaveBeenCalledWith('Browser.grantPermissions', {
      origin: 'https://mp.weixin.qq.com',
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
    expect(page.evaluate).toHaveBeenCalledWith(expect.stringContaining('navigator.clipboard.write'));
    expect(page.evaluate).toHaveBeenCalledWith(expect.stringContaining('collapse(false)'));
    expect(page.evaluate.mock.calls.filter(([script]) => script.includes('collapse(false)'))).toHaveLength(2);
    expect(page.cdp).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({
      type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 4,
    }));
    expect(page.focusWindow).toHaveBeenCalledTimes(2);
    expect(page.nativeClick).toHaveBeenCalledWith(420, 390);
  });

  it('uses Ctrl+V on non-macOS platforms', async () => {
    const page = createPage();

    await pasteHtmlThroughClipboard(page, '<p>Rich</p>', { platform: 'linux' });

    expect(page.cdp).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({
      type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 2,
    }));
  });

  it('continues when the bridge does not expose permission grant passthrough', async () => {
    const page = createPage();
    page.cdp.mockRejectedValueOnce(new Error('CDP method not permitted: Browser.grantPermissions'));

    await expect(pasteHtmlThroughClipboard(page, '<p>Rich</p>', { platform: 'linux' }))
      .resolves.toMatchObject({ text: 'Rich' });
    expect(page.evaluate).toHaveBeenCalledWith(expect.stringContaining('navigator.clipboard.write'));
  });

  it('rejects plain-text-only editor results after paste', async () => {
    const page = createPage({ ok: true, html: 'Rich', text: 'Rich' });

    await expect(pasteHtmlThroughClipboard(page, '<p>Rich</p>', { platform: 'linux' }))
      .rejects.toThrow(/rich HTML content was not retained by the editor.*htmlLength=4.*tags=none/);
  });

  it('accepts WeChat structural wrappers around pasted rich text', async () => {
    const page = createPage({ ok: true, html: '<section><span>Rich</span></section>', text: 'Rich' });

    await expect(pasteHtmlThroughClipboard(page, '<p>Rich</p>', { platform: 'linux' }))
      .resolves.toMatchObject({ text: 'Rich' });
  });
});
