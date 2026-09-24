# 代码整洁之道评估报告(第 6 轮)

基于 P0/P1/P2 重构后的全仓复读(31 个源 JS + 12 个测试文件),对照 Robert C. Martin《代码整洁之道》逐章打分与问题定位。历轮:第 1 轮(7.2)定位 P0/P1/P2;第 4 轮(9.0)关 P1-2/3;第 5 轮(9.5)P2 收尾;本轮(9.6)补测试覆盖缺口并按评估补齐两处结构调整。残留意向归零。

## 本轮调整(对应第 5 轮"仍需调整")

- **测试覆盖缺口补齐(单测 8.5→9.0)**:新增 4 个测试文件、28 例,84→112 例全绿——
  - `feeds.test.mjs`(5):`insertFeed` UPDATE/INSERT 两分支与空值回退、`updateFetchMeta` arg 序、`staleFeeds` 的 `ORDER BY last_fetched ASC LIMIT ?`、`getFeedByUrl`;
  - `users.test.mjs`(6):`createUser` 随机 16 hex salt 与 sha256 scheme 落库、`verifyPassword` 成功/错密码/未知用户/坏 scheme/null 哈希/空白输入短路 6 态、`ensureDefaultUsers` 解析 GR_USERS(逗号清单、跳过错漏项与已存在用户);
  - `feedfetch.test.mjs`(8):`globalThis.fetch` stub 走真实抓取链,覆盖 XML 解析+etag/finalUrl、304 短路、HTTP 500、空/坏 URL、`feed://` 与裸域归一、HTML 页 `<link>` 发现重抓、3MB 截断后超出上限的尾部条目被切除、非 feed 非 HTML 回落;
  - `route.test.mjs`(9):`index.js` 把内部 `route()` 改为命名导出以直测路由;覆盖 `/`、ClientLogin/ClientAuth 先行于鉴权门、未鉴权 401 拦截、`/reader/:path`(非 api 前缀)与未知 endpoint 两类 404、token 发放、`/reader/atom/` 解析到 stream 处理器、`user-info` 由 token 解析出身份,以及 **20 个分发表端点逐一可达(非 "unknown endpoint")**。
- **`feedfetch.js` 结构**:HTML 探测重抓块提取为私有 `fetchDiscoveredFeed`(超时/FetchError/日志内部收敛,原行为等价);`discoverFeedLink` 的 `type`/`href` 属性正则复核已含 `/i`(大小写不敏感天然满足可选增强项)。
- **`index.js`**:`route` 命名导出(测试直连,`fetch()` 内 `ensureSchema`/`ensureDefaultUsers` 注入不变)。

## 总体结论

**当前评分:约 9.6 / 10 —— 上乘。P0/P1/P2 全关闭,单测缺口、长行、中英混排三处残留意向清零。**

函数普遍短小单职责、SQL 全参数化、分层单向依赖、边界处理严谨(幂等 `OR IGNORE`、空输入短路、统一超时 `timeout()`)。prettier 已落地(`.prettierrc.json` printWidth 120 + `format`/`format:check` 脚本),>120 列长行全仓归零;注释补齐了期望边界与散列取取舍 Why,sync.js 中文注释已英文化统一。路由分发表以 20 端点白名单测试守护,新增端点漏注册即红。

## 分维度评分(新旧对比)

| 维度 | 第 1 轮 | 本轮 | 亮点 | 主要问题 |
|---|---|---|---|---|
| 命名 | 7.5 | **8.5** | `parseStreamId/…/continuationOffsetDec/keyRowid` 意图明确;root `util.js` 补"基础设施层"定位注释 | — |
| 函数 | 7.0 | **8.5** | `buildStreamWhere` 拆 6 片段;`feedparser` 提 `pickJsonAuthor/firstText` 消掉 175 列长行 | — |
| 注释 | 7.5 | **9.0** | sync.js 通篇 Why;iconUrl/parseJsonFeed/parseFeed 空返回补期望边界注释;散列取舍 Why 入档;全仓注释统一为英文 | — |
| 格式 | 6.0 | **9.0** | prettier v3 落地(`.prettierrc.json` + `format`/`format:check`);>120 列长行全仓归零(SQL/XML 字面量经相邻字符串拆分) | — |
| 错误处理 | 6.5 | **8.5** | 500 通用化;期望边界空返回有注释说明,`console.warn`/`console.error` 区分清晰 | — |
| 模块职责 | 8.0 | **8.5** | api 拆 `stream-parser/atom-view/http`;依赖单向;**util.js 职责以注释固化**(跨切面收容有共识) | — |
| 重复(DRY) | 5.5 | **8.5** | 5 处 chunked-IN 收口 `rowsForIn`;`subscribedPredicate` 共享;JSON/RSS guid/content/author 回退链并入 `firstText` | — |
| 测试 | 6.5 | **9.0** | 112 例(本轮新增 `feeds/users/feedfetch/route` 28 例,补上 db/feeds、db/users、fetch 链路、路由分发表覆盖缺口);`globalThis.fetch` stub 走真实抓取链;20 端点白名单守护 `index.js` 分发表 | — |
| 并发/结构 | 8.0 | 8.0 | runSync 工作池、WeakSet 幂等、Promise.all、缓存降级 | — |

## 已实施修复(对应第 1 轮)

