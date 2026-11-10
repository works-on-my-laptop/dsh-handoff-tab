# dsh-handoff-tab 插件设计方案 v3（会话 Tab + 本地持久化）

- 日期：2026-11-10
- 状态：**方案待确认**，代码未开始
- v1（填词→主对话生成）、v2（dock 按钮→临时面板）均被后续需求取代。

## 1. 需求

| # | 需求 | 约束含义 |
| --- | --- | --- |
| 1 | 不要命令，不要提示词输入 | 触发靠界面，不注册斜杠命令 |
| 2 | 不影响现有会话内容，不新增输入和输出 | 会话里不能多出 user/assistant 消息或命令卡片 |
| 3 | 结果要能持久化回顾，但不能落工作区 | 不生成仓库文件；存到插件自己的数据区 |
| 4 | 入口 + 展示都放在「对话 / 轨迹」旁的 tab | 新增一个会话视图 tab，内含按钮与展示区 |
| 5 | 展示区要有生成时间 + 重新生成按钮 | tab 顶部工具行 |
| 6 | 展示形式不限 | 以可读 + 一键复制为准 |
| 7 | 不学 handoff-button 写 `handoff/` 污染仓库 | 明确排除工作区写盘 |
| 8 | 生成是后台任务 | 生成中切 tab、切会话、关页面都不中断；回来能继续看或看到"生成中" |
| 9 | 只展示提示词，内容要充实 | 正文是可直接粘给下一会话的交接提示词，不追求短；一份即可 |

## 2. 架构结论

两条需求同时成立，架构被唯一确定：

- 需求 2 排除"主对话生成"→ 生成必须**带外**（宿主侧直接调 LLM，不进会话）。
- 需求 3+4 决定了展示与持久化的落点：**会话 tab 作为唯一 UI**，文档存 **DSH 存储域**（`ctx.storageDomain`），不写工作区。

```
┌ 会话 Tab 行： [对话] [轨迹] [交接] …（窄屏收进「更多会话视图」）
└──────────────────────────────────────────────
 点击「交接」tab
   ├─ 无文档 → 空状态：「生成交接提示词」按钮
   ├─ 生成中 → 进度/取消
   └─ 有文档 → 顶部：生成于 16:20 · [重新生成] [复制]
              正文：交接提示词（可滚动）
        │
        ▼
 客户端 fetch('/handoff/generate' | '/handoff/doc')
        │
        ▼
 宿主 index.js
   sessionQuery 读会话 → 压缩转录 → llm.stream → 文本
   storageDomain 存/取 { text, generatedAt, model }（~/.dsh/storages）
   返回客户端（不写会话、不写工作区）
```

## 3. 证据（均已核实）

| 能力 | 结论 | 来源 |
| --- | --- | --- |
| 新增会话 tab | `ctx.slots.inject('conversation.view', () => ctx.slots.register({ name:'conversation.view', id, order, locale, label:()=>string, inject:(sessionId)=>props }, Component))` | 轨迹 tab 的真实注册代码 `dsh-client-ui-trajectory/lib/client.js`；官方指南 `dsh-creation-recommendations/references/session-tab.md` 明确写"This adds a tab beside Chat and Trajectory" |
| tab 行「更多」菜单 | `conversation.session.header.views.actions`（list/session），自动产出 pinned/active 信息 | `dsh-client-ui-conversation/.../contract/slots.d.ts:283,289` |
| 视图 owner props | `{ inspectCall, viewRequest, openView, completeViewRequest }` | 同上 `slots.d.ts:533` |
| 持久化（非会话、非工作区） | `defineDomain({ name, version, tables })` + `ctx.storageDomain.open(spec)` → `domain.table(t).put/get/update` | `dsh-storage-domain/README.zh.md` |
| 存储后端已挂载 | base 已挂 `storage` + `storage-json`（`root: $DSH_HOME/storages`）+ `storage-domain` | `dsh-base/cordis.patch.yml:175-188` |
| 宿主读会话 + 调 LLM | `ctx.get('sessionQuery').readSession(id)`、`ctx.get('llm').stream({...})` | `dsh-handoff-button/index.js:141,415` |
| 零会话足迹 | 视图是纯客户端 slot；生成走 HTTP 路由，不产生 `command/*` 或消息事件 | `dsh-handoff-button` 同构管线长期运行无会话污染 |

## 4. 界面设计（tab 内）

```
┌─ 交接 ──────────────────────────────────────────┐
│ 生成于 2026-11-10 16:20        [重新生成] [复制] │   ← 工具行，无文档时只显示按钮
├─────────────────────────────────────────────────┤
│                                                 │
│  （整段提示词，直接可复制粘贴）                   │   ← 正文区，独立滚动
│  你在继续一个 DSH 插件项目……                      │
│                                                 │
└─────────────────────────────────────────────────┘
```

状态机：

| 状态 | 表现 |
| --- | --- |
| 空 | 一句说明 + 「生成交接提示词」主按钮 |
| 生成中 | 按钮禁用、显示"生成中…"、可取消 |
| 就绪 | 工具行显示生成时间 + 重新生成 + 复制；正文渲染 |
| 失败 | 错误文案 + 重试；不留半成品 |

要点：

- 生成是**宿主侧后台任务**：点击后不切换 tab、不打断；切到别的 tab、别的会话、甚至关掉页面，生成都继续。
- 重新进入该会话的 tab 时，按宿主返回的状态恢复：`ready` 显示结果、`generating` 显示进行中、`idle` 显示空状态（否则离开再回来会误显示为空）。
- 切换会话 = 切换文档：tab 内容按 `sessionId` 取，绝不串会话。
- 复制只有一个按钮，复制正文全文（正文就是交接提示词）。
- 正文渲染：MVP 用等宽 `<pre>`（零构建依赖），M3 再换 Markdown 渲染。

