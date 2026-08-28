---
name: linear-cli
description: >-
  Use this skill whenever the user wants to manage Linear projects and issues —
  list teams or projects, search/view/create/update issues, or view/add comments —
  via the official Linear GraphQL API. Trigger phrases include "linear", "Linear 议题",
  "工单", "项目进度", "issues", "ENG-123", "创建议题", "更新议题", or any task that should
  go through the user's Linear workspace. Always prefer the `linear` CLI over
  hand-crafted curl/HTTP requests. When creating or updating issues, follow the
  skill's 议题运营规范: requirements in description, progress in comments, keep state
  current, always attach a project, use sub-issues for breakdown (not comment TODOs),
  and never leave unfinished work on Done issues.
---

# Linear CLI

Linear CLI wraps the official Linear GraphQL API for project and issue management. This skill teaches an agent how to call it.

## 何时使用

用户请求落在以下场景之一时使用：

- 查看 Linear 用户/组织、团队、项目；
- 搜索、查看、创建或更新议题；
- 查看或给议题添加评论；
- 提到「Linear」「issue」「工单」「项目进度」「ENG-123」等。

## 前置检查

每次使用前按顺序确认：

1. `command -v linear` — CLI 已安装（Linear Lite 设置页「命令行工具」一键安装，或手动下载二进制解压到 `~/.local/bin/linear-cli/`）。
2. `linear whoami --json` — 已登录且 API Key 有效。失败时停下：若用户已在 **Linear Lite**（菜单栏应用）设置页填过 API Key，CLI 与它共用同一 Keychain 条目，直接可用、无需重新登录；否则让用户运行 `linear login <api-key>`，**不要自己编 key 试**，也不要把 key 当参数传给其它命令。

## 通用约定

- **Agent 一律加 `--json`**：所有命令支持，输出结构化 JSON 便于解析。
- 失败统一输出 `{"success":false,"error":"..."}` 并以非 0 退出码退出。
- CLI 完全 non-interactive，可在脚本中安全使用。
- 凭据来源优先级：`LINEAR_API_KEY` 环境变量 > macOS Keychain > 非 macOS 配置文件。macOS 上 Keychain 与 **Linear Lite（菜单栏应用）共用同一位置**（service `app.linearlite` / account `linear-api-key`）：用户在 Linear Lite 设置页填入的 API Key，CLI 直接可用，反之亦然。Key 永不作为 CLI 参数，永不打印。
- 写操作（create / update / comment）会改变 Linear 外部状态，执行前先向用户说明将修改什么；结果 `success:false` 且错误为网络/超时时，不要盲目重试（执行状态未知）。

## 议题运营规范（必须遵守）

Agent 创建、更新、评论议题时按下列分工与约束操作，不要用评论当待办清单、也不要把进度写进 description。

| 内容 | 放哪里 | 怎么做 |
| --- | --- | --- |
| 需求本身、验收标准、背景补充 | **description** | `create`/`update` 用 `description=...`；后续补充改 description，不要另开评论堆需求 |
| 进展、决策记录、阻塞说明、阶段性结果 | **comment** | `linear comment <id> "..."`；只记「发生了什么」，不列未完成 checklist |
| 工作流位置 | **state** | 有实质进展就同步改 `stateId`（Todo → In Progress → In Review → Done 等） |
| 可独立完成的拆分项 | **sub-issue** | `create ... parentId=<父议题 UUID>`；用子议题拆解，而不是在评论里写 `- [ ]` 待办 |

硬性约束：

1. **必须挂 Project**：新建议题一律带 `projectId=<uuid>`（先 `linear projects --json` 取 id）。已有议题若 `project` 为空，更新时补上，不要留下无项目议题。
2. **状态保持新鲜**：开始做 → `started` 类状态；交付/关闭 → `completed`/`canceled`。不要长期停在 Todo 却已在推进，也不要 Done 后还靠评论追尾活。
3. **Done 不留尾巴**：标记完成（`completed`）前，确认该议题（含其未关闭子议题）没有未完成事项。若发现遗留工作：**先另建新议题（或子议题）追踪剩余项，再把当前议题标 Done**；不要在 Done 议题的 description/评论里留「还剩…」清单。
4. **拆解用 sub-issue，不用评论待办**：多步骤、可并行或需单独跟进的工作，创建子议题并挂同一 `projectId`；评论只用于进度与讨论。禁止用评论维护 checkbox / TODO 列表作为唯一追踪手段。
5. **description vs comment**：改需求/范围 → 更新 description；汇报「做到哪了」→ 发 comment。两者不要混用。

示例：

```bash
# 新建（必带 project；可挂父议题做拆解）
linear create "实现登录超时重试" --team ENG \
  projectId=<project-uuid> description="验收：超时后自动重试 3 次并提示用户" --json

linear create "补充超时埋点" --team ENG \
  projectId=<project-uuid> parentId=<父议题-uuid> --json

# 补充需求 → 改 description；推进进度 → 改状态 + 评论
linear update ENG-123 description="…更新后的验收标准…" --json
linear update ENG-123 stateId=<started-state-uuid> --json
linear comment ENG-123 "已合入重试逻辑，待 QA 回归超时场景" --json

# 关闭前：剩余工作先拆成新议题，再 Done
linear create "登录超时：补充 metrics dashboard" --team ENG projectId=<project-uuid> --json
linear update ENG-123 stateId=<completed-state-uuid> --json
```

## 命令速查

### 账号

