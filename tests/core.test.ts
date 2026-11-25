import { describe, expect, it } from 'vitest';
import { basisDerivatives, basisValues, clampedKnots, findSpan, partitionOfUnityCheck, uniformInterior } from '../src/core/bspline.js';
import { conditioning, solveSPD, zeros, add } from '../src/core/linalg.js';
import { evaluateSurface, latticeFromGeometry, sampleSurface } from '../src/core/surface.js';
import { defaultGeometry, fitSurface, knotsWithCrease, applyCrease } from '../src/core/fit.js';
import type { Observation, Vec3 } from '../src/core/types.js';

function analytic(u: number, v: number): Vec3 {
  // a smooth non-planar reference patch
  return [u, v, 0.25 * Math.sin(Math.PI * u) * Math.cos(0.5 * Math.PI * v) + 0.1 * u * v];
}

/** Sample an analytic function onto a dense observation set with exact labels. */
function observationsFromAnalytic(nu = 15, nv = 13, noise = 0, seed = 7): Observation[] {
  const out: Observation[] = [];
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296 - 0.5;
  };
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const u = i / (nu - 1);
      const v = j / (nv - 1);
      const p = analytic(u, v);
      out.push({
        id: `o${i}_${j}`,
        u,
        v,
        point: [p[0] + noise * rand(), p[1] + noise * rand(), p[2] + noise * rand()],
        probeId: 'p1',
        passId: 'first',
      });
    }
  }
  return out;
}

describe('B-spline basis', () => {
  it('partitions unity across the domain', () => {
    const knots = clampedKnots({ degree: 3, count: 7, interior: uniformInterior(7, 3) }, 0, 1);
    for (let t = 0; t <= 1; t += 0.017) expect(partitionOfUnityCheck(knots, 3, t)).toBeCloseTo(1, 12);
  });

  it('derivative matches finite differences', () => {
    const knots = clampedKnots({ degree: 3, count: 7, interior: uniformInterior(7, 3) }, 0, 1);
    const u = 0.427;
    const span = findSpan(knots, 3, u);
    const d = basisDerivatives(knots, 3, span, u, 1)[1];
    const h = 1e-7;
    const sp = findSpan(knots, 3, u + h);
    const sm = findSpan(knots, 3, u - h);
    const bp = basisValues(knots, 3, sp, u + h);
    const bm = basisValues(knots, 3, sm, u - h);
    for (let a = 0; a <= 3; a++) {
      const iP = sp - 3 + a;
      const iM = sm - 3 + a;
      const idx = span - 3 + a;
      const fd = ((iP === idx ? bp[a] : 0) - (iM === idx ? bm[a] : 0)) / (2 * h);
      expect(d[a]).toBeCloseTo(fd, 5);
    }
  });
});

describe('linear algebra', () => {
  it('solves an SPD system', () => {
    const A = zeros(3, 3);
    const vals = [
      [4, 1, 0],
      [1, 3, 1],
      [0, 1, 2],
    ];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) add(A, i, j, vals[i][j]);
    const b = new Float64Array([1, 2, 3]);
    const { x } = solveSPD(A, b);
    for (let i = 0; i < 3; i++) {
      let s = 0;
      for (let j = 0; j < 3; j++) s += vals[i][j] * x[j];
      expect(s).toBeCloseTo(b[i], 10);
    }
  });

  it('reports conditioning', () => {
    const A = zeros(2, 2);
    add(A, 0, 0, 1);
    add(A, 1, 1, 1e-6);
    const c = conditioning(A);
    expect(c.ratio).toBeLessThan(1e-5);
    expect(c.rank).toBe(2);
  });
});

describe('surface evaluation', () => {
  it('produces a normal orthogonal to both tangents', () => {
    const geom = defaultGeometry();
    const lat = latticeFromGeometry(
      geom,
      Array.from({ length: geom.countU * geom.countV }, (_, k) => {
        const i = Math.floor(k / geom.countV);
        const j = k % geom.countV;
        return analytic(i / (geom.countU - 1), j / (geom.countV - 1));
      }),
    );
    const e = evaluateSurface(lat, 0.3, 0.6);
    const d1 = e.du[0] * e.normal[0] + e.du[1] * e.normal[1] + e.du[2] * e.normal[2];
    const d2 = e.dv[0] * e.normal[0] + e.dv[1] * e.normal[1] + e.dv[2] * e.normal[2];
    expect(Math.abs(d1)).toBeLessThan(1e-12);
    expect(Math.abs(d2)).toBeLessThan(1e-12);
  });
});

