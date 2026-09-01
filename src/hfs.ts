/**
 * Healthy-Fullness Score (HFS) & dual-constraint recommended intake ratio —
 * Algorithm II.
 *
 * ## Model: HFS–target-energy dual-constraint recommendation
 *
 *  1. Basal metabolism (Mifflin-St Jeor, see `bmr`) and the single-meal
 *     target energy
 *
 *         E_base,m = BMR × G × μ_m
 *
 *  2. Dynamic single-meal target correction from recent fullness feedback
 *
 *         E_target,t = Clip(E_base,m × [1 + ω·(HFS* − HFS̄_recent)/(σ_HFS + ε)],
 *                           E_min, E_max)
 *
 *  3. Energy-constraint recommended ratio
 *
 *         r_E = E_target,t / E_total
 *
 *  4. Seven-tenths-full constraint (healthy-fullness regression)
 *
 *         ĤFS = β0 + β1·Calories + β2·Protein + β3·Fiber − β4·Fat
 *         r_H = Clip((HFS* − β0) / (β1·E_total + β2·Protein + β3·Fiber − β4·Fat),
 *                    r_min, r_max)
 *
 *  5. Dual-constraint fused baseline ratio
 *
 *         r_base = (1 − α)·r_E + α·r_H
 *
 * ## Nutrition-density flexible quota (`allocateFlexibleQuota`)
 *
 * Iterative proportional cut rather than a single global multiplier:
 *  1. Under budget → every item keeps 1.0.
 *  2. Over budget → need = total − target; each item's "cut pressure share"
 *     is proportional to shrinkWeight × kcal, and `need` is split by share.
 *  3. An item that hits its floorRatio is pinned there and its uncovered
 *     deficit is re-split among the remaining items (≤ 6 passes, converges
 *     early).
 *  4. If everything bottoms out, accept the shortfall — better an honest
 *     "best effort" than cutting any dish to zero.
 *
 * Hyperparameters (regression betas, correction weight ω, fusion weight α,
 * nutrition tiers) are **configurable** via `HfsConfig`; the shipped defaults
 * are generic placeholders to be fitted per deployment.
 *
 * Pure module: no platform APIs, no `this`, no network.
 */

import type {
  FoodCategory,
  HfsRegression,
  MacroSummary,
  NutritionTier,
  PortionAdvice,
  QuotaInput,
  QuotaResult,
  WeightGoal
} from './types';
import { WEIGHT_GOAL_FACTOR } from './bmr';
import { clamp, round } from './geometry';

/* ==================== Config (placeholder defaults) ==================== */

/** HFS engine configuration — all fields optional, shipped with placeholders. */
export interface HfsConfig {
  /** HFS regression coefficients (PLACEHOLDER defaults — fit your data). */
  betas: HfsRegression;
  /** Seven-tenths-full target HFS* (7-point scale). */
  hfsStar: number;
  /** Dynamic-target correction weight ω. */
  correctionOmega: number;
  /** Standard deviation of recent HFS scores σ_HFS (normalizes the correction). */
  hfsStd: number;
  /** Dual-constraint fusion weight α (0 = pure energy, 1 = pure fullness). */
  fusionAlpha: number;
  /** Fullness-ratio clamp bounds. */
  rMin: number;
  rMax: number;
  /** Nutrition-density reduction gradient per category. */
  tiers: Readonly<Record<FoodCategory, NutritionTier>>;
}

/**
 * Default engine configuration. All numeric values are **generic
 * placeholders** — the real coefficients must be calibrated on deployment-
 * specific data (see README for the fitting procedure).
 */
