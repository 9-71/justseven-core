/**
 * Post-meal two-branch adaptive dialog state machine — dialogEngine.
 *
 * Scope (strictly isolated): dialog state transitions + on-device regex slot
 * extraction. No emotion/EXP/shield settlement (see `pet`) and no Bayesian
 * calibration (see `bayesian`). Exports pure functions and a Reducer with
 * zero external side effects.
 *
 * Dialog flow (after a meal):
 *   1st turn   askExecution  "Did you follow the recommendation?" → followedAdvice (yes / no)
 *   branch     branchRatio   "Roughly how much did you eat?"     → theta (0.1..1.5), only when NOT followed
 *   2nd turn   askSatiety    "How do you feel?"                  → F (-1/0/1)
 *   done       end, produces (theta, F)
 *
 * Slot contract (aligned with `types.MealFeedback`):
 * - theta: actual intake ratio = Q_actual / Quota_rec; 1.0 = ate the whole
 *   recommendation, > 1 overate, < 1 left food
 * - F: three-state satiety, -1 = not full, 0 = exactly seven-tenths full, 1 = stuffed
 */

/** Dialog stage. */
export type DialogStage = 'askExecution' | 'branchRatio' | 'askSatiety' | 'done';

/** Regex-extracted slots (null = not matched; the orchestrator may downgrade to a cloud extractor). */
export interface DialogSlots {
  /** Actual intake ratio (0.1..1.5), null when not extracted. */
  theta: number | null;
  /** Three-state satiety, null when not extracted. */
  F: -1 | 0 | 1 | null;
}

/** Dialog state (immutable; the Reducer always returns a new object). */
export interface DialogState {
  stage: DialogStage;
  /** Whether the user followed the advice (null = not yet determined). */
  followedAdvice: boolean | null;
  /** Actual intake ratio, null when not extracted. */
  theta: number | null;
  /** Three-state satiety, null when not extracted. */
  F: -1 | 0 | 1 | null;
}

/** Reducer action. */
export type DialogAction =
  | { type: 'USER_REPLY'; text: string }
  | { type: 'RESET' };

/** Per-stage question copy. */
export const QUESTION_ASK_EXECUTION = 'Did you follow the recommendation?';
export const QUESTION_BRANCH_RATIO = 'Roughly how much did you eat?';
export const QUESTION_ASK_SATIETY = 'How do you feel?';

/** Legal theta bounds. */
export const THETA_MIN = 0.1;
export const THETA_MAX = 1.5;

/* ==================== On-device regex quick extractor ==================== */

/**
 * Extract the satiety state F (three-state).
 * Order-sensitive: check "stuffed/over" first, then "not full/hungry", then
 * "just right", so "没吃饱" is not swallowed by "饱" and "刚好" is not
 * preempted by "好".
 */
function extractSatiety(s: string): -1 | 0 | 1 | null {
  // F = +1 stuffed / overate
  if (/(?:吃|太|很|过|有点)?撑|吃多|太饱|很饱|过饱|过量|吃撑/.test(s)) return 1;
  // F = -1 not full / still hungry
  if (/没饱|没吃饱|还饿|不饱|不够吃|没吃够|还想吃|有点饿|饿了|饿$/.test(s)) return -1;
  // F = 0 just right (seven-tenths full)
  if (/刚好|正好|刚刚好|正合适|合适|差不多|七分饱|七成饱|八分饱|不饿|还行|还可以|一般|不错|舒服/.test(s)) return 0;
  return null;
}

/**
 * Extract the actual intake ratio theta (0.1..1.5). Rule order = priority:
 *   1. Negations (left food / barely ate) before "ate it all", so "没吃完"
 *      is not swallowed by "吃完".
 *   2. Explicit fractions before percents, so "三分之一" is not taken by "三成".
 *   3. Percents carry a `(?!饱)` negative lookahead to exclude fullness
 *      expressions like "七分饱 / 八成饱".
 *   4. "ate it all / clean plate" → 1.0; "one and a half / two servings" caps at 1.5.
 */
function extractTheta(s: string): number | null {
  const rules: Array<[RegExp, number]> = [
    [/没吃完|没吃光/, 0.5],
    [/没怎么吃|基本没吃|几口|没(?:吃|动|碰)/, 0.1],
    [/三分之二|2\/3/, 0.67],
    [/四分之三|3\/4/, 0.75],
    [/三分之一|1\/3/, 0.33],
    [/四分之一|1\/4/, 0.25],
    [/九[成分](?!饱)|90%?/, 0.9],
    [/八[成分](?!饱)|80%?/, 0.8],
    [/七[成分](?!饱)|70%?/, 0.7],
    [/六[成分](?!饱)|60%?/, 0.6],
    [/五[成分](?!饱)|50%?/, 0.5],
    [/四[成分](?!饱)|40%?/, 0.4],
    [/三[成分](?!饱)|30%?/, 0.3],
    [/[两二][成分](?!饱)|20%?/, 0.2],
    [/一[成分](?!饱)|10%?/, 0.1],
    [/一半/, 0.5],
    [/吃(?:完|光)(?:了)?|全吃(?:了|完)|光盘|都吃(?:了|完)?/, 1.0],
    [/一份半|1\.5|两[份个]|2[份个]/, 1.5]
  ];
  for (const [re, value] of rules) {
    if (re.test(s)) return value;
  }
  return null;
}

