# AgentFlow 交接文档（HANDOVER）

> **最后更新**：2026-10-25
> **关键数据规模**：npm workspaces monorepo，9 个子包；79 个源码/文档文件（不含 node_modules/dist）；约 5628 行 TS/TSX；12 个测试文件 107 个测试；磁盘会话存档 6 个 JSONL（`~/.agent-flow/sessions/`）；WorkBuddy 真实数据冒烟产生过 1029 个事件 / 18 个会话。
> 本文档由上一轮开发者（AI）基于代码现状撰写；所有「实测通过」均在撰写当日复跑确认。发现文档与代码不符时：**以代码为准，改本文档**（见第 10 节）。

---

## 0. 30 秒速览

**一句话**：AgentFlow 是一个本机常驻的可视化平台——把多个 AI Agent 客户端（ZCode/Claude Code、Codex CLI、WorkBuddy、DeepSeek Harness、任意 JSONL 日志）执行过程中的事件（提问/计划/工具调用/说明/收尾）翻译成统一协议 `AgentEvent`，实时生成「故事线 + 流程图（DAG）」面板，支持会话回放，会话落盘为 append-only JSONL。

**四个关键路径**：

| 什么 | 绝对路径 |
|---|---|
| 源码目录（本仓库根） | `C:\Users\Mr.Mouse\.zcode\workspace\4f21c839-6db2-4dcb-aee5-6ca5a977019a\agent-flow` |
| 原始数据（被监视的各客户端数据） | `~/.workbuddy/`（审计日志/变更索引/侧栏快照）、`~/.codex/sessions/`（Codex rollout） |
| 数据产物（本项目的会话存档） | `C:\Users\Mr.Mouse\.agent-flow\sessions\<sessionId>.jsonl` |
| 程序入口 | `apps/cli/src/bin.ts`（CLI：start/demo/install/uninstall/skill/open）；服务库入口 `packages/server/src/main.ts`；前端 `packages/web/`（构建产物 `packages/web/dist/` 由 server 静态托管） |

**接手后第一件事**：按第 9 节重启守护进程并跑全量基线（当前 4765 端口上跑的还是修复前的旧代码），确认 107/107 后再动任何代码。

---

## 1. 环境坑（先读这个，每一条都实际踩过）