### 生成内容要求

- 产物是**一段可直接粘贴到新会话第一条消息的文本**，全文都是提示词：没有标题、引言、结语、生成时间或会话 ID，正文之外没有任何内容。
- 正文必须覆盖：任务与验收标准、当前进度（含证据）、关键决策与已否决方案、产出物路径、坑、下一步（做什么/改哪里/验收）、硬约束。
- 800–2000 字，具体到路径与命令；不确定的写成「先核实」而不是编造。
- 跟随会话语言；API key / token / 密码等自动脱敏。

## 5. 持久化边界

| 写什么 | 位置 | 是否允许 |
| --- | --- | --- |
| 交接提示词正文 + 元信息 | `ctx.storageDomain`（`$DSH_HOME/storages`，DSH 管理的数据目录） | ✅ 需求 3 认可 |
| 工作区文件（如 `handoff/*.md`） | 仓库 | ❌ 明确禁止 |
| 会话消息 / 命令事件 | 会话日志 | ❌ 需求 2 禁止 |
| 插件配置（cordis.patch.yml） | profile | ❌ 不适合存增长型数据 |

数据模型：

```
domain: handoff （version 1）
table:  documents
key:    sessionId
value:  { text, generatedAt, model, promptVersion }
```

策略：

- 每个会话只保留**最新一份**，重新生成直接覆盖（已确认不留历史）。
- 进行中状态不落库：宿主用内存 `Map<sessionId, Promise>` 记住"正在生成"，客户端重新挂载时据此恢复；切换会话/关页面都不会终止它。
- 可选「删除」按钮清空该会话记录（M2）。

### 生命周期与清理

- **不探测会话是否存在**：会话被删后 tab 本来就打不开，记录留着无害；省掉逐条 `readTitle` 探测，逻辑更短。
- **启动时清理一次**：插件装载后异步扫一遍 `documents` 表，删除 `generatedAt` 早于 **60 天** 的记录（默认保留期，先写成常量；以后可做成插件配置项）。
- 异步执行（启动后延迟几秒跑，不阻塞启动）；表规模 = 生成过提示词的会话数，量级很小，一次全表扫描可忽略。
- 读时不校验：有记录就展示，没有就是空状态；归档会话在保留期内恢复后，tab 里仍能看到原提示词。
- 内存里的 in-flight 状态在进程重启后自然清空，不需要清理。

## 6. 文件结构

```
dsh-handoff-tab/
├── package.json      # dsh.bundle.patch + dsh.client{platform:'web', inject:[…]}
├── cordis.patch.yml  # - insert: { id: handoff, name: dsh-handoff-tab }
├── index.js          # 宿主：routes + storageDomain + sessionQuery + llm
├── client.js         # 浏览器：conversation.view tab + 状态机 + 复制
└── README.md         # 安装/卸载/数据位置/零足迹说明
```

## 7. 验收清单

1. tab 出现在「对话 / 轨迹」旁（窄屏进「更多会话视图」），且不破坏原有两个 tab。
2. 生成一次后：会话事件数不变、工作区 `git status` 干净。
3. 刷新页面、重启 dsh、换会话再回来：文档仍在且属于正确会话。
4. 「重新生成」覆盖旧值并更新生成时间；「删除」后回到空状态。
5. DB 里确实只有 `documents` 一条记录，无其他文件产生。
6. 换到别的会话，tab 不显示上个会话的内容。

## 8. 里程碑

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| M0 | 宿主：路由 + storageDomain 读写 + 一次真实 LLM 调用；curl 验证 | 返回合理文本并能往返存取；会话与工作区零变化 |
| M1 | 客户端 tab：注册、空状态、生成、展示 | tab 出现，点击能生成并显示 |
| M2 | 生成时间 + 重新生成 + 复制 + 删除 + 错误态 | 完整闭环 |
| M3（可选） | Markdown 渲染、启动词单独复制、后台生成、i18n | 体验打磨 |

## 9. 风险

1. **`conversation.view` 组件 props 形状**：`inject(sessionId)` 返回什么、组件如何拿到 `sessionId`，需 10 行探针确认（轨迹的写法可照抄）。
2. **`llm.stream` 带 `sessionId` 是否写会话记录**：M0 用事件计数法验证，必要时去掉该参数。
3. **生成耗时与状态恢复**：单次 10–30 秒；宿主必须在内存维护 in-flight 状态，客户端重新挂载时据此恢复"生成中"，否则离开再回来会误显示为空。
4. **转录压缩质量**：一次性产物，漏"已否决方案/坑"就失去价值；M0 拿真实长会话做对照。
5. **存储域兼容**：`defineDomain` 版本号一旦发布要按版本升级规则演进，v1 先固定 version 1。
6. **安装需重启**：新增宿主半部，首次安装必须重启 dsh 进程。

## 10. 默认决策（未逐项确认时采用）

- 入口：只做 tab，不做 dock 按钮、不做命令；生成后**不自动切换 tab**
- 展示：tab 内工具行（生成时间 / 重新生成 / 复制）+ 正文 `<pre>`；正文是单份交接提示词，内容充实
- 持久化：storageDomain，每会话仅最新一份，不存历史
- 清理：启动后异步扫描一次，删除 `generatedAt` 早于 60 天的记录；不探测会话是否存在
- 复制：一个按钮，复制全文
- 生成：宿主后台任务，非流式；跨 tab / 跨会话 / 关页面都不中断，重进时按宿主状态恢复
- 语言：跟随会话语言
- 代码位置：本会话产出目录下 `dsh-handoff-tab/`
