/** Clamped (open) knot vector and B-spline basis utilities.
 *  Basis evaluation follows Piegl & Tiller, "The NURBS Book", algorithms A2.1-A2.3. */

export interface KnotSpec {
  degree: number;
  /** number of control points */
  count: number;
  /** interior knots, strictly increasing, inside (paramMin, paramMax).
   *  Repeated values are allowed to create reduced continuity (C0 creases). */
  interior: number[];
}

/** Clamped knot vector of length count+degree+1. */
export function clampedKnots(spec: KnotSpec, paramMin = 0, paramMax = 1): Float64Array {
  const { degree, count, interior } = spec;
  const nKnots = count + degree + 1;
  const expectedInterior = count - degree - 1;
  if (interior.length !== expectedInterior) {
    throw new Error(
      `knot count mismatch: ${count} control points of degree ${degree} require exactly ` +
        `${expectedInterior} interior knots, got ${interior.length}`,
    );
  }
  const knots = new Float64Array(nKnots);
  for (let i = 0; i <= degree; i++) knots[i] = paramMin;
  for (let i = 0; i < interior.length; i++) {
    const k = interior[i];
    if (!(k > paramMin) || !(k < paramMax)) throw new Error(`interior knot ${k} outside (${paramMin},${paramMax})`);
    if (i > 0 && !(k >= interior[i - 1])) throw new Error('interior knots must be non-decreasing');
    knots[degree + 1 + i] = k;
  }
  for (let i = nKnots - degree - 1; i < nKnots; i++) knots[i] = paramMax;
  return knots;
}

/** Uniform interior knots: count-degree-1 distinct values in (min,max). */
export function uniformInterior(count: number, degree: number, paramMin = 0, paramMax = 1): number[] {
  const m = count - degree - 1;
  if (m <= 0) return [];
  const out: number[] = [];
  for (let i = 1; i <= m; i++) out.push(paramMin + ((paramMax - paramMin) * i) / (m + 1));
  return out;
}

/** Distinct interior knots with multiplicities. A multiplicity > 1 lowers continuity. */
export function interiorMultiplicities(
  spec: KnotSpec,
  paramMin = 0,
  paramMax = 1,
): { value: number; multiplicity: number }[] {
  const knots = clampedKnots(spec, paramMin, paramMax);
  const out: { value: number; multiplicity: number }[] = [];
  const start = spec.degree + 1;
  const end = knots.length - spec.degree - 1;
  for (let i = start; i < end; i++) {
    const v = knots[i];
    const last = out[out.length - 1];
    if (last && Math.abs(last.value - v) < 1e-12) last.multiplicity++;
    else out.push({ value: v, multiplicity: 1 });
  }
  return out;
}

/** Highest continuity across the given interior knot = degree - multiplicity. */
export function continuityAt(spec: KnotSpec, knotValue: number): number {
  const list = interiorMultiplicities(spec);
  let mult = 0;
  for (const e of list) if (Math.abs(e.value - knotValue) < 1e-12) mult = e.multiplicity;
  return mult === 0 ? spec.degree : spec.degree - mult;
}

export function findSpan(knots: Float64Array, degree: number, u: number): number {
  const n = knots.length - degree - 1; // number of control points
  if (u >= knots[n]) return n - 1;
  if (u <= knots[degree]) return degree;
  let lo = degree;
  let hi = n;
  let mid = Math.floor((lo + hi) / 2);
  while (u < knots[mid] || u >= knots[mid + 1]) {
    if (u < knots[mid]) hi = mid;
    else lo = mid;
    mid = Math.floor((lo + hi) / 2);
    if (hi - lo <= 1) return lo;
  }
  return mid;
}

/** Non-zero basis values N_{span-p..span} at u. */
export function basisValues(
  knots: Float64Array,
  degree: number,
  span: number,
  u: number,
  out?: Float64Array,
): Float64Array {
  const buf = out ?? new Float64Array(degree + 1);
  const left = new Float64Array(degree + 1);
  const right = new Float64Array(degree + 1);
  buf[0] = 1;
  for (let j = 1; j <= degree; j++) {
    left[j] = u - knots[span + 1 - j];
    right[j] = knots[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const denom = right[r + 1] + left[j - r];
      const temp = denom !== 0 ? buf[r] / denom : 0;
      buf[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    buf[j] = saved;
  }
  return buf;
}

/** Basis values and derivatives up to order `order` (A2.3).
 *  Returns ders[k][i] = d^k N_{span-degree+i} / du^k for k=0..order. */
export function basisDerivatives(
  knots: Float64Array,
  degree: number,
  span: number,
  u: number,
  order: number,
): Float64Array[] {
  const p = degree;
  const du = Math.min(order, p);
  const ndu: Float64Array[] = [];
  for (let i = 0; i <= p; i++) ndu.push(new Float64Array(p + 1));
  const left = new Float64Array(p + 1);
  const right = new Float64Array(p + 1);
  ndu[0][0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - knots[span + 1 - j];
    right[j] = knots[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      ndu[j][r] = right[r + 1] + left[j - r];
      const temp = ndu[j][r] !== 0 ? ndu[r][j - 1] / ndu[j][r] : 0;
      ndu[r][j] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    ndu[j][j] = saved;
  }

  const ders: Float64Array[] = [];
  for (let k = 0; k <= du; k++) ders.push(new Float64Array(p + 1));
  for (let j = 0; j <= p; j++) ders[0][j] = ndu[j][p];

  const a: Float64Array[] = [];
  for (let i = 0; i <= 1; i++) a.push(new Float64Array(p + 1));
  for (let r = 0; r <= p; r++) {
    let s1 = 0;
    let s2 = 1;
    a[0][0] = 1;
    for (let k = 1; k <= du; k++) {
      let d = 0;
      const rk = r - k;
      const pk = p - k;
      if (r >= k) {
        a[s2][0] = a[s1][0] / ndu[pk + 1][rk];
        d = a[s2][0] * ndu[rk][pk];
      }
      const j1 = rk >= -1 ? 1 : -rk;
      const j2 = r - 1 <= pk ? k - 1 : p - r;
      for (let j = j1; j <= j2; j++) {
        a[s2][j] = (a[s1][j] - a[s1][j - 1]) / ndu[pk + 1][rk + j];
        d += a[s2][j] * ndu[rk + j][pk];
      }
      if (r <= pk) {
        a[s2][k] = -a[s1][k - 1] / ndu[pk + 1][r];
        d += a[s2][k] * ndu[r][pk];
      }
      ders[k][r] = d;
      const t = s1;
      s1 = s2;
      s2 = t;
    }
  }
  let fac = p;
  for (let k = 1; k <= du; k++) {
    for (let j = 0; j <= p; j++) ders[k][j] *= fac;
    fac *= p - k;
  }
  return ders;
}

export function partitionOfUnityCheck(knots: Float64Array, degree: number, u: number): number {
  const span = findSpan(knots, degree, u);
  const v = basisValues(knots, degree, span, u);
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i];
  return s;
}

export function knotDomain(knots: Float64Array, degree: number): [number, number] {
  return [knots[degree], knots[knots.length - degree - 1]];
}
