import type { RunStatus } from "../contracts";
import { AppError, SubmissionError } from "./errors";
export const transitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  draft: ["submitting", "failed"], submitting: ["queued", "submission_unknown", "failed"],
  queued: ["running", "downloading", "failed"], running: ["downloading", "failed"],
  downloading: ["succeeded", "download_failed"], download_failed: ["downloading", "failed"],
  submission_unknown: ["queued", "failed"], succeeded: [], failed: [],
};
export function transition(from: RunStatus, to: RunStatus): RunStatus {
  if (from === to) return to;
  if (!transitions[from].includes(to)) throw new AppError("CONFLICT", `Invalid run transition: ${from} -> ${to}`);
  return to;
}

/** Unknown exceptions default to ambiguity, never to permission to resubmit. */
export function submissionFailureState(error: unknown): "failed" | "submission_unknown" {
  return error instanceof SubmissionError && error.certainty === "rejected" ? "failed" : "submission_unknown";
}
