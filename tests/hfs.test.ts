import { describe, expect, it } from 'vitest';
import {
  allocateFlexibleQuota,
  buildHfsSummary,
  calcItemKcal,
  calcKcal,
  computeDynamicTarget,
  computeEnergyRatio,
  computeHfsRatio,
  computeRBase,
  computeRecommendedRatio,
  fuseRatios,
  predictHfs,
  snapPortion,
  toPortionAdvice
} from '../src/hfs';

/** Typical macros used across tests: E=600, P=30, F=5, Fat=20 → ĤFS = 6.1. */
const TYPICAL_MACROS = { totalKcal: 600, proteinG: 30, fiberG: 5, fatG: 20 };

describe('predictHfs (fullness regression)', () => {
  it('reproduces the documented sanity check ≈ 6.1', () => {
    // 3 + 0.003×600 + 0.05×30 + 0.08×5 − 0.03×20 = 3 + 1.8 + 1.5 + 0.4 − 0.6 = 6.1
    expect(predictHfs(TYPICAL_MACROS)).toBeCloseTo(6.1, 10);
  });

  it('is driven up by protein & fiber, down by fat', () => {
    const moreProtein = predictHfs({ ...TYPICAL_MACROS, proteinG: 60 });
    expect(moreProtein).toBeGreaterThan(predictHfs(TYPICAL_MACROS));
    const moreFat = predictHfs({ ...TYPICAL_MACROS, fatG: 60 });
    expect(moreFat).toBeLessThan(predictHfs(TYPICAL_MACROS));
  });
});

describe('computeHfsRatio (seven-tenths-full constraint)', () => {
  it('solves ĤFS(r_H) = HFS*', () => {
    // (7 − 3) / (0.003×600 + 0.05×30 + 0.08×5 − 0.03×20) = 4 / 3.1 = 1.2903
    expect(computeHfsRatio(TYPICAL_MACROS)).toBeCloseTo(1.2903, 4);
  });

  it('clamps to rMin for very heavy plates', () => {
    expect(computeHfsRatio({ totalKcal: 3000, proteinG: 100, fiberG: 30, fatG: 50 })).toBe(0.3);
  });

  it('returns rMax when the denominator is non-positive', () => {
    expect(computeHfsRatio({ totalKcal: 0, proteinG: 0, fiberG: 0, fatG: 0 })).toBe(1.3);
  });
});

describe('computeDynamicTarget', () => {
  it('raises the target when recent fullness is below HFS*', () => {
    // 480 × (1 + 0.1×(7−5)/1) = 576
    expect(computeDynamicTarget(480, 5)).toBe(576);
  });

  it('lowers the target when recent fullness is above HFS*', () => {
    expect(computeDynamicTarget(480, 9)).toBe(384);
  });

  it('clamps to the default [70%, 130%] window', () => {
    // 480 × (1 + 0.1×7) = 816 → clamped to 480×1.3 = 624
    expect(computeDynamicTarget(480, 0)).toBe(624);
  });

  it('honours a custom omega', () => {
    expect(computeDynamicTarget(480, 5, { omega: 0.05 })).toBe(528);
  });
});

describe('energy ratios', () => {
  it('computes the pure r_E', () => {
    expect(computeEnergyRatio(480, 600)).toBeCloseTo(0.8, 10);
    expect(computeEnergyRatio(480, 0)).toBe(1);
  });

  it('clamps r_base to [0.3, 1]', () => {
    expect(computeRBase(600, 480)).toBeCloseTo(0.8, 4);
    expect(computeRBase(200, 480)).toBe(1);
    expect(computeRBase(4800, 480)).toBe(0.3);
  });

  it('fuses r_E and r_H with alpha', () => {
    expect(fuseRatios(0.8, 1.0, 0.5)).toBe(0.9);
    expect(fuseRatios(0.8, 1.0, 0)).toBe(0.8); // alpha 0 is valid!
    expect(fuseRatios(0.8, 1.0, 1)).toBe(1);
  });

  it('runs the full 3→5 pipeline', () => {
    const { rE, rH, rBase } = computeRecommendedRatio(480, 600, TYPICAL_MACROS);
    expect(rE).toBeCloseTo(0.8, 4);
    expect(rH).toBeCloseTo(1.2903, 4);
    expect(rBase).toBeCloseTo((0.8 + 1.2903) / 2, 4);
  });
});

