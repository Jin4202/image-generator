"use client";
import Link from "next/link";
import { useState } from "react";
import { z } from "zod";
import * as C from "@/contracts";
import { EffectsCanvas } from "@/components/canvas/effects-canvas";
import { mediaUrl, postJson, useApi } from "../_studio/api";
import { ErrorText, Loaded, PageShell, Panel, buttonClass, formatDate, secondaryButtonClass, useSelection, useWorkspace, withQuery } from "../_studio/ui";

export default function Page() {
  return <PageShell title="효과와 내보내기"><EffectsView /></PageShell>;
}

type Value = z.infer<typeof C.EffectsInput>;
const CandidateView = z.object({ candidate: C.Candidate, reviews: z.array(C.Review) });
const defaults: Omit<Value, "expectedRevision"> = { layers: [], brightness: 1, contrast: 1, saturation: 1, blur: 0 };
const sameContent = (a: Omit<Value, "expectedRevision">, b: Omit<Value, "expectedRevision">) => JSON.stringify({ ...a, expectedRevision: 0 }) === JSON.stringify({ ...b, expectedRevision: 0 });

function EffectsView() {
  const projectId = useSelection("projectId"); const candidateId = useSelection("candidateId");
  const [candidateLoad] = useApi(candidateId ? `/api/candidates/${candidateId}` : null, CandidateView);
  const [effectsLoad, reloadEffects] = useApi(candidateId ? `/api/candidates/${candidateId}/effects` : null, C.Effects.nullable());
  const [workspace, reloadWorkspace] = useWorkspace(projectId);
  const ws = workspace.state === "ready" ? workspace.data : null;
  return (
    <Loaded load={candidateLoad} idle={<>후보가 선택되지 않았습니다. <Link className="underline" href={withQuery("/history", { projectId })}>이력</Link>에서 후보를 고르세요.</>}>
      {({ candidate }) => (
        <Loaded load={effectsLoad}>
          {effects => (
            <div className="space-y-6">
              <EffectsEditor key={effects ? `${effects.id}:${effects.revision}` : "none"} candidate={candidate} effects={effects} onSaved={reloadEffects} onExported={reloadWorkspace} />
              <Panel title="이전 내보내기">
                {!ws ? <p className="text-sm text-slate-400">프로젝트를 선택하면 이전 내보내기를 볼 수 있습니다.</p> : <ExportList records={ws.exports.filter(e => e.candidateId === candidate.id)} />}
              </Panel>
            </div>
          )}
        </Loaded>
      )}
    </Loaded>
  );
}

function EffectsEditor({ candidate, effects, onSaved, onExported }: { candidate: C.Candidate; effects: C.Effects | null; onSaved: () => void; onExported: () => void }) {
  const saved = effects?.content ?? { ...defaults, expectedRevision: 0 };
  const [value, setValue] = useState<Value>(structuredClone(saved));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState<C.ExportRecord | null>(null);
  const dirty = !sameContent(value, saved);

  async function save() {
    setBusy(true); setError(null);
    // Next expectedRevision is the stored Effects.revision (0 for the first save), not content.expectedRevision.
    try { await postJson(`/api/candidates/${candidate.id}/effects`, { ...value, expectedRevision: effects?.revision ?? 0 }, C.Effects, "PUT"); onSaved(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function exportPng() {
    setBusy(true); setError(null);
    try { setExported(await postJson("/api/exports", { candidateId: candidate.id }, C.ExportRecord)); onExported(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <Panel title="효과 편집">
      <EffectsCanvas imageUrl={mediaUrl(candidate.mediaId)} value={value} onChange={setValue} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass} disabled={!dirty || busy} onClick={save}>효과 저장</button>
        <button type="button" className={secondaryButtonClass} disabled={!dirty || busy} onClick={() => setValue(structuredClone(saved))}>저장된 상태로 되돌리기</button>
        <button type="button" className={buttonClass} disabled={dirty || busy} onClick={exportPng}>PNG + manifest 내보내기</button>
        {dirty && <span className="text-sm text-amber-300">저장하지 않은 변경이 있습니다. 내보내기는 저장된 효과를 사용합니다.</span>}
        {!effects && !dirty && <span className="text-sm text-slate-400">저장된 효과 없음 — 원본 그대로 내보냅니다.</span>}
      </div>
      <ErrorText error={error} />
      {exported && <ExportList records={[exported]} />}
      <p className="text-xs text-slate-400">원본 후보 이미지는 바뀌지 않습니다. PNG와 manifest 두 파일만으로 다른 컴퓨터에서 프로젝트를 복원할 수는 없습니다(참조 원본은 이 컴퓨터의 data/blobs에 남습니다).</p>
    </Panel>
  );
}

function ExportList({ records }: { records: C.ExportRecord[] }) {
  if (records.length === 0) return <p className="text-sm text-slate-400">아직 내보내기가 없습니다.</p>;
  return (
    <ul aria-label="내보내기 파일" className="space-y-1 text-sm">
      {records.map(r => (
        <li key={r.id} className="flex flex-wrap gap-3">
          <span className="text-slate-400">{formatDate(r.createdAt)}</span>
          <a className="underline" href={mediaUrl(r.pngMediaId)} download={`export-${r.id}.png`}>PNG 다운로드</a>
          <a className="underline" href={`/api/exports/${r.id}/manifest`} download>manifest 다운로드</a>
        </li>
      ))}
    </ul>
  );
}
