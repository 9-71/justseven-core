/**
 * Pet emotion / streak / EXP / shield-card settlement — petDynamics.
 *
 * Scope (strictly isolated): emotion verdict, "accurate clean plate"
 * detection, EXP settlement, indulgence-shield deduction, streak & level
 * progression. Does NOT touch dialog extraction (`dialog`) or Bayesian
 * calibration (`bayesian`). Pure state machine: input → output, zero
 * external side effects.
 *
 * Settlement rules (field contract aligned with `types.MealFeedback`):
 * - Accurate clean plate: theta ≈ 1.0 AND F === 0 — ate exactly the advice
 *   and is exactly seven-tenths full. EXP × 2.0 (crit), streak + 1.
 * - Stuffed (F=+1): counts as indulgence → streak reset to 0; holding an
 *   indulgence shield card automatically deducts it and preserves the streak
 *   (shieldConsumed = true).
 * - Not full (F=-1) or "just right but not accurate" (F=0, theta off):
 *   streak unchanged — the direction feedback is left to the Bayesian
 *   calibration (up / down), no streak penalty.
 */

import { THETA_MAX, THETA_MIN } from './dialog';

/** Pet emotion. */
export type PetEmotion = 'happy' | 'hungry' | 'full';

/** Settlement input (fed by the `pipeline` orchestrator). */
export interface PetReactionParams {
  /** Actual intake ratio (0.1..1.5). */
  theta: number;
  /** Three-state satiety: -1 not full / 0 just right / 1 stuffed. */
  F: -1 | 0 | 1;
  /** Current level. */
  currentLevel: number;
  /** Current EXP. */
  currentExp: number;
  /** Current streak (days). */
  streakDays: number;
  /** Whether an "indulgence shield card" is held. */
  hasShieldCard: boolean;
}

/** Settlement result. */
export interface PetReactionResult {
  emotion: PetEmotion;
  /** theta ≈ 1.0 AND F === 0 → accurate clean plate. */
  isAccurateCleanPlate: boolean;
  /** EXP gained this round (accurate clean plate = 2.0 × base EXP). */
  expGained: number;
  /** F=+1 with a shield card → automatically deducted, streak preserved. */
  shieldConsumed: boolean;
  /** Updated streak (days). */
  updatedStreak: number;
  /** Updated level (+1 per level-up threshold crossed). */
  updatedLevel: number;
  /** Updated EXP (a level-up threshold is deducted on level up). */
  updatedExp: number;
}

/** Base EXP per meal. */
export const BASE_EXP = 10;
/** Accurate-clean-plate EXP multiplier. */
export const ACCURATE_CLEAN_PLATE_MULTIPLIER = 2.0;
/** Level-up base: level N → N+1 needs N × EXP_PER_LEVEL (increasing curve). */
export const EXP_PER_LEVEL = 100;
/** Accurate-clean-plate theta tolerance (|theta − 1| ≤ 0.05). */
export const ACCURATE_CLEAN_PLATE_EPSILON = 0.05;
// Legal theta bounds are imported from './dialog' (single source of truth).

/** Clamp to [min, max]; non-finite → min. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Pure state machine: one post-meal feedback → pet settlement result.
 * Never mutates its inputs.
 *
 * @param params settlement input (theta, F, level/EXP/streak, shield card)
 */
export function evaluatePetReaction(params: PetReactionParams): PetReactionResult {
  const thetaRaw = Number(params.theta);
  const theta = clamp(Number.isFinite(thetaRaw) ? thetaRaw : 1, THETA_MIN, THETA_MAX);
  const F: -1 | 0 | 1 = params.F === -1 || params.F === 1 ? params.F : 0;
  const currentLevel = Math.max(1, Math.floor(Number(params.currentLevel) || 1));
  const currentExp = Math.max(0, Math.floor(Number(params.currentExp) || 0));
  const streakDays = Math.max(0, Math.floor(Number(params.streakDays) || 0));
  const hasShieldCard = params.hasShieldCard === true;

  // Accurate clean plate: theta ≈ 1.0 AND F === 0.
  const isAccurateCleanPlate =
    Math.abs(theta - 1) <= ACCURATE_CLEAN_PLATE_EPSILON && F === 0;

  // Emotion follows the three-state satiety.
  const emotion: PetEmotion = F === 1 ? 'full' : F === -1 ? 'hungry' : 'happy';

  // EXP: 2.0 × base on accurate clean plate (crit), 1.0 × base otherwise.
  const expGained = Math.round(
    BASE_EXP * (isAccurateCleanPlate ? ACCURATE_CLEAN_PLATE_MULTIPLIER : 1)
  );

  // Streak & shield settlement.
  let shieldConsumed = false;
  let updatedStreak = streakDays;
  if (isAccurateCleanPlate) {
    updatedStreak = streakDays + 1;
  } else if (F === 1) {
    // Stuffed = indulgence → streak reset; a shield card preserves it.
    if (hasShieldCard) {
      shieldConsumed = true;
      updatedStreak = streakDays;
    } else {
      updatedStreak = 0;
    }
  }
  // Otherwise (F=0 non-accurate / F=-1): streak unchanged.

  // Level progression: level N → N+1 needs N × EXP_PER_LEVEL. The loop
  // handles multi-level jumps so a single settlement never loses surplus EXP.
  let updatedLevel = currentLevel;
  let updatedExp = currentExp + expGained;
  while (updatedExp >= updatedLevel * EXP_PER_LEVEL) {
    updatedExp -= updatedLevel * EXP_PER_LEVEL;
    updatedLevel += 1;
  }

  return {
    emotion,
    isAccurateCleanPlate,
    expGained,
    shieldConsumed,
    updatedStreak,
    updatedLevel,
    updatedExp
  };
}

/**
 * Cognitive-restructuring copy bank: maps a settlement outcome to a result
 * title + guiding message. Kept as a pure function so the copy stays in one
 * place instead of being scattered through UI layers.
 *
 * @param reaction settlement outcome (emotion / accurate clean plate / shield)
 */
export function buildCognitiveCopy(reaction: {
  emotion: PetEmotion;
  isAccurateCleanPlate: boolean;
  shieldConsumed: boolean;
}): { title: string; message: string } {
  const r = reaction || {};
  if (r.isAccurateCleanPlate) {
    return {
      title: 'Accurate clean plate!',
      message: 'Ate exactly as advised and exactly seven-tenths full — 2.0× EXP crit!'
    };
  }
  if (r.emotion === 'full') {
    return r.shieldConsumed
      ? { title: 'Body signals lag…', message: 'Indulgence shield auto-deducted, streak preserved.' }
      : { title: 'Stuffed', message: 'Body signals lag a bit — the next recommendation will be lowered.' };
  }
  if (r.emotion === 'hungry') {
    return { title: 'Have a bit more next time', message: 'Looks like the advice was short — the next recommendation will be raised.' };
  }
  // emotion === 'happy' but not accurate (F=0, theta off).
  return { title: 'Perfectly seven-tenths full', message: 'Not over, not hungry — your rhythm is steady.' };
}
