"use client";
import Link from "next/link";
import { useState } from "react";
import * as C from "@/contracts";
import { SceneCanvas } from "@/components/canvas/scene-canvas";
import { ApiError, postJson } from "../_studio/api";
import { MediaSelect, Thumb } from "../_studio/media";
import { ErrorText, Loaded, NeedProject, PageShell, Panel, buttonClass, inputClass, secondaryButtonClass, useSelection, useSetQuery, useWorkspace, withQuery } from "../_studio/ui";

export default function Page() {
  return <PageShell title="장면"><ScenesView /></PageShell>;
}

type Content = C.SceneContent;
type Role = "character" | "style" | "sketch";
const roleText: Record<Role, string> = { character: "캐릭터", style: "스타일", sketch: "스케치" };
const blank: Content = { prompt: "", camera: "", size: { width: 1024, height: 1024 }, references: [], styleVersionId: null, assetVersionIds: [], boxes: [] };

function ScenesView() {
  const projectId = useSelection("projectId"); const sceneId = useSelection("sceneId"); const setQuery = useSetQuery();
  const [workspace, reload] = useWorkspace(projectId);
  return (
    <NeedProject projectId={projectId}>
      <Loaded load={workspace}>
        {ws => {
          const scene = ws.scenes.find(s => s.id === sceneId) ?? null;
          return (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
              <Panel title="장면 목록">
                <button type="button" className={secondaryButtonClass} onClick={() => setQuery({ sceneId: null })}>새 장면</button>
                {ws.scenes.length === 0 ? <p className="text-sm text-slate-400">아직 장면이 없습니다.</p> : (
                  <ul className="space-y-1 text-sm">
                    {ws.scenes.map(s => (
                      <li key={s.id}><button type="button" aria-current={s.id === sceneId ? "true" : undefined} onClick={() => setQuery({ sceneId: s.id })} className={`w-full rounded px-2 py-1 text-left ${s.id === sceneId ? "bg-teal-900" : "hover:bg-slate-800"}`}>{s.content.prompt.slice(0, 40)} <span className="text-xs text-slate-400">rev {s.revision}</span></button></li>
                    ))}
                  </ul>
                )}
                {sceneId && !scene && <p className="text-sm text-amber-300">선택한 장면을 찾을 수 없습니다.</p>}
              </Panel>
              {/* Keyed so the draft re-initializes when another scene or a newer revision is shown. */}
              <SceneEditor key={scene ? `${scene.id}:${scene.revision}` : "new"} ws={ws} scene={scene} onSaved={saved => { reload(); setQuery({ sceneId: saved.id }); }} />
            </div>
          );
        }}
      </Loaded>
    </NeedProject>
  );
}

