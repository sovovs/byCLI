// N2 · 临时草稿存储。LLM 生成 + 静态检查通过的脚本写到 **~/.bycli/.recorder-drafts/<rand>/** 0700 目录、
// 0600 文件——刻意放在 bycli home 下(与正式 clis/ 同 FS 根,verify-runner 对 @sovovs/bycli 的模块解析行为一致),
// 但**不在 clis/ 内**(不被 discovery/registry 收录)。verify 成功后由保存步骤(N4)再落到正式 clis/。
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DraftFile {
  path: string;
  site: string;
  name: string;
}

const safeSeg = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'x';

/** 建一个 0700 草稿目录(~/.bycli/.recorder-drafts/<rand>)。 */
export function makeDraftDir(): string {
  const base = join(homedir(), '.bycli', '.recorder-drafts');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(base, 'd-'));
  try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
  return dir;
}

/** 把脚本写进草稿目录(每个 0600);返回各自路径。 */
export function writeDrafts(dir: string, scripts: Array<{ site: string; name: string; source: string }>): DraftFile[] {
  const out: DraftFile[] = [];
  for (const s of scripts) {
    const path = join(dir, `${safeSeg(s.site)}__${safeSeg(s.name)}.js`);
    writeFileSync(path, s.source, { mode: 0o600 });
    out.push({ path, site: s.site, name: s.name });
  }
  return out;
}

/** 清理整个草稿目录(verify+保存后或会话结束)。 */
export function cleanupDraftDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
