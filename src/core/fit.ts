import { basisDerivatives, basisValues, clampedKnots, findSpan, interiorMultiplicities, uniformInterior } from './bspline.js';
import { add, conditioning, get, solveSPD, zeros } from './linalg.js';
import type { DenseMatrix } from './linalg.js';
import { coverageGrid, curvatureStats, dot, evaluateSurface, latticeFromGeometry, norm, normalize, subtract } from './surface.js';
import type {
  ControlLattice,
  CreaseHypothesis,
  FairnessEvidence,
  FitDiagnostics,
  FitRequest,
  FitResult,
  Observation,
  ObservationResidual,
  ProbeWeightSummary,
  SurfaceGeometryConfig,
  Vec3,
  WeightRule,
} from './types.js';

export const DEFAULT_MIN_WEIGHT = 1e-6;

// ---------------------------------------------------------------------------
// Basis expansion helpers
// ---------------------------------------------------------------------------

interface BasisEntry {
  index: number;
  value: number;
}

interface PointBasis {
  u: BasisEntry[];
  v: BasisEntry[];
  du: BasisEntry[];
  dv: BasisEntry[];
}

function pointBasis(lat: ControlLattice, u: number, v: number): PointBasis {
  const su = findSpan(lat.knotsU, lat.degreeU, u);
  const sv = findSpan(lat.knotsV, lat.degreeV, v);
  const Nu = basisValues(lat.knotsU, lat.degreeU, su, u);
  const Nv = basisValues(lat.knotsV, lat.degreeV, sv, v);
  const Du = basisDerivatives(lat.knotsU, lat.degreeU, su, u, 1)[1];
  const Dv = basisDerivatives(lat.knotsV, lat.degreeV, sv, v, 1)[1];
  const ue: BasisEntry[] = [];
  const ve: BasisEntry[] = [];
  const due: BasisEntry[] = [];
  const dve: BasisEntry[] = [];
  for (let a = 0; a <= lat.degreeU; a++) {
    const idx = su - lat.degreeU + a;
    if (Nu[a] !== 0) ue.push({ index: idx, value: Nu[a] });
    if (Du[a] !== 0) due.push({ index: idx, value: Du[a] });
  }
  for (let b = 0; b <= lat.degreeV; b++) {
    const idx = sv - lat.degreeV + b;
    if (Nv[b] !== 0) ve.push({ index: idx, value: Nv[b] });
    if (Dv[b] !== 0) dve.push({ index: idx, value: Dv[b] });
  }
  return { u: ue, v: ve, du: due, dv: dve };
}

// ---------------------------------------------------------------------------
// Weight resolution (documented rule, deterministic)
// ---------------------------------------------------------------------------

export interface WeightResolution {
  base: Float64Array;
  rules: WeightRule[];
  /** probe-group factor actually applied */
  probeFactors: Record<string, number>;
  manualCount: number;
  excludedCount: number;
}

/** Base weight of observation k is a product of fixed factors:
 *    manualWeight (user exclusion/edit) x probeGroupWeight.
 *  probeGroupWeight is 1 unless the metrologist flagged the group as offset or
 *  supplied an explicit group weight; an offset group gets settings.offsetProbeWeight.
 *  Robust reweighting is applied later, on top of this base, never replacing it.
 *  Observations with base 0 are excluded from the fit and never resurrected. */
export function resolveWeights(request: FitRequest): WeightResolution {
  const { observations, settings } = request;
  const flagged = new Set(request.offsetProbes ?? []);
  const explicit = request.probeWeights ?? {};
  const probeFactors: Record<string, number> = {};
  for (const o of observations) {
    if (!(o.probeId in probeFactors)) {
      let factor = 1;
      if (explicit[o.probeId] !== undefined) factor *= Math.max(0, explicit[o.probeId]);
      if (flagged.has(o.probeId)) {
        factor *= Math.max(0, settings.offsetProbeWeight);
      }
      if (!(factor > 0)) factor = 0;
      probeFactors[o.probeId] = factor;
    }
  }
  const base = new Float64Array(observations.length);
  const rules: WeightRule[] = [];
  let manualCount = 0;
  let excludedCount = 0;
  for (let k = 0; k < observations.length; k++) {
    const o = observations[k];
    const manual = o.manualWeight === undefined ? 1 : Math.max(0, o.manualWeight);
    if (o.manualWeight !== undefined) manualCount++;
    const pf = probeFactors[o.probeId] ?? 1;
    let w = manual * pf;
    if (flagged.has(o.probeId)) w *= Math.max(settings.minWeight, 1); // floor keeps group present
    base[k] = w;
    if (w === 0) excludedCount++;
    rules.push({
      observationId: o.id,
      probeId: o.probeId,
      manualWeight: manual,
      probeFactor: pf,
      baseWeight: w,
      excluded: w === 0,
    });
  }
  return { base, rules, probeFactors, manualCount, excludedCount };
}

// ---------------------------------------------------------------------------
// Normal equations
// ---------------------------------------------------------------------------

