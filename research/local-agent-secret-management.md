# Beacon MVP：本地 Agent 服务密钥管理实践调研

调研日期：2026-09-12

## 结论

Beacon MVP 应采用“**两个仓库外凭证存储 + 显式构造 Pi 子进程环境**”的最窄方案：

1. 飞书 `app_secret` 由 Beacon 自己从一个仓库外、仅当前用户可读的 secrets 文件加载；普通 TOML/YAML 配置只保存一个 secret 引用，不保存值。
2. 模型 provider 凭证优先交给 Pi 自己的 `auth.json` 管理，Beacon 不读取、不复制该值。若某个 provider 只能使用环境变量，Beacon 才按显式 allowlist 将该变量加入该次 Pi Run 的环境。
3. 启动 Pi 时禁止沿用默认的 `process.env`。必须从一个最小基础环境开始构造 `env`，只加入运行 Pi 所需的非敏感变量和被批准的 provider 变量；任何 `FEISHU_*`、`LARK_*` 或 Beacon secret-loader 变量都不得出现。
4. MVP 不以 macOS Keychain 或外部 secret manager 为必需依赖。二者可作为后续可替换的 `SecretSource`，但都会增加无人值守启动、bootstrap credential、故障诊断和部署步骤。

这保证的是“飞书密钥**不会通过进程环境继承给 Pi**”。它不是同一 macOS 用户内的强安全隔离：能在宿主机上以该用户执行任意命令的 Agent，原则上仍可能读取该用户有权读取的文件，或调用获准的 Keychain 项目。若未来的威胁模型要求 Pi 即使主动寻找也不能取得飞书密钥，需要独立 OS 用户、sandbox/container 或只代办飞书调用而不暴露密钥的 broker；这超出当前单用户 Mac MVP。

## 现有项目的实际做法

### Hermes Agent

这里的 “Hermes” 名称有歧义。本调研采用活跃的 Hermes Agent 项目（历史组织名 `NousResearch/hermes-agent`，当前 canonical 仓库为 `hermes-agent-org/hermes`），而不是同名协议或其他 Agent 项目。

Hermes 将非密钥设置放在 `~/.hermes/config.yaml`，把 API keys、bot tokens 和 passwords 放在 `~/.hermes/.env`；`hermes config set` 会把识别为 secret 的值路由到 `.env`。它的飞书集成同样通过 `FEISHU_APP_SECRET` 等环境变量取值。这说明“用户目录下的仓库外 secret 文件”是成熟本地 Agent 的现实基线，而不是将 secret 写进项目配置。

更重要的是，Hermes 对容器执行端采用显式 `docker_forward_env`/`env_passthrough`：只有点名的变量才进入执行环境，并警告转发后的凭证对容器内命令可见。这个做法直接支持 Beacon 的边界——消息 Gateway 的凭证与 Agent 执行环境应分开，跨边界使用 allowlist，而不是继承整个父进程环境。Hermes 的 local backend 也明确说明没有隔离、与当前用户拥有相同文件访问权，印证了“0600 文件不是同用户 Agent 的 sandbox”。

### 飞书 / Lark Agent Channel

公开方案并未形成一个比“配置文件或环境变量”更强的统一最佳实践：

- OpenClaw 的生产级飞书插件支持 setup wizard、配置文件中的 `appSecret`，也支持 `FEISHU_APP_SECRET` 环境变量。它的配置位于用户目录而非业务仓库，但文档仍允许明文值。
- `opencode-feishu` 也允许用户目录配置中的明文 secret，或 `${FEISHU_APP_SECRET}` 环境替换；缺失变量会失败。
- 其他社区插件常见 `env:FEISHU_APP_SECRET` 形式。这比把值提交进仓库好，但没有自动解决子进程继承问题。

因此不能把“别的 Channel 也用环境变量”当作 Beacon 可直接 `spawn(..., { env: process.env })` 的依据。Gateway 与强能力 Agent 同进程树时，秘密分层和子进程环境过滤必须由 Beacon 自己实现。

### Pi

Pi 官方支持 provider API key 来自环境变量或 `~/.pi/agent/auth.json`。`auth.json`：

- 创建时使用 `0600`，父目录创建为 `0700`；
- 优先级高于 provider 环境变量；
- 支持 API key、OAuth token 自动刷新，以及 provider-scoped `env`；
- key 值还支持 `!command`，官方例子包括调用 macOS `security find-generic-password`。

这使 Pi `auth.json` 成为 Beacon MVP 的首选 provider 凭证边界：用户直接用 Pi 的登录流程配置凭证，Beacon 只指定 Pi agent directory/provider/model，不触碰 key。建议给 Beacon 部署使用专用的 `PI_CODING_AGENT_DIR`（例如 `~/Library/Application Support/Beacon/pi`），避免无意复用个人交互式 Pi 的全部认证与扩展配置。

