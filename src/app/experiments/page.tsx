"use client";
import { useState } from "react";
import { z } from "zod";
import * as C from "@/contracts";
import { formatMoney, postJson, useApi } from "../_studio/api";
import { PreviewDetails, RunMonitor, SubmitPanel, runStatusText } from "../_studio/generation";
import { ErrorText, Loaded, NeedProject, PageShell, Panel, buttonClass, inputClass, secondaryButtonClass, useSelection, useSetQuery, useWorkspace } from "../_studio/ui";

export default function Page() {
  return <PageShell title="실험"><ExperimentsView /></PageShell>;
}

const routes = [["fal-flux2-edit", "참조 경로"], ["fal-flux2-text", "텍스트 기준선"]] as const;
const seeds = [0, 1, 2] as const;
type Route = (typeof routes)[number][0];
type Slot = { sceneId: string; adapterId: Route; seed: number };
const Report = z.object({ total: z.number(), accepted: z.number(), acceptanceRate: z.number().nullable(), costPerAccepted: C.Money, medianLatencyMs: z.number().nullable() });
const reasonText: Record<string, string> = { "no-accepted-results": "승인된 결과 없음", "incomplete-billing": "실제 비용이 보고되지 않은 run 포함" };
const slotOf = (run: C.Run) => `${run.snapshot.sceneId}|${run.compiled.adapterId}|${run.compiled.parameters.seed}`;
const slotKey = (s: Slot) => `${s.sceneId}|${s.adapterId}|${s.seed}`;

function ExperimentsView() {
  const projectId = useSelection("projectId"); const experimentId = useSelection("experimentId"); const setQuery = useSetQuery();
  const [workspace, reload] = useWorkspace(projectId);
  return (
    <NeedProject projectId={projectId}>
      <Loaded load={workspace}>
        {ws => {
          const experiment = ws.experiments.find(e => e.id === experimentId) ?? null;
          return (
            <div className="space-y-6">
              <p className="rounded border border-slate-700 p-3 text-sm text-slate-300">같은 승인 캐릭터·스타일로 장면 3개를 참조 경로(fal-flux2-edit)와 텍스트 기준선(fal-flux2-text)으로 각 3번(seed 0·1·2) 생성해 비교합니다. 실험을 만들어도 자동 생성이나 과금은 없으며, 18개 슬롯은 하나씩 미리보기·비용 동의·제출로 직접 실행합니다. 결과 판정은 사람의 평가로만 하며 통계적 결론을 주장하지 않습니다.</p>
              <CreateExperiment ws={ws} onCreated={created => { reload(); setQuery({ experimentId: created.id }); }} />
              <Panel title="실험 목록">
                {ws.experiments.length === 0 ? <p className="text-sm text-slate-400">아직 실험이 없습니다.</p> : (
                  <ul className="space-y-1 text-sm">
                    {ws.experiments.map(e => (
                      <li key={e.id}><button type="button" aria-current={e.id === experimentId ? "true" : undefined} onClick={() => setQuery({ experimentId: e.id })} className={`rounded px-2 py-1 text-left ${e.id === experimentId ? "bg-teal-900" : "hover:bg-slate-800"}`}>
                        {e.sceneIds.map(id => ws.scenes.find(s => s.id === id)?.content.prompt.slice(0, 16) ?? "?").join(" / ")} · 연결 {e.runIds.length}/18
                      </button></li>
                    ))}
                  </ul>
                )}
              </Panel>
              {experiment && <ExperimentDetail key={experiment.id} ws={ws} experiment={experiment} onChanged={reload} />}
            </div>
          );
        }}
      </Loaded>
    </NeedProject>
  );
}

