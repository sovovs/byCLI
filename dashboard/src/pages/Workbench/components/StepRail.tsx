// 录制流程进度轨 —— 单一可视化(替代旧的 FlowGraph 画布 + antd Steps 重复)。
// 纯自定义 DOM + global.less 青色样式;带 aria 语义供 AT。
interface Step {
  key: string;
  title: string;
}

interface Props {
  steps: Step[];
  /** 当前活动 step 序号(0-based);done 时 = steps.length */
  current: number;
  failed?: boolean;
}

const STATUS_LABEL = { done: '已完成', active: '当前步骤', pending: '未开始', failed: '失败' } as const;

export default function StepRail({ steps, current, failed }: Props) {
  return (
    <ol className="wb-rail" aria-label="录制流程进度">
      {steps.map((s, i) => {
        const status =
          failed && i === current ? 'failed' : i < current ? 'done' : i === current ? 'active' : 'pending';
        return (
          <li
            key={s.key}
            className={`wb-step wb-step--${status}`}
            aria-label={`${s.title},${STATUS_LABEL[status]}`}
            aria-current={status === 'active' ? 'step' : undefined}
          >
            <span className="wb-step__dot" aria-hidden>
              {status === 'done' ? '✓' : i + 1}
            </span>
            <span className="wb-step__label">{s.title}</span>
          </li>
        );
      })}
    </ol>
  );
}
