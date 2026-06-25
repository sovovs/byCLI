// Umi Max runtime config —— 注入 Fira 字体 token,补全 .umirc.ts 未设的 fontFamily。
import type { RuntimeAntdConfig } from '@umijs/max';

export const antd: RuntimeAntdConfig = (memo) => {
  memo.theme ??= {};
  memo.theme.token = {
    ...memo.theme.token,
    fontFamily: "'Fira Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontFamilyCode: "'Fira Code', 'SFMono-Regular', Menlo, monospace",
  };
  return memo;
};