| 编号 | 坑 | 后果（具体报错/现象） | 规避方法（具体做法） |
|---|---|---|---|
| E1 | 在包目录跑 `tsc`（无 `noEmit`）会在源码旁原地发射 `.js`，vitest 解析 `../src/index.js` 时**优先命中陈旧 .js 而不是 .ts** | 测试静默跑旧代码：新加的测试失败、报错信息与源码对不上（如 `expected 'ok' to be 'running'`，但源码明显会返回 'running'）。曾导致一轮排查完全跑偏 | 已根治：`tsconfig.base.json` 加了 `"noEmit": true`，并清空过全部寄生 `.js`。日常只用 `npm run typecheck`（内部全部 `-p <pkg>`，受 noEmit 保护）。**永远不要**手跑 `tsc -b` 或去掉 noEmit；若怀疑中招：`find packages adapters apps -name "*.js" -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*plugin*"`，非零结果就是中招，删掉这些 .js 再跑测试 |
| E2 | JSDoc/块注释里出现 `*/` 字符序列（如 glob `**/*.jsonl`、路径 `*/sidebar-...`）会**提前终止注释** | esbuild（vitest 用）宽容不报错，`tsc` 报一串 `TS1127: Invalid character` + `TS1109` 级联错误，报错行列指向注释内部。本会话踩了两次 | 注释里不写 `*/`：glob 写成「按日期嵌套的 .jsonl」，路径示例拆行写。看到 TS1127 指向注释行，先查注释内容 |
| E3 | chokidar **v4 不支持 glob**，`chokidar.watch(['a','dir/*','b'])` 里的 glob 被当字面路径，**静默忽略、无任何报错** | WorkBuddy watcher 的侧栏快照 glob 从不触发事件（探针实测 `ADD` 不出现）。codex/generic 的测试没暴露它是因为它们只 watch 纯目录 | 不用 glob。workbuddy watcher 的做法：启动时 `readdirSync(home)` 显式发现 profile 目录并 `watcher.add(具体文件)`，`setInterval(5s)` 重扫新目录（见 `adapters/workbuddy/src/watcher.ts` 的 `scanSnapshots`） |
| E4 | `fastify.inject`（light-my-request）在客户端就把 URL 里的 `/..` 规范化掉 | 通过 inject 测路径穿越时，`/../package.json` 到达处理器前已被改成 `/package.json`，穿越检查根本不执行（实测 inject 返回 200） | 路径穿越逻辑抽成纯函数测：`packages/server/src/index.ts` 的 `resolveWithin(root, rel)` 有专门单测；真实 socket 行为用 `curl --path-as-is` 验证（实测返回 404） |
| E5 | Git Bash 的 `/tmp` 映射到 `%TEMP%`，即 `C:\Users\MR3B6F~1.MOU\AppData\Local\Temp\`（8.3 短路径） | 临时脚本里写相对 import（如 `./packages/...`）会 `MODULE_NOT_FOUND`（脚本真实位置在 Temp 下）；Node 代码里传给 chokidar 的路径要用短名或绝对路径都能工作 | 需要相对 import 的临时探针脚本放在**仓库根目录内**（命名 `*.tmp.ts`，用完删）；给 watcher 传路径用 `C:/Users/MR3B6F~1.MOU/AppData/Local/Temp/...` 短名形式可行 |
| E6 | `npx tsx -e "import ... from './x.js'"` ESM 内联脚本**静默不执行**：exit 0、无输出、无报错 | 冒烟时 watcher「跑完了」但一个事件都没发出（codex 与 workbuddy 各踩一次），极易误判为 watcher 坏了 | 不用 `tsx -e` 写 import 逻辑；写临时脚本文件（`xxx.tmp.ts`）再 `npx tsx xxx.tmp.ts`，用完删除 |
| E7 | Git Bash 里 `curl -d '{"title":"中文"}'` **内联中文以 GBK 字节发出** | server 按 UTF-8 解析，中文变乱码入库（实测 `用户：交接冒烟` 存成乱码并在面板显示乱码） | 中文/非 ASCII payload 一律写 UTF-8 文件再发：`curl ... --data-binary @file.json`（heredoc 写出的文件是 UTF-8，实测正常）。注意服务端本身 UTF-8 无问题——WorkBuddy 真实数据冒烟中文全部正常 |
| E8 | `VAR=x cmd1 & cmd2` / 多条命令串行时，**环境变量前缀只作用于紧跟的那一条命令** | 冒烟 watcher 没带 `AGENT_FLOW_PORT`，默认 POST 到 4765（用户的 live 实例），造成数据泄漏（本会话发生过两次，一次靠旧版 schema 拒绝、一次清理了磁盘文件才兜住） | 每条要环境变量的命令都**单独**加前缀；冒烟一律用 `AGENT_FLOW_PORT=4799` + 临时 `AGENT_FLOW_HOME`；冒烟完用 `netstat -ano | grep :4799` 找 PID `taskkill //F //PID <pid>`，并检查 4765 有没有混入测试会话 |
| E9 | `npm run demo -- --speed=20` 的 `--speed` 被 npm 吞掉 | 实测仍按 4x 播放（输出显示「4x 速度」） | 直接调 CLI：`AGENT_FLOW_PORT=4799 npx tsx apps/cli/src/bin.ts demo --speed=20`（实测正常） |
| E10 | 会话里抓取 GitHub 网页用 WebFetch 报证书错误 | `fetch failed: unable to verify the first certificate ... UNABLE_TO_VERIFY_LEAF_SIGNATURE` | 用会话内置的 web reader 工具，或 `curl -s <url>`（本项目机器上 curl 可正常抓 GitHub discussions） |
| E11 | Git Bash 无 `hexdump` | `hexdump: command not found` | 用 `od -c` |
| E12 | Windows 控制台按 GBK 显示，UTF-8 输出乱码 | curl 返回的中文标题、`taskkill`/`netstat` 输出在终端显示乱码 | **仅显示问题**，服务端存储与 API 返回均为正确 UTF-8（用 `node -e` 处理 JSON 或看网页面板即正常），不要因此「修」服务端 |

---

## 2. 架构与数据流

### 2.1 数据流图

```
 ZCode/CC skill（AI 自述上报）──┐
 ZCode/CC hooks（未安装，可选）──┤
 Codex notify.cjs（回合完成）────┤
 Codex sessions watcher ────────┤        HTTP POST /api/events
 WorkBuddy 三源 watcher ────────┼────► packages/server (Fastify, 127.0.0.1:4765)
 ds-harness telemetry 插件 ─────┤            │  zod 校验 → sanitizeEvent 截断
 generic 日志 watcher ──────────┘            │  → SessionStore（幂等去重 + JSONL 落盘 ~/.agent-flow/sessions/）
                                             │  → buildGraph（inference 纯函数，每会话）
                                             ▼
                              WebSocket /ws 广播（hello/sessions/event/session-end）
                                             ▼
                              packages/web（React + React Flow + elkjs）
                              故事线视图 / 流程图视图 / 详情面板 / 回放（本地按事件重放 buildGraph）
```

### 2.2 模块接口速查

