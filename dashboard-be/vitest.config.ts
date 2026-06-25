import { defineConfig } from 'vitest/config';

// 重型 e2e 默认排除,各自门控:
//  - Tier A 真 daemon 子进程 smoke(需 dist,无 Chrome)→ BYCLI_RECORDER_E2E=1(CI 每 PR)。
//  - C1 真 Chrome be→真浏览器 capture(需 dist + 扩展 + Chrome,会抖)→ BYCLI_AX_E2E=1(CI nightly)。
// `npm test`(默认)两者都不触发。
const recorderE2e = process.env.BYCLI_RECORDER_E2E === '1';
const axE2e = process.env.BYCLI_AX_E2E === '1';

const exclude: string[] = [];
if (!recorderE2e) exclude.push('test/recorder-real-daemon-e2e.test.ts');
if (!axE2e) exclude.push('test/recorder-real-browser-capture.test.ts');

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude,
  },
});
