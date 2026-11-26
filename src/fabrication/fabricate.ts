/** Fabricate measurement observations from a truth surface and a sampling plan.
 *
 *  Each record carries:
 *    - the verified (u,v) label, with a label confidence,
 *    - the measured point (method-dependent), with isotropic 3-D noise,
 *    - a measured normal, with angular jitter,
 *    - reliability metadata: stated sigma, label confidence, outlier status.
 *
 *  Outliers are injected deterministically along the surface normal by a fixed
 *  stride, so the exact same records are produced on every run. Their `status`
 *  is recorded for verification only; the fitter never reads it and must reject
 *  them with its robust kernel. */

import { mulberry32, gaussian } from '../scenarios/scenarios.js';
import type { Vec3 } from '../core/types.js';
import { methodPoint, truthNormal } from './truthSurface.js';
import type { FabricatedObservation, SamplePlan, TruthSpec } from './types.js';

export interface FabricationConfig {
  spec: TruthSpec;
  method: 'analytic' | 'section';
  sectionStations: number[] | null;
  labelConfidence: number;
}

export function fabricateObservations(plan: SamplePlan, config: FabricationConfig): FabricatedObservation[] {
  const rng = mulberry32(plan.seed);
  const s3 = plan.noiseSigma / Math.sqrt(3);
  const outlierPlan = plan.outlierPlan;
  const outlierIndices = chooseOutlierIndices(plan, outlierPlan);
  const observations: FabricatedObservation[] = [];

  plan.points.forEach((pt, index) => {
    const { u, v } = pt;
    const base = methodPoint(u, v, config.spec, config.method, config.sectionStations);
    // the section truth shares the analytic (u,v) parametrisation and only shifts
    // the height, so the analytic normal is a faithful direction for both methods
    const oriented = truthNormal(u, v, config.spec);

    const s3x = s3 * gaussian(rng);
    const s3y = s3 * gaussian(rng);
    const s3z = s3 * gaussian(rng);
    let point: Vec3 = [base[0] + s3x, base[1] + s3y, base[2] + s3z];

    const nJ = plan.normalJitter;
    const measuredNormal: Vec3 = [
      oriented[0] + nJ * gaussian(rng),
      oriented[1] + nJ * gaussian(rng),
      oriented[2] + nJ * gaussian(rng),
    ];

    const isOutlier = outlierPlan ? outlierIndices.has(index) : false;
    if (isOutlier && outlierPlan) {
      const m = outlierPlan.magnitude;
      point = [point[0] + oriented[0] * m, point[1] + oriented[1] * m, point[2] + oriented[2] * m];
    }

    observations.push({
      id: `${plan.id}-${String(index).padStart(4, '0')}`,
      u,
      v,
      point,
      normal: measuredNormal,
      probeId: 'probe-A',
      passId: 'first',
      side: 'upper',
      reliability: {
        sigma: plan.noiseSigma,
        labelConfidence: config.labelConfidence,
        status: isOutlier ? 'outlier' : 'accepted',
        note: isOutlier ? `注入离群：沿法向 +${(outlierPlan!.magnitude * 1000).toFixed(2)} mm` : undefined,
      },
    });
  });

  return observations;
}

/** Deterministic, evenly-strided outlier selection, separate from noise draws so
 *  the outlier positions do not perturb the gaussian stream. */
function chooseOutlierIndices(plan: SamplePlan, outlierPlan: SamplePlan['outlierPlan']): Set<number> {
  const out = new Set<number>();
  if (!outlierPlan || outlierPlan.count <= 0) return out;
  const n = plan.points.length;
  const stride = Math.max(1, outlierPlan.stride);
  let idx = Math.floor(stride / 2);
  while (out.size < outlierPlan.count && idx < n) {
    out.add(idx);
    idx += stride;
  }
  return out;
}