| 模块文件 | 关键函数/入口 | 一句话说明 |
|---|---|---|
| `packages/protocol/src/types.ts` | `AgentEvent`/`Graph`/`SessionSummary`/`WsServerMessage` | 全系统唯一契约：事件、图、会话摘要、WS 消息的类型定义 |
| `packages/protocol/src/schema.ts` | `agentEventSchema`、`parseAgentEvent`、`sanitizeEvent`、`truncateDeep` | zod 校验 + 入库前深截断（字符串 2000/数组 50/深度 6/循环引用） |
| `packages/protocol/src/fixtures.ts` | `demoSession`、`demoSession2` | 演示会话数据（ts 为相对偏移），demo 推送与多处测试共用 |
| `packages/server/src/index.ts` | `createApp(opts)`、`startServer(opts)`、`resolveWithin(root,rel)`、`MIME` | Fastify 应用：`POST /api/events`、`GET /api/sessions[/:id/events|/graph]`、`DELETE /api/sessions/:id`、`/ws` 升级、静态托管 `packages/web/dist`（SPA 回退） |
| `packages/server/src/store.ts` | `SessionStore`：`append/get/summaries/remove`、`isValidSessionId` | 内存索引 + append-only JSONL 落盘；按 id 幂等去重；sessionId 白名单 `[A-Za-z0-9._-]+` 防路径穿越；`summaries()` 取全量极值时间戳 |
| `packages/inference/src/index.ts` | `buildGraph(events): Graph` | 纯函数：事件流 → 节点/边/why/计划分组（幂等，同输入同输出） |
| `packages/web/src/live.ts` | `LiveClient`、`reduceLive`、`appendEvent`、`mergeEvents` | WS 客户端（1s/2s/4s 退避重连，重连成功自动补拉当前会话历史）+ 纯 reducer |
| `packages/web/src/useReplay.ts` | `useReplay(events, engaged)` | 回放控制器：滑杆=事件序号，本地 `buildGraph(slice)` 重算 |
| `packages/web/src/story.ts` | `buildStory(graph, events)` | 故事线数据构造（总结话术、承接关系、补救标记） |
| `packages/web/src/Canvas.tsx` + `layout.ts` | `computeLayout(graph, prevIds)` | React Flow 画布；elkjs 分层布局（plan-item 为 compound 节点，纵向生长用隐形排序边） |
| `apps/cli/src/bin.ts` | `main()`：start/demo/install/uninstall/skill/open | CLI；`start` 幂等（已有实例在线则复用并开面板）；自动按需启动 codex/workbuddy watcher |
| `adapters/zcode/src/installer.ts` | `installZcode/uninstallZcode/hookScriptPath` | 写 `~/.zcode/cli/config.json` 的 hooks（先备份、幂等、可卸载）；`hook.cjs` 为零依赖 hook 脚本 |
| `adapters/codex/src/watcher.ts` | `mapCodexLine`、`startCodexWatcher` | tail `~/.codex/sessions`（增量 offset+半行缓冲）；支持真实 rollout 信封格式 + 顶层扁平旧格式 |
| `adapters/codex/notify.cjs` | `notifyToEvent` | Codex notify 回调脚本（argv JSON → turn_end） |
| `adapters/workbuddy/src/mapper.ts` | `mapAuditRecord`、`mapChangesDoc`、`mapChangeEntry`、`readSidebarItems` | WorkBuddy 三源数据 → AgentEvent 纯映射 |
| `adapters/workbuddy/src/watcher.ts` | `startWorkbuddyWatcher` | audit-log JSONL tail + changes-index 整文件重写去重 + 侧栏快照（显式发现 profile 目录 + 5s 重扫，见 E3） |
| `adapters/ds-harness/plugin/mapper.js` | `mapDshEvent(record, sessionId, now)` | dsh 会话事件（`{seq,time,type,data}`）→ AgentEvent 纯映射（附 `mapper.d.ts`） |
| `adapters/ds-harness/plugin/index.js` | `name/inject/apply(ctx)` | Cordis 插件：`ctx.on('session/event')` → 250ms 批量 POST server |
| `adapters/generic/src/watcher.ts` | `mapGenericLine`、`startGenericWatcher` | 兜底：监视任意目录的 JSONL（行约定见该包 README） |

### 2.3 判定逻辑的地基（改任何映射/推理前必读）

**AgentEvent 协议**（`packages/protocol/src/types.ts`）：`{ id, ts(ms), sessionId, adapter, phase, tool?, title, files?, input?, output?, planItems?, status?('ok'|'error'), raw? }`；`phase ∈ user_prompt | plan | tool_start | tool_end | turn_end | note`；`adapter ∈ zcode | codex | ds-harness | workbuddy | generic | demo`。**id 是全系统去重键**：server 端 `SessionStore` 按 `(sessionId, id)` 幂等去重，各 adapter 都必须生成确定性 id（重启重读不重复）：
- zcode hook：`zcode:<sessionId>:<ts36><random6>`（hook 场景无需跨重启幂等）
- codex：`codex:<sessionId>:<lineNo>`（行号确定性 ✓）
- workbuddy：`wb:aud:<记录uuid>` / `wb:chg:<change.id>` / `wb:title:<sessionId>` / `wb:state:<sessionId>:<updatedAt>`
- ds-harness：`dsh:<sessionId>:<seq>`（事件日志 seq 确定性 ✓）

