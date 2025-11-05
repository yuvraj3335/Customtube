// Minimal reader for the NumPy .npy format: little-endian float16 or float32, C order, 2-D.
// The export ships embeddings as float16, which Node 22 has no typed array for; the
// @petamoriken/float16 package decodes them into a Float32Array.

import { getFloat16, setFloat16 } from '@petamoriken/float16';

const MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // "\x93NUMPY"

/** Parse the header dict, e.g. {'descr': '<f2', 'fortran_order': False, 'shape': (6454, 384), } */
function parseHeader(text) {
  const descr = /'descr':\s*'([^']+)'/.exec(text)?.[1];
  const fortran = /'fortran_order':\s*(True|False)/.exec(text)?.[1];
  const shapeText = /'shape':\s*\(([^)]*)\)/.exec(text)?.[1];
  if (!descr || !fortran || shapeText === undefined) throw new Error(`npy: unreadable header ${text}`);
  const shape = shapeText
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (shape.some((n) => !Number.isInteger(n) || n < 0)) throw new Error(`npy: bad shape ${shapeText}`);
  return { descr, fortranOrder: fortran === 'True', shape };
}

/**
 * Read a 2-D float matrix from a .npy buffer.
 * @param {Buffer} buf
 * @returns {{ rows: number, cols: number, data: Float32Array }}
 */
export function readNpyMatrix(buf) {
  if (buf.length < 10 || MAGIC.some((b, i) => buf[i] !== b)) throw new Error('npy: not a .npy file');
  const major = buf[6];
  let headerLen;
  let offset;
  if (major === 1) {
    headerLen = buf.readUInt16LE(8);
    offset = 10;
  } else if (major === 2 || major === 3) {
    headerLen = buf.readUInt32LE(8);
    offset = 12;
  } else {
    throw new Error(`npy: unsupported version ${major}`);
  }
  const header = parseHeader(buf.toString('latin1', offset, offset + headerLen));
  const dataStart = offset + headerLen;
  if (header.fortranOrder) throw new Error('npy: fortran order is not supported');
  if (header.shape.length !== 2) throw new Error(`npy: expected a 2-D matrix, got shape ${header.shape}`);
  const [rows, cols] = header.shape;
  const count = rows * cols;
  const data = new Float32Array(count);

  if (header.descr === '<f2') {
    if (buf.length < dataStart + count * 2) throw new Error('npy: file is shorter than its shape');
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let i = 0; i < count; i++) data[i] = getFloat16(view, dataStart + i * 2, true);
  } else if (header.descr === '<f4') {
    if (buf.length < dataStart + count * 4) throw new Error('npy: file is shorter than its shape');
    for (let i = 0; i < count; i++) data[i] = buf.readFloatLE(dataStart + i * 4);
  } else {
    throw new Error(`npy: unsupported dtype ${header.descr}`);
  }
  return { rows, cols, data };
}

/** Build a .npy buffer (float16 or float32). Used by tests to make fixtures. */
export function writeNpyMatrix(rows, cols, values, dtype = '<f4') {
  let header = `{'descr': '${dtype}', 'fortran_order': False, 'shape': (${rows}, ${cols}), }`;
  const pad = 64 - ((10 + header.length + 1) % 64);
  header = header + ' '.repeat(pad % 64) + '\n';
  const size = dtype === '<f2' ? 2 : 4;
  const buf = Buffer.alloc(10 + header.length + rows * cols * size);
  Buffer.from(MAGIC).copy(buf, 0);
  buf[6] = 1;
  buf[7] = 0;
  buf.writeUInt16LE(header.length, 8);
  buf.write(header, 10, 'latin1');
  const start = 10 + header.length;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < rows * cols; i++) {
    if (size === 4) buf.writeFloatLE(values[i], start + i * 4);
    else setFloat16(view, start + i * 2, values[i], true);
  }
  return buf;
}