export const DEFAULT_HFS_CONFIG: HfsConfig = {
  betas: { beta0: 3.0, beta1: 0.003, beta2: 0.05, beta3: 0.08, beta4: 0.03 },
  hfsStar: 7,
  correctionOmega: 0.1,
  hfsStd: 1,
  fusionAlpha: 0.5,
  rMin: 0.3,
  rMax: 1.3,
  tiers: Object.freeze({
    veggie: { shrinkWeight: 0.1, floorRatio: 0.9, tier: 'protect' },
    soup: { shrinkWeight: 0.1, floorRatio: 0.9, tier: 'protect' },
    protein: { shrinkWeight: 0.45, floorRatio: 0.7, tier: 'quality' },
    carb: { shrinkWeight: 1.0, floorRatio: 0.5, tier: 'staple' },
    fried: { shrinkWeight: 2.2, floorRatio: 0.3, tier: 'indulgent' },
    dessert: { shrinkWeight: 2.2, floorRatio: 0.35, tier: 'indulgent' },
    other: { shrinkWeight: 0.8, floorRatio: 0.6, tier: 'staple' }
  })
};

/** Deep-merge a partial config onto the placeholder defaults. */
export function resolveHfsConfig(partial?: Partial<HfsConfig>): HfsConfig {
  return {
    ...DEFAULT_HFS_CONFIG,
    ...(partial || {}),
    betas: { ...DEFAULT_HFS_CONFIG.betas, ...(partial && partial.betas) }
  };
}

/* ==================== Nutrition-density gradient ==================== */

/** Keep ratios below this threshold get a drawn circle. */
export const CIRCLE_DRAW_THRESHOLD = 0.85;

/** Nutrition-density gradient of a category, unknown → `other`. */
export function getNutritionTier(
  category: FoodCategory | '',
  tiers: Readonly<Record<FoodCategory, NutritionTier>> = DEFAULT_HFS_CONFIG.tiers
): NutritionTier {
  return tiers[category as FoodCategory] ?? tiers.other;
}

/* ==================== Natural-language portion tiers ==================== */

/**
 * keepRatio → natural-language portion advice. Table is ordered by `min`
 * descending; the first tier with keepRatio >= min wins.
 */
export const PORTION_ADVICE_TIERS: ReadonlyArray<{
  min: number;
  fraction: string;
  label: string;
  shrink: boolean;
}> = Object.freeze([
  { min: 0.85, fraction: '1', label: 'eat freely', shrink: false },
  { min: 0.75, fraction: '4/5', label: 'try 4/5', shrink: true },
  { min: 0.65, fraction: '3/4', label: 'try 3/4', shrink: true },
  { min: 0.55, fraction: '2/3', label: 'try 2/3', shrink: true },
  { min: 0.4, fraction: '1/2', label: 'try 1/2', shrink: true },
  { min: 0, fraction: '1/3', label: 'try 1/3', shrink: true }
]);

/** Map a keep ratio (0..1) to natural-language advice. Pure rule mapping. */
export function toPortionAdvice(keepRatio: number): PortionAdvice {
  const ratio = Number.isFinite(Number(keepRatio)) ? Number(keepRatio) : 1;
  const tier =
    PORTION_ADVICE_TIERS.find((t) => ratio >= t.min) ??
    PORTION_ADVICE_TIERS[PORTION_ADVICE_TIERS.length - 1];
  return { label: tier.label, fraction: tier.fraction, shrink: tier.shrink };
}

/* ==================== Step 1: single-meal target energy ==================== */

/** Default meal energy weight μ_m (kept in sync with bmr.MEAL_BUDGET_RATIO). */
export const DEFAULT_MEAL_WEIGHT = 0.32;

/**
 * E_base,m = BMR × G × μ_m (Algorithm II step 1).
 *
 * @param bmr basal metabolic rate (kcal/day), invalid → 1500
 * @param goal weight goal (decides G)
 * @param mealWeight meal weight μ_m (default 0.32)
 */