**buildGraph 推理规则**（`packages/inference/src/index.ts`，全部启发式、有单测）：
1. 事件按 id 去重 + 按 `ts` 稳定排序（同 ts 按 id）——**同毫秒事件靠排序位置定先后**（勿改回 ts 严格比较，E 曾因此丢边）；
2. `tool_start`/`tool_end` 回溯配对（同 tool、files 相容；孤立 start → `running`，孤立 end → 独立节点）；
3. plan 事件 → plan-item 节点（按文本去重）；步骤归属：分批快照按时间区间，同批快照按数量等分；plan 状态 = 名下无步骤 `pending` / 有未配对 start `running` / 否则 `ok`（历史失败不传染到 plan，失败显示在步骤节点本身）；
4. 边优先级 `verify > read-edit > contains > seq`：read-edit = Edit/Write 与共享文件的最近一次 Read（同毫秒也能连）；verify = 验证类命令（`VERIFY_RE=/test|spec|vitest|jest|pytest|build|lint|tsc|compile/i`）收上个验证节点之后的全部编辑；seq 兜底连前驱；
5. `why` 三来源拼接：`user`（user_prompt 的 input.prompt）→ `plan`（归属的计划条目）→ `tool-input`（事件 input 的 `why` 字段优先，其次 command，其次 JSON 全文），UI 必须如实标注来源。

**会话状态机**：`turn_end` → `ended`；之后任何新事件 → 翻回 `live`（store 逐事件覆写）。`SessionSummary.firstTs/lastTs` 取全量极值（非插入序首尾——E 曾导致 `lastTs < firstTs`）。

---

## 3. 已验证状态 vs 未验证状态

| 验证项 | 当前成绩 | 怎么复跑（在仓库根 `C:\Users\Mr.Mouse\.zcode\workspace\4f21c839-6db2-4dcb-aee5-6ca5a977019a\agent-flow` 下） |
|---|---|---|
| 全量单元/集成测试 | **实测通过**：107/107（12 个文件）。注意：8 次全量运行中观察到 1 次偶发失败，疑似负载下 watcher 端到端时序（workbuddy/codex 的 e2e 用 chokidar 轮询 + 固定 sleep）；连续 4 次复跑全绿 | `npx vitest run` |
| 类型检查 | **实测通过**：9 个包（protocol/inference/server/cli/zcode/codex/generic/workbuddy/ds-harness）零错误 | `npm run typecheck` |
| 前端构建 | **实测通过**：vite 5.4.21 构建成功（约 15s，产物 hash 形如 `index-DszdTwso.js`） | `npm run build -w packages/web` |
| HTTP API 全生命周期 | **实测通过**（临时端口 4799）：health `{"ok":true}`、批量 POST `{"accepted":2,"rejected":0}`、sessions 摘要、graph 节点、`DELETE` 返回 `{"ok":true}` 且删后 404/列表消失、静态 `/` 返回 200、`curl --path-as-is /../package.json` 返回 404 | 见第 5 节「服务冒烟」 |
| demo 推送 | **实测通过**：18 个事件全部入库（skill 风格场景，会话摘要 adapter 显示 `zcode` 属正常——场景模拟的就是 zcode 会话） | `AGENT_FLOW_PORT=4799 npx tsx apps/cli/src/bin.ts demo --speed=20`（先起一个 4799 server；**不要**对 4765 跑，会往真实面板推演示会话） |
| WorkBuddy watcher（真实数据） | **实测通过**：对 `~/.workbuddy` 数据副本跑出 1029 事件 / 18 会话，标题正常（如「BH优化修复」278 事件），图含 40 条 read-edit 边、101 条 verify 边 | `npx vitest run adapters/workbuddy`（单测含端到端）；真实数据冒烟步骤较繁（临时 home 拷贝 + 临时 server），需要时可参照本文档 E8 的隔离原则重现 |
| Codex watcher 解析（真实格式） | **实测通过**（单测 + 构造假 rollout 文件的端到端）；**未实测**：本机 `~/.codex/sessions` 为空目录，没喂过真实 Codex 产生的文件 | `npx vitest run adapters/codex` |
| ZCode hook（真实进程） | **实测通过**：单测起真实 node 进程走 stdin→POST→exit 0 无 stdout 全链路 | `npx vitest run adapters/zcode` |
| ZCode hooks 安装器 | **实测通过**（单测覆盖写配置/备份/幂等/卸载）；**注意**：本机当前**没有安装** hooks（`~/.zcode/cli/config.json` 无 agent-flow 条目），实际接入走的是 skill 模式 | `npx vitest run adapters/zcode`；安装本身：`npx tsx apps/cli/src/bin.ts install` |
| skill 上报链路 | **实测通过**（间接）：本会话的事件经 skill 约定 POST 到 4765 并正常显示（会话 `af-op7fix`） | 面板 `http://127.0.0.1:4765` 查看历史会话；skill 本体在 `~/.zcode/skills/agent-flow/SKILL.md` |
| ds-harness 插件 | **实现了但未实测（端到端）**：映射器 7 个单测全绿；插件订阅/上报逻辑按官方文档实现，但**本机未安装 dsh，无法真机验证**。属「按参考推断」，字段别名做了兼容 | `npx vitest run adapters/ds-harness`（仅映射器）；真机验证步骤见 `adapters/ds-harness/README.md` |
| 守护进程自启（开机启动） | **纯假设/未实现**：spec 提到「Windows 开机自启」，代码里没有对应实现，目前靠手动 `npm run start` 常驻 | 无 |
| WorkBuddy 对话正文解析 | **明确不做**：正文在 `~/.workbuddy/workbuddy.db`（SQLite，运行中被应用锁），零依赖原则下不碰 | 无 |

