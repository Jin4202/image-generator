"use client";
import Link from "next/link";
import * as C from "@/contracts";
import { passesReview } from "@/domain/approval";
import { formatMoney } from "../_studio/api";
import { runStatusText } from "../_studio/generation";
import { Thumb } from "../_studio/media";
import { Loaded, NeedProject, PageShell, Panel, formatDate, useSelection, useWorkspace, withQuery } from "../_studio/ui";

export default function Page() {
  return <PageShell title="이력"><HistoryView /></PageShell>;
}

/** Latency = final updatedAt − createdAt (queue wait included), only for succeeded runs. */
const latency = (run: C.Run) => run.status === "succeeded" ? `${((Date.parse(run.updatedAt) - Date.parse(run.createdAt)) / 1000).toFixed(1)}초` : "—";

function HistoryView() {
  const projectId = useSelection("projectId");
  const [workspace] = useWorkspace(projectId);
  return (
    <NeedProject projectId={projectId}>
      <Loaded load={workspace} isEmpty={ws => ws.runs.length === 0} empty={<>아직 생성 이력이 없습니다. <Link className="underline" href={withQuery("/generate", { projectId })}>생성</Link>에서 시작하세요.</>}>
        {ws => {
          const latestReview = (candidateId: string) => ws.reviews.filter(r => r.candidateId === candidateId).at(-1) ?? null;
          return (
            <Panel title={`${ws.project.title} · 생성 ${ws.runs.length}건`}>
              <ol className="space-y-4">
                {[...ws.runs].reverse().map(run => {
                  const scene = ws.scenes.find(s => s.id === run.snapshot.sceneId);
                  const candidates = ws.candidates.filter(c => c.runId === run.id).sort((a, b) => a.index - b.index);
                  const parent = run.snapshot.parentCandidateId;
                  return (
                    <li key={run.id} className="space-y-2 rounded border border-slate-700 p-3 text-sm">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p><b>{runStatusText[run.status]}</b>{run.errorCode ? ` · ${run.errorCode}` : ""}</p>
                        <p className="text-slate-400">{formatDate(run.createdAt)} · {run.compiled.adapterId} · 소요 {latency(run)} · 비용 {run.actualCost.kind === "known" ? formatMoney(run.actualCost.micros) : run.compiled.estimate.kind === "known" ? `예상 ${formatMoney(run.compiled.estimate.micros)}` : "알 수 없음"}</p>
                      </div>
                      <p className="text-slate-300">장면: {scene?.content.prompt.slice(0, 60) ?? run.snapshot.scene.prompt.slice(0, 60)} (rev {run.snapshot.sceneRevision}){run.snapshot.style ? ` · 스타일 v${run.snapshot.style.version}` : ""}{run.snapshot.assets.map(a => ` · ${a.name} v${a.version}`).join("")}</p>
                      {parent && <p className="text-slate-300">수정본 · 지시: {run.snapshot.edit?.instruction} · <Link className="underline" href={withQuery("/review", { projectId, candidateId: parent })}>원본</Link></p>}
                      {candidates.length > 0 && (
                        <ul className="flex flex-wrap gap-3">
                          {candidates.map(c => {
                            const review = latestReview(c.id);
                            return (
                              <li key={c.id} className="w-36 space-y-1">
                                <Thumb mediaId={c.mediaId} alt={`후보 ${c.index + 1}`} size="h-32 w-36" />
                                <p className="text-xs">{review ? (passesReview(review.ratings, c.parentCandidateId !== null) ? "✓ 기준 통과" : "기준 미달") : "미평가"}</p>
                                <p className="flex gap-2 text-xs"><Link className="underline" href={withQuery("/review", { projectId, candidateId: c.id })}>평가</Link><Link className="underline" href={withQuery("/effects", { projectId, candidateId: c.id })}>효과</Link></p>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      <Link className="text-xs underline" href={withQuery("/generate", { projectId, sceneId: run.snapshot.sceneId, runId: run.id })}>진행 상황 보기</Link>
                    </li>
                  );
                })}
              </ol>
            </Panel>
          );
        }}
      </Loaded>
    </NeedProject>
  );
}
