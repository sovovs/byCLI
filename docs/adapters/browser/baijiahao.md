# Baijiahao（百家号）

发布前必须先保存、重开核对平台草稿，向用户展示具体内容并获得明确确认；然后单独调用 `--mode submit --execute --user-confirmed`。准备阶段不得预先传入确认参数。详见[三平台发布确认流程](../../guide/publishing-confirmation.md)。

**Mode**: Browser · **Domains**: `baijiahao.baidu.com`、`haokan.baidu.com`

先在 Chrome 登录百家号并连接 [Browser Bridge](/guide/browser-bridge)。发布通过网页原生控件完成；统计通过当前账号的只读接口读取。图文和文章在后台均为 `news`，共用驱动。

公开视频检索使用好看视频原生搜索页，需要 Chrome 和 Browser Bridge，不要求百家号创作者后台登录。

## 命令

| 命令 | 用途 |
| --- | --- |
| `bycli baijiahao search <query>` | 通过好看视频原生入口搜索公开视频，返回可用于下载的正式链接 |
| `bycli baijiahao video-download <url> --output <dir>` | 下载百家号、mbd 分享页或好看分发页的公开视频，不限定本人账号 |
| `bycli baijiahao video-publish` | 视频上传、双封面、AI 声明、保存/核对草稿、单次提交和状态读取 |
| `bycli baijiahao video-stats <id>` | 本人已发布视频的播放、点赞、评论、收藏、分享 |
| `bycli baijiahao image-text-publish` | 图文发布，至少一张图片 |
| `bycli baijiahao image-text-stats <id>` | 图文阅读及四项互动指标 |
| `bycli baijiahao article-publish` | 文章发布，与图文共用 `news` 驱动 |
| `bycli baijiahao article-stats <id>` | 文章阅读、点赞、评论、收藏、分享 |

## 发布

```bash
mkdir -p ./operations
# 上传、保存并重开核对草稿，此步不公开提交。
bycli baijiahao video-publish --operation ./operations/video.json \
  --title '视频标题' --file /absolute/path/video.mp4 \
  --cover /absolute/path/horizontal.jpg --vertical-cover /absolute/path/vertical.jpg \
  --ai-generated yes --execute --timeout 300

# prepared 后，显式提交一次。
bycli baijiahao video-publish --operation ./operations/video.json --mode submit --user-confirmed --execute
# 只读取同一作品的远端状态，不重新点发布。
bycli baijiahao video-publish --operation ./operations/video.json --mode status -f json

# 正文不包含标题；图片按数组顺序追加到正文末尾。
bycli baijiahao image-text-publish --operation ./operations/news.json \
  --title '文章标题' --file /absolute/path/body.txt \
  --images '["/absolute/path/one.png","/absolute/path/two.png"]' \
  --cover /absolute/path/cover.png --ai-generated yes --execute
bycli baijiahao image-text-publish --operation ./operations/news.json --mode submit --user-confirmed --execute
bycli baijiahao article-publish --operation ./operations/news.json --mode status -f json
```

`--operation` 父目录须存在，后续始终使用同一记录。`--text` 可代替正文文件。视频标题 2–50 字，文章标题 2–64 字；正文最多 50000 字符，配图最多 20 张。正文为纯文本，不转换 Markdown/HTML 排版。AI 声明须按实际传 `yes` 或 `no`；图文准备时关闭“自动生成播客”。

| mode | 行为 |
| --- | --- |
| `prepare` | 新建操作、上传、填写、保存并重开核对；已有记录时直接保留 |
| `resume` | 在原独立浏览器会话继续中断阶段，不自动重传视频或重建未知草稿 |
| `reopen` | 按已保存的精确 ID 重开并核对未提交草稿 |
| `submit` | 核对账号、远端草稿和页面后提交一次；点击前持久化已尝试标记 |
| `status` | 按精确 ID 读取当前账号的管理状态，不提交；无需 `--execute` |

中断后用 `--mode resume --execute`，源文件 SHA-256 必须未变。保存回执未知时保留原页，在管理列表核对精确草稿 ID 后可用 `--mode resume --draft-id <id> --execute` 恢复；命令会再次核对原页面和远端草稿，不重按保存。两个 news 命令可处理同一操作，记录保留最初的 `contentKind`。

`prepared` 说明草稿已核对；`submitted: true` 说明已记录一次提交尝试。`status` 返回 `published` 才对应管理列表的正式 `publish` 状态；`analyze` 保留平台原始处理状态。遇到验证码或未知提交状态，人工完成验证后运行 `status`，不重按发布，也不删除记录重新提交。

