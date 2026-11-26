/** Two sampling tables (采样表) for the same fixture.
 *
 *  Both tables share the identical non-uniform chordwise ladder. Their spanwise
 *  ladders differ ONLY inside the sharp-edge band:
 *
 *    - Table A (coarse): a uniform spanwise ladder whose nearest rows straddle
 *      the apex v=ridgeV without sampling it. The arris apex is never measured,
 *      so the reconstruction can only guess between the two flanking rows.
 *    - Table B (refined): the same ladder with extra rows inserted only inside
 *      the band, including an explicit apex row v=ridgeV.
 *
 *  Everything outside the band is identical, so any reconstruction difference is
 *  attributable to spanwise density at the sharp edge and nothing else. */

import type { SamplePlan, SamplePoint, TruthSpec } from './types.js';

/** Coarse spanwise rows used AWAY from the apex by both tables. A uniform 13-row
 *  ladder places 0.62 exactly between rows 0.58 and 0.66, so the apex is never
 *  sampled directly. */
export function coarseSpanwiseLadder(spec: TruthSpec): number[] {
  void spec;
  const vs: number[] = [];
  const n = 13;
  for (let j = 0; j < n; j++) vs.push(round6(0.02 + (0.96 * j) / (n - 1)));
  return vs;
}

/** Non-uniform chordwise ladder: denser toward both chordwise extremes (cosine
 *  clustering), identical for both tables. */
export function chordwiseLadder(): number[] {
  const us: number[] = [];
  const n = 17;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const u = 0.5 - 0.5 * Math.cos(Math.PI * t);
    us.push(round6(0.02 + 0.96 * u));
  }
  return us;
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** Spanwise rows for table B: coarse rows outside the band, a dense local ladder
 *  (including the exact apex) inside it. */
export function refinedSpanwiseLadder(spec: TruthSpec): number[] {
  const coarse = coarseSpanwiseLadder(spec);
  const lo = spec.ridgeV - 0.08;
  const hi = spec.ridgeV + 0.08;
  const outside = coarse.filter((v) => v < lo || v > hi);
  const local: number[] = [];
  const nLocal = 11;
  for (let j = 0; j < nLocal; j++) local.push(round6(lo + ((hi - lo) * j) / (nLocal - 1)));
  local.push(round6(spec.ridgeV));
  return [...outside, ...local].sort((a, b) => a - b);
}

/** Build the two sampling plans for a fixture. Same seed and noise settings; only
 *  spanwise density inside the sharp-edge band differs. */
export function buildSamplingTables(
  spec: TruthSpec,
  noiseSigma: number,
  normalJitter: number,
  seed: number,
): { coarse: SamplePlan; refined: SamplePlan } {
  const us = chordwiseLadder();
  const coarseVs = coarseSpanwiseLadder(spec);
  const refinedVs = refinedSpanwiseLadder(spec);

  const materials = (vs: number[]): SamplePoint[] => {
    const pts: SamplePoint[] = [];
    for (const v of vs) for (const u of us) pts.push({ u, v });
    return pts;
  };

  return {
    coarse: {
      id: 'table-A-coarse',
      label: '采样表 A · 尖棱处稀疏',
      points: materials(coarseVs),
      seed,
      noiseSigma,
      normalJitter,
      outlierPlan: { count: 4, magnitude: 0.0025, stride: 37 },
    },
    refined: {
      id: 'table-B-refined',
      label: '采样表 B · 尖棱处加密',
      points: materials(refinedVs),
      seed,
      noiseSigma,
      normalJitter,
      outlierPlan: { count: 4, magnitude: 0.0025, stride: 41 },
    },
  };
}

export function ridgeBandPointCount(plan: SamplePlan, spec: TruthSpec, halfWidth: number): number {
  return plan.points.filter((p) => Math.abs(p.v - spec.ridgeV) <= halfWidth).length;
}
