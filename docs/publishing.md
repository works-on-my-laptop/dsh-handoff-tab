# 发布到社区插件市场

社区列表是 [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（网站 <https://awesome-dsh-plugin.com>，dsh-market 插件市场读同一份数据）。收录规则见其 [contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)。本文记录本插件发布时需要做的事。

## 清单

| 项 | 状态 |
| --- | --- |
| `package.json` 声明 `dsh.bundle.patch` + 根目录 `cordis.patch.yml` | ✅ |
| 真实可运行代码（非占位） | ✅ |
| `engines.dsh` 兼容范围 | ✅ `>=0.2.0-rc.1 <0.3.0-0` |
| 官方包用 `peerDependencies` 且带显式预发布分支 | ✅ `>=0.2.0-rc.1 <0.2.1 \|\| >=0.2.1-rc.1 <0.2.2 \|\| >=0.2.2-rc.1 <0.3.0-0` |
| 仓库创建满 1 天（CI 自动检查） | ⏳ 2026-11-11 创建，2026-11-12 之后可提交 |
| 仓库 topic `dsh-plugin` | ⬜ 在 GitHub 仓库 About 里添加 |
| npm 发布（推荐，可免 `allowBuilds` 构建授权并进入带版本的索引） | ⬜ 需要 npm 登录 |
| 市场卡片图标：GitHub 托管的位图（SVG 会被拒） | ✅ `assets/icon-256.png`（由 `assets/icon.svg` 导出，也是插件管理页图标） |
| `screenshots.json` + 1–8 张截图（可选，推荐） | ⬜ 需补真实截图 |
| 提交条目 YAML | ⬜ 见下 |

## 步骤

### 1. 推送仓库并设置 About

```bash
git remote add origin https://github.com/works-on-my-laptop/dsh-handoff-tab.git
git push -u origin main
```

在 GitHub 仓库页 **About → Topics** 添加 `dsh-plugin`（必须），建议再加 `deepseek-harness`、`dsh`、`cordis`；Description 用 README 第一段即可。

### 2. 发布到 npm（推荐）

包名 `dsh-handoff-tab` 目前未被占用（2026-11-11 查 npm registry 返回 404）。

```bash
npm login
npm publish --access public
```

发布后确认：

```bash
npm view dsh-handoff-tab version dist.tarball
dsh plugin --profile web add dsh-handoff-tab   # 可在临时 profile 验证
```

### 3. 截图（可选，推荐）

在 DSH Web 里截 2–3 张图（建议 16:9 或 4:3）：

1. 空状态：会话 tab 行出现「交接」，正文区显示「生成交接提示词」；
2. 就绪状态：正文 + 顶部生成时间 / 重新生成 / 复制；
3. 生成中或窄屏「更多会话视图」菜单（可选）。

放到 `assets/screenshots/`，然后在仓库根加 `screenshots.json`：

```json
[
  "assets/screenshots/empty.png",
  "assets/screenshots/ready.png"
]
```

市场每晚构建时自动读取；以后换图只需推自己的仓库。

### 4. 提交条目

Fork `awesome-dsh-plugin/awesome-dsh-plugin`，新增**一个文件**：
`data/plugins/works-on-my-laptop__dsh-handoff-tab.yml`

```yaml
url: https://github.com/works-on-my-laptop/dsh-handoff-tab
name: works-on-my-laptop/dsh-handoff-tab
category: session
description:
  en: Adds a Handoff tab to the conversation view that generates a paste-ready handoff prompt for a new session in the background and stores it in the DSH storage domain, without writing workspace files or session messages.
  zh: 在会话视图新增「交接」标签页，后台生成一段可直接粘贴到新会话第一条消息的交接提示词，保存在 DSH 存储域，不写工作区文件、不往会话写消息。
icon: https://raw.githubusercontent.com/works-on-my-laptop/dsh-handoff-tab/main/assets/icon-256.png
```

然后开 PR（一个 PR 最多 3 条；只加自己的条目，不要改别人的）。CI 会检查：

- 条目数、`dsh.bundle` manifest、仓库年龄（≥1 天）、awesome-lint、README 重生成；
- 通过后由维护者对照源码审核描述准确性、分类与是否有重复条目。

合并后网站与 dsh-market 通常一天内自动收录。

### 如果没有 npm 包

可以把预构建 tarball 挂到 GitHub Release，并在条目里加：

```yaml
tarball: https://github.com/works-on-my-laptop/dsh-handoff-tab/releases/download/v0.1.0/dsh-handoff-tab-0.1.0.tgz
```

注意 `latest/download/` 只在请求时解析 `latest`，文件名带版本会在下次发版后 404；要么文件名不带版本，要么钉住 tag（如上）。

## 维护

- 发新版：改 `package.json` 的 `version` → `npm publish` → GitHub Release/tag；市场索引会自动读到新版本与下载量。
- 仓库长期不更新会被定期扫描标记，最终从列表移除。
- 收录不等于安全审查：README 顶部有官方免责声明；本插件不写工作区、不写会话事件，只调用当前默认模型并在 loopback 提供两条路由。