```bash
linear login <api-key>     # 保存 API Key 到 Keychain（与 Linear Lite 共用同一条目）
linear logout              # 删除已保存的 Key
linear whoami --json       # 当前用户 + 组织
```

### 只读

```bash
linear teams --json [--first N]
linear states --json [--team KEY] [--first N]   # 列工作流状态（拿到 stateId 供 update 用）
linear projects --json [--team KEY] [--query TEXT] [--include-archived] [--first N]
linear issues --json [--query TEXT] [--team KEY] [--first N]
                     [--state "Todo,In Progress"] [--top-level]
                     [--completed-after ISO] [--completed-before ISO]
linear search <query> --json        # issues --query 的别名
linear views --json [--first N]     # 列出自定义视图
linear view <name|id> --json [--first N]   # 某个视图里的议题
linear get ENG-123 --json [--first N]      # 或 UUID；含评论（默认 50 条）
linear comments ENG-123 --json [--first N] # 只拉评论，按 createdAt 升序
```

`issues` 返回 `project`、`parent`、`completedAt`，配合下列过滤器可直接产出周期报表：

- `--state` 按状态名过滤，逗号分隔（`Todo,In Progress,In Review`）。
- `--top-level` 只要顶层议题（`parent` 为空），避免子任务重复计数。
- `--completed-after` / `--completed-before` 按完成时间取窗口，值是 ISO 时间戳，语义为 `gte` / `lt`。
- `--first` 在 `issues` 上限 250（`teams` / `projects` 仍是 50）。

这些过滤器只作用于列表查询；带 `--query` 时走 Linear 全文搜索，过滤器不生效。

```bash
# 昨日完成（Asia/Shanghai 当天窗口换算成 UTC 后传入）
linear issues --json --top-level \
  --completed-after 2026-08-04T00:00:00.000Z \
  --completed-before 2026-08-05T00:00:00.000Z --first 250

# 当前任务池
linear issues --json --top-level --state "Todo,In Progress,In Review" --first 250
```

`states` 返回 `{ id, name, type, position }`，`type` 是 `triage` / `backlog` / `unstarted` / `started` / `completed` / `canceled` 之一，`position` 可用来按列排序。`--team` 给出该团队的状态列（推荐：不同团队状态集可能不同）；不传则列出工作区全部状态。更新状态时把目标状态的 `id` 传给 `update`：`linear update ENG-123 stateId=<uuid>`。

`view` 的参数可以是视图名或 UUID，传名字时先精确匹配再忽略大小写匹配；返回 `{ view, issues }`，issues 字段与 `linear issues` 一致。脚本里要区分「视图不存在」和「视图为空」时，先 `linear views` 拿到 name→id 映射，再按 id 取，别依赖错误文案。

`get` 带 `comments` 数组（正文、作者、时间、`parent.id` 表示回复）。只要讨论内容时用 `comments`，不必再拆 `get`。`--first` 上限 250、默认 50，取较新的 N 条再按 `createdAt` 升序排出；评论很多时加大 `--first`，不要假设一次拿全。`comments` 返回 `{ issue, comments }`；议题不存在时报错，没有评论时 `comments` 为空数组。作者优先 `user`，其次 `externalUser`（Slack 等），再其次 `botActor`（Agent / 机器人）。

### 写操作（先确认再执行；并遵守上方「议题运营规范」）

```bash
linear create "<title>" --team KEY [field=value ...] --json
linear states --json --team KEY                 # 先查状态，拿目标 stateId
linear update ENG-123 stateId=<uuid> --json     # 支持 title/description/stateId/assigneeId/priority/projectId/parentId 等
linear comment ENG-123 "<body>" --json

`create` / `update` 的 field=value 会原样传给 Linear GraphQL。常用字段：
- `projectId` — **必填（运营规范）**，先 `projects` 取 id
- `parentId` — 子议题挂到父议题 UUID（拆解用，不要用评论列待办）
- `description` — 需求与验收；`stateId` — 工作流；进度细节用 `comment`
- `assigneeId` / `priority` 等

`priority` 在 Linear GraphQL 里是 Float，CLI 会把数值字段（priority / estimate / sortOrder）
自动转成 JSON 数字，直接 `priority=2` 即可；非数字会报错并提示取值。
priority 取值：0=none 1=urgent 2=high 3=medium 4=low。
```

## 技能自管理

`linear` 自带本 Agent 技能。执行前可检查技能是否已安装：

```bash
linear skills status --json     # installed / symlink / path
linear skills install           # 复制到 ~/.agents/skills/linear-cli
linear skills uninstall         # 移除复制的技能
```

目标是软链接时 `install` / `uninstall` 自动跳过——那是开发者用软链接指向仓库的开发模式，不要覆盖。

## 工作流提示

- 创建议题前先 `linear teams --json` 拿 `key`，再 `linear projects --json` 拿目标 `projectId`；**没有 project 不要 create**。
- 需要拆解时先建/确认父议题，再 `create ... parentId=<uuid> projectId=<uuid>`；不要把拆解项写成评论 checklist。
- 更新状态前先 `linear states --json --team <key>` 拿到目标 `stateId`（不同团队状态集可能不同，务必带 `--team`），再 `linear update <id> stateId=<uuid>`；或先 `linear get <id> --json` 看当前 `state`。不要猜测状态名或让用户手查。
- 标 Done 前扫一眼 description / 未关闭子议题：有尾巴就先新建议题追踪，再 completed。
- 输出过大时用 `--first` 收窄；查不到项目时先确认 team key 拼写。
