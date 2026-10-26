"use client";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type Konva from "konva";
import { Media, type SceneContent } from "../../contracts";

type Point = [number, number];
type SceneBox = SceneContent["boxes"][number];
/** Local-only drawing state; points are normalized [x0,y0,x1,y1,…] in 0..1 so they survive resizes. */
export type Stroke = { tool: "pen" | "eraser"; points: number[] };
type Tool = Stroke["tool"] | "box";

const maxBoxes = 30;
const maxReferences = 20;
const minBoxSide = 0.01;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Pointer pixels → canvas-relative 0..1 coordinates. */
export function normalizePoint(x: number, y: number, width: number, height: number): Point {
  return [clamp01(x / width), clamp01(y / height)];
}

/** Drag corners → a box fully inside the canvas (x+w ≤ 1, y+h ≤ 1), or null when too small to mean anything. */
export function boxFromDrag(a: Point, b: Point): SceneBox["box"] | null {
  const x = round4(Math.min(a[0], b[0])); const y = round4(Math.min(a[1], b[1]));
  const w = Math.min(round4(Math.abs(a[0] - b[0])), round4(1 - x)); const h = Math.min(round4(Math.abs(a[1] - b[1])), round4(1 - y));
  return w >= minBoxSide && h >= minBoxSide ? { x, y, w, h } : null;
}

/** Replaces every sketch reference with the new one, keeping its position; null when the reference limit would be exceeded. */
export function replaceSketchReference(references: SceneContent["references"], mediaId: string): SceneContent["references"] | null {
  const first = references.findIndex(r => r.role === "sketch");
  const rest = references.filter(r => r.role !== "sketch");
  if (rest.length >= maxReferences) return null;
  const at = first === -1 ? rest.length : references.slice(0, first).filter(r => r.role !== "sketch").length;
  return [...rest.slice(0, at), { mediaId, role: "sketch", note: "" }, ...rest.slice(at)];
}

/** Uploads through the media HTTP API; the scene only ever receives an ID the server confirmed. */
async function uploadSketch(png: Blob): Promise<string> {
  const projectId = new URLSearchParams(window.location.search).get("projectId");
  if (!projectId) throw new Error("프로젝트를 먼저 선택하세요 (URL의 projectId가 없습니다).");
  const form = new FormData();
  form.append("file", new File([png], "sketch.png", { type: "image/png" }));
  form.append("projectId", projectId);
  form.append("licenseNotes", "SceneCanvas sketch");
  const response = await fetch("/api/media/upload", { method: "POST", body: form });
  const body = await response.json().catch(() => null) as { data?: unknown; error?: { message?: string } } | null;
  if (!response.ok) throw new Error(body?.error?.message ?? `업로드 실패 (${response.status})`);
  const media = Media.safeParse(body?.data);
  if (!media.success) throw new Error("업로드 응답 형식이 올바르지 않습니다.");
  return media.data.id;
}

type StageProps = {
  width: number; height: number; output: SceneContent["size"];
  tool: Tool; strokes: Stroke[]; boxes: SceneBox[]; canAddBox: boolean;
  onStroke: (stroke: Stroke) => void; onBox: (box: SceneBox["box"]) => void;
  exportRef: MutableRefObject<(() => Promise<Blob>) | null>;
};

