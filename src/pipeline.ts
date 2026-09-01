/**
 * Unified closed-loop orchestration — feedbackPipeline.
 *
 * One-way data flow (strict responsibility isolation; this module writes no
 * extraction / settlement logic of its own):
 *
 *   dialog.dialogReducer            → dialog state transitions + slot extraction
 *   → converge (theta, F) with defaults
 *   → bayesian.calibrateAfterMeal   → Bayesian incremental calibration
 *   → pet.evaluatePetReaction       → emotion / EXP / shield settlement
 *   → final updated state
 *
 * Pure orchestration layer: no platform APIs, no network, no storage, no
 * closure caches, no global mutable state. Persistence (calibration state /
 * pet state) is the caller's responsibility.
 */

import type {
  CalibrationOptions,
  CalibrationResult,
  CalibrationState,
  MealFeedback
} from './types';
import { calibrateAfterMeal } from './bayesian';
import {
  type DialogAction,
  type DialogState,
  dialogReducer,
  isComplete,
  questionForStage
} from './dialog';
import {
  type PetReactionResult,
  evaluatePetReaction
} from './pet';

/** Default theta when the user followed the advice without a branch turn. */
export const DEFAULT_THETA_WHEN_FOLLOWED = 1.0;
/** Default satiety when unrecognized (exactly seven-tenths full). */
export const DEFAULT_F: -1 | 0 | 1 = 0;

/** Pet state snapshot (read by the caller from storage). */
export interface PetStateSnapshot {
  currentLevel: number;
  currentExp: number;
  streakDays: number;
  hasShieldCard: boolean;
}

/** Orchestration input. */
export interface FeedbackPipelineInput {
  /** Current dialog state (start with dialog.initialDialogState()). */
  dialogState: DialogState;
  /** This turn's user reply text. */
  userText: string;
  /** Current Bayesian calibration state. */
  calibrationState: CalibrationState;
  /** Current pet state snapshot. */
  pet: PetStateSnapshot;
  /** Calibration hyperparameters (optional overrides). */
  calibrationOptions?: CalibrationOptions;
  /** Feedback timestamp (optional, recorded in the calibration state). */
  recordedAt?: number;
}

/** Orchestration result (dialog + calibration + pet updates in one shot). */
export interface FeedbackPipelineResult {
  /** Advanced dialog state. */
  dialogState: DialogState;
  /** Next question ('' when done). */
  question: string;
  /** Whether this turn completed the loop (reached done). */
  completed: boolean;
  /** Converged post-meal feedback (null while incomplete). */
  feedback: MealFeedback | null;
  /** Bayesian calibration output (null while incomplete). */
  calibration: {
    state: CalibrationState;
    result: CalibrationResult;
    observation: number;
    gain: number;
  } | null;
  /** Pet settlement output (null while incomplete). */
  pet: PetReactionResult | null;
}

/**
 * Advance one closed-loop turn: dialog state machine → converge (theta, F) →
 * Bayesian calibration → pet settlement.
 * While the dialog has not reached done, only the advanced dialog state and
 * the next question are returned — no calibration / settlement is triggered.
 */
export function runFeedbackTurn(input: FeedbackPipelineInput): FeedbackPipelineResult {
  const action: DialogAction = { type: 'USER_REPLY', text: input.userText };
  const nextDialog = dialogReducer(input.dialogState, action);

  if (!isComplete(nextDialog)) {
    return {
      dialogState: nextDialog,
      question: questionForStage(nextDialog.stage),
      completed: false,
      feedback: null,
      calibration: null,
      pet: null
    };
  }

  // Converge (theta, F): followed advice → theta defaults to 1.0; F unrecognized → 0.
  const theta = nextDialog.theta != null ? nextDialog.theta : DEFAULT_THETA_WHEN_FOLLOWED;
  const F: -1 | 0 | 1 = nextDialog.F != null ? nextDialog.F : DEFAULT_F;
  const feedback: MealFeedback = { theta, F, recordedAt: input.recordedAt };

  // Bayesian incremental calibration (one-step pipeline: update + factor).
  const calib = calibrateAfterMeal(input.calibrationState, feedback, input.calibrationOptions);

  // Pet settlement.
  const pet = evaluatePetReaction({
    theta,
    F,
    currentLevel: input.pet.currentLevel,
    currentExp: input.pet.currentExp,
    streakDays: input.pet.streakDays,
    hasShieldCard: input.pet.hasShieldCard
  });

  return {
    dialogState: nextDialog,
    question: '',
    completed: true,
    feedback,
    calibration: {
      state: calib.state,
      result: calib.result,
      observation: calib.observation,
      gain: calib.gain
    },
    pet
  };
}
