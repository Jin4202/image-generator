"use client";
import Link from "next/link";
import { useState } from "react";
import { z } from "zod";
import * as C from "@/contracts";
import { passesReview } from "@/domain/approval";
import { postJson, useApi } from "../_studio/api";
import { PreviewDetails, RunMonitor, SubmitPanel } from "../_studio/generation";
import { MediaSelect, Thumb } from "../_studio/media";
import { ErrorText, Loaded, PageShell, Panel, buttonClass, formatDate, inputClass, secondaryButtonClass, useSelection, useWorkspace, withQuery } from "../_studio/ui";

export default function Page() {
  return <PageShell title="평가와 수정"><ReviewView /></PageShell>;
}

const CandidateView = z.object({ candidate: C.Candidate, reviews: z.array(C.Review) });
type Ratings = z.infer<typeof C.ReviewInput>;
const scoreFields = [["identity", "정체성"], ["style", "스타일"], ["composition", "구도"], ["anatomy", "해부학"]] as const;

function ReviewView() {
  const projectId = useSelection("projectId"); const candidateId = useSelection("candidateId");
  const [candidateLoad, reloadCandidate] = useApi(candidateId ? `/api/candidates/${candidateId}` : null, CandidateView);
  const [workspace] = useWorkspace(projectId);
  const ws = workspace.state === "ready" ? workspace.data : null;
  return (
    <Loaded load={candidateLoad} idle={<>평가할 후보가 선택되지 않았습니다. <Link className="underline" href={withQuery("/history", { projectId })}>이력</Link>에서 후보를 고르세요.</>}>
      {({ candidate, reviews }) => {
        const parent = ws?.candidates.find(c => c.id === candidate.parentCandidateId) ?? null;
        const run = ws?.runs.find(r => r.id === candidate.runId) ?? null;
        const isEdit = candidate.parentCandidateId !== null;
        return (
          <div className="space-y-6">
            <Panel title={isEdit ? "원본과 수정본 비교" : "후보"}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {isEdit && <figure><figcaption className="text-sm text-slate-400">원본 (부모)</figcaption>{parent ? <Thumb mediaId={parent.mediaId} alt="원본 후보" size="h-72 w-full" /> : <p className="text-sm text-slate-400">원본 후보를 불러오는 중이거나 찾을 수 없습니다.</p>}</figure>}
                <figure><figcaption className="text-sm text-slate-400">{isEdit ? "수정본 (자식)" : `후보 ${candidate.index + 1}`}</figcaption><Thumb mediaId={candidate.mediaId} alt="평가 대상 후보" size="h-72 w-full" /></figure>
              </div>
              {run?.snapshot.edit && <p className="text-sm text-slate-300">수정 지시: {run.snapshot.edit.instruction} · 보존: {run.snapshot.edit.preservation || "—"}</p>}
              <p className="flex flex-wrap gap-3 text-sm">
                <Link className="underline" href={withQuery("/effects", { projectId, candidateId: candidate.id })}>효과·내보내기</Link>
                {parent && <Link className="underline" href={withQuery("/review", { projectId, candidateId: parent.id })}>원본 평가 보기</Link>}
              </p>
            </Panel>
            <ReviewForm candidateId={candidate.id} isEdit={isEdit} onSaved={reloadCandidate} />
            <Panel title="평가 기록 (추가만 가능)">
              {reviews.length === 0 ? <p className="text-sm text-slate-400">아직 평가가 없습니다.</p> : (
                <ol className="space-y-2 text-sm">
                  {reviews.map((r, i) => {
                    const pass = passesReview(r.ratings, isEdit);
                    return (
                      <li key={r.id} className="rounded border border-slate-700 p-2">
                        <p>{formatDate(r.createdAt)} {i === reviews.length - 1 && <b className="text-teal-300">· 현재 판정</b>}</p>
                        <p>정체성 {r.ratings.identity} · 스타일 {r.ratings.style} · 구도 {r.ratings.composition} · 해부학 {r.ratings.anatomy}{r.ratings.preservation !== null ? ` · 보존 ${r.ratings.preservation}` : ""}</p>
                        <p>{r.ratings.approved ? "사람 승인" : "미승인"} · <span className={pass ? "text-teal-300" : "text-amber-300"}>{pass ? "기준 통과" : "기준 미달"}</span>{r.ratings.notes ? ` · ${r.ratings.notes}` : ""}</p>
                      </li>
                    );
                  })}
                </ol>
              )}
            </Panel>
            {run && ws && <RefinePanel candidate={candidate} sceneId={run.snapshot.sceneId} ws={ws} />}
          </div>
        );
      }}
    </Loaded>
  );
}

