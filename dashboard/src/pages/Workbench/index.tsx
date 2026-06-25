// 录制工作台主框架 —— 左 Steps 进度 + FlowGraph,中 当前 step 操作区,右 StatePanel。
// 失败态切 ErrorRecovery;完成态显示 Result。数据/状态机走 useRecorderSession model。
import { useModel } from '@umijs/max';
import { Card, Col, Result, Row, Steps, Typography } from 'antd';
import { CheckCircleOutlined } from '@ant-design/icons';
import FlowGraph from './components/FlowGraph';
import StatePanel from './components/StatePanel';
import ErrorRecovery from './components/ErrorRecovery';
import HealthStep from './steps/HealthStep';
import BindNavigateStep from './steps/BindNavigateStep';
import CaptureStep from './steps/CaptureStep';
import RankStep from './steps/RankStep';
import InitStep from './steps/InitStep';
import VerifyStep from './steps/VerifyStep';
import { FLOW_STEPS, STATE_ORDER, isFailed } from '@/constants/recorder';

const { Title, Paragraph } = Typography;

export default function Workbench() {
  const { state, stateVersion, data, loading, error, actions } = useModel('useRecorderSession');

  const order = STATE_ORDER[state];
  const failed = isFailed(state);
  // 当前活动 step 序号(0-based);done 时全部完成
  const currentStep = state === 'done' ? FLOW_STEPS.length : Math.max(0, order);
  const selectedCandidate = data.candidates?.find((c) => c.id === data.selectedCandidateId);

  const renderActiveStep = () => {
    switch (state) {
      case 'idle':
        return <HealthStep health={data.health} loading={loading} done={false} onRun={actions.health} />;
      case 'health_checked':
      case 'awaiting_user_login':
      case 'auth_confirmed':
        return (
          <BindNavigateStep
            state={state}
            loading={loading}
            onBind={actions.bind}
            onConfirmAuth={actions.confirmAuth}
            onNavigate={actions.navigate}
            onBindAndNavigate={actions.bindAndNavigate}
          />
        );
      case 'session_bound':
      case 'page_ready':
        // page_ready 时若尚未采集,进入 capture;否则展示绑定/导航完成态
        if (state === 'page_ready' && !data.sampleA) {
          return (
            <CaptureStep
              state={state}
              loading={loading}
              sampleA={data.sampleA}
              sampleB={data.sampleB}
              onCaptureA={actions.captureA}
              onCaptureB={actions.captureB}
            />
          );
        }
        return (
          <BindNavigateStep
            state={state}
            loading={loading}
            onBind={actions.bind}
            onConfirmAuth={actions.confirmAuth}
            onNavigate={actions.navigate}
            onBindAndNavigate={actions.bindAndNavigate}
          />
        );
      case 'capture_a':
      case 'capture_b':
        return (
          <CaptureStep
            state={state}
            loading={loading}
            sampleA={data.sampleA}
            sampleB={data.sampleB}
            onCaptureA={actions.captureA}
            onCaptureB={actions.captureB}
          />
        );
      case 'ranked':
        // rank 候选选择 + init(dry-run 预览 → 责任声明 → 写入)同屏:init 动作自 ranked 触发,
        // write 才推进 ranked→draft_created(修正旧 off-by-one:init 触发口曾错落在 draft_created)。
        return (
          <>
            <RankStep
              loading={loading}
              candidates={data.candidates}
              selectedId={data.selectedCandidateId}
              sampleA={data.sampleA}
              onRank={actions.rank}
              onSelect={actions.selectCandidate}
            />
            <div style={{ marginTop: 16 }}>
              <InitStep
                loading={loading}
                selectedCandidate={selectedCandidate}
                adapterName={data.adapterName}
                preview={data.draftPreview}
                onPreview={actions.previewInit}
                onWrite={actions.writeInit}
              />
            </div>
          </>
        );
      case 'draft_created':
      case 'verifying':
        // 草稿已写入 → 在此触发 verify(draft_created→verifying);verifying/结果同屏展示。
        return <VerifyStep loading={loading} draft={data.draft} result={data.verifyResult} onVerify={actions.verify} />;
      default:
        return null;
    }
  };

  // 当处于 capture_b 但还没排序时,需要一个「执行排序」入口 → 进 RankStep
  const renderByStage = () => {
    if (failed && error) {
      return <ErrorRecovery error={error} terminal onRetry={actions.reset} onReset={actions.reset} />;
    }
    if (state === 'done') {
      return (
        <Result
          status="success"
          icon={<CheckCircleOutlined />}
          title="录制完成"
          subTitle="adapter 草稿已生成并通过 verify。raw capture 与临时文件已清理,仅保留脱敏报告。"
        />
      );
    }
    // capture_b → 进入排序步骤
    if (state === 'capture_b') {
      return (
        <RankStep
          loading={loading}
          candidates={data.candidates}
          selectedId={data.selectedCandidateId}
          sampleA={data.sampleA}
          onRank={actions.rank}
          onSelect={actions.selectCandidate}
        />
      );
    }
    return renderActiveStep();
  };

  // 非终止错误(如 invalid_state / validation_failed)就地提示,不替换整个操作区
  const inlineError = error && !failed ? error : null;

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }}>
      <Title level={2} style={{ marginBottom: 4 }}>录制工作台</Title>
      <Paragraph type="secondary" style={{ marginBottom: 16 }}>
        按 8 步状态机录制并生成 adapter:健康检查 → 绑定 → 导航 → 采集 A/B → 排序 → 草稿 → Verify。
      </Paragraph>

      <Card size="small" style={{ marginBottom: 16 }}>
        <FlowGraph state={state} />
      </Card>

      <Row gutter={16}>
        <Col xs={24} lg={18}>
          <Steps
            size="small"
            current={currentStep}
            status={failed ? 'error' : undefined}
            items={FLOW_STEPS.map((s) => ({ title: s.title }))}
            style={{ marginBottom: 16 }}
          />
          {inlineError && (
            <ErrorRecovery
              error={inlineError}
              terminal={false}
              onRetry={() => {
                // 非终止错误:清错由下一次动作触发,这里仅提供重置兜底
              }}
              onReset={actions.reset}
            />
          )}
          {renderByStage()}
        </Col>
        <Col xs={24} lg={6}>
          <StatePanel state={state} stateVersion={stateVersion} sessionId={data.sessionId} targetUrl={data.targetUrl} />
        </Col>
      </Row>
    </div>
  );
}
