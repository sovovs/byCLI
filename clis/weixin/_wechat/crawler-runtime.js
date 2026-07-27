import crawler from '@sovovs/wechat-article-crawler';
import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@sovovs/bycli/errors';

const {
  CrawlerError,
  collectArticles,
  createWechatApi,
  isTrustedWechatArticleUrl,
  saveArticles,
} = crawler;

export {
  CrawlerError,
  collectArticles,
  createWechatApi,
  isTrustedWechatArticleUrl,
  saveArticles,
};

export async function callCrawler(operation) {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof CrawlerError)) throw error;

    if (error.code === 'INVALID_ARGUMENT') {
      throw new ArgumentError(error.message);
    }
    if (error.code === 'AUTH_REQUIRED') {
      throw new AuthRequiredError('mp.weixin.qq.com', error.message);
    }
    throw new CommandExecutionError(error.message);
  }
}
