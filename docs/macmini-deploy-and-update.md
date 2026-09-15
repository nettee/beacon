# 在 macmini 上部署或更新 Beacon

本文记录 Beacon 在 `macmini.liuyi` 上的实际部署方式。当前部署以用户
`liuyi` 运行，但由 system LaunchDaemon 监督，因此无需用户登录即可在机器启动后运行。

## 已验证的目录和入口

| 用途 | 路径 |
| --- | --- |
| Beacon home | `/Users/liuyi/.beacon` |
| 全局配置 | `/Users/liuyi/.beacon/config.yaml` |
| Profile | `/Users/liuyi/.beacon/profiles/<profile-id>` |
| 密钥 | `/Users/liuyi/.beacon/secrets.json` |
| Pi 会话 | `/Users/liuyi/.beacon/sessions/<profile-id>/<run-id>` |
| Beacon CLI | `/Users/liuyi/.local/bin/beacon` |
| Pi CLI | `/Users/liuyi/.local/share/pi-node/node-v22.23.2-darwin-arm64/bin/pi` |
| 服务日志 | `/Users/liuyi/.beacon/logs/` |
| launchd label | `system/io.nettee.beacon` |

从运维机进入 macmini：

```sh
netops --repo /Users/william/projects/internal-net ssh macmini.liuyi
```

Beacon 的 shebang 使用 `/usr/bin/env node`。普通 SSH 和 launchd 的默认 `PATH`
通常找不到版本管理器安装的 Node，所以诊断和安装前先使用与服务一致的 PATH：

```sh
export PATH=/Users/liuyi/.local/bin:/Users/liuyi/.local/share/pi-node/node-v22.23.2-darwin-arm64/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
```

如果 Node 的安装位置发生变化，必须同时更新 LaunchDaemon 的 `PATH`，并重新确认
`command -v beacon`、`command -v node` 和 `command -v pi`。

## 首次部署

### 1. 检查运行时并安装精确版本

Beacon 要求 Node.js 22 或更高版本，同时依赖已经配置好 provider/model 的 Pi：

```sh
node --version
npm --version
pi --version
npm config get prefix
```

macmini 的用户级 npm prefix 应为 `/Users/liuyi/.local`。生产环境建议安装明确版本，
避免一次重建意外跨版本：

```sh
npm view @nettee/beacon@VERSION version
npm install --global @nettee/beacon@VERSION
beacon version
command -v beacon
```

只有第一条命令能够查询到目标版本后再安装。GitHub Actions 显示 publish 成功后，
npm registry 偶尔仍需短暂时间才会返回新版本。

### 2. 创建私有目录和全局配置

```sh
umask 077
mkdir -p /Users/liuyi/.beacon/{profiles,sessions,logs}
chmod 700 /Users/liuyi/.beacon /Users/liuyi/.beacon/sessions
```

`/Users/liuyi/.beacon/config.yaml` 的基线配置：

```yaml
version: 1
profiles_directory: profiles
pi:
  executable: /Users/liuyi/.local/share/pi-node/node-v22.23.2-darwin-arm64/bin/pi
  coding_agent_directory: /Users/liuyi/.pi/agent
  session_directory: /Users/liuyi/.beacon/sessions
runs:
  max_concurrent: 1
  max_queued: 20
  timeout_seconds: 300
  terminate_grace_seconds: 5
scheduler:
  max_occurrences_per_reconciliation: 1000
```

`session_directory` 必须是绝对路径。每次业务 Run 会在其下创建权限为 `0700` 的
独立目录并保留 Pi JSONL 会话；`beacon doctor` 的烟雾测试不会产生会话。

创建至少一个 Profile 和 `/Users/liuyi/.beacon/secrets.json` 后再继续。具体步骤见
[在 macmini 上给 Beacon 添加 Profile](./macmini-add-profile.md)。密钥文件及其父目录
权限是启动契约的一部分：

```sh
chmod 700 /Users/liuyi/.beacon
chmod 600 /Users/liuyi/.beacon/secrets.json
```

### 3. 先运行 doctor

```sh
beacon doctor
```

`doctor` 会严格加载全部 Profile 和凭据、获取飞书 tenant token，并运行真实 Pi RPC
烟雾测试。任何错误都应先修复，不能带着失败结果安装或重启服务。

### 4. 安装 system LaunchDaemon

