# 代码整洁之道评估报告(第 5 轮)

基于 P0/P1/P2 重构后的全仓复读(31 个源 JS + 8 个测试文件,约 3100 行),对照 Robert C. Martin《代码整洁之道》逐章打分与问题定位。第 1 轮(2026-09 初评,7.2/10)列出的全部 P0/P1 已落地;第 4 轮(9.0)关 P1-2/3 结构问题;本轮(9.5)P2 收尾。P0/P1/P2 至 9.5。

## 总体结论

**当前评分:约 9.5 / 10 —— 上乘。P0/P1/P2 全部关闭,结构性与一致性问题清零,进入收尾级维护。**

函数普遍短小单职责、SQL 全参数化、分层单向依赖、边界处理严谨(幂等 `OR IGNORE`、空输入短路、统一超时 `timeout()`)。prettier 已落地(`.prettierrc.json` printWidth 120 + `format`/`format:check` 脚本),>120 列长行全仓归零(含测试,SQL/XML 字面量经相邻字符串拆分收敛);注释补齐了期望边界与散列取取舍 Why,sync.js 中文注释已英文化统一。

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
| 测试 | 6.5 | **8.5** | 84 例(新增 `subscriptions.test.mjs`:latestTimestamps 分片/去重/空输入);`globalThis.fetch` stub 走真实抓取链 | — |
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

> 行为等价性由三套回归守护:`/tmp/p1-23.mjs`(buildStreamWhere 7128 组合 + getItemsStream 32 例 + chunked-IN/insertNewItems)、P0 stream 解析对比(44 项)、streams opts+token 端到端断言,全部 0 失败;`npm test` 84/84。

## 仍需调整(按优先级)

### P1 —— 可维护性显著提升(全部完成)

P1 清单已在第 4 轮全部关闭:`buildStreamWhere` 大函数(拆 6 片段)与 chunked-IN 五连重复(收口 `rowsForIn`)均已落地,详见"已实施修复"。以下不再列 P1 项。

### P2 —— 锦上添花(全部完成)

P2 三项代码项已全部落地:① `db/users.js` 补 sha256 取舍 Why;② prettier 落地(`.prettierrc.json` printWidth 120 + `format`/`format:check`),>120 列长行 11→8;③ `feedparser.js` 提 `pickJsonAuthor/firstText`;④ 三处空返回补"期望边界"注释;⑤ `contDec`→`continuationOffsetDec`、`util.js` 基础设施层注释。

**残留意向**:已全部清除——>120 列长行经相邻字符串拆分归零(`opml.js`/`api/atom-view.js` gr:origin/`db/schema.js` 迁移 SQL/三处测试 fixture);`sync.js` 中文注释英文化统一,全仓注释单一语言。

## 一句话

P0/P1/P2 全数关闭,残留意向(长行/中英混排)清零:**9.5/10**。结构、重复、注释、格式化四类问题归零,回归守护(等价 harness + 84 例测试)全绿。当前仓库处于"维护级"状态——后续改动只需守住 `format:check` 与测试即可。

> 实施原则:每一项保持行为等价,以 `/tmp/p1-23.mjs` 等价 harness(7128 组合 + 32 例 + chunked-IN/insertNewItems)与单元测试回归;格式化单独提交,便于评审。