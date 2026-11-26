/** Types for the design-observation fabrication (设计观测制作) subsystem.
 *
 *  Two independent roles are kept strictly apart:
 *    - the *fitter* sees only measurement observations (labels + points + noise),
 *    - the *assembler* sees only the fitted surface and the independent checking
 *      fixture (样板), never the truth surface and never the raw observations.
 *
 *  The truth surface is the design intent. It is saved with the package and used
 *  only by the verification/analysis code to score a reconstruction; it is never
 *  read by the fit. */

import type { Observation, TemplatePoint, Vec3 } from '../core/types.js';

export type FabricationMethod = 'analytic' | 'section';

/** Parameters of the analytic design truth.
 *
 *  Base:  z = twist·u·v + camberV·sin(πv)
 *  Ridge: a spanwise *tent* ridge, z += amp·envelope(u)·max(0, 1 − |v−ridgeV|/ridgeHalfWidthV)
 *
 *  The tent has a slope discontinuity (a C0 arris, 尖棱) exactly at v=ridgeV, so
 *  it is a sharp edge that a C0 crease reproduces exactly — but only if the edge
 *  itself was measured. `envelope(u)` switches the ridge on over a flat-top
 *  chordwise window [edgeU0, edgeU1] with smooth ramps, and splits it into a
 *  smaller leading-edge lobe and a larger trailing-edge lobe at `lobeSplit`. The
 *  crest is therefore a finite edge segment with two analysable lobes. */
export interface TruthSpec {
  id: string;
  /** twist coefficient, metres per unit u·v */
  twist: number;
  /** spanwise camber amplitude, metres */
  camberV: number;
  /** flat-top chordwise extent of the ridge */
  edgeU0: number;
  edgeU1: number;
  /** smoothstep ramp width outside the flat top */
  edgeRamp: number;
  /** spanwise station of the sharp edge */
  ridgeV: number;
  /** spanwise half-width of the tent, parameter units */
  ridgeHalfWidthV: number;
  /** crest height of the outboard (main) lobe, metres */
  ridgeAmp: number;
  /** chordwise split between the leading-edge (secondary) and trailing-edge
   *  (main) lobes of the ridge */
  lobeSplit: number;
  /** smoothstep blend half-width at the lobe split */
  lobeRamp: number;
  /** secondary-lobe height as a fraction of the main lobe, in [0,1] */
  secondaryRatio: number;
}

export type ObservationStatus = 'accepted' | 'outlier';

/** Reliability information carried alongside every fabricated measurement. */
export interface Reliability {
  /** stated 3-D measurement noise standard deviation, metres */
  sigma: number;
  /** confidence that the (u,v) label is the point actually measured */
  labelConfidence: number;
  /** ground-truth classification, used only for verification — the fitter does
   *  not read it; outlier handling is left to the robust kernel */
  status: ObservationStatus;
  /** free-form provenance note (probe, drift injection, ...) */
  note?: string;
}

export interface FabricatedObservation extends Observation {
  reliability: Reliability;
}

/** Independent checking fixture point: a design point with a tolerance and the
 *  design normal used to measure the assembly gap. */
export interface FixturePoint extends TemplatePoint {
  normal: Vec3;
  kind: 'background' | 'ridge';
  /** ridge segment this point belongs to (only for kind === 'ridge') */
  segmentId?: string;
}

/** A chordwise portion of the sharp ridge, used for per-segment mating coverage. */
export interface FixtureSegment {
  id: string;
  label: string;
  uRange: [number, number];
}

export interface FixtureLandmarks {
  ridgeV: number;
  ridgeHalfWidthV: number;
  edgeU0: number;
  edgeU1: number;
  segments: FixtureSegment[];
}

export interface Fixture {
  points: FixturePoint[];
  tolerance: number;
  landmarks: FixtureLandmarks;
}

// ---------------------------------------------------------------------------
// Sampling plan
// ---------------------------------------------------------------------------

export interface OutlierPlan {
  /** number of injected outliers */
  count: number;
  /** displacement along the surface normal, metres */
  magnitude: number;
  /** deterministic stride over the eligible observations */
  stride: number;
}

export interface SamplePoint {
  u: number;
  v: number;
}

export interface SamplePlan {
  id: string;
  label: string;
  /** explicit (u,v) list so points can be added only near the ridge */
  points: SamplePoint[];
  seed: number;
  noiseSigma: number;
  normalJitter: number;
  outlierPlan?: OutlierPlan;
}

// ---------------------------------------------------------------------------
// Fitting recipe (what the fitter is told; no truth, no fixture)
// ---------------------------------------------------------------------------

export interface FitRecipe {
  degreeU: number;
  degreeV: number;
  countU: number;
  countV: number;
  tensionWeight: number;
  blendWeight: number;
  priorWeight: number;
  robust: 'none' | 'huber' | 'tukey';
  normalWeight: number;
  useNormals: boolean;
  /** optional C0 crease baked into the v knots */
  crease: { axis: 'u' | 'v'; at: number } | null;
}

// ---------------------------------------------------------------------------
// Truth surface payload
// ---------------------------------------------------------------------------

