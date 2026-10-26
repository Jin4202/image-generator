import sharp, { type OverlayOptions, type Sharp } from "sharp";
import type { CompositeInput, ImageCompositor } from "../../application/ports";
import { Limits } from "../../contracts";
import { AppError } from "../../domain/errors";

type Raw = { data: Buffer; width: number; height: number; channels: number };
/** Guard for a scaled overlay before clipping (scale ≤ 8 could otherwise allocate huge buffers). */
const maxOverlayPixels = 4 * Limits.uploadPixels;
const maxOverlaySide = 16_384;

const invalid = (): never => { throw new AppError("INVALID_MEDIA", "Export input image could not be decoded"); };

async function decodeRgba(bytes: Uint8Array): Promise<Raw> {
  try {
    const { data, info } = await sharp(Buffer.from(bytes), { failOn: "warning" }).toColourspace("srgb").ensureAlpha().raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, channels: info.channels };
  } catch { return invalid(); }
}
const rawInput = (r: Raw) => ({ raw: { width: r.width, height: r.height, channels: r.channels as 1 | 2 | 3 | 4 } });
/** One operation per pipeline: sharp reorders operations inside a single pipeline, so this keeps the contract order. */
async function step(r: Raw, op: (s: Sharp) => Sharp): Promise<Raw> {
  const { data, info } = await op(sharp(r.data, rawInput(r))).raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}
function splitAlpha(rgba: Raw): { rgb: Raw; alpha: Buffer } {
  const pixels = rgba.width * rgba.height; const rgb = Buffer.alloc(pixels * 3); const alpha = Buffer.alloc(pixels);
  for (let i = 0; i < pixels; i++) { rgb[i * 3] = rgba.data[i * 4]; rgb[i * 3 + 1] = rgba.data[i * 4 + 1]; rgb[i * 3 + 2] = rgba.data[i * 4 + 2]; alpha[i] = rgba.data[i * 4 + 3]; }
  return { rgb: { data: rgb, width: rgba.width, height: rgba.height, channels: 3 }, alpha };
}
function joinAlpha(rgb: Raw, alpha: Buffer): Raw {
  const pixels = rgb.width * rgb.height; const out = Buffer.alloc(pixels * 4);
  for (let i = 0; i < pixels; i++) { out[i * 4] = rgb.data[i * 3]; out[i * 4 + 1] = rgb.data[i * 3 + 1]; out[i * 4 + 2] = rgb.data[i * 3 + 2]; out[i * 4 + 3] = alpha[i]; }
  return { data: out, width: rgb.width, height: rgb.height, channels: 4 };
}

async function adjustBase(base: Raw, a: CompositeInput["adjustments"]): Promise<Raw> {
  if (a.brightness === 1 && a.contrast === 1 && a.saturation === 1 && a.blur === 0) return base;
  const { alpha } = splitAlpha(base); let { rgb } = splitAlpha(base);
  if (a.brightness !== 1) rgb = await step(rgb, s => s.linear(a.brightness, 0));
  if (a.contrast !== 1) rgb = await step(rgb, s => s.linear(a.contrast, 128 * (1 - a.contrast)));
  if (a.saturation !== 1) rgb = await step(rgb, s => s.modulate({ saturation: a.saturation }));
  if (a.blur > 0) rgb = await step(rgb, s => s.blur(Math.max(0.3, a.blur)));
  return joinAlpha(rgb, alpha);
}

/** Scale → rotate (clockwise, transparent corners) → opacity on alpha; returns the transformed bounding box pixels. */
async function transformOverlay(bytes: Uint8Array, layer: CompositeInput["overlays"][number]["layer"]): Promise<Raw> {
  let raw = await decodeRgba(bytes);
  const width = Math.max(1, Math.round(raw.width * layer.scale)); const height = Math.max(1, Math.round(raw.height * layer.scale));
  if (width > maxOverlaySide || height > maxOverlaySide || width * height > maxOverlayPixels) throw new AppError("UNSUPPORTED", "Overlay is too large after scaling");
  if (width !== raw.width || height !== raw.height) raw = await step(raw, s => s.resize(width, height, { fit: "fill", kernel: "lanczos3" }));
  if (layer.rotation % 360 !== 0) raw = await step(raw, s => s.rotate(layer.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } }));
  if (layer.opacity < 1) { const data = Buffer.from(raw.data); for (let i = 3; i < data.length; i += 4) data[i] = Math.round(data[i] * layer.opacity); raw = { ...raw, data }; }
  return raw;
}

/** T09: sharp implementation of the ImageCompositor contract in application/ports.ts. */
export function createSharpImageCompositor(): ImageCompositor {
  return {
    async composite(input) {
      const base = await adjustBase(await decodeRgba(input.base), input.adjustments);
      const layers: OverlayOptions[] = [];
      for (const { bytes, layer } of input.overlays) {
        const overlay = await transformOverlay(bytes, layer);
        // Clip the overlay box to the canvas; sharp composite cannot place pixels outside the base.
        const left = Math.round(layer.x); const top = Math.round(layer.y);
        const x0 = Math.max(0, left); const y0 = Math.max(0, top);
        const x1 = Math.min(base.width, left + overlay.width); const y1 = Math.min(base.height, top + overlay.height);
        if (x1 <= x0 || y1 <= y0 || layer.opacity === 0) continue;
        const visible = await step(overlay, s => s.extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 }));
        layers.push({ input: visible.data, raw: rawInput(visible).raw, left: x0, top: y0, blend: "over" });
      }
      let pipeline = sharp(base.data, rawInput(base));
      if (layers.length) pipeline = pipeline.composite(layers);
      const { data, info } = await pipeline.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
      return { bytes: new Uint8Array(data), width: info.width, height: info.height };
    },
  };
}