**信任地基**：`packages/protocol`（zod 校验 + sanitize 截断）+ `SessionStore` 幂等去重 + `buildGraph` 幂等性测试。**改动后必须重跑的校验**：
- 改 `packages/protocol/**` → `npx vitest run`（全部包都依赖它）**且** `npm run build -w packages/web`（web 打包时直接引用其源码）；
- 改 `packages/inference/**` → `npx vitest run packages/inference packages/web`；
- 改 `packages/server/**` → `npx vitest run packages/server` + 第 5 节服务冒烟；
- 改 `adapters/*/src/**` → `npx vitest run adapters/<对应包>`。

---

## 4. 已知边界与局限性（不要对用户过度承诺）

**输入数据里没有什么**：
1. **WorkBuddy 会话没有用户提问原文、没有 AI 计划**——正文在 SQLite（运行中被锁）。因此 WorkBuddy 会话的 `user_prompt` 是**侧栏标题合成**的（`input.source = 'workbuddy-session-title'`），why 只有 `user`（标题）+ `tool-input` 两个来源，**没有 plan 分组**。用户问「它怎么知道我要干什么」时，标准回答：面板显示的提问来自 WorkBuddy 侧栏会话标题，不是对话原文。
2. **WorkBuddy 审计日志只有「安全放行」粒度的事件**：`command-safety.sandbox-executed`（命令执行）、`file-safety.*`（文件读取/删除审批）、`sensitive-protection.*`。**Read 工具只有在触发文件安全审计时才有事件**——没触发审计的读操作在面板上不存在。事件数量 ≠ AI 实际动作数量，是**下界代理指标**。
3. **ZCode/Codex 的 hooks/日志模式拿不到模型思考原文**——「为什么」来自 用户需求+计划+工具入参 的拼接推断，UI 已标注来源；只有装了 skill（本机已装）后 why 才是 AI 原话。
4. **dsh adapter 没有真实环境验证过**——如果用户在真机上跑，字段对不上时改 `adapters/ds-harness/plugin/mapper.js`，不要动订阅逻辑。

**输出是代理指标的地方（误读风险）**：
1. 故事线总结里的「失败 N 次」= status 为 error 的工具节点数，**不代表最终结果失败**（失败常被后续步骤补救，补救标记已体现）；
2. plan 条目的「ok」= 名下步骤都有终态，**不代表该步骤全对**（失败后重试成功也算 ok）；
3. 依赖边全是启发式：read-edit 可能连到「读过同一文件但改它和这次读无关」的情形；verify 边靠命令文本匹配 `test|build|lint...`，跑 `ls` 不会成验证边，跑 `npm run build` 会；
4. 回放（replay）的图是本地按事件重放 `buildGraph` 算的，与实时推送的图理论上完全一致（同一纯函数），但若 inference 有 bug 两边会不一致——以 `buildGraph` 测试为准。

**用户/前维护者质疑过的点及标准回答**：
- 「为什么面板上会话标题是乱码？」——那是**发送方**用 GBK 编码内联 curl 造成的（环境坑 E7），服务端与面板 UTF-8 无问题；用文件方式重发即可。
- 「为什么有的会话永远显示『直播中』？」——会话收到过 `turn_end` 才会结束。skill 模式的会话依赖 AI 主动上报 turn_end；WorkBuddy 会话依赖侧栏状态转 idle。中途强杀客户端就不会有 turn_end。
- 「hooks 和 skill 重复上报怎么办？」——skill 说明书里已写明：发现本机 hooks 在报 tool 事件时，skill 只上报 user_prompt/plan/note/turn_end，不重复报工具事件（本会话就是这么执行的）。
- 「多客户端 sessionId 撞名会串线吗？」——会。去重与存档都只按 `sessionId`，不按 `adapter+sessionId` 组合。实际各客户端 id 都是 UUID，概率极低，未处理（见第 6 节「明确不做」）。

---

## 5. 日常操作命令

以下命令全部在仓库根目录执行：`cd "C:\Users\Mr.Mouse\.zcode\workspace\4f21c839-6db2-4dcb-aee5-6ca5a977019a\agent-flow"`。

### 开发运行（真实面板，端口 4765）
```bash
npm run start                # 启动守护进程 + 自动开面板（已在跑时复用实例，不崩）
npx tsx apps/cli/src/bin.ts open   # 只开面板（根 package.json 没有 open 脚本，别用 npm run open）
```

