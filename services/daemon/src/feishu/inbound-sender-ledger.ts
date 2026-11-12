import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export type InboundSenderLedgerEntry = {
  at: string;
  profileId: string;
  triggerKey: string;
  openId?: string | undefined;
  name?: string | undefined;
  chatId: string;
  chatType: string;
  messageId: string;
  eventId: string;
};

/** Append-only usage ledger next to triggers/: one JSON line per inbound Feishu accept. */
export function inboundSenderLedgerPath(triggersRoot: string): string {
  return join(dirname(triggersRoot), "inbound-senders.jsonl");
}

export async function appendInboundSenderLedger(
  triggersRoot: string,
  entry: InboundSenderLedgerEntry,
): Promise<void> {
  const path = inboundSenderLedgerPath(triggersRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(entry)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
