# AGENTS.md

本文件面向在本仓库工作的 AI 编码与审查 Agent，提供执行边界、架构不变量、防膨胀原则与验证速查。功能细节与协议定义以链接文档为准，不在此重复。

## 1. 项目边界与文档地图

- **不要保留兼容性**：重构或演进一次做干净。严禁保留冗余 shim、过渡包装层、兼容别名、旧版格式回退或 `.bak`／`.new` 文件；`src/` 与 `extensions/` 生产代码一律使用严格 TypeScript。
- **范围**：基于 Pi SDK 的 Coding Agent Harness，包含树状 Subagent 编排、Capability 按需发现与分支记忆、以及本机受管 IPC 通信（Unix Socket / Windows Named Pipe）。不扩展脱离 Harness 的外部调度服务。
- **文档索引**：
  - 项目目标与总览：[docs/00-scope.md](docs/00-scope.md)、[docs/README.md](docs/README.md)
  - 公开接口与行为契约：[docs/interface-contract.md](docs/interface-contract.md)
  - 模块所有权与运行时边界：[docs/architecture.md](docs/architecture.md)
  - 会话存储 v2 与分支恢复：[docs/subagent-storage.md](docs/subagent-storage.md)、[docs/capability-prompt-memory.md](docs/capability-prompt-memory.md)
  - 提示词资产与写作规范：[prompts/README.md](prompts/README.md)、[docs/writing-guide.md](docs/writing-guide.md)
  - 已知问题与待验收边界：[docs/known-issues.md](docs/known-issues.md)
- **资产与配置入口**：工具链与脚本以 `package.json`、`tsconfig.json` 为准；模型提示词正文统一存于 `prompts/*.json`（由 `src/prompt-text.ts` 加载），路由示例见 `config/subagent-routing.json`，不在业务代码中硬编码额外副本。

## 2. 不可破坏的系统不变量

- **代次围栏与底层资源归属**：异步任务、会话切换（tree / switch / fork）与服务退役必须通过代次（Epoch / Generation）围栏隔离晚到回调，禁止旧代次经 `pi.appendEntry` 写入新根；退役超时并不等于底层会话已退出，必须保持资源围栏直至清理完成。Unix Socket 清理必须核对绑定时的 `dev`/`ino` 与有效 UID，严禁按路径盲目 `unlink` 或覆盖未验证归属的文件。
- **交接异常 ≠ 未入队（禁止盲目重放）**：向运行中 SDK 会话交接消息或跨 Socket 写入时，抛出异常、断连或超时并不证明消息未入队；只有明确收到“未交出”的同步拒收才允许转入保留历史或重排，严禁对结果未知的已提交消息自动重发。

## 3. 架构审美、强弱依赖辨析与修改原则

- **先审前提，区分强依赖与弱依赖**：
  - 新增防御校验、回滚或字段前，先核实故障前提在现实中是否成立，并区分**强依赖前提**（如跨进程会话/IPC 句柄所有权、代次围栏、磁盘 JSONL 恢复、外部 Socket 报文、工具入参）与**弱依赖前提**（如可随时从原生区间重建的 `views/` 视图、TUI 折叠缓存）。
  - 同一宿主内的受控 TS 模块间信任静态类型：仅在存在真实并发原地修改（如共享 `copyInheritedEntries`）时才做深拷贝；严禁把内部协作边界当成强事务不变量去重复编写字段白名单自检（`checkFields`）、递归 `deepFreeze` 或无意义的 `structuredClone`。
- **保持架构审美与主体性，变丑前先停下并交用户拍板**：
  - 面对边缘追问或审查意见时，不机械顺从、不为应付极端巧合而叠床架屋（审美是启动复核的信号，但不能作为删除已证必要正确性约束的理由）。
  - 当识别出某处属于弱边界、继续加保护会让架构、状态机、接口或 Prompt 变拧巴时，**先停下添加机制，向用户简列：① 触发条件；② 用户可见失败/残留状态及影响范围；③ 恢复办法；④ 增加保护的代价与推荐取舍**，由用户拍板后再修改；未获确认前不私自放宽契约或把部分失败包装成成功。
- **Prompt 资产改动原则**：
  - Prompt 是系统契约的一部分，严禁混入内部实现细节噪音（底层函数名、中间变量、特定实验反馈要求）；修改已打磨的提示词遵循最小改动原则，使用明确的技术动词与行为原语，杜绝空洞说教与反向诱导。

## 4. 常用命令与验证门禁

按改动范围选择对应验证路径（纯文档修改或者提示词，默认配置非字段修改，无需跑全套测试；代码交付以 `npm run check` 为基准门禁）：

```sh
# 1) 类型检查与全量测试基准门禁（tsc --noEmit + 全套测试）
npm run check

# 2) 仅运行类型化核心测试套件
npm run test:typed

# 3) 定向运行单个或多个测试文件（必须带 --test）
node --import tsx --test test/typed/runtime-parent-hold.test.ts
node --import tsx --test test/typed/subagent-surface.test.ts

# 4) Prompt、配置与文档自检（JSON 合法性与 Markdown 技术语言/链接验证）
npm run check:json
npm run check:docs

# 5) 提交前暂存内容与脱敏自检
git status --short
git diff --cached
```

- **验证效力边界**：默认回归使用真实 Pi SDK 与本地模拟模型（及离线子进程 MCP），不等同于真实模型供应商多轮在线运行、长时压测或 Windows 实机验收。缺少对应环境时须如实声明“未测”。

## 5. 隐私、Git 卫生与多 Agent 协作

- **严禁提交本机真实信息**：代码、测试 fixture 与文档统一使用合成占位数据（如 `fake-provider`、`fake-model`、`/tmp/project`）。严禁提交真实 API Key、OAuth Token、主机名或开发机隐私路径。
- **历史与文档分离**：提交前必看 `git diff --cached`，保持小步原子提交。公共文档（`docs/*.md`）只描述当前有效设计与接口契约，不写阶段进度表；代码审查与复现材料归入 `docs/reviews/`，淘汰/过时方案归入 `docs/archive/`。
- **交付汇报**：仅在用户要求时合入主分支或清理分支；交付汇报须明确区分 **“已改 / 已测 / 未测”**。
