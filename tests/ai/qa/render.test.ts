import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { buildMassingGlb } from '@/lib/ai/mesh/massing';
import { renderMeshViews } from '@/lib/ai/qa/render';
import { makeFurnitureSpec } from '../../fixtures';

/** Reads an encodePng output back into flat RGB bytes, IHDR width/height included. */
function decodePng(png: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  let offset = 8;
  let width = 0;
  let height = 0;
  let idat: Buffer | null = null;
  while (offset < png.length) {
    const length = new DataView(png.buffer, png.byteOffset + offset, 4).getUint32(0);
    const type = Buffer.from(png.slice(offset + 4, offset + 8)).toString('ascii');
    const data = png.slice(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = view.getUint32(0);
      height = view.getUint32(4);
    }
    if (type === 'IDAT') idat = Buffer.from(data);
    offset += 4 + 4 + length + 4;
  }
  if (!idat) throw new Error('no IDAT chunk');
  const raw = inflateSync(idat);
  const stride = width * 3;
  const rgb = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    rgb.set(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride), y * stride);
  }
  return { width, height, rgb };
}

describe('renderMeshViews', () => {
  it('renders one PNG per stock angle, each showing something other than flat background', async () => {
    const spec = makeFurnitureSpec();
    const glb = buildMassingGlb(spec);

    const views = await renderMeshViews(glb);

    expect(views.length).toBeGreaterThanOrEqual(3);
    const angles = new Set(views.map((v) => v.angle));
    expect(angles.size).toBe(views.length); // every angle distinct

    for (const view of views) {
      expect(view.image.mimeType).toBe('image/png');
      const { width, height, rgb } = decodePng(view.image.bytes);
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
      expect(rgb.length).toBe(width * height * 3);

      // The rendered piece should cover a meaningful fraction of the frame, not
      // just a stray pixel - i.e. this is a real silhouette, not a fluke.
      const background = rgb.slice(0, 3);
      let foreground = 0;
      for (let i = 0; i < rgb.length; i += 3) {
        if (rgb[i] !== background[0] || rgb[i + 1] !== background[1] || rgb[i + 2] !== background[2]) {
          foreground += 1;
        }
      }
      expect(foreground).toBeGreaterThan((width * height) / 20);
    }
  });

  it('returns no views for a mesh with no geometry', async () => {
    // Not a realistic reconstruct() output, but renderMeshViews must not throw
    // on it - an empty result degrades to "no mesh views this round", handled
    // by evaluateReconstruction falling back to the offline placeholder.
    const json = JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [] }],
      nodes: [],
    });
    const jsonChunk = Buffer.from(json);
    const padded = Buffer.concat([jsonChunk, Buffer.alloc((4 - (jsonChunk.length % 4)) % 4, 0x20)]);
    const total = 12 + 8 + padded.length;
    const out = Buffer.alloc(total);
    let o = 0;
    out.writeUInt32LE(0x46546c67, o); o += 4; // 'glTF'
    out.writeUInt32LE(2, o); o += 4;
    out.writeUInt32LE(total, o); o += 4;
    out.writeUInt32LE(padded.length, o); o += 4;
    out.writeUInt32LE(0x4e4f534a, o); o += 4; // 'JSON'
    padded.copy(out, o);

    const views = await renderMeshViews(new Uint8Array(out));
    expect(views).toEqual([]);
  });
});
