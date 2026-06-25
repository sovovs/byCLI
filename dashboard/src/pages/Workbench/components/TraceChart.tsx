// TraceChart —— Recharts 柱状图:capture entries 各请求耗时对比(降序、带数值标签)。
// Recharts 读不到 antd token,故在组件内用 theme.useToken() 取值传入(单一事实源)。
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Empty, theme } from 'antd';
import type { NetworkEntry } from '@/types/recorder';

interface Props {
  entries?: NetworkEntry[];
}

export default function TraceChart({ entries }: Props) {
  const { token } = theme.useToken();
  if (!entries?.length) return <Empty description="暂无 trace 数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;

  const data = entries
    .map((e) => ({ name: `${e.method} ${e.pathname}`, ms: e.timing?.durationMs ?? 0 }))
    .sort((a, b) => b.ms - a.ms);

  // 耗时 → 颜色:慢(>250ms)= warning 琥珀(瓶颈语义),其余 = 主色青。
  const barColor = (ms: number) => (ms > 250 ? token.colorWarning : token.colorPrimary);

  return (
    <ResponsiveContainer width="100%" height={Math.max(140, data.length * 44)}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 32, top: 8, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={token.colorBorder} horizontal={false} />
        <XAxis type="number" stroke={token.colorTextSecondary} fontSize={11} unit="ms" />
        <YAxis
          type="category"
          dataKey="name"
          width={150}
          stroke={token.colorTextSecondary}
          fontSize={11}
          tick={{ fontFamily: "'Fira Code', monospace" }}
        />
        <Tooltip
          cursor={{ fill: token.colorBgElevated }}
          contentStyle={{
            background: token.colorBgContainer,
            border: `1px solid ${token.colorBorder}`,
            borderRadius: token.borderRadius,
            fontSize: 12,
          }}
          labelStyle={{ color: token.colorText, fontFamily: "'Fira Code', monospace" }}
          formatter={(v) => [`${v} ms`, '耗时']}
        />
        <Bar dataKey="ms" radius={[0, 4, 4, 0]} label={{ position: 'right', fill: token.colorTextSecondary, fontSize: 11 }}>
          {data.map((d) => (
            <Cell key={d.name} fill={barColor(d.ms)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