describe('surface fitting', () => {
  it('recovers a smooth analytic patch from dense exact samples', () => {
    const geom = defaultGeometry({ tensionWeightU: 0, tensionWeightV: 0, blendWeightU: 0, blendWeightV: 0, priorWeight: 0 });
    const obs = observationsFromAnalytic(15, 13, 0);
    const result = fitSurface({
      observations: obs,
      settings: { geometry: geom, minWeight: 1e-6, useNormals: false, normalWeight: 1, crease: null, robust: 'none', offsetProbeWeight: 0.05, controlPointBoost: { u: 0, v: 0 } },
    });
    expect(result.rms).toBeLessThan(5e-3);
    // check at interior points not on the sample grid
    for (const [u, v] of [[0.413, 0.337], [0.77, 0.61], [0.11, 0.88]] as [number, number][]) {
      const e = evaluateSurface(result.lattice, u, v);
      const truth = analytic(u, v);
      const err = Math.hypot(e.point[0] - truth[0], e.point[1] - truth[1], e.point[2] - truth[2]);
      expect(err).toBeLessThan(2e-3);
    }
  });

  it('is invariant to uniform weighting when there is no fairing or prior', () => {
    const geom = defaultGeometry({
      tensionWeightU: 0, tensionWeightV: 0, blendWeightU: 0, blendWeightV: 0, priorWeight: 0,
    });
    const obs = observationsFromAnalytic(11, 9, 0.002);
    const mk = (w: number) =>
      fitSurface({
        observations: obs.map((o) => ({ ...o, manualWeight: w })),
        settings: { geometry: geom, minWeight: 1e-6, useNormals: false, normalWeight: 1, crease: null, robust: 'none', offsetProbeWeight: 0.05, controlPointBoost: { u: 0, v: 0 } },
      });
    const a = mk(1);
    const b = mk(0.25);
    expect(a.rms).toBeCloseTo(b.rms, 8);
    expect(a.lattice.points[12][2]).toBeCloseTo(b.lattice.points[12][2], 8);
  });

  it('robust reweighting never inflates error on clean, well-fit data', () => {
    // Regression: Tukey IRLS used to cascade on a coherently misfit boundary and
    // delete clean rows, turning a 0.5 mm noise floor into >10 mm residuals. Huber
    // is monotone and must stay at the noise floor regardless of iteration count.
    const geom = defaultGeometry();
    const obs = observationsFromAnalytic(15, 13, 0.0004, 99);
    const run = (robust: 'none' | 'huber' | 'tukey') =>
      fitSurface({
        observations: obs,
        settings: { geometry: geom, minWeight: 1e-6, useNormals: false, normalWeight: 1, crease: null, robust, offsetProbeWeight: 0.05, controlPointBoost: { u: 0, v: 0 } },
      });
    const plain = run('none');
    const huber = run('huber');
    const tukey = run('tukey');
    // Huber stays close to the unweighted solution
    expect(huber.rms).toBeLessThan(plain.rms * 1.6);
    expect(Math.max(...huber.residuals.map((r) => r.distance))).toBeLessThan(0.01);
    // and never deletes observations outright
    expect(huber.residuals.filter((r) => r.weight < 1e-9).length).toBe(0);
    // Tukey's redescending weights are documented as unstable on this data
    expect(tukey.rms).toBeGreaterThan(huber.rms);
  });
});

describe('crease geometry', () => {
  it('builds a C0 crease with unchanged control point count', () => {
    const geom = defaultGeometry();
    const knots = knotsWithCrease(geom, 'v', 0.5);
    expect(knots.length).toBe(geom.countV - geom.degreeV - 1);
    expect(knots.filter((k) => Math.abs(k - 0.5) < 1e-12).length).toBe(3);
    const applied = applyCrease(geom, { enabled: true, direction: 'v', at: 0.5, hard: true });
    expect(applied.applied).toBe(true);
    expect(applied.geometry.countV).toBe(geom.countV);
  });

  it('rejects a crease outside the domain', () => {
    const geom = defaultGeometry();
    const applied = applyCrease(geom, { enabled: true, direction: 'v', at: 1.2, hard: true });
    expect(applied.applied).toBe(false);
  });
});
