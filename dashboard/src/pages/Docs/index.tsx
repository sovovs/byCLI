// 方案文档页 —— 左侧 11 模块分组导航树 + 右侧阅读区。
// 阅读型布局(对 MASTER.md 的 Data-Dense 做页面级覆盖):宽留白、限行宽 72ch、行高 1.6。
import { FileTextOutlined, FolderOutlined } from '@ant-design/icons';
import { Card, Col, Layout, Row, Tag, Tree, Typography } from 'antd';
import type { DataNode } from 'antd/es/tree';
import { useMemo, useState } from 'react';
import { DOC_GROUPS, DOC_MODULES, type DocModule } from './modules';

const { Sider, Content } = Layout;
const { Title, Paragraph, Text } = Typography;

export default function Docs() {
  const [selectedId, setSelectedId] = useState(DOC_MODULES[1].id); // 默认选「系统总览」

  const treeData: DataNode[] = useMemo(
    () =>
      DOC_GROUPS.map((group) => ({
        title: <Text strong>{group}</Text>,
        key: `group:${group}`,
        selectable: false,
        icon: <FolderOutlined />,
        children: DOC_MODULES.filter((m) => m.group === group).map((m) => ({
          title: (
            <span>
              <Tag className="code" style={{ marginInlineEnd: 6, fontSize: 11 }}>
                {m.no}
              </Tag>
              {m.title}
            </span>
          ),
          key: m.id,
          icon: <FileTextOutlined />,
        })),
      })),
    [],
  );

  const current: DocModule = DOC_MODULES.find((m) => m.id === selectedId) ?? DOC_MODULES[0];

  return (
    <Layout style={{ background: 'transparent' }}>
      <Sider width={280} theme="dark" style={{ background: '#161b22', borderRadius: 8, padding: '12px 4px', marginInlineEnd: 16 }}>
        <Title level={5} style={{ padding: '0 12px', marginTop: 0 }}>
          模块导航
        </Title>
        <Tree
          showIcon
          blockNode
          defaultExpandAll
          selectedKeys={[selectedId]}
          treeData={treeData}
          onSelect={(keys) => {
            const k = keys[0] as string;
            if (k && !k.startsWith('group:')) setSelectedId(k);
          }}
        />
      </Sider>

      <Content>
        {/* 阅读区:限制行宽提升可读性(line-length 65–75ch) */}
        <Card variant="borderless">
          <article style={{ maxWidth: '72ch', lineHeight: 1.7 }}>
            <Tag className="code" color="#2dd4bf">
              {current.no}
            </Tag>
            <Title level={3} style={{ marginTop: 8 }}>
              {current.title}
            </Title>
            <Paragraph style={{ fontSize: 15, color: '#9da7b3', lineHeight: 1.7 }}>{current.summary}</Paragraph>

            <Title level={5} style={{ marginTop: 24 }}>
              关键要点
            </Title>
            <ul style={{ lineHeight: 1.8, paddingInlineStart: 20 }}>
              {current.points.map((p, i) => (
                <li key={i} style={{ marginBottom: 6 }}>
                  {p}
                </li>
              ))}
            </ul>

            <Paragraph type="secondary" style={{ marginTop: 24, fontSize: 13 }}>
              完整正文见源文件:
              <Text className="code" copyable style={{ marginInlineStart: 6 }}>
                {current.srcPath}
              </Text>
            </Paragraph>
          </article>
        </Card>
      </Content>
    </Layout>
  );
}
