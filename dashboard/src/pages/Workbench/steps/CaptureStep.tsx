// Step 3 · 采集 A/B 样本 —— capture/start + capture/read 两个样本窗口(串行)
import { CheckCircleFilled } from '@ant-design/icons';
import { Button, Card, Col, Row, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { CaptureSample, NetworkEntry, SessionState } from '@/types/recorder';

const { Paragraph, Text } = Typography;

const entryColumns: ColumnsType<NetworkEntry> = [
  { title: '方法', dataIndex: 'method', width: 64, render: (m) => <Tag className="code">{m}</Tag> },
  { title: 'Path', dataIndex: 'pathname', render: (p) => <Text className="code" style={{ fontSize: 12 }}>{p}</Text> },
  {
    title: '状态',
    dataIndex: ['response', 'status'],
    width: 70,
    render: (s: number) => <Tag color={s < 300 ? '#56d364' : '#f0a868'} className="code">{s}</Tag>,
  },
  {
    title: '耗时',
    dataIndex: ['timing', 'durationMs'],
    width: 80,
    render: (d: number) => <Text className="code" type="secondary">{d}ms</Text>,
  },
];

function SampleCard({ name, sample }: { name: 'A' | 'B'; sample?: CaptureSample }) {
  return (
    <Card
      size="small"
      title={
        <Space>
          样本 {name}
          {sample && <CheckCircleFilled style={{ color: '#56d364' }} />}
        </Space>
      }
    >
      {sample ? (
        <Table
          size="small"
          rowKey="requestId"
          dataSource={sample.entries}
          columns={entryColumns}
          pagination={false}
        />
      ) : (
        <Text type="secondary">尚未采集</Text>
      )}
    </Card>
  );
}

interface Props {
  state: SessionState;
  loading: boolean;
  sampleA?: CaptureSample;
  sampleB?: CaptureSample;
  onCaptureA: () => void;
  onCaptureB: () => void;
}

export default function CaptureStep({ state, loading, sampleA, sampleB, onCaptureA, onCaptureB }: Props) {
  const hasA = !!sampleA;
  const hasB = !!sampleB;
  return (
    <Card title="采集 A/B 样本" variant="borderless">
      <Paragraph type="secondary" style={{ lineHeight: 1.6 }}>
        对同一 page lease 串行采集两个样本窗口(用不同关键词触发,便于后续 normalize/diff 识别动态参数)。
        一个会话同时只允许一个活动采集窗口。
      </Paragraph>
      <Row gutter={[12, 12]}>
        <Col xs={24} md={12}>
          <SampleCard name="A" sample={sampleA} />
          <Button
            type={hasA ? 'default' : 'primary'}
            block
            loading={loading && state === 'page_ready'}
            disabled={hasA}
            onClick={onCaptureA}
            style={{ marginTop: 8 }}
          >
            {hasA ? '样本 A 已采集' : '采集样本 A'}
          </Button>
        </Col>
        <Col xs={24} md={12}>
          <SampleCard name="B" sample={sampleB} />
          <Button
            type={hasB ? 'default' : 'primary'}
            block
            loading={loading && state === 'capture_a'}
            disabled={!hasA || hasB}
            onClick={onCaptureB}
            style={{ marginTop: 8 }}
          >
            {hasB ? '样本 B 已采集' : '采集样本 B'}
          </Button>
        </Col>
      </Row>
    </Card>
  );
}
