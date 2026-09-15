# 在 macmini 上给 Beacon 添加 Profile

一个 Beacon Profile 对应一套独立的行为 Prompt、工作目录、Pi provider/model 和飞书应用
凭据。当前约定是一套 Profile 对应一个飞书自建应用。服务启动时会加载并校验全部
Profile；任何一个 Profile 无效，Beacon 都不会以“部分可用”的状态启动。

以下示例新增 Profile `example-bot`。将名称、工作目录、模型和飞书凭据替换为实际值。

## 1. 准备飞书应用

在飞书开发者后台创建或选定一个自建应用，并完成：

- 启用机器人能力。
- 使用“长连接接收事件/回调”。
- 订阅消息接收事件 `im.message.receive_v1`。
- 授予接收/读取消息、读取被引用消息、回复或发送消息、添加消息表情回应所需权限。
- 发布使配置和权限生效的应用版本，并确保测试用户或群能够使用该应用。

Beacon 会使用应用凭据获取 tenant token；消息到达时会尝试添加 `OnIt` reaction，读取
完整引用链，启动 Pi Run，再引用回复原消息。reaction 失败是非关键诊断，但鉴权、消息读取
或回复失败会在 doctor、日志或 Run record 中明确暴露。

## 2. 选择 Profile ID 和工作目录

Profile ID 必须匹配：

```text
^[a-z0-9][a-z0-9_-]{0,62}$
```

例如 `example-bot` 合法，`Example Bot` 不合法。工作目录必须已经存在，并且用户 `liuyi`
拥有运行任务所需的读取和写入权限：

```sh
test -d /ABSOLUTE/PATH/TO/WORKSPACE
test -r /ABSOLUTE/PATH/TO/WORKSPACE
test -w /ABSOLUTE/PATH/TO/WORKSPACE
```

每个 Pi Run 都以该目录作为 workspace。不要把需要额外人工提权才能访问的目录配置给
Profile。

## 3. 创建 Profile 文件

```sh
umask 077
mkdir -p /Users/liuyi/.beacon/profiles/example-bot
```

创建 `/Users/liuyi/.beacon/profiles/example-bot/profile.yaml`：

```yaml
prompt: prompt.md
workspace: /ABSOLUTE/PATH/TO/WORKSPACE
runtime: pi
model:
  provider: openrouter
  id: deepseek/deepseek-v4.1-flash
schedules: []
```

`prompt` 必须是 Profile 目录内的相对路径，不能逃逸到目录之外。`workspace` 推荐使用
绝对路径。`provider` 和 `id` 必须是 macmini 上 Pi coding-agent 配置能够实际运行的组合。

创建 `/Users/liuyi/.beacon/profiles/example-bot/prompt.md`。例如一个简单复读机器人：

```markdown
你是一个飞书复读机器人。读取用户提供的飞书对话上下文，取出 current_message 的文本内容，
将其原样连续重复三遍作为最终回复。不要添加解释、标题或额外标点。
```

Beacon 会在这个 Profile Prompt 后追加 Final Outcome 工具约束，并把飞书消息转换为包含
`chat_type`、`quoted_messages` 和 `current_message` 的规范化 JSON 上下文。Prompt 应描述
业务行为，不需要自行实现飞书 API 调用。

如果需要定时任务，可把 `schedules: []` 改为：

```yaml
schedules:
  - id: weekday-brief
    cron: "0 9 * * 1-5"
    timezone: Asia/Shanghai
    input: 生成工作日简报。
    delivery:
      chat_id: REPLACE_WITH_DIRECT_OR_GROUP_CHAT_ID
```

cron 必须恰好包含五个字段，timezone 必须是有效 IANA 时区，`chat_id` 必须明确配置；
Beacon 不会猜测或回退到其他投递目标。

## 4. 添加飞书凭据

先备份密钥文件：

```sh
cp -p /Users/liuyi/.beacon/secrets.json /Users/liuyi/.beacon/secrets.json.before-example-bot
```

在 `/Users/liuyi/.beacon/secrets.json` 的 `profiles` 对象中加入与目录名完全一致的 key，
并保留已有 Profile：

