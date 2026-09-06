import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { encodePng } from '@/lib/ai/qa/png';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Minimal chunk reader - just enough to check what encodePng wrote, without pulling in a PNG library. */
function readChunks(png: Uint8Array): { type: string; data: Uint8Array }[] {
  const chunks: { type: string; data: Uint8Array }[] = [];
  let offset = 8; // past the signature
  while (offset < png.length) {
    const length = new DataView(png.buffer, png.byteOffset + offset, 4).getUint32(0);
    const type = Buffer.from(png.slice(offset + 4, offset + 8)).toString('ascii');
    const data = png.slice(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 4 + 4 + length + 4; // length + type + data + crc
  }
  return chunks;
}

/** Undo encodePng's "no filter" scanlines back into flat RGB bytes. */
function decodeRgb(png: Uint8Array, width: number, height: number): Uint8Array {
  const chunks = readChunks(png);
  const idat = chunks.find((c) => c.type === 'IDAT');
  if (!idat) throw new Error('no IDAT chunk');
  const raw = inflateSync(Buffer.from(idat.data));

  const stride = width * 3;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    expect(raw[rowStart]).toBe(0); // filter type "None", as encodePng always writes
    out.set(raw.subarray(rowStart + 1, rowStart + 1 + stride), y * stride);
  }
  return out;
}

describe('encodePng', () => {
  it('starts with the PNG signature', () => {
    const png = encodePng(1, 1, new Uint8Array([255, 0, 0]));
    expect(Array.from(png.slice(0, 8))).toEqual(SIGNATURE);
  });

  it('writes an IHDR describing an 8-bit truecolor image of the given size', () => {
    const png = encodePng(4, 3, new Uint8Array(4 * 3 * 3));
    const ihdr = readChunks(png).find((c) => c.type === 'IHDR')!;
    const view = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
    expect(view.getUint32(0)).toBe(4); // width
    expect(view.getUint32(4)).toBe(3); // height
    expect(ihdr.data[8]).toBe(8); // bit depth
    expect(ihdr.data[9]).toBe(2); // color type: truecolor, no alpha
  });

  it('ends with an empty IEND chunk', () => {
    const png = encodePng(2, 2, new Uint8Array(2 * 2 * 3));
    const last = readChunks(png).at(-1)!;
    expect(last.type).toBe('IEND');
    expect(last.data.length).toBe(0);
  });

  it('round-trips arbitrary pixel data losslessly', () => {
    const width = 5;
    const height = 4;
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < rgb.length; i += 1) rgb[i] = (i * 37) % 256;

    const png = encodePng(width, height, rgb);
    expect(decodeRgb(png, width, height)).toEqual(rgb);
  });

  it('rejects a pixel buffer of the wrong length', () => {
    expect(() => encodePng(4, 4, new Uint8Array(3))).toThrow(/expected/);
  });
});
