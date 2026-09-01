/**
 * Multi-source feedback driven Bayesian incremental adaptive calibration —
 * Algorithm III.
 *
 * ## Model: normal-normal conjugacy (Kalman-style incremental update)
 *
 *  1. Personalized final recommendation
 *
 *         Quota_t^rec = c_t × Quota_t^base        r_rec = c_t × r_base
 *
 *  2. Feedback quantification → observation
 *
 *         θ_t = Q_actual / Quota_rec               y_t = θ_t × (1 − λ·F_t)
 *
 *  3. Posterior incremental update
 *
 *         c_t ~ N(m_t, s_t²)          likelihood y_t | c_t ~ N(c_t, τ_t²)
 *
 *         K_t      = s_t² / (s_t² + τ_t²)         (Kalman gain)
 *         m_{t+1}  = m_t + K_t·(y_t − m_t)         (posterior mean)
 *         s²_{t+1} = (1 − K_t)·s_t²                (posterior variance)
 *         c_{t+1}  = Clip(m_{t+1}, c_min, c_max)
 *
 * The normal-normal conjugate explicitly models the personal calibration
 * factor c_t as a continuous Gaussian, which naturally expresses how the
 * uncertainty s_t² shrinks with each observation (the Kalman gain K_t is
 * monotonically decreasing). The observation y_t fuses the actual intake
 * ratio (main signal: the user's true demand) with a ±λ satiety adjustment.
 *
 * All hyperparameters (λ, τ², c_min, c_max, prior) are configurable via
 * `BayesianConfig` / `CalibrationOptions`; shipped defaults are generic
 * placeholders to be tuned per deployment.
 *
 * Pure module: no platform APIs, no storage, no network. Persistence is the
 * caller's responsibility.
 */

import type {
  CalibrationOptions,
  CalibrationResult,
  CalibrationState,
  MealFeedback
} from './types';

/* ==================== Config (placeholder defaults) ==================== */

/** Bayesian calibration configuration (all fields concrete). */
export interface BayesianConfig
  extends Omit<CalibrationOptions, 'lambda' | 'tauSq' | 'cMin' | 'cMax'> {
  /** Satiety feedback adjustment strength λ. */
  lambda: number;
  /** Observation noise variance τ². */
  tauSq: number;
  /** Correction-factor lower bound c_min. */
  cMin: number;
  /** Correction-factor upper bound c_max. */
  cMax: number;
  /** Initial prior mean m_0 (1.0 = no calibration). */
  priorMean: number;
  /** Initial prior variance s_0² (large → first feedbacks adjust freely). */
  priorVariance: number;
  /** Observation clamp bounds for theta. */
  thetaMin: number;
  thetaMax: number;
}

/**
 * Default calibration configuration — all numeric values are **generic
 * placeholders**: λ in [0.05, 0.10], τ² typical measurement noise, and
 * symmetric c bounds around 1.0. Tune per deployment before production use.
 */
export const DEFAULT_BAYESIAN_CONFIG: BayesianConfig = {
  lambda: 0.08, // satiety feedback strength λ
  tauSq: 0.2, // observation noise variance τ²
  cMin: 0.8, // correction-factor lower bound
  cMax: 1.2, // correction-factor upper bound
  priorMean: 1.0,
  priorVariance: 0.25,
  thetaMin: 0,
  thetaMax: 1.5
};

/** Deep-merge a partial config onto the placeholder defaults. */
export function resolveBayesianConfig(partial?: Partial<BayesianConfig>): BayesianConfig {
  return { ...DEFAULT_BAYESIAN_CONFIG, ...(partial || {}) };
}

/** Hysteresis band for the direction verdict: |factor − 1| < 0.05 → hold. */
const HYSTERESIS = 0.05;

