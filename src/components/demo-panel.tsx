"use client";
import { useState } from "react";
export function DemoPanel() {
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try { const res = await fetch("/api/demo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "Wind Duel mock contract" }) });
      const body = await res.json(); if (!res.ok) throw new Error(body.error?.message || "실패");
      setMessage(`MOCK · ${body.data.trace.join(" → ")} · 저장 안 됨 · 1×1 fixture`);
    } catch { setMessage("데모 실행 실패"); } finally { setBusy(false); }
  }
  return <section aria-label="계약 데모" className="mt-8 rounded-2xl border border-teal-800 p-6">
    <h2 className="text-xl font-semibold">Hollow architecture · Mock 데모</h2>
    <p className="my-3 text-slate-300">API와 모델 adapter 연결만 확인합니다. 유료 호출과 영구 저장은 없습니다.</p>
    <button onClick={run} disabled={busy} className="rounded bg-teal-700 px-4 py-2 disabled:opacity-50">{busy ? "실행 중" : "Mock 계약 실행"}</button>
    <p role="status" className="mt-3">{message}</p>
  </section>;
}
