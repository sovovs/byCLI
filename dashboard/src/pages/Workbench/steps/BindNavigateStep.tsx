// Step 2 · 新建录制会话 —— 输入 URL,一键「新建录制会话」即自动绑定浏览器 + 导航打开录制页。
// 需要登录的站点走「先建会话 · 等待登录」分支:bind(await_login)→ 登录 → confirm-auth → 打开录制页面。
import { LinkOutlined, LoginOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Form, Input, Space, Switch, Tooltip, Typography } from 'antd';
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
  /** 一步合并:新建会话 + 自动导航打开录制页(无需先登录的默认路径)。 */
  onBindAndNavigate: (url: string) => void;
}

export default function BindNavigateStep({
  state,
  loading,
  onBind,
  onConfirmAuth,
  onNavigate,
  onBindAndNavigate,
}: Props) {
  const [url, setUrl] = useState('https://example.com/search');
  const [needLogin, setNeedLogin] = useState(false);
  const [injectFault, setInjectFault] = useState(false);

  const preBind = state === 'health_checked'; // 尚未建会话
  const awaitingLogin = state === 'awaiting_user_login'; // 已建会话,等用户登录
  // 已建会话、待打开录制页(登录确认后 / 已绑定但导航失败需重试)
  const readyToOpen = state === 'auth_confirmed' || state === 'session_bound';
  const navigated = state === 'page_ready';

  const applyFault = () => {
    mockFlags.injectPageLost = injectFault;
  };
  // 主路径:一键建会话 + 打开;登录路径:先 bind(await_login)。
  const handlePrimary = () => {
    if (!url.trim()) return;
    applyFault();
    if (needLogin) onBind('await_login');
    else onBindAndNavigate(url);
  };
  // 登录确认后 / 绑定但未导航:用已输入的 URL 打开录制页。
  const handleOpen = () => {
    applyFault();
    onNavigate(url);
  };

  return (
    <Card title="新建录制会话" variant="borderless">
      <Paragraph type="secondary" style={{ lineHeight: 1.6 }}>
        输入要录制的目标地址,点击「新建录制会话」即自动绑定浏览器并打开录制页面(建立 sessionId / page lease)。
        录制使用严格 page lease,页面丢失即 <code className="code">page_lost</code>,不会自动换标签页。
      </Paragraph>

      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Form layout="vertical">
          <Form.Item label="目标 URL" required htmlFor="target-url" style={{ marginBottom: 12 }}>
            <Input
              id="target-url"
              className="code"
              prefix={<LinkOutlined />}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/search"
              disabled={!preBind}
              onPressEnter={() => preBind && handlePrimary()}
            />
          </Form.Item>

          {preBind && (
            <>
              <Form.Item style={{ marginBottom: 8 }}>
                <Space>
                  <Switch checked={needLogin} onChange={setNeedLogin} />
                  <span>目标站点需要先登录(先建会话,登录后再打开录制页)</span>
                </Space>
              </Form.Item>
              <Form.Item style={{ marginBottom: 12 }}>
                <Space>
                  <Tooltip title="开启后导航将触发 page_lost,用于演示错误恢复路径">
                    <Switch checked={injectFault} onChange={setInjectFault} />
                  </Tooltip>
                  <span>
                    <ThunderboltOutlined style={{ color: '#f0a868' }} /> 模拟故障(page_lost)
                  </span>
                </Space>
              </Form.Item>
              <Button type="primary" loading={loading} disabled={!url.trim()} onClick={handlePrimary}>
                {needLogin ? '新建会话 · 等待登录' : '新建录制会话并打开'}
              </Button>
            </>
          )}
        </Form>

        {awaitingLogin && (
          <Alert
            type="info"
            showIcon
            message="等待用户登录"
            description="请在新打开的标签页完成登录,然后点击确认。Recorder 只绑定已有登录,不收集或回放凭据。"
            action={
              <Button size="small" type="primary" icon={<LoginOutlined />} loading={loading} onClick={onConfirmAuth}>
                确认已登录
              </Button>
            }
          />
        )}

        {readyToOpen && (
          <Button type="primary" loading={loading} onClick={handleOpen}>
            打开录制页面
          </Button>
        )}

        {navigated && <Alert type="success" showIcon message="页面已就绪(page_ready),可开始采集 A/B 样本。" />}
      </Space>
    </Card>
  );
}
