// Dense vector helpers over one flat Float32Array matrix (row-major, `dim` columns).

export function dotRows(matrix, dim, rowA, rowB) {
  const a = rowA * dim;
  const b = rowB * dim;
  let s = 0;
  for (let k = 0; k < dim; k++) s += matrix[a + k] * matrix[b + k];
  return s;
}

export function dotRowVec(matrix, dim, row, vec) {
  const a = row * dim;
  let s = 0;
  for (let k = 0; k < dim; k++) s += matrix[a + k] * vec[k];
  return s;
}

/** L2-normalize `vec` in place (no-op for a zero vector). Returns the original norm. */
export function normalizeInPlace(vec, offset = 0, dim = vec.length) {
  let s = 0;
  for (let k = 0; k < dim; k++) s += vec[offset + k] * vec[offset + k];
  const norm = Math.sqrt(s);
  if (norm > 0) for (let k = 0; k < dim; k++) vec[offset + k] /= norm;
  return norm;
}
