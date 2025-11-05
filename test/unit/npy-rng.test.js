import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readNpyMatrix, writeNpyMatrix } from '../../src/npy.js';
import { hashString, mulberry32, rngFor, weightedOrder } from '../../src/rng.js';

test('npy decodes known float16 bit patterns', () => {
  const header = readNpyMatrix(writeNpyMatrix(1, 1, [0], '<f2'));
  assert.equal(header.data[0], 0);
  // write raw half-precision bits into a 1x5 matrix and read them back
  const buf = writeNpyMatrix(1, 5, [0, 0, 0, 0, 0], '<f2');
  const start = buf.length - 10;
  [0x3c00, 0xc000, 0x3555, 0x7c00, 0x0001].forEach((bits, i) => buf.writeUInt16LE(bits, start + i * 2));
  assert.deepEqual([...readNpyMatrix(buf).data], [1, -2, 0.333251953125, Infinity, 2 ** -24]);
});

test('npy round-trips float32 and float16 matrices', () => {
  const values = [0.5, -0.25, 1, 0.125, -1, 0.75];
  for (const dtype of ['<f4', '<f2']) {
    const m = readNpyMatrix(writeNpyMatrix(2, 3, values, dtype));
    assert.equal(m.rows, 2);
    assert.equal(m.cols, 3);
    assert.deepEqual([...m.data], values);
  }
  assert.equal(readNpyMatrix(writeNpyMatrix(1, 1, [0.1], '<f2')).data[0].toFixed(4), '0.1000');
});

test('npy rejects files that are not 2-D little-endian floats', () => {
  assert.throws(() => readNpyMatrix(Buffer.from('not numpy at all')), /not a \.npy file/);
  const good = writeNpyMatrix(2, 2, [1, 2, 3, 4]);
  assert.throws(() => readNpyMatrix(good.subarray(0, good.length - 4)), /shorter than its shape/);
  const f8 = Buffer.from(good);
  f8.write("'<f8'", f8.indexOf("'<f4'"), 'latin1');
  assert.throws(() => readNpyMatrix(f8), /unsupported dtype/);
});

test('mulberry32 is deterministic per seed', () => {
  const a = mulberry32(hashString('x'));
  const b = mulberry32(hashString('x'));
  const c = mulberry32(hashString('y'));
  const seqA = [a(), a(), a()];
  assert.deepEqual(seqA, [b(), b(), b()]);
  assert.notDeepEqual(seqA, [c(), c(), c()]);
  for (const x of seqA) assert.ok(x >= 0 && x < 1);
});

test('rngFor gives independent streams', () => {
  assert.notEqual(rngFor('s', 'a')(), rngFor('s', 'b')());
  assert.equal(rngFor('s', 'a')(), rngFor('s', 'a')());
});

test('weightedOrder drops non-positive weights and favours heavy items', () => {
  const items = ['heavy', 'light', 'zero', 'negative'];
  const w = { heavy: 50, light: 1, zero: 0, negative: -3 };
  let heavyFirst = 0;
  for (let s = 0; s < 400; s++) {
    const order = weightedOrder(items, (x) => w[x], mulberry32(s));
    assert.deepEqual([...order].sort(), ['heavy', 'light']);
    if (order[0] === 'heavy') heavyFirst++;
  }
  // P(heavy first) = 50/51; allow noise.
  assert.ok(heavyFirst > 370, `heavy came first ${heavyFirst}/400 times`);
});
