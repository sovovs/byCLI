// TraceChart —— Recharts 柱状图:capture entries 各请求耗时对比(降序、带数值标签)。
// MASTER.md:趋势/对比用 Recharts,主色 #58a6ff;复杂图配数据表(此处条目同时在 CaptureStep 表格中)。
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Empty } from 'antd';
import type { NetworkEntry } from '@/types/recorder';

interface Props {
  entries?: NetworkEntry[];
}

/** 耗时 → 颜色:快=info 蓝,慢(>250ms)=warning 琥珀(瓶颈语义) */
const barColor = (ms: number) => (ms > 250 ? '#f0a868' : '#58a6ff');

export default function TraceChart({ entries }: Props) {
  if (!entries?.length) return <Empty description="暂无 trace 数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;

  const data = entries
    .map((e) => ({ name: `${e.method} ${e.pathname}`, ms: e.timing?.durationMs ?? 0 }))
    .sort((a, b) => b.ms - a.ms);

  return (
    <ResponsiveContainer width="100%" height={Math.max(140, data.length * 44)}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 32, top: 8, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2d3744" horizontal={false} />
        <XAxis type="number" stroke="#9da7b3" fontSize={11} unit="ms" />
        <YAxis
          type="category"
          dataKey="name"
          width={150}
          stroke="#9da7b3"
          fontSize={11}
          tick={{ fontFamily: "'Fira Code', monospace" }}
        />
        <Tooltip
          cursor={{ fill: '#1c2330' }}
          contentStyle={{ background: '#161b22', border: '1px solid #2d3744', borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: '#e6edf3', fontFamily: "'Fira Code', monospace" }}
          formatter={(v) => [`${v} ms`, '耗时']}
        />
        <Bar dataKey="ms" radius={[0, 4, 4, 0]} label={{ position: 'right', fill: '#9da7b3', fontSize: 11 }}>
          {data.map((d) => (
            <Cell key={d.name} fill={barColor(d.ms)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
