import type { z } from "zod";
import { ReviewInput } from "../contracts";
export function passesReview(input: z.infer<typeof ReviewInput>, isEdit: boolean): boolean {
  const r = ReviewInput.parse(input);
  return r.approved && r.identity >= 4 && r.style >= 4 && r.composition >= 4 && r.anatomy >= 3 && (!isEdit || (r.preservation !== null && r.preservation >= 4));
}
