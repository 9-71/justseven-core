import { describe, expect, it } from 'vitest';
import {
  areaRatioToRadiusScale,
  bboxAreaRatio,
  bboxCenter,
  calcImageFit,
  clamp,
  denormalizeRect,
  estimateMacros,
  estimateMasses,
  frameToNormalizedROI,
  mapNormalizedPoint,
  mapNormalizedRadius,
  normalizeAreaRatios,
  normalizeRect,
  normalizeVolumeShares,
  recommendedRadiusFromBox,
  relativePortionRatio,
  round,
  toAmountLabel
} from '../src/geometry';

describe('numeric utilities', () => {
  it('clamps to [0, 1] and rounds', () => {
    expect(clamp(-1)).toBe(0);
    expect(clamp(2)).toBe(1);
    expect(clamp(0.5)).toBe(0.5);
    expect(round(1.23456, 2)).toBe(1.23);
  });
});

describe('rect <-> normalized mapping', () => {
  const size = { width: 200, height: 100 };
  const rect = { x: 10, y: 20, width: 100, height: 50 };

  it('normalizeRect maps pixels to 0..1', () => {
    expect(normalizeRect(rect, size)).toEqual({ x: 0.05, y: 0.2, width: 0.5, height: 0.5 });
  });

  it('denormalizeRect round-trips back to pixels', () => {
    expect(denormalizeRect(normalizeRect(rect, size), size)).toEqual(rect);
  });

  it('clamps normalized rects into the unit square', () => {
    const out = normalizeRect({ x: 180, y: 90, width: 100, height: 50 }, size);
    expect(out.x + out.width).toBeLessThanOrEqual(1);
    expect(out.y + out.height).toBeLessThanOrEqual(1);
  });
});

describe('bbox geometry', () => {
  it('computes projection area and center', () => {
    expect(bboxAreaRatio({ x: 0.2, y: 0.2, width: 0.5, height: 0.5 })).toBe(0.25);
    expect(bboxCenter({ x: 0.2, y: 0.2, width: 0.5, height: 0.5 })).toEqual({ x: 0.45, y: 0.45 });
    expect(bboxAreaRatio(null)).toBe(0);
  });

  it('normalizes area ratios against the summed projection area', () => {
    const bboxes = [
      { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, // area 0.25
      { x: 0.1, y: 0.6, width: 0.25, height: 0.25 } // area 0.0625
    ];
    const ratios = normalizeAreaRatios(bboxes);
    expect(ratios[0]).toBeCloseTo(0.8, 6);
    expect(ratios[1]).toBeCloseTo(0.2, 6);
  });

  it('falls back to uniform shares for all-zero volumes', () => {
    expect(normalizeVolumeShares([0, 0])).toEqual([0.5, 0.5]);
  });
});

describe('estimateMasses', () => {
  const items = [
    { category: 'carb' as const, bbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, massVlm: 200 },
    { category: 'veggie' as const, bbox: { x: 0.1, y: 0.6, width: 0.25, height: 0.25 }, massVlm: null }
  ];

  it('uses the VLM prior mass when inside the trusted range', () => {
    const { estimates } = estimateMasses(items);
    expect(estimates[0]).toEqual({ massG: 200, source: 'vlm' });
  });

  it('falls back to the density-weighted estimate otherwise', () => {
    const { estimates } = estimateMasses(items);
    expect(estimates[1].source).toBe('density');
    // M = 450 × ω × ρ_i/ρ̄ with ω = 0.136069, ρ̄ = 0.9319655 → 32.85 → 32.9 g
    expect(estimates[1].massG).toBeCloseTo(32.9, 1);
  });

  it('applies the trust range options', () => {
    const { estimates } = estimateMasses(items, { massMin: 150, massMax: 180 });
    expect(estimates[0].source).toBe('density'); // 200 now out of range
  });
});

describe('estimateMacros', () => {
  it('sums energy and macros by category density', () => {
    const summary = estimateMacros([
      { category: 'carb', massG: 200 },
      { category: 'veggie', massG: 100 }
    ]);
    expect(summary.totalKcal).toBeCloseTo(335, 1); // 200×1.5 + 100×0.35
    expect(summary.proteinG).toBeCloseTo(7.2, 1); // 5.2 + 2.0
    expect(summary.fiberG).toBeCloseTo(2.4, 1); // 0.8 + 1.6
    expect(summary.fatG).toBeCloseTo(1.1, 1); // 0.8 + 0.3
  });
});

describe('radius scaling', () => {
  it('shrinks the linear radius by √P', () => {
    expect(areaRatioToRadiusScale(0.25)).toBe(0.5);
    expect(areaRatioToRadiusScale(1)).toBe(1);
  });

  it('computes R_rec = min(w,h)/2 × √keep', () => {
    expect(recommendedRadiusFromBox({ x: 0, y: 0, width: 0.4, height: 0.8 }, 0.25)).toBe(0.1);
  });
});

describe('portion labels', () => {
  it('maps relative ratios to five qualitative tiers', () => {
    expect(relativePortionRatio(200, 200)).toBe(1);
    expect(toAmountLabel(0.2)).toBe('tiny portion');
    expect(toAmountLabel(0.5)).toBe('small portion');
    expect(toAmountLabel(1.0)).toBe('regular serving');
    expect(toAmountLabel(1.5)).toBe('large serving');
    expect(toAmountLabel(2.5)).toBe('extra-large serving');
  });
});

describe('image fit mapping', () => {
  const image = { width: 1000, height: 500 };
  const container = { width: 500, height: 500 };

  it('aspectFill overflows & centers with a negative offset', () => {
    const fit = calcImageFit(image, container, 'aspectFill')!;
    expect(fit.scaleX).toBe(1);
    expect(fit.offsetX).toBe(-250);
    expect(fit.drawWidth).toBe(1000);
  });

  it('aspectFit letterboxes with a positive offset', () => {
    const fit = calcImageFit(image, container, 'aspectFit')!;
    expect(fit.scaleX).toBe(0.5);
    expect(fit.offsetY).toBe(125);
    expect(fit.drawWidth).toBe(500);
  });

  it('scaleToFill stretches both axes independently', () => {
    const fit = calcImageFit(image, container, 'scaleToFill')!;
    expect(fit.scaleX).toBe(0.5);
    expect(fit.scaleY).toBe(1);
  });

  it('maps normalized points and radii into the container', () => {
    const fit = calcImageFit(image, container, 'aspectFit')!;
    expect(mapNormalizedPoint({ x: 0.5, y: 0.5 }, fit)).toEqual({ x: 250, y: 250 });
    expect(mapNormalizedRadius(0.5, fit)).toBe(125); // 0.5 × min(500, 250)
  });

  it('returns null for invalid sizes', () => {
    expect(calcImageFit(null, container)).toBeNull();
  });
});

describe('frameToNormalizedROI', () => {
  it('centers the ROI', () => {
    const roi = frameToNormalizedROI({ x: 0, y: 0, width: 400, height: 400 }, { width: 800, height: 600 });
    expect(roi.x).toBe(0.25);
    expect(roi.y).toBeCloseTo(0.166667, 6);
    expect(roi.width).toBe(0.5);
    expect(roi.height).toBeCloseTo(0.666667, 6);
  });

  it('falls back to the central 80% for invalid input', () => {
    expect(frameToNormalizedROI(null, null)).toEqual({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
  });
});