### 跑校验
```bash
npx vitest run               # 全量测试，预期 107/107（12 个文件）
npm run typecheck            # 9 个包 tsc --noEmit，预期无输出
npm run build -w packages/web # 前端构建，预期 "✓ built in ..."
```

### 服务冒烟（隔离端口，不碰真实面板）——完整可复制
```bash
rm -rf /tmp/af/hs && mkdir -p /tmp/af/hs/data
AGENT_FLOW_PORT=4799 AGENT_FLOW_HOME=/tmp/af/hs/data npx tsx packages/server/src/main.ts > /tmp/af/hs/server.log 2>&1 &
sleep 4
curl -s -m 2 http://127.0.0.1:4799/api/health
# 中文 payload 必须走 UTF-8 文件（环境坑 E7）：
cat > /tmp/af/hs/ev.json <<'EOF'
{"events":[{"id":"smoke-1","ts":1792939000000,"sessionId":"smoke-1","adapter":"demo","phase":"user_prompt","title":"用户：冒烟","input":{"prompt":"冒烟"}},{"id":"smoke-2","ts":1792939001000,"sessionId":"smoke-1","adapter":"demo","phase":"turn_end","title":"完成"}]}
EOF
curl -s -m 5 -X POST http://127.0.0.1:4799/api/events -H "content-type: application/json" --data-binary @/tmp/af/hs/ev.json
curl -s -m 2 http://127.0.0.1:4799/api/sessions
curl -s -m 2 http://127.0.0.1:4799/api/sessions/smoke-1/graph
curl -s -m 2 --path-as-is -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4799/../package.json   # 预期 404
curl -s -m 2 -X DELETE http://127.0.0.1:4799/api/sessions/smoke-1                                   # 预期 {"ok":true}
# 收尾（E8：逐条命令独立清理）：
PID=$(netstat -ano | grep ":4799" | grep LISTENING | awk '{print $5}' | head -1); taskkill //F //PID $PID
rm -rf /tmp/af/hs
```

### 演示会话推送（隔离端口）
```bash
# 先按上面的方法起一个 4799 server，然后：
AGENT_FLOW_PORT=4799 npx tsx apps/cli/src/bin.ts demo --speed=20
# 注意：不要用 `npm run demo -- --speed=20`（E9，参数被吞）；不要对 4765 跑（污染真实面板）
```

### 面板数据维护
```bash
curl -s http://127.0.0.1:4765/api/sessions | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>JSON.parse(d).forEach(s=>console.log(s.sessionId,'|',s.adapter,'|',s.status,'|',s.eventCount)))"
curl -s -X DELETE http://127.0.0.1:4765/api/sessions/<sessionId>   # 删除会话（内存+磁盘），面板即时消失
```

### 接入管理
```bash
npx tsx apps/cli/src/bin.ts skill            # 安装/更新「实时上报」skill → ~/.zcode/skills/agent-flow（本机已装）
npx tsx apps/cli/src/bin.ts skill --remove   # 卸载 skill
npx tsx apps/cli/src/bin.ts install          # 注册 ZCode hooks（本机当前未装；装完 ~/.zcode/cli/config.json 会出现 7 组 hook.cjs 条目）
npx tsx apps/cli/src/bin.ts uninstall        # 移除 hooks（保留用户自己的条目）
```

---

## 6. 未完成 / 可做的方向（按性价比排序）

1. **（5 分钟）重启守护进程让全部修复生效**——当前 4765 上跑的是旧代码，可实证：`curl -s http://127.0.0.1:4765/api/sessions` 里 `af-bhrlab` 仍显示 `lastTs < firstTs`（旧 bug），新代码会取全量极值。做法：找到 4765 的 PID（`netstat -ano | grep :4765`）`taskkill //F //PID`，然后 `npm run start`。重启后磁盘上已删除的脏会话文件不会再出现。
2. **（15 分钟）给面板加会话删除按钮**——`DELETE /api/sessions/:id` 后端已实测，web 侧只剩 UI：在 `packages/web/src/App.tsx` 会话列表（`sortedSessions.map` 处）加一个删除按钮 + 确认，调用后依赖现有 `sessions` 广播自动刷新。为什么值得：现在清理误报会话要敲 curl。
3. **（30 分钟）Watcher 端到端测试去偶发**——把 `adapters/workbuddy/test/workbuddy.test.ts` 与 `adapters/codex/test/codex.test.ts` 的固定 `sleep` 改成 `waitFor` 谓词等待，testTimeout 从 15s 提到 30s。为什么值得：8 次全量中出现过 1 次负载下超时（见第 3 节），CI/慢机上会更频繁。从两个测试文件的 e2e 用例入手。
4. **（1–2 小时）ds-harness 真机验证**——装 `@deepseek-ai/dsh`（Node ≥22），按 `adapters/ds-harness/README.md` 挂载插件，对照真实 `session/event` 载荷核对 `plugin/mapper.js` 的字段别名。为什么值得：当前是全项目唯一「按文档推断、未实测」的组件。
5. **（半天）会话存档治理**——`~/.agent-flow/sessions/*.jsonl` 只增不减（当前 6 个文件；WorkBuddy 回灌一次约千事件/会话）。可做：启动时按 `lastTs` 超过 N 天自动归档/删除，或面板加批量清理。入口：`packages/server/src/store.ts` 构造函数与 `summaries()`。
6. **（1 天）skill 的 note 事件去重/节流**——AI 高频自述时面板节点会很密，可在 server 端对同会话同秒 note 做合并。入口：`packages/server/src/store.ts` 的 `append()`。
7. **（大重构，暂缓）跨客户端会话隔离**——按 `adapter+sessionId` 组合键隔离（见第 4 节「串线」）。牵动 store key、全部 API URL 语义与前端，收益低（真实 id 都是 UUID），**明确推迟**。

