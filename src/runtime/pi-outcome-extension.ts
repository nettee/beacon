import { spawn } from "node:child_process";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: { submitted: true };
};

type ExtensionApi = {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: object;
    execute(
      toolCallId: string,
      params: { text: string },
      signal: AbortSignal,
    ): Promise<ToolResult>;
  }): void;
};

async function invokeBeaconCli(text: string, signal: AbortSignal): Promise<void> {
  const cliPath = process.env.BEACON_CLI_PATH;
  if (!cliPath) throw new Error("BEACON_CLI_PATH is missing from this Agent Run");

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
    child.stdin.end(text);
  });
}

export default function registerOutcomeTool(pi: ExtensionApi): void {
  pi.registerTool({
    name: "submit_final_outcome",
    label: "Submit Final Outcome",
    description:
      "Submit the exact final response that Beacon must deliver to the user. Call this once after completing the task.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          minLength: 1,
          description: "The complete user-facing final response.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      await invokeBeaconCli(params.text, signal);
      return {
        content: [{ type: "text", text: "Final Outcome accepted by Beacon." }],
        details: { submitted: true },
      };
    },
  });
}
