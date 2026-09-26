# 编写职责边界清晰的 Profile（persona.md / task.md）

Beacon 会为收到的每条飞书消息启动独立 Agent Run。飞书可能把 `@ All` 消息也投递给群内机器人，
所以 Profile 不能假设“收到事件”等于“用户正在请求本机器人”。每个 Profile 都应先做
职责判定，再执行昂贵或有副作用的业务流程。

Profile 拆成两个固定文件，不必在 yaml 里点名：

- `persona.md`：身份、正/反意图、`@ All`、私聊、引用链
- `task.md`：SOP 顺序和**业务**成功条件（有事/无事/失败时开口、卡片文案）

运行时按**成对**解析，不混用两处各一半：

1. `{workspace}/.beacon-profile/persona.md` 与 `task.md` 都存在 → 用这一对，不再看 Profile 目录。
2. 否则 `{profileDir}/persona.md` 与 `task.md` 都存在 → 用这一对。
3. 两处都拼不出完整一对 → 报错并列出缺的路径。
4. 两处都有完整一对时，只用 workspace 那对，不报错。

不要再写整份 `prompt.md`，也不要在 yaml 里写 `prompt:`、persona/task 路径。yaml 只留 workspace、model、admin、schedule。示例见 `examples/workspace/.beacon-profile/`。

## Agent 实际看到的 system prompt

Beacon **先**拼英文平台模板，再拼接 `persona.md` 和 `task.md`。不要在 Profile 文本后再指望一段英文尾巴。

```text
[Beacon · English]
  workspace = Profile yaml 的 workspace
  this Run = inbound | schedule {id} | manual
  对话通道：入站用 reply 或 reply_card 恰好一次；禁止 no_reply / notify_card
  定时/手动：reply 或 no_reply 恰好一次；禁止 reply_card；有 notify 目标时可再 notify_card 一次
  合同：投递工具是什么、不要填 chat_id、模型正文不投递
  可选：有指令/Skill/依赖/工具上的高/中优先级问题时，可调用一次 `submit_feedback`；没有就不要调

[persona.md]  ← `{workspace}/.beacon-profile/`（否则仅当 workspace 没有这一对时，才读 Profile 目录）
[task.md]     ← 同上
```

英文前言按这次 Trigger 的 kind 和是否有 notify 目标填写。Profile **不要复述**工具定义、不填 `chat_id`、工作区路径。业务仍决定**何时开口**：有结果 / 空转 / 失败时用 `reply`、`reply_card`、`no_reply` 还是 `notify_card`，以及卡片标题和按钮。

## Agent 实际看到的用户输入

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
操作员输入。`persona.md` 应分别说明这些入口何时直接执行、何时仍需判断职责。

## persona.md：身份判定

按下面顺序写，避免模型先开始工作、随后才发现消息无关：

1. **角色和唯一职责**：一句话说明机器人是什么，以及不是什么。
2. **先判定、后执行**：要求在运行任何命令、读取生产数据或生成报告之前判断职责。
3. **正向条件**：列出明确应该处理的意图和典型表达。
4. **引用回复规则**：说明何时需要结合 `quoted_messages` 判断当前短句。
5. **反向条件**：列出容易误触发、但不应处理的消息类型。
6. **群聊与私聊规则**：明确 `@ All` 不是对机器人的请求，私聊也不自动等于相关。
7. **越界时不要做业务**：一两句说明不在职责范围内，不要跑 SOP。入站如何关闭对话通道由 Beacon 前言负责。

## task.md：流程和业务成功条件

1. **SOP 顺序**：只写跨文档的总顺序；单份 SOP 保持独立、互不引用。
2. **开口策略**：有事 / 无事 / 失败时对用户、管理员、群分别怎么做。
3. **业务载荷**：卡片标题、每行一条 feature、按钮文案等。

## 可复制模板

`persona.md`：

