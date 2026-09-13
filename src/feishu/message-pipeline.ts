import type { TriggerInput } from "../domain/types.js";
import type { TriggerStore } from "../state/trigger-store.js";
import { FeishuIntake } from "./intake.js";
import type { FeishuMessageGateway } from "./message-gateway.js";

export type FeishuMessagePipelineOptions = {
  gateway: FeishuMessageGateway;
  store: TriggerStore;
  process(
    triggerKey: string,
    normalize: () => Promise<TriggerInput>,
  ): Promise<void>;
  onFatal(error: Error): void;
};

export function createFeishuMessagePipeline(
  options: FeishuMessagePipelineOptions,
) {
  const intake = new FeishuIntake({
    store: options.store,
    process: options.process,
    fetchMessage: (messageId) => options.gateway.fetchMessage(messageId),
    acknowledge: (messageId) => options.gateway.acknowledge(messageId),
    onFatal: options.onFatal,
  });

  return {
    run: (shutdown: Promise<void>) =>
      options.gateway.run((event) => intake.handle(event), shutdown),
    drain: () => intake.drain(),
  };
}
