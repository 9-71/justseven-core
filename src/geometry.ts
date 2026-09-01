/**
 * Plate geometry, relative volume & mass estimation — Algorithm I, plus
 * normalized-coordinate utilities.
 *
 * ## Model: plate-geometry distribution with prior baselines
 *
 *  1. Plate normalization & area share
 *
 *         AreaRatio_i = Area_i / Area_plate
 *
 *  2. Relative volume & volume contribution
 *
 *         V_score,i = K_i × AreaRatio_i × H_i        ω_i = V_score,i / Σ V_score,j
 *
 *  3. Food mass estimation
 *
 *         M_i = M_vlm,i                             if M_vlm ∈ [M_min, M_max]
 *         M_i = M_ref,plate × ω_i × ρ_i / ρ̄         otherwise (density-weighted)
 *
 *  4. Energy & macro summary
 *
 *         E_total = Σ M_i × C_i        Protein = Σ M_i × p_i        Fiber / Fat likewise
 *
 * ## Design boundary
 *
 * This module only estimates **relative shares** (normalized 0..1, no
 * absolute physical units). There is intentionally no pixel→millimetre
 * calibration: mass comes from the vision model directly, and the
 * density-weighted fallback is used only when the model mass is missing or
 * out of range.
 *
 * Pure module: no platform APIs, no `this`, no global state.
 */

import type {
  FoodCategory,
  FoodFormFactors,
  ImageFit,
  MacroDensity,
  MacroSummary,
  MassEstimate,
  NormalizedBox,
  NormalizedPoint,
  PixelBox,
  VolumeContribution
} from './types';

/* ==================== Numeric utilities ==================== */

/** Clamp to [min, max]; non-finite → min. */
export function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Round to a number of decimals (default 6). */
export function round(value: number, digits = 6): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

/* ==================== Density & form-factor tables (placeholders) ==================== */

/**
 * Per-100 g macro density by category (placeholder category-level medians;
 * extend or replace per deployment).
 */
export const MACRO_DENSITY: Readonly<Record<FoodCategory, MacroDensity>> = {
  carb: { kcalPer100g: 150, proteinG: 2.6, fiberG: 0.4, fatG: 0.4 },
  protein: { kcalPer100g: 190, proteinG: 22, fiberG: 0.0, fatG: 3.0 },
  veggie: { kcalPer100g: 35, proteinG: 2.0, fiberG: 1.6, fatG: 0.3 },
  soup: { kcalPer100g: 30, proteinG: 1.2, fiberG: 0.4, fatG: 0.5 },
  fried: { kcalPer100g: 320, proteinG: 15, fiberG: 1.0, fatG: 18 },
  dessert: { kcalPer100g: 380, proteinG: 4.0, fiberG: 0.5, fatG: 14 },
  other: { kcalPer100g: 200, proteinG: 6.0, fiberG: 3.0, fatG: 18 }
};

/** Macro density of a category, unknown → `other`. */
export function getMacroDensity(category: FoodCategory | ''): MacroDensity {
  return MACRO_DENSITY[category as FoodCategory] ?? MACRO_DENSITY.other;
}

/**
 * Food form factors (Algorithm I step 2):
 * - density (ρ_i): converts volume share → mass share
 * - shapeFactor (K_i): shape / stacking (liquids spread flat → small, fried → large)
 * - thickness (H_i): relative thickness weight
 */
export const FOOD_FORM_FACTORS: Readonly<Record<FoodCategory, FoodFormFactors>> = {
  carb: { density: 1.0, shapeFactor: 1.0, thickness: 1.0 },
  protein: { density: 0.95, shapeFactor: 1.1, thickness: 1.0 },
  veggie: { density: 0.5, shapeFactor: 0.7, thickness: 0.9 },
  soup: { density: 1.0, shapeFactor: 0.5, thickness: 0.6 },
  fried: { density: 0.6, shapeFactor: 1.2, thickness: 0.9 },
  dessert: { density: 0.8, shapeFactor: 0.9, thickness: 0.8 },
  other: { density: 0.9, shapeFactor: 1.0, thickness: 1.0 }
};

