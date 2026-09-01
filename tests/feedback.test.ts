import { describe, expect, it } from 'vitest';
import {
  applyAgentSlots,
  dialogReducer,
  extractFollowedAdvice,
  fastExtractSlots,
  initialDialogState,
  isComplete,
  questionForStage
} from '../src/dialog';
import {
  buildCognitiveCopy,
  evaluatePetReaction
} from '../src/pet';
import {
  DEFAULT_THETA_WHEN_FOLLOWED,
  runFeedbackTurn
} from '../src/pipeline';
import { createInitialState } from '../src/bayesian';

describe('fastExtractSlots', () => {
  it('extracts theta and F from colloquial replies', () => {
    expect(fastExtractSlots('没吃完，还有点饿')).toEqual({ theta: 0.5, F: -1 });
    expect(fastExtractSlots('光盘了，刚好')).toEqual({ theta: 1.0, F: 0 });
    expect(fastExtractSlots('吃撑了')).toEqual({ theta: null, F: 1 });
    expect(fastExtractSlots('')).toEqual({ theta: null, F: null });
  });

  it('keeps "七分饱" out of the theta extractor', () => {
    expect(fastExtractSlots('七分饱').theta).toBeNull();
  });
});

describe('extractFollowedAdvice', () => {
  it('checks negation first', () => {
    expect(extractFollowedAdvice('没有，随便吃的')).toBe(false);
    expect(extractFollowedAdvice('没照建议吃')).toBe(false);
    expect(extractFollowedAdvice('照着建议吃的')).toBe(true);
    expect(extractFollowedAdvice('差不多')).toBe(true);
    expect(extractFollowedAdvice('我在看手机')).toBeNull();
  });
});

describe('dialogReducer', () => {
  it('walks the followed path: askExecution → askSatiety → done', () => {
    let state = dialogReducer(initialDialogState(), { type: 'USER_REPLY', text: '照着吃了' });
    expect(state.stage).toBe('askSatiety');
    expect(state.followedAdvice).toBe(true);

    state = dialogReducer(state, { type: 'USER_REPLY', text: '刚好' });
    expect(isComplete(state)).toBe(true);
    expect(state.F).toBe(0);
    expect(state.theta).toBeNull(); // followed path leaves theta to the pipeline default
  });

  it('walks the branch path: askExecution → branchRatio → askSatiety → done', () => {
    let state = dialogReducer(initialDialogState(), { type: 'USER_REPLY', text: '没按建议' });
    expect(state.stage).toBe('branchRatio');

    state = dialogReducer(state, { type: 'USER_REPLY', text: '吃了一半' });
    expect(state.stage).toBe('askSatiety');
    expect(state.theta).toBe(0.5);

    state = dialogReducer(state, { type: 'USER_REPLY', text: '没吃饱' });
    expect(isComplete(state)).toBe(true);
    expect(state.theta).toBe(0.5);
    expect(state.F).toBe(-1);
  });

  it('stays on the current stage when nothing matches', () => {
    const state = dialogReducer(initialDialogState(), { type: 'USER_REPLY', text: '我在看手机' });
    expect(state.stage).toBe('askExecution');
  });

  it('RESET returns the initial state', () => {
    const done = dialogReducer(initialDialogState(), { type: 'USER_REPLY', text: '照着吃了' });
    expect(dialogReducer(done, { type: 'RESET' }).stage).toBe('askExecution');
  });

  it('asks the per-stage questions', () => {
    expect(questionForStage('askExecution')).toBe('Did you follow the recommendation?');
    expect(questionForStage('done')).toBe('');
  });
});

describe('applyAgentSlots (cloud-slot path)', () => {
  it('jumps straight to done when all slots are given at once', () => {
    const state = applyAgentSlots(initialDialogState(), { theta: 1.3, F: 1 });
    expect(isComplete(state)).toBe(true);
    expect(state.followedAdvice).toBe(false); // inferred from theta ≠ 1
    expect(state.theta).toBe(1.3);
    expect(state.F).toBe(1);
  });

  it('infers followedAdvice = true from theta ≈ 1', () => {
    const state = applyAgentSlots(initialDialogState(), { theta: 1.0, F: 0 });
    expect(state.followedAdvice).toBe(true);
  });
});

