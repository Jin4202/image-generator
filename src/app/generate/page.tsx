"use client";
import { useState } from "react";
import * as C from "@/contracts";
import { describeError, postJson, useApi } from "../_studio/api";
import { PreviewDetails, RunMonitor, SubmitPanel } from "../_studio/generation";
import { ErrorText, PageShell, Panel, buttonClass, inputClass, useSelection, useSetQuery, useWorkspace } from "../_studio/ui";

export default function Page() {
  return <PageShell title="생성"><GenerateView /></PageShell>;
}

function GenerateView() {
  const projectId = useSelection("projectId"); const sceneId = useSelection("sceneId"); const runId = useSelection("runId");
  const setQuery = useSetQuery();
  const [workspace] = useWorkspace(projectId);
  const [models] = useApi("/api/models", C.ModelInfo.array());
  const [adapterId, setAdapterId] = useState<C.ModelInfo["id"]>("mock-reference");
  const [outputCount, setOutputCount] = useState(1);
  const [seed, setSeed] = useState("");
  const [preview, setPreview] = useState<C.Preview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const ws = workspace.state === "ready" ? workspace.data : null;
  const scene = ws?.scenes.find(s => s.id === sceneId) ?? null;
  const modelList = models.state === "ready" ? models.data : [];
  const selectedModel = modelList.find(m => m.id === adapterId);
  const seedValue = seed.trim() === "" ? null : Number(seed);
  const seedValid = seedValue === null || (Number.isInteger(seedValue) && seedValue >= 0 && seedValue <= 2147483647);
  const clearPreview = () => { setPreview(null); setError(null); };

  async function requestPreview() {
    if (!scene) return;
    setBusy(true); setError(null);
    try { setPreview(await postJson("/api/generations/preview", { sceneId: scene.id, adapterId, outputCount, seed: seedValue }, C.Preview)); }
    catch (e) { setPreview(null); setError(e); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <Panel title="장면 선택">
        {!projectId && <p className="text-sm text-slate-400">프로젝트가 선택되지 않았습니다. 프로젝트 화면에서 먼저 선택하세요.</p>}
        {workspace.state === "loading" && <p role="status" className="text-sm text-slate-400">장면 불러오는 중…</p>}
        {workspace.state === "error" && <ErrorText error={workspace.error} />}
        <label className="flex flex-wrap items-center gap-2 text-sm">장면
          <select className={inputClass} aria-label="장면" value={scene?.id ?? ""} disabled={!ws || ws.scenes.length === 0} onChange={e => { clearPreview(); setQuery({ sceneId: e.target.value || null, runId: null }); }}>
            <option value="">— 장면 선택 —</option>
            {ws?.scenes.map(s => <option key={s.id} value={s.id}>{s.content.prompt.slice(0, 40)} (rev {s.revision})</option>)}
          </select>
        </label>
        {ws && ws.scenes.length === 0 && <p className="text-sm text-slate-400">이 프로젝트에 장면이 없습니다. 장면 화면에서 먼저 만드세요.</p>}
        {scene && <p className="text-sm text-slate-300">“{scene.content.prompt}” · {scene.content.size.width}×{scene.content.size.height} · 참조 {scene.content.references.length}개</p>}
      </Panel>

      <Panel title="모델과 옵션">
        {models.state === "error" && <ErrorText error={models.error} />}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">모델
            <select className={inputClass} aria-label="모델" value={adapterId} onChange={e => { clearPreview(); setAdapterId(e.target.value as C.ModelInfo["id"]); }}>
              {modelList.map(m => <option key={m.id} value={m.id} disabled={!m.available}>{m.id} ({m.mode}{m.available ? "" : ` · ${m.reason ?? "사용 불가"}`})</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2">개수
            <select className={inputClass} aria-label="개수" value={outputCount} onChange={e => { clearPreview(); setOutputCount(Number(e.target.value)); }}>{[1, 2, 3, 4].map(n => <option key={n}>{n}</option>)}</select>
          </label>
          <label className="flex items-center gap-2">seed
            <input className={`${inputClass} w-32`} aria-label="seed" inputMode="numeric" placeholder="비우면 무작위" value={seed} onChange={e => { clearPreview(); setSeed(e.target.value); }} />
          </label>
        </div>
        {selectedModel && <p className="text-xs text-slate-400">참조 최대 {selectedModel.maxReferences}개 · 마스크 {selectedModel.masks ? "지원" : "미지원"} · {selectedModel.mode === "mock" ? "MOCK: 1×1 테스트 이미지만 생성되며 품질 평가용이 아닙니다." : "실제 유료 호출"}</p>}
        {!seedValid && <p className="text-sm text-amber-300">seed는 0 이상의 정수여야 합니다.</p>}
        <button type="button" className={buttonClass} disabled={!scene || busy || !seedValid || !selectedModel?.available} onClick={requestPreview}>요청 미리보기</button>
        {error ? <p role="alert" className="text-sm text-red-300">{describeError(error)}</p> : null}
      </Panel>

      <Panel title="요청 확인과 비용 동의">
        {preview && <PreviewDetails preview={preview} />}
        <SubmitPanel preview={preview} sceneSelected={scene !== null} budgetMicros={ws?.project.budgetMicros ?? null} onSubmitted={run => { clearPreview(); setQuery({ runId: run.id }); }} />
      </Panel>

      {runId && <Panel title="진행 상황"><RunMonitor runId={runId} projectId={projectId} /></Panel>}
    </div>
  );
}