/** Form factors of a category, unknown → `other`. */
export function getFormFactors(category: FoodCategory | ''): FoodFormFactors {
  return FOOD_FORM_FACTORS[category as FoodCategory] ?? FOOD_FORM_FACTORS.other;
}

/** Prior baseline mass of a standard single-person plate (g). */
export const M_REF_PLATE = 450;

/** Trusted range of the vision-model prior mass [M_min, M_max] (g); out of range → density fallback. */
export const MASS_VLM_MIN = 50;
export const MASS_VLM_MAX = 500;

/* ==================== Normalized geometry ==================== */

/**
 * Normalized projected bbox area (width × height). Area is a 2-D projection
 * — it carries a systematic bias vs. true 3-D volume (unknown stacking
 * height) — so it is used only for relative comparison and visual scaling,
 * never converted to absolute mass.
 */
export function bboxAreaRatio(bbox: NormalizedBox | null | undefined): number {
  if (!bbox) return 0;
  const w = Number(bbox.width);
  const h = Number(bbox.height);
  if (!(w > 0) || !(h > 0)) return 0;
  return clamp(w * h, 0, 1);
}

/** bbox center (normalized). */
export function bboxCenter(bbox: NormalizedBox | null | undefined): NormalizedPoint {
  if (!bbox) return { x: 0.5, y: 0.5 };
  return {
    x: round(Number(bbox.x) + Number(bbox.width) / 2, 6),
    y: round(Number(bbox.y) + Number(bbox.height) / 2, 6)
  };
}

/**
 * AreaRatio_i = Area_i / Area_plate (Algorithm I step 1). When no plate
 * boundary was detected, degrades to the single component's projection area.
 */
export function areaRatioOnPlate(
  bbox: NormalizedBox | null | undefined,
  plateArea: number | null | undefined
): number {
  const area = bboxAreaRatio(bbox);
  if (!(area > 0)) return 0;
  const plate = Number(plateArea);
  if (!(plate > 0)) return area; // no plate boundary: return projection area
  return clamp(area / plate, 0, 1);
}

/**
 * Batch plate-area-share normalization (Algorithm I step 1): without an
 * explicit plate area, the sum of all projection areas acts as the plate.
 */
export function normalizeAreaRatios(
  bboxes: Array<NormalizedBox | null>,
  plateArea?: number | null
): number[] {
  const areas = bboxes.map((b) => bboxAreaRatio(b));
  let plate = Number(plateArea);
  if (!(plate > 0)) {
    plate = areas.reduce((sum, a) => sum + a, 0);
  }
  if (!(plate > 0)) return areas.map(() => 0);
  return areas.map((a) => clamp(a / plate, 0, 1));
}

/* ==================== Relative volume (Algorithm I step 2) ==================== */

/** Single-component volume score: V_score,i = K_i × AreaRatio_i × H_i. */
export function volumeScore(
  areaRatio: number,
  category: FoodCategory | ''
): number {
  const { shapeFactor, thickness } = getFormFactors(category);
  return shapeFactor * clamp(Number(areaRatio) || 0, 0, 1) * thickness;
}

/** Volume-contribution solution incl. area share (ω normalized separately). */
export function computeVolumeContribution(
  bbox: NormalizedBox | null,
  plateArea: number | null,
  category: FoodCategory | ''
): VolumeContribution {
  const areaRatio = areaRatioOnPlate(bbox, plateArea);
  const score = volumeScore(areaRatio, category);
  return { areaRatio, volumeScore: score, volumeShare: 0 };
}

/** Volume-share normalization: ω_i = V_score,i / Σ V_score,j (Σ ω = 1; all-zero → uniform). */
export function normalizeVolumeShares(volumeScores: number[]): number[] {
  const scores = volumeScores.map((v) => Math.max(0, Number(v) || 0));
  const sum = scores.reduce((s, v) => s + v, 0);
  if (!(sum > 0)) {
    return scores.map(() => (scores.length ? 1 / scores.length : 0));
  }
  return scores.map((v) => round(v / sum, 6));
}

