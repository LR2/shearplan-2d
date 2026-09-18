# ShearPlan 2D

Guillotine shear cutting optimizer with yield-aware part-family grouping.
Single-page React app — runs entirely in the browser; plans are saved in
your browser's local storage.

## Develop locally

    npm install
    npm run dev

## Deploy

Pushing to `main` builds and deploys to GitHub Pages automatically
(see `.github/workflows/deploy.yml`). In the repo settings, set
Pages → Source to "GitHub Actions" once.

## Review changes

- Production (`main`): https://lr2.github.io/shearplan-2d/
- Review branch (`codex-review`): https://lr2.github.io/shearplan-2d/codex-review/

Push changes to `codex-review`, wait for **Validate review preview** and then
**Deploy to GitHub Pages** to finish, and review the preview URL. Review one
feature or related group of fixes at a time; merge approved changes into `main`.
Keep the review branch for subsequent work and bring it up to date with `main`
after merging.

GitHub Pages serves one combined deployment. The deployment workflow on `main`
builds production at the root and the latest successfully validated review commit
under `codex-review/`. A failed preview validation leaves the previous preview
live. Preview pushes trigger deployment through `workflow_run` on `main`, so
the existing Pages environment can remain restricted to `main`. No additional
tokens or hosting services are needed.

Preview builds receive `VITE_STORAGE_NAMESPACE=shearplan:codex-review:` to keep
their saved plans separate from production. The preview starts with no saved
production plans; use the app's export/import controls to copy plans for testing.
Normal production builds retain the existing storage keys. The deployed preview
commit can be checked at `codex-review/version.json`.

## Cutting and shop settings

- New jobs enable **Strong** part grouping and disable saved remnants. Enable **Allow
  remnants** to classify reusable drops, credit them toward net yield, and use
  the remnant preference. Existing explicit grouping choices in saved jobs are
  preserved.
- Grouping presets allow gross-yield losses of **0 pp** (Yield First), **2.5 pp**
  (Balanced), **5 pp** (Strong), and **8 pp** (Ultra). Slider values between presets
  interpolate those caps. The bar shows an amber warning above **5 pp**, including
  when a manual loss cap overrides the slider.
- **Blade & edges → Plate thickness preset** applies the 15 entries supplied in
  `Blade and Edges Presets.xlsx` (Sheet1, rows 2–16). The cut allowance applies to
  both directions; the edge allowance applies separately to each of four sides.
  Editing a value switches to Custom. Selecting Custom retains the current values.
- The four search-effort buttons set the time per search phase. Grouping uses
  separate baseline and grouped phases.
- After sheet assignments are selected, a second nesting pass tries family rows,
  columns, grids, and allowed rotations within each sheet. It then rebuilds a
  complete guillotine cut tree, minimizing cut count first, total cut length
  second, and gauge changes when those tie. Ready cuts within a stage reuse the
  current gauge where possible. This applies with grouping on or off and to
  every grouping comparison level.
- The final pass keeps the exact part instances on each blank, stock sizes,
  sheet order, gross yield, rotation locks, kerf, first-cut direction, stage
  limits, and existing saved drops. Drawings, cut lists, repeat counts and reports
  are rebuilt from the same final geometry. It reports progress and supports
  stopping between sheets. Initial blank edge trims are still performed before
  the listed production cuts.
- Repacking is bounded: at most 128 block combinations, 6,000 packing trials
  (fewer for larger sheets), and 24 candidate layouts receive cut-tree searches.
  Sheets above 256 parts still receive fixed-layout cut refinement. The existing
  valid plan remains the fallback; this is not a guarantee of a global minimum.
- The supplied 120 × 48 example with four plenums, two wraps and four caps is a
  regression fixture. Its 18-cut layout becomes a 12-cut, three-stage layout at
  the same 91.53% gross yield, with 36′2″ of cutting versus CutLogic's reported
  38′8″. The cap row is rotated to share trims and the plenums stay together.
- Printing works from Results and Report. Report options control the printed
  copy, including cut sequences when layout drawings are unchecked.

Run `npm test` for the cutting geometry, sheet repacking, grouping, settings and
storage regression tests.
