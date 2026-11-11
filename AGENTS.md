# AGENTS.md — Agent 维护约定

本文件约束所有在本仓库工作的 AI agent。用户当次指令优先于本文件；没有特别说明时按下面执行。

## 1. README 是唯一入口

- `README.md` 是本仓库的入口文档：安装、使用、隐私、开发、文档索引都在里面。
- **不允许孤立文件或孤立文档。** 新增、移动、删除任何受版本控制的文件（含 `docs/`、`test/`、`assets/`、`.github/`、`locale/`）时，必须同步更新 README 末尾的「仓库结构 / 文档索引」表。
- 每个文件/目录都要能在 README 的索引里找到一行用途说明；文档之间用相对路径互链，不留死链。
- 改 README 时保持它面向使用者（安装/使用/隐私优先），内部约定放 `docs/` 或本文件。

## 2. 文档与代码同步

- `index.js` 的 `SYSTEM_PROMPT` 与 `docs/handoff-prompt.md` 的「提示词正文」必须**逐字一致**。
- 修改任一处时必须同步另一处，并把 `index.js` 的 `PROMPT_VERSION` 加 1（已存文档用它标记提示词版本）。
- `npm test` 里的 `test/prompt-sync.cjs` 会校验一致性；CI 也会跑。

## 3. 提交前验证

```bash
node --check index.js
node --check client.js
npm test          # 客户端注册冒烟 + 提示词同步校验
```

- 改了 `client.js`：在 DSH Web 里强刷，检查空状态、生成中、就绪、复制、深/浅主题。
- 改了 `index.js`：重载插件（插件管理里关/开）后，用 `POST /handoff/generate` + `GET /handoff/doc` 走一遍；确认会话日志行数不变、工作区无新增文件。
- 文档改动（含本文件）：确认 README 索引仍完整。

## 4. 运行期硬约束

- 插件运行期**不写工作区文件**、**不往会话追加消息/命令卡片/事件**；数据只进 `ctx.storageDomain`（`$DSH_HOME/storages/dsh_handoff_tab.json`）。
- 固定标识不可改：patch 行 id `handoff`、存储域 `dsh_handoff_tab`、表 `documents`、tab id `handoff`、路由 `GET /handoff/doc` 与 `POST /handoff/generate`。
- 入口只有 tab：不加斜杠命令、dock 按钮、自动切 tab、历史版本或第二个操作按钮。
- 保持零运行时依赖、无构建步骤；官方 `@deepseek-ai/*` 包用 `peerDependencies`，范围必须带显式预发布分支（参考 `package.json` 现有写法）。
- 安装、重启、npm 发布、修改仓库设置等有副作用的操作，先征得用户同意。

## 5. 发布

- 版本号按语义化版本；发版：改 `package.json` 的 `version` → `npm publish` → 打 tag / GitHub Release。
- 社区市场（awesome-dsh-plugin 注册表）的收录要求、条目 YAML 与提交流程见 `docs/publishing.md`；改发布流程时同步该文档。
