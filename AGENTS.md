# Repository Guidelines

## Project Structure & Module Organization
Twiglane is a lightweight desktop Git client built with Svelte 5, TypeScript, Rust, and Tauri 2.

- `src/App.svelte` and `src/app.css` define the application shell and styling.
- `src/lib/components/` contains UI components; `src/lib/` holds API wrappers, types, and UI logic.
- `src-tauri/src/` contains native commands, state, security, and filesystem watching; `git/` implements Git operations.
- `tests/` contains frontend tests. Rust tests live alongside backend modules.
- `public/` and `src-tauri/icons/` hold assets. `scripts/` provides fixtures, delivery checks, and UI mocks; `docs/verification/` stores verification evidence.

## Build, Test, and Development Commands
Use Node.js 26 (matching CI), stable Rust, system Git, and the platform's Tauri prerequisites.

- `npm ci`: install dependencies from the lockfile.
- `npm run tauri dev`: run the desktop app with Vite hot reload.
- `npm run preview:ui`: preview mocked UI at `http://127.0.0.1:1430`.
- `npm run check`: check Svelte and TypeScript.
- `npm test`: run frontend tests once.
- `npm run build`: build the frontend; `npm run tauri build` produces native bundles.
- `cargo test --manifest-path src-tauri/Cargo.toml`: run backend tests.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`: enforce Rust lint checks.

## Coding Style & Naming Conventions
Match existing code: two-space indentation, double quotes, and semicolons in TypeScript; four-space indentation in Rust. Use PascalCase for Svelte components and types, camelCase for TypeScript functions, and snake_case for Rust modules and functions. Keep TypeScript strict. Preserve camelCase invoke arguments across the TypeScript–Rust boundary. No dedicated ESLint or Prettier configuration is present.

## Testing Guidelines
Frontend tests use Vitest, happy-dom, and Testing Library. Name files `tests/<feature>.spec.ts`; use descriptive `describe`/`it` cases. Add regression coverage for changed behavior, especially stale responses, Git failures, and destructive-operation boundaries. Use Rust's test framework for backend behavior. No numeric coverage threshold is configured. Run the CI checks above before submitting; mocked previews do not verify real Git behavior.

## Commit & Pull Request Guidelines
History primarily uses `feat:` and `fix:` prefixes with concise Chinese descriptions. Follow that convention for relevant changes. PRs should explain behavior changes, link relevant issues, list validation results and platform limits, and include screenshots for UI changes.

## Security & Verification
Run Git through argument arrays without a shell; preserve write serialization, generation checks, and credential redaction. Never commit credentials. For delivery claims, run `npm run verify:delivery` against actual evidence; distinguish tested platforms from intended support.
