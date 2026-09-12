# 飞书应用消息链路可行性调研

调研日期：2026-09-12  
范围：企业自建飞书应用及其 Bot 能力；**不包括**群自定义 Webhook 机器人。

## 结论

Beacon MVP 的可行路径是：**企业自建应用 + Bot + `im.message.receive_v1` + 官方 WebSocket 长连接 + IM OpenAPI**。

- 常驻 Mac 只需能主动访问飞书公网，不需要公网 IP、域名或入站端口；Webhook 模式则需要公网可达的 HTTPS 请求地址，因此不适合作为 MVP 默认路径。
- 私聊和群聊 @Bot 都由同一个 `im.message.receive_v1` 事件进入，使用 `chat_type`、`mentions`、`message_id`、`chat_id`、`thread_id/root_id/parent_id` 路由。
- 长连接事件处理同样受 **3 秒**处理窗口约束，超时或异常会触发重推。官方 Python SDK 的实现会等待业务 handler 返回后才写回 WS ACK，handler 异常则写 500；因此 handler 绝不能等待 Pi 完成，而应在 3 秒内完成校验、持久化去重键与 Run 入队，然后返回。
- “收到，处理中”可以用 Bot reaction 表达；最终结果用 reply API。推荐默认采用 **follow-shape**：普通群/私聊引用原消息，已在线程或话题群中的消息继续留在线程。是否把普通群的平铺消息强制提升成新线程，应通过真机 A/B 后决定。
- 定时任务主动投递使用 create-message API，不依赖事件上下文；配置保存目标 `chat_id`。向用户 `open_id` 主动私聊还受 Bot 与该用户已有会话关系、应用可用范围等限制，MVP 不应把它作为定时投递的唯一寻址方式。
- 事件交付不是 exactly-once。Beacon 必须持久化去重；建议 `(app_id, event_id)` 为第一层唯一键，`(app_id, message_id, event_type)` 为防御性第二层键。

## 已验证事实

### 1. 连接与事件确认

| 项目 | 官方能力/限制 | 对 Beacon 的影响 |
|---|---|---|
| WebSocket 长连接 | 官方服务端 SDK 建立全双工连接；本机只需出站公网访问，无需公网入口 | Mac mini 可直接常驻运行 |
| 应用类型 | 长连接目前只支持企业自建应用 | MVP 明确使用企业自建飞书应用，不是商店应用或群自定义机器人 |
| 处理窗口 | 收到事件后需在 3 秒内处理完成，否则触发超时重推 | 必须把 Pi 执行移出事件 handler |
| 连接数 | 每个应用最多 50 个 client 连接 | 单机、单 Profile 远低于限制 |
| 多 client | 集群语义、非广播；同一事件只随机推给一个 client | 不能用两个连接做双消费或旁路监听 |
| Webhook | 飞书向公网请求地址 POST；需处理验签/解密及 HTTP 服务边界 | 作为未来备选，不是无公网入口 Mac 的 MVP 路径 |

官方 Python SDK 源码进一步确认：WS 客户端先同步调用 event handler，正常返回后发 `200`，异常后发 `500`；SDK 默认开启自动重连。这个实现证据说明“接收后立即把长任务扔到后台”不是性能优化，而是协议正确性要求。

### 2. 私聊与群聊 @Bot

订阅事件：`im.message.receive_v1`。

官方示例给出的 Bot 侧最小权限候选集是：

- `im:message.p2p_msg:readonly`：接收私聊消息。
- `im:message.group_at_msg:readonly`：接收群聊中 @Bot 的消息。
- `im:message:readonly`：读取收到的消息内容（官方示例包含）。
- `im:message:send_as_bot`：以应用 Bot 身份发送/回复消息。
- `im:message.reactions:write_only`：添加和删除 reaction（官方 CLI 权限表）。

控制台中的 granular scope 名称和审批提示是最终准绳；若选择更宽的 `im:message`，应记录为何不用上述最小权限组合。权限、事件订阅或 Bot 能力发生变化后，需要发布/更新应用版本使其在租户中生效。

`im.message.receive_v1` 的 v2 envelope 有 `header.event_id/event_type/app_id`；消息体有：

