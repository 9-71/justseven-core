/**
 * Basal metabolic rate & single-meal energy baselines — Algorithm 0.
 *
 * ## Mifflin-St Jeor formula
 *
 *     male:   BMR = 10·weight(kg) + 6.25·height(cm) − 5·age + 5
 *     female: BMR = 10·weight(kg) + 6.25·height(cm) − 5·age − 161
 *
 * ## Meal energy allocation
 *
 *     mealBudgetKcal = round(BMR × μ_m)            (μ_m = 0.32 by default)
 *     targetKcal     = round(mealBudgetKcal × 0.7) ("seven-tenths-full" target)
 *
 * ## Precision target with a tight elastic band
 *
 *     E_target = round(BMR × G × μ_m)
 *     minKcal  = round(E_target × 0.95)   maxKcal = round(E_target × 1.05)
 *
 * where G is the weight-goal factor (lose 0.85 / maintain 1.0 / gain 1.15).
 * The band's total span never exceeds 100 kcal: for extreme BMRs the ±5%
 * window is recentered to [E_target − 50, E_target + 50].
 *
 * Pure module: no platform APIs, no `this`, no network, no global state.
 */

import type { UserProfile, WeightGoal, WeightGoalFactor } from './types';

/** Gender constant offset of the Mifflin-St Jeor formula. */
const GENDER_OFFSET: Readonly<Record<'male' | 'female', number>> = {
  male: 5,
  female: -161
};

/** Single-meal budget ≈ 32% of daily BMR. */
export const MEAL_BUDGET_RATIO = 0.32;
/** "Seven-tenths-full" coefficient: fraction of the meal budget to target. */
export const SEVEN_FULL_TARGET = 0.7;

/** Weight-management goal factor G (single source of truth for the engine). */
export const WEIGHT_GOAL_FACTOR: Readonly<WeightGoalFactor> = {
  lose: 0.85,
  maintain: 1.0,
  gain: 1.15
};

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** BMR input validation outcome. */
export interface BMRValidation {
  valid: boolean;
  reason: string;
}

/**
 * Validate a BMR input profile.
 * @param profile anthropometric profile
 */
export function validateBMRInput(profile: UserProfile): BMRValidation {
  const { gender, age, height, weight } = profile || ({} as UserProfile);

  if (gender !== 'male' && gender !== 'female') {
    return { valid: false, reason: 'gender must be "male" or "female"' };
  }
  if (!isPositiveNumber(age)) {
    return { valid: false, reason: 'age must be a positive number' };
  }
  if (!isPositiveNumber(height)) {
    return { valid: false, reason: 'height must be a positive number (cm)' };
  }
  if (!isPositiveNumber(weight)) {
    return { valid: false, reason: 'weight must be a positive number (kg)' };
  }
  return { valid: true, reason: '' };
}

/**
 * Compute the basal metabolic rate (kcal/day) via Mifflin-St Jeor.
 * @param profile anthropometric profile
 * @throws when the input is invalid
 */
export function calcBMR(profile: UserProfile): number {
  const { valid, reason } = validateBMRInput(profile);
  if (!valid) {
    throw new Error(`calcBMR: invalid input — ${reason}`);
  }

  const { gender, age, height, weight } = profile;
  const base = 10 * weight + 6.25 * height - 5 * age;

  return Math.round(base + GENDER_OFFSET[gender]);
}

/**
 * Lenient variant: returns `fallback` instead of throwing, for placeholder UI.
 */
export function safeCalcBMR(profile: UserProfile, fallback = 0): number {
  try {
    return calcBMR(profile);
  } catch {
    return fallback;
  }
}

/** Coerce to a positive finite number; invalid (missing / 0 / NaN / negative) → fallback. */
function toPositiveNumber(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

/** Round to 1 decimal. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Single-meal calorie baseline from a BMR:
 *   mealBudgetKcal = round(bmr × 0.32, 1)
 *   targetKcal     = round(mealBudgetKcal × 0.7, 1)
 *
 * @param bmr basal metabolic rate (kcal/day); invalid values fall back to 1500
 */
export function computeMealCalorieBaseline(bmr: number): {
  mealBudgetKcal: number;
  targetKcal: number;
} {
  const safeBmr = toPositiveNumber(bmr, 1500);
  const mealBudgetKcal = round1(safeBmr * MEAL_BUDGET_RATIO);
  const targetKcal = round1(mealBudgetKcal * SEVEN_FULL_TARGET);
  return { mealBudgetKcal, targetKcal };
}

/**
 * One-shot: profile → BMR + meal calorie baseline.
 * Reuses `profile.bmr` when already present.
 */
export function computeUserCalorieBaseline(profile: UserProfile): {
  bmr: number;
  mealBudgetKcal: number;
  targetKcal: number;
} {
  const bmr = toPositiveNumber(profile && profile.bmr, 0) || safeCalcBMR(profile, 1500);
  const { mealBudgetKcal, targetKcal } = computeMealCalorieBaseline(bmr);
  return { bmr, mealBudgetKcal, targetKcal };
}

/** Tightest band span (kcal): beyond it the ±5% window is clamped to ±50. */
const MAX_BAND_SPAN_KCAL = 100;

/** Single-meal precise target plus a narrow elastic band. */
export interface MealTargetBand {
  /** Precise target energy E_target = round(BMR × G × μ_m). */
  targetKcal: number;
  /** Elastic lower bound = targetKcal − 5%. */
  minKcal: number;
  /** Elastic upper bound = targetKcal + 5%. */
  maxKcal: number;
}

/**
 * Precise single-meal target with a narrow (±5%, ≤ 100 kcal span) elastic band.
 *
 * @param bmr basal metabolic rate (kcal/day), invalid → 1500
 * @param goal weight goal (decides G)
 * @param mealWeight meal energy weight μ_m (default MEAL_BUDGET_RATIO = 0.32)
 */
export function computeMealTargetBand(
  bmr: number,
  goal: WeightGoal = 'maintain',
  mealWeight: number = MEAL_BUDGET_RATIO
): MealTargetBand {
  const safeBmr = toPositiveNumber(bmr, 1500);
  const G = WEIGHT_GOAL_FACTOR[goal] ?? WEIGHT_GOAL_FACTOR.maintain;
  const mu = toPositiveNumber(mealWeight, MEAL_BUDGET_RATIO);

  const targetKcal = Math.round(safeBmr * G * mu);

  let minKcal = Math.round(targetKcal * 0.95);
  let maxKcal = Math.round(targetKcal * 1.05);

  // Keep the total span ≤ 100 kcal: recenter to ±50 around the target.
  if (maxKcal - minKcal > MAX_BAND_SPAN_KCAL) {
    minKcal = targetKcal - MAX_BAND_SPAN_KCAL / 2;
    maxKcal = targetKcal + MAX_BAND_SPAN_KCAL / 2;
  }

  return { targetKcal, minKcal, maxKcal };
}
