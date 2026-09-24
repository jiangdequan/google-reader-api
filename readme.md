# googlereaderapi

基于 Cloudflare Workers 的自建 **Google Reader API** 后端服务。任何支持自建 Google Reader API 的客户端都可以接入，例如 **Reeder、Fiery Feeds、FeedMe、NewsFlash、FreshRSS 兼容客户端** 等。

- 存储：Cloudflare **D1**（SQLite）
- 定时抓取：Cloudflare **Cron Triggers**
- 支持 RSS 2.0 / Atom / RSS 1.0（RDF）/ JSON Feed，自动识别网页里的 `<link rel="alternate">`
- 认证：HTTP Basic、ClientLogin Token、`GoogleLogin auth=`、`?auth=` / `?T=`
- 运行时零第三方依赖，代码自包含

## 目录结构

```
.
├── index.js            # Worker 入口 + 路由 + CRON 处理
├── auth.js             # ClientLogin / Token / Basic 认证
├── constants.js        # 集中常量（超时 / 上限 / 默认密钥）
├── feedfetch.js        # 抓取 + 网页 feed 自动发现
├── feedparser.js       # RSS/Atom/RDF/JSON Feed 解析
├── xml.js              # 轻量 XML 解析器（无依赖）
├── opml.js             # OPML 导入/导出
├── streamid.js         # Reader 流 ID 语法：解析 / 序列化
├── sync.js             # 定时/手动抓取同步
├── util.js             # 工具函数
├── api/                # API 端点实现（streams / subscriptions / tags / ...）
├── db/                 # D1 数据访问 + 建表
├── test/               # node:test 单元测试（npm test）
├── schema.sql          # D1 表结构（可选，Worker 会自动建表）
├── wrangler.sample.toml# 配置样例（占位 database_id）
├── wrangler.toml       # 实际配置（本地从 sample 复制，已 gitignore）
├── package.json        # 脚本与 devDependencies（wrangler / prettier）
└── readme.md
```

## 快速开始（本地）

```bash
# 0. 首次先装依赖（Node ≥ 18），并生成本地配置
npm install
cp wrangler.sample.toml wrangler.toml   # 若尚未存在，按需修改 database_id / GR_USERS

# 1. 启动本地服务（--env staging，使用本地 D1，自动建表、自动创建默认用户）
npm run start:gr
# 也可: npx wrangler dev --env staging

# 2. 浏览器/curl 访问（wrangler 默认监听本地 8787 端口）
curl "http://localhost:8787/reader/api/0/user-info?output=json" -u admin:changeme123
```

本地默认账号：`admin` / `changeme123`（`wrangler.sample.toml` 的 `[env.staging.vars].GR_USERS` 中的配置，可按需在本地 `wrangler.toml` 修改）。

> 本地 D1 数据持久化在 `.wrangler/` 下（已 gitignore）。wrangler 按配置内容生成持久化目录，**修改 `wrangler.toml` 或切换 `--env` 会导致本地数据库重置**，属正常现象，重新订阅即可。

### 本地手动执行建表 / 查看本地数据

```bash
npm run d1:gr                        # 执行 schema.sql（本地 D1）
npx wrangler d1 execute googlereaderapi-db --command "SELECT 1"
```

## 部署到生产

### 0. 准备本地配置

```bash
cp wrangler.sample.toml wrangler.toml
wrangler login       # 或设置 CLOUDFLARE_API_TOKEN 环境变量
```

### 1. 创建 D1 数据库

```bash
npx wrangler d1 create googlereaderapi-db
```

把输出中的 `database_id` 填入 `wrangler.toml`（即 `wrangler.sample.toml` 中占位符 `00000000-0000-0000-0000-000000000000` 所在的位置）。

### 2. 修改配置

在 `wrangler.toml` 的 `[env.production]` 中修改：

```toml
[env.production.vars]
GR_USERS = "你的用户名:你的强密码"      # 多个用户用英文逗号分隔
JWT_SECRET = "一段足够长的随机字符串"    # 用于签发登录 token
```

`[env.production]` 下的 `d1_databases` 中的 `id` 也会在你创建资源后自动填入占位值，部署前确认它们是生产环境的真实资源 id。

### 3. 部署

```bash
npm run deploy:gr
# 也可: npx wrangler deploy --env production
```

首次请求会自动建表；也可以用 `npm run d1:gr:remote` 手动对生产 D1 执行 `schema.sql`。

## 在客户端接入

以 **Reeder** 为例（其他客户端类似）：

1. 添加账号 → 选择 **Google Reader API** / **FreshRSS** / **自建服务**
2. 服务器地址：`https://你的worker域名`
3. 用户名 / 密码：上面 `GR_USERS` 配置的值
4. 保存后即可同步订阅、未读、星标

> 客户端会自行拼接 `/reader/api/0/...` 路径。若客户端要求填写完整 API 地址，填 `https://你的worker域名/reader/api/0`。

### feed 图标

订阅列表里的 `iconUrl` 指向 Worker 自带的 `/favicon?host=xxx` 代理，由 Worker 从 Cloudflare 边缘抓取并缓存在边缘（Cache API），客户端无需直连 Google/DuckDuckGo。

