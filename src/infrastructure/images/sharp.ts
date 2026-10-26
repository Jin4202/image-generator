import sharp from "sharp";
import type { ImageInfo, ImageInspector } from "../../application/ports";
import { Limits } from "../../contracts";
import { AppError } from "../../domain/errors";

/** Signature sniffing keeps unrecognized formats (e.g. SVG) away from the decoder entirely. */
function sniff(bytes: Uint8Array): string | null {
  const ascii = (start: number, end: number) => Buffer.from(bytes.subarray(start, end)).toString("latin1");
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 8) === "PNG\r\n\x1a\n") return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(0, 6))) return "image/gif";
  return null;
}
/** libvips decodes APNG as a still PNG, so read the animation control chunk (acTL precedes IDAT) directly. */
function apngFrames(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset + 8 <= bytes.length;) {
    const length = view.getUint32(offset); const type = Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString("latin1");
    if (type === "IDAT") return null;
    if (type === "acTL") return offset + 12 <= bytes.length ? view.getUint32(offset + 8) : null;
    offset += 12 + length;
  }
  return null;
}
const formatMime: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
const invalid = (): never => { throw new AppError("INVALID_MEDIA", "Image could not be decoded"); };

/** T02: sharp-backed ImageInspector. Decodes every pixel of the first frame; warnings (e.g. truncation) fail. */
export function createSharpImageInspector(): ImageInspector {
  return {
    async inspect(bytes: Uint8Array): Promise<ImageInfo> {
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) return invalid();
      const sniffed = sniff(bytes);
      if (!sniffed) return invalid();
      const input = Buffer.from(bytes); // copy: sharp never sees caller-owned memory
      try {
        const meta = await sharp(input, { failOn: "warning", limitInputPixels: false }).metadata();
        const mime = formatMime[meta.format ?? ""];
        if (mime !== sniffed || !meta.width || !meta.height) return invalid();
        const info = { mime, width: meta.width, height: meta.height, pages: (mime === "image/png" ? apngFrames(bytes) : null) ?? meta.pages ?? 1 };
        if (info.width * info.height > Limits.uploadPixels) return info;
        const decoded = await sharp(input, { failOn: "warning", limitInputPixels: Limits.uploadPixels }).raw().toBuffer({ resolveWithObject: true });
        if (decoded.info.width !== info.width || decoded.info.height !== info.height) return invalid();
        return info;
      } catch (error) {
        if (error instanceof AppError) throw error;
        return invalid();
      }
    },
  };
}
