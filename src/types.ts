/**
 * justseven-core — core data structures & API contracts.
 *
 * This file is the single source of truth for all input/output types shared by
 * the engine modules (`bmr`, `hfs`, `bayesian`, `geometry`, `dialog`, `pet`,
 * `pipeline`). Every module is a **pure function set** with zero external
 * side effects: no platform APIs (wx.* / DOM / cloud), no network, no global
 * mutable state. All modules run identically in Node, browser workers, server
 * runtimes, or unit tests.
 *
 * Conventions:
 * - `bbox` is always the object form `{x, y, width, height}` in normalized
 *   coordinates (0..1, origin at top-left). Array form `[ymin, xmin, ymax,
 *   xmax]` from detectors must be converted **before** entering this layer.
 * - A missing `category` is the empty string `''` (i.e. "not recognized").
 *   Consumers may look it up by dish name; never fabricate `'other'` — that
 *   is a real vocabulary category.
 */

/* ==================== Primitive scalars & geometry ==================== */

/** Food macro-category used by the engine. */
export type FoodCategory =
  | 'carb' // staple / carbohydrates
  | 'protein' // meat & protein
  | 'veggie' // vegetables
  | 'soup' // soups & liquids
  | 'fried' // fried food
  | 'dessert' // dessert / sugary
  | 'other';

/** Normalized bounding box (0..1, origin top-left). */
export interface NormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Normalized point. */
export interface NormalizedPoint {
  x: number;
  y: number;
}

/** Normalized circle: center + radius (radius relative to the short edge). */
export interface NormalizedCircle {
  cx: number;
  cy: number;
  r: number;
}

/** Pixel rectangle (logical canvas coordinates). */
export interface PixelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Pixel size. */
export interface PixelSize {
  width: number;
  height: number;
}

/** Image-to-container render mapping (aspectFill / aspectFit scale & offset). */
export interface ImageFit {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
  drawWidth: number;
  drawHeight: number;
}

/** Rounded-rectangle path op-list, executed by a renderer (this layer never touches a canvas context). */
export type PathOp =
  | { op: 'moveTo'; x: number; y: number }
  | { op: 'lineTo'; x: number; y: number }
  | { op: 'arcTo'; x1: number; y1: number; x2: number; y2: number; r: number }
  | { op: 'closePath' };

/* ==================== User & dietary profile ==================== */

/** Anthropometric profile consumed by the BMR module. */
export interface UserProfile {
  gender: 'male' | 'female';
  age: number; // years
  height: number; // cm
  weight: number; // kg
  /** Precomputed BMR (kcal/day); when absent the BMR module computes it. */
  bmr?: number;
}

/** Weight-management goal → drives the goal factor G. */
export type WeightGoal = 'lose' | 'maintain' | 'gain';

/** Weight-management factor G: lose < 1, maintain = 1, gain > 1 (defaults in `bmr`). */
export type WeightGoalFactor = Record<WeightGoal, number>;

/* ==================== Dish entries (strategy-engine contract) ==================== */

/** A dish entry consumed by the strategy layer. */
export interface DishItem {
  /** Unique id — upstream must always fill it in. */
  id: string;
  name: string;
  /** `''` means "category not recognized". */
  category: FoodCategory | '';
  /** Energy density (kcal per 100 g). */
  kcalPer100g: number;
  /** Actual mass (g); 0 means volume estimation failed. */
  massG: number;
  /** Normalized outline box; null → fall back to geometry rendering. */
  bbox: NormalizedBox | null;
  /** bbox center (normalized); null when no bbox. */
  centerX: number | null;
  centerY: number | null;
  /** Portion multiplier snapped to PORTION_STEPS (0.8 / 1.0 / 1.2 / 1.5). */
  portionFactor: number;
  /** Replacement candidates (plain strings, never includes the current name). */
  candidates: string[];
  /** Qualitative model tag (e.g. "quality protein"), may be empty. */
  modelTag: string;
  /** Item kcal = massG × portionFactor × kcalPer100g / 100. */
  kcal?: number;
  /** Deleted by the user (filtered out on recalc). */
  removed?: boolean;
}

/* ==================== HFS nutrition-density layers ==================== */

/**
 * Nutrition-density reduction gradient:
 * - shrinkWeight: relative cut pressure (bigger → cut first)
 * - floorRatio:   floor retention ratio (never zero — a dish must never be cut to 0)
 * - tier:         protection semantics
 */
