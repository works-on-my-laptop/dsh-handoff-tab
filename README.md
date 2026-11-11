# dsh-handoff-tab

DeepSeek Harness（DSH）Web 会话视图的「交接」tab：在后台读当前会话日志、调用当前默认模型，生成**一段可直接粘贴到新会话第一条消息的交接提示词**，保存在 DSH 存储域（`$DSH_HOME/storages/handoff.json`）。

> English: a **Handoff** tab for the DSH conversation view. It generates a paste-ready handoff prompt for a fresh session, in the background, and stores it in the DSH storage domain — no workspace files, no session messages.

不写工作区、不往会话加消息/命令事件；每个会话只保留最新一份，60 天自动清理。

## 功能

- 「交接」tab 与「对话」「轨迹」并列（order 20），窄屏自动收进「更多会话视图」省略号菜单。
- 空状态一键「生成交接提示词」；生成在**宿主后台**执行：切 tab、切会话、关页面都不中断，重新进入按宿主状态（`idle` / `generating` / `ready` / `error`）恢复。
- 就绪后顶部工具行显示生成时间，支持「重新生成」「复制」；正文就是全部复制内容。
- 生成时附带一份**当前工作区快照**（顶层文件树、引用路径存在性、移动文件检测），避免提示词引用已移动/不存在的文件或并不存在的构建产物。
- tab 激活时隐藏底部输入框，正文区域完整可用（切回其他 tab 自动恢复）。
- 生成失败给出错误文案与重试，不留半成品；重新生成直接覆盖旧值。
- 界面文本中英双语（跟随 DSH locale），颜色/圆角/字体跟随宿主主题 token。

## 环境要求

- DSH **0.2.2-rc.1**（web profile）实测；`engines.dsh` 兼容范围 `>=0.2.0-rc.1 <0.3.0-0`。
- Node.js >= 22.19。
- 无构建步骤、无运行时 npm 依赖。
- 数据/路由只在 loopback 的 DSH Web 进程内使用。

## 安装

三种方式任选其一，装完若宿主没有热装载，重启一次 `dsh web` 即可。

### 1. 直接从 GitHub 安装（pnpm git 依赖）

```bash
dsh plugin --profile web add github:works-on-my-laptop/dsh-handoff-tab
```

### 2. 克隆到本地后按目录安装

```bash
git clone https://github.com/works-on-my-laptop/dsh-handoff-tab.git
dsh plugin --profile web add /path/to/dsh-handoff-tab
```

### 3. 用 DSH 的 plugin_manager

在 DSH 里让 agent 调 `plugin_manager`，`action: install_bundle`，`target` 指向仓库目录。它会完成包安装与 bundle 选择。

安装后可自查（应看到 `- id: handoff` 行）：

```bash
dsh --profile web --dump-config | grep -A1 handoff
```

卸载见文末。

## 使用

1. 打开任意会话，切到 tab 行的「交接」。
2. 空状态点「生成交接提示词」。单次生成约 10–60 秒（模型/上下文长度而异）。
3. 生成完成后：
   - 「复制」把正文整段放进剪贴板，粘到新会话第一条消息即可；
   - 「重新生成」覆盖旧结果并刷新生成时间；
   - 生成期间切走/关页面不会中断，回来会显示进行中或已完成。
4. 生成内容要求：正文即提示词，不含标题、引言、生成时间、会话 ID；覆盖任务与验收、当前进度与证据、关键决策与否决方案、产物路径、坑、下一步、硬约束；目标 800–2000 字。

## 数据与隐私

- 只写入 `$DSH_HOME/storages/handoff.json`，结构：

```json
{
  "unit": { "name": "handoff", "version": 1 },
  "global": null,
  "tables": {
    "documents": {
      "<sessionId>": { "text": "…", "generatedAt": 1730000000000, "model": "…", "promptVersion": 1 }
    }
  }
}
```

- **不**写工作区文件，**不**往会话日志追加消息、命令卡片或事件（路由是纯客户端↔宿主 side channel）。
- 生成会调用当前默认模型并产生 token 费用；若装了 `dsh-cost-meter`，该次费用会计入目标会话（它自己的账本，不写会话事件）。
- 进程重启会丢失进行中的生成任务；已生成的结果保留在存储文件里。
- 插件路由与 DSH Web 同源、仅监听 loopback，不额外鉴权；不要在不可信网络暴露 DSH Web 端口。

## 卸载

```bash
# 推荐：用 DSH 插件管理页卸载，或让 agent 调 plugin_manager remove_bundle
dsh plugin --profile web remove dsh-handoff-tab
```

命令行卸载后还需把 profile `package.json` 的 `dsh.profile.bundles` 里的 `dsh-handoff-tab` 条目删掉（插件管理页会自动处理）。清空数据（可选）：

```bash
rm "$DSH_HOME/storages/handoff.json"
```

## 兼容性与已知限制

- 仅在 DSH 0.2.2-rc.1 / Windows 实测；其他版本未验证，尤其是客户端 slot API。
- 正文用等宽 `<pre>` 渲染，暂不做 Markdown。
- 长度由模型自行控制，可能略超出 800–2000 字目标。
- 记录 schema 使用最小校验对象（只要求 `parse`/`safeParse`）而不是 zod：本地目录以 linked 方式装入 profile 时解析不到 profile 的 `zod`，而 harness 只代理自己安装的 `@deepseek-ai/*`；这样插件保持零依赖。
- 视图组件只 `require('react')`，不 require 任何 DSH Client 包（官方建议，避免版本漂移与 slot 崩溃）。

