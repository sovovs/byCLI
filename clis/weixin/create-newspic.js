import { cli, Strategy } from '@sovovs/bycli/registry';
import { ArgumentError } from '@sovovs/bycli/errors';
import { createNewspicDraftViaApi } from './_wechat/api-newspic.js';

const MAX_TITLE_LENGTH = 32;

function codePointLength(value) {
  return [...value].length;
}

function requiredText(value, name) {
  const text = String(value ?? '').trim();
  if (!text) throw new ArgumentError(`${name} must not be empty`);
  return text;
}

function parseImages(value) {
  const images = requiredText(value, 'images').split(',').map(item => item.trim());
  if (images.some(image => !image)) throw new ArgumentError('images must not contain empty entries');
  if (images.length < 1 || images.length > 20) throw new ArgumentError('newspic requires 1–20 images');
  return images;
}

export const createNewspicCommand = cli({
  site: 'weixin',
  name: 'create-newspic',
  access: 'write',
  description: '通过微信公众号官方 API 创建贴图草稿（不会公开发布）',
  example: 'bycli weixin create-newspic --title "相册标题" --images "./01.jpg,http://example.com/02.png" --content "说明文字" --appid wx123 --appsecret secret',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'title', required: true, help: '贴图标题（最长 32 字）' },
    { name: 'images', required: true, help: '1–20 张本地或 HTTP(S) 图片，使用逗号分隔' },
    { name: 'content', valueRequired: true, help: '可选的纯文本贴图说明' },
    { name: 'appid', required: true, help: '公众号 AppID' },
    { name: 'appsecret', required: true, help: '公众号 AppSecret；请勿提交到 shell 历史或日志' },
    { name: 'allow-private-image-hosts', type: 'boolean', default: false, help: '允许下载 localhost/内网 HTTP(S) 图片；云元数据地址始终禁止' },
  ],
  columns: ['status', 'detail'],

  func: async (kwargs) => {
    const title = requiredText(kwargs.title, 'title');
    if (codePointLength(title) > MAX_TITLE_LENGTH) {
      throw new ArgumentError(`title must be at most ${MAX_TITLE_LENGTH} characters`);
    }
    const images = parseImages(kwargs.images);
    const result = await createNewspicDraftViaApi({
      appid: requiredText(kwargs.appid, 'appid'),
      appsecret: requiredText(kwargs.appsecret, 'appsecret'),
      title,
      content: kwargs.content == null ? '' : String(kwargs.content),
      images,
      allowPrivateImageHosts: kwargs['allow-private-image-hosts'] === true,
    });
    return [{
      status: 'newspic draft created',
      detail: `"${title}" (media_id: ${result.mediaId}, images: ${images.length})${result.cleanupWarning ? `; warning: ${result.cleanupWarning}` : ''}`,
    }];
  },
});
