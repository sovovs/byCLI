// FlowGraph —— React-Flow 横向 DAG,可视化 8 步主流程状态机,当前态高亮。
// MASTER.md 图表语义:已完成=#56d364 / 当前=#2dd4bf / 未到达=边框灰 / 失败=#f47067。
import { useMemo } from 'react';
import ReactFlow, { Background, Controls, MarkerType, Position, type Edge, type Node } from 'reactflow';
import 'reactflow/dist/style.css';
import { FLOW_COLOR, FLOW_STEPS, STATE_ORDER, isFailed } from '@/constants/recorder';
import type { SessionState } from '@/types/recorder';

interface Props {
  state: SessionState;
}

export default function FlowGraph({ state }: Props) {
  const currentOrder = STATE_ORDER[state];
  const failed = isFailed(state);

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = FLOW_STEPS.map((step, i) => {
      const stepOrder = i + 1; // 该 step 的 doneState 在主流程的序号(health=1 ...)
      const done = currentOrder >= stepOrder;
      const active = !failed && currentOrder === stepOrder - 1; // 正在进行该 step
      const color = failed && active ? FLOW_COLOR.failed : done ? FLOW_COLOR.done : active ? FLOW_COLOR.active : FLOW_COLOR.pending;

      return {
        id: step.key,
        position: { x: i * 150, y: 0 },
        data: { label: `${i + 1}. ${step.title}` },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          width: 128,
          fontSize: 12,
          borderRadius: 8,
          border: `2px solid ${color}`,
          background: done ? '#15301f' : active ? '#10261f' : '#161b22',
          color: '#e6edf3',
          boxShadow: active ? `0 0 0 3px ${FLOW_COLOR.active}33` : undefined,
          fontFamily: "'Fira Sans', sans-serif",
        },
      };
    });

    const edges: Edge[] = FLOW_STEPS.slice(1).map((step, i) => {
      const targetOrder = i + 2;
      const traversed = currentOrder >= targetOrder;
      return {
        id: `${FLOW_STEPS[i].key}-${step.key}`,
        source: FLOW_STEPS[i].key,
        target: step.key,
        animated: !failed && currentOrder === targetOrder - 1,
        style: { stroke: traversed ? FLOW_COLOR.done : FLOW_COLOR.pending, strokeWidth: traversed ? 2 : 1 },
        markerEnd: { type: MarkerType.ArrowClosed, color: traversed ? FLOW_COLOR.done : FLOW_COLOR.pending },
      };
    });

    return { nodes, edges };
  }, [currentOrder, failed, state]);

  return (
    <div style={{ height: 130, border: '1px solid #2d3744', borderRadius: 8, background: '#0d1117' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#2d3744" gap={16} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