```json
{
  "version": 1,
  "profiles": {
    "existing-profile": {
      "feishu": {
        "app_id": "cli_EXISTING_APP_ID",
        "app_secret": "EXISTING_SECRET"
      }
    },
    "example-bot": {
      "feishu": {
        "app_id": "cli_0123456789abcdef",
        "app_secret": "REPLACE_WITH_REAL_SECRET"
      }
    }
  }
}
```

不要把真实 secret 放进仓库、命令历史、聊天记录或普通日志。编辑完成后立即校验 JSON 和
权限。真实 `app_id` 必须采用 `cli_` 加 16 位十六进制字符的格式：

```sh
jq empty /Users/liuyi/.beacon/secrets.json
chmod 600 /Users/liuyi/.beacon/secrets.json
chmod 700 /Users/liuyi/.beacon
stat -f '%Sp %Su:%Sg %N' /Users/liuyi/.beacon /Users/liuyi/.beacon/secrets.json
```

期望 owner 是 `liuyi`，Beacon home 不授予 group/world 权限，密钥文件必须恰好为 `0600`。

## 5. 在重启前验证

先验证 Pi 模型本身可用，再验证 Beacon 的完整配置：

```sh
export PATH=/Users/liuyi/.local/bin:/Users/liuyi/.local/share/pi-node/node-v22.23.2-darwin-arm64/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

beacon doctor --config /Users/liuyi/.beacon/config.yaml
```

doctor 必须输出新 Profile 的 ready 信息，同时已有 Profile 也必须全部通过。若失败，不要重启
当前仍在工作的服务；根据错误修正 Profile、workspace、模型、飞书凭据或文件权限。

可先做一个不经过飞书的本地业务逻辑测试：

```sh
printf '%s\n' '测试消息' | \
  beacon trigger \
    --config /Users/liuyi/.beacon/config.yaml \
    --profile example-bot \
    --input -
```

这个命令能验证 Profile Prompt、workspace、Pi 和 Final Outcome，但不能证明飞书事件订阅和
回复权限正确。

## 6. 重启并验收

Profile registry 只在服务启动时加载。doctor 通过后，手动重启 system LaunchDaemon：

```sh
sudo launchctl kickstart -k system/io.nettee.beacon
```

检查状态和日志：

```sh
launchctl print system/io.nettee.beacon | egrep 'state =|pid =|runs =|last exit code'
tail -n 100 /Users/liuyi/.beacon/logs/service.stdout.log
tail -n 100 /Users/liuyi/.beacon/logs/service.stderr.log
```

stdout 应分别出现每个 Profile 的启动日志，并最终出现 WebSocket ready。然后完成真实验收：

1. 给新机器人发送一条私聊文本，确认它引用回复。
2. 若计划支持群聊，在目标群中 `@` 机器人测试。
3. 回复一条历史消息，确认引用链行为符合 Prompt。
4. 检查对应 Run 和持久 Pi 会话。

```sh
find /Users/liuyi/.beacon/profiles/example-bot/state/triggers -name record.json -print
find /Users/liuyi/.beacon/sessions/example-bot -type f -name '*.jsonl' -print
```

Run record 中的 `runId` 应等于 `sessionId`，且 `sessionPath` 应为：

```text
/Users/liuyi/.beacon/sessions/example-bot/<runId>
```

## 失败时撤回新增 Profile

如果新 Profile 导致服务无法启动，先保留现场日志和配置用于诊断。需要恢复服务时：

1. 将新 Profile 目录移出 `profiles/`，不要直接删除其 `state/` 或 Pi 会话。
2. 恢复添加前的 `secrets.json` 备份，并保持权限为 `0600`。
3. 再次运行 `beacon doctor`。
4. doctor 通过后执行 `sudo launchctl kickstart -k system/io.nettee.beacon`。

不要只删除 Run record 或 session 来掩盖配置错误。Run record 保存去重和投递状态，session
保存可追踪的 Pi 执行过程，两者都应视为运维证据。
