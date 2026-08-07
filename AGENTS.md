# Agent Instructions

- **Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first.** It is a compact map of the codebase —
  file responsibilities, the thread/data-flow model, key invariants, and where to look for public API
  detail (the README). Use it to go straight to the relevant file instead of searching from scratch.
- **Keep the docs current.** Whenever you make an architectural change — a new/removed component or
  system, a change to the thread model, the public API surface, an invariant, or a dev-workflow
  command — update `docs/ARCHITECTURE.md` (and the README if the public API changed) in the same
  change so they never drift from the code.
- Keep comments concise and rare. Only comment non-obvious things: a hidden gotcha, an invariant, or the reason code must work a certain way. Never restate what the code already says, and don't narrate what a function does when its name and body make it clear. Prefer one short line over a paragraph.
- Never cast types to `any`
- Always check there are no lint or type errors after editing a file
- Do not ever use @ts-nocheck
- Use "npm run type-check" and "npm run lint" after changes to verify type and formatting is correct
- Do not run git commands
- Do not modify NOTES.md