/** Control point indices that sit on a C0 break (an interior knot whose
 *  multiplicity reaches the degree). The second-difference fairing triple centred
 *  on such a point straddles the break and would penalise the design fold itself,
 *  so it must be omitted from the blend energy. */
export function c0ControlPoints(knots: Float64Array, degree: number): Set<number> {
  const set = new Set<number>();
  const hi = knots.length - degree - 2;
  for (let i = degree + 1; i <= hi; ) {
    const val = knots[i];
    let j = i;
    while (j + 1 <= hi && Math.abs(knots[j + 1] - val) < 1e-12) j++;
    if (j - i + 1 >= degree) set.add(j - degree);
    i = j + 1;
  }
  return set;
}

function buildNormalEquations(
  lat: ControlLattice,
  obs: Observation[],
  weights: Float64Array,
  normals: (Vec3 | null)[],
  settings: FitRequest['settings'],
): { K: DenseMatrix; b: Float64Array; normalRowCount: number } {
  const nCp = lat.countU * lat.countV;
  const n = nCp * 3;
  const K = zeros(n, n);
  const b = new Float64Array(n);
  const g = settings.geometry;
  // Energy-density normalization: the discrete tension/blend sums are divided by
  // the number of contributing differences so the fairing penalty scales with the
  // lattice and does not swamp the per-observation data terms as the grid grows.
  const nU = lat.countU;
  const nV = lat.countV;
  const spanU = Math.max(lat.uMax - lat.uMin, 1e-9);
  const spanV = Math.max(lat.vMax - lat.vMin, 1e-9);
  const nTensionPairs = (nU - 1) * nV + nU * (nV - 1);
  const nBlendTriples = (nU - 2) * nV + nU * (nV - 2);
  const wu = (g.tensionWeightU * (nU / spanU)) / Math.max(1, nTensionPairs);
  const wv = (g.tensionWeightV * (nV / spanV)) / Math.max(1, nTensionPairs);
  const bu = (g.blendWeightU * (nU / spanU) ** 2) / Math.max(1, nBlendTriples);
  const bv = (g.blendWeightV * (nV / spanV) ** 2) / Math.max(1, nBlendTriples);
  const dataFactor = g.dataWeight;
  let normalRowCount = 0;

  for (let k = 0; k < obs.length; k++) {
    const w = weights[k];
    if (w <= 0) continue;
    const o = obs[k];
    const basis = pointBasis(lat, o.u, o.v);
    const uv: { cp: number; value: number }[] = [];
    for (const ea of basis.u) for (const eb of basis.v) uv.push({ cp: ea.index * lat.countV + eb.index, value: ea.value * eb.value });
    for (const p of uv) {
      for (const q of uv) {
        const val = dataFactor * w * p.value * q.value;
        if (val === 0) continue;
        for (let c = 0; c < 3; c++) add(K, p.cp * 3 + c, q.cp * 3 + c, val);
      }
      for (let c = 0; c < 3; c++) b[p.cp * 3 + c] += dataFactor * w * p.value * o.point[c];
    }
    if (settings.useNormals && normals[k]) {
      const nr = normalize(normals[k] as Vec3);
      const scale = Math.sqrt(Math.max(1e-12, settings.normalWeight * w * dataFactor));
      for (const which of ['u', 'v'] as const) {
        // S_u . n and S_v . n are linear in the control points; the derivative
        // acts on the corresponding basis only and the other basis stays un-derived.
        const row: { idx: number; coef: number }[] = [];
        for (let a = 0; a <= lat.degreeU; a++) {
          const iu = findSpan(lat.knotsU, lat.degreeU, o.u) - lat.degreeU + a;
          const uCoeff = which === 'u'
            ? basisDerivatives(lat.knotsU, lat.degreeU, findSpan(lat.knotsU, lat.degreeU, o.u), o.u, 1)[1][a]
            : basisValues(lat.knotsU, lat.degreeU, findSpan(lat.knotsU, lat.degreeU, o.u), o.u)[a];
          for (let b = 0; b <= lat.degreeV; b++) {
            const iv = findSpan(lat.knotsV, lat.degreeV, o.v) - lat.degreeV + b;
            const vCoeff = which === 'v'
              ? basisDerivatives(lat.knotsV, lat.degreeV, findSpan(lat.knotsV, lat.degreeV, o.v), o.v, 1)[1][b]
              : basisValues(lat.knotsV, lat.degreeV, findSpan(lat.knotsV, lat.degreeV, o.v), o.v)[b];
            const cp = iu * lat.countV + iv;
            for (let c = 0; c < 3; c++) row.push({ idx: cp * 3 + c, coef: uCoeff * vCoeff * nr[c] * scale });
          }
        }
        for (const p of row) for (const q of row) add(K, p.idx, q.idx, p.coef * q.coef);
        normalRowCount++;
      }
    }
  }

  const tensionPairs: [number, number, number][] = [];
  const blendTriples: [number, number, number, number][] = [];
  const c0U = c0ControlPoints(lat.knotsU, lat.degreeU);
  const c0V = c0ControlPoints(lat.knotsV, lat.degreeV);
  for (let i = 0; i < nU; i++) {
    for (let j = 0; j < nV; j++) {
      const a = i * nV + j;
      if (i + 1 < nU) tensionPairs.push([a, (i + 1) * nV + j, wu]);
      if (j + 1 < nV) tensionPairs.push([a, i * nV + j + 1, wv]);
      // A second-difference triple whose centre is a C0 control point straddles
      // the break and would penalise the design fold itself. Omit only that triple;
      // the triples inside each panel still fair the panels.
      if (i + 2 < nU && !c0U.has(i + 1)) blendTriples.push([a, (i + 1) * nV + j, (i + 2) * nV + j, bu]);
      if (j + 2 < nV && !c0V.has(j + 1)) blendTriples.push([a, i * nV + j + 1, i * nV + j + 2, bv]);
    }
  }
  for (const [a, bb, w] of tensionPairs) {
    for (let c = 0; c < 3; c++) {
      add(K, a * 3 + c, a * 3 + c, w);
      add(K, bb * 3 + c, bb * 3 + c, w);
      add(K, a * 3 + c, bb * 3 + c, -w);
      add(K, bb * 3 + c, a * 3 + c, -w);
    }
  }
  for (const [a, bb, ccc, w] of blendTriples) {
    for (let c = 0; c < 3; c++) {
      add(K, a * 3 + c, a * 3 + c, w);
      add(K, bb * 3 + c, bb * 3 + c, 4 * w);
      add(K, ccc * 3 + c, ccc * 3 + c, w);
      add(K, a * 3 + c, bb * 3 + c, -2 * w);
      add(K, bb * 3 + c, a * 3 + c, -2 * w);
      add(K, bb * 3 + c, ccc * 3 + c, -2 * w);
      add(K, ccc * 3 + c, bb * 3 + c, -2 * w);
      add(K, a * 3 + c, ccc * 3 + c, w);
      add(K, ccc * 3 + c, a * 3 + c, w);
    }
  }
  return { K, b, normalRowCount };
}

