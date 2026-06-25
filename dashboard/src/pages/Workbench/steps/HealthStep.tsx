// Step 1 · 健康检查 —— health(daemon/extension/high-level 健康卡)
import { ApiOutlined, CloudServerOutlined, DisconnectOutlined, RocketOutlined } from '@ant-design/icons';
import { Badge, Button, Card, Col, Row, Typography } from 'antd';
import type { HealthReport } from '@/types/recorder';

const { Text, Paragraph } = Typography;

const ITEMS: Array<{ key: keyof HealthReport; label: string; icon: React.ReactNode }> = [
  { key: 'localService', label: 'Local Service', icon: <CloudServerOutlined /> },
  { key: 'daemon', label: 'byCLI Daemon', icon: <ApiOutlined /> },
  { key: 'extension', label: 'Chrome 扩展', icon: <DisconnectOutlined /> },
  { key: 'highLevel', label: 'High-Level 模块', icon: <RocketOutlined /> },
];

interface Props {
  health?: HealthReport;
  loading: boolean;
  done: boolean;
  onRun: () => void;
}

export default function HealthStep({ health, loading, done, onRun }: Props) {
  return (
    <Card title="健康检查" variant="borderless">
      <Paragraph type="secondary" style={{ lineHeight: 1.6 }}>
        录制开始前的只读前置检查:确认 Local Service、daemon、扩展与 High-Level 模块均可用。此步无会话副作用。
      </Paragraph>
      <Row gutter={[12, 12]}>
        {ITEMS.map((it) => {
          const v = health?.[it.key];
          const okState = v === 'ok';
          return (
            <Col xs={12} md={6} key={it.key}>
              <Card size="small" style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 22, color: okState ? '#56d364' : '#9da7b3' }}>{it.icon}</div>
                <div style={{ marginTop: 6 }}>
                  <Text strong>{it.label}</Text>
                </div>
                <Badge
                  status={v ? (okState ? 'success' : 'error') : 'default'}
                  text={<Text className="code" type="secondary">{v ?? '未检查'}</Text>}
                />
              </Card>
            </Col>
          );
        })}
      </Row>
      <Button type="primary" loading={loading} disabled={done} onClick={onRun} style={{ marginTop: 16 }}>
        {done ? '健康检查已通过' : '运行健康检查'}
      </Button>
    </Card>
  );
}