/** Plate-wide weighted average density: ρ̄ = Σ (ω_j × ρ_j). */
export function weightedAverageDensity(
  volumeShares: number[],
  categories: Array<FoodCategory | ''>
): number {
  const total = volumeShares.reduce((sum, w, i) => {
    const { density } = getFormFactors(categories[i]);
    return sum + (Number(w) || 0) * density;
  }, 0);
  return total;
}

/* ==================== Mass estimation (Algorithm I step 3) ==================== */

/** Mass-estimation input (single component). */
export interface MassInput {
  category: FoodCategory | '';
  bbox: NormalizedBox | null;
  /** Vision-model prior mass (g), may be missing / invalid. */
  massVlm?: number | null;
}

/**
 * Batch mass estimation (Algorithm I step 3):
 *   M_i = M_vlm,i                            if M_vlm ∈ [M_min, M_max]
 *   M_i = M_ref,plate × ω_i × ρ_i / ρ̄        otherwise
 *
 * Needs whole-plate context (ω_i, ρ̄), so it solves all components at once.
 *
 * @param items components (bbox + model prior mass)
 * @param options { plateArea?, refMass?, massMin?, massMax? }
 * @returns { estimates, volumeShares, weightedDensity }
 */
export function estimateMasses(
  items: MassInput[],
  options: {
    plateArea?: number | null;
    refMass?: number;
    massMin?: number;
    massMax?: number;
  } = {}
): {
  estimates: MassEstimate[];
  volumeShares: number[];
  weightedDensity: number;
} {
  const list = items || [];
  const refMass = Number(options.refMass) > 0 ? Number(options.refMass) : M_REF_PLATE;
  const massMin = Number(options.massMin) > 0 ? Number(options.massMin) : MASS_VLM_MIN;
  const massMax = Number(options.massMax) > 0 ? Number(options.massMax) : MASS_VLM_MAX;

  const categories = list.map((it) => it.category);
  const areaRatios = normalizeAreaRatios(
    list.map((it) => it.bbox),
    options.plateArea
  );
  const volumeScores = areaRatios.map((ar, i) => volumeScore(ar, categories[i]));
  const volumeShares = normalizeVolumeShares(volumeScores);
  const rhoBar = weightedAverageDensity(volumeShares, categories);

  const estimates: MassEstimate[] = list.map((it, i) => {
    const massVlm = Number(it.massVlm);
    const withinRange = Number.isFinite(massVlm) && massVlm >= massMin && massVlm <= massMax;

    if (withinRange) {
      return { massG: round(massVlm, 1), source: 'vlm' };
    }

    // Density-weighted fallback: M_i = M_ref,plate × ω_i × ρ_i / ρ̄
    const { density } = getFormFactors(categories[i]);
    const share = Number(volumeShares[i]) || 0;
    const massG =
      rhoBar > 0 ? refMass * share * (density / rhoBar) : refMass * share;
    return { massG: round(Math.max(0, massG), 1), source: 'density' };
  });

  return { estimates, volumeShares, weightedDensity: round(rhoBar, 4) };
}

/* ==================== Macro summary (Algorithm I step 4) ==================== */

/** Macro-summary input (single component, mass already resolved). */
export interface MacroInput {
  category: FoodCategory | '';
  massG: number;
}

/**
 * Whole-plate energy & macro totals (Algorithm I step 4):
 *   E_total = Σ M_i × C_i        Protein = Σ M_i × p_i        Fiber / Fat likewise
 * where C_i = kcalPer100g / 100, p_i = proteinG / 100, etc.
 */
export function estimateMacros(items: MacroInput[]): MacroSummary {
  let totalKcal = 0;
  let proteinG = 0;
  let fiberG = 0;
  let fatG = 0;

  (items || []).forEach((it) => {
    const mass = Number(it.massG);
    if (!(mass > 0)) return;
    const macro = getMacroDensity(it.category);
    totalKcal += (mass * macro.kcalPer100g) / 100;
    proteinG += (mass * macro.proteinG) / 100;
    fiberG += (mass * macro.fiberG) / 100;
    fatG += (mass * macro.fatG) / 100;
  });

  return {
    totalKcal: round(totalKcal, 1),
    proteinG: round(proteinG, 1),
    fiberG: round(fiberG, 1),
    fatG: round(fatG, 1)
  };
}

