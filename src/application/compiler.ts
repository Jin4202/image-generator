import { z } from "zod";
import { Compiled, PreviewInput, Snapshot } from "../contracts";
import type { Money } from "../contracts";
import { AppError } from "../domain/errors";

type Options = Pick<PreviewInput, "adapterId" | "outputCount" | "seed">;
type Reference = Compiled["references"][number];
type Warning = Compiled["warnings"][number];

const roleOrder: Record<Reference["role"], number> = { parent: 0, character: 1, style: 2, sketch: 3, mask: 4 };
const endpoints: Record<Options["adapterId"], string> = { "mock-reference": "mock://fixture", "fal-flux2-edit": "fal-ai/flux-2/edit", "fal-flux2-text": "fal-ai/flux-2" };
/** Reference counts each adapter accepts; text sends none. Inputs beyond these are blocked, never truncated. */
const referenceLimits: Record<Options["adapterId"], { min: number; max: number } | null> = { "mock-reference": { min: 0, max: 4 }, "fal-flux2-edit": { min: 1, max: 4 }, "fal-flux2-text": null };
const warningOrder: readonly Warning[] = ["SOFT_LAYOUT", "FULL_IMAGE_EDIT", "REFERENCES_OMITTED", "NEGATIVE_AS_TEXT"];
const mockPrice: Money = { kind: "known", micros: 0, currency: "USD", source: "mock", verifiedAt: "2026-10-26T00:00:00.000Z" };
const falPrice: Money = { kind: "unknown", reason: "pricing-not-configured" };
const OptionsSchema = z.object({ adapterId: PreviewInput.shape.adapterId, outputCount: PreviewInput.shape.outputCount, seed: PreviewInput.shape.seed });

/** JSON with object keys sorted at every depth and array order kept; used for prompts and preview hashes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(v => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined);
    return `{${entries.map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const unsupported = (message: string): never => { throw new AppError("UNSUPPORTED", message); };

/** T05: deterministic compilation; no DB, file, network or clock access. */
export function compile(snapshot: Snapshot, options: Pick<PreviewInput, "adapterId" | "outputCount" | "seed">): Compiled {
  const parsedSnapshot = Snapshot.safeParse(snapshot);
  const parsedOptions = OptionsSchema.safeParse(options);
  if (!parsedSnapshot.success || !parsedOptions.success) throw new AppError("VALIDATION", "Invalid snapshot or compile options");
  // Zod parsing returns fresh objects, so nothing below can mutate the caller's snapshot.
  const s = parsedSnapshot.data; const { adapterId, outputCount, seed } = parsedOptions.data;
  const sceneRefs = s.scene.references;
  const parentRefs = sceneRefs.filter(r => r.role === "parent").length;
  if ((s.parentCandidateId === null) !== (s.edit === null) || (s.parentCandidateId === null ? parentRefs !== 0 : parentRefs !== 1)) throw new AppError("VALIDATION", "Edits need exactly one parent candidate, its parent reference and an edit");
  if (s.edit?.maskMediaId != null || sceneRefs.some(r => r.role === "mask")) unsupported("Masks are not supported by any adapter; remove the mask to request a whole-image edit");

  const limits = referenceLimits[adapterId];
  if (!limits && s.edit) unsupported("Text baseline cannot edit a parent image");
  const references = limits ? sceneRefs.map((ref, i) => ({ ref, i })).sort((a, b) => roleOrder[a.ref.role] - roleOrder[b.ref.role] || a.i - b.i).map(({ ref }) => ref) : [];
  if (limits && (references.length < limits.min || references.length > limits.max)) unsupported(`${adapterId} accepts ${limits.min}–${limits.max} reference images; this request has ${references.length}. Choose which to send`);

  const warnings = new Set<Warning>();
  if (s.scene.boxes.length > 0 || sceneRefs.some(r => r.role === "sketch")) warnings.add("SOFT_LAYOUT");
  if (s.edit) warnings.add("FULL_IMAGE_EDIT");
  if (!limits && sceneRefs.length > 0) warnings.add("REFERENCES_OMITTED");
  if (s.style && s.style.specification.negative.trim() !== "") warnings.add("NEGATIVE_AS_TEXT");

  const prompt = [
    "[SCENE]", s.scene.prompt,
    "[CAMERA]", s.scene.camera,
    "[STYLE]", canonicalJson(s.style?.specification ?? {}),
    "[ASSETS]", canonicalJson(s.assets.map(a => ({ name: a.name, kind: a.kind, invariants: a.invariants, variants: a.variants }))),
    "[LAYOUT]", canonicalJson(s.scene.boxes),
    "[REFERENCES]", canonicalJson(references.map((r, i) => ({ index: i + 1, role: r.role, note: r.note }))),
    "[EDIT]", canonicalJson(s.edit),
  ].join("\n");

  return Compiled.parse({
    adapterId, endpoint: endpoints[adapterId], prompt, references,
    parameters: { image_size: s.scene.size, num_images: outputCount, seed, guidance_scale: 2.5, num_inference_steps: 28, acceleration: "regular", enable_prompt_expansion: false, enable_safety_checker: true, output_format: "png", sync_mode: false },
    warnings: warningOrder.filter(w => warnings.has(w)),
    estimate: adapterId === "mock-reference" ? mockPrice : falPrice,
  });
}
