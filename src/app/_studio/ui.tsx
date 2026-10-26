"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, type ReactNode } from "react";
import * as C from "@/contracts";
import { describeError, useApi, type Load } from "./api";

const pages = [["/projects", "프로젝트"], ["/assets", "자산"], ["/styles", "스타일"], ["/scenes", "장면"], ["/generate", "생성"], ["/history", "이력"]] as const;

/** Reads a UUID query value (selection survives reload); anything malformed counts as "not selected". */
export function useSelection(name: string): string | null {
  const value = useSearchParams().get(name);
  return value && C.Id.safeParse(value).success ? value : null;
}

/** Updates query keys in place (replace, no scroll) so selection is shareable and restored on reload. */
export function useSetQuery() {
  const router = useRouter(); const pathname = usePathname(); const params = useSearchParams();
  return useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) if (value === null) next.delete(key); else next.set(key, value);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [router, pathname, params]);
}

export const withQuery = (path: string, query: Record<string, string | null | undefined>) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) params.set(k, v);
  const text = params.toString();
  return text ? `${path}?${text}` : path;
};

function Nav() {
  const projectId = useSelection("projectId"); const pathname = usePathname();
  return (
    <nav aria-label="작업 단계" className="flex flex-wrap gap-2 text-sm">
      {pages.map(([href, label]) => (
        <Link key={href} href={withQuery(href, { projectId })} aria-current={pathname === href ? "page" : undefined}
          className={`rounded px-3 py-1 ${pathname === href ? "bg-teal-700 text-white" : "border border-slate-700 text-slate-300 hover:border-teal-600"}`}>{label}</Link>
      ))}
    </nav>
  );
}

/** Page frame. Children render inside Suspense because they read the URL query (required for prerendered pages). */
export function PageShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <header className="space-y-3">
        <Link href="/" className="text-xs tracking-widest text-teal-300">AI ART DIRECTION STUDIO</Link>
        <h1 className="text-3xl font-semibold">{title}</h1>
        <Suspense fallback={null}><Nav /></Suspense>
      </header>
      <Suspense fallback={<p role="status">불러오는 중…</p>}>{children}</Suspense>
    </main>
  );
}

export function Panel({ title, children, label }: { title: string; children: ReactNode; label?: string }) {
  return (
    <section aria-label={label ?? title} className="min-w-0 space-y-3 rounded-xl border border-slate-700 p-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  return error ? <p role="alert" className="rounded border border-red-800 bg-red-950/40 p-2 text-sm text-red-200">{describeError(error)}</p> : null;
}

/** Distinguishes idle / loading / error (incl. 501) / empty / ready. */
export function Loaded<T>({ load, idle, empty, isEmpty, children }: { load: Load<T>; idle?: ReactNode; empty?: ReactNode; isEmpty?: (data: T) => boolean; children: (data: T) => ReactNode }) {
  if (load.state === "idle") return <p className="text-sm text-slate-400">{idle ?? "선택된 항목이 없습니다."}</p>;
  if (load.state === "loading") return <p role="status" className="text-sm text-slate-400">불러오는 중…</p>;
  if (load.state === "error") return <ErrorText error={load.error} />;
  if (isEmpty?.(load.data)) return <p className="text-sm text-slate-400">{empty ?? "아직 항목이 없습니다."}</p>;
  return <>{children(load.data)}</>;
}

/** Project workspace for the selected project (the single source of page data). */
export function useWorkspace(projectId: string | null) {
  return useApi(projectId ? `/api/projects/${projectId}/workspace` : null, C.Workspace);
}

export function NeedProject({ projectId, children }: { projectId: string | null; children: ReactNode }) {
  if (projectId) return <>{children}</>;
  return <p className="text-sm text-slate-400">먼저 <Link className="underline" href="/projects">프로젝트</Link>를 선택하세요.</p>;
}

export const inputClass = "rounded border border-slate-600 bg-slate-900 px-2 py-1 text-sm text-slate-100 disabled:opacity-50";
export const buttonClass = "rounded bg-teal-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-40";
export const secondaryButtonClass = "rounded border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:border-teal-600 disabled:cursor-not-allowed disabled:opacity-40";
export const formatDate = (iso: string) => new Date(iso).toLocaleString("ko-KR", { hour12: false });
