// A real BROWSER adapter fixture for the M6b verify-runner smoke. Registering with
// browser:true means executeAdapterForVerify routes it through the browser branch, so the
// child must construct a daemon-backed Page and connect BACK to the daemon (BYCLI_DAEMON_PORT)
// to run `func`. Lives inside the package so `@sovovs/bycli/registry` resolves; imported by
// absolute path via input.json's adapterPath.
import { cli, Strategy } from '@sovovs/bycli/registry';

cli({
  site: 'm6bsmoke',
  name: 'probe',
  access: 'read',
  description: 'M6b browser-branch smoke — touches the page, forcing a daemon connect-back',
  strategy: Strategy.COOKIE, // browser strategy → browser:true
  browser: true,
  args: [],
  func: async (page) => {
    // Any page op routes through sendCommand → daemon /command. With no extension on the
    // target daemon this surfaces a connect-back error (proving we reached the daemon), not
    // a fabricated result.
    await page.evaluate('1 + 1');
    return [{ ok: 1 }];
  },
});
