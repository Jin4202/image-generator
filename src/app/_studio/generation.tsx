"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import * as C from "@/contracts";
import { ApiError, api, describeError, formatMoney, mediaUrl, postJson } from "./api";
import { ErrorText, buttonClass, formatDate, inputClass, secondaryButtonClass, withQuery } from "./ui";

const RunView = z.object({ run: C.Run, candidates: z.array(C.Candidate) });
type RunView = z.infer<typeof RunView>;
const warningText: Record<C.Compiled["warnings"][number], string> = {
  SOFT_LAYOUT: "스케치·박스는 약한 레이아웃 힌트입니다. 모델이 정확히 따르지 않을 수 있습니다.",
  FULL_IMAGE_EDIT: "마스크 없이 전체 이미지를 다시 생성합니다. 보존하려는 영역도 바뀔 수 있습니다.",
  REFERENCES_OMITTED: "Text baseline: 참조 이미지는 전송되지 않고 스타일·자산 설명만 사용됩니다.",
  NEGATIVE_AS_TEXT: "Negative 지시는 별도 필드가 없어 프롬프트 본문 텍스트로만 전달됩니다.",
};
const statusText: Record<C.RunStatus, string> = {
  draft: "대기(제출 전)", submitting: "제출 중", queued: "대기열", running: "생성 중", downloading: "결과 저장 중",
  download_failed: "다운로드 실패 — 조치 필요", succeeded: "완료", failed: "실패", submission_unknown: "제출 결과 불명확 — 조치 필요",
};
/** States that do not change without a user action, plus terminal states: polling stops here. */
const settled: ReadonlySet<C.RunStatus> = new Set(["succeeded", "failed", "submission_unknown", "download_failed"]);