export interface TruthGrid {
  nu: number;
  nv: number;
  points: Vec3[];
}

export interface TruthPayload {
  spec: TruthSpec;
  /** how the observations were fabricated from the truth */
  method: FabricationMethod;
  /** calibrated spanwise stations (only for the section method) */
  sectionStations: number[] | null;
  /** sampled design surface, saved with the package */
  grid: TruthGrid;
}

// ---------------------------------------------------------------------------
// Provenance & conventions
// ---------------------------------------------------------------------------

export interface Provenance {
  generator: string;
  generatorVersion: string;
  method: FabricationMethod;
  sectionStations: number[] | null;
  samplingTable: string;
  seed: number;
  noiseSigma: number;
  normalJitter: number;
  outlierCount: number;
  tolerance: number;
  truthSpecId: string;
  generatedAt: string;
  notes: string[];
}

export type EdgeAdvice = 'none' | 'add-measurement' | 'method-review';

export interface Conventions {
  /** in-sample residual RMS must not exceed this, metres */
  fitRmsMax: number;
  /** parameter-domain observation coverage (occupied bin fraction) minimum */
  coverageMin: number;
  /** overall mating coverage must be AT LEAST this; null = not gated */
  matingCoverageMin: number | null;
  /** overall mating coverage must be AT MOST this (records a demonstrated
   *  shortfall of a deliberately-sparse package); null = not gated */
  matingCoverageMax: number | null;
  /** every edge segment must be at least this; null = not gated */
  edgeCoverageMin: number | null;
  /** count of observations inside the sharp-edge band; null = unconstrained */
  ridgeBandObservations: { min?: number; max?: number } | null;
  /** whether a lost feature must be reported */
  expectLostFeature: boolean;
  /** max mating gap must be at least this, proving the crest was lost
   *  (metres); null = not gated */
  expectMaxGapMin: number | null;
  /** truth-error RMS inside the sharp-edge band must not exceed this, metres */
  truthErrorBandMax: number | null;
  /** which edge-measurement advice the analysis must produce */
  expectEdgeAdvice: EdgeAdvice | null;
  /** the fabrication method the package must declare */
  expectMethod: FabricationMethod | null;
}

export interface ConventionCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// Package
// ---------------------------------------------------------------------------

export interface FabricationMetadata {
  specimen: string;
  unit: string;
  uMeaning: string;
  vMeaning: string;
  operator: string;
}

export interface FabricationPackage {
  schemaVersion: string;
  id: string;
  title: string;
  createdAt: string;
  provenance: Provenance;
  truth: TruthPayload;
  fixture: Fixture;
  plan: SamplePlan;
  observations: FabricatedObservation[];
  recipe: FitRecipe;
  conventions: Conventions;
  metadata: FabricationMetadata;
}

// ---------------------------------------------------------------------------
// Analysis results (assembler + verification)
// ---------------------------------------------------------------------------

export interface SegmentCoverage {
  id: string;
  label: string;
  uRange: [number, number];
  total: number;
  engaged: number;
  coverage: number;
  maxGap: number;
}

export interface MatingReport {
  total: number;
  engaged: number;
  coverage: number;
  maxGap: number;
  rmsGap: number;
  /** signed gap extremes, metres */
  minSigned: number;
  maxSigned: number;
  segments: SegmentCoverage[];
  /** the ridge segment with the lowest mating coverage */
  worstSegment: SegmentCoverage | null;
}

export interface TruthErrorHotspot {
  u: number;
  v: number;
  meanError: number;
  maxError: number;
  /** observation density in the same cell, as a fraction of the densest cell */
  coverage: number;
}

export interface TruthErrorReport {
  rms: number;
  max: number;
  /** truth-error RMS inside the sharp-edge band */
  bandRms: number;
  bandMax: number;
  /** localized concentration of reconstruction error */
  hotspots: TruthErrorHotspot[];
}

export interface CoverageReport {
  occupancy: number;
  emptyBins: number;
  totalBins: number;
  bins: number;
  /** observations inside the sharp-edge band */
  ridgeBandCount: number;
}

export interface OutlierReport {
  injected: number;
  detectedIds: string[];
  /** mean robust weight actually applied to injected outliers */
  meanRobustWeight: number;
  downweighted: number;
}

export interface LostFeature {
  u: number;
  v: number;
  magnitude: number;
  coverage: number;
  /** sampling vs method explanation */
  reason: string;
  advice: EdgeAdvice;
}

export interface EdgeAdviceReport {
  segmentId: string | null;
  label: string;
  coverage: number;
  /** observation count in the segment's edge neighbourhood */
  observationDensity: number;
  advice: EdgeAdvice;
  detail: string;
}

export interface ReconstructionAnalysis {
  mating: MatingReport;
  truthError: TruthErrorReport;
  coverage: CoverageReport;
  outliers: OutlierReport;
  lostFeatures: LostFeature[];
  edgeAdvice: EdgeAdviceReport;
  /** global in-sample residual, metres */
  fitRms: number;
  fitRmsHoldout: number;
  controlPointCount: number;
  observationCount: number;
}

export interface ConventionsResult {
  ok: boolean;
  checks: ConventionCheck[];
}