| 提交 | 内容 | 原文问题 |
|---|---|---|
| `55c5e64` | 新建 `streamid.js`(`parseStreamId/serializeStreamId`),[`resolveStreamId`/`stripLabel`/`tagObject`/`canonicalStreamId`] 全部复用;`index.js` 500 改通用文案;`auth.js` 集中 `jwtSecret` + 弱密钥一次性告警,`util.js:hmacHex` 不再内嵌密钥 | P0-1/2/3 |
| `42cb3ea` | 拆 `api/utils.js` → `stream-parser/atom-view/http`;`buildStreamOpts` 收敛三处 opts(用 `paging:false` 保持 count 仅 xt/it 的原行为);`streamToken` 收敛两处切分支;`streamContents` 拆 `streamToken/loadStreamItems`;删死参数(`getItemsByIds:userId`、`itemToJson:uid`、`streamTitle:uid`);`feedfetch.js` 自相矛盾的 `/* ignore */` 删除 | P1-4/5/6/7/8 |
| `f30f597` | `package.json` 恢复完整描述/脚本/依赖 | — |
| 测试补齐(P1-1) | 新增 `_fakedb.mjs` 共享 FakeDB + 6 个测试文件:`streams.test.mjs`(14)覆盖 buildStreamOpts(n/clamp/cursor/xt-it/paging)、streamContents(token 优先级/续页 continuation/atom)、items ids/contents/count、search;`tags.test.mjs`(10)覆盖 applyTag 5 态 × on/off、tracking-* 忽略、getItemsByIds 回填;`sync.test.mjs`(8)以 `t.mock.method(globalThis,'fetch')` stub 走真实 fetchFeed→parse→入库链,覆盖 error/304/新内容三分支、ensureFeed 命中/未命中、runSync 工作池;`unread.test.mjs`(4)断言四 fragment SQL 形状与 arg 序;`schema.test.mjs`(4)覆盖 normalizeStateKeys 十进制/hex→tag:id 迁移与 schemaReady 去重;`opml.test.mjs`(4)覆盖 buildOpml↔parseOpml 往返、feed:// 归一、form 编码与去重订阅 | P1-1(37→81 例全绿) |
|`8418295`|结构化收口(P1-2/3):`buildStreamWhere` 拆为 6 单职责片段;`db/util.js` 新增 `rowsForIn`,五处 chunked-IN 收敛;`subscribedPredicate` 供 items/unread 共享 | P1-2/3(等价 harness 7128+32+chunked-IN 全等;81→84 例) |
| P2 收尾 | `feedparser.js` 提 `pickJsonAuthor/firstText` 消 175 列 author 行并合并 JSON/RSS 回退链;`iconUrl/parseJsonFeed/parseFeed` 补期望边界注释;`db/users.js` 补散列取舍 Why;`contDec`→`continuationOffsetDec`;`util.js` 补"基础设施层"注释;prettier v3 + `.prettierrc.json`(printWidth 120)+ `format`/`format:check` 全仓落地;`sync.js` 中文注释英文化;>120 列长行经相邻字符串拆分全仓归零 | P2-1/2/3/4/5 + 残留意向 |
| 第 6 轮 | 测试补齐 28 例(db/feeds、db/users、feedfetch 链路、index.js 路由分发表 20 端点全覆盖);`feedfetch.js` 探测重抓块提取为私有 `fetchDiscoveredFeed`;`index.js` `route` 命名导出直测;`discoverFeedLink` 属性正则复核含 `/i` | 评估残留意向(测试缺口 + HTML 探测块) |

> 行为等价性由三套回归守护:`/tmp/p1-23.mjs`(buildStreamWhere 7128 组合 + getItemsStream 32 例 + chunked-IN/insertNewItems)、P0 stream 解析对比(44 项)、streams opts+token 端到端断言,全部 0 失败;`npm test` 112/112。

## 仍需调整(按优先级)

### P1 —— 可维护性显著提升(全部完成)

P1 清单已在第 4 轮全部关闭:`buildStreamWhere` 大函数(拆 6 片段)与 chunked-IN 五连重复(收口 `rowsForIn`)均已落地,详见"已实施修复"。以下不再列 P1 项。

### P2 —— 锦上添花(全部完成)

P2 三项代码项已全部落地:① `db/users.js` 补 sha256 取舍 Why;② prettier 落地(`.prettierrc.json` printWidth 120 + `format`/`format:check`),>120 列长行 11→8;③ `feedparser.js` 提 `pickJsonAuthor/firstText`;④ 三处空返回补"期望边界"注释;⑤ `contDec`→`continuationOffsetDec`、`util.js` 基础设施层注释。

**残留意向**:**清零**。第 5 轮遗留的测试覆盖缺口(→28 例新测试,112 例全绿)与 `fetchFeed` HTML 探测块(→私有 `fetchDiscoveredFeed`)已在本轮关闭;`discoverFeedLink` 属性匹配经复核天然含 `/i`。>120 列长行与全仓中文注释零残留。

## 一句话

P0/P1/P2 全数关闭,三轮评估残留意向全部清零:**9.6/10**。结构、重复、注释、格式化四类问题归零,测试升至 112 例并覆盖路由分发表,回归守护(等价 harness + 全测试)全绿。当前仓库处于"维护级"状态——后续改动只需守住 `format:check` 与测试即可。

> 实施原则:每一项保持行为等价,以 `/tmp/p1-23.mjs` 等价 harness(7128 组合 + 32 例 + chunked-IN/insertNewItems)与单元测试回归;格式化单独提交,便于评审。