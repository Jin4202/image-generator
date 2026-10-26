import { z } from "zod";
export const FalInput = z.object({ prompt: z.string().min(1), image_size: z.object({width:z.number().int().min(512).max(2048),height:z.number().int().min(512).max(2048)}), num_images:z.number().int().min(1).max(4), seed:z.number().int().optional(), guidance_scale:z.literal(2.5), num_inference_steps:z.literal(28), acceleration:z.literal("regular"), enable_prompt_expansion:z.literal(false), enable_safety_checker:z.literal(true), output_format:z.literal("png"), sync_mode:z.literal(false), image_urls:z.array(z.string().url()).min(1).max(4).optional() }).strict();
export type FalInput = z.infer<typeof FalInput>;
/** T07: injectable transport. Default: submit = one direct Queue REST POST (no retry); upload/status/result = instance-scoped @fal-ai/client. */
export interface FalTransport {
 submit(endpoint: string, input: FalInput): Promise<{request_id: string}>;
 status(endpoint: string, requestId: string): Promise<"IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED">;
 result(endpoint: string, requestId: string): Promise<unknown>;
 upload(bytes: Uint8Array): Promise<string>;
 fetchImage(url: string): Promise<Uint8Array>;
}

/** Provider may add fields; parse only this allowlist, never persist raw response. */
export const FalOutput = z.object({
 images: z.array(z.object({url:z.string().url(),content_type:z.literal("image/png").optional(),width:z.number().int().positive().max(2048).optional(),height:z.number().int().positive().max(2048).optional()})).min(1).max(4),
 seed:z.number().int(), has_nsfw_concepts:z.array(z.boolean()).min(1).max(4),
}).refine(v=>v.images.length===v.has_nsfw_concepts.length,"Safety flags must match image count");
