export const errorStatus = { VALIDATION: 400, NOT_FOUND: 404, CONFLICT: 409, STALE_PREVIEW: 409, BUDGET_EXCEEDED: 409, COST_UNKNOWN: 409, UNSUPPORTED: 422, INVALID_MEDIA: 422, TOO_LARGE: 413, FORBIDDEN: 403, PROVIDER: 502, STORAGE: 500, INTERNAL: 500, NOT_IMPLEMENTED: 501 } as const;
export type ErrorCode = keyof typeof errorStatus;
export class AppError extends Error {
  constructor(public readonly code: ErrorCode, message: string) { super(message); this.name = "AppError"; }
}
export class NotImplementedError extends AppError {
  constructor(public readonly taskId: string) { super("NOT_IMPLEMENTED", `Implementation required: ${taskId}`); this.name = "NotImplementedError"; }
}
export function unfinished(taskId: string): never { throw new NotImplementedError(taskId); }

/** External submission certainty must survive the adapter boundary. */
export class SubmissionError extends AppError {
  constructor(public readonly certainty: "rejected" | "unknown", message: string) { super("PROVIDER", message); this.name = "SubmissionError"; }
}
