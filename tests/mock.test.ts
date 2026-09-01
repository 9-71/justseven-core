import { describe, expect, it } from 'vitest';
import {
  buildMockQuotaItem,
  lookupMockFood,
  mockFoodData,
  mockUserProfile
} from '../src/mock';
import { calcBMR } from '../src/bmr';

describe('mockFoodData', () => {
  it('ships a lightweight dish set only', () => {
    expect(mockFoodData.length).toBeGreaterThanOrEqual(6);
    expect(mockFoodData.every((d) => d.kcalPer100g > 0)).toBe(true);
  });

  it('looks dishes up case-insensitively', () => {
    expect(lookupMockFood('Steamed Rice')?.category).toBe('carb');
    expect(lookupMockFood('no-such-dish')).toBeNull();
  });

  it('builds quota items with computed energy', () => {
    const item = buildMockQuotaItem('grilled chicken breast', 120);
    expect(item.category).toBe('protein');
    expect(item.kcal).toBeCloseTo(198, 1); // 120 × 165 / 100
  });

  it('defaults the mass to the typical serving', () => {
    const item = buildMockQuotaItem('steamed rice');
    expect(item.kcal).toBeCloseTo(260, 1); // 200 × 130 / 100
  });

  it('throws for unknown dishes', () => {
    expect(() => buildMockQuotaItem('unknown')).toThrow();
  });
});

describe('mockUserProfile', () => {
  it('yields a known BMR', () => {
    expect(calcBMR(mockUserProfile)).toBe(1659);
  });
});