describe('allocateFlexibleQuota', () => {
  const items = [
    { id: 'rice', kcal: 300, category: 'carb' as const },
    { id: 'fried', kcal: 320, category: 'fried' as const }
  ];

  it('keeps everything at 1.0 under budget', () => {
    const result = allocateFlexibleQuota(items, 700);
    expect(result.keepById).toEqual({ rice: 1, fried: 1 });
    expect(result.reducedKcal).toBe(0);
    expect(result.capped).toBe(false);
  });

  it('cuts fried food more than staples when over budget', () => {
    const result = allocateFlexibleQuota(items, 400); // total 620, need 220
    expect(result.reducedKcal).toBeCloseTo(220, 0);
    expect(result.keepById.fried).toBeLessThan(result.keepById.rice);
    expect(result.keepById.fried).toBeCloseTo(0.5179, 2);
    expect(result.keepById.rice).toBeCloseTo(0.7809, 2);
    expect(result.shortfallKcal).toBe(0);
    expect(result.capped).toBe(false);
  });

  it('accepts a shortfall when every item hits its floor', () => {
    const result = allocateFlexibleQuota(items, 100); // need 520 > maxCut 374
    expect(result.keepById.rice).toBe(0.5);
    expect(result.keepById.fried).toBe(0.3);
    expect(result.capped).toBe(true);
    expect(result.shortfallKcal).toBeCloseTo(146, 0);
  });

  it('keeps zero-energy items fully and excludes them from the split', () => {
    const withZero = [...items, { id: 'soup', kcal: 0, category: 'soup' as const }];
    const result = allocateFlexibleQuota(withZero, 400);
    expect(result.keepById.soup).toBe(1);
  });
});

describe('portion helpers', () => {
  it('snaps portion multipliers to the 4 steps', () => {
    expect(snapPortion(1.05)).toBe(1.0);
    expect(snapPortion(1.4)).toBe(1.5);
    expect(snapPortion(NaN)).toBe(1.0);
  });

  it('maps keep ratios to natural-language advice', () => {
    expect(toPortionAdvice(0.9)).toMatchObject({ fraction: '1', shrink: false });
    expect(toPortionAdvice(0.8)).toMatchObject({ fraction: '4/5', shrink: true });
    expect(toPortionAdvice(0.6)).toMatchObject({ fraction: '2/3', shrink: true });
    expect(toPortionAdvice(0.5)).toMatchObject({ fraction: '1/2', shrink: true });
    expect(toPortionAdvice(0.2)).toMatchObject({ fraction: '1/3', shrink: true });
  });

  it('computes item energy', () => {
    expect(calcKcal(200, 150)).toBe(300);
    expect(calcItemKcal(200, 150, 1.2)).toBe(360); // 200 × 1.2 × 1.5
  });
});

describe('buildHfsSummary', () => {
  it('aggregates an over-budget meal', () => {
    const result = buildHfsSummary(
      [
        { id: 'rice', kcal: 300, category: 'carb' },
        { id: 'fried', kcal: 320, category: 'fried' }
      ],
      400
    );
    expect(result.totalKcal).toBe(620);
    expect(result.withinBudget).toBe(false);
    expect(result.overBudget).toBe(true);
    expect(result.circleCount).toBe(2);
    expect(result.recommendedKcal).toBeCloseTo(400, 0);
    expect(result.keepOverall).toBeCloseTo(400 / 620, 4);
    expect(result.rBasePercent).toBe(Math.round((400 / 620) * 100));
  });
});