/**
 * On-device regex quick extractor: matches common colloquial phrasing and
 * returns the slots directly, avoiding a model call. Unmatched fields stay
 * null (the orchestrator decides whether to downgrade to a cloud extractor).
 */
export function fastExtractSlots(text: string): DialogSlots {
  const slots: DialogSlots = { theta: null, F: null };
  const s = (text || '').trim();
  if (!s) return slots;
  slots.F = extractSatiety(s);
  slots.theta = extractTheta(s);
  return slots;
}

/**
 * 1st-turn yes/no extraction ("did you follow the advice?").
 * Order-sensitive: negation first, so "没按建议" is not swallowed by "按建议".
 * Returns null when unrecognized (cloud fallback).
 */
export function extractFollowedAdvice(text: string): boolean | null {
  const s = (text || '').trim();
  if (!s) return null;
  if (/没有|没按|没照|没听|没吃|没做|没全|不完全|没完全|不是|不对|没执行|改了|随便|相反|反着|并没有/.test(s)) return false;
  if (/照着|按建议|按推荐|照建议|照做|听建议|听了|吃了|是的|是|对|嗯|照|按|差不多|还行|还可以|可以|就那样|大致|基本|没错|不错|挺好|好的|还好/.test(s)) return true;
  return null;
}

/* ==================== State machine Reducer ==================== */

/** Initial dialog state (1st-turn question). */
export function initialDialogState(): DialogState {
  return { stage: 'askExecution', followedAdvice: null, theta: null, F: null };
}

/** Next question for a stage ('' when done). */
export function questionForStage(stage: DialogStage): string {
  switch (stage) {
    case 'askExecution': return QUESTION_ASK_EXECUTION;
    case 'branchRatio': return QUESTION_BRANCH_RATIO;
    case 'askSatiety': return QUESTION_ASK_SATIETY;
    case 'done': return '';
    default: return '';
  }
}

/** Whether the dialog loop has completed. */
export function isComplete(state: DialogState): boolean {
  return state.stage === 'done';
}

/**
 * Dialog Reducer (pure): given the current state and an action, returns a
 * new state without mutating the input.
 * Flow: askExecution → (branchRatio when NOT followed) → askSatiety → done.
 * An unmatched slot keeps the current stage (the orchestrator decides: cloud
 * fallback or re-ask).
 */
export function dialogReducer(state: DialogState, action: DialogAction): DialogState {
  if (!state || action.type === 'RESET') return initialDialogState();

  const text = action.text || '';

  switch (state.stage) {
    case 'askExecution': {
      const followed = extractFollowedAdvice(text);
      if (followed === true) {
        return { stage: 'askSatiety', followedAdvice: true, theta: null, F: null };
      }
      if (followed === false) {
        return { stage: 'branchRatio', followedAdvice: false, theta: null, F: null };
      }
      return { ...state }; // cannot tell → stay on this stage
    }

    case 'branchRatio': {
      const { theta } = fastExtractSlots(text);
      if (theta != null) {
        return { stage: 'askSatiety', followedAdvice: false, theta, F: null };
      }
      return { ...state }; // ratio not matched → stay on the branch stage
    }

    case 'askSatiety': {
      const { F } = fastExtractSlots(text);
      if (F != null) {
        return { stage: 'done', followedAdvice: state.followedAdvice, theta: state.theta, F };
      }
      return { ...state };
    }

    case 'done':
    default:
      return state;
  }
}

/**
 * Advance the dialog using *pre-extracted* slots (cloud-agent fallback path).
 *
 * Unlike `dialogReducer`, this does not read text or run regexes — it
 * consumes structured slots (theta / F, optional followedAdvice) directly.
 * It may advance several stages at once: if the user answered "how much" and
 * "how full" in one message, it goes straight to done.
 *
 * When followedAdvice is absent it is inferred from theta: theta deviating
 * from 1.0 (left food / overate) → "did not follow"; theta ≈ 1.0 or missing
 * → "followed", matching `extractFollowedAdvice` semantics.
 */
export function applyAgentSlots(
  state: DialogState,
  slots: { followedAdvice?: boolean; theta?: number; F?: -1 | 0 | 1 }
): DialogState {
  if (!state) return initialDialogState();
  const s = slots || {};

  const theta = s.theta != null && Number.isFinite(Number(s.theta)) ? Number(s.theta) : null;
  const F = s.F === -1 || s.F === 0 || s.F === 1 ? s.F : null;

  let cur = state;

  if (cur.stage === 'askExecution') {
    let followed = typeof s.followedAdvice === 'boolean' ? s.followedAdvice : null;
    if (followed == null && theta != null) {
      followed = Math.abs(theta - 1) > 0.05 ? false : true;
    }
    if (followed == null) return cur; // still undecidable → stay
    cur = followed
      ? { stage: 'askSatiety', followedAdvice: true, theta: null, F: null }
      : { stage: 'branchRatio', followedAdvice: false, theta, F: null };
  }

  if (cur.stage === 'branchRatio') {
    if (theta == null) return cur; // missing intake ratio → stuck on the branch
    cur = { stage: 'askSatiety', followedAdvice: false, theta, F: null };
  }

  if (cur.stage === 'askSatiety') {
    if (F == null) return cur; // missing satiety → stuck on the last question
    cur = { stage: 'done', followedAdvice: cur.followedAdvice, theta: cur.theta, F };
  }

  return cur;
}
