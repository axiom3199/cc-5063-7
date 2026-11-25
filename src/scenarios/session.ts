import type { Observation, ReadinessReport, SurfaceGeometryConfig, TemplatePoint } from '../core/types.js';
import { arbitrate, candidate, type ArbitrationResult, type RepeatProbeInput } from '../core/arbitration.js';
import { buildReadiness } from '../core/readiness.js';
import { defaultGeometry } from '../core/fit.js';
import { validateLabels } from './measurementFile.js';
import type { LabelValidation, MeasurementFile } from './measurementFile.js';
import { generateScenario, probesByRole, recordsToObservations, SCENARIOS } from './scenarios.js';
import type { ScenarioBundle, ScenarioSpec } from './scenarios.js';

export interface SessionOptions {
  /** override the base geometry */
  geometry?: SurfaceGeometryConfig;
  /** force these probe groups to be treated as globally offset */
  offsetProbes?: string[];
  /** manual weight overrides keyed by observation id */
  manualWeights?: Record<string, number>;
  /** which probe ids are fit data (override scenario defaults) */
  fitProbeIds?: string[];
}

export interface WorkbenchSession {
  bundle: ScenarioBundle;
  validation: LabelValidation;
  observations: Observation[];
  repeatObservations: Observation[];
  repeat: RepeatProbeInput;
  geometry: SurfaceGeometryConfig;
  template: TemplatePoint[];
  arbitration: ArbitrationResult;
  readiness: ReadinessReport;
  testSide: string;
  repeatSide: string;
}

export function geometryFor(_spec: ScenarioSpec): SurfaceGeometryConfig {
  // Degree 3 both ways, 8 × 9 control points: enough freedom for the wingtip while
  // keeping observations per free control point > 3 for a 255-point scan. Interior
  // knots are uniform; a crease candidate later replaces the v knot vector.
  return defaultGeometry({
    degreeU: 3,
    degreeV: 3,
    countU: 8,
    countV: 9,
    interiorU: uniform(8, 3),
    interiorV: uniform(9, 3),
    tensionWeightU: 0.015,
    tensionWeightV: 0.015,
    blendWeightU: 0.004,
    blendWeightV: 0.004,
    priorWeight: 0.0008,
    robustCutoff: 3.2,
    robustIterations: 8,
  });
}

function uniform(count: number, degree: number): number[] {
  const m = count - degree - 1;
  const out: number[] = [];
  for (let i = 1; i <= m; i++) out.push(i / (m + 1));
  return out;
}

export function buildSession(spec: ScenarioSpec, options: SessionOptions = {}): WorkbenchSession {
  const bundle = generateScenario(spec);
  return buildSessionFromBundle(spec, bundle, options);
}

export function buildSessionFromBundle(
  spec: ScenarioSpec,
  bundle: ScenarioBundle,
  options: SessionOptions = {},
): WorkbenchSession {
  return buildSessionFromFile(spec, bundle, bundle.file, options);
}

export function buildSessionFromFile(
  spec: ScenarioSpec,
  bundle: ScenarioBundle,
  file: MeasurementFile,
  options: SessionOptions = {},
): WorkbenchSession {
  const validation = validateLabels(file);
  const acceptedIndices = validation.accepted.map((a) => a.index);

  const fitProbeIds = new Set(options.fitProbeIds ?? probesByRole(spec, 'fit'));
  const observations = recordsToObservations(file, acceptedIndices, 'fit', spec.probes)
    .filter((o) => fitProbeIds.has(o.probeId))
    .map((o) =>
      options.manualWeights && options.manualWeights[o.id] !== undefined
        ? { ...o, manualWeight: options.manualWeights[o.id] }
        : o,
    );

  const repeatObservations = recordsToObservations(file, acceptedIndices, 'repeat-evidence', spec.probes);

  const testSide = spec.probes.find((p) => p.role === 'fit')?.side ?? 'upper';
  const repeatProbe = spec.probes.find((p) => p.role === 'repeat-evidence');
  const repeatSide = repeatProbe?.side ?? '';
  const repeatMode = repeatObservations.length === 0 ? 'none' : repeatSide === testSide ? 'same-side' : 'opposite-side';

  const repeat: RepeatProbeInput = {
    probeId: repeatProbe?.probeId ?? '',
    side: repeatSide,
    mode: repeatMode,
    observations: repeatObservations,
  };

  const geometry = options.geometry ?? geometryFor(spec);
  const template = bundle.template;

  let arbitration = arbitrate({
    observations,
    baseGeometry: geometry,
    template,
    settings: arbitrationSettings(),
    repeat,
  });

  if (options.offsetProbes && options.offsetProbes.length) {
    // Operator override: refit the chosen hypothesis with an explicit offset group.
    const chosen = arbitration.chosen;
    const refit = candidate('offset-override', `人工指定降权 ${options.offsetProbes.join(', ')}`, 'instrument-drift', {
      observations,
      baseGeometry: geometry,
      template,
      settings: arbitrationSettings(),
      repeat,
    }, {
      observations,
      offsetProbes: options.offsetProbes,
      crease: chosen.creaseLocation,
    });
    arbitration = {
      ...arbitration,
      chosen: refit,
      candidates: [...arbitration.candidates, refit],
      hypothesis: arbitration.repeat.reproduces === true ? 'design-crease' : 'instrument-drift',
    };
  }

  const readiness = buildReadiness({
    spec,
    validation,
    arbitration,
    hasRepeatForBand: arbitration.repeat.reproduces !== null,
    resolvedLabelIssues: validation.rejected.length === 0,
  });

  return {
    bundle,
    validation,
    observations,
    repeatObservations,
    repeat,
    geometry,
    template,
    arbitration,
    readiness,
    testSide,
    repeatSide,
  };
}

export function arbitrationSettings() {
  return {
    minWeight: 1e-6,
    normalWeight: 0.35,
    offsetProbeWeight: 0.12,
    controlPointBoost: { u: 2, v: 2 },
  };
}

export interface ScenarioListItem {
  id: string;
  title: string;
  description: string;
  expected: ScenarioSpec['expected'];
}

export function scenarioList(): ScenarioListItem[] {
  return SCENARIOS.map((s) => ({ id: s.id, title: s.title, description: s.description, expected: s.expected }));
}
