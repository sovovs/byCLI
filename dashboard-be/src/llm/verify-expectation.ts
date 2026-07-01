// N3 · verifyExpectation 比对(纯函数)。verify summary 只回 rows/fieldCount/stage/ok(脱敏),
// 用 LLM 自带的 verifyExpectation(minRows/expectedFieldCount/expectedStage)判一个草稿是否「达标」。
// 达标的草稿才进入展示/保存;不达标的丢弃或降级。
import type { VerifyExpectation } from './generate.js';

export interface VerifySummaryLike {
  ok?: boolean;
  stage?: string;
  rows?: number;
  fieldCount?: number;
}

export interface VerifyOutcome {
  ok: boolean;
  rows: number;
  fieldCount: number;
  reasons: string[];
}

/** 判 verify 结果是否满足期望。无 expectation 时退回最低门槛(verify ok 且 rows≥1)。 */
export function meetsExpectation(summary: VerifySummaryLike | null, exp?: VerifyExpectation): VerifyOutcome {
  const rows = typeof summary?.rows === 'number' ? summary.rows : 0;
  const fieldCount = typeof summary?.fieldCount === 'number' ? summary.fieldCount : 0;
  const reasons: string[] = [];

  if (!summary || summary.ok !== true) reasons.push('verify 未成功(ok!=true)');

  const minRows = exp && typeof exp.minRows === 'number' ? exp.minRows : 1; // 缺省最低 1 行
  if (rows < minRows) reasons.push(`rows ${rows} < 期望 ${minRows}`);

  if (exp) {
    if (exp.expectedStage && summary?.stage && summary.stage !== exp.expectedStage) {
      reasons.push(`stage ${summary.stage} ≠ 期望 ${exp.expectedStage}`);
    }
    if (typeof exp.expectedFieldCount === 'number' && exp.expectedFieldCount > 0 && fieldCount !== exp.expectedFieldCount) {
      reasons.push(`fieldCount ${fieldCount} ≠ 期望 ${exp.expectedFieldCount}`);
    }
  }

  return { ok: reasons.length === 0, rows, fieldCount, reasons };
}
