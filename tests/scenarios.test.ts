import { describe, expect, it } from 'vitest';
import { buildSession, scenarioList } from '../src/scenarios/session.js';
import { generateScenario, SCENARIOS, S2_POLYLINE_TWO_PROBES, S1_DRIFT_NO_REPEAT, S3_ONE_PROBE_OFFSET, S4_CLEAN_LABEL_ERRORS, S5_REPEAT_MISSES_BAND, S6_REPEAT_DENIES } from '../src/scenarios/scenarios.js';
import { evaluateSurface } from '../src/core/surface.js';

describe('scenario generation', () => {
  it('produces reproducible files', () => {
    const a = generateScenario(S1_DRIFT_NO_REPEAT);
    const b = generateScenario(S1_DRIFT_NO_REPEAT);
    expect(a.file.records.length).toBe(b.file.records.length);
    expect(a.file.records[42].point).toEqual(b.file.records[42].point);
  });

  it('contains a displaced row in S1', () => {
    const bundle = generateScenario(S1_DRIFT_NO_REPEAT);
    const file = bundle.file;
    // row 8 of probe A = j = 8, all rows have nu records
    const probe = S1_DRIFT_NO_REPEAT.probes[0];
    const row8 = file.records.filter((r) => r.probeId === 'probe-A' && r.params && Math.abs(r.params[1] - (probe.grid.vMin + ((probe.grid.vMax - probe.grid.vMin) * 8) / (probe.grid.nv - 1))) < 1e-6);
    expect(row8.length).toBe(probe.grid.nu);
  });

  it('lists all scenarios', () => {
    expect(scenarioList().length).toBe(SCENARIOS.length);
  });
});

describe('session arbitration outcomes', () => {
  it('S1 without repeat stays unresolved and blocks machinable export', () => {
    const session = buildSession(S1_DRIFT_NO_REPEAT);
    expect(session.arbitration.hypothesis).toBe('unresolved');
    expect(session.arbitration.pendingRegion).not.toBeNull();
    expect(session.readiness.canExportMachinable).toBe(false);
  });

  it('S2 with two-probe agreement selects a design crease', () => {
    const session = buildSession(S2_POLYLINE_TWO_PROBES);
    expect(session.arbitration.repeat.reproduces).toBe(true);
    expect(session.arbitration.hypothesis).toBe('design-crease');
    expect(session.arbitration.chosen.creasePresent).toBe(true);
    expect(session.arbitration.chosen.template.failures).toBe(0);
  });

  it('S2 crease candidate passes the template while the smooth one does not', () => {
    const session = buildSession(S2_POLYLINE_TWO_PROBES);
    const smooth = session.arbitration.candidates.find((c) => c.id === 'smooth');
    expect(smooth).toBeDefined();
    expect(smooth!.template.failures).toBeGreaterThan(0);
  });
});

describe('scenario arbitration matches the documented expectation for every scenario', () => {
  for (const spec of SCENARIOS) {
    it(`${spec.id}: ${spec.expected.outcome}`, () => {
      const session = buildSession(spec);
      const a = session.arbitration;
      expect(a.hypothesis).toBe(spec.expected.hypothesis);
      expect(a.pendingRegion !== null).toBe(spec.expected.pendingRegion);
      if (spec.expected.pendingRegion) {
        expect(session.readiness.canExportMachinable).toBe(false);
      }
      // the chosen surface must always be materially better than the noise floor
      expect(a.chosen.rms).toBeLessThan(0.002);
    });
  }

  it('S3 lowers only probe-B when one probe is globally offset', () => {
    const session = buildSession(S3_ONE_PROBE_OFFSET);
    expect(session.arbitration.evidence.globalOffsetProbes).toEqual(['probe-B']);
    const chosen = session.arbitration.chosen;
    expect(chosen.probeFactors['probe-B']).toBeLessThan(0.5);
    expect(chosen.probeFactors['probe-A']).toBeGreaterThan(0.9);
  });

  it('S4 isolates bad labels rather than repairing them', () => {
    const session = buildSession(S4_CLEAN_LABEL_ERRORS);
    expect(session.validation.rejected.length).toBeGreaterThan(0);
    const kinds = new Set(session.validation.issues.map((i) => i.kind));
    expect(kinds.has('missing')).toBe(true);
    expect(kinds.has('duplicate')).toBe(true);
    // every accepted record keeps its own verified label
    for (const a of session.validation.accepted) {
      expect(a.record.probeId).not.toBe('');
    }
    expect(session.readiness.canExportMachinable).toBe(false);
  });

  it('S5 repeat exists but does not cover the band, so the pending region survives', () => {
    const session = buildSession(S5_REPEAT_MISSES_BAND);
    expect(session.repeatObservations.length).toBeGreaterThan(0);
    expect(session.arbitration.repeat.covers).toBe(false);
    expect(session.arbitration.repeat.reproduces).toBeNull();
    expect(session.arbitration.pendingRegion).not.toBeNull();
  });

  it('S6 repeat covers the band and denies the fold', () => {
    const session = buildSession(S6_REPEAT_DENIES);
    expect(session.arbitration.repeat.covers).toBe(true);
    expect(session.arbitration.repeat.reproduces).toBe(false);
    expect(session.arbitration.chosen.offsetProbes.length).toBe(0);
    // robust weighting is what suppresses the band, not deletion
    expect(session.arbitration.chosen.fit.rmsHoldout).toBeLessThan(0.002);
  });
});

describe('scenario sanity', () => {
  it('every scenario builds a session without throwing', () => {
    for (const spec of SCENARIOS) {
      const s = buildSession(spec);
      expect(s.observations.length).toBeGreaterThan(100);
      expect(Number.isFinite(s.arbitration.chosen.rms)).toBe(true);
      expect(s.arbitration.chosen.rms).toBeLessThan(0.005);
    }
  }, 30000);

  it('the design truth is reproduced by the crease candidate at the fold station', () => {
    const session = buildSession(S2_POLYLINE_TWO_PROBES);
    const lat = session.arbitration.chosen.fit.lattice;
    const foldV = 0.62;
    const before = evaluateSurface(lat, 0.5, foldV - 0.02).point;
    const after = evaluateSurface(lat, 0.5, foldV + 0.02).point;
    // the surface must turn at the fold: slope changes sign/magnitude across it
    const leftSlope = evaluateSurface(lat, 0.5, foldV - 0.01).point[2] - before[2];
    const rightSlope = after[2] - evaluateSurface(lat, 0.5, foldV + 0.01).point[2];
    expect(Math.abs(leftSlope - rightSlope)).toBeGreaterThan(1e-5);
  });
});