export interface NutritionTier {
  shrinkWeight: number;
  floorRatio: number;
  tier: 'protect' | 'quality' | 'staple' | 'indulgent';
}

/** Natural-language portion advice (output of toPortionAdvice). */
export interface PortionAdvice {
  /** Display copy: "eat freely" / "try 4/5" etc. */
  label: string;
  /** Fraction wording: "1" / "4/5" / "3/4" / "2/3" / "1/2" / "1/3". */
  fraction: string;
  /** Whether portion control is advised. */
  shrink: boolean;
}

/* ==================== HFS quota engine ==================== */

/** Per-item quota-allocation input. */
export interface QuotaInput {
  id: string;
  /** Actual kcal; items with kcal <= 0 are kept fully and excluded from the split. */
  kcal: number;
  category: FoodCategory | '';
}

/** Quota-allocation result. */
export interface QuotaResult {
  /** id → recommended keep ratio (0..1, 4 decimals). */
  keepById: Record<string, number>;
  /** Actually reduced energy (kcal). */
  reducedKcal: number;
  /** Under-reduction: the part of the deficit that even the floors could not cover. */
  shortfallKcal: number;
  /** Whether every item hit its floor. */
  capped: boolean;
}

/* ==================== Healthy-fullness regression (HFS r_H) ==================== */

/**
 * Healthy-fullness (HFS) prediction regression coefficients:
 *   ĤFS = β0 + β1·Calories + β2·Protein + β3·Fiber − β4·Fat
 * Target score HFS* = 7 ("seven-tenths full"). Defaults in `hfs` are
 * **placeholder values** — fit your own dataset before production use.
 */
export interface HfsRegression {
  beta0: number; // baseline fullness
  beta1: number; // calories coefficient (kcal^-1)
  beta2: number; // protein coefficient (g^-1)
  beta3: number; // fiber coefficient (g^-1)
  beta4: number; // fat coefficient (g^-1, negative contribution)
}

/* ==================== Render plans (consumed by draw layers) ==================== */

/** One component's recommended circle geometry + draw semantics. */
export interface CircleShapeSpec {
  id: string;
  name: string;
  category: FoodCategory | '';
  bbox: NormalizedBox;
  /** Recommended circle: R_rec = min(w,h)/2 × √keepRatio, centered on the bbox center. */
  circle: NormalizedCircle;
  keepRatio: number;
  /** true = dim everything then brighten inside the circle (shrink ring); false = keep whole (dashed ring). */
  mask: boolean;
  atFloor: boolean;
  kcal: number;
  recommendedKcal: number;
  /** Ring label (fraction wording). */
  label: string;
}

/** Geometry fallback render plan (no fine-grained outlines available). */
export interface GeometryRenderPlan {
  mode: 'solo';
  layout: 'geometry';
  headline: string;
  subline: string;
  withinBudget: boolean;
  center: NormalizedPoint;
  /** Outer reference radius (normalized, relative to the short edge). */
  outerR: number;
  /** Inner recommended radius = outerR × √keep. */
  innerR: number;
  keepOverall: number;
  rBase?: number;
  portionAdvice?: string;
  /** Whether a breathing animation is advised (phase is driven by the caller). */
  breathing: boolean;
  label: string;
  shapes: CircleShapeSpec[];
}

/** Per-item render plan. */
export interface SoloRenderPlan {
  mode: 'solo';
  layout: 'perItem';
  headline: string;
  subline: string;
  withinBudget: boolean;
  shapes: CircleShapeSpec[];
}

/* ==================== Plate geometry & volume estimation (Algorithm I) ==================== */

/**
 * Per-100 g macro density. Used for Algorithm I macro summaries and the
 * Algorithm II fullness regression. Defaults in `geometry` are placeholder
 * category-level medians.
 */
export interface MacroDensity {
  kcalPer100g: number;
  proteinG: number; // protein per 100 g (g)
  fiberG: number; // dietary fiber per 100 g (g)
  fatG: number; // fat per 100 g (g)
}

/**
 * Food form factors (relative-volume solution):
 * - density (ρ_i): converts a volume share into a mass share
 * - shapeFactor (K_i): shape / stacking factor (liquids spread flat → small, fried → large)
 * - thickness (H_i): relative thickness weight
 */
export interface FoodFormFactors {
  density: number;
  shapeFactor: number;
  thickness: number;
}

