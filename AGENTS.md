# Repository Guidelines

## Project Structure & Module Organization
- Vite + React app lives under `src/`. `src/App.tsx` contains the wood vs. heating calculator and should stay framework-agnostic so it can be embedded elsewhere.
- Entry wiring is in `src/main.tsx` and `index.html`. Tailwind utilities are declared in `src/index.css`.
- Ember CO₂ intensity samples reside in `public/data/monthly_full_release_long_format.csv`; the app fetches this file on startup and expects the latest 12 months per country (any `CO2 intensity` area found) with untouched column headers.

## Build, Test, and Development Commands
- `npm install` (or `pnpm install`) to pull React, Tailwind, lucide-react, and papaparse dependencies.
- `npm run dev` launches the Vite dev server with hot reloading.
- `npm run build` performs a type check then emits a production bundle to `dist/`.
- `npm run preview` serves the built bundle locally for smoke testing.
- `npm run typecheck` runs `tsc --noEmit`; use it before pushing if you skip the full build.

## Coding Style & Naming Conventions
Use TypeScript in strict mode, camelCase for variables, PascalCase for components, and keep helpers pure where possible. Favor React hooks (`useState`, `useMemo`, `useEffect`) over ad-hoc side effects. Stick with Tailwind utility classes already in use; extend styling via `src/index.css` if Tailwind cannot express it cleanly. Prefer async/await over chained `.then` unless streaming. Collapsible UI (Details & Explanation card) should stay accessible—button toggles must be focusable and labelled.

## Testing Guidelines
Manual verification: `npm run dev`, confirm the bundled Ember data loads automatically (open Details & Explanation → Grid data), switch between several countries (including ones you add to the CSV) to verify intensity changes, inspect the doughnut energy-mix chart (nuclear, fossil, renewables) for sanity, and ensure the Open-Meteo geocoded temperature fetch succeeds or falls back gracefully. When adding computational helpers, include unit tests in a colocated `__tests__` directory (Vitest or Jest) or document deterministic calculations in the PR. Capture console output or screenshots if behaviour changes.

## Commit & Pull Request Guidelines
Write imperative, scope-aware commit messages (e.g., `Refine Kyoto decline model`). Squash noisy commits before opening a PR. In the PR description include: motivation, notable UI/UX adjustments, manual test steps with datasets used, and any follow-ups or tech debt. Link issues or tickets and attach screenshots/recordings for visual changes.

## Security & Configuration Tips
Never commit secrets—ElectricityMaps keys should be piped via environment variables or local config. Keep fetches resilient by handling network failures and fallback paths for missing CSV fields. Open-Meteo geocoding/forecast endpoints are the only network calls; guard against failures before merging. Tailwind and Vite configs are loaded from the workspace; review diffs for unwanted plugin additions before merging.