export function computeMealBudget(
  bmr: number,
  goal: WeightGoal = 'maintain',
  mealWeight: number = DEFAULT_MEAL_WEIGHT
): number {
  const safeBmr = Number.isFinite(Number(bmr)) && Number(bmr) > 0 ? Number(bmr) : 1500;
  const G = WEIGHT_GOAL_FACTOR[goal] ?? WEIGHT_GOAL_FACTOR.maintain;
  const mu =
    Number.isFinite(Number(mealWeight)) && Number(mealWeight) > 0
      ? Number(mealWeight)
      : DEFAULT_MEAL_WEIGHT;
  return round(safeBmr * G * mu, 1);
}

/* ==================== Step 2: dynamic target correction ==================== */

/** "Seven-tenths-full" target HFS* (7-point scale). */
export const HFS_STAR = 7;

/** Numerical-stability constant ε. */
const EPSILON = 1e-6;

/**
 * Dynamic single-meal target (Algorithm II step 2):
 *   E_target,t = Clip(E_base,m × [1 + ω·(HFS* − HFS̄_recent)/(σ_HFS + ε)],
 *                     E_min,m, E_max,m)
 *
 * Semantics: a recent average fullness HFS̄ below HFS* (repeatedly under-fed)
 * raises the target; above HFS* (repeatedly stuffed) lowers it. σ_HFS
 * normalizes the correction magnitude, ε prevents division by zero.
 *
 * @param baseKcal base meal energy E_base,m
 * @param recentHfsMean recent average fullness score HFS̄_recent (7-point)
 * @param options { hfsStar?, hfsStd?, omega?, minKcal?, maxKcal? }
 */
export function computeDynamicTarget(
  baseKcal: number,
  recentHfsMean: number,
  options: {
    hfsStar?: number;
    hfsStd?: number;
    omega?: number;
    minKcal?: number;
    maxKcal?: number;
  } = {}
): number {
  const base = Number(baseKcal) > 0 ? Number(baseKcal) : 0;
  const hfsStar = Number(options.hfsStar) || HFS_STAR;
  const hfsStd = Number(options.hfsStd) > 0 ? Number(options.hfsStd) : 1;
  const omega = Number.isFinite(Number(options.omega))
    ? Number(options.omega)
    : DEFAULT_HFS_CONFIG.correctionOmega;
  const recent = Number.isFinite(Number(recentHfsMean)) ? Number(recentHfsMean) : hfsStar;

  const correction = 1 + omega * ((hfsStar - recent) / (hfsStd + EPSILON));
  const raw = base * correction;

  const minKcal = Number(options.minKcal) > 0 ? Number(options.minKcal) : base * 0.7;
  const maxKcal = Number(options.maxKcal) > 0 ? Number(options.maxKcal) : base * 1.3;

  return round(clamp(raw, minKcal, maxKcal), 1);
}

/* ==================== Step 3: energy-constraint ratio ==================== */

/**
 * r_E = E_target,t / E_total (Algorithm II step 3, pure formula, no clamp).
 * Non-positive total → 1 (nothing to cut).
 */
export function computeEnergyRatio(targetKcal: number, totalKcal: number): number {
  const total = Number(totalKcal);
  const target = Number(targetKcal);
  if (!(total > 0)) return 1;
  if (!(target > 0)) return 0;
  return target / total;
}

/**
 * Global baseline ratio with clamp: clamp(target/total, 0.3, 1).
 *
 * Why clamp: when a meal's actual energy is far below target (e.g. 200 kcal),
 * the raw r_E would exceed 1 and distort the quota; when the total is huge,
 * r_E approaches 0 — the 0.3 floor guarantees "at least 1/3" rather than
 * pushing people to starve.
 */
export function computeRBase(totalKcal: number, targetKcal: number): number {
  return totalKcal > 0 ? round(clamp(targetKcal / totalKcal, 0.3, 1), 4) : 1;
}

/* ==================== Step 4: seven-tenths-full constraint ==================== */