/* ==================== Area ratio → visual radius ==================== */

/**
 * Linear radius scale for a proportional area shrink: R_rec = R_actual × √P
 * (visual area πR² corresponds to the ratio P).
 */
export function areaRatioToRadiusScale(ratio: number): number {
  const safe = clamp(Number(ratio) || 0, 0, 1);
  return Math.sqrt(safe);
}

/**
 * Recommended circle radius from a bbox and keep ratio:
 * R_rec = min(w,h)/2 × √keep (normalized, relative to the short edge).
 */
export function recommendedRadiusFromBox(bbox: NormalizedBox, keepRatio: number): number {
  const w = Number(bbox && bbox.width) || 0;
  const h = Number(bbox && bbox.height) || 0;
  const base = Math.min(w, h) / 2;
  return round(base * areaRatioToRadiusScale(keepRatio), 6);
}

/* ==================== Typical single-serving table ==================== */

/** Typical single-serving mass (g) per category (placeholder medians). */
export const TYPICAL_SERVING_G: Readonly<Record<FoodCategory, number>> = {
  carb: 200,
  protein: 120,
  veggie: 200,
  soup: 250,
  fried: 100,
  dessert: 100,
  other: 150
};

/** Typical single-serving mass of a category, unknown → `other`. */
export function getTypicalServingG(category: FoodCategory | ''): number {
  return TYPICAL_SERVING_G[category as FoodCategory] ?? TYPICAL_SERVING_G.other;
}

/* ==================== Relative portion tiers ==================== */

/** Qualitative portion descriptions (five tiers). */
export const AMOUNT_LABELS = Object.freeze([
  'tiny portion',
  'small portion',
  'regular serving',
  'large serving',
  'extra-large serving'
]) as readonly string[];

/** Portion ratio relative to a typical single serving: ratio = massG / typicalServingG. */
export function relativePortionRatio(massG: number, typicalServingG: number): number {
  const mass = Number(massG);
  const base = Number(typicalServingG);
  if (!Number.isFinite(mass) || mass <= 0 || !(base > 0)) return NaN;
  return mass / base;
}

/** Relative portion ratio → qualitative tier label (thresholds 0.35 / 0.75 / 1.35 / 2.0). */
export function toAmountLabel(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return AMOUNT_LABELS[2];

  if (ratio < 0.35) return AMOUNT_LABELS[0];
  if (ratio < 0.75) return AMOUNT_LABELS[1];
  if (ratio < 1.35) return AMOUNT_LABELS[2];
  if (ratio < 2.0) return AMOUNT_LABELS[3];
  return AMOUNT_LABELS[4];
}

/** Convenience: mass + category → qualitative portion label. */
export function amountLabelForItem(massG: number, category: FoodCategory | ''): string {
  const ratio = relativePortionRatio(massG, getTypicalServingG(category));
  return toAmountLabel(ratio);
}

/** Plate share of a component: its projection-area share (not a mass share). */
export function plateShareRatio(bbox: NormalizedBox | null | undefined): number {
  return bboxAreaRatio(bbox);
}

/* ==================== Pixel <-> normalized mapping ==================== */

/**
 * Pixel rectangle → normalized rectangle.
 * @param rect pixel rect
 * @param size image pixel size
 */
export function normalizeRect(
  rect: PixelBoxLike,
  size: { width: number; height: number }
): NormalizedBox {
  if (!rect || !size || !size.width || !size.height) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const x = clamp(rect.x / size.width);
  const y = clamp(rect.y / size.height);

  return {
    x: round(x),
    y: round(y),
    width: round(clamp(rect.width / size.width, 0, 1 - x)),
    height: round(clamp(rect.height / size.height, 0, 1 - y))
  };
}

/** Minimal pixel rectangle shape. */
export interface PixelBoxLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Normalized rectangle → pixel rectangle. */
export function denormalizeRect(
  rect: NormalizedBox,
  size: { width: number; height: number }
): PixelBox {
  if (!rect || !size) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return {
    x: Math.round(rect.x * size.width),
    y: Math.round(rect.y * size.height),
    width: Math.round(rect.width * size.width),
    height: Math.round(rect.height * size.height)
  };
}

