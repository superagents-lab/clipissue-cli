# clipissue

Clipissue CLI：基于官方 Linear GraphQL API 的项目与议题管理命令行工具，能力对齐本地 Cindy Linear 插件。

## 功能

- `login` / `logout` / `whoami`：凭据管理（macOS Keychain）与身份查看
- `teams` / `projects` / `states`：列出团队、项目与工作流状态（支持 `--team`、`--query`、`--include-archived`）
- `issues` / `search` / `get` / `children` / `comments`：搜索、查看议题、子议题与评论
- `create` / `update` / `comment`：创建议题、更新字段、添加评论
- 所有命令支持 `--json` 结构化输出，适合 Agent 与脚本调用

## 安装（推荐：二进制，免 Node）

单文件二进制（含运行时，无需 Node）由 `scripts/build-binary.sh` 构建，随发布物
以 tar.gz 分发（内含 `clipissue` 二进制 + `skills/` 目录）。安装后布局：

```
~/.local/bin/clipissue-cli/clipissue    # 二进制 + skills/ 同目录
~/.local/bin/clipissue                  # 软链接 → clipissue-cli/clipissue
```

- **手动安装**：下载 `clipissue-<arch>.tar.gz`，解压到 `~/.local/bin/clipissue-cli/`，
  再 `ln -sf ~/.local/bin/clipissue-cli/clipissue ~/.local/bin/clipissue`。
- **开发模式**：在仓库 `cli/` 下 `node bin/link.mjs`，把 `~/.local/bin/clipissue`
  软链到源码入口（Clipissue 应用内已不再提供一键安装入口）。

## 构建二进制

```bash
./scripts/build-binary.sh           # 输出 dist-bin/clipissue-<arch>.tar.gz
```

需要 bun >= 1.4（1.3.x stable 编译产物在 macOS 27 上会被 SIGKILL，请用
`bun upgrade` 更新到 canary / 1.4+）。

## 使用

```bash
clipissue login lin_api_xxxxxxxx        # 保存到 Keychain
clipissue whoami --json
clipissue teams --json
clipissue projects --json --team ENG
clipissue states --json --team ENG   # 查状态列表，拿 stateId 供 update 使用
clipissue issues --json --query "登录"
clipissue get ENG-123 --json
clipissue children ENG-123 --json
clipissue comments ENG-123 --json
clipissue create "修复登录超时" --team ENG --json
clipissue update ENG-123 state=Done --json   # state=<名称> 自动解析为 stateId
clipissue comment ENG-123 "已定位，待修复" --json
```

## 凭据安全

- API Key 保存在 macOS Keychain（service `com.clipissue.mac` / account `linear-api-key`），与 **Clipissue 菜单栏应用共用同一条目**：一端配置两端可用。若已在 Clipissue 设置页填入 API Key，CLI 无需 `login` 即可使用。历史条目（`app.linearlite`、`com.fatwang2.linear-cli`）在读取时自动迁移到新命名空间。
- 其它平台回退到 `~/.config/clipissue/credentials.json`（0600）。
- Key 永不作为命令参数、永不打印；错误输出不包含请求头。
- CI 可用 `CLIPISSUE_API_KEY`（兼容旧 `LINEAR_API_KEY`）环境变量，但环境变量可见性低于 Keychain，仅限自动化场景。
- 若要公开给其他用户，建议改为每位用户自己的 Key，或后续迁移 Linear OAuth。

## 安装 Agent 技能

CLI 自带 Agent 技能（`skills/clipissue/SKILL.md`），可一键装到 Agent 扫描目录：

```bash
clipissue skills install      # 复制到 ~/.agents/skills/clipissue
clipissue skills status       # 查看安装状态
clipissue skills uninstall    # 移除复制的技能
```

技能源按优先级定位：显式环境变量 `CLIPISSUE_SKILL_SOURCE` → 二进制同目录
（`~/.local/bin/clipissue-cli/skills/...`）→ 源码包根。

目标是软链接时 `install` / `uninstall` 自动跳过（开发者用软链接指向仓库的开发模式，不会被误覆盖）。

## 结构

- `src/linear.ts`：GraphQL 客户端（错误分类：HTTP / GraphQL / 网络）
- `src/credential.ts`：Keychain / 配置文件凭据管理
- `src/cli.ts`：命令解析与各命令实现
- `skills/clipissue/SKILL.md`：Agent 使用手册
- `scripts/build-binary.sh`：单文件二进制构建（bun compile）

## 开发（源码模式，默认）

`~/.local/bin/clipissue` 软链接指向 `bin/clipissue.mjs`，它默认**优先直接跑 `src/cli.ts`**
（Node >= 22.6 类型剥离）：**改完 `src/` 立刻生效，无需 build、无需任何步骤**。

- Node < 22.6（不支持类型剥离）→ 自动回退 `dist/` 编译产物（需先 `npm run build`）；
- 想强制走编译产物（如验证发布物行为）→ `CLIPISSUE_USE_DIST=1 clipissue ...`。

```bash
pnpm install
pnpm typecheck    # 改完顺手查类型（可选）
pnpm link         # 一次性：把本地入口链接到 PATH
node bin/clipissue.mjs help
```
