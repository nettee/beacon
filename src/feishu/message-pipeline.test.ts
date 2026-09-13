import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TriggerStore } from "../state/trigger-store.js";
import type { FeishuMessageEvent } from "./intake.js";
import type { FeishuMessageGateway } from "./message-gateway.js";
import { createFeishuMessagePipeline } from "./message-pipeline.js";
import type { FetchedMessage } from "./trigger-input.js";

class TestGateway implements FeishuMessageGateway {
  private handleEvent?: (event: FeishuMessageEvent) => Promise<unknown>;
  readonly acknowledged: string[] = [];

  async run(
    handleEvent: (event: FeishuMessageEvent) => Promise<unknown>,
    shutdown: Promise<void>,
  ): Promise<void> {
    this.handleEvent = handleEvent;
    await shutdown;
  }

  async emit(event: FeishuMessageEvent): Promise<unknown> {
    if (!this.handleEvent) throw new Error("Gateway is not running");
    return this.handleEvent(event);
  }

  async acknowledge(messageId: string): Promise<void> {
    this.acknowledged.push(messageId);
  }

  async fetchMessage(_messageId: string): Promise<FetchedMessage> {
    throw new Error("No quoted message expected");
  }

  async deliver(): Promise<Record<string, never>> {
    throw new Error("Delivery is not exercised by this test");
  }
}

test("a factory-created message pipeline receives through its Gateway", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beacon-message-pipeline-"));
  const gateway = new TestGateway();
  const processed: string[] = [];
  let stop!: () => void;
  const shutdown = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const pipeline = createFeishuMessagePipeline({
    gateway,
    store: new TriggerStore(directory, "profile"),
    async process(_triggerKey, normalize) {
      const input = await normalize();
      processed.push(input.kind);
    },
    onFatal(error) {
      throw error;
    },
  });

  const running = pipeline.run(shutdown);
  const result = await gateway.emit({
    event_id: "event-1",
    sender: { sender_type: "user", sender_id: { open_id: "user-1" } },
    message: {
      message_id: "message-1",
      chat_id: "chat-1",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "hello" }),
    },
  });
  await pipeline.drain();
  stop();
  await running;

  assert.equal(result, "accepted");
  assert.deepEqual(processed, ["feishu_message"]);
  assert.deepEqual(gateway.acknowledged, ["message-1"]);
});