/** Reduce away pinned scalar unknowns (pinned control points are eliminated,
 *  not softly penalized, so their values are exact). */
function reduceWithPins(
  K: DenseMatrix,
  b: Float64Array,
  nScalar: number,
  pinned: Record<number, Vec3>,
): { A: DenseMatrix; rhs: Float64Array; freeScalar: number[] } {
  const nCp = nScalar / 3;
  const pinnedCp = new Map<number, Vec3>();
  for (const key of Object.keys(pinned)) {
    const k = Number(key);
    if (!Number.isInteger(k) || k < 0 || k >= nCp) throw new Error(`pinned control point index ${key} out of range 0..${nCp - 1}`);
    pinnedCp.set(k, pinned[k]);
  }
  const freeScalar: number[] = [];
  const slot = new Int32Array(nScalar).fill(-1);
  for (let s = 0; s < nScalar; s++) {
    if (!pinnedCp.has(Math.floor(s / 3))) {
      slot[s] = freeScalar.length;
      freeScalar.push(s);
    }
  }
  const m = freeScalar.length;
  const A = zeros(m, m);
  const rhs = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const si = freeScalar[i];
    let acc = b[si];
    for (let j = 0; j < nScalar; j++) {
      const kij = get(K, si, j);
      if (kij === 0) continue;
      const sj = slot[j];
      if (sj >= 0) add(A, i, sj, kij);
      else {
        const pv = pinnedCp.get(Math.floor(j / 3)) as Vec3;
        acc -= kij * pv[j % 3];
      }
    }
    rhs[i] = acc;
  }
  return { A, rhs, freeScalar };
}

// ---------------------------------------------------------------------------
// Initial lattice & fairing evidence
// ---------------------------------------------------------------------------

interface InitialLattice {
  points: Vec3[];
  prior: Vec3[];
}

function initialLattice(observations: Observation[], geometry: SurfaceGeometryConfig): InitialLattice {
  const targets: [number, number][] = [
    [geometry.uMin, geometry.vMin],
    [geometry.uMax, geometry.vMin],
    [geometry.uMin, geometry.vMax],
    [geometry.uMax, geometry.vMax],
  ];
  const cornerPoints: Vec3[] = targets.map(([tu, tv]) => {
    let best: Vec3 = [0, 0, 0];
    let bestD = Infinity;
    for (const o of observations) {
      const d = (o.u - tu) ** 2 + (o.v - tv) ** 2;
      if (d < bestD) {
        bestD = d;
        best = o.point;
      }
    }
    return [...best] as Vec3;
  });
  const [p00, p10, p01, p11] = cornerPoints;
  const points: Vec3[] = [];
  for (let i = 0; i < geometry.countU; i++) {
    const tu = geometry.countU === 1 ? 0 : i / (geometry.countU - 1);
    for (let j = 0; j < geometry.countV; j++) {
      const tv = geometry.countV === 1 ? 0 : j / (geometry.countV - 1);
      const P: Vec3 = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        P[c] = (1 - tu) * (1 - tv) * p00[c] + tu * (1 - tv) * p10[c] + (1 - tu) * tv * p01[c] + tu * tv * p11[c];
      }
      points.push(P);
    }
  }
  return { points, prior: points.map((p) => [...p] as Vec3) };
}

