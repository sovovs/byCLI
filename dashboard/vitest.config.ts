import { defineConfig } from 'vitest/config';

// 前端单测最小配置。httpRecorderClient 只依赖全局 fetch(不碰 DOM,类型 import 擦除),
// 故用 node 环境即可,无需 jsdom;`@` alias 仅出现在 type-only import 中(运行时擦除),无需重建。
//
// 为何 package.json 的 test 脚本走根 vitest(../node_modules/.bin/vitest):
// Umi Max 4.6 把 vite 锁在 4.5.2(传递依赖),而现代 vitest(2/3/4)要求 vite 6+,在
// dashboard 本地装会因缺 vite 的 ./module-runner 而无法启动。主仓根的 vitest 4 + 兼容
// vite 可正常跑本目录测试,故复用根 runner,dashboard 不自带(会装不上的)vitest 依赖。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