## 方案比较

| 方案 | 开发体验 | 单用户常驻 Mac | 对 Pi 继承边界的影响 | MVP 判断 |
|---|---|---|---|---|
| 父进程环境变量 | shell 中最快；CI 也常见 | launchd plist 中会成为静态明文，登录 shell 环境也不会自然出现 | Node `spawn` 默认 `env = process.env`，最容易整包泄漏给 Pi | 不作为飞书 secret 的 canonical store；只允许显式 provider env |
| 仓库外权限文件 | 易编辑、易备份、无需额外服务 | 离线可用，启动稳定；可检查 owner/mode | 只要不写入 `process.env` 且子进程使用最小 env，就不会被继承 | **飞书 secret 的 MVP 首选** |
| macOS Keychain | 交互式设置方便 | LaunchAgent/锁屏/重启后的可访问性和 UI 提示需实机验证；后台读取可能返回 `errSecInteractionNotAllowed` | 不通过 env 继承，但同用户 Pi 可能调用 `security`；除非另做 ACL/签名边界 | 后续可选 provider，不阻塞 MVP |
| Pi `auth.json` | `/login` 或手工配置直接可用 | Pi 原生支持、0600、OAuth 可刷新 | provider secret 只由 Pi 读取；不承载飞书 secret | **provider 凭证首选** |
| 外部 secret manager | 轮换、审计、团队管理更强 | 增加 CLI/网络/账号和 bootstrap token；服务不可用会阻断 Beacon | `op run`/`infisical run` 等通常仍把 secret 注入进程 env，仍需过滤 Pi env | MVP 不引入；团队化后再评估 |

## 推荐配置与运行契约

普通配置只持有引用：

```toml
[[profiles]]
id = "model-intel"

[profiles.feishu]
app_id = "cli_xxx"
app_secret = { secret = "FEISHU_MODEL_INTEL_APP_SECRET" }
```

默认 secret 文件建议位于：

```text
~/Library/Application Support/Beacon/secrets.env
```

它不是 shell 脚本，只接受严格的 `NAME=value` 格式；不支持命令替换、`export`、变量展开或多余 fallback。建议约束：

- 父目录归当前 uid 所有，权限不宽于 `0700`；文件为普通文件、归当前 uid 所有，权限必须为 `0600`；不符合时 `doctor` 与 `serve` 非零退出。
- secret 引用缺失、重复键、非法行、空值均 fail fast；不得回退到 placeholder 或空字符串。
- loader 返回内存中的只读映射，不修改 `process.env`。
- 日志只打印 secret 名称和来源，不打印值；错误与结构化运行记录也不得包含值。
- CLI 不接受 secret value 参数，避免 shell history 与进程参数暴露。可以接受 `--secrets-file <path>` 或 `BEACON_SECRETS_FILE=<path>`，但它们只传路径。

开发环境使用同一加载器。可以把文件放在项目外的临时开发目录；若为了便利放到仓库目录，必须 gitignored 且 `doctor` 给出明确警告，但这不应是文档默认路径。

Pi 环境需要单独的纯函数/深模块，例如：

```ts
function buildPiEnv(input: PiEnvironmentInput): NodeJS.ProcessEnv {
  return {
    HOME: input.home,
    PATH: input.path,
    TMPDIR: input.tmpdir,
    LANG: input.lang,
    PI_CODING_AGENT_DIR: input.piAgentDir,
    ...input.approvedProviderEnvironment,
  };
}
```

不得先 spread `process.env` 再删除已知 secret；denylist 会漏掉未来新增的 Profile/Gateway 密钥。测试至少断言：

1. 父进程即使存在 `FEISHU_APP_SECRET`、`LARK_APP_SECRET` 和任意配置文件中的 secret key，Pi env 也不含它们；
2. 仅当前 profile/target 声明的 provider 环境变量可以出现；
3. provider 使用 Pi `auth.json` 时，Pi env 不含 provider key；
4. child spawn 必须显式传入 `env: buildPiEnv(...)`；遗漏应在代码评审/测试中失败；
5. 配置、日志、RPC 错误与 Run 记录不出现 secret value。

launchd plist 只保存非敏感启动参数、绝对 executable/config 路径和最小 `PATH`，不放 `EnvironmentVariables` 密钥。Beacon 应作为当前登录用户的 LaunchAgent 运行；若未来要求重启后在无人登录状态运行，Keychain 与用户目录语义都必须重新验证，不能把本结论直接推广为 LaunchDaemon 方案。

