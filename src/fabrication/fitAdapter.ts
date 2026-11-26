/** Drive the existing fit kernel from a fabrication package.
 *
 *  The fitter reads ONLY the observations (label + point + normal) and the fit
 *  recipe. It never sees `provenance`, `truth`, `fixture` or any `reliability`
 *  field: outlier handling is left entirely to the robust kernel, and the truth
 *  surface is not available to it. This is what makes the reconstruction a genuine
 *  measurement fit rather than a copy of the truth control points. */

import { applyCrease, fitSurface } from '../core/fit.js';
import { uniformInterior } from '../core/bspline.js';
import { validateGeometry } from '../core/fit.js';
import type { FitResult, FittingSettings, Observation, SurfaceGeometryConfig } from '../core/types.js';
import type { FabricatedObservation, FitRecipe } from './types.js';

/** Strip everything except what the fitter is allowed to see. */
export function fitterObservations(observations: FabricatedObservation[]): Observation[] {
  return observations.map((o) => ({
    id: o.id,
    u: o.u,
    v: o.v,
    point: [o.point[0], o.point[1], o.point[2]],
    normal: o.normal ? [o.normal[0], o.normal[1], o.normal[2]] : undefined,
    probeId: o.probeId,
    passId: o.passId,
    side: o.side,
  }));
}

export function geometryFromRecipe(recipe: FitRecipe): SurfaceGeometryConfig {
  const geometry: SurfaceGeometryConfig = {
    degreeU: recipe.degreeU,
    degreeV: recipe.degreeV,
    countU: recipe.countU,
    countV: recipe.countV,
    interiorU: uniformInterior(recipe.countU, recipe.degreeU),
    interiorV: uniformInterior(recipe.countV, recipe.degreeV),
    uMin: 0,
    uMax: 1,
    vMin: 0,
    vMax: 1,
    tensionWeightU: recipe.tensionWeight,
    tensionWeightV: recipe.tensionWeight,
    blendWeightU: recipe.blendWeight,
    blendWeightV: recipe.blendWeight,
    priorWeight: recipe.priorWeight,
    dataWeight: 1,
    robustCutoff: 3.2,
    robustIterations: 8,
  };
  validateGeometry(geometry);
  return geometry;
}

export function settingsFromRecipe(recipe: FitRecipe): FittingSettings {
  let geometry = geometryFromRecipe(recipe);
  if (recipe.crease) {
    const applied = applyCrease(geometry, { enabled: true, direction: recipe.crease.axis, at: recipe.crease.at, hard: true });
    if (applied.applied) geometry = applied.geometry;
  }
  return {
    geometry,
    minWeight: 1e-6,
    useNormals: recipe.useNormals,
    normalWeight: recipe.normalWeight,
    crease: recipe.crease ? { enabled: true, direction: recipe.crease.axis, at: recipe.crease.at, hard: true } : null,
    robust: recipe.robust,
    offsetProbeWeight: 0.12,
    controlPointBoost: { u: 0, v: 0 },
  };
}

/** Deterministic every-Nth holdout so holdout RMS is available for verification
 *  without the fitter knowing which rows are special. */
export function everyNthHoldout(observations: Observation[], every = 7): string[] {
  const ids: string[] = [];
  observations.forEach((o, i) => {
    if ((i + 1) % every === 0) ids.push(o.id);
  });
  return ids;
}

export function fitFromPackage(observations: FabricatedObservation[], recipe: FitRecipe): FitResult {
  const obs = fitterObservations(observations);
  if (obs.length === 0) throw new Error('package contains no observations');
  return fitSurface({
    observations: obs,
    settings: settingsFromRecipe(recipe),
    holdoutIds: everyNthHoldout(obs),
  });
}