**明确不做 / 已放弃**：
- **读 WorkBuddy SQLite 取对话正文**——运行中被应用锁、需要 SQLite 驱动，违背「零依赖、不碰运行中数据」原则；README 已如实声明局限。
- **hook/notify 脚本输出 stdout**——宿主客户端按 strict JSON 解析 stdout，输出任何东西都会污染会话（`hook.cjs` 头部注释写着这条铁律）。
- **引入数据库替代 JSONL**——spec 明确 append-only JSONL + 回放按时间戳，别走回头路。
- **把 `noUncheckedIndexedAccess` 打开**——全库大量 `arr[i]!` 断言，打开会爆炸式报错，收益仅剩理论上的。

---

## 7. 上下游依赖与波及范围

**本项目依赖（运行时读取的外部数据，只读）**：
- `~/.workbuddy/`（`audit-log/*.jsonl`、`changes-index/<sessionId>.json`、`*/sidebar-list-snapshot.json`）——WorkBuddy v1.x 实测格式（审计行 `schemaVersion: 2`）。WorkBuddy 升级改格式时，只需改 `adapters/workbuddy/src/mapper.ts`。
- `~/.codex/sessions/**`（openai/codex rollout 格式）——格式对不上时改 `adapters/codex/src/watcher.ts` 的 `mapRolloutPayload`/`mapCodexLine`。
- `~/.zcode/skills/agent-flow/SKILL.md`（已安装，源自 `adapters/skill/SKILL.md`）——skill 行为由该文件约定。
- Codex 接入的可选外部配置：`~/.codex/config.toml` 的 `notify`（本机未配置，未实测真实 Codex 触发）。

**反向依赖（谁依赖本项目）**：无外部项目依赖本仓库。唯一「本项目写出去」的文件是 `~/.zcode/cli/config.json`（仅当手动执行 `install`）与 `~/.zcode/skills/agent-flow/SKILL.md`（仅当执行 `skill`）。

**动这几个文件前必须三思（波及面最大）**：
1. `packages/protocol/src/types.ts` + `schema.ts`——全系统契约（server 校验、inference、web、全部 adapter、skill 约定）。加枚举值（如新 adapter id）是安全的；改既有字段语义不安全。
2. `packages/inference/src/index.ts`——web 的故事线/流程图/回放全部消费它的输出，且 demo fixtures 的测试断言了具体节点/边数量。
3. `packages/server/src/store.ts`——落盘格式与去重语义；改坏会导致重启恢复（`重启恢复` 测试）与幂等去重失效。
4. `packages/web/dist/`——不要手改，`npm run build -w packages/web` 重新生成；live server 逐请求读盘，构建完成后浏览器刷新即生效（无需重启 server）。

---

## 8. 深度背景资料

| 资料 | 绝对路径 / URL | 说明 |
|---|---|---|
| 原始需求（项目 spec） | 仓库同级：`C:\Users\Mr.Mouse\.zcode\workspace\4f21c839-6db2-4dcb-aee5-6ca5a977019a\agent-flow-prompt.md` | 里程碑 M0–M4 与验收标准；**注意其「pnpm workspaces + turbo」与实际不符**，实际是 npm workspaces（`package.json` 的 `workspaces` 字段），无 turbo |
| 冻结接口与任务分解 | `docs/plan.md`、`docs/spec.md` | 历史文档；「冻结接口」与现状基本一致，但协议已按需演进（加了 `workbuddy` adapter、`note` 事件已是正式 phase、新增 DELETE API） |
| 各 adapter 接入依据 | `adapters/zcode/`、`adapters/codex/`、`adapters/workbuddy/`、`adapters/ds-harness/`、`adapters/generic/` 各自的 `README.md` | 每个都写了数据源实测格式与诚实声明 |
| dsh 调研（未实测的参照） | https://github.com/deepseek-ai/deepseek-harness/discussions/961 、https://zhuanlan.zhihu.com/p/2072466931421074027 | 插件 API 与会话事件表的来源。**与实测的关系**：dsh 未在本机安装，这些资料没经过真机验证，真相裁决标准 = `adapters/ds-harness/test/dsh.test.ts` 的映射单测 + 未来真机对照 |
| 参考开源项目 | 仓库根 `README.md` 末尾「致谢 / 参考项目」 | disler/claude-code-hooks-multi-agent-observability、simple10/agents-observe、anaypaul/claude-session-visualizer |
| 已知坑引用 | https://github.com/anthropics/claude-code/issues/70632 | 「直接 tail 会话日志可能中途不刷新」——本项目因此以 hooks/skill 为主、tail 为辅 |
| 实时上报 skill 本体 | `adapters/skill/SKILL.md`（已安装到 `~/.zcode/skills/agent-flow/SKILL.md`） | AI 自述上报的行为约定（phase、id 规则、节奏、去重） |