/** Konva needs the browser canvas, so the stage is loaded on the client only. */
const SketchStage = dynamic(async () => {
  const { Stage, Layer, Line, Rect, Text } = await import("react-konva");
  function SketchStageInner({ width, height, output, tool, strokes, boxes, canAddBox, onStroke, onBox, exportRef }: StageProps) {
    const sketchLayer = useRef<Konva.Layer>(null);
    const [draft, setDraft] = useState<Stroke | null>(null);
    const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);
    const toPixels = (points: number[]) => points.map((p, i) => i % 2 === 0 ? p * width : p * height);

    useEffect(() => {
      // White background + strokes only (boxes are layout JSON, not sketch pixels), at the scene's target size.
      exportRef.current = () => new Promise<Blob>((resolve, reject) => {
        const layer = sketchLayer.current;
        if (!layer) return reject(new Error("캔버스가 준비되지 않았습니다."));
        const source = layer.toCanvas({ pixelRatio: output.width / width });
        const canvas = document.createElement("canvas"); canvas.width = output.width; canvas.height = output.height;
        const context = canvas.getContext("2d");
        if (!context) return reject(new Error("PNG를 만들 수 없습니다."));
        context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG를 만들 수 없습니다.")), "image/png");
      });
      return () => { exportRef.current = null; };
    }, [exportRef, output.width, output.height, width]);

    const pointer = (event: Konva.KonvaEventObject<MouseEvent | TouchEvent>): Point | null => {
      const position = event.target.getStage()?.getPointerPosition();
      return position ? normalizePoint(position.x, position.y, width, height) : null;
    };
    const start = (event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
      const p = pointer(event); if (!p) return;
      if (tool === "box") { if (canAddBox) setDrag({ from: p, to: p }); }
      else setDraft({ tool, points: [...p] });
    };
    const move = (event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
      const p = pointer(event); if (!p) return;
      if (draft) setDraft({ ...draft, points: [...draft.points, ...p] });
      else if (drag) setDrag({ ...drag, to: p });
    };
    const end = () => {
      if (draft) { if (draft.points.length >= 4) onStroke(draft); setDraft(null); }
      if (drag) { const box = boxFromDrag(drag.from, drag.to); if (box) onBox(box); setDrag(null); }
    };
    const preview = drag ? boxFromDrag(drag.from, drag.to) : null;

    return (
      <Stage width={width} height={height} onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end} onTouchStart={start} onTouchMove={move} onTouchEnd={end} style={{ touchAction: "none" }}>
        <Layer ref={sketchLayer}>
          {[...strokes, ...(draft ? [draft] : [])].map((stroke, i) => (
            <Line key={i} points={toPixels(stroke.points)} stroke="#111111" strokeWidth={stroke.tool === "eraser" ? 18 : 3} lineCap="round" lineJoin="round" tension={0.3} globalCompositeOperation={stroke.tool === "eraser" ? "destination-out" : "source-over"} />
          ))}
        </Layer>
        <Layer listening={false}>
          {boxes.map((item, i) => (
            <Rect key={`box-${i}`} x={item.box.x * width} y={item.box.y * height} width={item.box.w * width} height={item.box.h * height} stroke="#2563eb" strokeWidth={2} dash={[6, 4]} />
          ))}
          {boxes.map((item, i) => (
            <Text key={`label-${i}`} x={item.box.x * width + 4} y={item.box.y * height + 4} text={`${item.label} · z${item.zIndex}`} fontSize={13} fill="#1d4ed8" />
          ))}
          {preview && <Rect x={preview.x * width} y={preview.y * height} width={preview.w * width} height={preview.h * height} stroke="#2563eb" strokeWidth={1} />}
        </Layer>
      </Stage>
    );
  }
  return SketchStageInner;
}, { ssr: false, loading: () => <p className="text-sm text-neutral-500">캔버스 불러오는 중…</p> });