## Keychain 与外部管理器为何暂不作为默认

Keychain 提供加密静态存储，但“存进去”不等于“无人值守服务一定能读”。Apple 文档说明默认 keychain accessibility 受设备锁定状态影响，后台取值可能以 `errSecInteractionNotAllowed` 失败；登录 keychain 也可能按睡眠或空闲策略锁定。对一个要求自动恢复的 launchd 服务，必须在目标 Mac 上验证登录、重启、睡眠/唤醒、锁屏、应用升级/路径变化等状态。通过 `/usr/bin/security` 读取也不天然构成 Pi 的访问边界，因为 Pi 可以执行同一个命令。

外部 secret manager 改善中心化轮换与审计，但 1Password、Bitwarden、Infisical 等无人值守方式都需要 service/machine identity 或 access token。bootstrap credential 仍需安全落地，而且常见 `run` 命令最终把 secret 注入被启动进程的环境。它们可以替换 Beacon 的文件 `SecretSource`，却不能替代 `buildPiEnv` 的最小化边界。对一个单用户、单机、单 Profile MVP，新增故障面大于即时收益。

## 后续验收

实现阶段应把以下项目加入 `beacon doctor` 与部署 smoke test：

- secret 文件 owner/mode/格式及所有引用完整性；
- Pi agent directory 与 `auth.json` 可读性，但不回显内容；
- 使用受控测试变量启动一个诊断子进程，确认 Gateway secret 不在 child env；
- 使用真实 Pi provider 完成一次调用，确认无需把飞书 secret 加入 Pi env；
- 日志扫描确认测试 secret marker 不出现。

若后来选择 Keychain，先建立单独的 credentialed spike，在目标 Mac 上跨重启、登录、锁屏、睡眠/唤醒测试；失败必须可观测，绝不能静默回退到明文配置。

## 证据来源

- [Hermes Agent configuration（固定 commit）](https://github.com/hermes-agent-org/hermes/blob/036cbdfa0a3158454a0a2a7a7388cf70353326b4/website/docs/user-guide/configuration.md)：`~/.hermes/.env`、secret/non-secret 分离、显式环境转发及 local backend 无隔离。
- [Hermes environment variables（固定 commit）](https://github.com/hermes-agent-org/hermes/blob/036cbdfa0a3158454a0a2a7a7388cf70353326b4/website/docs/reference/environment-variables.md)：飞书凭证变量与配置入口。
- [Pi providers（固定 commit）](https://github.com/earendil-works/pi-mono/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/coding-agent/docs/providers.md)：环境变量/`auth.json`、优先级、0600、`!security` command resolver。
- [Pi auth storage implementation（固定 commit）](https://github.com/earendil-works/pi-mono/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/coding-agent/src/core/auth-storage.ts)：目录 0700、文件 0600 与读写行为。
- [OpenClaw Feishu channel（固定 commit）](https://github.com/openclaw/openclaw/blob/7275b4baa0251b3499c2ba2b476b9ecc7bc0c3af/docs/channels/feishu.md)：成熟飞书 Channel 的用户目录配置、wizard 与环境变量实践。
- [opencode-feishu configuration](https://github.com/NeverMore93/opencode-feishu#2-%E5%88%9B%E5%BB%BA%E9%A3%9E%E4%B9%A6%E9%85%8D%E7%BD%AE%E6%96%87%E4%BB%B6)：环境替换与缺失配置失败行为。
- [Node.js `child_process.spawn`](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options)：`env` 省略时默认继承 `process.env`，显式 `env` 决定子进程可见变量。
- [Apple Service Management](https://developer.apple.com/documentation/servicemanagement/)：LaunchAgent 属于已登录用户会话，LaunchDaemon 是不同系统上下文。
- [Apple Keychain accessibility](https://developer.apple.com/documentation/security/restricting-keychain-item-accessibility)：后台/锁定状态与访问级别的关系。
- [Apple Security engineer: SecItem pitfalls](https://developer.apple.com/forums/thread/724013)：后台读取可能返回 `errSecInteractionNotAllowed`，不应把该失败误判为凭证不存在。
- [launchd.plist(5)](https://keith.github.io/xcode-man-pages/launchd.plist.5.html)：launchd job 参数、环境和生命周期约束。
- [1Password: load secrets into scripts](https://developer.1password.com/docs/cli/secrets-scripts)：service account 最小权限及 `op run` 环境注入模式。
- [Bitwarden Secrets Manager CLI](https://bitwarden.com/help/secrets-manager-cli/)：machine account access token 与 CLI 取值模式。
- [Infisical CLI `run`](https://infisical.com/docs/cli/commands/run)：machine identity/bootstrap token 与进程环境注入模式。