function addPrior(K: DenseMatrix, b: Float64Array, weight: number, prior: Vec3[]): void {
  for (let k = 0; k < prior.length; k++) {
    for (let c = 0; c < 3; c++) {
      const s = k * 3 + c;
      add(K, s, s, weight);
      b[s] += weight * prior[k][c];
    }
  }
}

// ---------------------------------------------------------------------------
// Robust reweighting
// ---------------------------------------------------------------------------

export function robustWeight(r: number, cutoff: number, mode: 'none' | 'tukey' | 'huber'): number {
  if (mode === 'none' || !Number.isFinite(r)) return 1;
  const a = Math.abs(r);
  if (mode === 'tukey') {
    if (a >= cutoff) return 0;
    const t = 1 - (a / cutoff) ** 2;
    return t * t;
  }
  return a <= cutoff ? 1 : cutoff / a;
}

function robustScale(residuals: ObservationResidual[]): number {
  const mags = residuals.map((r) => r.distance).sort((a, b) => a - b);
  if (mags.length === 0) return 1;
  const med = mags[Math.floor(mags.length / 2)];
  return Math.max(1.4826 * med, 1e-9);
}

// ---------------------------------------------------------------------------
// Residuals
// ---------------------------------------------------------------------------

function computeResiduals(
  lat: ControlLattice,
  observations: Observation[],
  normals: (Vec3 | null)[],
  weights: Float64Array,
  baseWeights: Float64Array,
  holdout: Set<string>,
): { residuals: ObservationResidual[]; normalErrors: number[] } {
  const residuals: ObservationResidual[] = [];
  const normalErrors: number[] = [];
  for (let k = 0; k < observations.length; k++) {
    const o = observations[k];
    const e = evaluateSurface(lat, o.u, o.v);
    const diff = subtract(o.point, e.point);
    const distance = norm(diff);
    let normalError = 0;
    if (normals[k]) {
      const n = normals[k] as Vec3;
      normalError = Math.acos(Math.max(-1, Math.min(1, dot(n, e.normal))));
    }
    normalErrors.push(normalError);
    const rb = baseWeights[k] > 0 ? Math.min(1, weights[k] / baseWeights[k]) : 0;
    residuals.push({
      id: o.id,
      probeId: o.probeId,
      passId: o.passId,
      u: o.u,
      v: o.v,
      normalResidual: dot(diff, e.normal),
      distance,
      vector: diff,
      weight: weights[k],
      robustWeight: rb,
      influence: 0,
      isHoldout: holdout.has(o.id),
      isOutlierCandidate: false,
    });
  }
  return { residuals, normalErrors };
}

function collectNormalSigns(observations: Observation[], lat: ControlLattice): { normals: (Vec3 | null)[]; flips: number } {
  let flips = 0;
  const normals = observations.map((o) => {
    if (!o.normal) return null;
    const e = evaluateSurface(lat, o.u, o.v);
    let n = normalize(o.normal);
    if (dot(n, e.normal) < 0) {
      n = [-n[0], -n[1], -n[2]];
      flips++;
    }
    return n;
  });
  return { normals, flips };
}

// ---------------------------------------------------------------------------
// Diagnostics & fairness
// ---------------------------------------------------------------------------