/** T04: Konva loaded client-side only; save sketch PNG + normalized JSON; no provider calls. */
export function SceneCanvas(props: { value: SceneContent; onChange: (value: SceneContent) => void }) {
  const { value, onChange } = props;
  const wrapper = useRef<HTMLDivElement>(null);
  const exportRef = useRef<(() => Promise<Blob>) | null>(null);
  const [available, setAvailable] = useState(720);
  const [tool, setTool] = useState<Tool>("pen");
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [label, setLabel] = useState("subject");
  const [status, setStatus] = useState<{ kind: "idle" | "saving" | "error" | "saved"; message: string }>({ kind: "idle", message: "" });

  useEffect(() => {
    const element = wrapper.current; if (!element) return;
    const observer = new ResizeObserver(([entry]) => setAvailable(Math.max(240, Math.floor(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale = Math.min(available / value.size.width, 540 / value.size.height, 1);
  const width = Math.round(value.size.width * scale); const height = Math.round(value.size.height * scale);
  const sketch = value.references.find(r => r.role === "sketch");
  const canAddBox = value.boxes.length < maxBoxes;
  const setBoxes = (boxes: SceneBox[]) => onChange({ ...value, boxes });
  const updateBox = (index: number, patch: Partial<SceneBox>) => setBoxes(value.boxes.map((b, i) => i === index ? { ...b, ...patch } : b));

  async function saveSketch() {
    if (!exportRef.current) return setStatus({ kind: "error", message: "캔버스가 준비되지 않았습니다." });
    setStatus({ kind: "saving", message: "스케치 업로드 중…" });
    try {
      const mediaId = await uploadSketch(await exportRef.current());
      const references = replaceSketchReference(value.references, mediaId);
      if (!references) throw new Error(`참조는 최대 ${maxReferences}개입니다. 다른 참조를 먼저 제거하세요.`);
      onChange({ ...value, references });
      setStatus({ kind: "saved", message: "스케치를 업로드하고 sketch 참조를 갱신했습니다. 장면 저장 후 반영됩니다." });
    } catch (error) {
      // The scene keeps its previous references: no unconfirmed media ID is ever written.
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "스케치 업로드 실패" });
    }
  }

  const toolButton = (id: Tool, text: string, disabled = false) => (
    <button type="button" aria-pressed={tool === id} disabled={disabled} onClick={() => setTool(id)} className={`rounded border px-3 py-1 text-sm ${tool === id ? "border-blue-600 bg-blue-50 text-blue-900" : "border-neutral-300"} disabled:opacity-50`}>{text}</button>
  );

  return (
    <section aria-label="장면 캔버스" className="space-y-3">
      <div role="toolbar" aria-label="캔버스 도구" className="flex flex-wrap items-center gap-2">
        {toolButton("pen", "펜")}
        {toolButton("eraser", "지우개")}
        {toolButton("box", "박스", !canAddBox)}
        <label className="flex items-center gap-1 text-sm">새 박스 라벨
          <input value={label} maxLength={120} onChange={e => setLabel(e.target.value)} className="w-32 rounded border border-neutral-300 px-2 py-1" />
        </label>
        <button type="button" onClick={() => setStrokes([])} disabled={strokes.length === 0} className="rounded border border-neutral-300 px-3 py-1 text-sm disabled:opacity-50">스케치 지우기</button>
        <button type="button" onClick={saveSketch} disabled={strokes.length === 0 || status.kind === "saving"} className="rounded bg-neutral-900 px-3 py-1 text-sm text-white disabled:opacity-50">스케치 PNG 업로드</button>
      </div>
      <div ref={wrapper} className="w-full max-w-full overflow-hidden">
        <div style={{ width, height }} className="border border-neutral-300 bg-white">
          <SketchStage width={width} height={height} output={value.size} tool={tool} strokes={strokes} boxes={value.boxes} canAddBox={canAddBox} exportRef={exportRef}
            onStroke={stroke => setStrokes(s => [...s, stroke])}
            onBox={box => canAddBox && setBoxes([...value.boxes, { label: label.trim() || "box", box, zIndex: 0, facing: "" }])} />
        </div>
      </div>
      <p className="text-xs text-neutral-500">스케치와 박스는 생성 결과를 강제하지 않는 약한 레이아웃 힌트입니다. 박스는 0..1 정규화 좌표로 저장됩니다.</p>
      {sketch && <p className="text-sm">현재 sketch 참조: <a className="underline" href={`/api/media/${sketch.mediaId}`} target="_blank" rel="noreferrer">{sketch.mediaId}</a></p>}
      <p role="status" aria-live="polite" className={`text-sm ${status.kind === "error" ? "text-red-700" : "text-neutral-700"}`}>{status.message}</p>
      {value.boxes.length > 0 && (
        <table className="w-full text-sm">
          <caption className="text-left font-medium">레이아웃 박스 ({value.boxes.length}/{maxBoxes}) · 같은 z는 목록 순서대로 겹칩니다</caption>
          <thead><tr><th className="text-left">라벨</th><th className="text-left">z</th><th className="text-left">방향</th><th className="text-left">위치(x,y,w,h)</th><th /></tr></thead>
          <tbody>
            {value.boxes.map((item, i) => (
              <tr key={i}>
                <td><input aria-label={`박스 ${i + 1} 라벨`} value={item.label} maxLength={120} onChange={e => updateBox(i, { label: e.target.value })} onBlur={e => { if (!e.target.value.trim()) updateBox(i, { label: "box" }); }} className="w-full rounded border border-neutral-300 px-1" /></td>
                <td><input aria-label={`박스 ${i + 1} z`} type="number" min={0} max={100} value={item.zIndex} onChange={e => updateBox(i, { zIndex: Math.min(100, Math.max(0, Math.trunc(Number(e.target.value) || 0))) })} className="w-16 rounded border border-neutral-300 px-1" /></td>
                <td><input aria-label={`박스 ${i + 1} 방향`} value={item.facing} maxLength={100} onChange={e => updateBox(i, { facing: e.target.value })} className="w-full rounded border border-neutral-300 px-1" /></td>
                <td className="font-mono text-xs">{[item.box.x, item.box.y, item.box.w, item.box.h].map(n => n.toFixed(3)).join(", ")}</td>
                <td><button type="button" onClick={() => setBoxes(value.boxes.filter((_, j) => j !== i))} className="text-red-700 underline">삭제</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
