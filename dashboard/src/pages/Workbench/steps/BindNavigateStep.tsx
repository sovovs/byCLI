// Step 2 · 绑定会话 + 导航/登录 —— bind(已登录 / 待登录两模式)→ confirm-auth → navigate
import { LinkOutlined, LoginOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Form, Input, Radio, Space, Switch, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { mockFlags } from '@/services/mockRecorder';
import type { SessionState } from '@/types/recorder';

const { Paragraph } = Typography;

interface Props {
  state: SessionState;
  loading: boolean;
  onBind: (mode: 'existing' | 'await_login') => void;
  onConfirmAuth: () => void;
  onNavigate: (url: string) => void;
}

export default function BindNavigateStep({ state, loading, onBind, onConfirmAuth, onNavigate }: Props) {
  const [url, setUrl] = useState('https://example.com/search');
  const [injectFault, setInjectFault] = useState(false);
  const [bindMode, setBindMode] = useState<'existing' | 'await_login'>('existing');

  const awaitingLogin = state === 'awaiting_user_login';
  // 已可导航的状态:已登录绑定 / 登录确认完成 / 已在 page_ready
  const bound = state === 'session_bound' || state === 'auth_confirmed' || state === 'page_ready';
  const navigated = state === 'page_ready';
  // 尚未发起绑定(仍在 health_checked)
  const preBind = state === 'health_checked';

  const handleNavigate = () => {
    mockFlags.injectPageLost = injectFault;
    onNavigate(url);
  };

  return (
    <Card title="绑定会话与导航" variant="borderless">
      <Paragraph type="secondary" style={{ lineHeight: 1.6 }}>
        绑定一个带登录态的浏览器标签页(建立 sessionId / contextId / targetId 租约),然后导航到要录制的目标地址。
        录制使用严格 page lease,页面丢失即 <code className="code">page_lost</code>,不会自动换标签页。
      </Paragraph>

      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Radio.Group
          value={bindMode}
          onChange={(e) => setBindMode(e.target.value)}
          disabled={!preBind}
          options={[
            { label: '绑定已登录标签页', value: 'existing' },
            { label: '新建页面 · 等待登录', value: 'await_login' },
          ]}
          optionType="button"
        />

        <Button
          type={preBind ? 'primary' : 'default'}
          loading={loading && preBind}
          disabled={!preBind}
          onClick={() => onBind(bindMode)}
        >
          {preBind ? '绑定标签页' : '会话已绑定'}
        </Button>

        {awaitingLogin && (
          <Alert
            type="info"
            showIcon
            message="等待用户登录"
            description="请在目标标签页完成登录,然后点击下方按钮确认登录态。Recorder 只绑定已有登录,不收集或回放凭据。"
            action={
              <Button
                size="small"
                type="primary"
                icon={<LoginOutlined />}
                loading={loading}
                onClick={onConfirmAuth}
              >
                确认已登录
              </Button>
            }
          />
        )}

        <Form layout="vertical" disabled={!bound || navigated}>
          <Form.Item label="目标 URL" required htmlFor="target-url" style={{ marginBottom: 12 }}>
            <Input
              id="target-url"
              className="code"
              prefix={<LinkOutlined />}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/search"
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 12 }}>
            <Space>
              <Tooltip title="开启后导航将触发 page_lost,用于演示错误恢复路径">
                <Switch checked={injectFault} onChange={setInjectFault} disabled={navigated} />
              </Tooltip>
              <span>
                <ThunderboltOutlined style={{ color: '#f0a868' }} /> 模拟故障(page_lost)
              </span>
            </Space>
          </Form.Item>
          <Button type="primary" loading={loading && bound && !navigated} disabled={!bound || navigated} onClick={handleNavigate}>
            {navigated ? '已导航,页面就绪' : '导航到目标页'}
          </Button>
        </Form>

        {navigated && <Alert type="success" showIcon message="页面已就绪(page_ready),可开始采集 A/B 样本。" />}
      </Space>
    </Card>
  );
}
