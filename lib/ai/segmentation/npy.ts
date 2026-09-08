/**
 * Minimal parser for NumPy's `.npy` format - just enough to read a 1-D
 * integer array, which is what P3-SAM's `face_id` output is
 * (`np.save(path, face_ids)` in the model's own `app.py`/`auto_mask.py`,
 * verified by reading Tencent-Hunyuan/Hunyuan3D-Part on GitHub - see the
 * P3-SAM adapter's module doc for the exact source read).
 *
 * Format (https://numpy.org/doc/stable/reference/generated/numpy.lib.format.html):
 *   6 bytes  magic "\x93NUMPY"
 *   1 byte   major version
 *   1 byte   minor version
 *   2 or 4 bytes (v1: 2, v2+: 4), little-endian - header dict length
 *   N bytes  ASCII Python-dict-literal header, e.g.
 *            "{'descr': '<i4', 'fortran_order': False, 'shape': (12000,), }"
 *   rest     raw little-endian array data
 *
 * Values are returned as plain `number[]`; face-id arrays are small enough
 * (well under 2^53) that this never loses precision, including for an int64
 * dtype read via `BigInt64Array` and converted down.
 */
import { PartSegmentationProviderError } from './types';

const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // "\x93NUMPY"

interface TypedArrayCtor {
  new (buffer: ArrayBufferLike, byteOffset: number, length: number): {
    length: number;
    [index: number]: number | bigint;
  };
  BYTES_PER_ELEMENT: number;
}

const DTYPES: Record<string, { ctor: TypedArrayCtor; isBigInt: boolean }> = {
  i1: { ctor: Int8Array, isBigInt: false },
  u1: { ctor: Uint8Array, isBigInt: false },
  i2: { ctor: Int16Array, isBigInt: false },
  u2: { ctor: Uint16Array, isBigInt: false },
  i4: { ctor: Int32Array, isBigInt: false },
  u4: { ctor: Uint32Array, isBigInt: false },
  i8: { ctor: BigInt64Array, isBigInt: true },
  u8: { ctor: BigUint64Array, isBigInt: true },
};

export interface ParsedNpyArray {
  values: number[];
  shape: number[];
}

/** Parses a `.npy` file's bytes into a flat 1-D array of integers. Throws `PartSegmentationProviderError` on anything unexpected. */
export function parseNpyIntArray(bytes: Uint8Array, provider: string): ParsedNpyArray {
  // Thrown directly (rather than through a `fail()` helper) so TypeScript's
  // control-flow narrowing sees each guarded value as non-null afterwards.
  const fail = (message: string): PartSegmentationProviderError =>
    new PartSegmentationProviderError(provider, `face_id file: ${message}`);

  if (bytes.length < 10 || !MAGIC.every((b, i) => bytes[i] === b)) {
    throw fail('not a .npy file (missing magic header)');
  }

  const majorVersion = bytes[6];
  const headerLenBytes = majorVersion >= 2 ? 4 : 2;
  const headerLenOffset = 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen =
    headerLenBytes === 2 ? view.getUint16(headerLenOffset, true) : view.getUint32(headerLenOffset, true);
  const headerStart = headerLenOffset + headerLenBytes;
  const dataStart = headerStart + headerLen;
  if (dataStart > bytes.length) throw fail('truncated header');

  const header = new TextDecoder('ascii').decode(bytes.subarray(headerStart, dataStart));

  const descrMatch = /'descr'\s*:\s*'([^']+)'/.exec(header);
  const fortranMatch = /'fortran_order'\s*:\s*(True|False)/.exec(header);
  const shapeMatch = /'shape'\s*:\s*\(([^)]*)\)/.exec(header);
  if (!descrMatch || !fortranMatch || !shapeMatch) throw fail(`unparsable header: ${header}`);

  const descr = descrMatch[1];
  const byteOrder = descr[0];
  if (byteOrder === '>') throw fail(`big-endian dtype "${descr}" is not supported`);

  const typeCode = descr.replace(/^[<>|=]/, '');
  const dtype = DTYPES[typeCode];
  if (!dtype) throw fail(`unsupported dtype "${descr}" (expected a small/large integer type)`);

  const shape = shapeMatch[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s));
  if (shape.length !== 1) throw fail(`expected a 1-D array, got shape (${shapeMatch[1]})`);

  if (fortranMatch[1] === 'True') throw fail('fortran-ordered arrays are not supported');

  const [length] = shape;
  const elementSize = dtype.ctor.BYTES_PER_ELEMENT;
  const expectedBytes = length * elementSize;
  const available = bytes.length - dataStart;
  if (available < expectedBytes) throw fail(`truncated data (need ${expectedBytes} bytes, have ${available})`);

  // TypedArrays require their backing buffer to be aligned to the element
  // size; a .npy embedded further into a larger fetch response's ArrayBuffer
  // is not guaranteed to be, so copy into a freshly-aligned buffer.
  const dataBytes = bytes.slice(dataStart, dataStart + expectedBytes);
  const typed = new dtype.ctor(dataBytes.buffer, 0, length);

  const values = new Array<number>(length);
  for (let i = 0; i < length; i += 1) {
    values[i] = dtype.isBigInt ? Number(typed[i] as bigint) : (typed[i] as number);
  }

  return { values, shape };
}
