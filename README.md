# linear-cli

Linear CLI：基于官方 Linear GraphQL API 的项目与议题管理命令行工具，能力对齐本地 Cindy Linear 插件。

## 功能

- `login` / `logout` / `whoami`：凭据管理（macOS Keychain）与身份查看
- `teams` / `projects` / `states`：列出团队、项目与工作流状态（支持 `--team`、`--query`、`--include-archived`）
- `issues` / `search` / `get` / `comments`：搜索、查看议题与评论
- `create` / `update` / `comment`：创建议题、更新字段、添加评论
- 所有命令支持 `--json` 结构化输出，适合 Agent 与脚本调用

## 安装（推荐：二进制，免 Node）

单文件二进制（含运行时，无需 Node）由 `scripts/build-binary.sh` 构建，随发布物
以 tar.gz 分发（内含 `linear` 二进制 + `skills/` 目录）。安装后布局：

```
~/.local/bin/linear-cli/linear     # 二进制 + skills/ 同目录
~/.local/bin/linear                # 软链接 → linear-cli/linear
```

- **Linear Lite 菜单栏应用**：设置页「命令行工具」区块一键 安装 / 更新 / 卸载。
- **手动安装**：下载 `linear-<arch>.tar.gz`，解压到 `~/.local/bin/linear-cli/`，
  再 `ln -sf ~/.local/bin/linear-cli/linear ~/.local/bin/linear`。

## 构建二进制

```bash
./scripts/build-binary.sh           # 输出 dist-bin/linear-<arch>.tar.gz
```

需要 bun >= 1.4（1.3.x stable 编译产物在 macOS 27 上会被 SIGKILL，请用
`bun upgrade` 更新到 canary / 1.4+）。

## 使用

```bash
linear login lin_api_xxxxxxxx        # 保存到 Keychain
linear whoami --json
linear teams --json
linear projects --json --team ENG
linear states --json --team ENG   # 查状态列表，拿 stateId 供 update 使用
linear issues --json --query "登录"
linear get ENG-123 --json
linear comments ENG-123 --json
linear create "修复登录超时" --team ENG --json
linear comment ENG-123 "已定位，待修复" --json
```

## 凭据安全

- API Key 保存在 macOS Keychain（service `app.linearlite` / account `linear-api-key`），与 **Linear Lite 菜单栏应用共用同一条目**：一端配置两端可用。若已在 Linear Lite 设置页填入 API Key，CLI 无需 `login` 即可使用。
- 其它平台回退到 `~/.config/linear-cli/credentials.json`（0600）。
- Key 永不作为命令参数、永不打印；错误输出不包含请求头。
- CI 可用 `LINEAR_API_KEY` 环境变量，但环境变量可见性低于 Keychain，仅限自动化场景。
- 若要公开给其他用户，建议改为每位用户自己的 Key，或后续迁移 Linear OAuth。

## 安装 Agent 技能

CLI 自带 Agent 技能（`skills/linear-cli/SKILL.md`），可一键装到 Agent 扫描目录：

```bash
linear skills install      # 复制到 ~/.agents/skills/linear-cli
linear skills status       # 查看安装状态
linear skills uninstall    # 移除复制的技能
```

技能源按优先级定位：显式环境变量 `LINEAR_SKILL_SOURCE` → 二进制同目录
（`~/.local/bin/linear-cli/skills/...`）→ 源码包根。

目标是软链接时 `install` / `uninstall` 自动跳过（开发者用软链接指向仓库的开发模式，不会被误覆盖）。

## 结构

- `src/linear.ts`：GraphQL 客户端（错误分类：HTTP / GraphQL / 网络）
- `src/credential.ts`：Keychain / 配置文件凭据管理
- `src/cli.ts`：命令解析与各命令实现
- `skills/linear-cli/SKILL.md`：Agent 使用手册
- `scripts/build-binary.sh`：单文件二进制构建（bun compile）

## 开发（源码模式，默认）

`~/.local/bin/linear` 软链接指向 `bin/linear.mjs`，它默认**优先直接跑 `src/cli.ts`**
（Node >= 22.6 类型剥离）：**改完 `src/` 立刻生效，无需 build、无需任何步骤**。

- Node < 22.6（不支持类型剥离）→ 自动回退 `dist/` 编译产物（需先 `npm run build`）；
- 想强制走编译产物（如验证发布物行为）→ `LINEAR_USE_DIST=1 linear ...`。

```bash
pnpm install
pnpm typecheck    # 改完顺手查类型（可选）
pnpm link         # 一次性：把本地入口链接到 PATH
node bin/linear.mjs help
```
