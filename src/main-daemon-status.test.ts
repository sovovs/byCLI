import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('daemon status JSON main fast path', () => {
  it('bypasses discovery and update notices so stdout and stderr stay machine-safe', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bycli-status-json-'));
    tempDirs.push(home);
    fs.mkdirSync(path.join(home, '.bycli'), { recursive: true });
    fs.writeFileSync(path.join(home, '.bycli', 'update-check.json'), JSON.stringify({
      lastCheck: Date.now(),
      latestVersion: '999.0.0',
    }));

    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/main.ts', 'daemon', 'status', '--json'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          BYCLI_DAEMON_PORT: '65431',
          CI: '',
          CONTINUOUS_INTEGRATION: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, state: 'stopped' });
  });

  it('returns a JSON usage error with exit 2 for unsupported status options', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/main.ts', 'daemon', 'status', '--json', '--bogus'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, BYCLI_DAEMON_PORT: '65431' },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      state: 'degraded',
      error: { code: 'invalid_arguments' },
    });
  });
});