```markdown
你是 <领域> 助手。你的唯一职责是 <职责>；你不是群聊通用助手，也不把无关消息当成任务去做。

收到输入后，必须先判断是否属于职责范围，再执行任何命令或调用业务工具：

- 配置的定时任务 <哪些输入> 应直接执行。
- 飞书消息只有在 <正向意图清单> 时才属于职责范围。
- 如果当前消息是对历史消息或机器人结果的补充，结合 `quoted_messages` 判断完整意图。
- `chat_type` 为 `group` 时，`@ All` / `@_all` 只表示通知全群，不表示请求本机器人。
- <反向示例清单> 不属于职责范围，即使消息提到相关系统名或 `@ All`。
- 私聊消息同样必须符合职责，不因来自私聊而默认处理。

如果这是一条飞书消息且不属于职责范围，用一两句说明不在职责范围内，不要运行命令、读取外部系统或生成产物。
```

`task.md`：

```markdown
如果消息属于职责范围，按照 <业务流程文档> 执行。

成功后：

- 入站结构化报告卡片：调用 `reply_card`（不要 `notify_card`）。
- 入站普通文字结果或越界说明：只 `reply`。
- 定时有群公告：`notify_card` + `no_reply`（或管理员也需要文本时再 `reply`）。
- 定时无事可报：只 `no_reply`。

任何必需步骤失败时立即停止并报告真实错误，不得伪造成功结果。失败只告诉管理员，不要伪造报告。
```

`no_reply` 的 `reason` 应简短说明为什么不打扰管理员。它只用于 Run record 审计，不会发送给用户。入站越界用 `reply` 把说明发给用户，不要 `no_reply`。

## 容易踩的坑

- **只写关键词**：消息出现 AMR、仓库名、运维或 Workflow，不代表用户要求执行 Profile。
- **把所有群事件当作机器人 mention**：飞书可能因 `@ All` 向机器人投递事件。
- **只看当前消息**：诸如“catalog 也发了”必须结合被引用的报告才有意义。
- **把所有私聊都接住**：私聊只改变消息来源，不扩大机器人的职责。
- **判定太晚**：若先 pull 仓库、查生产或发布网页，再决定越界，仍然产生了无谓成本和
  副作用。`persona.md` 必须要求判定发生在所有业务工具之前。
- **正反规则冲突**：例如同时写“任何提到发布的消息都处理”和“普通发布通知不处理”。应以
  用户是否明确要求或更新该 Profile 所负责的业务状态作为判据。
- **在 Profile 里复述平台合同**：工具定义、不填 `chat_id`、工作区路径，都已经在英文前言里。
  重复一遍只会和 Trigger 能力打架。
- **把入站卡片写成 `notify_card`**：入站用 `reply_card`；`notify_card` 只给定时群公告。

## 上线前测试矩阵

至少覆盖以下情况；不要只测试一条成功消息：

| 输入 | 期望 |
| --- | --- |
| 群聊中明确 `@` 机器人并提出职责内请求 | 回复（文字或 `reply_card`）；Run succeeded；Delivery delivered |
| 群聊中仅 `@ All` 的无关通知 | 短 `reply`：不在职责范围内 |
| 引用机器人上一份结果并补充职责内状态 | 结合引用链处理并回复 |
| 无引用的相似短句 | 按 `persona.md` 的明确性规则处理，不能凭空补上下文 |
| 私聊中的职责内请求 | 回复（文字或 `reply_card`） |
| 私聊中的无关请求 | 短 `reply`：不在职责范围内 |
| 配置的 Schedule，无事可报 | `no_reply`（不打扰管理员） |
| 配置的 Schedule，要发群公告 | `notify_card` + `no_reply` 或 `reply` |
| 入站要发结构化报告卡片 | `reply_card`（引用回复用户） |
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

对于入站越界，期望 Run 成功、`reply` 为短说明、Delivery delivered。定时 `no_reply` 期望没有 reply Delivery。真实飞书验收还应
确认临时 `OnIt` reaction 在 Run 结束后消失，无论最终回复、选择 `no_reply`，还是处理失败。
