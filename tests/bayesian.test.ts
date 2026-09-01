import { describe, expect, it } from 'vitest';
import {
  applyCalibration,
  buildObservation,
  calibrateAfterMeal,
  computeCalibrationFactor,
  createInitialState,
  recordFeedback
} from '../src/bayesian';
import type { CalibrationState } from '../src/types';

const initialState = createInitialState();

describe('createInitialState', () => {
  it('starts at c_0 ~ N(1.0, 0.25) with no meals', () => {
    expect(initialState).toEqual({ mean: 1.0, variance: 0.25, mealCount: 0, lastRecordedAt: null });
  });
});

describe('buildObservation', () => {
  it('y = θ·(1 − λF): no satiety adjustment when F = 0', () => {
    expect(buildObservation(1.0, 0)).toBe(1.0);
  });

  it('widens the observation when under-fed (F = −1)', () => {
    expect(buildObservation(1.0, -1)).toBeCloseTo(1.08, 10); // 1 × (1 + 0.08)
  });

  it('narrows the observation when stuffed (F = +1)', () => {
    expect(buildObservation(1.0, 1)).toBeCloseTo(0.92, 10); // 1 × (1 − 0.08)
  });

  it('clamps theta to [0, 1.5]', () => {
    expect(buildObservation(2, 0)).toBe(1.5);
    expect(buildObservation(-1, 0)).toBe(0);
  });
});

describe('recordFeedback (one Kalman step)', () => {
  it('applies K = s²/(s²+τ²), m′ = m + K(y−m), s′² = (1−K)s²', () => {
    const { state, observation, gain } = recordFeedback(initialState, { theta: 1.1, F: 0 });
    // K = 0.25/0.45 = 0.5556
    expect(gain).toBeCloseTo(0.5556, 4);
    // m′ = 1 + 0.5556 × 0.1 = 1.0556
    expect(state.mean).toBeCloseTo(1.0556, 4);
    // s′² = 0.4444 × 0.25 = 0.1111
    expect(state.variance).toBeCloseTo(0.1111, 4);
    expect(state.mealCount).toBe(1);
    expect(observation).toBeCloseTo(1.1, 4);
  });

  it('gain decreases monotonically as uncertainty shrinks', () => {
    let state = initialState;
    const gains: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const step = recordFeedback(state, { theta: 1.0, F: 0 });
      gains.push(step.gain);
      state = step.state;
    }
    for (let i = 1; i < gains.length; i += 1) {
      expect(gains[i]).toBeLessThan(gains[i - 1]);
    }
  });
});

describe('convergence', () => {
  it('converges toward the true intake ratio over many meals', () => {
    let state = initialState;
    for (let i = 0; i < 50; i += 1) {
      state = recordFeedback(state, { theta: 1.1, F: 0 }).state;
    }
    const result = computeCalibrationFactor(state);
    expect(result.factor).toBeCloseTo(1.1, 2);
    expect(state.variance).toBeLessThan(0.01); // uncertainty collapsed
  });
});

describe('computeCalibrationFactor', () => {
  it('clips the posterior mean to [cMin, cMax]', () => {
    const high: CalibrationState = { mean: 2.0, variance: 0.1, mealCount: 3, lastRecordedAt: null };
    const low: CalibrationState = { mean: 0.4, variance: 0.1, mealCount: 3, lastRecordedAt: null };
    expect(computeCalibrationFactor(high).factor).toBe(1.2);
    expect(computeCalibrationFactor(low).factor).toBe(0.8);
  });

  it('applies the ±0.05 hysteresis to the direction verdict', () => {
    const mk = (mean: number): CalibrationState => ({ mean, variance: 0.1, mealCount: 1, lastRecordedAt: null });
    expect(computeCalibrationFactor(mk(1.03)).direction).toBe('hold');
    expect(computeCalibrationFactor(mk(0.97)).direction).toBe('hold');
    expect(computeCalibrationFactor(mk(1.06)).direction).toBe('up');
    expect(computeCalibrationFactor(mk(0.9)).direction).toBe('down');
  });

  it('reports gain = 0 on the pure-read path', () => {
    expect(computeCalibrationFactor(initialState).gain).toBe(0);
  });
});

describe('applyCalibration', () => {
  it('scales r_base by the factor: r_rec = c·r_base', () => {
    expect(applyCalibration(0.8, 1.1)).toBeCloseTo(0.88, 4);
  });

  it('clamps the result to [0.3, 1]', () => {
    expect(applyCalibration(0.2, 1.5)).toBe(0.3);
    expect(applyCalibration(0.9, 1.5)).toBe(1);
  });

  it('treats a non-finite factor as 1', () => {
    expect(applyCalibration(0.8, NaN)).toBe(0.8);
  });
});

describe('calibrateAfterMeal (one-step pipeline)', () => {
  it('returns state + observation + gain + full result in one shot', () => {
    const out = calibrateAfterMeal(initialState, { theta: 1.1, F: 0 });
    expect(out.state.mealCount).toBe(1);
    expect(out.gain).toBeGreaterThan(0);
    expect(out.observation).toBeCloseTo(1.1, 4);
    expect(out.result.factor).toBeCloseTo(out.state.mean, 4);
    expect(out.result.gain).toBe(out.gain);
    // The initial state must not be mutated.
    expect(initialState.mealCount).toBe(0);
  });
});