---

## 9. 接手后第一件事

**按顺序执行，全部通过再动任何代码：**

1. **重启守护进程**（当前 4765 跑的是修复前旧代码，实证：`curl -s http://127.0.0.1:4765/api/sessions | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d);console.log(s.filter(x=>x.lastTs<x.firstTs).map(x=>x.sessionId))})"` 当前输出 `["af-bhrlab"]`；新代码下该查询必然输出 `[]`）：
   ```bash
   PID=$(netstat -ano | grep ":4765" | grep LISTENING | awk '{print $5}' | head -1); taskkill //F //PID $PID
   npm run start        # 自动启动 server + codex/workbuddy watcher 并开面板
   ```
   预期控制台输出（中文显示乱码属 E12 显示问题，不影响功能）：`已启动 Codex 会话监视` / `已启动 WorkBuddy 审计/变更监视` / `AgentFlow 运行中 — http://127.0.0.1:4765`。重启后上面那个 `lastTs<firstTs` 查询必须输出 `[]`。
2. **跑全量基线**（若 `node_modules` 不存在，先 `npm install --no-audit --no-fund`）：
   ```bash
   npx vitest run        # 预期：Tests 107 passed (107)，Test Files 12 passed (12)
   npm run typecheck     # 预期：无输出（9 个包全过）
   ```
   若 107 基线对不上：先看是不是 E1（寄生 .js）——`find packages adapters apps -name "*.js" -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*plugin*"` 应输出 0；再排除偶发（见第 3 节，重跑一次）。
3. **跑服务冒烟**：执行第 5 节「服务冒烟」整块，预期输出依次为 `{"ok":true}`、`{"accepted":2,"rejected":0}`、会话列表含 1 条、graph 有 2 节点、`404`、`{"ok":true}`。
4. 基线全部符合 → 可以动手；任何一项不符合 → 先修环境（第 1 节）再谈改动。

---

## 10. 与接手者的协作契约

**安全改动（有校验兜底，改完跑测试即可）**：
- 各 adapter 的**映射纯函数**（`mapper.ts` / `mapper.js`）——有专门单测，改字段映射只要测试绿且不破坏既有断言；
- web 展示层（样式、文案、面板交互）——`npm run build -w packages/web` 通过即可；
- 新增 adapter 子项目——按 `adapters/workbuddy/` 的结构抄（package.json + tsconfig + mapper + watcher + test），并在 protocol 枚举加 id、`packages/web/src/App.tsx` 的 `ADAPTER_LABEL` 加标签、`packages/web/src/styles.css` 的 `.af-adapter-*` 选择器加一行。

**危险改动（动前先跑基线，改完成绩不回退才算过）**：
- 协议字段/枚举语义（`packages/protocol/**`）；
- `buildGraph` 的配对/归属/连边规则（`packages/inference/src/index.ts`）；
- 存储与去重（`packages/server/src/store.ts`）；
- 各 watcher 的**事件 id 生成规则**——改成非确定性会导致重启重读重复入库，改成确定性不足会被误去重。

**危险改动流程**：`npx vitest run` 记录基线（107/107）→ 小步改（一次一个规则）→ `npx vitest run` + 对应包测试 → 若动过 protocol 或 web 依赖面，再跑 `npm run build -w packages/web` → 成绩不回退、行为断言不弱化（不要用删断言的方式让测试通过）才算完成。

**文档与代码不符时**：以代码为准，**当场改本文档**并在改动处加一行「（YYYY-MM-DD 修正：<内容>）」。本文档中所有命令都在撰写当日实测过；如果某条命令在你手上失败，先怀疑环境（第 1 节），再怀疑文档过时。

**工作纪律（本会话实测有效的习惯）**：
- 冒烟永远用隔离端口 + 临时 `AGENT_FLOW_HOME`，并检查没打到 4765（E8）；
- 临时脚本命名 `*.tmp.ts` 放仓库根，用完即删；
- 中文 payload 走 UTF-8 文件（E7）；
- 不跑 `tsc -b`、不删 `noEmit`（E1）；
- 交给用户面板（4765）的数据必须是真实有意义的，演示数据只进隔离实例。
