"use client";
import { useState } from "react";
import * as C from "@/contracts";
import { postJson } from "../_studio/api";
import { MediaSelect, Thumb, UploadMedia, mediaLabel } from "../_studio/media";
import { ErrorText, Loaded, NeedProject, PageShell, Panel, buttonClass, inputClass, secondaryButtonClass, useSelection, useWorkspace } from "../_studio/ui";

export default function Page() {
  return <PageShell title="자산"><AssetsView /></PageShell>;
}

const slotKinds = ["front", "three_quarter", "side", "back", "face", "expression", "equipment"] as const;
type Slot = { slot: (typeof slotKinds)[number]; mediaId: string };
const slotText: Record<Slot["slot"], string> = { front: "정면", three_quarter: "3/4", side: "측면", back: "후면", face: "얼굴", expression: "표정", equipment: "장비" };

function AssetsView() {
  const projectId = useSelection("projectId");
  const [workspace, reload] = useWorkspace(projectId);
  return (
    <NeedProject projectId={projectId}>
      <Loaded load={workspace}>
        {ws => (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Panel title="이미지 업로드">
              <UploadMedia projectId={ws.project.id} onUploaded={reload} />
              {ws.media.length === 0 ? <p className="text-sm text-slate-400">아직 이미지가 없습니다.</p> : (
                <ul aria-label="프로젝트 이미지" className="flex flex-wrap gap-2">
                  {ws.media.map(m => <li key={m.id} className="w-24 text-xs"><Thumb mediaId={m.id} alt={mediaLabel(m)} /><span className="break-all">{mediaLabel(m)}</span></li>)}
                </ul>
              )}
            </Panel>
            <AssetForm ws={ws} onCreated={reload} />
            <AssetList ws={ws} onChanged={reload} />
          </div>
        )}
      </Loaded>
    </NeedProject>
  );
}