describe('evaluatePetReaction', () => {
  const base = { theta: 1.0, F: 0 as -1 | 0 | 1, currentLevel: 1, currentExp: 0, streakDays: 2, hasShieldCard: false };

  it('accurate clean plate: 2.0× EXP crit and streak + 1', () => {
    const result = evaluatePetReaction(base);
    expect(result.isAccurateCleanPlate).toBe(true);
    expect(result.emotion).toBe('happy');
    expect(result.expGained).toBe(20);
    expect(result.updatedStreak).toBe(3);
  });

  it('stuffed without a shield resets the streak', () => {
    const result = evaluatePetReaction({ ...base, theta: 1.3, F: 1 });
    expect(result.emotion).toBe('full');
    expect(result.updatedStreak).toBe(0);
    expect(result.shieldConsumed).toBe(false);
  });

  it('stuffed with a shield preserves the streak and consumes the card', () => {
    const result = evaluatePetReaction({ ...base, theta: 1.3, F: 1, hasShieldCard: true });
    expect(result.updatedStreak).toBe(2);
    expect(result.shieldConsumed).toBe(true);
  });

  it('under-fed keeps the streak and raises no penalty', () => {
    const result = evaluatePetReaction({ ...base, theta: 0.5, F: -1 });
    expect(result.emotion).toBe('hungry');
    expect(result.updatedStreak).toBe(2);
  });

  it('handles multi-level jumps without losing surplus EXP', () => {
    // 320 EXP: L1 needs 100, L2 needs 200 → level 3 with 20 surplus.
    const result = evaluatePetReaction({ ...base, currentExp: 300, streakDays: 0 });
    expect(result.updatedLevel).toBe(3);
    expect(result.updatedExp).toBe(20);
  });
});

describe('buildCognitiveCopy', () => {
  it('maps settlement outcomes to titles', () => {
    expect(buildCognitiveCopy({ emotion: 'happy', isAccurateCleanPlate: true, shieldConsumed: false }).title).toBe('Accurate clean plate!');
    expect(buildCognitiveCopy({ emotion: 'full', isAccurateCleanPlate: false, shieldConsumed: true }).title).toBe('Body signals lag…');
    expect(buildCognitiveCopy({ emotion: 'full', isAccurateCleanPlate: false, shieldConsumed: false }).title).toBe('Stuffed');
    expect(buildCognitiveCopy({ emotion: 'hungry', isAccurateCleanPlate: false, shieldConsumed: false }).title).toBe('Have a bit more next time');
  });
});

describe('runFeedbackTurn (closed loop)', () => {
  it('returns the next question while the loop is incomplete', () => {
    const out = runFeedbackTurn({
      dialogState: initialDialogState(),
      userText: '照着吃了',
      calibrationState: createInitialState(),
      pet: { currentLevel: 1, currentExp: 0, streakDays: 0, hasShieldCard: false }
    });
    expect(out.completed).toBe(false);
    expect(out.question).toBe('How do you feel?');
    expect(out.calibration).toBeNull();
  });

  it('runs calibration + pet settlement on completion', () => {
    // Turn 1: follow the advice.
    const t1 = runFeedbackTurn({
      dialogState: initialDialogState(),
      userText: '照着吃了',
      calibrationState: createInitialState(),
      pet: { currentLevel: 1, currentExp: 0, streakDays: 0, hasShieldCard: false }
    });

    // Turn 2: report "just right" → loop completes.
    const t2 = runFeedbackTurn({
      dialogState: t1.dialogState,
      userText: '刚好',
      calibrationState: createInitialState(),
      pet: { currentLevel: 1, currentExp: 0, streakDays: 0, hasShieldCard: false }
    });

    expect(t2.completed).toBe(true);
    expect(t2.feedback).toEqual({ theta: DEFAULT_THETA_WHEN_FOLLOWED, F: 0 });
    expect(t2.calibration!.state.mealCount).toBe(1);
    expect(t2.calibration!.result.direction).toBe('hold');
    // theta 1.0 & F 0 → accurate clean plate → 2.0× EXP crit.
    expect(t2.pet!.isAccurateCleanPlate).toBe(true);
    expect(t2.pet!.expGained).toBe(20);
    expect(t2.pet!.updatedStreak).toBe(1);
  });

  it('records the branch theta when the user did not follow', () => {
    let state = dialogReducer(initialDialogState(), { type: 'USER_REPLY', text: '没按建议' });
    state = dialogReducer(state, { type: 'USER_REPLY', text: '一半' });
    const out = runFeedbackTurn({
      dialogState: state,
      userText: '没吃饱',
      calibrationState: createInitialState(),
      pet: { currentLevel: 1, currentExp: 0, streakDays: 0, hasShieldCard: false }
    });
    expect(out.completed).toBe(true);
    expect(out.feedback!.theta).toBe(0.5);
    expect(out.feedback!.F).toBe(-1);
    expect(out.pet!.emotion).toBe('hungry');
  });
});
