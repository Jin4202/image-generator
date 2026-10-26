"use client";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import type { z } from "zod";
import { Id, type EffectsInput } from "../../contracts";

type Value = z.infer<typeof EffectsInput>;
type Layer = Value["layers"][number];
const maxLayers = 20;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Axis-aligned box of an overlay after scale + clockwise rotation (same geometry the export uses). */
export function rotatedBox(width: number, height: number, scale: number, rotation: number): { width: number; height: number } {
  const w = width * scale; const h = height * scale; const r = (rotation * Math.PI) / 180;
  return { width: Math.abs(w * Math.cos(r)) + Math.abs(h * Math.sin(r)), height: Math.abs(w * Math.sin(r)) + Math.abs(h * Math.cos(r)) };
}

/** Converts a dragged overlay center (base pixels) back to the stored top-left of its rotated box. */
export function topLeftFromCenter(center: { x: number; y: number }, box: { width: number; height: number }): { x: number; y: number } {
  return { x: clamp(round2(center.x - box.width / 2), -4096, 4096), y: clamp(round2(center.y - box.height / 2), -4096, 4096) };
}

/** Base preview filter in the contract order; CSS brightness/contrast/saturate are the same linear operations, blur is display-scaled. */
export function cssFilter(value: Pick<Value, "brightness" | "contrast" | "saturation" | "blur">, displayScale: number): string {
  const blur = value.blur === 0 ? 0 : Math.max(0.3, value.blur) * displayScale;
  return `brightness(${value.brightness}) contrast(${value.contrast}) saturate(${value.saturation}) blur(${round2(blur)}px)`;
}

const mediaUrl = (mediaId: string) => `/api/media/${mediaId}`;

type StageProps = { width: number; height: number; scale: number; layers: Layer[]; images: Record<string, HTMLImageElement>; onMove: (index: number, center: { x: number; y: number }) => void };
/** Konva needs the browser canvas, so the overlay stage is loaded on the client only. */
const OverlayStage = dynamic(async () => {
  const { Stage, Layer: KLayer, Image: KImage } = await import("react-konva");
  function OverlayStageInner({ width, height, scale, layers, images, onMove }: StageProps) {
    // Same draw order as the export: low zIndex first, ties by array order.
    const ordered = layers.map((layer, index) => ({ layer, index })).sort((a, b) => a.layer.zIndex - b.layer.zIndex || a.index - b.index);
    return (
      <Stage width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        <KLayer>
          {ordered.map(({ layer, index }) => {
            const image = images[layer.mediaId];
            if (!image) return null;
            const box = rotatedBox(image.naturalWidth, image.naturalHeight, layer.scale, layer.rotation);
            return (
              <KImage key={index} image={image} draggable opacity={layer.opacity} rotation={layer.rotation}
                x={(layer.x + box.width / 2) * scale} y={(layer.y + box.height / 2) * scale}
                offsetX={image.naturalWidth / 2} offsetY={image.naturalHeight / 2} scaleX={layer.scale * scale} scaleY={layer.scale * scale}
                onDragEnd={e => onMove(index, { x: e.target.x() / scale, y: e.target.y() / scale })} />
            );
          })}
        </KLayer>
      </Stage>
    );
  }
  return OverlayStageInner;
}, { ssr: false });