function ReviewForm({ candidateId, isEdit, onSaved }: { candidateId: string; isEdit: boolean; onSaved: () => void }) {
  const [ratings, setRatings] = useState<Ratings>({ identity: 3, style: 3, composition: 3, anatomy: 3, preservation: isEdit ? 3 : null, approved: false, notes: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const pass = passesReview(ratings, isEdit);
  async function save() {
    setBusy(true); setError(null);
    try { await postJson(`/api/candidates/${candidateId}/review`, ratings, C.Review); onSaved(); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  const score = (key: "identity" | "style" | "composition" | "anatomy" | "preservation", label: string) => (
    <label key={key} className="flex items-center gap-1 text-sm">{label}
      <select className={inputClass} value={ratings[key] ?? 3} onChange={e => setRatings({ ...ratings, [key]: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map(n => <option key={n}>{n}</option>)}</select>
    </label>
  );
  return (
    <Panel title="평가 남기기">
      <div className="flex flex-wrap gap-3">{scoreFields.map(([k, l]) => score(k, l))}{isEdit && score("preservation", "비대상 영역 보존")}</div>
      <p className="text-xs text-slate-400">기준: 정체성·스타일·구도 4 이상, 해부학 3 이상{isEdit ? ", 보존 4 이상" : ""}, 그리고 사람 승인. 미달이어도 기록할 수 있습니다.</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ratings.approved} onChange={e => setRatings({ ...ratings, approved: e.target.checked })} />이 후보를 승인합니다</label>
      <textarea className={`${inputClass} w-full`} rows={2} maxLength={2000} placeholder="메모" value={ratings.notes} onChange={e => setRatings({ ...ratings, notes: e.target.value })} />
      <p className={`text-sm ${pass ? "text-teal-300" : "text-amber-300"}`}>이 평가는 {pass ? "기준을 통과합니다" : "기준에 미달합니다"}.</p>
      <button type="button" className={buttonClass} disabled={busy} onClick={save}>평가 저장</button>
      <ErrorText error={error} />
    </Panel>
  );
}

function RefinePanel({ candidate, sceneId, ws }: { candidate: C.Candidate; sceneId: string; ws: C.Workspace }) {
  const [instruction, setInstruction] = useState("");
  const [preservation, setPreservation] = useState("");
  const [maskMediaId, setMaskMediaId] = useState("");
  const [adapterId, setAdapterId] = useState<"mock-reference" | "fal-flux2-edit">("mock-reference");
  const [preview, setPreview] = useState<C.Preview | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const hasMask = maskMediaId !== "";

  async function requestPreview() {
    if (hasMask || !instruction.trim()) return;
    setBusy(true); setError(null); setPreview(null);
    try {
      setPreview(await postJson(`/api/candidates/${candidate.id}/refine`, { sceneId, adapterId, outputCount: 1, seed: null, edit: { instruction, preservation, maskMediaId: null } }, C.Preview));
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <Panel title="수정본 만들기 (원본 유지)">
      <p className="rounded border border-amber-700 bg-amber-950/40 p-2 text-sm text-amber-200">FULL_IMAGE_EDIT: 마스크 없이 전체 이미지를 다시 생성합니다. 보존하려는 영역도 바뀔 수 있으며, 원본 후보는 그대로 남습니다.</p>
      <textarea className={`${inputClass} w-full`} rows={2} maxLength={2000} placeholder="수정 지시 (예: 칼날 모양 수정)" aria-label="수정 지시" value={instruction} onChange={e => { setInstruction(e.target.value); setPreview(null); }} />
      <textarea className={`${inputClass} w-full`} rows={2} maxLength={2000} placeholder="보존할 것 (예: 얼굴, 망토 색)" aria-label="보존 지시" value={preservation} onChange={e => { setPreservation(e.target.value); setPreview(null); }} />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">모델
          <select className={inputClass} value={adapterId} onChange={e => { setAdapterId(e.target.value as typeof adapterId); setPreview(null); }}>
            <option value="mock-reference">mock-reference (MOCK)</option><option value="fal-flux2-edit">fal-flux2-edit</option>
          </select>
        </label>
        <label className="flex items-center gap-2">마스크 (선택)
          <MediaSelect media={ws.media} label="마스크 이미지" value={maskMediaId} onChange={id => { setMaskMediaId(id); setPreview(null); }} />
        </label>
      </div>
      {hasMask && (
        <div role="alert" className="space-y-2 rounded border border-red-800 bg-red-950/40 p-2 text-sm text-red-200">
          <p>현재 모델은 마스크 편집을 지원하지 않습니다. 마스크를 직접 제거해야 전체 이미지 수정으로 진행할 수 있습니다(자동으로 버리지 않습니다).</p>
          <button type="button" className={secondaryButtonClass} onClick={() => setMaskMediaId("")}>마스크 제거</button>
        </div>
      )}
      <button type="button" className={buttonClass} disabled={hasMask || !instruction.trim() || busy} onClick={requestPreview}>수정 미리보기</button>
      <ErrorText error={error} />
      {preview && <PreviewDetails preview={preview} />}
      {preview && <SubmitPanel preview={preview} sceneSelected budgetMicros={ws.project.budgetMicros} onSubmitted={run => { setPreview(null); setRunId(run.id); }} />}
      {runId && <RunMonitor runId={runId} projectId={ws.project.id} />}
    </Panel>
  );
}
