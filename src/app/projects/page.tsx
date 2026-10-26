"use client";
import Link from "next/link";
import { useState } from "react";
import * as C from "@/contracts";
import { ApiError, formatMoney, postJson, useApi } from "../_studio/api";
import { ErrorText, Loaded, PageShell, Panel, buttonClass, formatDate, inputClass, secondaryButtonClass, useSelection, useSetQuery, withQuery } from "../_studio/ui";

export default function Page() {
  return <PageShell title="프로젝트"><ProjectsView /></PageShell>;
}

/** Dollar text → integer micro-USD; empty means "no budget set" (not unlimited consent). */
function parseBudget(text: string): number | null | "invalid" {
  if (text.trim() === "") return null;
  const dollars = Number(text);
  return Number.isFinite(dollars) && dollars >= 0 ? Math.round(dollars * 1_000_000) : "invalid";
}

/** Every query key that points into a project; cleared when that project is deleted. */
const projectScopedKeys = { projectId: null, sceneId: null, candidateId: null, runId: null, experimentId: null };
const budgetText = (micros: number | null) => micros === null ? "" : String(micros / 1_000_000);

function ProjectsView() {
  const selected = useSelection("projectId"); const setQuery = useSetQuery();
  const [projects, reload] = useApi("/api/projects", C.Project.array());
  const [title, setTitle] = useState("");
  const [budget, setBudget] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const budgetMicros = parseBudget(budget);
  // T17: at most one project is being edited or confirmed for deletion at a time.
  const [mode, setMode] = useState<{ kind: "edit" | "delete"; id: string } | null>(null);
  const canCreate = title.trim().length > 0 && title.trim().length <= 120 && budgetMicros !== "invalid" && !busy;

  async function create() {
    if (!canCreate) return;
    setBusy(true); setError(null);
    try {
      const project = await postJson("/api/projects", { title, budgetMicros }, C.Project);
      setTitle(""); setBudget(""); reload(); setQuery({ projectId: project.id });
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <Panel title="새 프로젝트">
        <label className="block space-y-1 text-sm">제목
          <input className={`${inputClass} w-full`} value={title} maxLength={120} onChange={e => setTitle(e.target.value)} placeholder="예: Wind Duel" />
        </label>
        <label className="block space-y-1 text-sm">예산 (USD, 선택)
          <input className={`${inputClass} w-full`} inputMode="decimal" value={budget} onChange={e => setBudget(e.target.value)} placeholder="비우면 한도 없음" />
        </label>
        <p className="text-xs text-slate-400">예산을 비우면 한도가 없다는 뜻이며, 가격을 모르는 요청은 매번 별도 동의가 필요합니다. 예산을 정하면 가격 미확인 요청은 제출할 수 없습니다.</p>
        {budgetMicros === "invalid" && <p className="text-sm text-amber-300">예산은 0 이상의 숫자여야 합니다.</p>}
        <button type="button" className={buttonClass} disabled={!canCreate} onClick={create}>프로젝트 만들기</button>
        <ErrorText error={error} />
      </Panel>
      <Panel title="프로젝트 목록">
        <Loaded load={projects} isEmpty={list => list.length === 0} empty="아직 프로젝트가 없습니다.">
          {list => (
            <ul className="space-y-2">
              {list.map(p => (
                <li key={p.id} aria-label={`프로젝트 ${p.title}`} className={`rounded border p-3 ${p.id === selected ? "border-teal-500 bg-teal-950/30" : "border-slate-700"}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium">{p.title}</p>
                      <p className="text-xs text-slate-400">{formatDate(p.createdAt)} · 예산 {p.budgetMicros === null ? "미설정" : formatMoney(p.budgetMicros)}</p>
                    </div>
                    {p.id === selected
                      ? <span aria-current="true" className="text-sm text-teal-300">선택됨</span>
                      : <button type="button" className={secondaryButtonClass} onClick={() => setQuery({ projectId: p.id })}>선택</button>}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" className={secondaryButtonClass} disabled={mode !== null} onClick={() => setMode({ kind: "edit", id: p.id })}>편집</button>
                    <button type="button" className={secondaryButtonClass} disabled={mode !== null} onClick={() => setMode({ kind: "delete", id: p.id })}>삭제</button>
                  </div>
                  {mode?.id === p.id && mode.kind === "edit" && <EditProject project={p} onDone={changed => { setMode(null); if (changed) reload(); }} />}
                  {mode?.id === p.id && mode.kind === "delete" && <DeleteProject project={p} onDone={deleted => {
                    setMode(null);
                    if (deleted) { if (p.id === selected) setQuery(projectScopedKeys); reload(); }
                  }} />}
                  {p.id === selected && (
                    <p className="mt-2 flex flex-wrap gap-3 text-sm">
                      <Link className="underline" href={withQuery("/assets", { projectId: p.id })}>에셋 준비</Link>
                      <Link className="underline" href={withQuery("/styles", { projectId: p.id })}>스타일</Link>
                      <Link className="underline" href={withQuery("/scenes", { projectId: p.id })}>장면</Link>
                      <Link className="underline" href={withQuery("/history", { projectId: p.id })}>이력</Link>
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Loaded>
      </Panel>
    </div>
  );
}

function EditProject({ project, onDone }: { project: C.Project; onDone: (changed: boolean) => void }) {
  const [title, setTitle] = useState(project.title);
  const [budget, setBudget] = useState(budgetText(project.budgetMicros));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const budgetMicros = parseBudget(budget);
  const lowered = budgetMicros !== "invalid" && budgetMicros !== null && (project.budgetMicros === null || budgetMicros < project.budgetMicros);
  const canSave = title.trim().length > 0 && title.trim().length <= 120 && budgetMicros !== "invalid" && !busy;
  async function save() {
    if (!canSave) return;
    setBusy(true); setError(null);
    try { await postJson(`/api/projects/${project.id}`, { expectedRevision: project.revision, title, budgetMicros }, C.Project, "PATCH"); onDone(true); }
    catch (e) { setError(e); setBusy(false); }
  }
  return (
    <div role="group" aria-label="프로젝트 편집" className="mt-3 space-y-2 rounded border border-slate-700 p-3">
      <label className="block space-y-1 text-sm">제목
        <input className={`${inputClass} w-full`} value={title} maxLength={120} onChange={e => setTitle(e.target.value)} />
      </label>
      <label className="block space-y-1 text-sm">예산 (USD, 선택)
        <input className={`${inputClass} w-full`} inputMode="decimal" value={budget} onChange={e => setBudget(e.target.value)} placeholder="비우면 한도 없음" />
      </label>
      {budgetMicros === "invalid" && <p className="text-sm text-amber-300">예산은 0 이상의 숫자여야 합니다.</p>}
      {lowered && <p className="text-xs text-amber-300">예산을 낮춰도 이미 발생했거나 접수된 비용은 취소·환급되지 않습니다. 이후 제출부터 새 예산으로 누적 비용을 확인합니다.</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={!canSave} onClick={save}>변경 저장</button>
        <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => onDone(false)}>취소</button>
      </div>
      <ErrorText error={error} />
      {error instanceof ApiError && error.code === "CONFLICT" && <p className="text-sm text-amber-300">다른 곳에서 먼저 바뀌었습니다. 취소 후 목록을 다시 불러온 뒤 수정하세요.</p>}
    </div>
  );
}

/** Cancel sends nothing; confirm sends one DELETE with the revision the user saw. */
function DeleteProject({ project, onDone }: { project: C.Project; onDone: (deleted: boolean) => void }) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true); setError(null);
    try { await postJson(`/api/projects/${project.id}`, { expectedRevision: project.revision }, C.ProjectDeleted, "DELETE"); onDone(true); }
    catch (e) { setError(e); setBusy(false); }
  }
  return (
    <div role="alertdialog" aria-label="프로젝트 삭제 확인" className="mt-3 space-y-2 rounded border border-red-800 bg-red-950/30 p-3 text-sm">
      <p>‘{project.title}’ 프로젝트를 삭제할까요? 장면, 생성 이력, 평가, 효과, 내보내기 기록이 모두 삭제되며 되돌릴 수 없습니다.</p>
      <p className="text-xs text-slate-300">이미 발생한 생성 비용은 취소·환급되지 않습니다. 이미지 파일은 다른 프로젝트와 공유될 수 있어 디스크에서 지우지 않으므로 공간이 바로 줄거나 완전히 지워지지는 않습니다. 진행 중인 생성(확인 필요·다운로드 실패 포함)이 있으면 삭제할 수 없습니다.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-40" disabled={busy} onClick={confirm}>삭제 확인</button>
        <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => onDone(false)}>취소</button>
      </div>
      <ErrorText error={error} />
    </div>
  );
}