/** T09: canvas preview; canonical PNG export rendered server-side using sharp. */
export function EffectsCanvas(props: { imageUrl: string; value: z.infer<typeof EffectsInput>; onChange: (value: z.infer<typeof EffectsInput>) => void }) {
  const { imageUrl, value, onChange } = props;
  const baseImage = useRef<HTMLImageElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(720);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [images, setImages] = useState<Record<string, HTMLImageElement>>({});
  const [newMediaId, setNewMediaId] = useState("");
  const [error, setError] = useState("");
  const mediaIds = useMemo(() => [...new Set(value.layers.map(l => l.mediaId))], [value.layers]);

  useEffect(() => {
    const element = wrapper.current; if (!element) return;
    const observer = new ResizeObserver(([entry]) => setAvailable(Math.max(160, Math.floor(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // A server-rendered <img> can finish loading before hydration, so onLoad alone may never fire.
  useEffect(() => {
    const img = baseImage.current;
    if (img?.complete && img.naturalWidth > 0) setNatural({ width: img.naturalWidth, height: img.naturalHeight });
  }, [imageUrl]);

  useEffect(() => {
    for (const mediaId of mediaIds) {
      if (images[mediaId]) continue;
      const image = new window.Image();
      image.onload = () => setImages(current => ({ ...current, [mediaId]: image }));
      image.onerror = () => setError(`오버레이 이미지를 불러오지 못했습니다: ${mediaId}`);
      image.src = mediaUrl(mediaId);
    }
  }, [mediaIds, images]);

  const displayWidth = natural ? Math.min(720, available, natural.width) : 0;
  const scale = natural ? displayWidth / natural.width : 1;
  const displayHeight = natural ? Math.round(natural.height * scale) : 0;
  const set = (patch: Partial<Value>) => onChange({ ...value, ...patch });
  const updateLayer = (index: number, patch: Partial<Layer>) => set({ layers: value.layers.map((l, i) => i === index ? { ...l, ...patch } : l) });
  const moveLayer = (index: number, center: { x: number; y: number }) => {
    const layer = value.layers[index]; const image = images[layer.mediaId];
    if (image) updateLayer(index, topLeftFromCenter(center, rotatedBox(image.naturalWidth, image.naturalHeight, layer.scale, layer.rotation)));
  };
  const addLayer = () => {
    const id = Id.safeParse(newMediaId.trim());
    if (!id.success) return setError("오버레이 media ID(UUID)를 입력하세요.");
    if (value.layers.length >= maxLayers) return setError(`오버레이는 최대 ${maxLayers}개입니다.`);
    setError(""); setNewMediaId("");
    set({ layers: [...value.layers, { mediaId: id.data, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, zIndex: 0, blend: "source-over" }] });
  };
  const number = (label: string, current: number, min: number, max: number, step: number, apply: (n: number) => void) => (
    <label className="flex items-center gap-1 text-sm">{label}
      <input type="number" aria-label={label} value={current} min={min} max={max} step={step} onChange={e => { const n = Number(e.target.value); if (Number.isFinite(n)) apply(clamp(n, min, max)); }} className="w-20 rounded border border-neutral-300 px-1" />
    </label>
  );
  const slider = (key: "brightness" | "contrast" | "saturation" | "blur", label: string, max: number, step: number) => (
    <label className="flex items-center gap-2 text-sm">{label}
      <input type="range" aria-label={label} min={0} max={max} step={step} value={value[key]} onChange={e => set({ [key]: Number(e.target.value) })} />
      <span className="w-12 font-mono text-xs">{value[key].toFixed(2)}</span>
    </label>
  );

  return (
    <section aria-label="효과 편집" className="space-y-3">
      <div ref={wrapper} className="w-full max-w-[720px]">
      <div className="relative max-w-full overflow-hidden outline outline-1 outline-neutral-300 bg-[repeating-conic-gradient(#ddd_0%_25%,#fff_0%_50%)] bg-[length:16px_16px]" style={natural ? { width: displayWidth, height: displayHeight } : undefined}>
        {/* eslint-disable-next-line @next/next/no-img-element -- local media route; dimensions come from the decoded image */}
        <img ref={baseImage} src={imageUrl} alt="후보 이미지" onLoad={e => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })} onError={() => setError("후보 이미지를 불러오지 못했습니다.")}
          style={{ width: natural ? displayWidth : undefined, height: natural ? displayHeight : undefined, filter: cssFilter(value, scale), display: "block" }} />
        {natural && <OverlayStage width={displayWidth} height={displayHeight} scale={scale} layers={value.layers} images={images} onMove={moveLayer} />}
      </div>
      </div>
      <p className="text-xs text-neutral-500">미리보기는 근사치입니다(채도·흐림 계산 방식이 조금 다름). 내보낸 PNG가 기준이며 원본 이미지는 바뀌지 않습니다.</p>
      <div className="flex flex-wrap gap-4">
        {slider("brightness", "밝기", 2, 0.01)}{slider("contrast", "대비", 2, 0.01)}{slider("saturation", "채도", 2, 0.01)}{slider("blur", "흐림", 20, 0.1)}
        <button type="button" onClick={() => set({ brightness: 1, contrast: 1, saturation: 1, blur: 0 })} className="rounded border border-neutral-300 px-2 text-sm">기본값</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input value={newMediaId} onChange={e => setNewMediaId(e.target.value)} placeholder="오버레이 media ID" aria-label="오버레이 media ID" className="w-80 max-w-full rounded border border-neutral-300 px-2 py-1 text-sm" />
        <button type="button" onClick={addLayer} disabled={value.layers.length >= maxLayers} className="rounded bg-neutral-900 px-3 py-1 text-sm text-white disabled:opacity-50">오버레이 추가</button>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {value.layers.length > 0 && (
        <ul aria-label="오버레이 목록" className="space-y-2">
          {value.layers.map((layer, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2 border-t border-neutral-200 pt-2">
              <span className="font-mono text-xs">{layer.mediaId.slice(0, 8)}…</span>
              {number(`x ${i + 1}`, layer.x, -4096, 4096, 1, n => updateLayer(i, { x: n }))}
              {number(`y ${i + 1}`, layer.y, -4096, 4096, 1, n => updateLayer(i, { y: n }))}
              {number(`배율 ${i + 1}`, layer.scale, 0.01, 8, 0.05, n => updateLayer(i, { scale: n }))}
              {number(`회전 ${i + 1}`, layer.rotation, -180, 180, 1, n => updateLayer(i, { rotation: n }))}
              {number(`불투명도 ${i + 1}`, layer.opacity, 0, 1, 0.05, n => updateLayer(i, { opacity: n }))}
              {number(`z ${i + 1}`, layer.zIndex, 0, 100, 1, n => updateLayer(i, { zIndex: Math.trunc(n) }))}
              <button type="button" onClick={() => set({ layers: value.layers.filter((_, j) => j !== i) })} className="text-sm text-red-700 underline">삭제</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
