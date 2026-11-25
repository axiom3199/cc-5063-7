export interface DenseMatrix {
  rows: number;
  cols: number;
  data: Float64Array;
}

export function zeros(rows: number, cols: number): DenseMatrix {
  return { rows, cols, data: new Float64Array(rows * cols) };
}

export function get(A: DenseMatrix, i: number, j: number): number {
  return A.data[i * A.cols + j];
}

export function set(A: DenseMatrix, i: number, j: number, v: number): void {
  A.data[i * A.cols + j] = v;
}

export function add(A: DenseMatrix, i: number, j: number, v: number): void {
  A.data[i * A.cols + j] += v;
}

/** Symmetric positive-(semi)definite solve via Cholesky with diagonal jitter fallback.
 *  Returns { solution, rcond-estimate via min pivot, regularized } */
export function solveSPD(
  A: DenseMatrix,
  b: Float64Array,
  options: { jitter?: number; maxJitterSteps?: number } = {},
): { x: Float64Array; minPivot: number; regularized: number } {
  const n = A.rows;
  if (n !== A.cols || b.length !== n) throw new Error('dimension mismatch');
  let jitter = 0;
  let minPivot = 0;
  const maxSteps = options.maxJitterSteps ?? 0;
  const baseJitter = options.jitter ?? 1e-12;

  let L = new Float64Array(n * n);
  let ok = false;
  let attempts = 0;
  while (!ok) {
    L = new Float64Array(n * n);
    minPivot = Infinity;
    ok = true;
    const scale = maxAbsDiag(A);
    const shift = jitter * Math.max(scale, 1e-300);
    for (let i = 0; i < n && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = get(A, i, j) + (i === j ? shift : 0);
        for (let k = 0; k < j; k++) sum -= L[i * n + k] * L[j * n + k];
        if (i === j) {
          if (!(sum > 0) || !Number.isFinite(sum)) {
            ok = false;
            break;
          }
          minPivot = Math.min(minPivot, sum);
          L[i * n + i] = Math.sqrt(sum);
        } else {
          L[i * n + j] = sum / L[j * n + j];
        }
      }
    }
    if (!ok) {
      attempts++;
      if (attempts > maxSteps) {
        throw new Error(
          `Cholesky failed after ${attempts} regularization attempts (matrix singular or not SPD)`,
        );
      }
      jitter = jitter === 0 ? baseJitter : jitter * 10;
    }
  }
  minPivot = Math.sqrt(Math.max(minPivot, 0));

  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= L[i * n + k] * y[k];
    y[i] = sum / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= L[k * n + i] * x[k];
    x[i] = sum / L[i * n + i];
  }
  return { x, minPivot, regularized: jitter };
}

export function maxAbsDiag(A: DenseMatrix): number {
  let m = 0;
  const n = Math.min(A.rows, A.cols);
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(get(A, i, i)));
  return m;
}

/** Eigenvalues of a small symmetric matrix via cyclic Jacobi. */
export function symmetricEigenvalues(A: DenseMatrix, sweeps = 60): Float64Array {
  const n = A.rows;
  const a = Float64Array.from(A.data);
  const scale = Math.max(maxAbsDiag(A), 1e-300);
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q];
    if (off <= 1e-30 * scale * scale * n) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) <= 1e-300) continue;
        const app = a[p * n + p];
        const aqq = a[q * n + q];
        const theta = (aqq - app) / (2 * apq);
        const t =
          Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p];
          const akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k];
          const aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
      }
    }
  }
  const ev = new Float64Array(n);
  for (let i = 0; i < n; i++) ev[i] = a[i * n + i];
  ev.sort();
  return ev;
}

/** Normalized ratios lambda_min/lambda_max and count of numerically-zero eigenvalues. */
export function conditioning(A: DenseMatrix, sweeps = 60): {
  lambdaMin: number;
  lambdaMax: number;
  ratio: number;
  rank: number;
  nullSpaceDimension: number;
  threshold: number;
} {
  const n = A.rows;
  const ev = symmetricEigenvalues(A, sweeps);
  const lambdaMin = Math.abs(ev[0]);
  const lambdaMax = Math.abs(ev[n - 1]);
  const threshold = Math.max(1e-10 * lambdaMax, 1e-14);
  let rank = 0;
  for (let i = 0; i < n; i++) if (Math.abs(ev[i]) > threshold) rank++;
  return {
    lambdaMin,
    lambdaMax,
    ratio: lambdaMax > 0 ? lambdaMin / lambdaMax : 0,
    rank,
    nullSpaceDimension: n - rank,
    threshold,
  };
}

export function matMul(A: DenseMatrix, B: DenseMatrix): DenseMatrix {
  if (A.cols !== B.rows) throw new Error('dimension mismatch');
  const C = zeros(A.rows, B.cols);
  for (let i = 0; i < A.rows; i++) {
    for (let k = 0; k < A.cols; k++) {
      const aik = A.data[i * A.cols + k];
      if (aik === 0) continue;
      for (let j = 0; j < B.cols; j++) C.data[i * C.cols + j] += aik * B.data[k * B.cols + j];
    }
  }
  return C;
}

export function transpose(A: DenseMatrix): DenseMatrix {
  const T = zeros(A.cols, A.rows);
  for (let i = 0; i < A.rows; i++)
    for (let j = 0; j < A.cols; j++) T.data[j * T.cols + i] = A.data[i * A.cols + j];
  return T;
}

export function matVec(A: DenseMatrix, v: Float64Array): Float64Array {
  if (A.cols !== v.length) throw new Error('dimension mismatch');
  const out = new Float64Array(A.rows);
  for (let i = 0; i < A.rows; i++) {
    let s = 0;
    for (let j = 0; j < A.cols; j++) s += A.data[i * A.cols + j] * v[j];
    out[i] = s;
  }
  return out;
}

export function frobenius(A: DenseMatrix): number {
  let s = 0;
  for (let i = 0; i < A.data.length; i++) s += A.data[i] * A.data[i];
  return Math.sqrt(s);
}

/** Solve a small symmetric (possibly indefinite) system by Gaussian elimination
 *  with partial pivoting. Used only for tiny dense blocks. */
export function solveDense(A: DenseMatrix, b: Float64Array): Float64Array {
  const n = A.rows;
  const M = Float64Array.from(A.data);
  const rhs = Float64Array.from(b);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r * n + col]) > Math.abs(M[piv * n + col])) piv = r;
    if (Math.abs(M[piv * n + col]) < 1e-300) throw new Error('singular');
    if (piv !== col) {
      for (let k = 0; k < n; k++) {
        const t = M[col * n + k];
        M[col * n + k] = M[piv * n + k];
        M[piv * n + k] = t;
      }
      const t = rhs[col];
      rhs[col] = rhs[piv];
      rhs[piv] = t;
    }
    const d = M[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r * n + col] / d;
      if (f === 0) continue;
      for (let k = col; k < n; k++) M[r * n + k] -= f * M[col * n + k];
      rhs[r] -= f * rhs[col];
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = rhs[i];
    for (let k = i + 1; k < n; k++) s -= M[i * n + k] * x[k];
    x[i] = s / M[i * n + i];
  }
  return x;
}
