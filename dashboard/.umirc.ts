import { defineConfig } from '@umijs/max';

export default defineConfig({
  esbuildMinifyIIFE: true,
  antd: {
    // 暗色主题:对齐 V1.1 设计稿的配色
    theme: {
      token: {
        colorPrimary: '#2dd4bf',
        colorInfo: '#58a6ff',
        colorBgBase: '#0d1117',
        colorBgContainer: '#161b22',
        colorBgElevated: '#1c2330',
        colorBorder: '#2d3744',
        colorText: '#e6edf3',
        colorTextSecondary: '#9da7b3',
        colorSuccess: '#56d364',
        colorWarning: '#f0a868',
        colorError: '#f47067',
        borderRadius: 8,
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
  layout: {
    title: 'byCLI · Adapter Recorder',
  },
  routes: [
    {
      path: '/',
      redirect: '/workbench',
    },
    {
      name: '录制工作台',
      path: '/workbench',
      icon: 'Experiment',
      component: './Workbench',
      // 单页应用:顶栏只保留品牌标识,不展示导航项(与页面 H1 重复)。
      hideInMenu: true,
    },
  ],
  npmClient: 'pnpm',
});
