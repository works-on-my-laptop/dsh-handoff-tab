# dsh-handoff-tab

会话视图「交接」tab：宿主在后台读当前会话日志、调用默认模型，生成**一段可直接粘贴到新会话第一条消息的交接提示词**，保存在 DSH 存储域（`$DSH_HOME/storages/handoff.json`）。

- 不写工作区文件；不往会话加消息、命令卡片或事件。
- 每个会话只保留最新一份，重新生成直接覆盖；保留期 60 天，插件启动后异步清理一次。
- 入口只有 tab；没有斜杠命令、dock 按钮，也不自动切 tab。

## 状态

M0–M3 已完成：

- M0 宿主半部：路由、后台生成、storageDomain 往返、60 天清理、零会话足迹。
- M1 会话 tab：注册、空状态、生成中、展示、生成时间、重新生成、复制、错误态。
- M2 收尾：清理与持久化验证、错误路径验证、README。
- M3 界面打磨：tab 激活时隐藏底部输入框；按钮/工具栏/正文排版按宿主 token 重做（显式边框让 hover 底色完整覆盖按钮盒，主按钮带轻阴影）。

已验证（2026-11-10，DSH 0.2.2-rc.1 / Windows）：

- 真实生成 4 次（19s–66s），产物均为「正文即提示词」：无标题/引言/生成时间/会话 ID；按「中文字符 + 英文词」口径 754–1207 字。
- 零会话足迹：空闲会话生成前后会话日志行数不变（332 → 332）。
- 零工作区足迹：生成前后 `git status` 无新增文件。
- 60 天清理：注入一条 `generatedAt=0` 的测试记录后重载插件，5 秒后被删除，其余记录保留。
- 持久化：域关闭（插件关）后重新打开，记录从 `handoff.json` 正常恢复。
- 错误路径：不存在的会话 → POST 202 → GET 一次性返回 `{state:'error', error:'session "…" not found'}`，再查变回 `idle`。
- 越界/坏请求：错误 HTTP 方法 405、空 body 400、非法 JSON 400。

## 界面行为

- 会话视图 tab 行：`[对话] [轨迹] [交接]`，窄屏自动收进「更多会话视图」。
- 只有「交接」tab 处于激活状态时，底部输入框被隐藏（`[data-conversation-session]:has([data-dsh-handoff-view]) [data-composer-seat]{display:none}`，只依赖宿主稳定属性，切回其他 tab 自动恢复）。
- 正文用等宽 `<pre>` 展示，不做 Markdown 渲染；正文即复制内容。
- 颜色、边框、圆角、字体全部走 `--dsw-alias-*` / `--dsw-radius-*` / `--dsw-font-*` token，跟随宿主明暗主题。

## 安装

```text
dsh plugin --profile web add <本目录>
```

首次安装后若宿主未热装载，重启一次 `dsh web`。已安装的本地目录是 linked 方式，之后改 `client.js` 由 client-hmr 热替换，改 `index.js` 需要重载插件（可在插件管理里关/开）或重启。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/handoff/doc?sessionId=<id>` | 返回 `{state:'idle'\|'generating'\|'ready'\|'error', text?, generatedAt?, model?, promptVersion?, error?}` |
| `POST` | `/handoff/generate` | body `{sessionId}`；立即 202，返回 `{state:'generating'}`，生成在宿主后台继续 |

生成中状态只存在宿主内存：切 tab、切会话、关页面都不中断；重新进入 tab 时用 `GET` 恢复状态。进程重启会丢失 in-flight（设计允许）。

## 数据

```text
$DSH_HOME/storages/handoff.json
{
  "unit": { "name": "handoff", "version": 1 },
  "global": null,
  "tables": { "documents": { "<sessionId>": { "text", "generatedAt", "model", "promptVersion" } } }
}
```

记录 schema 用 4 字段的极简校验对象（只要求 `parse`/`safeParse`）而不是 zod：本地目录以 linked 方式装入 profile 后解析不到 profile 的 `zod`，而 harness 只代理自己安装的 `@deepseek-ai/*`。这样插件保持零运行时依赖。

## 排障

- 记录读不出 / 插件不激活：检查 `$DSH_HOME/storages/handoff.json` 是否为合法 JSON、`unit.name` 是否为 `handoff`。确认不再需要后删掉该文件即可让插件以空域重建。
- 生成失败：`GET /handoff/doc` 会一次性返回 `{state:'error', error}`（不落半成品）；重新生成即可重试。
- 路由 404：确认 profile 里有 `handoff` 这一行（`dsh --profile web --dump-config | grep handoff`）且插件行处于启用状态。

## 开发

- `index.js`：宿主 ESM，`inject = ['webServer','storageDomain']`。
- `client.js`：浏览器 classic script，`window.__ModuleLoader__.load` + `exports.apply/inject`。
- `cordis.patch.yml`：插入 patch 行 `handoff`。
- 验证：`curl -s -X POST http://127.0.0.1:3080/handoff/generate -H 'content-type: application/json' -d '{"sessionId":"<id>"}'`，再轮询 `GET /handoff/doc`；用会话日志行数前后不变确认零会话足迹。
