// 失败态恢复卡 —— uipro UX 规范:错误要给清晰恢复路径(重试 + 帮助),不止报错。
import { ReloadOutlined } from '@ant-design/icons';
import { Button, Result, Space, Typography } from 'antd';
import type { RecorderError } from '@/types/recorder';

const { Paragraph, Text } = Typography;

/** 错误码 → 用户可执行的恢复建议 */
const RECOVERY_HINT: Record<string, string> = {
  page_lost: '页面租约已丢失。请重新绑定一个新会话再重试,录制不会自动切换标签页。',
  daemon_unavailable: 'byCLI daemon 不可用。请确认 daemon 已启动后重新开始。',
  extension_disconnected: 'Chrome 扩展已断开。请检查扩展连接后重新绑定会话。',
  verify_timeout: 'Verify 执行超时。可缩小数据量或检查 adapter 后重试。',
  invalid_state: '当前会话状态不允许该操作。请按流程顺序推进,或重置会话。',
  validation_failed: '输入校验未通过。请检查后重试。',
  responsible_use_required: '写入 adapter 前需先确认「负责任使用」声明。请确认后重试写入。',
};

interface Props {
  error: RecorderError;
  /** 是否为会话终止级错误(failed 态),决定按钮文案 */
  terminal: boolean;
  onRetry: () => void;
  onReset: () => void;
}

export default function ErrorRecovery({ error, terminal, onRetry, onReset }: Props) {
  const hint = error.hint ?? RECOVERY_HINT[error.code] ?? '请重试,或重置会话从头开始。';
  return (
    <Result
      status="error"
      title={error.message}
      subTitle={<Text className="code" type="secondary">{error.code}</Text>}
      extra={
        <Space direction="vertical" align="center" style={{ width: '100%' }}>
          <Paragraph type="secondary" style={{ maxWidth: 480, textAlign: 'center', lineHeight: 1.6 }}>
            {hint}
          </Paragraph>
          <Space>
            {!terminal && (
              <Button type="primary" icon={<ReloadOutlined />} onClick={onRetry}>
                重试
              </Button>
            )}
            <Button danger={terminal} type={terminal ? 'primary' : 'default'} icon={<ReloadOutlined />} onClick={onReset}>
              {terminal ? '重新绑定会话' : '重置会话'}
            </Button>
          </Space>
        </Space>
      }
    />
  );
}
