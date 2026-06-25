// 右侧会话状态面板 —— sessionId / state / stateVersion / 目标 URL。
// 等宽字段用 Fira Code(.code)。
import { Badge, Card, Descriptions, Typography } from 'antd';
import { isFailed, isTerminal } from '@/constants/recorder';
import type { SessionState } from '@/types/recorder';

const { Text } = Typography;

const STATE_BADGE: Record<string, 'processing' | 'success' | 'error' | 'default'> = {
  done: 'success',
  failed: 'error',
  cancelled: 'default',
};

interface Props {
  state: SessionState;
  stateVersion: number;
  sessionId?: string;
  targetUrl?: string;
}

export default function StatePanel({ state, stateVersion, sessionId, targetUrl }: Props) {
  const badge = STATE_BADGE[state] ?? (isTerminal(state) ? 'default' : 'processing');
  return (
    <Card size="small" title="会话状态" style={{ position: 'sticky', top: 16 }}>
      <Descriptions size="small" column={1} colon={false} styles={{ label: { width: 88 } }}>
        <Descriptions.Item label="当前状态">
          <Badge status={badge} text={<Text strong className="code">{state}</Text>} />
        </Descriptions.Item>
        <Descriptions.Item label="stateVersion">
          <Text className="code">{stateVersion}</Text>
        </Descriptions.Item>
        <Descriptions.Item label="sessionId">
          <Text className="code" type={sessionId ? undefined : 'secondary'}>
            {sessionId ?? '—'}
          </Text>
        </Descriptions.Item>
        <Descriptions.Item label="目标 URL">
          {targetUrl ? (
            <Text className="code" style={{ fontSize: 12 }} ellipsis={{ tooltip: targetUrl }}>
              {targetUrl}
            </Text>
          ) : (
            <Text type="secondary">—</Text>
          )}
        </Descriptions.Item>
      </Descriptions>
      {isFailed(state) && (
        <Text type="danger" style={{ fontSize: 12 }}>
          会话已终止,租约与采集窗口已释放。需重新绑定新会话。
        </Text>
      )}
    </Card>
  );
}
