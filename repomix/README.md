# Repomix split configs

I split the repomix pack because the full one is too big to hand to an LLM in one go: 396 files, about 1.18M tokens by my count (repomix itself counted about 1.23M). The parts below are measured from the Nov 23, 2026 pack off main at `fae46ac`. Sizes are estimates (chars / 4); repomix counts with `o200k_base`, so its numbers run a little higher.

## Parts

| Part | Config | What it covers | Size |
| --- | --- | --- | --- |
| Core runtime | `repomix.config.core-runtime.json` | `src/api`, `src/content`, `src/document-pipeline`, `src/offscreen`, `src/service-worker`, `src/shared`, `src/validators`, manifests, `build.mjs`, `package.json`, `tsconfig.json`, `eslint.config.js` | ~371k tokens, 108 files |
| Core UI | `repomix.config.core-ui.json` | `src/popup`, `src/sidepanel` | ~187k tokens, 14 files |
| Supabase backend | `repomix.config.supabase.json` | `supabase/` (Edge Functions, migrations, config) | ~50k tokens, 19 files |
| Docs | `repomix.config.docs.json` | `docs/`, README, CHANGELOG, CONTRIBUTING, SECURITY, LICENSE, AGENTS.md, `schema/`, `release/`, `.github/` | ~123k tokens, 76 files |
| Tests | `repomix.config.tests.json` | `tests/`, `vitest.config.ts` | ~326k tokens, 143 files |
| Tooling | `repomix.config.tooling.json` | `scripts/`, `tools/` (build, verify gates, screenshot/OCR helpers, pack builders) | ~127k tokens, 51 files |
| Full (fallback) | `repomix.config.full.json` | Everything, same exclusions as the Nov 23 run | ~1.18M tokens, 396 files |

Give an LLM one part at a time. Core runtime + UI together are the whole extension; docs + tests stand on their own.

## How to run

From the repo root:

```powershell
npx repomix --config repomix/repomix.config.core-runtime.json
```

Or run every part at once:

```powershell
.\repomix\run-split.ps1
```

Outputs land in `repomix/output/` (gitignored — never committed). The full pack is the fallback; prefer the split parts when handing code to an LLM.

## What is always excluded

- `vendor/**` and `data/**` — the medical packs and dictionaries (~14 MB of generated data, not hand-written code). Nobody needs to read those to understand the extension.
- Everything in `.gitignore` and repomix's default ignore patterns.

`src/content/detectors/nameDictionaries.ts` used to be a 2 MB generated census file and was excluded from the Nov 18 pack. It is small now (about 6 KB in the Nov 23 pack), so it needs no special exclusion — it rides along in the core-runtime part.

## Security check is off — on purpose

Every config sets `"security": { "enableSecurityCheck": false }`. The check flags test fixtures that contain synthetic secrets (fake SSNs, cards, API keys used to test detection). This repo's rule is synthetic test data only, and the repo is public, so nothing real is at risk. Leaving the check on would silently drop those test files from the pack. If real secrets ever land in the repo, that rule — not this config — is what failed.