/** Volume-contribution solution (Algorithm I). */
export interface VolumeContribution {
  /** AreaRatio_i: effective plate-area share. */
  areaRatio: number;
  /** V_score,i = K_i × AreaRatio_i × H_i. */
  volumeScore: number;
  /** ω_i: normalized volume share. */
  volumeShare: number;
}

/** Mass estimate (Algorithm I). */
export interface MassEstimate {
  massG: number;
  /** 'vlm' = vision-model prior mass; 'density' = density-weighted fallback. */
  source: 'vlm' | 'density';
}

/** Whole-plate macro summary (Algorithm I). */
export interface MacroSummary {
  /** Total energy (kcal). */
  totalKcal: number;
  /** Total protein (g). */
  proteinG: number;
  /** Total dietary fiber (g). */
  fiberG: number;
  /** Total fat (g). */
  fatG: number;
}

/* ==================== Post-meal feedback & Bayesian calibration (Algorithm III) ==================== */

/**
 * Post-meal feedback (contract-aligned with any external extraction agent):
 * - theta: actual intake ratio = Q_actual / Quota_rec. 1.0 = ate exactly the
 *   recommendation, > 1 overate, < 1 left food (clamped to [0, 1.5]).
 * - F: three-state satiety, -1 = not full, 0 = exactly seven-tenths full, 1 = stuffed.
 */
export interface MealFeedback {
  theta: number;
  F: -1 | 0 | 1;
  summary?: string;
  /** Feedback timestamp (ms) for state records. */
  recordedAt?: number;
}

/**
 * Bayesian calibration state (Algorithm III: normal-normal conjugacy,
 * Kalman-style incremental update). Individual correction factor prior
 * c_t ~ N(m_t, s_t²):
 * - mean (m_t): posterior mean (point estimate of the personal factor)
 * - variance (s_t²): posterior variance (uncertainty, shrinks with observations)
 */
export interface CalibrationState {
  mean: number;
  variance: number;
  /** Number of recorded feedbacks. */
  mealCount: number;
  /** Timestamp of the most recent feedback. */
  lastRecordedAt: number | null;
}

/**
 * Bayesian update observation & hyperparameters (Algorithm III, optional
 * overrides — shipped defaults are generic placeholders).
 */
export interface CalibrationOptions {
  /** Satiety feedback adjustment strength λ (placeholder default 0.08). */
  lambda?: number;
  /** Observation noise variance τ² (placeholder default 0.2). */
  tauSq?: number;
  /** Correction-factor lower bound c_min (default 0.8). */
  cMin?: number;
  /** Correction-factor upper bound c_max (default 1.2). */
  cMax?: number;
}

/** Calibration output (Algorithm III). */
export interface CalibrationResult {
  /** Portion calibration factor c = clip(mean, cMin, cMax), multiplied into recommendations. */
  factor: number;
  /** Posterior mean m_t (unclipped). */
  mean: number;
  /** Posterior variance s_t² (uncertainty). */
  variance: number;
  /** Latest Kalman gain K_t. */
  gain: number;
  /** Suggested direction: 'down' | 'up' | 'hold'. */
  direction: 'down' | 'up' | 'hold';
  /** Cumulative meal count. */
  mealCount: number;
}

/* ==================== Recalc aggregate (strategy summary) ==================== */

/** Strategy-level recalc result (HFS quota + BMR baseline combined). */
export interface MealRecalcResult {
  itemCount: number;
  totalKcal: number;
  recommendedKcal: number;
  mealBudgetKcal: number;
  targetKcal: number;
  /** Global baseline ratio r_base = dual-constraint fusion (r_E and r_H weighted). */
  rBase: number;
  /** Achieved overall keep ratio. */
  keepOverall: number;
  withinBudget: boolean;
  reducedKcal: number;
  shortfallKcal: number;
  quotaCapped: boolean;
  circleCount: number;
  overBudget: boolean;
  /** Integer percent for UI display. */
  rBasePercent: number;
}

/* ==================== Lightweight example data ==================== */

/**
 * One entry of the lightweight mock food database.
 *
 * NOTE: the production-grade dish database is intentionally **not** part of
 * this open-source library. `mock.ts` ships a handful of illustrative dishes
 * solely to keep tests and the demo runnable out of the box.
 */
export interface MockFoodEntry {
  /** Dish name (example data). */
  name: string;
  category: FoodCategory;
  kcalPer100g: number;
  proteinG: number; // per 100 g
  fiberG: number; // per 100 g
  fatG: number; // per 100 g
  /** Typical single-serving mass (g). */
  typicalServingG: number;
}
