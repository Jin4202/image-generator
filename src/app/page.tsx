"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { DemoPanel } from "../components/demo-panel";

const steps = [
  ["/projects", "01 프로젝트", "작업 단위를 만들고 선택합니다. 선택은 URL에 남아 새로고침 후에도 유지됩니다."],
  ["/assets", "02 에셋·스타일", "캐릭터 이미지를 올리고 에셋과 Style DNA 버전을 승인합니다."],
  ["/scenes", "03 장면", "승인 버전, 참조 이미지, 스케치와 레이아웃 박스로 장면을 저장합니다."],
  ["/generate", "04 생성", "정확한 요청과 비용을 확인하고 동의한 뒤에만 1회 제출합니다."],
  ["/history", "05 평가·수정·내보내기", "후보를 평가하고 원본을 유지한 채 수정본과 PNG·manifest를 만듭니다."],
  ["/experiments", "06 비교 실험", "참조 경로와 텍스트 기준선을 3장면×3회로 비교합니다."],
] as const;

type Health = { state: "loading" } | { state: "ready"; provider: string; liveGeneration: boolean } | { state: "not-ready"; message: string };

/** Product entry. Readiness comes from /api/health (DB migrated, provider mode); the mock demo stays separately labeled. */
export default function Home() {
  const [health, setHealth] = useState<Health>({ state: "loading" });
  useEffect(() => {
    let live = true;
    fetch("/api/health", { cache: "no-store" })
      .then(async response => {
        const body = await response.json().catch(() => null) as { data?: { provider: string; liveGeneration: boolean }; error?: { message?: string } } | null;
        if (!live) return;
        setHealth(response.ok && body?.data ? { state: "ready", provider: body.data.provider, liveGeneration: body.data.liveGeneration } : { state: "not-ready", message: body?.error?.message ?? `상태 확인 실패 (${response.status})` });
      })
      .catch(() => { if (live) setHealth({ state: "not-ready", message: "서버에 연결할 수 없습니다." }); });
    return () => { live = false; };
  }, []);

  return <main className="mx-auto max-w-5xl px-6 py-20">
    <p className="text-sm font-semibold tracking-widest text-teal-300">LOCAL ART WORKSPACE</p>
    <h1 className="mt-6 text-4xl font-semibold tracking-tight sm:text-6xl">AI Art Direction Studio</h1>
    <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-300">원하는 캐릭터, 스타일, 구도를 반복해서 구현하고 모든 선택과 수정 이력을 보존하는 작업실.</p>
    <section aria-label="작업 준비 상태" className="mt-10 rounded-2xl border border-teal-900 bg-teal-950/40 p-6">
      <h2 className="font-semibold text-teal-200">작업 준비 상태</h2>
      <p role="status" className="mt-2 text-slate-300">
        {health.state === "loading" && "확인 중…"}
        {health.state === "ready" && `준비됨 · 로컬 저장소 연결됨 · provider ${health.provider} · 실제 유료 생성 ${health.liveGeneration ? "사용 가능 (매 요청 비용 동의 필요)" : "꺼짐 (mock 생성만)"}`}
        {health.state === "not-ready" && `준비되지 않음: ${health.message}`}
      </p>
      {health.state === "ready" && <Link href="/projects" className="mt-4 inline-block rounded bg-teal-700 px-4 py-2 font-medium text-white hover:bg-teal-600">프로젝트 시작</Link>}
    </section>
    <section aria-label="작업 흐름" className="mt-8 grid grid-cols-1 gap-5 md:grid-cols-3">
      {steps.map(([href, title, detail]) => <Link key={href} href={href} className="rounded-2xl border border-slate-700 p-6 hover:border-teal-600">
        <h2 className="text-xl font-semibold">{title}</h2><p className="mt-3 leading-7 text-slate-400">{detail}</p>
      </Link>)}
    </section>
    <DemoPanel />
    <p className="mt-10 text-sm text-slate-400">mock 생성 결과는 1×1 테스트 이미지이며 모델 품질 평가가 아닙니다. 실제 생성은 GENERATION_PROVIDER=fal과 FAL_KEY 설정 후 요청마다 비용을 확인하고 동의해야 합니다.</p>
  </main>;
}
