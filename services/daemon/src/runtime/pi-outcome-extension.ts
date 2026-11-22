import { spawn } from "node:child_process";

import type {
  CardContent,
  FeedbackContent,
  FinalOutcomeContent,
  NotifyAdminContent,
  ObservabilityFeedbackContent,
} from "../domain/types.js";
import { parseOutcomePatch } from "../outcome/content.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: { submitted: true };
};

export type TextOutcomeToolParams = { text: string };
export type NoReplyOutcomeToolParams = { reason: string };
export type CardOutcomeToolParams = {
  title: string;
  content: string;
  buttons?: Array<{ label: string; url: string }>;
};
export type FeedbackToolParams = {
  items: FeedbackContent["items"];
};
export type ObservabilityFeedbackToolParams = {
  items: ObservabilityFeedbackContent["items"];
};

type ExtensionApi = {
  registerTool<TParams>(tool: {
    name: string;
    label: string;
    description: string;
    parameters: object;
    execute(
      toolCallId: string,
      params: TParams,
      signal: AbortSignal,
    ): Promise<ToolResult>;
  }): void;
};

export function replyTextFromToolParams(
  params: TextOutcomeToolParams,
): FinalOutcomeContent {
  return parseOutcomePatch({
    reply: { kind: "text", text: params.text },
  }) as FinalOutcomeContent;
}

export function replyCardFromToolParams(
  params: CardOutcomeToolParams,
): FinalOutcomeContent {
  return parseOutcomePatch({
    reply: {
      kind: "card",
      title: params.title,
      content: params.content,
      buttons: params.buttons ?? [],
    },
  }) as FinalOutcomeContent;
}

export function noReplyFromToolParams(
  params: NoReplyOutcomeToolParams,
): FinalOutcomeContent {
  return parseOutcomePatch({
    reply: { kind: "no_reply", reason: params.reason },
  }) as FinalOutcomeContent;
}

export function notifyCardFromToolParams(
  params: CardOutcomeToolParams,
): CardContent {
  const patch = parseOutcomePatch({
    notify: {
      kind: "card",
      title: params.title,
      content: params.content,
      buttons: params.buttons ?? [],
    },
  });
  if (!patch.notify) throw new Error("notify_card produced no card");
  return patch.notify;
}

export function notifyAdminFromToolParams(
  params: TextOutcomeToolParams,
): NotifyAdminContent {
  const patch = parseOutcomePatch({
    notifyAdmin: { kind: "text", text: params.text },
  });
  if (!patch.notifyAdmin) throw new Error("notify_admin produced no text");
  return patch.notifyAdmin;
}

export function feedbackFromToolParams(
  params: FeedbackToolParams,
): FeedbackContent {
  const patch = parseOutcomePatch({ feedback: { items: params.items } });
  if (!patch.feedback) throw new Error("submit_feedback produced no items");
  return patch.feedback;
}

export function observabilityFeedbackFromToolParams(
  params: ObservabilityFeedbackToolParams,
): ObservabilityFeedbackContent {
  const patch = parseOutcomePatch({
    observabilityFeedback: { items: params.items },
  });
  if (!patch.observabilityFeedback) {
    throw new Error("submit_observability_feedback produced no items");
  }
  return patch.observabilityFeedback;
}

async function invokeBeaconCli(
  outcome: object,
  signal: AbortSignal,
): Promise<void> {
  const cliPath = process.env.BEACON_CLI_PATH;
  if (!cliPath)
    throw new Error("BEACON_CLI_PATH is missing from this Agent Run");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "outcome", "submit"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      signal,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-64 * 1024);
    });
    child.once("error", reject);
    child.once("exit", (code, exitSignal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `beacon outcome submit failed (code=${String(code)} signal=${String(exitSignal)}): ${stderr.trim()}`,
        ),
      );
    });
    child.stdin.end(JSON.stringify(outcome));
  });
}

function acceptedResult(): ToolResult {
  return {
    content: [{ type: "text", text: "Final Outcome accepted by Beacon." }],
    details: { submitted: true },
  };
}

