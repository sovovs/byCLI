// 录制工作台主框架 —— 全屏单页:标题 + 会话状态带、青色进度轨(StepRail)、当前 step 操作区。
// 失败态切 ErrorRecovery;完成态显示 Result。数据/状态机走 useRecorderSession model。
import { useModel } from '@umijs/max';
import { Result } from 'antd';
import { CheckCircleOutlined } from '@ant-design/icons';
import StepRail from './components/StepRail';
import StatePanel from './components/StatePanel';
import ErrorRecovery from './components/ErrorRecovery';
import HealthStep from './steps/HealthStep';
import BindNavigateStep from './steps/BindNavigateStep';
import CaptureStep from './steps/CaptureStep';
import RankStep from './steps/RankStep';
import InitStep from './steps/InitStep';
import VerifyStep from './steps/VerifyStep';
import { FLOW_STEPS, STATE_ORDER, isFailed } from '@/constants/recorder';

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
    <div className="wb">
      <div className="wb-shell">
        <header className="wb-head">
          <h1 className="wb-title">录制工作台</h1>
          <StatePanel state={state} stateVersion={stateVersion} sessionId={data.sessionId} targetUrl={data.targetUrl} />
        </header>

        <StepRail steps={FLOW_STEPS} current={currentStep} failed={failed} />

        <div className="wb-stage">
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
        </div>
      </div>
    </div>
  );
}