- `message_id`（`om_…`）：回复、reaction、消息级去重的目标。
- `chat_id`（通常 `oc_…`）：原会话及后续主动投递目标。
- `chat_type`：区分 `p2p` 与 `group`。
- `thread_id/root_id/parent_id`：保持话题/线程语义。
- `mentions`：判断 Bot 是否真的被 @；不要通过正文里是否出现 `@名字` 猜测。
- sender 的 `open_id`（`ou_…`）：allowlist/audit 的用户标识。

建议入口策略：

```text
p2p   -> 接收该 Bot 私聊中用户发来的消息
group -> 仅当 mentions 命中本 Bot 身份时触发
bot/self sender -> 丢弃，避免回环
```

### 3. Reaction（“处理中”表情）

添加 reaction：`POST /open-apis/im/v1/messages/{message_id}/reactions`，请求核心字段为 `reaction_type.emoji_type`；响应带唯一 `reaction_id`。删除时需要 `message_id + reaction_id`，且调用方只能删除自己添加的 reaction。Bot 必须在该消息所在会话中。

Beacon 可在 Run 成功入队后添加固定 reaction（候选 `THUMBSUP` 或 `OK`），但 **reaction 失败不得阻断 Agent Run**：它是非关键 UX 反馈，应记录失败；最终回复仍是必需步骤。

### 4. 回复、引用与线程

三种独立的出站形态：

| 方案 | API/参数 | 预期呈现 | 适合场景 |
|---|---|---|---|
| 新消息 | `POST /im/v1/messages?receive_id_type=chat_id` | 群/私聊中的新顶层消息，无原任务引用 | 定时主动投递 |
| 引用回复 | `POST /messages/{message_id}/reply`, `reply_in_thread=false` | 主消息流中引用原消息 | 普通群和私聊的默认最终回复 |
| 线程回复 | 同一 reply API，`reply_in_thread=true` | 进入目标消息的线程；在普通群可由平铺消息开启线程 | 话题群、已有线程；普通群是否默认开启需 A/B |

官方 Channel SDK 的 `reply(msg, …)` 默认策略与建议一致：`replyTo=触发消息 message_id`，`replyInThread=Boolean(thread_id)`；话题群或已有线程留在线程，普通群平铺消息做引用回复，不自动创建线程。

**重要限制**：延迟最终回复不能只保存 `chat_id`，必须在 Run 记录中保存触发消息的 `message_id`，并保存 `thread_id/root_id/parent_id`。否则 Agent 数分钟后结束时无法可靠回到原线程。

### 5. 主动发送与定时任务

主动发送：`POST /open-apis/im/v1/messages`。

- 群/已知会话：`receive_id_type=chat_id`，`receive_id=oc_…`；这是定时任务的推荐配置。
- 指定用户：`receive_id_type=open_id`，`receive_id=ou_…`；Bot 需要与目标用户已有私聊关系，且用户在应用可用范围内。
- Bot 身份使用 tenant access token，所需权限为 `im:message:send_as_bot`。
- 官方 CLI 暴露的发送幂等键最长 50 字符，同一键 1 小时内只发送一次。Beacon 应为每次 schedule occurrence / final delivery 生成稳定 key，避免网络重试造成重复出站消息。
- OpenAPI 失败会返回非零错误码和错误信息；权限、会话成员关系、目标失效、限流和网络错误必须保留原始 code / request log id，不能记录为成功。

## 重复投递判断与持久化建议（设计推断）

官方明确存在超时重推；官方 Channel SDK 还专门为 webhook retry 和 WebSocket reconnect backfill 设置了两层去重。因此 Beacon 应按 **at-least-once** 设计，即使正常路径常常只收到一次。

可能的重复来源：

1. handler 超过 3 秒或抛异常，平台重推同一事件。
2. ACK 已发但连接在双方确认边界断开，重连后回补。
3. 进程在“Run 已创建、去重状态尚未提交”的窗口崩溃。
4. 出站 REST 请求在客户端看到超时、服务端实际已成功时被重试。

建议同一 SQLite 事务完成：

```text
insert inbound_event(app_id, event_id, message_id, received_at)  -- unique
insert run(trigger_type, trigger_id=event_id, reply_target...)
commit
ACK
```

若唯一键冲突，ACK 但不再创建 Run。`event_id` 是协议幂等键；`message_id` 第二层只防御 SDK/订阅配置异常，不应用来合并用户真正发送的两条不同消息。出站使用稳定 idempotency key，并单独记录 `delivery_status`，不要把“Agent 成功”与“回复成功”合并为一个状态。

## 无凭证实验结果

