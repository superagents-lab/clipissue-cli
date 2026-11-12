# clipissue

Clipissue CLI：基于官方 Linear GraphQL API 的项目与议题管理命令行工具，由 SuperAgents 维护。

独立仓库：[superagents-lab/clipissue-cli](https://github.com/superagents-lab/clipissue-cli)。CLI 可独立使用；macOS 上也能与 [Clipissue](https://clipissue.com) 菜单栏应用共用已保存的 API Key。

## 安装

需要 Node.js 18 或更新版本。目前尚未发布 npm 包，可从源码安装：

```bash
git clone https://github.com/superagents-lab/clipissue-cli.git
cd clipissue-cli
npm ci
npm link
clipissue help
```

计划发布的 npm 包名是 `@fatwang2/clipissue`，安装后的命令为 `clipissue`。包内包含预编译 JavaScript，无需在用户机器上编译 TypeScript。

## 功能

- `login` / `logout` / `whoami`：凭据管理（macOS Keychain）与身份查看
- `teams` / `projects` / `states`：列出团队、项目与工作流状态（支持 `--team`、`--query`、`--include-archived`）
- `issues` / `search` / `get` / `children` / `comments`：搜索、查看议题、子议题与评论
- `create` / `update` / `comment`：创建议题、更新字段、添加评论
- 所有命令支持 `--json` 结构化输出，适合 Agent 与脚本调用

## 自行构建二进制（免 Node）

单文件二进制（含运行时，无需 Node）由 `scripts/build-binary.sh` 构建，输出
tar.gz（内含 `clipissue` 二进制 + `skills/` 目录）。当前尚未提供预构建下载。安装后布局：

```
~/.local/bin/clipissue-cli/clipissue    # 二进制 + skills/ 同目录
~/.local/bin/clipissue                  # 软链接 → clipissue-cli/clipissue
```

- **手动安装**：构建 `clipissue-<arch>.tar.gz`，解压到 `~/.local/bin/clipissue-cli/`，
  再 `ln -sf ~/.local/bin/clipissue-cli/clipissue ~/.local/bin/clipissue`。
- **开发模式**：在独立仓库根目录运行 `node bin/link.mjs`，把 `~/.local/bin/clipissue`
  软链到源码入口（Clipissue 应用内已不再提供一键安装入口）。

## 构建二进制

```bash
./scripts/build-binary.sh           # 输出 dist-bin/clipissue-<arch>.tar.gz
```

需要 bun >= 1.4（1.3.x stable 编译产物在 macOS 27 上会被 SIGKILL，请用
`bun upgrade` 更新到 canary / 1.4+）。

## 使用

```bash
clipissue login                         # 浏览器 OAuth 登录，无需 Mac 客户端
clipissue login --no-browser            # 手动在浏览器打开终端显示的 URL
clipissue login lin_api_xxxxxxxx         # 兼容个人 API Key 登录
clipissue whoami --json
clipissue teams --json
clipissue projects --json --team ENG
clipissue states --json --team ENG   # 查状态列表，拿 stateId 供 update 使用
clipissue search "登录" --json          # 位置参数搜索；空查询会报错
clipissue issues --json --query "登录"
clipissue get ENG-123 --json
clipissue children ENG-123 --json
clipissue comments ENG-123 --json
clipissue create "修复登录超时" --team ENG --json
clipissue update ENG-123 state=Done --json   # state=<名称> 自动解析为 stateId
clipissue comment ENG-123 "已定位，待修复" --json
```

## OAuth 登录

`clipissue login` 启动本机回调服务并打开 Linear 授权页，使用 PKCE S256 与随机 state，无需 client secret。授权范围为 `read,write`，以用户身份操作。令牌到期前会自动刷新；收到 HTTP 401 时刷新并重试一次。CLI 与 Mac 客户端分别保存 OAuth 登录，互不依赖。

首次配置 OAuth 应用时，需要在 Linear 应用的 Redirect URLs 中追加以下地址，并保留 Mac 应用和云端插件的既有回调：

```text
http://127.0.0.1:52837/oauth/callback
```

默认复用 Clipissue 的公开 client ID `22203e33a70d34549ddeff09fac69098`。也可通过 `CLIPISSUE_OAUTH_CLIENT_ID` 与 `CLIPISSUE_OAUTH_REDIRECT_URI` 使用自己的应用；重定向地址必须是带端口的 `http://127.0.0.1` 地址，并在对应 Linear 应用中登记。默认回调端口被占用时，先关闭另一个登录进程再试。登录超时为三分钟，可用 Ctrl+C 取消。

`--no-browser` 仅停止自动打开浏览器，仍需浏览器能访问运行 CLI 的机器上的回调地址；它不是远程服务器的设备码登录。默认应用的本机回调必须先由维护者登记，仓库代码不会自动修改 Linear 应用设置。

## 凭据安全

- API Key 保存在 macOS Keychain（service `com.clipissue.mac` / account `linear-api-key`），与 **Clipissue 菜单栏应用共用同一条目**：一端配置两端可用。若已在 Clipissue 设置页填入 API Key，CLI 无需 `login` 即可使用。历史条目（`app.linearlite`、`com.fatwang2.linear-cli`）在读取时自动迁移到新命名空间。
- 其它平台回退到 `~/.config/clipissue/credentials.json`（0600）。
- `login <api-key>` 会把 Key 作为命令参数传入，可能留在 shell 历史和进程列表里；也可使用应用设置页保存 Key，或在自动化中通过环境变量传入。CLI 不主动打印 Key；macOS 保存时会调用系统 `security` 工具并通过参数传递 Key。
- CI 可用 `CLIPISSUE_API_KEY`（兼容旧 `LINEAR_API_KEY`）环境变量，但环境变量可见性低于 Keychain，仅限自动化场景。
- OAuth 令牌独立保存在 macOS Keychain（service `com.clipissue.cli` / account `linear-oauth`）；其它平台使用 `~/.config/clipissue/oauth.json`（0600，原子替换）。access token 与轮换后的 refresh token 一起保存，并通过跨进程锁串行刷新。macOS OAuth 保存经 stdin 传入系统工具，不把令牌放进命令参数。
- 凭据优先级：API Key 环境变量 > CLI OAuth > 已保存的 API Key。OAuth 登录不会删除客户端共享的 API Key；显式 API Key 登录会清除 CLI OAuth，从而切换认证方式。
- `clipissue whoami --json` 的 `authentication.method` 显示实际认证方式（`oauth` / `api-key`），`source` 显示来源；不会输出令牌。
- `clipissue logout` 清理本地保存的 CLI OAuth 和 API Key（包含与 Mac 客户端共用的 API Key），不会清除环境变量，也不会撤销 Linear 服务端的授权。Mac 客户端独立保存的 OAuth 不受影响。

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
- `src/credential.ts`：Keychain / 配置文件凭据管理与跨进程刷新锁
- `src/oauth.ts`：PKCE、回调服务与令牌交换
- `src/auth.ts`：认证选择与自动刷新
- `src/cli.ts`：命令解析与各命令实现
- `skills/clipissue/SKILL.md`：Agent 使用手册
- `scripts/build-binary.sh`：单文件二进制构建（bun compile）

## 开发

开发软链接指向 `bin/clipissue.mjs`，它默认**优先直接跑 `src/cli.ts`**
（Node >= 22.6 类型剥离）：改完 `src/` 立刻生效。

- Node < 22.6（不支持类型剥离）→ 自动回退 `dist/` 编译产物（需先 `npm run build`）；
- 想强制走编译产物（如验证发布物行为）→ `CLIPISSUE_USE_DIST=1 clipissue ...`。

```bash
npm ci
npm run typecheck
npm test          # 打包、在临时目录安装，并验证命令和 skills 安装
npm link
node bin/clipissue.mjs help
```

## npm 发布

`npm publish --access public` 前会自动执行类型检查与安装包测试。GitHub CI 在 Node 18、22、24 上执行相同检查。仓库不自动发布 npm，需有包发布权限的维护者手动发布；首次发布后应同步更新上面的安装说明。