export default function registerOutcomeTools(pi: ExtensionApi): void {
  pi.registerTool<TextOutcomeToolParams>({
    name: "reply_text",
    label: "Reply Text",
    description:
      "Send a plain-text task result to the direct caller. Inbound Feishu messages quote-reply the user. Manual Runs print to the operator. For Schedule / Listener / on_failure admin short messages, prefer notify_admin instead.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          minLength: 1,
          description: "The complete user-facing plain-text response.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      await invokeBeaconCli(
        { reply: { kind: "text", text: params.text } },
        signal,
      );
      return acceptedResult();
    },
  });

  pi.registerTool<CardOutcomeToolParams>({
    name: "reply_card",
    label: "Reply Card",
    description:
      "Send a structured interactive card as the task result on the conversational channel (inbound quote-reply, or manual stdout). Closes that channel by itself. Do not also call reply_text or no_reply on the same Run.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          description: "The card header title.",
        },
        content: {
          type: "string",
          minLength: 1,
          description: "The card body in Feishu-compatible Markdown.",
        },
        buttons: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            properties: {
              label: { type: "string", minLength: 1 },
              url: { type: "string", pattern: "^https?://" },
            },
            required: ["label", "url"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "content"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      await invokeBeaconCli(
        {
          reply: {
            kind: "card",
            title: params.title,
            content: params.content,
            buttons: params.buttons ?? [],
          },
        },
        signal,
      );
      return acceptedResult();
    },
  });

  pi.registerTool<NoReplyOutcomeToolParams>({
    name: "no_reply",
    label: "No Reply",
    description:
      "Finish a Run with no task result for the direct caller. Use on Schedule / Listener / on_failure when there is nothing to return. Do not use this on inbound Feishu messages.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          minLength: 1,
          description:
            "A concise internal reason why there is no task result for the caller.",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      await invokeBeaconCli(
        { reply: { kind: "no_reply", reason: params.reason } },
        signal,
      );
      return acceptedResult();
    },
  });

  pi.registerTool<TextOutcomeToolParams>({
    name: "notify_admin",
    label: "Notify Admin",
    description:
      "Send a short plain-text side-effect / audit message to the Profile admin private chat. Orthogonal to the reply gate: still close with reply_text, reply_card, or no_reply. At most once per Run.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          minLength: 1,
          description: "The short admin-facing plain-text notification.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      await invokeBeaconCli(
        { notifyAdmin: { kind: "text", text: params.text } },
        signal,
      );
      return acceptedResult();
    },
  });

  pi.registerTool<CardOutcomeToolParams>({
    name: "notify_card",
    label: "Notify Card",
    description:
      "Post a structured Feishu card to the Schedule's configured notify group. Only valid when this Run has a notify target. You must still close the conversational channel with reply_text, reply_card, or no_reply on the same Run. May be combined with notify_admin.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          description: "The card header title.",
        },
        content: {
          type: "string",
          minLength: 1,
          description: "The card body in Feishu-compatible Markdown.",
        },
        buttons: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            properties: {
              label: { type: "string", minLength: 1 },
              url: { type: "string", pattern: "^https?://" },
            },
            required: ["label", "url"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "content"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      await invokeBeaconCli(
        {
          notify: {
            kind: "card",
            title: params.title,
            content: params.content,
            buttons: params.buttons ?? [],
          },
        },
        signal,
      );
      return acceptedResult();
    },
  });

  pi.registerTool<FeedbackToolParams>({
    name: "submit_feedback",
    label: "Submit Feedback",
    description:
      "Optionally report one to three high or medium problems with instructions, Skills, dependencies, or tools on this Run. Call at most once, and only when such a problem actually existed. Do not call this tool when there is nothing to report.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          description:
            "One to three high or medium findings. Omit the tool call entirely when there are none.",
          items: {
            type: "object",
            properties: {
              priority: {
                type: "string",
                enum: ["high", "medium"],
                description: "high or medium only. Do not report low.",
              },
              summary: {
                type: "string",
                minLength: 1,
                maxLength: 1024,
                description:
                  "One or two sentences naming what is missing or wrong.",
              },
            },
            required: ["priority", "summary"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      await invokeBeaconCli({ feedback: { items: params.items } }, signal);
      return {
        content: [{ type: "text", text: "Feedback accepted by Beacon." }],
        details: { submitted: true },
      };
    },
  });
}
