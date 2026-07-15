import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = resolve(here, '../../../dashboard/schemas/adapter-recorder.bundle.json');
const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as {
  $defs: Record<string, {
    additionalProperties?: boolean;
    properties?: Record<string, unknown>;
  }>;
};

describe('verify source hash schema contract', () => {
  const sourceHashSchema = { type: 'string', pattern: '^[0-9a-f]{64}$' };

  it('declares the runner result source hash on a closed data object', () => {
    const data = bundle.$defs.RunnerResultEvent.properties?.data as {
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    };
    expect(data.additionalProperties).toBe(false);
    expect(data.properties?.sourceSha256).toEqual(sourceHashSchema);
  });

  it('declares the normalized verify summary source hash without opening the summary object', () => {
    const summary = bundle.$defs.VerifySummary;
    expect(summary.additionalProperties).toBe(false);
    expect(summary.properties?.sourceSha256).toEqual(sourceHashSchema);
  });
});
