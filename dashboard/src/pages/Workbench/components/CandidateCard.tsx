// 单个 RankCandidate 候选卡 —— 展示 score/confidence/risks/scoreExplanation/endpoint。
// 配色全走主题 token(theme.useToken),等宽字段用 Fira Code(.code class)。
import { CheckCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { Button, Card, Descriptions, Progress, Space, Tag, Tooltip, Typography, theme } from 'antd';
import { CONFIDENCE_LABEL } from '@/constants/recorder';
import type { Confidence, RankCandidate } from '@/types/recorder';

const { Text, Paragraph } = Typography;

interface Props {
  candidate: RankCandidate;
  selected: boolean;
  disabled?: boolean;
  onSelect: (id: string) => void;
}

export default function CandidateCard({ candidate, selected, disabled, onSelect }: Props) {
  const { id, endpoint, score, confidence, reviewRequired, args, responseShape, scoreExplanation, risks } = candidate;
  const { token } = theme.useToken();
  // confidence → 主题 token 色(高=主色青 / 中=info 蓝 / 低=warning 琥珀 / 拒绝=error 红)
  const confidenceColor: Record<Confidence, string> = {
    high: token.colorPrimary,
    medium: token.colorInfo,
    low: token.colorWarning,
    rejected: token.colorError,
  };
  const color = confidenceColor[confidence];
  const selectable = !disabled && confidence !== 'rejected';

  return (
    <Card
      size="small"
      onClick={() => selectable && onSelect(id)}
      style={{
        borderColor: selected ? color : undefined,
        borderWidth: selected ? 2 : 1,
        cursor: selectable ? 'pointer' : 'not-allowed',
        opacity: confidence === 'rejected' ? 0.6 : 1,
        transition: 'border-color 200ms, box-shadow 200ms',
        boxShadow: selected ? `0 0 0 2px ${color}33` : undefined,
      }}
      title={
        <Space size={8}>
          <Tag color={color} style={{ marginInlineEnd: 0 }}>
            {CONFIDENCE_LABEL[confidence]}
          </Tag>
          <Text strong className="code">
            {endpoint.method} {endpoint.pathname}
          </Text>
        </Space>
      }
      extra={
        <Tooltip title="排序得分(0–100)">
          <Progress
            type="circle"
            percent={Math.max(0, Math.min(100, score))}
            size={40}
            strokeColor={color}
            format={(p) => <span style={{ fontSize: 11 }}>{p}</span>}
          />
        </Tooltip>
      }
    >
      <Descriptions size="small" column={1} colon={false} styles={{ label: { width: 96 } }}>
        <Descriptions.Item label="URL 模板">
          <Text className="code" copyable style={{ fontSize: 12 }}>
            {endpoint.urlTemplate}
          </Text>
        </Descriptions.Item>
        {!!args?.length && (
          <Descriptions.Item label="参数映射">
            <Space size={[4, 4]} wrap>
              {args.map((a) => (
                <Tag key={a.argName} className="code" style={{ fontSize: 11 }}>
                  {a.argName} → {a.in}:{a.paramName}
                </Tag>
              ))}
            </Space>
          </Descriptions.Item>
        )}
        {responseShape && (
          <Descriptions.Item label="响应结构">
            <Text type="secondary" style={{ fontSize: 12 }}>
              {responseShape.kind}
              {responseShape.itemKeys?.length ? ` · ${responseShape.itemKeys.join(', ')}` : ''}
              {responseShape.count != null ? ` · ${responseShape.count} 条` : ''}
            </Text>
          </Descriptions.Item>
        )}
      </Descriptions>

      {!!scoreExplanation?.length && (
        <div style={{ marginTop: 8 }}>
          {scoreExplanation.map((s) => (
            <div key={s.signal} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, lineHeight: 1.6 }}>
              <Tooltip title={s.detail}>
                <Text type="secondary">{s.signal}</Text>
              </Tooltip>
              <Text style={{ color: s.delta >= 0 ? token.colorSuccess : token.colorError }}>
                {s.delta >= 0 ? '+' : ''}
                {s.delta}
              </Text>
            </div>
          ))}
        </div>
      )}

      {!!risks?.length && (
        <Paragraph type="warning" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
          <WarningOutlined /> {risks.join(';')}
        </Paragraph>
      )}

      <Button
        type={selected ? 'primary' : 'default'}
        size="small"
        block
        disabled={!selectable}
        aria-pressed={selected}
        aria-disabled={!selectable}
        icon={selected ? <CheckCircleOutlined /> : undefined}
        style={{ marginTop: 12 }}
        onClick={(e) => {
          e.stopPropagation();
          if (selectable) onSelect(id);
        }}
      >
        {confidence === 'rejected' ? '不可选(已拒绝)' : selected ? '已选定' : reviewRequired ? '选定(需复核)' : '选定此候选'}
      </Button>
    </Card>
  );
}
