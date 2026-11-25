import type { Vec3 } from '../core/types.js';

/** Analytic wingtip specimen used to generate measurement files with known truth.
 *  Parametrisation: u = chordwise (0 leading edge .. 1 trailing edge), v = spanwise
 *  (0 root station .. 1 tip station). The specimen is a thin shell; the upper and
 *  lower surfaces share a mid-line, so a real fold is visible on both sides at the
 *  same v. That is what lets a repeat scan of the other side corroborate a design
 *  polyline rather than an instrument artefact. */

export interface Fold {
  /** spanwise station of the fold */
  at: number;
  /** panel break angle in radians (positive = outboard panel bends down) */
  angle: number;
}

export interface WingtipTruth {
  camber: number;
  twist: number;
  thicknessRoot: number;
  thicknessTip: number;
  folds: Fold[];
}

export const NOMINAL_TRUTH: WingtipTruth = {
  camber: 0.06,
  twist: -0.05,
  thicknessRoot: 0.11,
  thicknessTip: 0.045,
  folds: [],
};

/** Mid-surface height, including all folds. Piecewise-smooth: each fold is a C0 kink. */
export function midHeight(u: number, v: number, truth: WingtipTruth): number {
  const camber = truth.camber * Math.sin(Math.PI * u) * (1 - 0.35 * v);
  const twist = truth.twist * u * v;
  let z = camber + twist;
  for (const f of truth.folds) {
    if (v > f.at) z -= Math.tan(f.angle) * (v - f.at);
  }
  return z;
}

export function halfThickness(u: number, v: number, truth: WingtipTruth): number {
  const t = truth.thicknessRoot + (truth.thicknessTip - truth.thicknessRoot) * v;
  const chordShape = Math.sin(Math.PI * Math.pow(u, 0.78));
  return 0.5 * t * chordShape;
}

/** side = +1 upper, -1 lower. */
export function wingPoint(u: number, v: number, side: number, truth: WingtipTruth): Vec3 {
  const z = midHeight(u, v, truth) + side * halfThickness(u, v, truth);
  // small lower-surface manufacturing asymmetry, kept smooth
  const asym = side < 0 ? -0.0015 * (1 - v) : 0;
  return [u, v, z + asym];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function unit(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** One-sided difference across each fold so the normal is not smeared by the kink. */
function panelBounds(v: number, truth: WingtipTruth): [number, number] {
  let lo = 0;
  let hi = 1;
  for (const f of truth.folds) {
    if (v > f.at + 1e-9) lo = Math.max(lo, f.at);
    else if (v < f.at - 1e-9) hi = Math.min(hi, f.at);
  }
  return [lo, hi];
}

export function wingNormal(u: number, v: number, side: number, truth: WingtipTruth): Vec3 {
  const h = 1e-6;
  const [vLo, vHi] = panelBounds(v, truth);
  const u0 = Math.max(0, u - h);
  const u1 = Math.min(1, u + h);
  const v0 = Math.max(vLo, v - h);
  const v1 = Math.min(vHi, v + h);
  const su = sub(wingPoint(u1, v, side, truth), wingPoint(u0, v, side, truth));
  const sv = sub(wingPoint(u, v1, side, truth), wingPoint(u, v0, side, truth));
  let n = unit(cross(su, sv));
  if (n[2] * side < 0) n = [-n[0], -n[1], -n[2]];
  return n;
}

export function cloneTruth(t: WingtipTruth): WingtipTruth {
  return { ...t, folds: t.folds.map((f) => ({ ...f })) };
}