function buildDiagnostics(
  lat: ControlLattice,
  observations: Observation[],
  residuals: ObservationResidual[],
  settings: FitRequest['settings'],
  nFreeScalar: number,
  solve: { minPivot: number; regularized: number },
  reduced: DenseMatrix,
  normalRowCount: number,
  flips: number,
  holdoutCount: number,
  excludedCount: number,
): FitDiagnostics {
  const coverage = coverageGrid(
    observations.map((o) => o.u),
    observations.map((o) => o.v),
    lat.uMin,
    lat.uMax,
    lat.vMin,
    lat.vMax,
    8,
  );
  const identifiabilityWarnings: string[] = [];
  const normalWarnings: string[] = [];
  const nFreeCp = nFreeScalar / 3;
  const dataPerUnknown = nFreeCp > 0 ? observations.length / nFreeCp : 0;

  let rankDeficiency = 0;
  let conditionRatio = 0;
  if (nFreeScalar > 0 && nFreeScalar <= 120) {
    const c = conditioning(reduced, 25);
    rankDeficiency = c.nullSpaceDimension;
    conditionRatio = c.ratio;
  } else if (nFreeScalar > 0) {
    let maxDiag = 0;
    for (let i = 0; i < reduced.rows; i++) maxDiag = Math.max(maxDiag, Math.abs(get(reduced, i, i)));
    conditionRatio = maxDiag > 0 ? (solve.minPivot / Math.sqrt(maxDiag)) ** 2 : 0;
  }

  if (nFreeCp > 0 && dataPerUnknown < 1) {
    identifiabilityWarnings.push(
      `欠约束：${observations.length} 个观测少于 ${nFreeCp} 个自由控制点；曲面主要由光滑先验决定，` +
        `约 ${Math.max(0, nFreeCp - observations.length)} 个自由度的信息来自先验而非测量。`,
    );
  } else if (nFreeCp > 0 && dataPerUnknown < 1.5) {
    identifiabilityWarnings.push(
      `观测/未知比仅 ${dataPerUnknown.toFixed(2)}：可辨识性依赖光滑先验，建议减少控制点或补充测点。`,
    );
  }
  if (coverage.occupancy < 0.6) {
    identifiabilityWarnings.push(
      `参数域覆盖率 ${(coverage.occupancy * 100).toFixed(0)}%：${coverage.emptyBins.length}/${coverage.totalBins} 个分箱为空，` +
        `未采样区域为外推，不应视为可加工依据。`,
    );
  }
  if (holdoutCount === 0) {
    identifiabilityWarnings.push('没有留出测点：无法检验过拟合；建议保留一组复测点不参与拟合。');
  }
  if (conditionRatio > 0 && conditionRatio < 1e-8) {
    identifiabilityWarnings.push(`法方程条件比约 ${conditionRatio.toExponential(2)}：接近秩亏，解对噪声敏感。`);
  }
  if (rankDeficiency > 0) {
    identifiabilityWarnings.push(`法方程秩亏 ${rankDeficiency} 维：存在不可辨识方向，需要增加约束或固定控制点。`);
  }
  if (excludedCount > 0) {
    identifiabilityWarnings.push(`${excludedCount} 个观测权重为 0（被排除），不计入拟合。`);
  }
  if (settings.useNormals && normalRowCount === 0) normalWarnings.push('已启用测点法向，但没有任何观测携带有效法向。');
  if (settings.useNormals && flips > 0) {
    normalWarnings.push(`${flips} 个测点法向与初始曲面法向相反，已统一翻转为同侧（约定：与初始参数化法向同向）。`);
  }
  if (settings.useNormals && normalRowCount > observations.length * 3) {
    normalWarnings.push('法向约束行数多于位置约束：拟合可能由法向主导，位置残差会被放松。');
  }
  return {
    observationCount: observations.length,
    freeControlPoints: nFreeCp,
    pinnedControlPoints: lat.points.length - nFreeCp,
    dofObservation: observations.length - nFreeCp,
    dataPerUnknown,
    rankDeficiency,
    conditionRatio,
    minPivot: solve.minPivot,
    regularized: solve.regularized,
    coverage,
    normalWarnings,
    weightHistogram: histogram(residuals.map((r) => r.weight)),
    probeSummary: probeSummary(observations, residuals),
    identifiabilityWarnings,
    normalConstraintRank: normalRowCount,
    normalConstraintNullDimension: 0,
    normalSignFlips: flips,
  };
}

function histogram(weights: number[]): { bin: number; count: number; label: string }[] {
  const edges = [0.0, 0.05, 0.25, 0.5, 0.75, 0.95, 1.0001];
  const out: { bin: number; count: number; label: string }[] = new Array(edges.length - 1)
    .fill(0)
    .map((_, i) => ({ bin: i, count: 0, label: edgeLabel(edges, i) }));
  for (const w of weights) {
    for (let b = 0; b < edges.length - 1; b++) {
      if (w >= edges[b] && w < edges[b + 1]) {
        out[b].count++;
        break;
      }
    }
  }
  return out;
}
function edgeLabel(edges: number[], i: number): string {
  const hi = Math.min(edges[i + 1], 1).toFixed(2);
  return `${edges[i].toFixed(2)}–${hi}`;
}

function probeSummary(observations: Observation[], residuals: ObservationResidual[]): ProbeWeightSummary[] {
  const map = new Map<string, { n: number; signed: number; sq: number; w: number; repeat: boolean; side: string }>();
  for (let k = 0; k < observations.length; k++) {
    const o = observations[k];
    const e = map.get(o.probeId) ?? { n: 0, signed: 0, sq: 0, w: 0, repeat: o.passId !== 'first', side: (o as Observation & { side?: string }).side ?? '' };
    e.n++;
    e.signed += residuals[k].normalResidual;
    e.sq += residuals[k].distance ** 2;
    e.w += residuals[k].weight;
    map.set(o.probeId, e);
  }
  return [...map.entries()].map(([probeId, e]) => ({
    probeId,
    observationCount: e.n,
    meanResidual: e.n ? e.signed / e.n : 0,
    rmsResidual: e.n ? Math.sqrt(e.sq / e.n) : 0,
    meanSignedResidual: e.n ? e.signed / e.n : 0,
    effectiveWeight: e.n ? e.w / e.n : 0,
    flaggedOffset: e.n ? e.w / e.n < 0.5 : false,
    isRepeat: e.repeat,
  }));
}

