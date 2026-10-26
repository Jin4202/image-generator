"use client";
import { useState } from "react";
import * as C from "@/contracts";
import { postJson } from "../_studio/api";
import { MediaChecklist, Thumb } from "../_studio/media";
import { ErrorText, Loaded, NeedProject, PageShell, Panel, buttonClass, inputClass, secondaryButtonClass, useSelection, useWorkspace } from "../_studio/ui";

export default function Page() {
  return <PageShell title="스타일"><StylesView /></PageShell>;
}

type Spec = C.Style["specification"];
const fields: [keyof Spec, string, number][] = [
  ["positive", "핵심 스타일 지시 (승인에 필수)", 3000], ["linework", "선", 1000], ["shading", "음영", 1000], ["palette", "색", 1000],
  ["anatomy", "인체 비례", 1000], ["rendering", "렌더링", 1000], ["lighting", "조명", 1000], ["effectsLanguage", "효과 표현", 1000], ["negative", "피할 것 (본문 텍스트로 전달)", 1000],
];
const emptySpec: Spec = { linework: "", shading: "", palette: "", anatomy: "", rendering: "", lighting: "", effectsLanguage: "", positive: "", negative: "" };

function StylesView() {
  const projectId = useSelection("projectId");
  const [workspace, reload] = useWorkspace(projectId);
  return (
    <NeedProject projectId={projectId}>
      <Loaded load={workspace}>{ws => <div className="grid grid-cols-1 gap-6 lg:grid-cols-2"><StyleForm ws={ws} onCreated={reload} /><StyleList ws={ws} onChanged={reload} /></div>}</Loaded>
    </NeedProject>
  );
}

function StyleForm({ ws, onCreated }: { ws: C.Workspace; onCreated: () => void }) {
  const lineages = [...new Map(ws.styles.map(s => [s.logicalId, s.specification.positive])).entries()];
  const [logicalId, setLogicalId] = useState("new");
  const [spec, setSpec] = useState<Spec>(emptySpec);
  const [referenceIds, setReferenceIds] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true); setError(null);
    try {
      await postJson("/api/styles", { projectId: ws.project.id, logicalId: logicalId === "new" ? crypto.randomUUID() : logicalId, specification: spec, referenceIds }, C.Style);
      setSpec(emptySpec); setReferenceIds([]); setLogicalId("new"); onCreated();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <Panel title="Style DNA 만들기">
      <label className="flex flex-wrap items-center gap-2 text-sm">대상
        <select className={inputClass} value={logicalId} onChange={e => setLogicalId(e.target.value)}>
          <option value="new">새 스타일</option>
          {lineages.map(([id, positive]) => <option key={id} value={id}>{(positive || "제목 없음").slice(0, 30)}의 새 버전</option>)}
        </select>
      </label>
      {fields.map(([key, label, max]) => (
        <label key={key} className="block space-y-1 text-sm">{label}
          <textarea className={`${inputClass} w-full`} rows={key === "positive" ? 3 : 1} maxLength={max} value={spec[key]} onChange={e => setSpec({ ...spec, [key]: e.target.value })} />
        </label>
      ))}
      <p className="text-sm">참조 이미지 (0개 가능, 최대 20개)</p>
      <MediaChecklist media={ws.media} selected={referenceIds} onChange={ids => setReferenceIds(ids.slice(0, 20))} label="스타일 참조 이미지" />
      <p className="text-xs text-slate-400">자동 스타일 분석은 하지 않습니다. 입력한 텍스트와 선택한 이미지만 사용됩니다.</p>
      <button type="button" className={buttonClass} disabled={busy} onClick={create}>스타일 저장 (초안)</button>
      <ErrorText error={error} />
    </Panel>
  );
}

function StyleList({ ws, onChanged }: { ws: C.Workspace; onChanged: () => void }) {
  const [error, setError] = useState<unknown>(null);
  const groups = [...Map.groupBy(ws.styles, s => s.logicalId).values()].map(v => v.sort((a, b) => b.version - a.version));
  async function approve(id: string) {
    setError(null);
    try { await postJson(`/api/styles/${id}/approve`, {}, C.Style); onChanged(); } catch (e) { setError(e); }
  }
  return (
    <Panel title="스타일 버전">
      <ErrorText error={error} />
      {groups.length === 0 ? <p className="text-sm text-slate-400">아직 스타일이 없습니다.</p> : (
        <ul className="space-y-3">
          {groups.flat().map(s => (
            <li key={s.id} className="rounded border border-slate-700 p-2 text-sm">
              <p>v{s.version} · {s.approvedAt ? <span className="text-teal-300">승인됨 (변경 불가)</span> : <span className="text-amber-300">초안</span>}</p>
              <p className="text-slate-300">{s.specification.positive || <i className="text-slate-500">핵심 지시 없음 — 승인 불가</i>}</p>
              {s.specification.negative && <p className="text-xs text-slate-400">피할 것: {s.specification.negative}</p>}
              <div className="mt-1 flex flex-wrap gap-1">{s.referenceIds.map(id => <Thumb key={id} mediaId={id} alt="스타일 참조" size="h-12 w-12" />)}</div>
              {!s.approvedAt && <button type="button" className={`${secondaryButtonClass} mt-2`} disabled={!s.specification.positive.trim()} onClick={() => approve(s.id)}>이 버전 승인</button>}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-slate-400">승인된 버전만 장면에서 고를 수 있습니다. 바꾸려면 새 버전을 만드세요.</p>
    </Panel>
  );
}