function AssetForm({ ws, onCreated }: { ws: C.Workspace; onCreated: () => void }) {
  const logicalIds = [...new Map(ws.assets.map(a => [a.logicalId, a.name])).entries()];
  const [logicalId, setLogicalId] = useState("new");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"character" | "object">("character");
  const [invariants, setInvariants] = useState("");
  const [variants, setVariants] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const duplicateSlot = new Set(slots.map(s => s.slot)).size !== slots.length;
  const valid = name.trim().length > 0 && !duplicateSlot && slots.every(s => s.mediaId);

  async function create() {
    if (!valid) return;
    setBusy(true); setError(null);
    try {
      // A new logical asset gets a client UUID; reusing one creates the next version on the server.
      await postJson("/api/assets", { projectId: ws.project.id, logicalId: logicalId === "new" ? crypto.randomUUID() : logicalId, name, kind, invariants, variants, slots }, C.Asset);
      setName(""); setInvariants(""); setVariants(""); setSlots([]); setLogicalId("new"); onCreated();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <Panel title="캐릭터·오브젝트 자산 만들기">
      <label className="flex flex-wrap items-center gap-2 text-sm">대상
        <select className={inputClass} value={logicalId} onChange={e => setLogicalId(e.target.value)}>
          <option value="new">새 자산</option>
          {logicalIds.map(([id, n]) => <option key={id} value={id}>{n}의 새 버전</option>)}
        </select>
      </label>
      <div className="flex flex-wrap gap-2 text-sm">
        <input className={inputClass} aria-label="자산 이름" placeholder="이름" maxLength={120} value={name} onChange={e => setName(e.target.value)} />
        <select className={inputClass} aria-label="종류" value={kind} onChange={e => setKind(e.target.value as "character" | "object")}><option value="character">캐릭터</option><option value="object">오브젝트</option></select>
      </div>
      <textarea className={`${inputClass} w-full`} aria-label="불변 특징" rows={3} placeholder="항상 유지할 특징 (얼굴 흉터, 머리색 등)" maxLength={4000} value={invariants} onChange={e => setInvariants(e.target.value)} />
      <textarea className={`${inputClass} w-full`} aria-label="변형 허용" rows={2} placeholder="바뀌어도 되는 요소" maxLength={2000} value={variants} onChange={e => setVariants(e.target.value)} />
      <div className="space-y-2">
        <p className="text-sm">슬롯 이미지 (승인하려면 1개 이상)</p>
        {slots.map((s, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select className={inputClass} aria-label={`슬롯 ${i + 1} 종류`} value={s.slot} onChange={e => setSlots(slots.map((x, j) => j === i ? { ...x, slot: e.target.value as Slot["slot"] } : x))}>
              {slotKinds.map(k => <option key={k} value={k}>{slotText[k]}</option>)}
            </select>
            <MediaSelect media={ws.media} label={`슬롯 ${i + 1} 이미지`} value={s.mediaId} onChange={id => setSlots(slots.map((x, j) => j === i ? { ...x, mediaId: id } : x))} />
            <button type="button" className="text-sm text-red-300 underline" onClick={() => setSlots(slots.filter((_, j) => j !== i))}>제거</button>
          </div>
        ))}
        <button type="button" className={secondaryButtonClass} disabled={slots.length >= 20 || ws.media.length === 0} onClick={() => setSlots([...slots, { slot: slotKinds.find(k => !slots.some(s => s.slot === k)) ?? "front", mediaId: "" }])}>슬롯 추가</button>
        {duplicateSlot && <p className="text-sm text-amber-300">같은 슬롯 종류를 두 번 쓸 수 없습니다.</p>}
        <p className="text-xs text-slate-400">없는 각도의 이미지는 만들어지지 않습니다. 업로드한 이미지만 사용됩니다.</p>
      </div>
      <button type="button" className={buttonClass} disabled={!valid || busy} onClick={create}>자산 저장 (초안)</button>
      <ErrorText error={error} />
    </Panel>
  );
}

function AssetList({ ws, onChanged }: { ws: C.Workspace; onChanged: () => void }) {
  const [error, setError] = useState<unknown>(null);
  const groups = [...Map.groupBy(ws.assets, a => a.logicalId).values()].map(versions => versions.sort((a, b) => b.version - a.version));
  async function approve(id: string) {
    setError(null);
    try { await postJson(`/api/assets/${id}/approve`, {}, C.Asset); onChanged(); } catch (e) { setError(e); }
  }
  return (
    <div className="lg:col-span-2">
      <Panel title="자산 버전">
        <ErrorText error={error} />
        {groups.length === 0 ? <p className="text-sm text-slate-400">아직 자산이 없습니다.</p> : (
          <ul className="space-y-4">
            {groups.map(versions => (
              <li key={versions[0].logicalId} className="space-y-2">
                <p className="font-medium">{versions[0].name} <span className="text-xs text-slate-400">({versions[0].kind})</span></p>
                <ul className="space-y-2">
                  {versions.map(a => (
                    <li key={a.id} className="rounded border border-slate-700 p-2 text-sm">
                      <p>v{a.version} · {a.approvedAt ? <span className="text-teal-300">승인됨 (변경 불가)</span> : <span className="text-amber-300">초안</span>}</p>
                      <p className="text-slate-300">{a.invariants || "불변 특징 없음"}</p>
                      <div className="mt-1 flex flex-wrap gap-2">{a.slots.map(s => <figure key={s.slot} className="text-xs"><Thumb mediaId={s.mediaId} alt={`${a.name} ${slotText[s.slot]}`} size="h-16 w-16" /><figcaption>{slotText[s.slot]}</figcaption></figure>)}</div>
                      {!a.approvedAt && <button type="button" className={`${secondaryButtonClass} mt-2`} disabled={a.slots.length === 0} onClick={() => approve(a.id)}>이 버전 승인</button>}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-slate-400">승인된 버전은 수정되지 않습니다. 바꾸려면 같은 자산의 새 버전을 만드세요. 기존 생성 이력은 당시 버전을 유지합니다.</p>
      </Panel>
    </div>
  );
}
