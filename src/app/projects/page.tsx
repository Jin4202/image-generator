"use client";
import Link from "next/link";
import { useState } from "react";
import * as C from "@/contracts";
import { formatMoney, postJson, useApi } from "../_studio/api";
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

function ProjectsView() {
  const selected = useSelection("projectId"); const setQuery = useSetQuery();
  const [projects, reload] = useApi("/api/projects", C.Project.array());
  const [title, setTitle] = useState("");
  const [budget, setBudget] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const budgetMicros = parseBudget(budget);
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
                <li key={p.id} className={`rounded border p-3 ${p.id === selected ? "border-teal-500 bg-teal-950/30" : "border-slate-700"}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium">{p.title}</p>
                      <p className="text-xs text-slate-400">{formatDate(p.createdAt)} · 예산 {p.budgetMicros === null ? "미설정" : formatMoney(p.budgetMicros)}</p>
                    </div>
                    {p.id === selected
                      ? <span aria-current="true" className="text-sm text-teal-300">선택됨</span>
                      : <button type="button" className={secondaryButtonClass} onClick={() => setQuery({ projectId: p.id })}>선택</button>}
                  </div>
                  {p.id === selected && (
                    <p className="mt-2 flex flex-wrap gap-3 text-sm">
                      <Link className="underline" href={withQuery("/assets", { projectId: p.id })}>자산 준비</Link>
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
