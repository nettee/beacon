import { spawn } from "node:child_process";

import type {
  CardContent,
  FeedbackContent,
  FinalOutcomeContent,
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

export function replyFromToolParams(
  params: TextOutcomeToolParams,
): FinalOutcomeContent {
  return parseOutcomePatch({
    reply: { kind: "text", text: params.text },
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

export function feedbackFromToolParams(
  params: FeedbackToolParams,
): FeedbackContent {
  const patch = parseOutcomePatch({ feedback: { items: params.items } });
  if (!patch.feedback) throw new Error("submit_feedback produced no items");
  return patch.feedback;
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
    name: "reply",
    label: "Reply",
    description:
      "Send a plain-text reply. Inbound Feishu messages quote-reply the user. Schedules message the admin. Inbound Runs must use this tool, including out-of-role messages.",
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

  pi.registerTool<NoReplyOutcomeToolParams>({
    name: "no_reply",
    label: "No Reply",
    description:
      "Finish a Schedule without messaging the admin. Do not use this on inbound Feishu messages.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          minLength: 1,
          description:
            "A concise internal reason why the admin should not be messaged.",
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

  pi.registerTool<CardOutcomeToolParams>({
    name: "notify_card",
    label: "Notify Card",
    description:
      "Post a structured Feishu card to the Schedule's configured notify group. Inbound messages cannot notify. You must still call reply or no_reply on the same Run.",
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