/**
 * Healthy-fullness prediction:
 *   ĤFS = β0 + β1·Calories + β2·Protein + β3·Fiber − β4·Fat
 *
 * Sanity check with the placeholder betas — E=600 kcal, Protein=30 g,
 * Fiber=5 g, Fat=20 g:
 *   ĤFS = 3 + 0.003·600 + 0.05·30 + 0.08·5 − 0.03·20
 *       = 3 + 1.8 + 1.5 + 0.4 − 0.6 = 6.1 ≈ 7  ✓
 */
export function predictHfs(
  macros: MacroSummary,
  betas: HfsRegression = DEFAULT_HFS_CONFIG.betas
): number {
  const b = betas || DEFAULT_HFS_CONFIG.betas;
  const calories = Number(macros && macros.totalKcal) || 0;
  const protein = Number(macros && macros.proteinG) || 0;
  const fiber = Number(macros && macros.fiberG) || 0;
  const fat = Number(macros && macros.fatG) || 0;

  return b.beta0 + b.beta1 * calories + b.beta2 * protein + b.beta3 * fiber - b.beta4 * fat;
}

/**
 * Seven-tenths-full constraint ratio (Algorithm II step 4): solve
 * ĤFS(r_H) = HFS*, i.e.
 *   r_H = Clip((HFS* − β0) / (β1·E_total + β2·Protein + β3·Fiber − β4·Fat),
 *              r_min, r_max)
 *
 * Note: the denominator is the fullness contribution of eating the *whole*
 * plate (E_total / Protein / Fiber / Fat at full quantities); the numerator
 * is the fullness gap still to be filled, so the ratio is the fraction of the
 * full plate needed to reach seven-tenths-full.
 *
 * @param macros whole-plate macro summary (full quantities)
 * @param options { betas?, hfsStar?, rMin?, rMax? }
 */
export function computeHfsRatio(
  macros: MacroSummary,
  options: {
    betas?: HfsRegression;
    hfsStar?: number;
    rMin?: number;
    rMax?: number;
  } = {}
): number {
  const b = options.betas || DEFAULT_HFS_CONFIG.betas;
  const hfsStar = Number(options.hfsStar) || HFS_STAR;

  const calories = Number(macros && macros.totalKcal) || 0;
  const protein = Number(macros && macros.proteinG) || 0;
  const fiber = Number(macros && macros.fiberG) || 0;
  const fat = Number(macros && macros.fatG) || 0;

  const denominator =
    b.beta1 * calories + b.beta2 * protein + b.beta3 * fiber - b.beta4 * fat;

  const rMin = Number.isFinite(Number(options.rMin)) ? Number(options.rMin) : DEFAULT_HFS_CONFIG.rMin;
  const rMax = Number.isFinite(Number(options.rMax)) ? Number(options.rMax) : DEFAULT_HFS_CONFIG.rMax;

  if (!(denominator > 0)) return rMax; // non-positive denominator: fullness contribution negative → upper bound
  const ratio = (hfsStar - b.beta0) / denominator;
  return round(clamp(ratio, rMin, rMax), 4);
}

/* ==================== Step 5: dual-constraint fusion ==================== */

/**
 * Fuse the two constraints: r_base = (1 − α)·r_E + α·r_H (Algorithm II step 5).
 *
 * @param rE energy-constraint ratio
 * @param rH fullness-constraint ratio
 * @param alpha fusion weight (0 = pure energy, 1 = pure fullness)
 */
export function fuseRatios(
  rE: number,
  rH: number,
  alpha: number = DEFAULT_HFS_CONFIG.fusionAlpha
): number {
  // Note: alpha = 0 is a valid value (pure energy constraint), so `||` must
  // not be used to fall back (0 would be misread as missing).
  const a = clamp(
    Number.isFinite(Number(alpha)) ? Number(alpha) : DEFAULT_HFS_CONFIG.fusionAlpha,
    0,
    1
  );
  const e = Number.isFinite(Number(rE)) ? Number(rE) : 1;
  const h = Number.isFinite(Number(rH)) ? Number(rH) : 1;
  return round((1 - a) * e + a * h, 4);
}

