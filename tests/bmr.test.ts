import { describe, expect, it } from 'vitest';
import {
  calcBMR,
  computeMealCalorieBaseline,
  computeMealTargetBand,
  computeUserCalorieBaseline,
  safeCalcBMR,
  validateBMRInput
} from '../src/bmr';

describe('validateBMRInput', () => {
  it('accepts a valid male profile', () => {
    expect(validateBMRInput({ gender: 'male', age: 28, height: 175, weight: 70 }).valid).toBe(true);
  });

  it('rejects each invalid field', () => {
    expect(validateBMRInput({ gender: 'x', age: 28, height: 175, weight: 70 }).valid).toBe(false);
    expect(validateBMRInput({ gender: 'male', age: 0, height: 175, weight: 70 }).valid).toBe(false);
    expect(validateBMRInput({ gender: 'male', age: 28, height: NaN, weight: 70 }).valid).toBe(false);
    expect(validateBMRInput({ gender: 'male', age: 28, height: 175, weight: -1 }).valid).toBe(false);
  });
});

describe('calcBMR (Mifflin-St Jeor)', () => {
  it('computes the male BMR', () => {
    // 10×70 + 6.25×175 − 5×28 + 5 = 1658.75 → 1659
    expect(calcBMR({ gender: 'male', age: 28, height: 175, weight: 70 })).toBe(1659);
  });

  it('computes the female BMR with the −161 offset', () => {
    // 700 + 1093.75 − 140 − 161 = 1492.75 → 1493
    expect(calcBMR({ gender: 'female', age: 28, height: 175, weight: 70 })).toBe(1493);
  });

  it('throws on invalid input, safeCalcBMR falls back', () => {
    expect(() => calcBMR({ gender: 'male', age: 0, height: 175, weight: 70 })).toThrow();
    expect(safeCalcBMR({ gender: 'male', age: 0, height: 175, weight: 70 }, 1500)).toBe(1500);
    expect(safeCalcBMR({ gender: 'male', age: 0, height: 175, weight: 70 })).toBe(0);
  });
});

describe('computeMealCalorieBaseline', () => {
  it('applies the 0.32 budget ratio and the 0.7 seven-tenths target', () => {
    // 1500 × 0.32 = 480; 480 × 0.7 = 336
    expect(computeMealCalorieBaseline(1500)).toEqual({ mealBudgetKcal: 480, targetKcal: 336 });
  });

  it('falls back to 1500 for invalid BMR', () => {
    expect(computeMealCalorieBaseline(NaN)).toEqual({ mealBudgetKcal: 480, targetKcal: 336 });
    expect(computeMealCalorieBaseline(-5)).toEqual({ mealBudgetKcal: 480, targetKcal: 336 });
  });
});

describe('computeMealTargetBand', () => {
  it('computes the ±5% elastic band', () => {
    expect(computeMealTargetBand(1500)).toEqual({ targetKcal: 480, minKcal: 456, maxKcal: 504 });
  });

  it('applies the weight-goal factor G', () => {
    expect(computeMealTargetBand(1500, 'lose')).toEqual({ targetKcal: 408, minKcal: 388, maxKcal: 428 });
    expect(computeMealTargetBand(1500, 'gain')).toEqual({ targetKcal: 552, minKcal: 524, maxKcal: 580 });
  });

  it('caps the band span at 100 kcal for extreme BMRs', () => {
    // 6000 × 0.32 = 1920; ±5% span = 192 > 100 → recenter to ±50.
    expect(computeMealTargetBand(6000)).toEqual({ targetKcal: 1920, minKcal: 1870, maxKcal: 1970 });
  });
});

describe('computeUserCalorieBaseline', () => {
  it('computes the full pipeline from a profile', () => {
    const result = computeUserCalorieBaseline({ gender: 'male', age: 28, height: 175, weight: 70 });
    expect(result.bmr).toBe(1659);
    expect(result.mealBudgetKcal).toBe(530.9); // 1659 × 0.32 = 530.88 → 530.9
    expect(result.targetKcal).toBe(371.6); // 530.88 × 0.7 = 371.616 → 371.6
  });

  it('reuses profile.bmr when present', () => {
    const result = computeUserCalorieBaseline({ gender: 'male', age: 28, height: 175, weight: 70, bmr: 2000 });
    expect(result.bmr).toBe(2000);
    expect(result.mealBudgetKcal).toBe(640);
    expect(result.targetKcal).toBe(448);
  });
});
