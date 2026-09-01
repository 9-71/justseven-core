/**
 * 7-day simulation: a user with a hidden "true appetite" (consistently eats
 * ~10% more than the base recommendation) goes through the full closed loop
 * every day — meal → HFS recommendation → Bayesian calibration update →
 * pet settlement — and we watch the personal correction factor converge.
 *
 * Run:  npm run demo        (ts-node examples/simulation_demo.ts)
 *
 * The script is deterministic (fixed noise sequence), so every run tells the
 * same story:
 *   day 1-3  factor rises toward the true appetite (direction: up)
 *   day 4    the user eats less than usual → factor dips → direction: hold
 *   day 5    the user overshoots (theta 1.28 → stuffed, F=+1); the shield
 *            card preserves the streak, and the observation is narrowed by λ
 *   day 6-7  the posterior mean re-converges, variance s² and Kalman gain K
 *            keep shrinking → the engine becomes more confident.
 */

import {
  type CalibrationState,
  type MealFeedback,
  applyCalibration,
  buildMockQuotaItem,
  calcBMR,
  calibrateAfterMeal,
  computeCalibrationFactor,
  computeDynamicTarget,
  computeMealBudget,
  computeRecommendedRatio,
  evaluatePetReaction,
  estimateMacros,
  mockFoodData,
  mockUserProfile
} from '../src/index';

/* ==================== Terminal output helpers ==================== */

const useColor = !!process.stdout.isTTY;
const paint = (code: string, s: string): string =>
  useColor ? `[${code}m${s}[0m` : s;
const red = (s: string): string => paint('31', s);
const green = (s: string): string => paint('32', s);
const yellow = (s: string): string => paint('33', s);
const cyan = (s: string): string => paint('36', s);
const dim = (s: string): string => paint('2', s);
const bold = (s: string): string => paint('1', s);

