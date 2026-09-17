# 编写职责边界清晰的 Profile Prompt

Beacon 会为收到的每条飞书消息启动独立 Agent Run。飞书可能把 `@ All` 消息也投递给群内机器人，
所以 Profile Prompt 不能假设“收到事件”等于“用户正在请求本机器人”。每个 Profile 都应先做
职责判定，再执行昂贵或有副作用的业务流程。

## Agent 实际看到的输入

飞书 Run 的用户输入包含规范化 JSON：

```json
{
  "chat_type": "group",
  "quoted_messages": [
    {
      "sender_type": "app",
      "message_type": "interactive",
      "content": { "title": "上一份报告" }
    }
  ],
  "current_message": {
    "sender_type": "user",
    "message_type": "text",
    "content": { "text": "@_user_1 catalog 也发了" }
  }
}
```

- `chat_type` 是 `group` 或 `p2p`。
- `current_message` 是触发本次 Run 的消息。
- `quoted_messages` 是完整引用链，按最早到最新排列；短回复是否相关经常要结合它判断。
- `message_type` 常见为 `text`、`post`、`interactive`。
- 文本消息中的 `@ All` 通常表现为 `@_all`；富文本消息表现为
  `{ "tag": "at", "user_id": "@_all" }`。
- Prompt 中看不到发送人姓名；发送人 ID 会持久化在 Trigger record，但当前不会放入 Agent Prompt。

Schedule 和手动 Trigger 不是上述 JSON。它们会明确说明来源，并附带配置的 Schedule input 或
操作员输入。Prompt 应分别说明这些入口何时直接执行、何时仍需判断职责。

## 推荐的 Prompt 顺序

按下面顺序写，避免模型先开始工作、随后才发现消息无关：

1. **角色和唯一职责**：一句话说明机器人是什么，以及不是什么。
2. **先判定、后执行**：要求在运行任何命令、读取生产数据或生成报告之前判断职责。
3. **正向条件**：列出明确应该处理的意图和典型表达。
4. **引用回复规则**：说明何时需要结合 `quoted_messages` 判断当前短句。
5. **反向条件**：列出容易误触发、但不应处理的消息类型。
6. **群聊与私聊规则**：明确 `@ All` 不是对机器人的请求，私聊也不自动等于相关。
7. **无关消息出口**：立即调用 `submit_final_outcome_no_reply`，并禁止继续调用业务工具。
8. **业务流程和错误规则**：只有判定相关后才引用具体操作文档和成功输出格式。

## 可复制模板

```markdown
你是 <领域> 助手。你的唯一职责是 <职责>；你不是群聊通用助手，也不回应与该职责无关的消息。

收到输入后，必须先判断是否属于职责范围，再执行任何命令或调用业务工具：

- 配置的定时任务 <哪些输入> 应直接执行。
- 飞书消息只有在 <正向意图清单> 时才属于职责范围。
- 如果当前消息是对历史消息或机器人结果的补充，结合 `quoted_messages` 判断完整意图。
- `chat_type` 为 `group` 时，`@ All` / `@_all` 只表示通知全群，不表示请求本机器人。
- <反向示例清单> 不属于职责范围，即使消息提到相关系统名或 `@ All`。
- 私聊消息同样必须符合职责，不因来自私聊而默认处理。

如果消息不属于职责范围，立即调用 `submit_final_outcome_no_reply`，给出简短的内部审计原因。
不得运行命令、读取外部系统、生成产物，也不得提交文本或卡片回复。

如果消息属于职责范围，按照 <业务流程文档> 执行。

任何必需步骤失败时立即停止并报告真实错误，不得伪造成功结果。

成功后调用 <submit_final_outcome_text 或 submit_final_outcome_card>，输出要求为 <格式>。
```

`reason` 应简短说明为什么越界，例如“仓库迁移通知，不是生产发布影响分析请求”。它只用于
Run record 审计，不会发送给用户。不要用空文本、普通 assistant final text 或异常退出代替
`submit_final_outcome_no_reply`；这些方式分别会造成歧义、不会形成 Delivery，或把正常忽略
错误地记录成失败。

## 容易踩的坑

- **只写关键词**：消息出现 AMR、仓库名、运维或 Workflow，不代表用户要求执行 Profile。
- **把所有群事件当作机器人 mention**：飞书可能因 `@ All` 向机器人投递事件。
- **只看当前消息**：诸如“catalog 也发了”必须结合被引用的报告才有意义。
- **把所有私聊都接住**：私聊只改变消息来源，不扩大机器人的职责。
- **判定太晚**：若先 pull 仓库、查生产或发布网页，再调用 `no_reply`，仍然产生了无谓成本和
  副作用。Prompt 必须要求判定发生在所有业务工具之前。
- **正反规则冲突**：例如同时写“任何提到发布的消息都处理”和“普通发布通知不处理”。应以
  用户是否明确要求或更新该 Profile 所负责的业务状态作为判据。

## 上线前测试矩阵

至少覆盖以下情况；不要只测试一条成功消息：

| 输入 | 期望 |
| --- | --- |
| 群聊中明确 `@` 机器人并提出职责内请求 | 回复；Run succeeded；Delivery delivered |
| 群聊中仅 `@ All` 的无关通知 | 不回复；Run succeeded；outcome.kind = no_reply |
| 引用机器人上一份结果并补充职责内状态 | 结合引用链处理并回复 |
| 无引用的相似短句 | 按 Prompt 的明确性规则处理，不能凭空补上下文 |
| 私聊中的职责内请求 | 回复 |
| 私聊中的无关请求 | no_reply |
| 配置的 Schedule input | 按 Schedule 职责执行并投递到配置的 chat_id |
| 必需依赖失败 | Run failed 或发送真实失败结果，不得伪造成功 |

可先用手动 Trigger 验证判定逻辑：

```sh
printf '%s\n' '一条明确无关的通知' | \
  beacon trigger --profile PROFILE_ID --input -
```

然后检查最新 Trigger record：

```sh
jq '{run: .run.state, outcome: .finalOutcome.content, delivery: .delivery}' /ABSOLUTE/PATH/TO/record.json
```

对于 `no_reply`，期望 Run 成功、Final Outcome 保留审计原因、没有 Delivery。真实飞书验收还应
确认临时 `OnIt` reaction 在 Run 结束后消失，无论最终回复、选择 `no_reply`，还是处理失败。
