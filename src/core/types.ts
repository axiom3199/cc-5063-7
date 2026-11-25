/** Core data model for the surface-fitting workbench. */

export type Vec3 = [number, number, number];

export interface SurfaceGeometryConfig {
  /** B-spline degrees in u and v. Degree 3 with duplicated interior knots gives C0 creases. */
  degreeU: number;
  degreeV: number;
  /** number of control points in u and v */
  countU: number;
  countV: number;
  /** interior knot values (non-decreasing; repeats lower continuity).
   *  Each axis uses exactly count - degree - 1 interior knot entries. */
  interiorU: number[];
  interiorV: number[];
  /** parameterization domain, fixed from the verified input labels */
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  /** tensile (stretching) weight for the discrete fairness functional, per axis */
  tensionWeightU: number;
  tensionWeightV: number;
  /** blend (curvature) weight for the discrete fairness functional, per axis */
  blendWeightU: number;
  blendWeightV: number;
  /** external smoothness prior toward the initial bilinear lattice, suppresses
   *  unobserved-region drift */
  priorWeight: number;
  /** data weight multiplier; robust and probe weights multiply into it */
  dataWeight: number;
  /** Tukey/Huber cutoff in normalized residual units */
  robustCutoff: number;
  /** iterations of IRLS reweighting; 0 disables robustness */
  robustIterations: number;
}

export interface Observation {
  id: string;
  /** parameter labels supplied with the measurement, already verified to lie in domain */
  u: number;
  v: number;
  /** measured point in specimen coordinates */
  point: Vec3;
  /** optional normal direction; sign unified upstream, never trusted blindly */
  normal?: Vec3;
  /** probe head / setup that produced this observation */
  probeId: string;
  /** nominal measurement pass ("first", "repeat", ...) */
  passId: string;
  /** surface side this observation belongs to */
  side?: string;
  /** manual weight (0 excludes) supplied by the metrologist */
  manualWeight?: number;
}

export interface FittingSettings {
  geometry: SurfaceGeometryConfig;
  /** floor on robust weights, keeps a group from being fully deleted */
  minWeight: number;
  /** include the normal-direction soft constraint */
  useNormals: boolean;
  /** normal constraint weight relative to position residuals */
  normalWeight: number;
  /** crease hypothesis applied to the knot structure */
  crease: CreaseHypothesis | null;
  /** robust reweighting variant */
  robust: RobustMode;
  /** weight applied to a probe group flagged as globally offset */
  offsetProbeWeight: number;
  /** additional control points added on top of the base lattice, for
   *  complexity-vs-outlier-weighting comparisons */
  controlPointBoost: { u: number; v: number };
}

export type RobustMode = 'none' | 'tukey' | 'huber';

export interface CreaseHypothesis {
  enabled: boolean;
  /** axis the crease line runs along: 'v' means the crease is at constant u */
  direction: 'u' | 'v';
  /** parameter value of the crease */
  at: number;
  /** if false the crease hypothesis is reported but not baked into knots */
  hard: boolean;
}

export interface FitRequest {
  observations: Observation[];
  settings: FittingSettings;
  /** probe groups whose observations have a mean systematic offset */
  offsetProbes?: string[];
  /** explicit per-probe group weight (multiplies into the base weight) */
  probeWeights?: Record<string, number>;
  /** pinned control points supplied by the user; missing entries are solved for.
   *  Indexed [iU*countV + iV], each a Vec3. */
  pinnedControlPoints?: Record<number, Vec3>;
  /** subset of observation ids treated as held-out for generalization checks */
  holdoutIds?: string[];
}

