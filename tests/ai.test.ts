import { test } from "node:test";
import assert from "node:assert/strict";
import { aiStatus, billingGate, readCompletedDesign } from "../server/ai";
import { estimateDesign } from "../src/design/estimate";
import { fixtureImage, fixtureOptions } from "./helpers/imageFixture";

test("no API key, present key, and failed ChatGPT plan never silently enable separate billing", () => {
  const env = { TRADIATIVE_AI_KEY: "test-not-a-live-secret" };
  assert.equal(aiStatus(env).actualRequestVerified, false);
  assert.equal(aiStatus(env).plan.loginCompleted, false);
  assert.equal(aiStatus(env).remainingUsage, null);
  assert.equal(billingGate("chatgpt-plan", true, env)!.status, 503);
  assert.equal(billingGate("separate-api", true, env)!.status, 403);
  assert.equal(billingGate("separate-api", false, { ...env, TRADIATIVE_ALLOW_SEPARATE_API: "true" })!.status, 403);
  assert.equal(billingGate("separate-api", true, { ...env, TRADIATIVE_ALLOW_SEPARATE_API: "true" }), null);
});
test("stream start, incomplete response, refusal, empty and malformed results never count as completed", () => {
  const options = fixtureOptions(), ids = new Set(["test-reference"]);
  for (const result of [{ status: "in_progress", output: [] }, { status: "incomplete", output: [] }, { status: "completed", output: [{content:[{type:"refusal",refusal:"no"}]}] }, { status: "completed", output: [] }, {status:"completed",output:[{content:[{type:"output_text",text:"not JSON"}]}]}]) {
    assert.throws(() => readCompletedDesign(result, options, ids));
  }
});
test("mock completed response validates full variable geometry and resets model verification claims", () => {
  const options = fixtureOptions(), scene = estimateDesign(fixtureImage(), options);
  scene.elements.forEach(e => { e.userConfirmed = true; e.measured = true; });
  const result = { status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(scene) }] }] };
  const parsed = readCompletedDesign(result, options, new Set(["test-reference"]));
  assert.ok(parsed.elements.every(e => !e.userConfirmed && !e.measured));
  assert.equal(parsed.elements.filter(e => e.kind === "opening").length, 4);
  assert.throws(() => readCompletedDesign(result, options, new Set(["different-source"])), /원본 자료|열람하지/);
});
