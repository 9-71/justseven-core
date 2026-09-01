# justseven-core

A small, dependency-free TypeScript library of core dietary-intake algorithms —
**BMR budgeting, fullness-regression portion advice, Bayesian adaptive
calibration, and plate geometry estimation** — extracted from a production
WeChat Mini Program and rewritten as a pure, testable, open-source package.

> All `wx.*` / cloud / DOM dependencies were stripped. Every function is a pure
> TypeScript function operating on plain data. Production food data was removed;
> a lightweight `mockFoodData` (6 dishes) ships only to run the unit tests.

---

## Why this library

Recommending "how much of this plate to eat" well is a **control problem**, not
a lookup problem. The system needs to answer four questions on every meal:

1. **How much energy should this meal deliver?** — an energy budget derived
   from the user's basal metabolic rate.
2. **Which macro composition keeps you full?** — a fullness regression that
   scores a plate and rescales the portion to a "seven-tenths full" target.
3. **What portion do I actually need to cut / keep?** — an iterative quota
   allocator with category floors.
4. **Is my recommendation actually matching reality?** — an adaptive layer that
   watches the user's feedback and silently recalibrates the next advice.

The four algorithms below answer these in order and compose into a closed
loop: recommend → eat → report → recalibrate.

---

## Architecture

```
                        ┌─────────────────────────────┐
                        │  user profile (age/height/  │
                        │  weight/gender/goal)        │
                        └──────────────┬──────────────┘
                                       ▼
   ┌───────────────────────────────────────────────────────┐
   │ Algorithm 0 — BMR & meal budget           (src/bmr.ts) │
   │   BMR = Mifflin-St Jeor                                 │
   │   E_meal = BMR × G × μ_meal (band ±5%, cap 100 kcal)    │
   └───────────────────────┬───────────────────────────────┘
                           ▼ E_target
   ┌───────────────────────────────────────────────────────┐
   │ Algorithm I — plate geometry            (src/geometry)│
   │   area ratios → volume scores → mass & macro totals    │
   └───────────────────────┬───────────────────────────────┘
                           ▼ E_total, macros
   ┌───────────────────────────────────────────────────────┐
   │ Algorithm II — HFS dual-constraint advice (src/hfs.ts)│
   │   r_E (energy)   ┐                                    │
   │   r_H (fullness) ┴─ fuse → r_base → flexible quota     │
   └───────────────────────┬───────────────────────────────┘
                           ▼ recommended portion / quota
   ┌───────────────────────────────────────────────────────┐
   │ Algorithm III — Bayesian recalibration (src/bayesian) │
   │   Kalman update on θ_t = θ·(1 − λ·F_t)                │
   └───────────────────────▲───────────────────────────────┘
                           │ θ, F feedback
                   user eats & reports
```

Optional companions (kept out of the core loop):

| Module | Purpose |
|---|---|
| `src/dialog.ts` | Turn-taking state machine + colloquial Chinese slot extraction |
| `src/pet.ts` | Streak / EXP / shield-card settlement for gamification |
| `src/pipeline.ts` | `runFeedbackTurn` — orchestrates dialog → calibration → pet |
| `src/mock.ts` | 6-dish `mockFoodData` for tests & the simulation demo |

---

## Algorithm 0 — BMR and the meal budget (`src/bmr.ts`)

**Mifflin-St Jeor:**

$$
\text{BMR}_m = 10\,w + 6.25\,h - 5\,a + 5 \qquad
\text{BMR}_f = 10\,w + 6.25\,h - 5\,a - 161
$$

The meal target applies a weight-goal factor $G$ and a per-meal budget ratio
$\mu_m = 0.32$, then the "seven-tenths full" eating target $\mu_\text{sf} = 0.7$:

$$
E_{\text{target}} = \mathrm{round}\!\left(\text{BMR} \times G \times \mu_m\right),
\qquad G \in \{0.85\,(\text{lose}),\ 1.0\,(\text{maintain}),\ 1.15\,(\text{gain})\}
$$

An elastic band $E_{\text{target}} \times (1 \pm 0.05)$ tolerates plate
variability; the band span is capped at 100 kcal so extreme BMRs do not
produce unusably wide recommendations.

---

## Algorithm II — HFS dual-constraint recommendation (`src/hfs.ts`)

### Fullness regression

A linear model scores the plate's macros (Calories $C$, Protein $P$, Fiber
$F_b$, Fat $F_t$):

$$
\hat{\text{HFS}} = \beta_0 + \beta_1 C + \beta_2 P + \beta_3 F_b - \beta_4 F_t
$$

### Dual constraints

The portion ratio must satisfy **both** constraints — hit the energy target
*and* land at the seven-tenths-full scale point ($\text{HFS}^* = 7$):

$$
r_E = \frac{E_{\text{target},t}}{E_{\text{total}}},
\qquad
r_H = \mathrm{Clip}\!\left(
  \frac{\text{HFS}^* - \beta_0}{\beta_1 C + \beta_2 P + \beta_3 F_b - \beta_4 F_t},
  \; r_{\min},\; r_{\max}
\right)
$$

Fused with a blending weight $\alpha$ (default 0.5):

$$
r_{\text{base}} = (1 - \alpha)\, r_E + \alpha\, r_H
$$

### Dynamic target correction

The system adapts the *target itself* when recent reported fullness $\bar{\text{HFS}}$
drifts from $\text{HFS}^*$:

$$
E_{\text{target},t} = \mathrm{Clip}\!\left(
  E_{\text{base},m} \times \left[1 + \omega \frac{\text{HFS}^* - \bar{\text{HFS}}}{\sigma_{\text{HFS}} + \varepsilon}\right],
  \; E_{\min},\; E_{\max}
\right)
$$

### Flexible quota allocation

`allocateFlexibleQuota` walks the dish list and iteratively cuts portions
(≤ 6 passes) toward $r_{\text{base}}$, always stopping at per-category floor
ratios (e.g. staples at 0.5, fried food at 0.3). Result: `keepById` multipliers
per dish, calories reduced, and an explicit shortfall when even all floors are
reached — the caller can decide how to handle the remainder.

---

## Algorithm III — Bayesian adaptive calibration (`src/bayesian.ts`)

The calibrated intake ratio $c$ is the hidden state. Each meal is an
**observation of the state contaminated by satiety feedback**:

$$
y_t = \theta_t \times (1 - \lambda\, F_t), \qquad
\lambda = 0.08,\quad F_t \in \{-1, 0, +1\}
$$

$\theta_t$ is the reported intake ratio and $F_t$ the satiety class. A normal-
normal (Kalman) filter maintains the posterior:

$$
K = \frac{s^2}{s^2 + \tau^2},
\qquad
m' = m + K\,(y - m),
\qquad
s'^2 = (1 - K)\, s^2
$$

Prior $c_0 \sim \mathcal{N}(1.0,\ 0.25)$. The posterior mean is clipped to
$[c_{\min}, c_{\max}] = [0.8, 1.2]$ and the **direction verdict** (up / hold /
down) gets a ±0.05 hysteresis band so small noisy swings do not churn the
advice. The factor is applied multiplicatively to the recommendation:

$$
r_{\text{rec}} = c \times r_{\text{base}},\qquad
c = \mathrm{Clip}(m,\ c_{\min},\ c_{\max})
$$

> **Why Bayesian?** A naive moving average over-reacts to single meals and
> cannot express "how sure we are". The Kalman gain $K \to 0$ as evidence
> accumulates: the filter converges while remaining responsive early on.

---

## Algorithm I — plate geometry estimation (`src/geometry.ts`)

When a vision model supplies bounding boxes (and optionally a rough mass
prior), the plate is reconstructed geometrically:

1. **Projection area** — each component's bbox area ratio to the plate:
   $\text{AreaRatio}_i = \text{Area}_i / \text{Area}_{\text{plate}}$.
2. **Volume score** — $V_i = K_i \times \text{AreaRatio}_i \times H_i$
   (per-category form factor × area × height), normalized to shares
   $\omega_i = V_i / \sum V_j$.
3. **Mass** — trust the vision prior inside $[M_{\min}, M_{\max}]$,
   otherwise fall back to a plate-density model:
   $M_i = M_{\text{ref,plate}} \times \omega_i \times \rho_i / \bar{\rho}$
   with $M_{\text{ref,plate}} = 450$ g.
4. **Macros** — $E = \sum M_i C_i$ using per-category density tables.

Recommendation radius (for drawing the "eat this much" circle):

$$
R_{\text{rec}} = \frac{\min(w, h)}{2} \times \sqrt{k_{\text{keep}}}
$$

---

## Quick start

```bash
npm install
npm test          # Vitest: 94 unit tests
npm run demo      # 7-day simulated feedback loop (terminal colors if TTY)
npm run build     # tsc → dist/ (ES2020, CommonJS, strict)
```

The demo simulates a user whose true intake ratio is 1.1 while the system
starts from 1.0, feeds curated daily feedback (including an over-eating day
with a shield card), and prints the convergence of the calibration factor.

---

## Hyperparameters & calibration

All tuning knobs are exported as **configurable interfaces** with documented
placeholder defaults — production values were deliberately not shipped:

| Config | Default | Meaning |
|---|---|---|
| `HfsConfig.betas` | `[3.0, 0.003, 0.05, 0.08, 0.03]` | Fullness regression β₀…β₄ |
| `HfsConfig.hfsStar` | `7` | Seven-tenths-full scale point |
| `HfsConfig.correctionOmega` | `0.1` | Dynamic-target sensitivity |
| `HfsConfig.fusionAlpha` | `0.5` | Energy/fullness blend weight |
| `HfsConfig.rMin / rMax` | `0.3 / 1.3` | Portion ratio clipping |
| `BayesianConfig.lambda` | `0.08` | Satiety sensitivity on observations |
| `BayesianConfig.tauSq` | `0.2` | Kalman measurement noise |
| `BayesianConfig.cMin / cMax` | `0.8 / 1.2` | Posterior clipping |

Pass a partial config to any entry point; it deep-merges over the default
(`resolveHfsConfig`, `resolveBayesianConfig`). Re-fit `betas` on your own
satiation survey; tune `tauSq` to match the noise of your measurement channel.

---

## License

Copyright (c) 2026 JustSeven Team. This project is released under the
[Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](https://creativecommons.org/licenses/by-nc/4.0/)
license — see [LICENSE](./LICENSE) for the full legal text.

**Allowed** — no further permission needed:

- Academic research, teaching, and learning
- Personal or non-commercial evaluation, experimentation, and development
- Non-commercial redistribution with attribution

**Strictly prohibited**:

- Any commercial use — selling, SaaS hosting, or embedding this library in a
  paid product
- Enterprise integration or use within a for-profit organization's services
- For-profit derivative works or commercial services built on this library

Commercial use requires a separate commercial license — please contact the
authors to obtain one.