function SceneEditor({ ws, scene, onSaved }: { ws: C.Workspace; scene: C.Scene | null; onSaved: (scene: C.Scene) => void }) {
  const [draft, setDraft] = useState<Content>(() => structuredClone(scene?.content ?? blank));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const approvedStyles = ws.styles.filter(s => s.approvedAt);
  const approvedAssets = ws.assets.filter(a => a.approvedAt);
  const set = (patch: Partial<Content>) => setDraft(d => ({ ...d, ...patch }));
  const refs = draft.references;
  const duplicateRef = new Set(refs.map(r => `${r.mediaId}:${r.role}`)).size !== refs.length;
  const sizeOk = [draft.size.width, draft.size.height].every(n => Number.isInteger(n) && n >= 512 && n <= 2048);
  const valid = draft.prompt.trim().length > 0 && sizeOk && !duplicateRef && refs.every(r => r.mediaId);
  const conflict = error instanceof ApiError && error.code === "CONFLICT";

  async function save() {
    setBusy(true); setError(null);
    try {
      const saved = scene
        ? await postJson(`/api/scenes/${scene.id}`, { expectedRevision: scene.revision, content: draft }, C.Scene, "PATCH")
        : await postJson("/api/scenes", { projectId: ws.project.id, content: draft }, C.Scene);
      onSaved(saved);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function duplicate() {
    if (!scene) return;
    setBusy(true); setError(null);
    try { onSaved(await postJson(`/api/scenes/${scene.id}/duplicate`, {}, C.Scene)); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <div className="min-w-0 space-y-6">
      <Panel title={scene ? `장면 편집 (rev ${scene.revision})` : "새 장면"}>
        <label className="block space-y-1 text-sm">장면 설명
          <textarea className={`${inputClass} w-full`} rows={3} maxLength={4000} value={draft.prompt} onChange={e => set({ prompt: e.target.value })} />
        </label>
        <label className="block space-y-1 text-sm">카메라
          <input className={`${inputClass} w-full`} maxLength={1000} value={draft.camera} onChange={e => set({ camera: e.target.value })} placeholder="예: low angle, 35mm" />
        </label>
        <div className="flex flex-wrap items-center gap-2 text-sm">크기
          <input className={`${inputClass} w-24`} type="number" min={512} max={2048} aria-label="너비" value={draft.size.width} onChange={e => set({ size: { ...draft.size, width: Math.trunc(Number(e.target.value)) } })} />×
          <input className={`${inputClass} w-24`} type="number" min={512} max={2048} aria-label="높이" value={draft.size.height} onChange={e => set({ size: { ...draft.size, height: Math.trunc(Number(e.target.value)) } })} />
          {!sizeOk && <span className="text-amber-300">512–2048 정수</span>}
        </div>
        <label className="flex flex-wrap items-center gap-2 text-sm">스타일 (승인 버전만)
          <select className={inputClass} value={draft.styleVersionId ?? ""} onChange={e => set({ styleVersionId: e.target.value || null })}>
            <option value="">없음</option>
            {approvedStyles.map(s => <option key={s.id} value={s.id}>v{s.version} · {s.specification.positive.slice(0, 30)}</option>)}
          </select>
        </label>
        <fieldset className="text-sm"><legend>에셋 (승인 버전만)</legend>
          {approvedAssets.length === 0 ? <p className="text-slate-400">승인된 에셋이 없습니다.</p> : approvedAssets.map(a => (
            <label key={a.id} className="mr-3 inline-flex items-center gap-1">
              <input type="checkbox" checked={draft.assetVersionIds.includes(a.id)} onChange={e => set({ assetVersionIds: e.target.checked ? [...draft.assetVersionIds, a.id] : draft.assetVersionIds.filter(id => id !== a.id) })} />{a.name} v{a.version}
            </label>
          ))}
        </fieldset>
      </Panel>

      <Panel title="참조 이미지">
        <p className="text-xs text-slate-400">실제로 보낼 이미지만 직접 고릅니다. 선택한 스타일·에셋의 이미지가 자동으로 추가되지 않습니다. 전송 순서는 캐릭터 → 스타일 → 스케치이며, 모델별 개수 한도를 넘으면 미리보기에서 차단됩니다.</p>
        {refs.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            {r.mediaId && <Thumb mediaId={r.mediaId} alt={`참조 ${i + 1}`} size="h-12 w-12" />}
            <MediaSelect media={ws.media} label={`참조 ${i + 1} 이미지`} value={r.mediaId} onChange={id => set({ references: refs.map((x, j) => j === i ? { ...x, mediaId: id } : x) })} />
            <select className={inputClass} aria-label={`참조 ${i + 1} 역할`} value={r.role} onChange={e => set({ references: refs.map((x, j) => j === i ? { ...x, role: e.target.value as Role } : x) })}>
              {(Object.keys(roleText) as Role[]).map(role => <option key={role} value={role}>{roleText[role]}</option>)}
            </select>
            <input className={inputClass} aria-label={`참조 ${i + 1} 메모`} placeholder="메모" maxLength={500} value={r.note} onChange={e => set({ references: refs.map((x, j) => j === i ? { ...x, note: e.target.value } : x) })} />
            <button type="button" className="text-sm text-red-300 underline" onClick={() => set({ references: refs.filter((_, j) => j !== i) })}>제거</button>
          </div>
        ))}
        <button type="button" className={secondaryButtonClass} disabled={refs.length >= 20 || ws.media.length === 0} onClick={() => set({ references: [...refs, { mediaId: "", role: "character", note: "" }] })}>참조 추가</button>
        {duplicateRef && <p className="text-sm text-amber-300">같은 이미지를 같은 역할로 두 번 넣을 수 없습니다.</p>}
      </Panel>

      <Panel title="스케치와 레이아웃">
        <SceneCanvas value={draft} onChange={setDraft} />
      </Panel>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass} disabled={!valid || busy} onClick={save}>{scene ? "장면 저장" : "장면 만들기"}</button>
        {scene && <button type="button" className={secondaryButtonClass} disabled={busy} onClick={duplicate}>복제 (새 장면)</button>}
        {scene && <Link className="text-sm underline" href={withQuery("/generate", { projectId: ws.project.id, sceneId: scene.id })}>이 장면으로 생성</Link>}
      </div>
      {conflict && <p className="text-sm text-amber-300">다른 저장과 충돌했습니다. 목록에서 장면을 다시 선택해 최신 내용을 불러온 뒤 수정하세요.</p>}
      <ErrorText error={error} />
    </div>
  );
}
