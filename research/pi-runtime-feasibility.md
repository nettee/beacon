# Pi Agent 非交互运行可行性

调研日期：2026-09-12
实验环境：macOS 15.7.1 arm64、Node.js 24.13.0、`@earendil-works/pi-coding-agent` 0.84.2

## 结论

可行。Beacon 的 MVP 可以把 Pi 当作每次触发一个独立子进程的 Runtime：为每个 Run 指定工作目录、模型配置、独立 session ID，分别捕获 stdout/stderr，并等待进程结束。Pi 的 provider/model 应完全由部署配置决定；Beacon 不应编码 OpenRouter 或任何具体模型。

MVP 推荐使用 `--print` 文本模式，因为 Beacon 只需要最终回复。在该模式中，stdout 是最终 assistant 文本；模型错误或中止会写 stderr 并返回非零。若以后改用 `--mode json` 获取结构化事件，必须解析最终 `message_end` 的 `stopReason`，不能只信进程退出码：实验发现 0.84.2 在 JSON 模式发生模型错误时仍退出 0。

## 建议的 Runtime Adapter 契约

每个触发生成 Beacon `run_id`，启动类似以下命令（参数均来自 Profile/部署配置）：

```text
<absolute-pi-path>
  --print
  --provider <provider>
  --model <model>
  --session-dir <profile-session-dir>
  --session-id <run-id>
  --thinking <level>
  --approve|--no-approve
  <prompt>
```

Adapter 必须：

1. 使用 `spawn` 参数数组而不是 shell 拼接；设置 `cwd` 为 Profile 的工作目录。
2. 显式构造最小环境（至少 `HOME`、`PATH`、`PI_CODING_AGENT_DIR` 及部署选定 provider 所需凭证），不要无意把 Service 的全部秘密暴露给 Agent。launchd 的 PATH 不等同于交互 shell，`pi` 最好配置绝对路径。
3. 分别读取 stdout 和 stderr，并设大小上限。退出码 0 且 stdout 非空才是成功；启动失败、信号退出、非零退出、空最终结果分别记录明确原因。
4. 保存 Pi session，让 Pi 自己保留中间过程；Beacon 只保存 `run_id`、Pi session ID/文件位置、状态、时间、错误摘要和飞书投递状态。不要使用 `--no-session`，除非明确放弃 Pi 日志。
5. 超时属于 Service 运行保护，不是用户取消功能。到期发送 SIGTERM，等待短暂 grace period 后仍未退出再杀进程树；Pi 0.84.2 对 SIGTERM 做清理并以 143 退出。
6. 允许多个 Run 并发，但用简单的可配置并发上限保护 Mac 资源。每个 Run 使用不同 session ID；若任务可能修改同一个 Git 工作区，Beacon 不保证业务层写冲突安全，Profile 应改用独立 worktree/目录或将并发上限设为 1。

建议第一版继续采用 CLI 子进程，而非 SDK/RPC：隔离边界清楚、能自然利用 cwd/环境/退出码，也满足“只取最终结果”。SDK/RPC 可留作以后需要长连接或流式事件时的替换实现。

## OpenRouter 边界

Pi 原生支持 OpenRouter，provider 名为 `openrouter`，凭证可来自 `OPENROUTER_API_KEY`、Pi 的 `auth.json`，或 `--api-key`；官方文档还支持在交互登录时通过 OpenRouter PKCE 创建 key。凭证解析优先级是 CLI、`auth.json`、环境变量。部署可选 OpenRouter，但 Runtime Adapter 只传通用的 provider/model/env 配置。

本机没有可用的 OpenRouter 凭证（`pi auth check --provider openrouter` 返回 `not_ready`），因此没有做真实 OpenRouter 成功调用。使用隔离配置和无效测试 key 的请求得到 HTTP 401，text 模式退出 1，证明失败能被 Beacon 观察到。Pi 的真实成功链路则用本机已配置的另一 provider 验证；这符合 provider 对 Beacon 透明的边界。

## 实验记录

### 成功、工作目录、工具与环境继承

从指定工作目录启动 text 模式，允许 `read,bash`，注入无敏感值的 `BEACON_PI_SENTINEL`。Pi 读取工作目录内 marker，并通过 bash 读取环境，最终 stdout 为：

```json
{"cwd":"/private/tmp/beacon-research-pi","marker":"beacon-pi-runtime-marker","sentinel":"sentinel-7d91"}
```

进程退出 0。这验证了 cwd 会决定 Agent 的项目视图，本地工具在该 cwd 执行，子进程环境可到达 Pi 的 bash 工具。源码也显示 bash 工具以指定 cwd 启动，并基于 `process.env` 构造环境。

### 每次触发的新 session 与 Pi 日志

使用临时 `--session-dir` 和固定 UUID `--session-id` 启动新 Run。Pi 创建：

```text
2026-09-12T04-18-22-659Z_11111111-1111-4111-8111-111111111111.jsonl
```

文件 header 中的 ID 与 cwd 正确，随后有 user/assistant message，最终 assistant `stopReason` 为 `stop`。因此 Beacon 可直接以自己的 run ID 关联 Pi 日志，不需要复制中间事件。

### 两个并发 Run

同时启动两个独立 `--print --no-session` 进程，分别得到 `ALPHA-92f3` 和 `BETA-3b17`，两个退出码均为 0。Pi 本身没有全局单实例限制；真正的约束是机器资源、provider 限流以及共享工作区的写冲突。

### 失败与输出通道

用当前 ChatGPT 账户不支持的模型触发同一模型错误：

- text 模式：错误只出现在 stderr，退出码 1，stdout 无最终回复。
- JSON 模式：stdout 有完整 JSONL；authoritative assistant `message_end` 的 `stopReason` 为 `error` 且含 `errorMessage`，但进程退出码为 0。

当前 `runPrintMode` 源码只在 text 分支将 assistant 的 `error/aborted` 转为返回码 1；JSON 分支只发事件。这正是不能用 JSON 模式退出码单独判断成功的原因。

### Service 超时

启动会执行 `sleep 20` 的 Pi Run，3 秒后向 Pi 发送 SIGTERM；观察到退出码 143。进程源码为 print 模式注册 SIGTERM/SIGHUP handler，并清理已跟踪的 detached children。

### 启动前置条件缺失

当前沙箱内直接让 Pi 使用默认 `~/.pi/agent` 时，无法创建 settings/auth lock 会明确报 EPERM，而不是伪装成功。生产 launchd 配置必须确保 `HOME`/`PI_CODING_AGENT_DIR` 可写，并在启动时检查可执行文件、工作目录和 provider readiness；任何缺失都应使该 Run 失败并回复用户。

## 仍需在目标 Mac mini 上做的验收

1. 用实际 OpenRouter key 和目标模型跑一次上述 text-mode smoke test。
2. 以最终 launchd 用户与环境验证 `pi` 绝对路径、`HOME`/`PI_CODING_AGENT_DIR` 写权限、Keychain 或环境凭证、Git/gh 等所需工具的 PATH 与认证。
3. 用真实 Profile 工作区验证 Pi 能按预期读写代码并创建 PR；这属于部署/业务能力，不改变 Beacon Runtime Adapter。

## 一手资料

- [Pi CLI usage（print/json/rpc、session 与 cwd 相关选项）](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md)
- [Pi JSON event stream（`message_end` 是最终权威消息）](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md)
- [Pi provider 与 OpenRouter 凭证配置](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)
- [Pi print mode 实现](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/print-mode.ts)
- [Pi bash tool / environment 实现](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/bash.ts)
- [Pi session 格式](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md)