/**
 * One-shot: the full r_base pipeline (Algorithm II steps 3–5).
 *
 * @param targetKcal dynamically-corrected meal target E_target,t
 * @param totalKcal actual whole-plate energy E_total
 * @param macros whole-plate macros (for the r_H fullness regression)
 * @param options { alpha?, betas?, rMin?, rMax?, clampEnergy? }
 * @returns { rE, rH, rBase }
 */
export function computeRecommendedRatio(
  targetKcal: number,
  totalKcal: number,
  macros: MacroSummary,
  options: {
    alpha?: number;
    betas?: HfsRegression;
    rMin?: number;
    rMax?: number;
    /** Whether r_E is clamped to [0.3, 1] (default false → pure formula). */
    clampEnergy?: boolean;
  } = {}
): { rE: number; rH: number; rBase: number } {
  const total = Number(totalKcal);
  const target = Number(targetKcal);

  const rE = options.clampEnergy
    ? computeRBase(total, target)
    : computeEnergyRatio(target, total);

  const rH = computeHfsRatio(macros, {
    betas: options.betas,
    rMin: options.rMin,
    rMax: options.rMax
  });

  const rBase = fuseRatios(rE, rH, options.alpha);
  return { rE: round(rE, 4), rH: round(rH, 4), rBase: round(rBase, 4) };
}

/* ==================== Dual-constraint flexible quota ==================== */

/**
 * Nutrition-density flexible quota cut — the HFS dual-constraint core.
 *
 * @param items components with id / kcal / category
 * @param targetKcal target energy
 * @param options { tiers? } optional custom nutrition gradient
 */
export function allocateFlexibleQuota(
  items: QuotaInput[],
  targetKcal: number,
  options: { tiers?: Readonly<Record<FoodCategory, NutritionTier>> } = {}
): QuotaResult {
  const tiers = options.tiers || DEFAULT_HFS_CONFIG.tiers;
  const keepById: Record<string, number> = {};
  const list = (items || []).filter((it) => Number(it.kcal) > 0);

  // Zero-energy items (failed volume estimation) are kept fully and excluded.
  (items || []).forEach((it) => {
    keepById[it.id] = 1;
  });

  const totalKcal = list.reduce((sum, it) => sum + Number(it.kcal), 0);

  // Case 1: under budget → everything is kept fully.
  if (!(totalKcal > targetKcal) || !(targetKcal > 0)) {
    return { keepById, reducedKcal: 0, shortfallKcal: 0, capped: false };
  }

  let need = totalKcal - targetKcal;

  // Per-item cut ceiling (kcal) and weight share.
  const state = list.map((it) => {
    const tier = getNutritionTier(it.category, tiers);
    const kcal = Number(it.kcal);
    return {
      id: it.id,
      kcal,
      floorRatio: tier.floorRatio,
      // Maximum cuttable energy: down to the floor ratio.
      maxCut: kcal * (1 - tier.floorRatio),
      weight: tier.shrinkWeight * kcal,
      cut: 0,
      atFloor: false
    };
  });

  // Iterative split: items at their floor leave the pool; the uncovered
  // deficit is re-split among the remaining items (≤ 6 passes, converges).
  for (let pass = 0; pass < 6 && need > 0.01; pass += 1) {
    const open = state.filter((s) => !s.atFloor && s.maxCut - s.cut > 0.01);
    if (!open.length) break;

    const weightSum = open.reduce((sum, s) => sum + s.weight, 0);
    if (!(weightSum > 0)) break;

    let roundCut = 0;

    open.forEach((s) => {
      const share = need * (s.weight / weightSum);
      const room = s.maxCut - s.cut;
      const applied = Math.min(share, room);

      s.cut += applied;
      roundCut += applied;

      if (s.maxCut - s.cut <= 0.01) s.atFloor = true;
    });

    need -= roundCut;
    if (roundCut <= 0.01) break; // no forward progress — avoid spinning
  }

  let reducedKcal = 0;
  state.forEach((s) => {
    const keep = s.kcal > 0 ? clamp(1 - s.cut / s.kcal, s.floorRatio, 1) : 1;
    keepById[s.id] = round(keep, 4);
    reducedKcal += s.kcal * (1 - keep);
  });

  return {
    keepById,
    reducedKcal: round(reducedKcal, 1),
    // Under-reduction: the deficit that even the floors could not cover.
    shortfallKcal: round(Math.max(0, need), 1),
    capped: state.every((s) => s.atFloor)
  };
}