/** Exact request about to be sent: native parameters, references in send order, warnings and price. */
export function PreviewDetails({ preview }: { preview: C.Preview }) {
  const { compiled } = preview; const p = compiled.parameters;
  return (
    <div aria-label="요청 미리보기" className="space-y-3 text-sm">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
        <dt className="text-slate-400">모델</dt><dd>{compiled.adapterId} · {compiled.endpoint}</dd>
        <dt className="text-slate-400">크기·개수</dt><dd>{p.image_size.width}×{p.image_size.height} · {p.num_images}장</dd>
        <dt className="text-slate-400">seed</dt><dd>{p.seed ?? "무작위(전송 생략)"}</dd>
        <dt className="text-slate-400">만료</dt><dd>{formatDate(preview.expiresAt)}</dd>
      </dl>
      <div>
        <p className="font-medium">참조 (전송 순서)</p>
        {compiled.references.length === 0 ? <p className="text-slate-400">전송되는 참조 이미지 없음</p> : (
          <ol className="mt-1 flex flex-wrap gap-2">
            {compiled.references.map((ref, i) => (
              <li key={`${ref.mediaId}-${ref.role}`} className="w-28 rounded border border-slate-700 p-1">
                {/* eslint-disable-next-line @next/next/no-img-element -- local media route */}
                <img src={mediaUrl(ref.mediaId)} alt={`참조 ${i + 1} ${ref.role}`} className="h-20 w-full object-contain" />
                <p className="text-xs">{i + 1}. {ref.role}{ref.note ? ` · ${ref.note}` : ""}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
      {compiled.warnings.length > 0 && (
        <ul aria-label="제약 경고" className="space-y-1">
          {compiled.warnings.map(w => <li key={w} className="rounded border border-amber-700 bg-amber-950/40 p-2 text-amber-200"><b>{w}</b> — {warningText[w]}</li>)}
        </ul>
      )}
      <p>예상 비용: {compiled.estimate.kind === "known" ? <b>{formatMoney(compiled.estimate.micros)} ({compiled.estimate.source})</b> : <b className="text-amber-300">알 수 없음 ({compiled.estimate.reason}) — 0원이 아닙니다</b>}</p>
      <details><summary className="cursor-pointer text-slate-300">전송 프롬프트 보기</summary><pre className="mt-2 whitespace-pre-wrap break-all rounded bg-slate-900 p-2 text-xs">{compiled.prompt}</pre></details>
    </div>
  );
}

/** Explicit cost consent + submit. Never enabled without a selected scene, a live preview and consent. */
export function SubmitPanel({ preview, sceneSelected, budgetMicros, onSubmitted }: { preview: C.Preview | null; sceneSelected: boolean; budgetMicros: number | null; onSubmitted: (run: C.Run) => void }) {
  // Consent and errors belong to one preview; a new preview starts unconsented.
  const [consentFor, setConsentFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ previewId: string; error: unknown } | null>(null);
  const consent = preview !== null && consentFor === preview.id;
  const error = preview && failure?.previewId === preview.id ? failure.error : null;
  const [now, setNow] = useState(() => Date.now());
  // One idempotency key per preview: re-clicking after a lost response replays the same run instead of creating another.
  const idempotencyKey = useMemo(() => (preview ? crypto.randomUUID() : null), [preview]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 10_000); return () => clearInterval(t); }, []);
  const estimate = preview?.compiled.estimate;
  const expired = preview ? Date.parse(preview.expiresAt) <= now : false;
  const blockedByBudget = estimate?.kind === "unknown" && budgetMicros !== null;
  const disabled = !sceneSelected || !preview || !consent || expired || busy || blockedByBudget;

  async function submit() {
    if (!preview || !estimate || disabled) return;
    setBusy(true); setFailure(null);
    try {
      const body = estimate.kind === "known"
        ? { previewId: preview.id, previewHash: preview.hash, idempotencyKey, acceptUnknownCost: false, maxEstimatedCostMicros: estimate.micros }
        : { previewId: preview.id, previewHash: preview.hash, idempotencyKey, acceptUnknownCost: true, maxEstimatedCostMicros: null };
      onSubmitted(await postJson("/api/generations", body, C.Run));
    } catch (e) { setFailure({ previewId: preview.id, error: e }); } finally { setBusy(false); }
  }

  return (
    <div aria-label="생성 제출" className="space-y-2">
      {!sceneSelected && <p className="text-sm text-slate-400">장면을 선택해야 생성할 수 있습니다.</p>}
      {sceneSelected && !preview && <p className="text-sm text-slate-400">먼저 요청 미리보기를 만들어 정확한 요청과 비용을 확인하세요.</p>}
      {preview && estimate && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={consent} onChange={e => setConsentFor(e.target.checked ? preview.id : null)} disabled={blockedByBudget} className="mt-1" />
          {estimate.kind === "known"
            ? <span>예상 비용 {formatMoney(estimate.micros)} 이하로 이 요청을 1회 제출하는 데 동의합니다.</span>
            : <span><b>가격을 알 수 없음</b>을 이해했고, 상한 없이 이 요청을 1회 제출하는 데 동의합니다.</span>}
        </label>
      )}
      {blockedByBudget && <p className="text-sm text-amber-300">프로젝트에 예산이 설정되어 있어 가격을 모르는 요청은 제출할 수 없습니다.</p>}
      {expired && <p className="text-sm text-amber-300">미리보기가 만료되었습니다. 새 미리보기를 요청하세요.</p>}
      <button type="button" className={buttonClass} disabled={disabled} onClick={submit}>생성 실행</button>
      <ErrorText error={error} />
    </div>
  );
}

/** Polls a run every 2s until it is terminal or waits for the user; stops on unmount. Offers explicit recovery actions. */
export function RunMonitor({ runId, projectId }: { runId: string; projectId: string | null }) {
  const [view, setView] = useState<RunView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const [requestId, setRequestId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const status = view?.run.status;

  useEffect(() => {
    let live = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await api(`/api/generations/${runId}`, {}, RunView);
        if (!live) return;
        setView(next); setError(null);
        if (!settled.has(next.run.status)) timer = setTimeout(poll, C.Limits.pollMs);
      } catch (e) {
        if (!live) return;
        setError(e);
        // A 501/404 will not fix itself; transient failures keep polling.
        if (!(e instanceof ApiError && (e.notImplemented || e.status === 404))) timer = setTimeout(poll, C.Limits.pollMs);
      }
    };
    poll();
    return () => { live = false; clearTimeout(timer); };
  }, [runId, tick]);

  async function act(path: string, body: unknown) {
    setBusy(true); setError(null);
    try { await postJson(path, body, C.Run); setTick(t => t + 1); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <div aria-label="생성 진행" className="space-y-3 text-sm">
      {view ? (
        <>
          <p role="status">상태: <b>{statusText[view.run.status]}</b> ({view.run.status}){view.run.errorCode ? ` · ${view.run.errorCode}` : ""}</p>
          <p className="text-slate-400">제출 {formatDate(view.run.createdAt)} · 마지막 변경 {formatDate(view.run.updatedAt)} · 실제 비용 {view.run.actualCost.kind === "known" ? formatMoney(view.run.actualCost.micros) : "알 수 없음"}</p>
          {view.candidates.length > 0 && (
            <ul aria-label="생성 결과" className="flex flex-wrap gap-3">
              {view.candidates.map(c => (
                <li key={c.id} className="w-44 space-y-1">
                  {/* eslint-disable-next-line @next/next/no-img-element -- local media route */}
                  <img src={mediaUrl(c.mediaId)} alt={`후보 ${c.index + 1}`} className="h-40 w-full rounded bg-slate-900 object-contain" />
                  <Link className="underline" href={withQuery("/review", { projectId, candidateId: c.id })}>평가하기</Link>
                </li>
              ))}
            </ul>
          )}
          {status === "submission_unknown" && (
            <div className="space-y-2 rounded border border-amber-700 p-3">
              <p>제출 응답을 확인하지 못했습니다. 자동으로 다시 제출하지 않습니다. provider 콘솔에서 request ID를 찾았다면 연결하고, 아니면 중단하세요.</p>
              <div className="flex flex-wrap gap-2">
                <input className={inputClass} placeholder="provider request ID" aria-label="provider request ID" value={requestId} onChange={e => setRequestId(e.target.value)} />
                <button type="button" className={secondaryButtonClass} disabled={busy || !requestId.trim()} onClick={() => act(`/api/generations/${runId}/resolve`, { action: "attach", providerRequestId: requestId.trim() })}>request ID 연결</button>
              </div>
            </div>
          )}
          {status === "download_failed" && (
            <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => act(`/api/generations/${runId}/retry-download`, {})}>다운로드만 다시 시도</button>
          )}
          {(status === "submission_unknown" || status === "download_failed") && (
            <div className="flex flex-wrap items-center gap-2">
              <input className={inputClass} placeholder="중단 사유 (비밀 정보 입력 금지)" aria-label="중단 사유" value={reason} onChange={e => setReason(e.target.value)} />
              <button type="button" className={secondaryButtonClass} disabled={busy || !reason.trim()} onClick={() => act(`/api/generations/${runId}/resolve`, { action: "abandon", reason: reason.trim() })}>추적 중단</button>
              <span className="text-xs text-slate-400">중단은 provider 작업 취소나 환불이 아닙니다.</span>
            </div>
          )}
        </>
      ) : !error && <p role="status">상태 확인 중…</p>}
      <ErrorText error={error} />
    </div>
  );
}

export const runStatusText = statusText;
export { describeError };
