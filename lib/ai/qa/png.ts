import { crc32, deflateSync } from 'node:zlib';

/**
 * Minimal 8-bit truecolor (no alpha) PNG encoder.
 *
 * `renderMeshViews` (./render.ts) needs to hand Gemini a real image file, but
 * nothing else in this codebase writes PNGs from raw pixels server-side - the
 * client captures its own via `<canvas>.toBlob` (see ThumbnailCapture.tsx),
 * and the Blender render path lets Blender itself write the file. Rather than
 * add an image-encoding dependency for one lightweight preview render, this
 * writes the handful of chunks a PNG actually needs, exactly the way
 * `lib/ai/mesh/glb.ts` hand-rolls a GLB instead of pulling in a glTF writer.
 */

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const out = Buffer.alloc(4 + body.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body) >>> 0, 4 + body.length);
  return out;
}

/**
 * Encode `width` x `height` RGB pixels (3 bytes/pixel, row-major, no padding)
 * as a single-file PNG.
 */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const stride = width * 3;
  if (rgb.length !== stride * height) {
    throw new Error(`encodePng: expected ${stride * height} bytes, got ${rgb.length}`);
  }

  // Every scanline is prefixed with a filter-type byte; "0" (None) keeps the
  // encoder trivial at the cost of a slightly larger file, which does not
  // matter for a small preview image.
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), rowStart + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor (RGB)
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method: none

  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
