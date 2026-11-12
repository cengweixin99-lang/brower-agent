import assert from "node:assert/strict";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";

const models = createModels();
const agent = new Agent({
  initialState: { systemPrompt: "Environment validation only.", tools: [] },
  streamFn: models.streamSimple.bind(models),
  toolExecution: "sequential",
});
await agent.waitForIdle();
assert.equal(agent.state.isStreaming, false);
console.log("PASS: pi-ai and pi-agent-core loaded and initialized without provider requests.");
