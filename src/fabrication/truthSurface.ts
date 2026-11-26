/** Design truth surface for the fabrication subsystem.
 *
 *  z(u,v) = twist·u·v + camberV·sin(πv) + ridge(u,v)
 *
 *  The ridge is a spanwise *tent* along v with its apex at v=ridgeV: a C0 arris
 *  (slope break) that is switched on only inside a flat-top chordwise window
 *  [edgeU0,edgeU1]. It is split into a leading-edge (secondary) lobe and a
 *  trailing-edge (main) lobe at `lobeSplit`, so the sharp edge is a *finite
 *  segment* with two lobes of different size. Because the arris is a tent, a C0
 *  crease placed exactly at ridgeV reproduces it *exactly* when the apex row was
 *  measured — and misses it when the apex fell between sample rows.
 *
 *  The same specimens can be produced two ways:
 *    - analytic: evaluate z(u,v) directly (apex is continuous in v),
 *    - section:  calibrated cross-sections sampled at fixed stations, each
 *                observation's height obtained by linear interpolation in v.
 *  Where the apex falls between two section stations the tent is chopped off by
 *  the interpolation; that is a methodology loss, distinct from sparse sampling. */

import type { Vec3 } from '../core/types.js';
import type { FabricationMethod, TruthSpec } from './types.js';

/** Default design truth: a shallow twisted, cambered panel with one spanwise
 *  sharp arris split into a small leading-edge lobe and a larger trailing-edge
 *  lobe. */
export const NOMINAL_TRUTH_SPEC: TruthSpec = {
  id: 'WT-07-design-v1',
  twist: -0.05,
  camberV: 0.06,
  edgeU0: 0.16,
  edgeU1: 0.88,
  edgeRamp: 0.06,
  ridgeV: 0.62,
  ridgeHalfWidthV: 0.05,
  ridgeAmp: 0.003,
  lobeSplit: 0.52,
  lobeRamp: 0.04,
  secondaryRatio: 0.4,
};

function smoothstep(e0: number, e1: number, x: number): number {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Chordwise envelope of the ridge: 1 on the flat top, smooth ramps to 0 outside. */
export function chordEnvelope(u: number, spec: TruthSpec): number {
  const rise = smoothstep(spec.edgeU0 - spec.edgeRamp, spec.edgeU0, u);
  const fall = 1 - smoothstep(spec.edgeU1, spec.edgeU1 + spec.edgeRamp, u);
  return rise * fall;
}

/** Lobe weights: secondary (leading-edge) lobe before the split, main after. */
export function lobeWeights(u: number, spec: TruthSpec): { secondary: number; main: number } {
  const t = smoothstep(spec.lobeSplit - spec.lobeRamp, spec.lobeSplit + spec.lobeRamp, u);
  return { secondary: (1 - t) * spec.secondaryRatio, main: t };
}

/** Height of the ridge alone (above the smooth base) at (u,v). */
export function ridgeHeight(u: number, v: number, spec: TruthSpec): number {
  const env = chordEnvelope(u, spec);
  const tent = Math.max(0, 1 - Math.abs(v - spec.ridgeV) / spec.ridgeHalfWidthV);
  const lobes = lobeWeights(u, spec);
  return spec.ridgeAmp * env * tent * (lobes.secondary + lobes.main);
}

/** Analytic design truth height in specimen coordinates. */
export function truthPoint(u: number, v: number, spec: TruthSpec): Vec3 {
  const base = spec.twist * u * v + spec.camberV * Math.sin(Math.PI * v);
  return [u, v, base + ridgeHeight(u, v, spec)];
}

/** Truth point reconstructed from calibrated cross-sections (section method).
 *  Each observation keeps its own (u,v) label but its height is interpolated
 *  linearly between the two adjacent calibrated stations, as a real
 *  section-assembled surface would be. */
export function sectionPoint(u: number, v: number, spec: TruthSpec, stations: number[]): Vec3 {
  const sorted = [...stations].sort((a, b) => a - b);
  if (sorted.length < 2) return truthPoint(u, v, spec);
  let k = 0;
  while (k < sorted.length - 1 && sorted[k + 1] < v) k++;
  const v0 = sorted[k];
  const v1 = sorted[Math.min(sorted.length - 1, k + 1)];
  const a = truthPoint(u, v0, spec);
  const b = truthPoint(u, v1, spec);
  if (v1 === v0) return a;
  const t = Math.max(0, Math.min(1, (v - v0) / (v1 - v0)));
  // interpolate height only; x,y stay the parameter labels so label semantics are
  // unchanged between the two methods
  const z = a[2] * (1 - t) + b[2] * t;
  return [u, v, z];
}

export function methodPoint(u: number, v: number, spec: TruthSpec, method: FabricationMethod, stations: number[] | null): Vec3 {
  return method === 'section' && stations && stations.length >= 2
    ? sectionPoint(u, v, spec, stations)
    : truthPoint(u, v, spec);
}

/** Unit normal of the design truth by central differences. One difference step
 *  is fine: the tent is piecewise linear in v, so away from the apex the normal
 *  is exact and at the apex it is the average of the two panels. */
export function truthNormal(u: number, v: number, spec: TruthSpec): Vec3 {
  const h = 1e-4;
  const du = normalize(sub(truthPoint(Math.min(1, u + h), v, spec), truthPoint(Math.max(0, u - h), v, spec)));
  const dv = normalize(sub(truthPoint(u, Math.min(1, v + h), spec), truthPoint(u, Math.max(0, v - h), spec)));
  let n = normalize(cross(du, dv));
  if (n[2] < 0) n = [-n[0], -n[1], -n[2]];
  return n;
}

/** Ridge half-width in v used to define the "sharp-edge band" for coverage and
 *  error reporting: the tent's own half-width, capped so it stays a thin strip. */
export function ridgeBandHalfWidth(spec: TruthSpec): number {
  return Math.min(0.09, Math.max(0.06, 1.2 * spec.ridgeHalfWidthV));
}

/** Chordwise lobes as analysable segments. */
export function ridgeSegments(spec: TruthSpec): { id: string; label: string; uRange: [number, number] }[] {
  const mid = spec.lobeSplit;
  return [
    { id: 'le-lobe', label: '前缘短棱', uRange: [spec.edgeU0, mid] },
    { id: 'te-lobe', label: '后缘长棱', uRange: [mid, spec.edgeU1] },
  ];
}

export function sampleTruthGrid(spec: TruthSpec, nu = 81, nv = 81): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i < nu; i++) {
    const u = i / (nu - 1);
    for (let j = 0; j < nv; j++) {
      const v = j / (nv - 1);
      points.push(truthPoint(u, v, spec));
    }
  }
  return points;
}

// --- tiny vector helpers (local, independent of the core surface module) ----

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
