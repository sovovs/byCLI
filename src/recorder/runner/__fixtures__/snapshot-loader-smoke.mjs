import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  captureAdapterSource,
  executeAdapterForVerify,
  loadAdapterSnapshot,
} from '../verify-runner-main.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-snapshot-smoke-'));
try {
  fs.writeFileSync(path.join(root, 'helper.mjs'), 'export const marker = "snapshot-a";\n');
  const adapterPath = path.join(root, 'adapter.mjs');
  const registryApi = pathToFileURL(fileURLToPath(new URL('../../../registry-api.ts', import.meta.url))).href;
  fs.writeFileSync(adapterPath, `
    import { cli } from ${JSON.stringify(registryApi)};
    import { marker } from './helper.mjs';
    cli({ site: 'snapshot', name: 'a', access: 'read', browser: false, args: [], func: async () => [{ marker }] });
  `);
  const snapshot = captureAdapterSource(adapterPath);
  fs.writeFileSync(adapterPath, 'throw new Error("replacement-b-executed");\n');
  const command = await loadAdapterSnapshot(snapshot, 'snapshot/a');
  const result = await executeAdapterForVerify(command, { name: 'snapshot/a', seedArgs: {} });
  process.stdout.write(JSON.stringify({ hash: snapshot.sourceSha256, result }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
