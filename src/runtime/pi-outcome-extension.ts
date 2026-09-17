import { spawn } from "node:child_process";

import type { FinalOutcomeContent } from "../domain/types.js";
import { parseFinalOutcomeContent } from "../outcome/content.js";

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

export function textOutcomeFromToolParams(
  params: TextOutcomeToolParams,
): FinalOutcomeContent {
  return parseFinalOutcomeContent({ kind: "text", text: params.text });
}

export function cardOutcomeFromToolParams(
  params: CardOutcomeToolParams,
): FinalOutcomeContent {
  return parseFinalOutcomeContent({
    kind: "card",
    title: params.title,
    content: params.content,
    buttons: params.buttons ?? [],
  });
}

export function noReplyOutcomeFromToolParams(
  params: NoReplyOutcomeToolParams,
): FinalOutcomeContent {
  return parseFinalOutcomeContent({ kind: "no_reply", reason: params.reason });
}

async function invokeBeaconCli(
  outcome: FinalOutcomeContent,
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
    name: "submit_final_outcome_text",
    label: "Submit Final Outcome Text",
    description:
      "Submit the final response as a normal text message. Call exactly one Final Outcome tool after completing the task.",
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
      await invokeBeaconCli(textOutcomeFromToolParams(params), signal);
      return acceptedResult();
    },
  });

  pi.registerTool<CardOutcomeToolParams>({
    name: "submit_final_outcome_card",
    label: "Submit Final Outcome Card",
    description:
      "Submit the final response as a structured Feishu card. Call exactly one Final Outcome tool after completing the task.",
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
      await invokeBeaconCli(cardOutcomeFromToolParams(params), signal);
      return acceptedResult();
    },
  });

  pi.registerTool<NoReplyOutcomeToolParams>({
    name: "submit_final_outcome_no_reply",
    label: "Submit No Reply Outcome",
    description:
      "Complete the run without sending a reply. Use this exactly once when the triggering message is outside the Profile's role.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          minLength: 1,
          description:
            "A concise internal reason why the message should not receive a reply.",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      await invokeBeaconCli(noReplyOutcomeFromToolParams(params), signal);
      return acceptedResult();
    },
  });
}
