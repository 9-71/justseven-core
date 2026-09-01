/**
 * Lightweight example data — `mockFoodData`.
 *
 * IMPORTANT: this is intentionally **not** the production dish database. The
 * open-source library ships a handful of illustrative dishes so that unit
 * tests and the demo run out of the box. Production deployments must supply
 * their own food database and calibrated hyperparameters.
 */

import type { FoodCategory, MockFoodEntry, QuotaInput, UserProfile } from './types';

/** Lightweight mock food database (example data only). */
export const mockFoodData: ReadonlyArray<MockFoodEntry> = Object.freeze([
  { name: 'steamed rice', category: 'carb', kcalPer100g: 130, proteinG: 2.6, fiberG: 0.3, fatG: 0.3, typicalServingG: 200 },
  { name: 'grilled chicken breast', category: 'protein', kcalPer100g: 165, proteinG: 31, fiberG: 0, fatG: 3.6, typicalServingG: 120 },
  { name: 'steamed broccoli', category: 'veggie', kcalPer100g: 35, proteinG: 2.8, fiberG: 2.6, fatG: 0.4, typicalServingG: 200 },
  { name: 'corn soup', category: 'soup', kcalPer100g: 45, proteinG: 1.5, fiberG: 0.8, fatG: 1.2, typicalServingG: 250 },
  { name: 'fried chicken', category: 'fried', kcalPer100g: 320, proteinG: 18, fiberG: 0.5, fatG: 22, typicalServingG: 100 },
  { name: 'chocolate cake', category: 'dessert', kcalPer100g: 380, proteinG: 5, fiberG: 1.5, fatG: 18, typicalServingG: 100 }
]);

/** Look up a mock dish by name (case-insensitive); null when unknown. */
export function lookupMockFood(name: string): MockFoodEntry | null {
  const key = (name || '').trim().toLowerCase();
  return mockFoodData.find((d) => d.name.toLowerCase() === key) ?? null;
}

/**
 * Build a mock quota item (HFS input) for a dish by name.
 * @param name dish name from `mockFoodData`
 * @param massG actual mass in grams (defaults to the typical serving)
 * @param id optional item id (defaults to the dish name)
 */
export function buildMockQuotaItem(
  name: string,
  massG?: number,
  id?: string
): QuotaInput {
  const dish = lookupMockFood(name);
  if (!dish) {
    throw new Error(`buildMockQuotaItem: unknown mock dish "${name}"`);
  }
  const mass = Number(massG) > 0 ? Number(massG) : dish.typicalServingG;
  const kcal = Math.round((mass * dish.kcalPer100g) / 100 * 10) / 10;
  return { id: id || name, kcal, category: dish.category };
}

/** Typical example user profile used by tests and the demo. */
export const mockUserProfile: UserProfile = Object.freeze({
  gender: 'male',
  age: 28,
  height: 175,
  weight: 70
});

/** Resolve a category's macro density for a mock dish (per-100 g table). */
export function mockMacroDensity(
  category: FoodCategory
): { kcalPer100g: number; proteinG: number; fiberG: number; fatG: number } {
  const entry = mockFoodData.find((d) => d.category === category);
  if (entry) {
    return {
      kcalPer100g: entry.kcalPer100g,
      proteinG: entry.proteinG,
      fiberG: entry.fiberG,
      fatG: entry.fatG
    };
  }
  // Fall back to the engine's placeholder category table.
  return {
    kcalPer100g: 150,
    proteinG: 2.6,
    fiberG: 0.4,
    fatG: 0.4
  };
}
