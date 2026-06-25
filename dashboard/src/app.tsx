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

// 单页应用(仅录制工作台):品牌走顶部 header,去掉左侧导航 sider。
// 菜单项由路由 hideInMenu 隐藏(.umirc.ts),顶栏仅余品牌标识。
export const layout = () => ({
  layout: 'top' as const,
});