把下面内容保存为
`/Users/liuyi/.beacon/io.nettee.beacon.daemon.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.nettee.beacon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/liuyi/.local/bin/beacon</string>
    <string>serve</string>
    <string>--config</string>
    <string>/Users/liuyi/.beacon/config.yaml</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/liuyi/.beacon</string>
  <key>UserName</key>
  <string>liuyi</string>
  <key>GroupName</key>
  <string>staff</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/liuyi/.local/bin:/Users/liuyi/.local/share/pi-node/node-v22.23.2-darwin-arm64/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>/Users/liuyi/.beacon/logs/service.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/liuyi/.beacon/logs/service.stderr.log</string>
</dict>
</plist>
```

`63` 是十进制表示的 `077` umask。先普通用户校验 plist，然后手动以管理员权限安装：

```sh
plutil -lint /Users/liuyi/.beacon/io.nettee.beacon.daemon.plist
sudo cp /Users/liuyi/.beacon/io.nettee.beacon.daemon.plist /Library/LaunchDaemons/io.nettee.beacon.plist
sudo chown root:wheel /Library/LaunchDaemons/io.nettee.beacon.plist
sudo chmod 644 /Library/LaunchDaemons/io.nettee.beacon.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/io.nettee.beacon.plist
```

若 label 已加载，不要重复 `bootstrap`；使用后文的 `kickstart` 更新进程。

### 5. 验收

```sh
launchctl print system/io.nettee.beacon
tail -n 100 /Users/liuyi/.beacon/logs/service.stdout.log
tail -n 100 /Users/liuyi/.beacon/logs/service.stderr.log
```

验收标准：服务为 `running`、存在 PID、stderr 为空或没有新的 fatal、stdout 出现
`Feishu Gateway ready` 和 `ws client ready`。再给机器人发一条消息，确认收到回复，并检查：

```sh
find /Users/liuyi/.beacon/sessions -type f -name '*.jsonl' -print
```

## 更新 Beacon

更新时按“发布确认 → 安装 → 配置迁移 → doctor → 重启 → 业务验收”的顺序执行。

```sh
export PATH=/Users/liuyi/.local/bin:/Users/liuyi/.local/share/pi-node/node-v22.23.2-darwin-arm64/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

npm view @nettee/beacon@NEW_VERSION version dist.integrity --json
beacon version
npm install --global @nettee/beacon@NEW_VERSION
test "$(beacon version)" = "NEW_VERSION"
```

如新版本包含配置迁移，先备份再修改：

```sh
cp -p /Users/liuyi/.beacon/config.yaml /Users/liuyi/.beacon/config.yaml.pre-NEW_VERSION
```

不要在新 CLI 安装成功前先加入旧 CLI 不认识的字段。Beacon 使用严格 schema；若旧进程
意外重启，未知字段会令启动失败。安装完成后执行：

```sh
beacon doctor
```

doctor 通过后手动重启 LaunchDaemon：

```sh
sudo launchctl kickstart -k system/io.nettee.beacon
```

记录重启前后的 PID，并复查版本、状态和日志：

```sh
beacon version
launchctl print system/io.nettee.beacon | egrep 'state =|pid =|runs =|last exit code'
tail -n 100 /Users/liuyi/.beacon/logs/service.stdout.log
tail -n 100 /Users/liuyi/.beacon/logs/service.stderr.log
```

最后发送一条真实飞书消息。仅有 `doctor` 成功不等于消息接收、Agent Run 和回复投递的
整条链路均已验证。

## 回滚

回滚同样安装明确版本，并恢复与该版本兼容的配置：

```sh
npm install --global @nettee/beacon@OLD_VERSION
beacon version
cp -p /Users/liuyi/.beacon/config.yaml.pre-NEW_VERSION /Users/liuyi/.beacon/config.yaml
beacon doctor --config /Users/liuyi/.beacon/config.yaml
sudo launchctl kickstart -k system/io.nettee.beacon
```

只有 doctor 通过后才重启。不要删除 `profiles/*/state` 或 `sessions` 来“修复”升级；前者
包含去重和投递状态，后者是后续追踪所需的永久 Pi 会话。

## 常见问题

- `env: node: No such file or directory`：当前 shell 或 LaunchDaemon 的 `PATH` 不含 Node。
- `bootstrap failed: service already loaded`：label 已存在，更新进程应使用 `kickstart -k`。
- 配置新增字段后服务无法启动：CLI 版本过旧，或字段名/层级不符合严格 schema。
- 一个 Profile 配置错误导致所有 Profile 都未启动：这是预期的全量启动校验行为。
- npm 安装出现依赖 install-script 提示：不要据此假定成功或失败，以安装退出码、
  `beacon version` 和真实 `beacon doctor` 结果为准。
- launchd 显示 `running` 但机器人无响应：继续检查 stdout 中的 WebSocket readiness、
  飞书应用事件订阅、应用权限以及对应 Profile 的 Run record。
