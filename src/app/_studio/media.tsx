"use client";
import { useState } from "react";
import * as C from "@/contracts";
import { api, mediaUrl } from "./api";
import { ErrorText, buttonClass, inputClass } from "./ui";

const accepted = "image/png,image/jpeg,image/webp";

/** Multipart upload through POST /api/media/upload; the server decodes and validates the file. */
export function UploadMedia({ projectId, onUploaded }: { projectId: string; onUploaded: (media: C.Media) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [licenseNotes, setLicenseNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const tooLarge = file !== null && file.size > C.Limits.uploadBytes;

  async function upload() {
    if (!file || tooLarge) return;
    setBusy(true); setError(null);
    try {
      const form = new FormData();
      form.append("file", file); form.append("projectId", projectId); form.append("licenseNotes", licenseNotes);
      const media = await api("/api/media/upload", { method: "POST", body: form }, C.Media);
      setFile(null); setLicenseNotes(""); onUploaded(media);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-2 text-sm">
      <input type="file" accept={accepted} aria-label="업로드할 이미지" onChange={e => setFile(e.target.files?.[0] ?? null)} className="block text-sm" />
      <input className={`${inputClass} w-full`} aria-label="라이선스/출처 메모" placeholder="라이선스·출처 메모 (선택)" maxLength={2000} value={licenseNotes} onChange={e => setLicenseNotes(e.target.value)} />
      <p className="text-xs text-slate-400">PNG·JPEG·WebP, 10MiB·16MP 이하, 애니메이션 불가. 원본 파일은 변경 없이 저장됩니다.</p>
      {tooLarge && <p className="text-sm text-amber-300">파일이 10MiB를 넘습니다.</p>}
      <button type="button" className={buttonClass} disabled={!file || tooLarge || busy} onClick={upload}>{busy ? "업로드 중…" : "업로드"}</button>
      <ErrorText error={error} />
    </div>
  );
}

export function Thumb({ mediaId, alt, size = "h-24 w-24" }: { mediaId: string; alt: string; size?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- immutable local media route
  return <img src={mediaUrl(mediaId)} alt={alt} className={`${size} rounded bg-slate-900 object-contain`} loading="lazy" />;
}

export const mediaLabel = (m: C.Media) => `${m.source === "upload" ? "업로드" : m.source === "generated" ? "생성" : "내보내기"} · ${m.width}×${m.height} · ${m.id.slice(0, 8)}`;

/** Dropdown over project images; generated/exported images are allowed as references too. */
export function MediaSelect({ media, value, onChange, label, allowEmpty = true }: { media: C.Media[]; value: string; onChange: (id: string) => void; label: string; allowEmpty?: boolean }) {
  return (
    <select className={inputClass} aria-label={label} value={value} onChange={e => onChange(e.target.value)}>
      {allowEmpty && <option value="">— 이미지 선택 —</option>}
      {media.map(m => <option key={m.id} value={m.id}>{mediaLabel(m)}</option>)}
    </select>
  );
}

/** Multi-select gallery with checkboxes (order of clicking is the stored order). */
export function MediaChecklist({ media, selected, onChange, label }: { media: C.Media[]; selected: string[]; onChange: (ids: string[]) => void; label: string }) {
  if (media.length === 0) return <p className="text-sm text-slate-400">업로드된 이미지가 없습니다.</p>;
  return (
    <ul aria-label={label} className="flex flex-wrap gap-2">
      {media.map(m => {
        const on = selected.includes(m.id);
        return (
          <li key={m.id}>
            <label className={`block cursor-pointer rounded border p-1 ${on ? "border-teal-500" : "border-slate-700"}`}>
              <Thumb mediaId={m.id} alt={mediaLabel(m)} size="h-20 w-20" />
              <span className="flex items-center gap-1 text-xs"><input type="checkbox" checked={on} onChange={e => onChange(e.target.checked ? [...selected, m.id] : selected.filter(id => id !== m.id))} />{on ? `${selected.indexOf(m.id) + 1}번` : "선택"}</span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