function fairness(lat: ControlLattice, geometry: SurfaceGeometryConfig): FairnessEvidence {
  const pts = lat.points;
  const nU = lat.countU;
  const nV = lat.countV;
  const spanU = Math.max(lat.uMax - lat.uMin, 1e-9);
  const spanV = Math.max(lat.vMax - lat.vMin, 1e-9);
  const nTensionPairs = (nU - 1) * nV + nU * (nV - 1);
  const nBlendTriples = (nU - 2) * nV + nU * (nV - 2);
  const wu = (geometry.tensionWeightU * (nU / spanU)) / Math.max(1, nTensionPairs);
  const wv = (geometry.tensionWeightV * (nV / spanV)) / Math.max(1, nTensionPairs);
  const bu = (geometry.blendWeightU * (nU / spanU) ** 2) / Math.max(1, nBlendTriples);
  const bv = (geometry.blendWeightV * (nV / spanV) ** 2) / Math.max(1, nBlendTriples);
  let tension = 0;
  let blend = 0;
  for (let i = 0; i < nU; i++) {
    for (let j = 0; j < nV; j++) {
      const a = i * nV + j;
      if (i + 1 < nU) tension += wu * sq(pts[a], pts[(i + 1) * nV + j]);
      if (j + 1 < nV) tension += wv * sq(pts[a], pts[i * nV + j + 1]);
      if (i + 2 < nU) blend += bu * sq2(pts[a], pts[(i + 1) * nV + j], pts[(i + 2) * nV + j]);
      if (j + 2 < nV) blend += bv * sq2(pts[a], pts[i * nV + j + 1], pts[i * nV + j + 2]);
    }
  }
  const curv = curvatureStats(lat);
  return {
    tension,
    blend,
    maxCurvature: curv.maxAbs,
    controlPointCount: nU * nV,
    creases: creaseList(geometry),
    knotInformation: totalKnotInformation(geometry),
  };
}

function sq(a: Vec3, b: Vec3): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}
function sq2(a: Vec3, b: Vec3, c: Vec3): number {
  return (a[0] - 2 * b[0] + c[0]) ** 2 + (a[1] - 2 * b[1] + c[1]) ** 2 + (a[2] - 2 * b[2] + c[2]) ** 2;
}

export function creaseList(geometry: SurfaceGeometryConfig): { direction: 'u' | 'v'; at: number; continuity: number }[] {
  const out: { direction: 'u' | 'v'; at: number; continuity: number }[] = [];
  for (const e of interiorMultiplicities({ degree: geometry.degreeU, count: geometry.countU, interior: geometry.interiorU }, geometry.uMin, geometry.uMax)) {
    if (e.multiplicity > 1) out.push({ direction: 'u', at: e.value, continuity: geometry.degreeU - e.multiplicity });
  }
  for (const e of interiorMultiplicities({ degree: geometry.degreeV, count: geometry.countV, interior: geometry.interiorV }, geometry.vMin, geometry.vMax)) {
    if (e.multiplicity > 1) out.push({ direction: 'v', at: e.value, continuity: geometry.degreeV - e.multiplicity });
  }
  return out;
}

function rms(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x * x;
  return Math.sqrt(s / xs.length);
}
function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ---------------------------------------------------------------------------
// Fit driver
// ---------------------------------------------------------------------------

export interface FitOptions {
  /** deterministic seed for tie-breaking in robust iteration; unused numerically */
  seed?: number;
}

