# @hermests/agent

Subpackage 5f of the agent port — skill plumbing, prompt assembly,
onboarding hints, and title generation.

Files ported from `upstream/agent/`:

| upstream file | ts file |
|---|---|
| `skill_utils.py` (566 LOC) | `src/skills/skill-utils.ts` |
| `skill_preprocessing.py` (139 LOC) | `src/skills/skill-preprocessing.ts` |
| `skill_commands.py` (523 LOC) | `src/skills/skill-commands.ts` |
| `skill_bundles.py` (410 LOC) | `src/skills/skill-bundles.ts` |
| `prompt_builder.py` (1465 LOC) | `src/prompt/prompt-builder.ts` |
| `onboarding.py` (193 LOC) | `src/onboarding/onboarding.ts` |
| `title_generator.py` (171 LOC) | `src/title/title-generator.ts` |

Cross-package dependencies that have not yet been ported are wired through
the runtime extension registry in `src/extensions/` — see that module's
docstring. Tests install fakes; production code installs the real
packages once they ship (`@hermests/tools`, `@hermests/gateway`,
`@hermests/cli`, and `@hermests/agent/auxiliary-client` from #5j).
