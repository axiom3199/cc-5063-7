import { basisDerivatives, basisValues, clampedKnots, findSpan, knotDomain } from './bspline.js';
import type { ControlLattice, SurfaceEvaluation, Vec3, SurfaceGeometryConfig } from './types.js';

export function latticeFromGeometry(
  geometry: SurfaceGeometryConfig,
  points: Vec3[],
): ControlLattice {
  const { countU, countV, degreeU, degreeV, interiorU, interiorV, uMin, uMax, vMin, vMax } = geometry;
  const knotsU = clampedKnots({ degree: degreeU, count: countU, interior: interiorU }, uMin, uMax);
  const knotsV = clampedKnots({ degree: degreeV, count: countV, interior: interiorV }, vMin, vMax);
  return {
    countU,
    countV,
    degreeU,
    degreeV,
    knotsU,
    knotsV,
    points,
    uMin,
    uMax,
    vMin,
    vMax,
  };
}

/** Evaluate position and first derivatives of the tensor-product surface. */
export function evaluateSurface(lat: ControlLattice, u: number, v: number): SurfaceEvaluation {
  const su = findSpan(lat.knotsU, lat.degreeU, u);
  const sv = findSpan(lat.knotsV, lat.degreeV, v);
  const dersU = basisDerivatives(lat.knotsU, lat.degreeU, su, u, 1);
  const dersV = basisDerivatives(lat.knotsV, lat.degreeV, sv, v, 1);

  const point: Vec3 = [0, 0, 0];
  const du: Vec3 = [0, 0, 0];
  const dv: Vec3 = [0, 0, 0];
  for (let a = 0; a <= lat.degreeU; a++) {
    const iu = su - lat.degreeU + a;
    for (let b = 0; b <= lat.degreeV; b++) {
      const iv = sv - lat.degreeV + b;
      const P = lat.points[iu * lat.countV + iv];
      const Nu = dersU[0][a];
      const Nv = dersV[0][b];
      const dNu = dersU[1][a];
      const dNv = dersV[1][b];
      for (let c = 0; c < 3; c++) {
        point[c] += Nu * Nv * P[c];
        du[c] += dNu * Nv * P[c];
        dv[c] += Nu * dNv * P[c];
      }
    }
  }
  return finishEvaluation(u, v, point, du, dv);
}

function finishEvaluation(u: number, v: number, point: Vec3, du: Vec3, dv: Vec3): SurfaceEvaluation {
  const n: Vec3 = cross(du, dv);
  const mag = Math.hypot(n[0], n[1], n[2]);
  const normal: Vec3 = mag > 1e-14 ? [n[0] / mag, n[1] / mag, n[2] / mag] : [0, 0, 1];
  return { u, v, point, du, dv, normal, jacobianNorm: mag };
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  return n > 1e-14 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 1];
}

export function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export interface SampleGrid {
  nu: number;
  nv: number;
  us: Float64Array;
  vs: Float64Array;
  points: Vec3[];
  normals: Vec3[];
  /** flag where the parameterization degenerates (zero Jacobian) */
  degenerate: boolean[];
}

export function sampleSurface(lat: ControlLattice, nu: number, nv: number, uMin?: number, uMax?: number, vMin?: number, vMax?: number): SampleGrid {
  const a = uMin ?? lat.uMin;
  const b = uMax ?? lat.uMax;
  const c = vMin ?? lat.vMin;
  const d = vMax ?? lat.vMax;
  const us = new Float64Array(nu);
  const vs = new Float64Array(nv);
  for (let i = 0; i < nu; i++) us[i] = a + ((b - a) * i) / (nu - 1);
  for (let j = 0; j < nv; j++) vs[j] = c + ((d - c) * j) / (nv - 1);
  const points: Vec3[] = [];
  const normals: Vec3[] = [];
  const degenerate: boolean[] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const e = evaluateSurface(lat, us[i], vs[j]);
      points.push(e.point);
      normals.push(e.normal);
      degenerate.push(e.jacobianNorm < 1e-10);
    }
  }
  return { nu, nv, us, vs, points, normals, degenerate };
}

/** Principal curvature estimates via finite differences of the first fundamental
 *  quantities. Returns max |curvature| and signed mean curvature on the grid. */
export function curvatureStats(lat: ControlLattice, nu = 48, nv = 48): { maxAbs: number; meanAbs: number } {
  let maxAbs = 0;
  let sumAbs = 0;
  let count = 0;
  const du = 1e-4;
  for (let i = 1; i < nu - 1; i++) {
    const u = lat.uMin + ((lat.uMax - lat.uMin) * i) / (nu - 1);
    for (let j = 1; j < nv - 1; j++) {
      const v = lat.vMin + ((lat.vMax - lat.vMin) * j) / (nv - 1);
      const e = evaluateSurface(lat, u, v);
      const hu = Math.min(du, (lat.uMax - lat.uMin) * 1e-3);
      const hv = Math.min(du, (lat.vMax - lat.vMin) * 1e-3);
      const eu = evaluateSurface(lat, clamp(u + hu, lat.uMin, lat.uMax), v);
      const ev = evaluateSurface(lat, u, clamp(v + hv, lat.vMin, lat.vMax));
      const duu = scale(subtract(eu.du, e.du), 1 / hu);
      const dvv = scale(subtract(ev.dv, e.dv), 1 / hv);
      // Second fundamental form via normal curvature of the two parameter lines
      const n = e.normal;
      const k1 = dot(duu, n) / Math.max(dot(e.du, e.du), 1e-20);
      const k2 = dot(dvv, n) / Math.max(dot(e.dv, e.dv), 1e-20);
      const k = Math.max(Math.abs(k1), Math.abs(k2));
      maxAbs = Math.max(maxAbs, k);
      sumAbs += k;
      count++;
    }
  }
  return { maxAbs, meanAbs: count ? sumAbs / count : 0 };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Parameter-domain coverage: fraction of a bins x bins grid containing observations. */
export function coverageGrid(
  us: number[],
  vs: number[],
  uMin: number,
  uMax: number,
  vMin: number,
  vMax: number,
  bins = 8,
): { emptyBins: { u: number; v: number }[]; totalBins: number; occupancy: number } {
  const counts = new Float64Array(bins * bins);
  for (let k = 0; k < us.length; k++) {
    let iu = Math.floor(((us[k] - uMin) / (uMax - uMin)) * bins);
    let iv = Math.floor(((vs[k] - vMin) / (vMax - vMin)) * bins);
    iu = Math.min(bins - 1, Math.max(0, iu));
    iv = Math.min(bins - 1, Math.max(0, iv));
    counts[iu * bins + iv]++;
  }
  const emptyBins: { u: number; v: number }[] = [];
  let occupied = 0;
  for (let i = 0; i < bins; i++) {
    for (let j = 0; j < bins; j++) {
      if (counts[i * bins + j] === 0) {
        emptyBins.push({
          u: i + 0.5,
          v: j + 0.5,
        });
      } else occupied++;
    }
  }
  return { emptyBins, totalBins: bins * bins, occupancy: occupied / (bins * bins) };
}