/** Normalized rectangle center. */
export function rectCenter(rect: NormalizedBox): NormalizedPoint {
  return {
    x: round(rect.x + rect.width / 2),
    y: round(rect.y + rect.height / 2)
  };
}

/**
 * Camera frame position → normalized ROI (interest region). The preview is
 * aspectFill-cropped; this maps ratios only, no perspective correction.
 * Falls back to the central 80% when inputs are invalid.
 */
export function frameToNormalizedROI(
  frame: PixelBoxLike | null | undefined,
  viewport: { width: number; height: number } | null | undefined
): NormalizedBox {
  if (!frame || !viewport || !viewport.width || !viewport.height) {
    return { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
  }

  const width = clamp(frame.width / viewport.width, 0, 1);
  const height = clamp(frame.height / viewport.height, 0, 1);

  return {
    x: round((1 - width) / 2),
    y: round((1 - height) / 2),
    width: round(width),
    height: round(height)
  };
}

/**
 * Actual rendered region of an image inside a container (scale + offset).
 *
 * Normalized bboxes are relative to the *original image*, while an <image>
 * scaled with aspectFill / aspectFit is both scaled and offset inside the
 * container — multiplying normalized coordinates by the container size
 * directly would misplace every ring when aspect ratios differ.
 *
 * aspectFill: short edge fills, long edge overflows & center-crops → scale = max(ratio), negative offset
 * aspectFit : long edge fills, short edge letterboxes → scale = min(ratio), positive offset
 */
export function calcImageFit(
  imageSize: { width: number; height: number } | null | undefined,
  containerSize: { width: number; height: number } | null | undefined,
  mode: 'aspectFill' | 'aspectFit' | 'scaleToFill' = 'aspectFill'
): ImageFit | null {
  const iw = Number(imageSize && imageSize.width);
  const ih = Number(imageSize && imageSize.height);
  const cw = Number(containerSize && containerSize.width);
  const ch = Number(containerSize && containerSize.height);

  if (!(iw > 0) || !(ih > 0) || !(cw > 0) || !(ch > 0)) return null;

  // scaleToFill stretches freely; the two axes are independent.
  if (mode === 'scaleToFill') {
    return {
      scaleX: cw / iw,
      scaleY: ch / ih,
      offsetX: 0,
      offsetY: 0,
      drawWidth: cw,
      drawHeight: ch
    };
  }

  const ratioW = cw / iw;
  const ratioH = ch / ih;
  const scale = mode === 'aspectFit' ? Math.min(ratioW, ratioH) : Math.max(ratioW, ratioH);

  const drawWidth = iw * scale;
  const drawHeight = ih * scale;

  return {
    scaleX: scale,
    scaleY: scale,
    // Centered: negative when overflowing (crop), positive when letterboxing.
    offsetX: round((cw - drawWidth) / 2, 4),
    offsetY: round((ch - drawHeight) / 2, 4),
    drawWidth: round(drawWidth, 4),
    drawHeight: round(drawHeight, 4)
  };
}

/**
 * Normalized point → container pixel point, applying the aspectFill/Fit
 * scale & offset.
 */
export function mapNormalizedPoint(
  point: NormalizedPoint,
  fit: ImageFit | null | undefined
): NormalizedPoint {
  if (!fit) return { x: 0, y: 0 };

  return {
    x: round(fit.offsetX + (Number(point.x) || 0) * fit.drawWidth, 3),
    y: round(fit.offsetY + (Number(point.y) || 0) * fit.drawHeight, 3)
  };
}

/**
 * Normalized radius → pixel radius. Scaled against the rendered image's
 * short edge so the circle stays visually round and keeps its relative size.
 */
export function mapNormalizedRadius(r: number, fit: ImageFit | null | undefined): number {
  if (!fit) return 0;
  const base = Math.min(fit.drawWidth, fit.drawHeight);
  return round(Math.max(0, Number(r) || 0) * base, 3);
}
