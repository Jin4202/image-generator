"use client";
import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";

/** HTTP error from the JSON envelope `{ error: { code, message } }`; 501 means the feature is not wired yet. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "ApiError"; }
  get notImplemented() { return this.status === 501 || this.code === "NOT_IMPLEMENTED"; }
}

/** Calls a same-origin API route and returns `data`, validated with the contract schema when one is given. */
export async function api<T>(path: string, init: RequestInit = {}, schema?: z.ZodType<T>): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { cache: "no-store", ...init }); }
  catch { throw new ApiError(0, "NETWORK", "서버에 연결할 수 없습니다."); }
  const body = await response.json().catch(() => null) as { data?: unknown; error?: { code?: string; message?: string } } | null;
  if (!response.ok) throw new ApiError(response.status, body?.error?.code ?? `HTTP_${response.status}`, body?.error?.message ?? `요청 실패 (${response.status})`);
  if (!schema) return body?.data as T;
  const parsed = schema.safeParse(body?.data);
  if (!parsed.success) throw new ApiError(response.status, "BAD_RESPONSE", "서버 응답 형식이 계약과 다릅니다.");
  return parsed.data;
}

export const postJson = <T>(path: string, body: unknown, schema?: z.ZodType<T>, method = "POST") =>
  api<T>(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, schema);

/** User-facing text; 501 is always shown as "not implemented", never as success or empty data. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.notImplemented) return "미구현 (501 NOT_IMPLEMENTED): 이 기능의 서버 연결이 아직 완료되지 않았습니다. 결과가 저장되거나 생성되지 않았습니다.";
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : "알 수 없는 오류";
}

export type Load<T> = { state: "idle" } | { state: "loading" } | { state: "error"; error: unknown } | { state: "ready"; data: T };

/** GET with loading/error/ready states; `path === null` means nothing selected yet (idle). */
export function useApi<T>(path: string | null, schema?: z.ZodType<T>): [Load<T>, () => void] {
  const [tick, setTick] = useState(0);
  // Results are keyed by path: a new path shows "loading", while a reload of the same path keeps the previous data
  // on screen until the fresh response arrives (so forms below a refreshed view are not remounted and reset).
  const key = path ? `${path}#${tick}` : null;
  const [result, setResult] = useState<{ path: string; load: Load<T> } | null>(null);
  useEffect(() => {
    if (!path || !key) return;
    let live = true;
    api(path, {}, schema).then(data => { if (live) setResult({ path, load: { state: "ready", data } }); }, error => { if (live) setResult({ path, load: { state: "error", error } }); });
    return () => { live = false; };
  }, [path, schema, key]);
  const load: Load<T> = !path ? { state: "idle" } : result?.path === path ? result.load : { state: "loading" };
  return [load, useCallback(() => setTick(t => t + 1), [])];
}

export const mediaUrl = (mediaId: string) => `/api/media/${mediaId}`;
export const formatMoney = (micros: number) => `$${(micros / 1_000_000).toFixed(micros % 10_000 === 0 ? 2 : 6)}`;
