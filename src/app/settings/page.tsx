"use client";
import { useState } from "react";
import * as C from "@/contracts";
import { api, postJson, useApi } from "../_studio/api";
import { ErrorText, Loaded, PageShell, Panel, buttonClass, inputClass, secondaryButtonClass } from "../_studio/ui";

export default function Page() {
  return <PageShell title="설정"><SettingsView /></PageShell>;
}

const modeText: Record<C.ProviderMode, string> = { mock: "mock (테스트 이미지, 무료)", fal: "fal (실제 생성, 유료)" };
const sourceText: Record<C.FalSettings["source"], string> = { env: "환경변수 FAL_KEY", file: "이 컴퓨터의 설정 파일", none: "없음" };

/** T16: the key is typed, sent once in the PUT body, then cleared; it is never read back or kept in browser storage. */
function SettingsView() {
  const [settings, reload] = useApi("/api/settings/fal", C.FalSettings);
  // Kept outside the form: the form remounts with fresh server state after each change.
  const [done, setDone] = useState<string | null>(null);
  return (
    <Loaded load={settings}>
      {current => <SettingsForm key={JSON.stringify(current)} current={current} onSaved={reload} done={done} setDone={setDone} />}
    </Loaded>
  );
}

function SettingsForm({ current, onSaved, done, setDone }: { current: C.FalSettings; onSaved: () => void; done: string | null; setDone: (message: string | null) => void }) {
  const [mode, setMode] = useState<C.ProviderMode>(current.savedMode);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const needsKey = mode === "fal" && !current.configured && key.trim() === "";

  async function run(work: () => Promise<C.FalSettings>, message: string) {
    setBusy(true); setError(null); setDone(null);
    try { const next = await work(); setKey(""); setDone(next.restartRequired ? `${message} 서버와 worker를 모두 재시작해야 적용됩니다.` : message); onSaved(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  const save = () => run(() => postJson("/api/settings/fal", key.trim() ? { mode, key: key.trim() } : { mode }, C.FalSettings, "PUT"), "저장했습니다(키가 유효한지는 확인하지 않았습니다).");
  const remove = () => run(() => api("/api/settings/fal", { method: "DELETE" }, C.FalSettings), "저장된 키를 삭제하고 mock 모드로 저장했습니다.");

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Panel title="현재 상태">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-400">실행 중인 서버 모드</dt><dd>{modeText[current.serverMode]}</dd>
          <dt className="text-slate-400">저장된 모드</dt><dd>{modeText[current.savedMode]}</dd>
          <dt className="text-slate-400">fal API 키</dt><dd>{current.configured ? `설정됨 · ${sourceText[current.source]}` : "설정되지 않음"}</dd>
        </dl>
        {current.restartRequired && <p role="status" className="rounded border border-amber-700 bg-amber-950/40 p-2 text-sm text-amber-200">저장한 설정은 아직 적용되지 않았습니다. 서버와 worker를 모두 재시작하세요. 그 전까지 새 생성은 거부됩니다.</p>}
        {current.source === "env" && <p className="text-sm text-amber-300">환경변수 FAL_KEY가 적용 중입니다. 설정 파일의 키보다 우선하며, 이 화면에서 수정하거나 삭제할 수 없습니다.</p>}
        {current.modeSource === "env" && <p className="text-sm text-amber-300">환경변수 GENERATION_PROVIDER가 모드를 정합니다. 이 화면에서 저장한 모드보다 우선합니다.</p>}
      </Panel>
      <Panel title="fal 연결">
        <fieldset className="space-y-1 text-sm"><legend>생성 모드</legend>
          {(["mock", "fal"] as const).map(m => (
            <label key={m} className="mr-4 inline-flex items-center gap-1"><input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} />{modeText[m]}</label>
          ))}
        </fieldset>
        <label className="block space-y-1 text-sm">fal API 키
          <input type="password" autoComplete="off" spellCheck={false} className={`${inputClass} w-full`} maxLength={500} value={key} onChange={e => setKey(e.target.value)} placeholder={current.source === "file" ? "비워 두면 저장된 키 유지" : "키 입력"} />
        </label>
        <p className="text-xs text-slate-400">키는 이 컴퓨터의 데이터 폴더(APP_DATA_DIR/settings/settings.json)에 <strong>평문</strong>으로 저장됩니다(소유자만 읽기). 저장된 키는 화면으로 다시 보내지 않습니다. 저장은 fal에 연결해 보지 않으므로 키가 유효한지는 실제 생성 때 확인됩니다. 진행 중인 생성(확인 필요·다운로드 실패 포함)이 있으면 변경할 수 없습니다.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} disabled={busy || needsKey} onClick={save}>저장</button>
          <button type="button" className={secondaryButtonClass} disabled={busy} onClick={remove}>저장된 키 삭제</button>
        </div>
        {needsKey && <p className="text-sm text-amber-300">fal 모드에는 API 키가 필요합니다.</p>}
        {done && <p role="status" className="text-sm text-teal-300">{done}</p>}
        <ErrorText error={error} />
      </Panel>
    </div>
  );
}