## 上架到社区市场

社区列表是 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（网站 <https://awesome-dsh-plugin.com> / dsh-market 读取同一份数据）。收录要求、npm 发布、截图、注册表条目 YAML 与 PR 流程都写在 [`docs/publishing.md`](docs/publishing.md)，这里不重复。

当前准备度：

- 已满足：`dsh.bundle` manifest、真实代码、`engines.dsh`、带预发布分支的 peer 范围、`assets/icon-256.png` 市场卡片图。
- 待办：在 GitHub 仓库加 `dsh-plugin` topic、npm 发布（`npm publish --access public`）、补真实截图、仓库满 1 天后向注册表提 PR。

## 开发

```bash
npm test        # 客户端注册冒烟 + 提示词与代码同步校验
node --check index.js && node --check client.js
```

- 本地目录安装是 linked 方式：改 `client.js` 由 client-hmr 热替换；改 `index.js` 需要在插件管理里关/开该插件或重启。
- 宿主接口：`GET /handoff/doc?sessionId=<id>` 返回 `{state, text?, generatedAt?, model?, error?}`；`POST /handoff/generate` body `{sessionId}` 立即 202 并在后台生成。
- Agent 维护约定（README 入口、文档同步、验证与发布规则）见 [`AGENTS.md`](AGENTS.md)。

## 仓库结构 / 文档索引

**README 是唯一入口：每个受版本控制的文件都在下表里有用途说明。** 新增、移动或删除文件时，请同步更新此表。

| 路径 | 用途 |
| --- | --- |
| [`README.md`](README.md) | 本文件：功能、安装、使用、隐私、卸载、开发与文档入口 |
| [`AGENTS.md`](AGENTS.md) | Agent 维护约定：README 入口、文档同步、验证与发布规则 |
| [`LICENSE`](LICENSE) | MIT 许可证 |
| [`.gitignore`](.gitignore) | 忽略依赖、日志、系统/编辑器噪音与本地临时产物 |
| [`package.json`](package.json) | npm 包元数据、`dsh.bundle` / `dsh.client` 清单、测试脚本 |
| [`cordis.patch.yml`](cordis.patch.yml) | bundle patch：插入 Host 行 `id: handoff` |
| [`index.js`](index.js) | 宿主半部：两条路由、storageDomain、会话读取与转录压缩、LLM 调用、工作区快照、60 天清理 |
| [`client.js`](client.js) | 浏览器半部：`conversation.view` 交接 tab、状态机、轮询、复制、主题样式、本 tab 激活时隐藏输入框 |
| [`assets/icon-256.png`](assets/icon-256.png) | 唯一对外图标：插件管理页与社区市场卡片（GitHub 托管的位图） |
| [`assets/icon.svg`](assets/icon.svg) | 图标矢量源文件（不直接对外；改图后重新导出 `icon-256.png`） |
| [`locale/zh.json`](locale/zh.json) / [`locale/en.json`](locale/en.json) | 插件管理页的中英文标题与描述 |
| [`docs/plugin-design.md`](docs/plugin-design.md) | 已冻结的设计规格：需求、架构、数据模型、接口、里程碑、风险 |
| [`docs/handoff-prompt.md`](docs/handoff-prompt.md) | 交接提示词契约；其「提示词正文」与 `index.js` 的 `SYSTEM_PROMPT` 逐字一致（由测试校验） |
| [`docs/publishing.md`](docs/publishing.md) | 社区市场上架清单、npm 发布、截图、注册表条目与 PR 流程 |
| [`test/client-smoke.cjs`](test/client-smoke.cjs) | 客户端插件注册结构冒烟测试（零依赖） |
| [`test/prompt-sync.cjs`](test/prompt-sync.cjs) | 校验 `docs/handoff-prompt.md` 与 `index.js` 的 `SYSTEM_PROMPT` 保持同步 |
| [`.github/workflows/check.yml`](.github/workflows/check.yml) | CI：push/PR 时跑语法检查、JSON 校验与 `npm test` |

## 验证记录（DSH 0.2.2-rc.1）

- 真实生成多次（19–66 秒）；产物均为「正文即提示词」，无可粘贴外壳。
- 零会话足迹：空闲会话生成前后日志行数 332 → 332。
- 零工作区足迹：生成前后 `git status` 无新增文件。
- 60 天清理：注入 `generatedAt=0` 的测试纪录后重载插件，5 秒后删除，其余保留。
- 错误路径：不存在的会话 → POST 202 → GET 一次性返回 `{state:'error', …}`，随后回到 `idle`。
- 越界请求：错误方法 405、空 body/非法 JSON 400。
- 事实校准：生成时注入当前工作区快照与引用路径校验，提示词不再沿用转录里的旧路径或声称不存在的构建产物。

## License

[MIT](LICENSE) © dsh-handoff-tab contributors

`assets/icon.svg` 是项目原创几何矢量图（本仓库内从零绘制，未使用任何第三方图标库或素材），`assets/icon-256.png` 由它导出，两者随项目同以 MIT 许可发布，无额外署名要求。
