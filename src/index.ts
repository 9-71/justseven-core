/**
 * justseven-core — pure-TypeScript nutritional-intelligence engine.
 *
 * Unified entry point. Everything is a pure function with zero external
 * side effects; see the README for the technical whitepaper, math derivations
 * and the architecture diagram.
 */

export * from './types';

// Algorithm 0 — BMR & meal energy baselines (Mifflin-St Jeor).
export * from './bmr';

// Algorithm II — HFS dual-constraint recommended intake ratio & flexible quota.
export * from './hfs';

// Algorithm III — Bayesian / Kalman incremental personal calibration.
export * from './bayesian';

// Algorithm I — plate geometry, relative volume & mass estimation + coordinate utils.
export * from './geometry';

// Post-meal dialog state machine & on-device slot extraction.
export * from './dialog';

// Pet emotion / streak / EXP / shield settlement.
export * from './pet';

// Closed-loop orchestration (dialog → calibration → pet).
export * from './pipeline';

// Lightweight example data (NOT a production food database).
export * from './mock';