export function fitSurface(request: FitRequest, _options: FitOptions = {}): FitResult {
  const { observations, settings } = request;
  validateGeometry(settings.geometry);
  if (observations.length === 0) throw new Error('no observations supplied');
  for (const o of observations) {
    if (!Number.isFinite(o.u) || !Number.isFinite(o.v)) throw new Error(`observation ${o.id} has non-finite parameter label`);
    if (!(o.u >= settings.geometry.uMin && o.u <= settings.geometry.uMax))
      throw new Error(`observation ${o.id} u=${o.u} outside parameter domain [${settings.geometry.uMin},${settings.geometry.uMax}]`);
    if (!(o.v >= settings.geometry.vMin && o.v <= settings.geometry.vMax))
      throw new Error(`observation ${o.id} v=${o.v} outside parameter domain [${settings.geometry.vMin},${settings.geometry.vMax}]`);
  }

  const geometry = settings.geometry;
  const init = initialLattice(observations, geometry);
  let lattice = latticeFromGeometry(geometry, init.points);
  const { normals, flips } = collectNormalSigns(observations, lattice);

  const resolved = resolveWeights(request);
  const baseWeights = resolved.base;
  const holdout = new Set(request.holdoutIds ?? []);

  const maxIter = settings.robust === 'none' ? 1 : Math.max(1, geometry.robustIterations);
  let robustWeights = new Float64Array(observations.length).fill(1);
  let weights = Float64Array.from(baseWeights);
  let totalWeights = Float64Array.from(baseWeights);
  let lastSolve = { minPivot: 0, regularized: 0 };
  let reducedMatrix: DenseMatrix = zeros(0, 0);
  let normalRowCount = 0;
  let usedIterations = 0;
  const nCp = geometry.countU * geometry.countV;
  const nScalar = nCp * 3;

  let final = computeResiduals(lattice, observations, normals, weights, baseWeights, holdout);

  for (let iter = 0; iter < maxIter; iter++) {
    usedIterations = iter + 1;
    weights = new Float64Array(observations.length);
    for (let k = 0; k < observations.length; k++) weights[k] = Math.max(0, baseWeights[k] * robustWeights[k]);

    const { K, b, normalRowCount: nrc } = buildNormalEquations(lattice, observations, weights, normals, settings);
    normalRowCount = nrc;
    addPrior(K, b, geometry.priorWeight, init.prior);

    const reduced = reduceWithPins(K, b, nScalar, request.pinnedControlPoints ?? {});
    reducedMatrix = reduced.A;
    if (reduced.A.rows === 0) throw new Error('all control points are pinned; nothing to solve');
    const solved = solveSPD(reduced.A, reduced.rhs, { jitter: 1e-14, maxJitterSteps: 10 });
    lastSolve = { minPivot: solved.minPivot, regularized: solved.regularized };

    const newPoints: Vec3[] = lattice.points.map((p) => [...p] as Vec3);
    for (let i = 0; i < reduced.freeScalar.length; i++) {
      const s = reduced.freeScalar[i];
      const cp = Math.floor(s / 3);
      if (!newPoints[cp]) newPoints[cp] = [0, 0, 0];
      newPoints[cp][s % 3] = solved.x[i];
    }
    const pinned = request.pinnedControlPoints ?? {};
    for (const key of Object.keys(pinned)) newPoints[Number(key)] = [...pinned[Number(key)]] as Vec3;
    lattice = { ...lattice, points: newPoints };

    final = computeResiduals(lattice, observations, normals, weights, baseWeights, holdout);
    totalWeights = weights;

    if (settings.robust !== 'none' && iter < maxIter - 1) {
      const scale = robustScale(final.residuals);
      for (let k = 0; k < observations.length; k++) {
        const r = final.residuals[k].distance / scale;
        robustWeights[k] = Math.max(settings.minWeight, robustWeight(r, geometry.robustCutoff, settings.robust));
      }
    }
  }

  // influence proxy: leverage-like weight share per observation
  const totalWeight = final.residuals.reduce((s, r) => s + r.weight, 0) || 1;
  for (const r of final.residuals) {
    const z = r.distance / Math.max(robustScale(final.residuals), 1e-12);
    r.influence = (r.weight / totalWeight) * (1 + z * z);
    r.isOutlierCandidate = z > geometry.robustCutoff;
  }

  const diagnostics = buildDiagnostics(
    lattice,
    observations,
    final.residuals,
    settings,
    reducedMatrix.rows,
    lastSolve,
    reducedMatrix,
    normalRowCount,
    flips,
    request.holdoutIds?.length ?? 0,
    resolved.excludedCount,
  );

  const normalErrorsAll = final.normalErrors.filter((_, k) => normals[k] !== null);
  const included = final.residuals.filter((r) => r.weight > 0);
  const fitSet = included.filter((r) => !r.isHoldout);
  const holdSet = final.residuals.filter((r) => r.isHoldout);
  const fair = fairness(lattice, geometry);

  const objective = {
    data: included.reduce((s, r) => s + r.weight * r.distance * r.distance, 0),
    tension: fair.tension,
    blend: fair.blend,
    prior: priorObjective(lattice, init.prior, geometry.priorWeight),
  };

  const warnings = [...diagnostics.identifiabilityWarnings, ...diagnostics.normalWarnings];
  if (lastSolve.regularized > 1e-12) {
    warnings.push(`法方程需要对角正则化 ${lastSolve.regularized.toExponential(2)} 才能求解，结果不是纯最小二乘解。`);
  }

  return {
    lattice,
    settings,
    observations,
    residuals: final.residuals,
    diagnostics,
    fairness: fair,
    weights: totalWeights,
    robustIterations: usedIterations,
    rms: rms(included.map((r) => r.distance)),
    rmsFit: rms(fitSet.map((r) => r.distance)),
    rmsHoldout: rms(holdSet.map((r) => r.distance)),
    maxNormalError: normalErrorsAll.length ? Math.max(...normalErrorsAll) : 0,
    meanNormalError: mean(normalErrorsAll),
    objective,
    warnings,
    weightRules: resolved.rules,
    probeFactors: resolved.probeFactors,
  };
}

function priorObjective(lat: ControlLattice, prior: Vec3[], weight: number): number {
  let s = 0;
  for (let k = 0; k < lat.points.length; k++) s += weight * sq(lat.points[k], prior[k]);
  return s;
}