对 2026-09-12 获取的官方 `larksuite/oapi-sdk-python` `v2_main` 做了只读静态契约检查，全部通过：

1. receive event model 包含 `message_id/chat_id/thread_id/chat_type/mentions`。
2. v2 envelope 包含 `event_id/event_type/app_id`。
3. 主动发送 endpoint 与 `receive_id_type` 存在。
4. reply endpoint 与 `reply_in_thread` 存在。
5. reaction create endpoint 存在。
6. WS handler 成功回 200、异常回 500，且 ACK 在 handler 返回后写出。

本机安装了官方 `lark-cli`，但当前自动化环境读取 macOS Keychain 时返回 `keychain not initialized`，环境变量中也没有 `LARK_*` / `FEISHU_*` 应用凭证。出于安全考虑，没有降级 Keychain、创建应用、发送消息或修改真实会话。因此视觉表现、权限实际审批与重推时间线仍是 **凭证阻塞的 live gate**，不是本次已验证事实。

## 必须执行的凭证实验（MVP gate）

使用一个测试企业自建应用、一个普通测试群、一个话题群和一个测试用户：

1. **连接/收消息**：Mac 无入站端口，仅开 WebSocket；验证私聊和普通群 @ 各产生一次 `im.message.receive_v1`，记录并脱敏保存 `event_id/message_id/chat_id/chat_type/mentions`。
2. **权限负测**：分别撤掉 p2p、group-at、send、reaction 权限，确认“无事件”与“API 明确报错”的实际差异；重新发布后恢复。
3. **ACK/重推**：测试 handler 正常立即返回、故意睡眠超过 3 秒、故意抛异常；确认重投次数/间隔以及同一重投是否保持 `event_id` 和 `message_id`。
4. **断线/重启**：收事件期间 kill/restart client，确认是否回补、是否重复、官方 SDK 是否自动恢复；Mac 睡眠/唤醒也测一次。
5. **reaction**：对私聊、普通群顶层、普通群线程、话题群消息添加 `THUMBSUP` 和删除；截图实际 UI，并验证失败不会影响 Run。
6. **回复 A/B/C**：同一条普通群 @ 消息分别发新消息、引用回复、`reply_in_thread=true`；再对话题群和已有线程验证 follow-shape。截图手机/桌面端至少一种，交给产品选择默认策略。
7. **延迟回复**：入队后等待 2 分钟再用保存的 `message_id/thread_id` 回复，确认仍回到正确位置。
8. **主动投递**：使用保存的 `chat_id` 模拟定时任务发消息；再用相同 idempotency key 重发，验证 1 小时幂等窗口。
9. **失败语义**：Bot 被移出群、原消息撤回、缺权限、无效 chat_id、限流（若安全可测）时，记录 OpenAPI code/log id，并验证 Beacon 的失败状态不会显示为成功。

通过标准：以上矩阵中，私聊、群 @、reaction、follow-shape 回复和指定 `chat_id` 主动投递全部可复现；超时/异常的重复事件只产生一个 Run；任何最终回复失败均在 Run 审计中可见。

## 资料来源

- [飞书开放平台：事件概述](https://open.feishu.cn/document/ukTMukTMukTM/uUTNz4SN1MjL1UzM)
- [飞书开放平台：配置事件订阅方式](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/request-url-configuration-case)
- [飞书官方文档导出：处理事件（含 3 秒、50 连接、集群语义）](https://feishu.apifox.cn/doc-7518538)
- [larksuite 官方 Python SDK：Channel quickstart](https://github.com/larksuite/oapi-sdk-python/blob/v2_main/doc/channel/quickstart.md)
- [larksuite 官方 Python SDK：WebSocket client](https://github.com/larksuite/oapi-sdk-python/blob/v2_main/lark_oapi/ws/client.py)
- [larksuite 官方 Python SDK：两层去重架构](https://github.com/larksuite/oapi-sdk-python/blob/v2_main/doc/channel/dedup-architecture.md)
- [larksuite 官方 Node Channel SDK](https://github.com/larksuite/channel-sdk-node)
- [larksuite 官方 Bot 示例（权限与事件配置）](https://github.com/larksuite/lark-samples/blob/main/mcp_larkbot_demo/nodejs/README.md)
- [larksuite 官方 CLI：主动发送](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-send.md)
- [larksuite 官方 CLI：回复/线程](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-reply.md)
- [larksuite 官方 CLI：Reaction API](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-reactions.md)

