/** The independent checking fixture (独立样板).
 *
 *  The fixture is a separate design-controlled plate that a fitted surface must
 *  mate with. It is built from the design intent, NOT from the observations, so
 *  it can catch a surface that agrees with its own points but departs from the
 *  design. It carries:
 *    - background points on a coarse design grid,
 *    - dense points along the sharp ridge, grouped into per-lobe segments,
 *    - the design normal at every point (for the assembly gap),
 *    - a tolerance and the ridge landmarks (station, chordwise extents).
 *
 *  The assembler reads only the fitted surface and this fixture. */

import { chordEnvelope, ridgeBandHalfWidth, ridgeSegments, truthNormal, truthPoint } from './truthSurface.js';
import type { Fixture, FixturePoint, FixtureSegment, TruthSpec } from './types.js';

export function buildFixture(spec: TruthSpec, tolerance: number): Fixture {
  const points: FixturePoint[] = [];

  // background: coarse chordwise x moderately dense spanwise design grid, so the
  // crest region is bracketed on both sides and the panel shape is pinned
  const nuBg = 11;
  const nvBg = 21;
  for (let i = 0; i < nuBg; i++) {
    const u = i / (nuBg - 1);
    for (let j = 0; j < nvBg; j++) {
      const v = j / (nvBg - 1);
      points.push({
        u,
        v,
        point: truthPoint(u, v, spec),
        normal: truthNormal(u, v, spec),
        tolerance,
        kind: 'background',
      });
    }
  }

  // ridge: dense in v across the crest, restricted to the chordwise envelope,
  // split into lobe segments. The apex row v=ridgeV is always present so the
  // fixture pins the arris exactly.
  const segments = ridgeSegments(spec);
  const halfW = ridgeBandHalfWidth(spec);
  const ridgeVs: number[] = [];
  const nvRidge = 13;
  for (let j = 0; j < nvRidge; j++) ridgeVs.push(spec.ridgeV - halfW + ((2 * halfW) * j) / (nvRidge - 1));
  ridgeVs.push(spec.ridgeV);
  ridgeVs.sort((a, b) => a - b);
  const nuRidge = 41;
  for (const seg of segments) {
    for (let i = 0; i < nuRidge; i++) {
      const u = seg.uRange[0] + ((seg.uRange[1] - seg.uRange[0]) * i) / (nuRidge - 1);
      if (chordEnvelope(u, spec) < 0.35) continue;
      for (const rawV of ridgeVs) {
        const v = Math.max(0, Math.min(1, rawV));
        points.push({
          u,
          v,
          point: truthPoint(u, v, spec),
          normal: truthNormal(u, v, spec),
          tolerance,
          kind: 'ridge',
          segmentId: seg.id,
        });
      }
    }
  }

  const fixturesSegments: FixtureSegment[] = segments.map((s) => ({ ...s, uRange: [...s.uRange] as [number, number] }));

  return {
    points,
    tolerance,
    landmarks: {
      ridgeV: spec.ridgeV,
      ridgeHalfWidthV: spec.ridgeHalfWidthV,
      edgeU0: spec.edgeU0,
      edgeU1: spec.edgeU1,
      segments: fixturesSegments,
    },
  };
}

/** Fixture points whose chordwise position falls in a lobe segment. */
export function fixturePointsForSegment(fixture: Fixture, segmentId: string): FixturePoint[] {
  return fixture.points.filter((p) => p.kind === 'ridge' && p.segmentId === segmentId);
}

export function fixtureBounds(fixture: Fixture): { u: [number, number]; v: [number, number] } {
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of fixture.points) {
    u0 = Math.min(u0, p.u);
    u1 = Math.max(u1, p.u);
    v0 = Math.min(v0, p.v);
    v1 = Math.max(v1, p.v);
  }
  return { u: [u0, u1], v: [v0, v1] };
}

export function segmentPointCount(fixture: Fixture, segmentId: string): number {
  return fixture.points.filter((p) => p.kind === 'ridge' && p.segmentId === segmentId).length;
}

/** Distance from a point to a segment's chordwise range, used to decide which
 *  edge a candidate measurement would strengthen. */
export function segmentDeltaU(segment: FixtureSegment, u: number): number {
  if (u < segment.uRange[0]) return segment.uRange[0] - u;
  if (u > segment.uRange[1]) return u - segment.uRange[1];
  return 0;
}

/** Design height above the smooth base along the crest at a given u. */
export function crestHeightAt(u: number, spec: TruthSpec): number {
  const base = spec.twist * u * spec.ridgeV + spec.camberV * Math.sin(Math.PI * spec.ridgeV);
  return truthPoint(u, spec.ridgeV, spec)[2] - base;
}