function directionColor(d: 'down' | 'up' | 'hold'): string {
  if (d === 'up') return green(d.toUpperCase());
  if (d === 'down') return red(d.toUpperCase());
  return yellow(d.toUpperCase());
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/* ==================== Simulation constants ==================== */

const DAYS = 7;
/** Hidden "true appetite": the user consistently eats 1.1× the base quota. */
const TRUE_THETA = 1.1;
/** Daily noise around the true appetite (deterministic, curated). */
const DAILY_NOISE = [0.02, -0.03, 0.04, -0.2, 0.18, 0.03, -0.01];
/** Satiety thresholds: |theta| above +1.2 → stuffed, below 0.85 → under-fed. */
const STUFFED_THRESHOLD = 1.2;
const UNDERFED_THRESHOLD = 0.85;
/** The user holds an indulgence shield card from day 4 on. */
const SHIELD_FROM_DAY = 4;

/** Per-day meal: dish name → mass (g). */
const DAILY_MEALS: ReadonlyArray<Array<[string, number]>> = [
  [['steamed rice', 180], ['grilled chicken breast', 140], ['steamed broccoli', 160]],
  [['steamed rice', 220], ['grilled chicken breast', 120], ['corn soup', 200]],
  [['steamed rice', 200], ['fried chicken', 120], ['steamed broccoli', 180]],
  [['steamed rice', 150], ['grilled chicken breast', 150], ['steamed broccoli', 200]],
  [['steamed rice', 200], ['fried chicken', 150], ['chocolate cake', 80]],
  [['steamed rice', 210], ['grilled chicken breast', 130], ['steamed broccoli', 150]],
  [['steamed rice', 190], ['grilled chicken breast', 140], ['corn soup', 220]]
];

function satietyFor(theta: number): -1 | 0 | 1 {
  if (theta >= STUFFED_THRESHOLD) return 1;
  if (theta <= UNDERFED_THRESHOLD) return -1;
  return 0;
}

/* ==================== ASCII sparkline ==================== */

function sparkline(values: number[], min: number, max: number, width = 40): string {
  if (!values.length) return '';
  const span = Math.max(1e-9, max - min);
  const steps = '▁▂▃▄▅▆▇█';
  return values
    .map((v) => steps[Math.max(0, Math.min(steps.length - 1, Math.floor(((v - min) / span) * (steps.length - 1))))])
    .join('');
}

/* ==================== Main ==================== */

function main(): void {
  console.log(bold('justseven-core — 7-day adaptive calibration simulation'));
  console.log(dim('user: male 28y / 175cm / 70kg  ·  hidden true appetite θ* = 1.10  ·  deterministic'));
  console.log('');

  // Baseline: BMR → meal budget (Mifflin-St Jeor).
  const bmr = calcBMR(mockUserProfile);
  const mealBudget = computeMealBudget(bmr);
  const dynamicTarget = computeDynamicTarget(mealBudget, 7); // HFS̄ = 7 → no correction
  console.log(
    `${bold('Baseline')}  BMR = ${bmr} kcal/day  →  meal budget = ${mealBudget} kcal  →  ` +
      `dynamic target E_target,0 = ${dynamicTarget} kcal`
  );
  console.log('');

  // Header.
  console.log(
    pad('day', 4) + pad('meal kcal', 10) + pad('r_base', 7) + pad('r_rec', 7) +
    pad('θ_t', 6) + pad('F', 4) + pad('y_t', 8) + pad('K_t', 8) +
    pad('m_t', 8) + pad('s²_t', 8) + pad('dir', 6) +
    pad('pet', 8) + pad('streak', 7) + pad('EXP', 5) + 'level'
  );
  console.log(dim('─'.repeat(108)));

  // Running state.
  let calib: CalibrationState = {
    mean: 1.0,
    variance: 0.25,
    mealCount: 0,
    lastRecordedAt: null
  };
  let pet = { currentLevel: 1, currentExp: 0, streakDays: 0, hasShieldCard: false };

  const meanTrajectory: number[] = [1.0];
  const factorTrajectory: number[] = [1.0];

  for (let day = 1; day <= DAYS; day += 1) {
    // 1) Build the meal & estimate macros.
    const items = DAILY_MEALS[day - 1].map(([name, mass]) => buildMockQuotaItem(name, mass));
    const realMacros = estimateMacros(
      DAILY_MEALS[day - 1].map(([name, mass]) => {
        const dish = mockFoodData.find((d) => d.name === name)!;
        return { category: dish.category, massG: mass };
      })
    );
    const totalKcal = items.reduce((s, it) => s + it.kcal, 0);

    // 2) HFS dual-constraint recommendation, then apply the calibration factor.
    const factor = computeCalibrationFactor(calib).factor; // c_t = clip(m_t, 0.8, 1.2)
    const target = dynamicTarget * factor;
    const rec = computeRecommendedRatio(target, totalKcal, realMacros, { clampEnergy: true });
    const rRec = applyCalibration(rec.rBase, factor);

    // 3) Simulate the user: eats their true appetite + daily noise (relative
    //    to the recommendation), reports satiety from the outcome.
    const thetaRaw = TRUE_THETA + DAILY_NOISE[day - 1];
    const theta = Math.max(0.1, Math.min(1.5, thetaRaw));
    const F = satietyFor(theta);
    const feedback: MealFeedback = { theta, F };

    // 4) Bayesian incremental update.
    const { state: nextState, observation, gain, result } = calibrateAfterMeal(calib, feedback);
    void observation; void gain;

    // 5) Pet settlement. Grant the indulgence shield card once on day 4 —
    //    a single card that day 5's overshoot will consume.
    if (day === SHIELD_FROM_DAY) {
      pet = { ...pet, hasShieldCard: true };
    }
    const reaction = evaluatePetReaction({
      theta,
      F,
      currentLevel: pet.currentLevel,
      currentExp: pet.currentExp,
      streakDays: pet.streakDays,
      hasShieldCard: pet.hasShieldCard
    });
    pet = { ...pet, ...reaction, hasShieldCard: pet.hasShieldCard && !reaction.shieldConsumed };

    // 6) Print the day.
    console.log(
      pad(`${day}`, 4) +
      pad(`${totalKcal.toFixed(0)}`, 10) +
      pad(rec.rBase.toFixed(3), 7) +
      pad(rRec.toFixed(3), 7) +
      pad(theta.toFixed(2), 6) +
      pad(F > 0 ? '+1' : String(F), 4) +
      pad(observation.toFixed(4), 8) +
      pad(gain.toFixed(4), 8) +
      pad(result.mean.toFixed(4), 8) +
      pad(nextState.variance.toFixed(4), 8) +
      pad(directionColor(result.direction), 6) +
      pad(reaction.emotion, 8) +
      pad(String(reaction.updatedStreak), 7) +
      pad(`${reaction.updatedExp}`, 5) +
      String(reaction.updatedLevel)
    );

    // Day-5 annotation (the overshoot day).
    if (F === 1) {
      const shieldNote = reaction.shieldConsumed
        ? `  ${yellow('↳ stuffed! indulgence shield auto-deducted, streak preserved')}`
        : `  ${red('↳ stuffed! streak reset')}`;
      console.log(dim(shieldNote));
    }
    if (day === 4) {
      console.log(dim('  ↳ lower intake today → posterior dips, direction turns to hold'));
    }

    calib = nextState;
    meanTrajectory.push(result.mean);
    factorTrajectory.push(result.factor);
  }

  // 7) Summary.
  console.log(dim('─'.repeat(108)));
  console.log('');
  console.log(bold('Convergence summary'));
  console.log(`  posterior mean m_t : ${meanTrajectory.map((m) => m.toFixed(3)).join(' → ')}`);
  console.log(`  factor c_t (clipped): ${factorTrajectory.map((m) => m.toFixed(3)).join(' → ')}`);
  console.log(`  sparkline (mean)   : ${sparkline(meanTrajectory.slice(1), 0.95, 1.2)}`);
  console.log('');
  console.log(
    `  final state  m = ${calib.mean.toFixed(4)}  s² = ${calib.variance.toFixed(4)}  ` +
      `K = ${(calib.variance / (calib.variance + 0.2)).toFixed(4)}  meals = ${calib.mealCount}`
  );
  console.log(
    `  pet state    level ${pet.currentLevel}  EXP ${pet.currentExp}/100  streak ${pet.streakDays} days  ` +
      `shield ${pet.hasShieldCard ? 'held' : 'consumed'}`
  );
  console.log('');
  console.log(
    dim(
      'Takeaway: the engine detected a consistent over-eater (true θ* = 1.10) and raised the ' +
        'personal factor from 1.000 toward ≈1.08 within 7 days, while the posterior variance and ' +
        'Kalman gain kept shrinking — i.e. confidence grew with every meal.'
    )
  );
}

main();
