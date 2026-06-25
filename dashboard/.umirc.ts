import { defineConfig } from '@umijs/max';

export default defineConfig({
  esbuildMinifyIIFE: true,
  antd: {
    // 暗色主题:对齐 V1.1 设计稿的配色
    theme: {
      token: {
        // 青色主题:teal 为主导强调色,背景偏冷的深青黑。
        colorPrimary: '#2dd4bf',
        // colorInfo 保持蓝色:作语义信息/「中」置信度的区分色(青色主导靠 colorPrimary)
        colorInfo: '#58a6ff',
        colorBgBase: '#080d10',
        colorBgContainer: '#0e171b',
        colorBgElevated: '#14222a',
        colorBorder: '#1f3138',
        colorText: '#e6f4f1',
        colorTextSecondary: '#8ba3a3',
        colorSuccess: '#34d399',
        colorWarning: '#f0a868',
        colorError: '#f47067',
        borderRadius: 10,
        fontSize: 14,
        fontFamily: "'Fira Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        fontFamilyCode: "'Fira Code', 'SFMono-Regular', Menlo, monospace",
      },
    },
    // 启用 antd 5 的暗色算法
    dark: true,
  },
  access: {},
  model: {},
  initialState: {},
  request: {},
  // 单页录制工作台:不挂 ProLayout(无 header / 无 sider),页面自渲全屏布局。
  routes: [
    {
      path: '/',
      redirect: '/workbench',
    },
    {
      path: '/workbench',
      component: './Workbench',
    },
  ],
  npmClient: 'pnpm',
});
