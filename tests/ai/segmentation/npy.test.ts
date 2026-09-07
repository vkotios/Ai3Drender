import { describe, expect, it } from 'vitest';

import { parseNpyIntArray } from '@/lib/ai/segmentation/npy';
import { PartSegmentationProviderError } from '@/lib/ai/segmentation/types';

type Dtype = 'i1' | 'u1' | 'i4' | 'u4' | 'i8';

const DTYPE_INFO: Record<Dtype, { code: string; bytes: number; write: (view: DataView, offset: number, value: number) => void }> = {
  i1: { code: '<i1', bytes: 1, write: (v, o, x) => v.setInt8(o, x) },
  u1: { code: '<u1', bytes: 1, write: (v, o, x) => v.setUint8(o, x) },
  i4: { code: '<i4', bytes: 4, write: (v, o, x) => v.setInt32(o, x, true) },
  u4: { code: '<u4', bytes: 4, write: (v, o, x) => v.setUint32(o, x, true) },
  i8: { code: '<i8', bytes: 8, write: (v, o, x) => v.setBigInt64(o, BigInt(x), true) },
};

/** Hand-builds a minimal valid .npy v1.0 file for a 1-D array, per numpy's format spec. */
function buildNpy(values: number[], dtype: Dtype, options?: { fortranOrder?: boolean; shape?: number[] }): Uint8Array {
  const info = DTYPE_INFO[dtype];
  const shape = options?.shape ?? [values.length];
  const fortran = options?.fortranOrder ?? false;
  const shapeStr = shape.length === 1 ? `(${shape[0]},)` : `(${shape.join(', ')})`;
  let header = `{'descr': '${info.code}', 'fortran_order': ${fortran ? 'True' : 'False'}, 'shape': ${shapeStr}, }`;
  const prefixLen = 10; // magic(6) + version(2) + header-length field(2)
  const pad = (64 - ((prefixLen + header.length + 1) % 64)) % 64;
  header = header + ' '.repeat(pad) + '\n';
  const headerBytes = new TextEncoder().encode(header);

  const dataBytes = new Uint8Array(values.length * info.bytes);
  const view = new DataView(dataBytes.buffer);
  values.forEach((value, i) => info.write(view, i * info.bytes, value));

  const out = new Uint8Array(prefixLen + headerBytes.length + dataBytes.length);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59], 0);
  out[6] = 1; // major version
  out[7] = 0; // minor version
  new DataView(out.buffer).setUint16(8, headerBytes.length, true);
  out.set(headerBytes, prefixLen);
  out.set(dataBytes, prefixLen + headerBytes.length);
  return out;
}

describe('parseNpyIntArray', () => {
  it('parses an int32 array - P3-SAM face_id\'s actual dtype in practice', () => {
    const bytes = buildNpy([-1, 0, 0, 1, 1, 2, -1], 'i4');
    const { values, shape } = parseNpyIntArray(bytes, 'p3sam');
    expect(values).toEqual([-1, 0, 0, 1, 1, 2, -1]);
    expect(shape).toEqual([7]);
  });

  it('parses a uint8 array', () => {
    const bytes = buildNpy([0, 1, 2, 255], 'u1');
    expect(parseNpyIntArray(bytes, 'p3sam').values).toEqual([0, 1, 2, 255]);
  });

  it('parses an int8 array (negative sentinel fits)', () => {
    const bytes = buildNpy([-1, -1, 0, 5], 'i1');
    expect(parseNpyIntArray(bytes, 'p3sam').values).toEqual([-1, -1, 0, 5]);
  });

  it('parses an int64 array, converting BigInt64Array down to number', () => {
    const bytes = buildNpy([-1, 1000000, 42], 'i8');
    expect(parseNpyIntArray(bytes, 'p3sam').values).toEqual([-1, 1000000, 42]);
  });

  it('handles an empty array', () => {
    const bytes = buildNpy([], 'i4');
    expect(parseNpyIntArray(bytes, 'p3sam').values).toEqual([]);
  });

  it('rejects bytes with no .npy magic header', () => {
    expect(() => parseNpyIntArray(new Uint8Array([1, 2, 3, 4]), 'p3sam')).toThrow(PartSegmentationProviderError);
  });

  it('rejects a fortran-ordered array', () => {
    const bytes = buildNpy([1, 2, 3], 'i4', { fortranOrder: true });
    expect(() => parseNpyIntArray(bytes, 'p3sam')).toThrow(/fortran/i);
  });

  it('rejects a non-1-D array', () => {
    const bytes = buildNpy([1, 2, 3, 4], 'i4', { shape: [2, 2] });
    expect(() => parseNpyIntArray(bytes, 'p3sam')).toThrow(/1-D/);
  });

  it('rejects an unsupported dtype (float)', () => {
    // Build a header claiming a float32 dtype - unsupported by this parser.
    let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (1,), }`;
    const pad = (64 - ((10 + header.length + 1) % 64)) % 64;
    header = header + ' '.repeat(pad) + '\n';
    const headerBytes = new TextEncoder().encode(header);
    const out = new Uint8Array(10 + headerBytes.length + 4);
    out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59], 0);
    out[6] = 1;
    out[7] = 0;
    new DataView(out.buffer).setUint16(8, headerBytes.length, true);
    out.set(headerBytes, 10);
    expect(() => parseNpyIntArray(out, 'p3sam')).toThrow(/unsupported dtype/i);
  });

  it('error messages are tagged with the provider name, like MeshProviderError', () => {
    try {
      parseNpyIntArray(new Uint8Array([0, 0, 0, 0]), 'p3sam');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PartSegmentationProviderError);
      expect((error as Error).message).toMatch(/^p3sam:/);
    }
  });
});
