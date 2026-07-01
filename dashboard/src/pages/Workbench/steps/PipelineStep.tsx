// N5 · verify-then-save 结果页。从 ranked:点「AI 生成并验证脚本(发送痕迹)」→ 跑流水线 →
// 展示多脚本(评分依据 + verify rows/字段 + 可编辑源码)→ 勾选多个 → 底部统一保存 → 展示结果列表。
import { useEffect, useRef, useState } from 'react';
import { RobotOutlined, CheckCircleFilled, CloseCircleFilled, SaveOutlined, LoadingOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Checkbox, Collapse, Input, Space, Table, Tag, Typography, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { PipelineDraft, PipelinePrompts, RankCandidate, SavedAdapter } from '@/types/recorder';
import { candidateScoreDimensions } from '../components/candidateScore';

const { Paragraph, Text } = Typography;

interface Props {
  loading: boolean;
  drafts?: PipelineDraft[];
  rejected?: Array<{ candidateId: string; reason: string }>;
  prompts?: PipelinePrompts;
  /** rank 产出的全部候选(表格按分降序展示)。 */
  candidates?: RankCandidate[];
  /** 会被喂 LLM 的候选 id(进界面自动拉 preview 填充);默认勾选 top-N。 */
  sentCandidateIds?: string[];
  /** pipeline 异步轮询途中的阶段进度(score/generate/verify 耗时);运行中实时展示。 */
  pipelineProgress?: Array<{ stage: string; status: 'running' | 'done'; durationMs?: number; detail?: string }>;
  /** 本次录制 A/B 声明的搜索关键词(seed);表头展示,让用户对照每个候选 seed→参数命中情况。 */
  seedA?: string;
  seedB?: string;
  savedAdapters?: SavedAdapter[];
  /** 运行流水线;candidateIds=用户手选要传 LLM 的候选(空→be 按 cap 自动 top-N)。 */
  onRunPipeline: (candidateIds?: string[]) => void;
  /** 外发前预览将发送的提示词 + 拉取 sentCandidateIds(不外发)。 */
  onPreviewPrompts: () => void;
  /** 多选保存:把选中的(可能编辑过的)草稿一次性保存。 */
  onSaveMany: (drafts: Array<{ draftId: string; source: string }>) => void;
}

/** 从候选里推断 seed 是否命中参数:优先看 scoreExplanation 的 seed 信号,其次看 args 里 seed 派生的映射,
 *  再看 responseShape.echoesSeedArg。返回 {hit, label}——label 形如 "q / term"(命中的参数名)。 */
function seedHit(c: RankCandidate): { hit: boolean; label: string } {
  // be 真实信号:seed_arg_maps_to_param / response_echoes_seed;mock 信号:seed_echoed_in_query。
  const sig = (c.scoreExplanation ?? []).find((s) => /seed|echo/i.test(s.signal) && s.delta > 0);
  const seedArgs = (c.args ?? []).filter((a) => /seed|keyword|term|q\b/i.test(a.argName) || !!a.evidenceId);
  const params = seedArgs.map((a) => a.paramName).filter(Boolean);
  const hit = !!sig || params.length > 0 || c.responseShape?.echoesSeedArg === true;
  const label = params.length ? params.join(' / ') : sig ? sig.signal : c.responseShape?.echoesSeedArg ? '响应回显' : '—';
  return { hit, label };
}

/** 候选表格:按 rank 分降序列出每个候选接口 + 参数 + 分数(含来源) + seed→参数命中 + 手选传给 LLM。
 *  rowSelection 受控(selectedIds/onSelectChange);默认勾选 top-N(由父用 sentCandidateIds 初始化)。
 *  整体折叠 + 表格限高,避免长列表占屏。 */
function CandidateTable({ candidates, selectedIds, onSelectChange, seedA, seedB, locked }: {
  candidates: RankCandidate[];
  selectedIds: string[];
  onSelectChange?: (ids: string[]) => void;
  seedA?: string;
  seedB?: string;
  /** 运行后锁定选择(已发送,不可再改)。 */
  locked?: boolean;
}) {
  const { token } = theme.useToken();
  const rows = [...candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const seeds = [seedA, seedB].filter((s): s is string => !!s && !!s.trim());
  const columns: ColumnsType<RankCandidate> = [
    {
      title: '接口', key: 'endpoint',
      render: (_, c) => {
        const qp = c.endpoint?.queryParams ? Object.entries(c.endpoint.queryParams) : [];
        const dyn = c.endpoint?.dynamicParams ?? [];
        const mergedCount = c.mergedRequestIds?.length ?? 0;
        const params = c.paramObservations ?? [];
        return (
          <div>
            <Text className="code" style={{ fontSize: 12 }} ellipsis={{ tooltip: `${c.endpoint?.method} ${c.endpoint?.pathname || c.endpoint?.urlTemplate || ''}` }}>
              <Tag style={{ marginInlineEnd: 4 }}>{c.endpoint?.method}</Tag>{c.endpoint?.pathname || c.endpoint?.urlTemplate || '—'}
            </Text>
            {mergedCount > 1 && (
              <Tag color={token.colorInfo} style={{ marginInlineStart: 4, fontSize: 10 }} title="同一接口被多次调用,已按 endpoint 聚拢,参数取并集">
                聚合 {mergedCount} 次调用
              </Tag>
            )}
            {(qp.length > 0 || dyn.length > 0) && (
              <div style={{ marginTop: 4 }}>
                <Space size={[4, 4]} wrap>
                  {qp.map(([k, v]) => (
                    <Tag key={k} className="code" style={{ fontSize: 11 }}>
                      {k}={String(v).length > 20 ? String(v).slice(0, 20) + '…' : String(v)}
                    </Tag>
                  ))}
                  {dyn.map((p) => (
                    <Tag key={p} className="code" style={{ fontSize: 11 }} title="动态参数(时间戳/缓存破坏等,已排除出稳定 endpoint)">{p}</Tag>
                  ))}
                </Space>
              </div>
            )}
            {params.length > 0 && (
              <div style={{ marginTop: 4 }}>
                <Space size={[4, 4]} wrap>
                  {params.map((p) => {
                    const tags: string[] = [];
                    if (p.dynamicLike) tags.push('动态');
                    if (p.cursorLike) tags.push('翻页');
                    if (p.observedVariation === true) tags.push('变');
                    const suffix = tags.length ? ` (${tags.join('/')})` : '';
                    return (
                      <Tag key={`${p.in}:${p.name}`} className="code" style={{ fontSize: 10 }} title={`并集参数 · ${p.in} · 出现 ${p.observedCount}/${p.totalCalls} 次`}>
                        {p.name}{suffix}
                      </Tag>
                    );
                  })}
                </Space>
              </div>
            )}
          </div>
        );
      },
    },
    {
      title: 'Rank 置信', key: 'score', width: 170,
      render: (_, c) => {
        const { rank, utility } = candidateScoreDimensions(c);
        return (
          <Space direction="vertical" size={2}>
            <Space size={4} wrap>
              <Text strong>{rank.score}</Text>
              <Tag color={rank.band === 'high' ? 'success' : rank.band === 'medium' ? token.colorPrimary : 'default'}>{rank.band}</Tag>
              <Tag color={c.scoredBy === 'llm' ? token.colorPrimary : undefined} style={{ fontSize: 10 }} title={c.scoredBy === 'llm' ? 'LLM 评分(模型判定信号成立性,录制阶段证据置信,非 verify 结果)' : '规则评分(LLM 不可用时的启发式兜底,非 verify 结果)'}>
                {c.scoredBy === 'llm' ? 'LLM' : '规则'}
              </Tag>
            </Space>
            {/* LLM 效用:模型自报「做成数据命令是否有用」的语义判断,仅供参考(可选)。 */}
            {utility && (
              <Text type="secondary" style={{ fontSize: 11 }} title="模型对『做成数据命令是否有用』的语义判断,仅供参考">
                LLM 效用 {utility.score} · {utility.band}
              </Text>
            )}
          </Space>
        );
      },
    },
    {
      title: 'seed→参数', key: 'seed', width: 120,
      render: (_, c) => {
        const { hit, label } = seedHit(c);
        return hit
          ? <Tag color={token.colorPrimary} title={`本次录制关键词映射到参数:${label}`} className="code" style={{ fontSize: 12 }}>{label}</Tag>
          : <Text type="secondary" style={{ fontSize: 12 }} title="未检测到录制关键词映射到该接口参数(无参数据接口或未命中)">未命中</Text>;
      },
    },
  ];
  const rowSelection = locked ? undefined : {
    selectedRowKeys: selectedIds,
    onChange: (keys: React.Key[]) => onSelectChange?.(keys.map(String)),
    getCheckboxProps: (c: RankCandidate) => ({ name: c.id }),
  };
  const table = (
    <Table
      size="small" rowKey="id" dataSource={rows} columns={columns} pagination={false}
      rowSelection={rowSelection}
      scroll={{ y: 320 }}
      title={() => (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {locked
            ? '候选接口(已勾选的传给 LLM)'
            : '勾选要交给 LLM 评审/生成的接口(默认按评分选前若干;勾越多越慢)'}
          {seeds.length ? <> · 本次录制关键词:{seeds.map((s) => <Tag key={s} className="code" style={{ fontSize: 12, marginInlineStart: 4 }}>{s}</Tag>)}</> : null}
        </Text>
      )}
    />
  );
  return (
    <Collapse
      size="small"
      defaultActiveKey={['cands']}
      style={{ marginBottom: 12 }}
      items={[{
        key: 'cands',
        label: `候选接口(${rows.length} 个${locked ? '' : `,已选 ${selectedIds.length}`})`,
        children: table,
      }]}
    />
  );
}

/** 透明展示:把本轮真正发给 LLM 的提示词(score + generate)折叠展示,截图仅标注张数。 */
function PromptPanel({ prompts }: { prompts: PipelinePrompts }) {
  const shotNote = prompts.screenshotCount > 0 ? `(另附 ${prompts.screenshotCount} 张页面截图,图片不在文本内)` : '(无截图)';
  const items = [
    {
      key: 'prompts',
      label: `查看发给 AI 的提示词 ${shotNote}`,
      children: (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>评分(score)提示词:</Text>
            <Input.TextArea className="code" value={prompts.score} readOnly autoSize={{ minRows: 4, maxRows: 14 }} style={{ fontSize: 12, marginTop: 4 }} />
          </div>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>生成脚本(generate)提示词{prompts.generate ? '' : '(依赖评分结果,运行后展示)'}:</Text>
            <Input.TextArea className="code" value={prompts.generate || '(运行后展示)'} readOnly autoSize={{ minRows: 4, maxRows: 14 }} style={{ fontSize: 12, marginTop: 4 }} />
          </div>
        </Space>
      ),
    },
  ];
  return <Collapse size="small" items={items} style={{ marginBottom: 12 }} />;
}

/** pipeline 阶段进度:运行中实时展示 score/generate/verify 各阶段是否结束 + 耗时。 */
const STAGE_LABEL: Record<string, string> = { score: 'LLM 评分接口', generate: '生成 cli 脚本', verify: '验证脚本(verify)' };
function ProgressPanel({ phases, loading }: { phases?: Array<{ stage: string; status: 'running' | 'done'; durationMs?: number; detail?: string }>; loading: boolean }) {
  const { token } = theme.useToken();
  if (!phases?.length && !loading) return null;
  const list = phases ?? [];
  return (
    <Card size="small" style={{ marginBottom: 12 }} title={<Text strong style={{ fontSize: 13 }}>生成进度</Text>}>
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        {list.map((p) => (
          <div key={p.stage} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            {p.status === 'done'
              ? <CheckCircleFilled style={{ color: token.colorSuccess }} />
              : <LoadingOutlined style={{ color: token.colorPrimary }} />}
            <Text>{STAGE_LABEL[p.stage] ?? p.stage}</Text>
            {p.detail ? <Text type="secondary" style={{ fontSize: 12 }}>{p.detail}</Text> : null}
            <span style={{ flex: 1 }} />
            {p.status === 'done' && p.durationMs != null
              ? <Text type="secondary" className="code" style={{ fontSize: 12 }}>{(p.durationMs / 1000).toFixed(1)}s</Text>
              : <Text type="secondary" style={{ fontSize: 12 }}>进行中…</Text>}
          </div>
        ))}
        {loading && !list.some((p) => p.status === 'running') && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <LoadingOutlined style={{ color: token.colorPrimary }} /><Text type="secondary">准备中…</Text>
          </div>
        )}
      </Space>
    </Card>
  );
}

function DraftCard({
  draft, checked, onToggle, source, onSourceChange,
}: {
  draft: PipelineDraft;
  checked: boolean;
  onToggle: (next: boolean) => void;
  source: string;
  onSourceChange: (src: string) => void;
}) {
  const { token } = theme.useToken();
  const v = draft.verify;
  return (
    <Card
      size="small"
      style={{ marginBottom: 12, borderColor: checked ? token.colorPrimary : undefined }}
      title={
        <Space wrap>
          <Checkbox checked={checked} onChange={(e) => onToggle(e.target.checked)}>
            <Text strong className="code">{draft.site}/{draft.name}</Text>
          </Checkbox>
          <Tag color={draft.confidence === 'high' ? 'success' : draft.confidence === 'medium' ? token.colorPrimary : 'default'} title="Rank 置信(录制阶段评分,非 verify 结果)">
            Rank {draft.score} · {draft.confidence}
          </Tag>
          {draft.usable ? (
            <Tag icon={<CheckCircleFilled />} color="success" title="Verify 状态(脚本实跑结果)">Verify ✓ {v.rows} 行 / {v.fieldCount} 字段</Tag>
          ) : (
            <Tag icon={<CloseCircleFilled />} color={token.colorWarning} title="Verify 状态(脚本实跑结果)">Verify 未通过</Tag>
          )}
        </Space>
      }
    >
      {!!draft.reason && <Paragraph type="secondary" style={{ marginBottom: 6 }}>{draft.reason}</Paragraph>}
      {!draft.usable && (
        <Alert
          type="warning" showIcon style={{ marginBottom: 8 }}
          message="未通过(静态检查或 verify 不达标),仍可勾选保存,但建议修改后再存"
          description={[...draft.staticViolations, ...v.reasons].join(';') || undefined}
        />
      )}
      {!!draft.risks.length && <Alert type="info" showIcon style={{ marginBottom: 8 }} message={`风险:${draft.risks.join(';')}`} />}
      <Text type="secondary" style={{ fontSize: 12 }}>adapter 源码(可编辑后保存):</Text>
      <Input.TextArea
        className="code"
        value={source}
        onChange={(e) => onSourceChange(e.target.value)}
        autoSize={{ minRows: 6, maxRows: 18 }}
        style={{ fontSize: 12, marginTop: 4 }}
      />
    </Card>
  );
}

export default function PipelineStep({ loading, drafts, rejected, prompts, candidates, sentCandidateIds, pipelineProgress, seedA, seedB, savedAdapters, onRunPipeline, onPreviewPrompts, onSaveMany }: Props) {
  const has = !!drafts;
  // 每个草稿的选中态 + (可能编辑过的)源码,按 draft.id 索引。
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [sources, setSources] = useState<Record<string, string>>({});
  // 手选要传 LLM 的候选;默认 = be preview 算出的 top-N(sentCandidateIds)。用户可勾改。
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const selectionInit = useRef(false);

  // 进界面自动拉一次 preview(只读、不外发):填充候选表格的默认勾选(top-N) + 提示词面板。
  // 仅在尚未拉过(sentCandidateIds 未定义)且尚未运行(无 drafts)时触发,避免重复请求。
  useEffect(() => {
    if (sentCandidateIds === undefined && !has) onPreviewPrompts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // preview 回来后,用 be 的 top-N 初始化默认勾选(仅一次,之后尊重用户改动)。
  useEffect(() => {
    if (!selectionInit.current && sentCandidateIds && sentCandidateIds.length) {
      setSelectedCandidateIds(sentCandidateIds);
      selectionInit.current = true;
    }
  }, [sentCandidateIds]);

  const selectedIds = (drafts ?? []).filter((d) => checked[d.id]).map((d) => d.id);
  const selectedUnusable = (drafts ?? []).filter((d) => checked[d.id] && !d.usable).length;

  const handleSave = () => {
    const items = (drafts ?? [])
      .filter((d) => checked[d.id])
      .map((d) => ({ draftId: d.id, source: sources[d.id] ?? d.source }));
    if (items.length) onSaveMany(items);
  };

  return (
    <Card title="AI 生成并验证 adapter 脚本" variant="borderless">
      <Paragraph type="secondary" style={{ lineHeight: 1.7 }}>
        把 A/B 录制痕迹交给 LLM 评审 → 自动评分、为高分接口生成完整 cli 脚本 → 各自 verify → 下方展示脚本,
        勾选你要的(可编辑源码),底部统一保存。<strong>无需手动选候选</strong>。
      </Paragraph>

      {savedAdapters?.length ? (
        <Alert
          type="success"
          showIcon
          message={`已保存 ${savedAdapters.length} 个脚本到 ~/.bycli/clis/`}
          description={
            <Space direction="vertical" size={2} style={{ width: '100%' }}>
              {savedAdapters.map((a) => (
                <Text key={a.adapterPath ?? `${a.site}/${a.name}`} className="code" style={{ fontSize: 12 }}>
                  <Tag color="success" style={{ marginInlineEnd: 6 }}>{a.site}/{a.name}</Tag>
                  {a.adapterPath}
                </Text>
              ))}
            </Space>
          }
        />
      ) : !has ? (
        <>
          <Alert
            type="warning"
            showIcon
            icon={<RobotOutlined />}
            message="将把录制痕迹(截图 + 真实请求/响应)发送给模型分析"
            description="点击「发送痕迹」后由 LLM 评分 + 生成 + 验证脚本;数据可能含登录态站点信息,仅在你接受该外发时继续。发送前可先「预览将发送的提示词」。"
            action={
              <Space direction="vertical">
                <Button danger type="primary" icon={<RobotOutlined />} loading={loading} disabled={!selectedCandidateIds.length} onClick={() => onRunPipeline(selectedCandidateIds)}>
                  AI 生成并验证(发送 {selectedCandidateIds.length} 个接口)
                </Button>
                <Button size="small" loading={loading} onClick={onPreviewPrompts}>预览将发送的提示词</Button>
              </Space>
            }
          />
          {!!candidates?.length && <div style={{ marginTop: 12 }}><CandidateTable candidates={candidates} selectedIds={selectedCandidateIds} onSelectChange={setSelectedCandidateIds} seedA={seedA} seedB={seedB} /></div>}
          {(loading || !!pipelineProgress?.length) && <div style={{ marginTop: 12 }}><ProgressPanel phases={pipelineProgress} loading={loading} /></div>}
          {prompts && <div style={{ marginTop: 12 }}><PromptPanel prompts={prompts} /></div>}
        </>
      ) : (
        <>
          {!!candidates?.length && <CandidateTable candidates={candidates} selectedIds={selectedCandidateIds} seedA={seedA} seedB={seedB} locked />}
          {!!pipelineProgress?.length && <ProgressPanel phases={pipelineProgress} loading={false} />}
          {prompts && <PromptPanel prompts={prompts} />}
          {!drafts!.length && <Alert type="warning" showIcon message="LLM 未产出可用脚本" description="可返回重录或检查候选。" />}
          {drafts!.map((d) => (
            <DraftCard
              key={d.id}
              draft={d}
              checked={!!checked[d.id]}
              onToggle={(next) => setChecked((c) => ({ ...c, [d.id]: next }))}
              source={sources[d.id] ?? d.source}
              onSourceChange={(src) => setSources((s) => ({ ...s, [d.id]: src }))}
            />
          ))}
          {!!rejected?.length && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              已排除 {rejected.length} 个候选:{rejected.map((r) => `${r.candidateId}(${r.reason})`).join('、')}
            </Text>
          )}
          {/* 底部固定操作条:已选数量 + 统一保存 */}
          {!!drafts!.length && (
            <div
              style={{
                position: 'sticky', bottom: 0, marginTop: 12, padding: '12px 0',
                display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                borderTop: `1px solid ${theme.useToken().token.colorBorderSecondary}`,
                background: theme.useToken().token.colorBgContainer,
              }}
            >
              <Text>已选 <Text strong>{selectedIds.length}</Text> 个脚本</Text>
              {selectedUnusable > 0 && (
                <Text type="warning" style={{ fontSize: 12 }}>(含 {selectedUnusable} 个未通过脚本)</Text>
              )}
              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={loading}
                disabled={!selectedIds.length}
                onClick={handleSave}
              >
                保存选中的 {selectedIds.length} 个脚本到 ~/.bycli/clis/
              </Button>
              <Button size="small" loading={loading} onClick={() => onRunPipeline(selectedCandidateIds.length ? selectedCandidateIds : undefined)}>重新生成</Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
