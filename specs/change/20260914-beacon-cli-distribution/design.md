# Design Record

## Research Findings

### Existing System

- 项目已声明 Node.js ESM CLI：package 名为 `beacon`，`bin.beacon` 指向 `dist/cli.js`，运行时要求 Node.js `>=22`；但 `private` 为 `true`、版本为 `0.0.0`，尚不具备发布元数据。[`package.json`](../../../package.json)
- CLI 入口有 shebang 且会把未恢复的失败打印为 fatal 并设置非零退出码；但是 `beacon version` 的值另行硬编码为 `0.0.0`，目前可能与 package 版本漂移。[`src/cli.ts`](../../../src/cli.ts)
- 当前安装说明要求在源码目录执行 `pnpm install --frozen-lockfile`、`pnpm build` 和 `pnpm link --global`；这正是本 change 要移除的目标机源码依赖。[`README.md`](../../../README.md)
- 当前 launchd 示例使用绝对路径 `/usr/local/bin/beacon`，因此升级方案必须维持一个可预测的 CLI 路径，或同步改变服务安装契约。[`deploy/io.nettee.beacon.plist.example`](../../../deploy/io.nettee.beacon.plist.example)
- Beacon 本身不会安装 Pi。全局配置要求 Pi executable 和 coding-agent directory 都解析为已存在的绝对路径，并在加载时验证可执行文件/目录。因此“无需 Beacon 源码”与“完全无外部运行时依赖”是不同目标。[`src/config/global.ts`](../../../src/config/global.ts)
- Pi Run 会从 Beacon package 内按 `import.meta.url` 定位 `dist/runtime/pi-outcome-extension.js`，所以分发物必须保留 CLI 与该扩展的相对布局。[`src/runtime/pi-rpc.ts`](../../../src/runtime/pi-rpc.ts)
- 现有 CI 在 Node.js 22 上执行 lint、typecheck、unit tests 与 build，但不会验证打包内容、从 tarball 安装后的 CLI，或发布流程。[`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml)

### Packaging Probe

- 2026-09-14 在工作树运行 `npm pack --dry-run --json` 成功生成候选清单，但 npm 因缺少 `.npmignore` 而回退到 `.gitignore`。候选包为约 490 KB 压缩、1.98 MB 解压、133 个条目，包含 `src/`、测试、e2e、spec、CI 配置和约 1.6 MB 的图表 HTML；`dist/` 也包含测试编译产物。推论：发布前必须建立显式 allowlist，并把 pack/install smoke test 作为门禁。来源：本地命令输出与 [`.gitignore`](../../../.gitignore)。
- 未加 scope 的 npm package `beacon` 已被占用，registry 在 2026-09-14 返回 `beacon@0.4.9`，描述为 “assign ports for you net services.”。来源：`npm view beacon name version description repository --json`。

### External Distribution Constraints

- npm 官方将全局安装 CLI 的标准入口定义为 `npm install -g <package_name>`；npm 也建议 Node/npm 通过版本管理器安装，以减少全局安装权限问题。来源：[npm 全局安装文档](https://docs.npmjs.com/downloading-and-installing-packages-globally/)、[Node.js 与 npm 安装文档](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm/)。
- npm scope 提供独立命名空间；scoped public package 可由任何人安装，而 private package 总是 scoped 且安装者必须有读取权限。scoped package 发布时默认 private，公开发布需要显式 `--access public`。来源：[npm scopes](https://docs.npmjs.com/about-scopes/)、[scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)、[本地安装文档](https://docs.npmjs.com/downloading-and-installing-packages-locally/)。
- npm Trusted Publishing 可让 GitHub-hosted Actions 以 OIDC 短期凭据发布，避免长期 npm write token，并为满足条件的 public repository/public package 自动生成 provenance；当前要求 npm CLI >= 11.5.1、Node >= 22.14.0，且 package 的 `repository.url` 必须精确匹配 GitHub 仓库。来源：[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)、[npm provenance](https://docs.npmjs.com/generating-provenance-statements/)。
- npm 的 trust 配置要求目标 package 已经存在，因此全新 `@nettee/beacon` 不能在首发前建立 Trusted Publisher；staged publishing 同样不允许 brand-new package。来源：[npm trust CLI prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/)、[npm staged publishing prerequisites](https://docs.npmjs.com/staged-publishing/)。

### Reference: zest-dev Release Workflow

- 本机安装的 zest-dev 源于 `/Users/william/projects/zest-dev`，其 npm package 是 public unscoped `zest-dev@1.0.14`，author 为 `nettee`，而不是 `@nettee/zest-dev`。因此它不能证明 npm 上已存在或当前账号可管理 `@nettee` scope。来源：zest-dev [`package.json`](/Users/william/projects/zest-dev/package.json)。
- zest-dev 用 `package.json.files` 作为发布 allowlist，并有 packaged integration test：先 `npm pack`，在独立目录 `npm install <tarball>`，再从该安装执行 CLI；任何 pack、install 或 CLI 失败都会令测试失败。来源：zest-dev [`package.json`](/Users/william/projects/zest-dev/package.json)、[`e2e/helpers/package_env.py`](/Users/william/projects/zest-dev/e2e/helpers/package_env.py)。
- zest-dev 在 main/master push 上运行 local/package tests，查询 `name@version` 是否已存在；不存在时经 npm Trusted Publishing 发布，存在时显式跳过。它还在 PR 中自动 patch bump。来源：zest-dev [`.github/workflows/publish-npm.yml`](/Users/william/projects/zest-dev/.github/workflows/publish-npm.yml)、[`scripts/ci/check-npm-version.js`](/Users/william/projects/zest-dev/scripts/ci/check-npm-version.js)、[`.github/workflows/ci.yml`](/Users/william/projects/zest-dev/.github/workflows/ci.yml)。

### Evidence Gaps

- 尚未在 npm package settings 中建立 `@nettee/beacon` 的 Trusted Publisher；这是首次发布/自动发布启用时的一次性人工配置，不影响 package 命名决策。

## Design Decisions

### Public Scoped npm Package

正式分发物采用 public scoped npm package `@nettee/beacon`，继续暴露命令名 `beacon`。该包主要供项目维护者自己的设备使用，但不引入 private registry 认证要求。

用户在 2026-09-14 提供的 npm profile 截图显示浏览器位于 `npmjs.com/~nettee`，页面提供 `Edit Profile`，列出该账号发布的两个 package，并显示 `0 Organizations`。结合 npm 的规则“用户注册后自动获得与用户名相同的 scope”，这足以确认应使用 `nettee` 用户 scope；不需要建立 organization。截图不证明 Trusted Publisher 已配置，该配置仍需在首次发布阶段单独验证。来源：用户提供的 `codex-clipboard-37db8ea6-2d7b-4f1f-8386-82b3db40f757.png` 与 npm [About scopes](https://docs.npmjs.com/about-scopes/)。

Rationale: unscoped `beacon` 已被占用，而 user scope 可以避免命名冲突；public package 让新 Mac mini 的安装只依赖 Node/npm，不需要额外部署读取凭据。Trade-off: package 内容和版本历史公开，因此发布门禁必须用 allowlist 排除源码以外不应公开或与运行无关的文件。Premises: Packaging Probe 与 External Distribution Constraints。

### External Runtime Boundary

分发物只包含 Beacon 自身的 JavaScript 运行产物和必要用户文档/元数据；目标机预先提供 Node.js 22+、npm 和 Pi，Pi executable/coding-agent directory 仍由现有 Beacon 配置指定和验证。首期不生成 standalone binary，也不随包安装 Pi。

Rationale: 这直接解决“Beacon 不依赖源码安装”，同时维持现有清晰的 Agent Runtime 边界，避免把 Node/Pi 的平台打包、签名和更新生命周期并入本 change。Trade-off: 新机器仍需独立准备 Node 与 Pi。Premises: [`package.json`](../../../package.json)、[`src/config/global.ts`](../../../src/config/global.ts)。

### Preserve the Existing CLI Contract

npm 安装不得改变现有功能契约。Agent Run 继续通过 package 内的 `beacon outcome submit` 提交 Final Outcome；操作者继续使用 `beacon trigger` 发起手动 Run；常驻服务继续使用 `beacon serve`。安装后的 package 必须保持 `dist/cli.js` 与 `dist/runtime/pi-outcome-extension.js` 的相对布局。

Rationale: 需求是替换分发方式，而不是引入第二套调用协议。内部 Outcome 命令依赖 package 内 CLI 的绝对路径，Pi extension 也按相对位置解析。Premises: [`src/run/create-pi-orchestrator.ts`](../../../src/run/create-pi-orchestrator.ts)、[`src/runtime/pi-rpc.ts`](../../../src/runtime/pi-rpc.ts)。

### npm-native Install, Upgrade, and Rollback

操作者可用 `npm install -g @nettee/beacon@latest` 获取默认稳定版本，也可用 `npm install -g @nettee/beacon@<exact-version>` 安装或回滚到精确版本。不得要求目标机 clone Beacon 仓库或执行项目 build。

Rationale: npm dist-tag 提供方便的稳定入口，精确版本提供可复现部署与回滚。Trade-off: `latest` 是可变引用，运行中服务升级仍需明确的诊断和重启顺序，不能把成功安装等同于成功部署。Premises: npm [全局安装](https://docs.npmjs.com/downloading-and-installing-packages-globally/)与[dist-tag 安装语义](https://docs.npmjs.com/downloading-and-installing-packages-locally/)。

### Defer launchd Service Management

本期不新增 `beacon service install/upgrade`，也不承诺自动管理 launchd plist。npm 安装后的 CLI 继续兼容现有手工 launchd 配置；针对稳定 executable 路径、服务升级和重启的一等管理能力明确留待后续 change。

Rationale: 当前目标是替换 Beacon 自身的源码安装方式；launchd 生命周期管理是可独立交付且会显著扩大接口与 macOS 集成范围的能力。Trade-off: 操作者仍需自行维护现有 plist 中的绝对路径并在升级后重启服务。Premise: 用户在 2026-09-14 的 grilling 决策。

### Guarded Main-branch Publication

采用与 zest-dev 相近但带 bootstrap guard 的发布模型：维护者在发布 PR 中手工选择并更新精确 SemVer；PR CI 必须通过源码测试和真实 tarball 安装测试。publish workflow 在 `main` push 上执行验证；当且仅当 repository variable `NPM_TRUSTED_PUBLISHING_ENABLED` 等于 `true` 时，workflow 查询 `@nettee/beacon@<version>`，若不存在则通过 npm Trusted Publishing 发布为默认 `latest`，若完全相同的版本已存在则显式、安全地跳过，其他 registry、认证、构建或验证错误必须失败。首个版本为 `0.1.0`。首期不要求 Git tag/GitHub Release，也不自动改写 PR 版本。

Rationale: 单人维护时，package version 表达发布意图，合并 main 确立并自动发布可发布 commit；一次性 variable guard 解决 npm 强制“package 已存在才能配置 trust”的 bootstrap 顺序，而不引入长期 token。Trade-off: 首版需要人工 publish/configure/enable 三步，启用开关后任何带新版本号的 main 合并都会进入不可撤销发布流程。Premises: 用户 2026-09-14 的执行边界、Reference: zest-dev Release Workflow 与 npm Trusted Publishing。

`@nettee/beacon` 尚不存在，无法预先在该 package 的 settings 中绑定 Trusted Publisher。因此 `0.1.0` 是明确的一次性 bootstrap 例外：首次 PR 合并时 publish step 因 enable variable 未设置而明确跳过；随后由 `nettee` 用户以交互式 2FA 首次 public publish，配置 `nettee/beacon` 的 Trusted Publisher，再设置 enable variable。后续版本只走 main push + OIDC，不保留长期 write token。首次 publish 或外部设置失败时停止，不将 package/CI 状态报告为已完成。

### Package-first Verification

所有发布相关验证围绕将要交付的 tarball，而不是只验证源码工作树：构建后执行 `npm pack`，校验 allowlist、关键文件和禁止项；在临时隔离目录安装该 tarball，并从安装产物执行 `beacon version`、CLI 快速失败路径以及能证明内部 Outcome extension/CLI 布局有效的 smoke test。PR CI 与 publish workflow 复用同一命令；失败必须非零退出并阻止发布。

Rationale: 当前 dry-run 已证明源码测试通过并不能防止过宽 package 内容或错误的产物布局；真实 tarball install 是最接近 Mac mini 无源码安装行为的低成本门禁。Trade-off: CI 增加一次本地 package install，但不需要 registry round-trip 或真实 Feishu/Pi 凭据。Premises: Packaging Probe 与 zest-dev packaged integration test。

### Package Contents and Version Source

`package.json.files` 是发布边界的 allowlist。候选内容包括生产 `dist/`、README、LICENSE，以及现有安装文档直接依赖的 `examples/` 和 launchd 示例；明确排除 TypeScript 源码、测试/e2e、spec、CI 配置、开发配置与设计图。生产 TypeScript build 不再把 `*.test.ts` 编译到 `dist/`。pack 前必须执行生产 build，缺失或陈旧产物不得静默发布。

`package.json.version` 是唯一版本事实源；`beacon version` 在安装产物中读取/使用同一版本，不再维护独立字符串。首版为 `0.1.0`。package name、repository URL、license、description 等发布元数据必须完整，且 repository 必须与 `https://github.com/nettee/beacon` 精确对应以满足 provenance 约束。

Rationale: allowlist 同时控制泄露面、包体积和运行布局；单一版本源防止 CLI 与 registry 漂移。Trade-off: examples/plist 会略增包体，但使 npm 页面与离线安装产物仍包含现有操作入口。Premises: [`package.json`](../../../package.json)、Packaging Probe、npm Trusted Publishing。

### Publish Failure Semantics

registry 查询只把目标精确版本的明确 404 解释为“需要发布”；认证失败、网络错误、响应格式异常或返回了非预期版本都必须非零失败。publish job 不使用 fabricated registry data，不吞掉 build/test/publish 失败。并发 main 发布串行化且不得取消正在进行的发布。

Rationale: npm 版本不可覆盖，误判“未发布”或取消进行中的 publish 可能造成不可恢复或难以解释的 release 状态。Premises: repository `AGENTS.md` fast-fail 规则与 zest-dev [`scripts/ci/check-npm-version.js`](/Users/william/projects/zest-dev/scripts/ci/check-npm-version.js)。

### Change Scope

Impact Areas:

- npm identity and artifact: package 名、版本、metadata、allowlist、production build 输出与 bin 布局。
- CLI contract: `beacon version` 的来源改变；其他命令行为保持兼容。
- Verification: 增加 tarball 内容检查、隔离安装和安装后 CLI smoke test，并接入 PR CI。
- Release boundary: 增加精确版本 registry 查询、main publish workflow、OIDC permissions 与首次人工 bootstrap。
- Operator workflow: README 从源码 link 改为 public npm 的 latest/精确版本安装、升级和回滚说明，同时保留源码开发步骤。
- Compatibility: Node.js 22+、Pi 配置和当前 macOS/launchd 手工部署前提不变；不增加 private registry 认证。

Planned File Changes:

- [`package.json`](../../../package.json)、[`pnpm-lock.yaml`](../../../pnpm-lock.yaml)：设置 `@nettee/beacon@0.1.0`、public publish metadata、files allowlist、pack/package-test scripts。
- [`tsconfig.json`](../../../tsconfig.json) 或新增 production build config：阻止测试文件进入 `dist/`。
- [`src/cli.ts`](../../../src/cli.ts) 及必要的 version helper/test：从 package 单一来源报告版本。
- `scripts/` 下新增 package manifest/install smoke 与精确 npm version 查询脚本及测试；所有 required subprocess 失败向上传播。
- [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml)：在 PR/main CI 中加入 packaged installation gate。
- `.github/workflows/publish-npm.yml`：以 bootstrap variable 保护 main push 上串行、OIDC、验证先行的新版本自动发布。
- [`README.md`](../../../README.md)：记录 npm 安装、升级、精确版本回滚、外部依赖、首次/后续发布和本地 package 测试。

Out of Scope:

- 自动生成、安装或升级 launchd service/plist。
- 打包 Node.js、Pi 或 standalone macOS binary。
- 改变 Beacon 的 Profile、Trigger、Run、Final Outcome、Delivery 或配置 schema。
- Git tag、GitHub Release、release notes 或 prerelease channel 自动化。
