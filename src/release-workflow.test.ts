import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('release workflow', () => {
  it('publishes recorder core only when its exact version is absent from npm', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

    expect(workflow).toContain('id: recorder_core_status');
    expect(workflow).toContain('npm view "${PACKAGE_NAME}@${PACKAGE_VERSION}" version');
    expect(workflow).toContain("published=true");
    expect(workflow).toContain("published=false");
    expect(workflow).toContain("if: steps.recorder_core_status.outputs.published != 'true'");
  });
});
