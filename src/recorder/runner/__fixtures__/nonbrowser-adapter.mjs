// A real non-browser adapter fixture for loadAdapterByName() — it registers via cli() at
// import time exactly like a user adapter. Lives inside the package so the
// `@sovovs/bycli/registry` self-reference resolves; the runner imports it by absolute path.
import { cli, Strategy } from '@sovovs/bycli/registry';

cli({
  site: 'smokefix',
  name: 'echo',
  access: 'read',
  description: 'verify-runner load fixture — echoes its arg, no network',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [{ name: 'q', positional: true, required: false, help: 'echoed back' }],
  func: async (args) => [{ echoed: args.q ?? null }],
});