export interface ControlLattice {
  countU: number;
  countV: number;
  degreeU: number;
  degreeV: number;
  knotsU: Float64Array;
  knotsV: Float64Array;
  /** flat [iU*countV + iV] -> point */
  points: Vec3[];
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

export interface SurfaceEvaluation {
  u: number;
  v: number;
  point: Vec3;
  du: Vec3;
  dv: Vec3;
  normal: Vec3;
  /** unnormalized normal magnitude, for degenerate detection */
  jacobianNorm: number;
}

export interface ObservationResidual {
  id: string;
  probeId: string;
  passId: string;
  u: number;
  v: number;
  /** signed distance along the local surface normal */
  normalResidual: number;
  /** total Euclidean distance */
  distance: number;
  /** residual components in specimen axes */
  vector: Vec3;
  /** final weight after robust/probe/manual factors */
  weight: number;
  /** robust factor alone, in [0,1] */
  robustWeight: number;
  /** leverage-like influence proxy */
  influence: number;
  isHoldout: boolean;
  isOutlierCandidate: boolean;
}

export interface WeightRule {
  observationId: string;
  probeId: string;
  manualWeight: number;
  probeFactor: number;
  baseWeight: number;
  excluded: boolean;
}

export interface WeightBin {
  bin: number;
  count: number;
  label: string;
}

export interface FitDiagnostics {
  observationCount: number;
  freeControlPoints: number;
  pinnedControlPoints: number;
  /** nominal observation degrees of freedom */
  dofObservation: number;
  /** observations per free control point */
  dataPerUnknown: number;
  rankDeficiency: number;
  conditionRatio: number;
  minPivot: number;
  regularized: number;
  /** parameter-domain sample density; empty bins signal extrapolation risk */
  coverage: {
    emptyBins: { u: number; v: number }[];
    totalBins: number;
    occupancy: number;
  };
  normalWarnings: string[];
  weightHistogram: WeightBin[];
  probeSummary: ProbeWeightSummary[];
  identifiabilityWarnings: string[];
  /** rank of the normal soft-constraint block */
  normalConstraintRank: number;
  normalConstraintNullDimension: number;
  /** normals flipped to agree with the parameterization */
  normalSignFlips: number;
}

export interface ProbeWeightSummary {
  probeId: string;
  observationCount: number;
  meanResidual: number;
  rmsResidual: number;
  /** signed mean of the normal residual; a coherent sign across all rows means drift */
  meanSignedResidual: number;
  effectiveWeight: number;
  flaggedOffset: boolean;
  isRepeat: boolean;
}

export interface FairnessEvidence {
  tension: number;
  blend: number;
  maxCurvature: number;
  controlPointCount: number;
  creases: { direction: 'u' | 'v'; at: number; continuity: number }[];
  /** geometric interpretation for the evidence panel */
  knotInformation: { u: string; v: string };
}

export interface FitResult {
  lattice: ControlLattice;
  settings: FittingSettings;
  observations: Observation[];
  residuals: ObservationResidual[];
  diagnostics: FitDiagnostics;
  fairness: FairnessEvidence;
  weights: Float64Array;
  robustIterations: number;
  rms: number;
  rmsFit: number;
  rmsHoldout: number;
  maxNormalError: number;
  meanNormalError: number;
  objective: { data: number; tension: number; blend: number; prior: number };
  warnings: string[];
  /** the exact weight rule used per observation, for audit */
  weightRules: WeightRule[];
  probeFactors: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Hypothesis arbitration
// ---------------------------------------------------------------------------

export type HypothesisKind = 'instrument-drift' | 'design-crease' | 'both' | 'unresolved';

export interface HypothesisScore {
  kind: HypothesisKind;
  /** per-candidate fit metrics at matched complexity */
  candidate: {
    controlPoints: number;
    rms: number;
    rmsHoldout: number;
    blend: number;
    maxCurvature: number;
    creasePresent: boolean;
    creaseLocation: { axis: 'u' | 'v'; at: number } | null;
    offsetProbeWeighting: Record<string, number>;
  };
  /** deviation evidence */
  deviationRows: number;
  /** sign of the normal residual: coherent across the row => drift-like */
  rowSignCoherence: number;
  /** does the repeat (other-side or same-side) reproduce the deviation? */
  repeatReproduces: boolean | null;
  repeatProbeIds: string[];
  /** per-probe signed mean normal residual, computed on the deviation band only */
  probeBandSignedMeans: Record<string, number>;
  /** template outcome for this hypothesis */
  templatePassRate: number;
  templateMinMargin: number;
  recommended: boolean;
  rationale: string[];
}

export interface TemplatePoint {
  u: number;
  v: number;
  point: Vec3;
  tolerance: number;
  side?: string;
}

export interface TemplateCheck {
  templateId: string;
  passRate: number;
  minMargin: number;
  failures: number;
  /** signed distance at each template point, for the report */
  signedDistances: { u: number; v: number; signed: number; tolerance: number }[];
}

export type ReadinessState =
  | 'blocked-labels'
  | 'blocked-missing-repeat'
  | 'blocked-unresolved-hypothesis'
  | 'blocked-template-failure'
  | 'blocked-diagnostic'
  | 'ready-for-review'
  | 'released';

export interface ReadinessReport {
  state: ReadinessState;
  reasons: string[];
  canExportMachinable: boolean;
  /** parameter region whose status is still pending confirmation */
  pendingRegion: { uRange: [number, number]; vRange: [number, number]; reason: string } | null;
  checks: { id: string; label: string; ok: boolean; detail: string }[];
}

/** editable surface export: control lattice + evaluated samples */
export interface SurfaceExport {
  lattice: {
    countU: number;
    countV: number;
    degreeU: number;
    degreeV: number;
    knotsU: number[];
    knotsV: number[];
    points: Vec3[];
    uMin: number;
    uMax: number;
    vMin: number;
    vMax: number;
  };
  samples: { nu: number; nv: number; points: Vec3[]; normals: Vec3[] };
  metadata: {
    rms: number;
    controlPointCount: number;
    maxCurvature: number;
    blend: number;
    status: ReadinessState;
    generatedAt: string;
    pendingRegion: ReadinessReport['pendingRegion'];
  };
}
