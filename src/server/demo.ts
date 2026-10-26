import { z } from "zod";
import { Compiled } from "../contracts";
import { MockAdapter } from "../infrastructure/models/mock";
export const DemoInput = z.object({ prompt: z.string().trim().min(1).max(4000) }).strict();
export async function runDemo(input: z.infer<typeof DemoInput>) {
  const compiled = Compiled.parse({ adapterId: "mock-reference", endpoint: "mock://fixture", prompt: input.prompt, references: [], parameters: { image_size: { width: 512, height: 512 }, num_images: 1, seed: 1, guidance_scale: 2.5, num_inference_steps: 28, acceleration: "regular", enable_prompt_expansion: false, enable_safety_checker: true, output_format: "png", sync_mode: false }, warnings: [], estimate: { kind: "known", micros: 0, currency: "USD", source: "mock", verifiedAt: "2026-10-26T00:00:00.000Z" } });
  const adapter = new MockAdapter(); const { requestId } = await adapter.submit(compiled, [], { signal: new AbortController().signal, mayPost: () => true });
  const states = [];
  for (let i = 0; i < 3; i++) states.push(await adapter.poll(requestId));
  const result = states[2];
  if (result.status !== "completed") throw new Error("Mock contract broken");
  const outputs = await adapter.download(requestId);
  return { mode: "mock" as const, persisted: false as const, fixtureSize: { width: 1, height: 1 }, compiled, trace: states.map(s => s.status), imageDataUrl: `data:image/png;base64,${Buffer.from(outputs[0].bytes).toString("base64")}` };
}