记录使用独占锁、0600 权限和原子替换，绑定账号、精确 ID、源文件哈希及独立编辑会话。`editor` 返回当前阶段和 URL。图文重开核对正文、配图顺序和封面；完整静态图片的像素 SHA-256 须与本地素材相同，允许百家号改写图片代理 URL。动画等使用文件字节身份，不以首帧证明完整内容。

## 统计

```bash
bycli baijiahao video-stats 1879490486260090068 -f json
bycli baijiahao image-text-stats 1879490896848503110 -f json
bycli baijiahao article-stats 1879490896848503110 \
  --start-date 2026-10-19 --end-date 2026-10-19 -f json
```

`id` 是管理列表的精确作品 ID，`nid` 是内部内容 ID，均以字符串保留，不可混用。默认按作品发表日检索；显式日期须成对，最晚为上海今日。命令检查分页、作品类型和身份。草稿、找不到的作品或日期内无记录会报错，不补假 0。

真实 `0` 保留为数字；缺失指标为 `null`，并写入 `unavailableMetrics`。`observation` 包含检索日期、发表时间、采集时间和 `counterScope: "as_returned"`。累计/区间口径未独立证明，不能解释为某日新增或已结算值。

## 检索并下载

```bash
bycli baijiahao search '航天' --limit 15 --timeout 30 -f json
```

入口为 `https://haokan.baidu.com/web/search/page?query=...&tab=video`。检索的是好看视频公开分发的视频，包含百家号创作者发布到该平台的作品；不是百家号后台本人作品检索，也不覆盖全部百家号文章、草稿或未被好看视频收录的内容。命令不使用百度网页／视频搜索作为替代入口。

返回 `rank`、字符串 `id`、`title`、`author`、`duration`、`playsText`、`publishedAtText`、`url`、`source`。播放量和相对发布时间保留页面原文，不转换为精确统计或日期。只读取视频标签页中的原生结果卡片，排除广告和推荐区，并按视频 ID 去重。

`--limit` 为最多返回条数（1–50，默认 10）；超过首批结果时通过页面原生滚动加载。等待超时、导航错误或验证页会报错，不当作零结果。原生页面明确显示无结果时返回 `EMPTY_RESULT`，不据此证明平台索引没有命中。结果沿用平台排序，不保证全量或标题精确匹配。

将结果中的 `url` 原样传给下载命令即可。搜索返回不代表视频已验证可下载，播放权限和视频源仍由下载器检查：

```bash
# 此示例使用 jq 选择第一条搜索结果，仅在前面的步骤成功后下载。
bycli baijiahao search '科普' --limit 1 -f json > videos.json &&
video_url="$(jq -er '.[0].url' videos.json)" &&
bycli baijiahao video-download "$video_url" \
  --output ./downloads --timeout 60 -f json
```

也可以直接下载已有链接：

```bash
bycli baijiahao video-download \
  'https://mbd.baidu.com/newspage/data/videolanding?nid=sv_8719410024761431292' \
  --output ./downloads --timeout 60 -f json
```

接受正式 mbd `videolanding?nid=sv_...`、百家号 `/s?id=...` 和好看 `/v?vid=...`。页面须有唯一可播放视频及已加载的媒体元数据。草稿预览、多个不同视频源、私密/付费等受限内容不在支持范围。

复用 `downloadMedia`，检查媒体响应及 MP4 文件头，返回绝对路径、字节数、时长、分辨率和 SHA-256。下载的是平台转码版本。同名文件已存在时拒绝覆盖；暂存文件通过同文件系统硬链接原子落盘。

下载沿用 Node 的代理配置。Chrome 直连不等于 Node 直连；如本机网络需要，可仅为当前进程设置 `NO_PROXY=bdstatic.com no_proxy=bdstatic.com`，不改变系统或 Clash 配置。连接失败会报错，不能当作成功下载。

## 真实验收

2026-10-27：`baijiahao search '科普' --limit 3` 经好看视频原生页返回 3 条；`search '航天' --limit 15` 经原生滚动返回 15 条。将前者第一条链接 `https://haokan.baidu.com/v?vid=10637456184973686790` 交给现有 `video-download`，下载得到 2,555,902 字节 MP4；`ffprobe` 确认为 H.264/AAC、540×960、33.62 秒。这是样本链路验证，不代表所有检索结果均可下载。

2026-10-19：通过这些命令新发布视频 `1879490486260090068` 和 news `1879490896848503110`，均核对到正式 `publish` 状态。公开文章正文、两图及 AI 声明核对通过；新视频正式页下载经 `ffprobe` 确认为 H.264/AAC、1280×720、174.96 秒。

详见设计、实施与命令验收记录（本地实验记录，未随公开文档提供）。同一篇 news 覆盖图文和文章两组能力。
