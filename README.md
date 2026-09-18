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

- New jobs enable part grouping and disable saved remnants. Enable **Allow
  remnants** to classify reusable drops, credit them toward net yield, and use
  the remnant preference. Existing explicit grouping choices in saved jobs are
  preserved.
- **Blade & edges → Plate thickness preset** applies the 15 entries supplied in
  `Blade and Edges Presets.xlsx` (Sheet1, rows 2–16). The cut allowance applies to
  both directions; the edge allowance applies separately to each of four sides.
  Editing a value switches to Custom. Selecting Custom retains the current values.
- The four search-effort buttons set the time per search phase. Grouping uses
  separate baseline and grouped phases.
- After nesting, the cut sequencer compares alternate guillotine trees for each
  selected layout, minimizing cut count first and total cut length second. It
  can trim a common edge before separating parts. It preserves part geometry,
  kerf, first-cut direction, stage limits, and enabled saved remnants. The search
  is bounded for responsiveness and keeps the original valid sequence if it
  cannot improve it; this is not a guarantee of a global minimum. Initial blank
  edge trims are still performed before the listed production cuts.
- Printing works from Results and Report. Report options control the printed
  copy, including cut sequences when layout drawings are unchecked.

Run `npm test` for the cutting-geometry, settings and storage regression tests.