## 已实现的 API

端点清单见下表；各接口的请求参数与响应字段详细定义见 [docs/api.md](docs/api.md)。

| 端点                                     | 方法     | 说明                             |
| ---------------------------------------- | -------- | -------------------------------- |
| `/accounts/ClientLogin`                  | GET/POST | 账号密码换取 Auth token          |
| `/reader/api/0/auth-token`               | GET      | 获取 token                       |
| `/reader/api/0/token`                    | GET      | 获取 token（同 auth-token）      |
| `/reader/api/0/user-info`                | GET      | 用户信息                         |
| `/reader/api/0/subscription/list`        | GET      | 订阅列表（含分组/标签）          |
| `/reader/api/0/subscription/quickadd`    | POST     | 通过 URL 添加订阅                |
| `/reader/api/0/subscription/edit`        | POST     | 订阅/取消订阅、改标题、加/删标签 |
| `/reader/api/0/tag/list`                 | GET      | 标签列表                         |
| `/reader/api/0/rename-tag`               | POST     | 重命名标签                       |
| `/reader/api/0/disable-tag`              | POST     | 删除标签                         |
| `/reader/api/0/edit-tag`                 | POST     | 已读/未读/星标/标签编辑          |
| `/reader/api/0/mark-all-as-read`         | POST     | 全部标记已读                     |
| `/reader/api/0/unread-count`             | GET      | 未读数统计                       |
| `/reader/api/0/stream/contents/{stream}` | GET      | 流内容（JSON / Atom）            |
| `/reader/api/0/stream/details`           | GET      | 流详情                           |
| `/reader/api/0/stream/items/ids`         | GET      | 流的条目 ID 列表                 |
| `/reader/api/0/stream/items/contents`    | GET/POST | 指定条目详情                     |
| `/reader/api/0/stream/items/count`       | GET      | 流的条目数                       |
| `/reader/api/0/preference/list`          | GET      | 偏好设置（静态）                 |
| `/reader/api/0/preference/stream/list`   | GET      | 流偏好（静态）                   |
| `/reader/api/0/friend/list`              | GET      | 好友列表（静态）                 |
| `/reader/api/0/search/items/ids`         | GET      | 搜索条目                         |
| `/reader/subscriptions/export`           | GET      | 导出 OPML                        |
| `/reader/subscriptions/import`           | POST     | 导入 OPML                        |
| `/reader/api/0/sync`                     | POST     | 手动触发一次抓取同步             |
| `/favicon?host=xxx`                      | GET      | favicon 代理（边缘缓存）         |

### 常用 stream ID

- 全部/阅读列表：`user/-/state/com.google/reading-list`
- 未读：`user/-/state/com.google/reading-list` + `xt=user/-/state/com.google/read`
- 星标：`user/-/state/com.google/starred`
- 单个订阅：`feed/<feed url>`
- 标签：`user/-/label/<label>`

### 流查询参数

`n` 数量、`c` 分页 continuation、`r=o` 正序、`it` 包含、`xt` 排除、`ot`/`nt` 时间过滤、`output=json|atom`。

## 认证方式

服务端兼容客户端常用的几种方式：

```bash
# 1. HTTP Basic
curl -u admin:pass "https://your-worker/reader/api/0/user-info"

# 2. ClientLogin 换 token
curl "https://your-worker/accounts/ClientLogin?Email=admin&Passwd=pass"
#   返回 Auth=<token>，后续用 T=<token> 或 GoogleLogin auth=<token>
curl -H "Authorization: GoogleLogin auth=<token>" "https://your-worker/reader/api/0/user-info"
```

## 配置项

| 变量                 | 说明                                                          | 默认                |
| -------------------- | ------------------------------------------------------------- | ------------------- |
| `GR_USERS`           | `用户名:密码`，多个用逗号分隔                                 | `admin:changeme123` |
| `JWT_SECRET`         | token 签名密钥，务必修改                                      | `greader-secret`    |
| `SYNC_INTERVAL_MIN`  | 抓取间隔（分钟）                                              | `15`                |
| `MAX_FETCH_PER_CRON` | 每次 Cron 最多抓取的源数量                                    | `20`                |
| `MAX_ITEMS_PER_FEED` | 每个源保留的最大文章数                                        | `3000`              |
| `MAX_ITEM_AGE_DAYS`  | 入库时跳过 N 天以前的旧条目（`0` 关闭；无日期的条目总是保留） | `90`                |

Cron 表达式在 `wrangler.toml` 的 `[triggers]` 中，默认 `*/30`（每 30 分钟触发一次）；`SYNC_INTERVAL_MIN` 决定「多久未抓取」的源视为陈旧并在 cron 中补抓。

## 说明与限制

- 阅读列表默认返回**全部**条目（符合原生 Google Reader 行为）；客户端一般用 `xt=user/-/state/com.google/read` 过滤出未读。
- 只保留每个源最新的 `MAX_ITEMS_PER_FEED` 条，旧条目自动清理。
- `POST` 令牌（`T` 参数）不会强制校验，以兼容更多客户端。
- 首次访问或冷启动会自动执行建表语句（幂等）。