/** Clamp a value to [min, max]; non-finite → min. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Round to a number of decimals. */
function round(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

/* ==================== State lifecycle ==================== */

/**
 * Initial calibration state: c_0 ~ N(m_0, s_0²).
 *
 * @param priorMean prior mean (default 1.0 = no calibration)
 * @param priorVariance prior variance (default 0.25)
 */
export function createInitialState(
  priorMean = DEFAULT_BAYESIAN_CONFIG.priorMean,
  priorVariance = DEFAULT_BAYESIAN_CONFIG.priorVariance
): CalibrationState {
  const mean = Number.isFinite(Number(priorMean))
    ? Number(priorMean)
    : DEFAULT_BAYESIAN_CONFIG.priorMean;
  const variance =
    Number.isFinite(Number(priorVariance)) && Number(priorVariance) > 0
      ? Number(priorVariance)
      : DEFAULT_BAYESIAN_CONFIG.priorVariance;
  return {
    mean,
    variance,
    mealCount: 0,
    lastRecordedAt: null
  };
}

/** Reset to the initial state. */
export function resetState(priorMean = DEFAULT_BAYESIAN_CONFIG.priorMean): CalibrationState {
  return createInitialState(priorMean);
}

/* ==================== Observation & update ==================== */

/**
 * Build the observation (Algorithm III step 2):
 *   y_t = θ_t × (1 − λ × F_t)
 *
 * - θ_t (actual intake ratio) is the main signal — the user's true demand.
 * - F_t (satiety feedback) applies a ±λ adjustment: stuffed (F=+1) narrows
 *   the observation, under-fed (F=-1) widens it.
 */
export function buildObservation(
  theta: number,
  F: -1 | 0 | 1,
  lambda = DEFAULT_BAYESIAN_CONFIG.lambda
): number {
  const t = clamp(Number(theta) || 1, DEFAULT_BAYESIAN_CONFIG.thetaMin, DEFAULT_BAYESIAN_CONFIG.thetaMax);
  const f: -1 | 0 | 1 = F === -1 || F === 1 ? F : 0;
  const lam = Number.isFinite(Number(lambda)) ? Number(lambda) : DEFAULT_BAYESIAN_CONFIG.lambda;
  return t * (1 - lam * f);
}

/**
 * Single-step posterior incremental update (Algorithm III step 3):
 *   K = s²/(s²+τ²)
 *   m' = m + K·(y − m)
 *   s'² = (1−K)·s²
 *
 * Pure function: returns a new state plus the observation y and gain K;
 * never mutates the input.
 */
export function recordFeedback(
  state: CalibrationState,
  feedback: MealFeedback,
  options: CalibrationOptions = {}
): { state: CalibrationState; observation: number; gain: number } {
  const s = state || createInitialState();
  const mean = Number.isFinite(Number(s.mean))
    ? Number(s.mean)
    : DEFAULT_BAYESIAN_CONFIG.priorMean;
  const variance =
    Number.isFinite(Number(s.variance)) && Number(s.variance) > 0
      ? Number(s.variance)
      : DEFAULT_BAYESIAN_CONFIG.priorVariance;

  const tauSq = Number(options.tauSq) > 0 ? Number(options.tauSq) : DEFAULT_BAYESIAN_CONFIG.tauSq;
  const lambda = Number.isFinite(Number(options.lambda))
    ? Number(options.lambda)
    : DEFAULT_BAYESIAN_CONFIG.lambda;

  const F: -1 | 0 | 1 = feedback && (feedback.F === -1 || feedback.F === 1) ? feedback.F : 0;
  const theta = clamp(
    Number(feedback && feedback.theta) || 1,
    DEFAULT_BAYESIAN_CONFIG.thetaMin,
    DEFAULT_BAYESIAN_CONFIG.thetaMax
  );
  const y = buildObservation(theta, F, lambda);

  // Kalman gain: K = s² / (s² + τ²)
  const gain = variance / (variance + tauSq);

  // Posterior mean: m' = m + K·(y − m)
  const nextMean = mean + gain * (y - mean);

  // Posterior variance: s'² = (1 − K)·s² (uncertainty shrinks monotonically)
  const nextVariance = (1 - gain) * variance;

  return {
    state: {
      mean: nextMean,
      variance: nextVariance,
      mealCount: (Number(s.mealCount) || 0) + 1,
      lastRecordedAt: feedback.recordedAt != null ? feedback.recordedAt : Date.now()
    },
    observation: round(y, 4),
    gain: round(gain, 4)
  };
}

/**
 * Next-meal correction factor (end of Algorithm III step 3):
 *   c = Clip(m_t, c_min, c_max)
 *
 * Produces a CalibrationResult: factor (clipped), mean (raw posterior mean),
 * variance (uncertainty), direction, mealCount. `gain` is 0 in this pure-read
 * path; the real gain is returned by `calibrateAfterMeal`.
 */
export function computeCalibrationFactor(
  state: CalibrationState,
  options: CalibrationOptions = {}
): CalibrationResult {
  const s = state || createInitialState();
  const mean = Number.isFinite(Number(s.mean))
    ? Number(s.mean)
    : DEFAULT_BAYESIAN_CONFIG.priorMean;
  const variance =
    Number.isFinite(Number(s.variance)) && Number(s.variance) > 0
      ? Number(s.variance)
      : DEFAULT_BAYESIAN_CONFIG.priorVariance;
  const cMin = Number.isFinite(Number(options.cMin))
    ? Number(options.cMin)
    : DEFAULT_BAYESIAN_CONFIG.cMin;
  const cMax = Number.isFinite(Number(options.cMax))
    ? Number(options.cMax)
    : DEFAULT_BAYESIAN_CONFIG.cMax;

  const factor = clamp(mean, cMin, cMax);
  const direction: 'down' | 'up' | 'hold' =
    factor < 1 - HYSTERESIS ? 'down' : factor > 1 + HYSTERESIS ? 'up' : 'hold';

  return {
    factor: round(factor, 4),
    mean: round(mean, 4),
    variance: round(variance, 6),
    gain: 0,
    direction,
    mealCount: Number(s.mealCount) || 0
  };
}

/**
 * Apply the calibration factor to a recommended keep ratio (closed-loop hook,
 * Algorithm III step 1):
 *   r_rec = c_t × r_base
 *
 * factor < 1 → recommendation tightened; factor > 1 → loosened.
 * The result is clamped to [0.3, 1], matching the HFS r_base range.
 *
 * @param keepRatio HFS recommended keep ratio r_base (0..1)
 * @param factor calibration factor c_t
 */
export function applyCalibration(keepRatio: number, factor: number): number {
  const safeFactor = Number.isFinite(factor) ? factor : 1;
  const ratio = Number(keepRatio);
  if (!Number.isFinite(ratio)) return 1;
  return round(clamp(ratio * safeFactor, 0.3, 1), 4);
}

/**
 * Convenience pipeline: one feedback → update state → derive the factor.
 * Ideal as a one-liner in a post-meal callback. Returns the observation y,
 * the gain K, and the full result.
 */
export function calibrateAfterMeal(
  state: CalibrationState,
  feedback: MealFeedback,
  options: CalibrationOptions = {}
): {
  state: CalibrationState;
  observation: number;
  gain: number;
  result: CalibrationResult;
} {
  const { state: nextState, observation, gain } = recordFeedback(state, feedback, options);
  const result = computeCalibrationFactor(nextState, options);
  return { state: nextState, observation, gain, result: { ...result, gain } };
}