export function validateGeometry(g: SurfaceGeometryConfig): void {
  if (g.degreeU < 1 || g.degreeV < 1) throw new Error('surface degree must be at least 1');
  if (g.countU <= g.degreeU || g.countV <= g.degreeV) throw new Error('control point count must exceed degree on each axis');
  if (!(g.uMax > g.uMin) || !(g.vMax > g.vMin)) throw new Error('invalid parameter domain');
  clampedKnots({ degree: g.degreeU, count: g.countU, interior: g.interiorU }, g.uMin, g.uMax);
  clampedKnots({ degree: g.degreeV, count: g.countV, interior: g.interiorV }, g.vMin, g.vMax);
  if (g.tensionWeightU < 0 || g.tensionWeightV < 0 || g.blendWeightU < 0 || g.blendWeightV < 0)
    throw new Error('fairing weights must be non-negative');
  if (g.priorWeight < 0) throw new Error('prior weight must be non-negative');
}

export function defaultGeometry(overrides: Partial<SurfaceGeometryConfig> = {}): SurfaceGeometryConfig {
  const degreeU = 3;
  const degreeV = 3;
  const countU = 7;
  const countV = 7;
  return {
    degreeU,
    degreeV,
    countU,
    countV,
    interiorU: uniformInterior(countU, degreeU),
    interiorV: uniformInterior(countV, degreeV),
    uMin: 0,
    uMax: 1,
    vMin: 0,
    vMax: 1,
    tensionWeightU: 0.02,
    tensionWeightV: 0.02,
    blendWeightU: 0.005,
    blendWeightV: 0.005,
    priorWeight: 0.001,
    dataWeight: 1,
    robustCutoff: 3.5,
    robustIterations: 8,
    ...overrides,
  };
}

/** Build interior knots with `mult` copies exactly at `at` (C0 when mult === degree),
 *  remaining budget distributed uniformly in the two sub-intervals. Control point
 *  count is unchanged so a crease hypothesis is compared at equal complexity. */
export function knotsWithCrease(
  geometry: SurfaceGeometryConfig,
  axis: 'u' | 'v',
  at: number,
  mult = geometry[axis === 'u' ? 'degreeU' : 'degreeV'],
): number[] {
  const degree = axis === 'u' ? geometry.degreeU : geometry.degreeV;
  const count = axis === 'u' ? geometry.countU : geometry.countV;
  const lo = axis === 'u' ? geometry.uMin : geometry.vMin;
  const hi = axis === 'u' ? geometry.uMax : geometry.vMax;
  if (!(at > lo) || !(at < hi)) throw new Error(`crease location ${at} must lie inside (${lo},${hi})`);
  const m = Math.min(degree, Math.max(1, mult));
  const budget = count - degree - 1;
  if (budget < m) throw new Error(`control point count too small for a multiplicity-${m} crease`);
  const remaining = budget - m;
  const leftCount = Math.ceil(remaining / 2);
  const rightCount = remaining - leftCount;
  const out: number[] = [];
  for (let i = 1; i <= leftCount; i++) out.push(lo + ((at - lo) * i) / (leftCount + 1));
  for (let i = 0; i < m; i++) out.push(at);
  for (let i = 1; i <= rightCount; i++) out.push(at + ((hi - at) * i) / (rightCount + 1));
  return out;
}

export interface CreaseApplication {
  geometry: SurfaceGeometryConfig;
  applied: boolean;
  message: string;
}

export function applyCrease(geometry: SurfaceGeometryConfig, crease: CreaseHypothesis): CreaseApplication {
  if (!crease.enabled) return { geometry, applied: false, message: 'crease disabled' };
  const next = { ...geometry };
  try {
    const knots = knotsWithCrease(geometry, crease.direction, crease.at);
    if (crease.direction === 'u') next.interiorU = knots;
    else next.interiorV = knots;
  } catch (err) {
    return { geometry, applied: false, message: (err as Error).message };
  }
  const degree = crease.direction === 'u' ? next.degreeU : next.degreeV;
  return {
    geometry: next,
    applied: true,
    message: `在 ${crease.direction}=${crease.at.toFixed(3)} 处设 C0 折线（内部节点重数 ${degree}），控制点数不变 (${next.countU}×${next.countV})`,
  };
}

export function totalKnotInformation(geometry: SurfaceGeometryConfig): { u: string; v: string } {
  const u = interiorMultiplicities({ degree: geometry.degreeU, count: geometry.countU, interior: geometry.interiorU }, geometry.uMin, geometry.uMax);
  const v = interiorMultiplicities({ degree: geometry.degreeV, count: geometry.countV, interior: geometry.interiorV }, geometry.vMin, geometry.vMax);
  const fmt = (list: { value: number; multiplicity: number }[]) =>
    list.length === 0 ? '无内部节点' : list.map((e) => `${e.value.toFixed(3)}×${e.multiplicity}`).join(', ');
  return { u: fmt(u), v: fmt(v) };
}