/* ==================== Composite: HFS summary ==================== */

/** Item energy: massG × kcalPer100g / 100. */
export function calcKcal(massG: number, kcalPer100g: number): number {
  const mass = Number(massG);
  const density = Number(kcalPer100g);
  if (!(mass > 0) || !(density > 0)) return 0;
  return round((mass * density) / 100, 1);
}

/** Item energy with portion multiplier snapping: E = massG × factor × kcalPer100g / 100. */
export function calcItemKcal(
  massG: number,
  kcalPer100g: number,
  portionFactor: number
): number {
  const factor = snapPortion(portionFactor);
  return calcKcal(massG * factor, kcalPer100g);
}

/** Portion multiplier snapping steps. */
export const PORTION_STEPS: ReadonlyArray<number> = Object.freeze([0.8, 1.0, 1.2, 1.5]);

/** Snap any portion multiplier to the nearest step. */
export function snapPortion(factor: number): number {
  const value = Number(factor);
  if (!Number.isFinite(value)) return 1.0;
  return PORTION_STEPS.reduce(
    (best, step) =>
      Math.abs(step - value) < Math.abs(best - value) ? step : best,
    PORTION_STEPS[0]
  );
}

/**
 * HFS summary: items + target → quota and aggregate indicators
 * (total/recommended kcal, r_base, keep ratio, budget flags, circle count).
 */
export function buildHfsSummary(
  items: QuotaInput[],
  targetKcal: number
): {
  totalKcal: number;
  recommendedKcal: number;
  targetKcal: number;
  rBase: number;
  keepOverall: number;
  withinBudget: boolean;
  reducedKcal: number;
  shortfallKcal: number;
  quotaCapped: boolean;
  circleCount: number;
  overBudget: boolean;
  rBasePercent: number;
} {
  const totalKcal = round(
    (items || []).reduce((sum, it) => sum + Number(it.kcal || 0), 0),
    1
  );

  // Nutrition-density flexible quota: full keep under budget, gradient cut above.
  const quota = allocateFlexibleQuota(items, targetKcal);
  const withinBudget = totalKcal <= targetKcal;
  const rBase = computeRBase(totalKcal, targetKcal);

  // Achieved overall keep ratio (keepRatio × kcal weighted mean).
  let recommendedKcal = 0;
  (items || []).forEach((it) => {
    const keepRatio = quota.keepById[it.id] != null ? quota.keepById[it.id] : 1;
    recommendedKcal += Number(it.kcal || 0) * keepRatio;
  });
  recommendedKcal = round(recommendedKcal, 1);

  const keepOverall =
    totalKcal > 0 ? round(clamp(recommendedKcal / totalKcal, 0, 1), 4) : 1;

  const circleCount = (items || []).filter((it) => {
    const keepRatio = quota.keepById[it.id] != null ? quota.keepById[it.id] : 1;
    return keepRatio < CIRCLE_DRAW_THRESHOLD;
  }).length;

  return {
    totalKcal,
    recommendedKcal,
    targetKcal,
    rBase,
    keepOverall,
    withinBudget,
    reducedKcal: quota.reducedKcal,
    shortfallKcal: quota.shortfallKcal,
    quotaCapped: quota.capped,
    circleCount,
    overBudget: totalKcal > targetKcal,
    rBasePercent: Math.round(keepOverall * 100)
  };
}