function CreateExperiment({ ws, onCreated }: { ws: C.Workspace; onCreated: (e: C.Experiment) => void }) {
  const [sceneIds, setSceneIds] = useState(["", "", ""]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const valid = sceneIds.every(Boolean) && new Set(sceneIds).size === 3;
  async function create() {
    setBusy(true); setError(null);
    try { onCreated(await postJson("/api/experiments", { projectId: ws.project.id, sceneIds, repeats: 3 }, C.Experiment)); setSceneIds(["", "", ""]); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Panel title="새 실험 계획">
      {ws.scenes.length < 3 && <p className="text-sm text-slate-400">서로 다른 장면 3개가 필요합니다 (현재 {ws.scenes.length}개).</p>}
      <div className="flex flex-wrap gap-2">
        {sceneIds.map((value, i) => (
          <select key={i} className={inputClass} aria-label={`실험 장면 ${i + 1}`} value={value} onChange={e => setSceneIds(sceneIds.map((v, j) => j === i ? e.target.value : v))}>
            <option value="">— 장면 {i + 1} —</option>
            {ws.scenes.map(s => <option key={s.id} value={s.id} disabled={sceneIds.includes(s.id) && value !== s.id}>{s.content.prompt.slice(0, 40)} (rev {s.revision})</option>)}
          </select>
        ))}
      </div>
      <button type="button" className={buttonClass} disabled={!valid || busy} onClick={create}>실험 계획 저장</button>
      <p className="text-xs text-slate-400">저장 시점의 장면 revision이 고정됩니다. 이후 장면을 수정하면 그 장면에는 새 run을 연결할 수 없습니다.</p>
      <ErrorText error={error} />
    </Panel>
  );
}

function ExperimentDetail({ ws, experiment, onChanged }: { ws: C.Workspace; experiment: C.Experiment; onChanged: () => void }) {
  const [models] = useApi("/api/models", C.ModelInfo.array());
  const [report, reloadReport] = useApi(`/api/experiments/${experiment.id}`, Report);
  const [active, setActive] = useState<Slot | null>(null);
  const [error, setError] = useState<unknown>(null);
  const attached = experiment.runIds.map(id => ws.runs.find(r => r.id === id)).filter((r): r is C.Run => r !== undefined);
  const bySlot = new Map(attached.map(r => [slotOf(r), r]));
  const available = (id: Route) => models.state === "ready" && models.data.some(m => m.id === id && m.available);
  const refresh = () => { onChanged(); reloadReport(); };

  async function attach(runId: string) {
    setError(null);
    try { await postJson(`/api/experiments/${experiment.id}/runs`, { runId }, C.Experiment); refresh(); } catch (e) { setError(e); }
  }

  return (
    <div className="space-y-6">
      <Panel title={`슬롯 진행 (${attached.length}/18)`}>
        <ErrorText error={error} />
        {models.state === "ready" && routes.some(([id]) => !available(id)) && <p className="text-sm text-amber-300">fal 모델이 설정되지 않아 일부 경로는 생성할 수 없습니다(GENERATION_PROVIDER=fal, FAL_KEY 필요). mock 결과는 실험에 연결할 수 없습니다.</p>}
        <div className="space-y-4">
          {experiment.sceneIds.map(sceneId => {
            const scene = ws.scenes.find(s => s.id === sceneId);
            const frozen = experiment.sceneRevisions[sceneId];
            const changed = scene !== undefined && scene.revision !== frozen;
            return (
              <div key={sceneId} className="space-y-2">
                <p className="text-sm font-medium">{scene?.content.prompt.slice(0, 60) ?? sceneId} <span className="text-xs text-slate-400">(고정 rev {frozen})</span></p>
                {changed && <p className="text-sm text-amber-300">장면이 rev {scene.revision}로 수정되어 이 장면 슬롯에는 새 run을 연결할 수 없습니다.</p>}
                <table className="w-full text-sm">
                  <thead><tr><th className="text-left">경로</th>{seeds.map(seed => <th key={seed} className="text-left">seed {seed}</th>)}</tr></thead>
                  <tbody>
                    {routes.map(([adapterId, label]) => (
                      <tr key={adapterId}>
                        <td className="pr-2">{label}</td>
                        {seeds.map(seed => {
                          const slot = { sceneId, adapterId, seed }; const run = bySlot.get(slotKey(slot));
                          const candidate = !run ? ws.runs.find(r => !experiment.runIds.includes(r.id) && slotOf(r) === slotKey(slot) && r.compiled.parameters.num_images === 1 && r.snapshot.edit === null && r.snapshot.sceneRevision === frozen) : undefined;
                          return (
                            <td key={seed} className="py-1 pr-2 align-top">
                              {run ? <span>{runStatusText[run.status]}</span> : (
                                <div className="flex flex-wrap gap-1">
                                  <button type="button" className={secondaryButtonClass} disabled={changed || !available(adapterId) || active !== null} onClick={() => setActive(slot)}>생성</button>
                                  {candidate && <button type="button" className={secondaryButtonClass} disabled={changed} onClick={() => attach(candidate.id)}>기존 run 연결</button>}
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      </Panel>
      {active && <SlotRunner key={slotKey(active)} slot={active} ws={ws} experimentId={experiment.id} onAttached={refresh} onClose={() => setActive(null)} />}
      <Panel title="경로별 실제 요청 차이">
        {attached.length === 0 ? <p className="text-sm text-slate-400">연결된 run이 없습니다.</p> : (
          <table className="w-full text-sm">
            <thead><tr><th className="text-left">장면</th><th className="text-left">경로</th><th className="text-left">seed</th><th className="text-left">전송 참조</th><th className="text-left">경고</th><th className="text-left">실제 비용</th></tr></thead>
            <tbody>
              {attached.map(r => (
                <tr key={r.id}>
                  <td>{r.snapshot.scene.prompt.slice(0, 20)}</td><td>{r.compiled.adapterId}</td><td>{r.compiled.parameters.seed}</td>
                  <td>{r.compiled.references.length}개</td><td>{r.compiled.warnings.join(", ") || "—"}</td>
                  <td>{r.actualCost.kind === "known" ? formatMoney(r.actualCost.micros) : "알 수 없음"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <Panel title="비교 보고">
        <Loaded load={report}>
          {r => (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-5">
              <dt className="text-slate-400">후보 수</dt><dd>{r.total}</dd>
              <dt className="text-slate-400">기준 통과</dt><dd>{r.accepted}</dd>
              <dt className="text-slate-400">통과율</dt><dd>{r.acceptanceRate === null ? "— (결과 없음)" : `${(r.acceptanceRate * 100).toFixed(1)}%`}</dd>
              <dt className="text-slate-400">통과 1건당 실제 비용</dt><dd>{r.costPerAccepted.kind === "known" ? formatMoney(r.costPerAccepted.micros) : `알 수 없음 (${reasonText[r.costPerAccepted.reason] ?? r.costPerAccepted.reason})`}</dd>
              <dt className="text-slate-400">중앙 소요 시간</dt><dd>{r.medianLatencyMs === null ? "— (완료 run 없음)" : `${(r.medianLatencyMs / 1000).toFixed(1)}초`}</dd>
            </dl>
          )}
        </Loaded>
        <button type="button" className={secondaryButtonClass} onClick={reloadReport}>보고 새로고침</button>
        <p className="text-xs text-slate-400">각 후보의 최신 평가로 판정합니다. 예상 비용을 실제 비용으로 바꾸지 않습니다. 표본이 작아 품질 결론은 사람이 판단해야 합니다.</p>
      </Panel>
    </div>
  );
}

/** One slot: fixed scene/route/seed and outputCount 1 → preview → explicit consent → submit → attach. */
function SlotRunner({ slot, ws, experimentId, onAttached, onClose }: { slot: Slot; ws: C.Workspace; experimentId: string; onAttached: () => void; onClose: () => void }) {
  const [preview, setPreview] = useState<C.Preview | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function requestPreview() {
    setBusy(true); setError(null);
    try { setPreview(await postJson("/api/generations/preview", { sceneId: slot.sceneId, adapterId: slot.adapterId, outputCount: 1, seed: slot.seed }, C.Preview)); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function submitted(run: C.Run) {
    setPreview(null); setRunId(run.id);
    try { await postJson(`/api/experiments/${experimentId}/runs`, { runId: run.id }, C.Experiment); onAttached(); } catch (e) { setError(e); }
  }
  return (
    <Panel title={`슬롯 실행 · ${slot.adapterId} · seed ${slot.seed}`}>
      {!runId && <button type="button" className={buttonClass} disabled={busy} onClick={requestPreview}>슬롯 미리보기</button>}
      <ErrorText error={error} />
      {preview && <PreviewDetails preview={preview} />}
      {preview && <SubmitPanel preview={preview} sceneSelected budgetMicros={ws.project.budgetMicros} onSubmitted={submitted} />}
      {runId && <RunMonitor runId={runId} projectId={ws.project.id} />}
      <button type="button" className={secondaryButtonClass} onClick={onClose}>닫기</button>
    </Panel>
  );
}
