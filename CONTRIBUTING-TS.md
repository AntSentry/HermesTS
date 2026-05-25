# Contributing to HermesTS

This guide is for contributors working on the **TypeScript port** of `nousresearch/hermes-agent`. It complements (does not replace) `CONTRIBUTING.md`, which comes from the upstream Python project.

For the strategy, module breakdown, and dependency ordering of the port, see [`PORTING_PLAN.md`](./PORTING_PLAN.md).

---

## Picking up a sub-task

The port is coordinated through the team task list. To grab work:

1. `TaskList` — list every task with `status`, `owner`, and `blockedBy`.
2. Pick the **lowest-ID unblocked** task with `status: pending` and no `owner`. Earlier IDs usually set up context the later ones depend on.
3. `TaskUpdate` to claim it: set `status: in_progress` and `owner: <your-name>` in the same call.
4. If you hit something that blocks you, leave `status: in_progress` and either resolve the blocker, open a new task describing it, or escalate via `SendMessage` to `team-lead@hermests-port`.
5. Only mark `status: completed` when the work is actually done — tests green, PR open, coverage at the configured threshold.

---

## Branch naming

Branches map 1:1 to task scope. Use these prefixes:

| Prefix | When |
|---|---|
| `port/<package>` | Porting one full upstream module (e.g. `port/core`, `port/state`). |
| `port/<package>-<subtask>` | A slice of a larger module (e.g. `port/agent-loop`, `port/tools-registry`). |
| `docs/<topic>` | Documentation-only changes (e.g. `docs/dep-mapping`, `docs/coverage-policy`). |
| `chore/<topic>` | Repo hygiene, tooling, CI, or build changes (e.g. `chore/repo-hygiene`, `chore/biome-bump`). |

One branch per task. Don't piggyback unrelated changes — they slow review and make reverts painful.

---

## Local setup

Requirements: Node `>=20`, Bun `>=1.1` (see `engines` in `package.json`).

```bash
bun install
bun run typecheck
bun run test
```

`bun run test` runs Vitest with coverage; expect it to take longer as more packages land. Use `bun run test:watch` while iterating, and `bun run lint` / `bun run format` for Biome.

---

## Coverage rule

**The 100% line / branch / function / statement threshold in `vitest.config.ts` is enforced and CI will hard-fail below it.** Do not lower the threshold to "ship green."

- Add the tests the code requires.
- If a line is genuinely unreachable, exclude it with `/* v8 ignore */` and a one-line comment explaining why.
- Any `v8 ignore` needs reviewer sign-off in the PR description.

See `PORTING_PLAN.md` § "Coverage discipline" for the full rationale.

---

## PR discipline

Every PR must:

- Use the PR template at `.github/pull_request_template.md` (filled in, not stubbed).
- Include the coverage summary from `bun run test` output — paste the table, don't link to a CI artifact that may expire.
- List **faithful divergences** from the upstream Python: any place the TS port intentionally differs (idiom, API shape, error type, library swap) gets a bullet with the reason. Silent divergences are the failure mode this project is designed to prevent.
- Reference the upstream source paths and the target paths in this repo, per `PORTING_PLAN.md` § "Reference checking".

Open the PR against `main`. Squash-merge is the default.

---

## Worktree pattern for parallel work

Multiple agents (human or AI) regularly work on independent sub-tasks at the same time. To avoid stomping on each other, use git worktrees:

```bash
# from the main checkout
git worktree add ../HermesTS-worktrees/<branch-name> -b <branch-name> main
cd ../HermesTS-worktrees/<branch-name>
bun install
```

Each worktree gets its own working directory and `node_modules`, so two tasks editing different packages never collide. When the PR merges, clean up:

```bash
git worktree remove ../HermesTS-worktrees/<branch-name>
git branch -d <branch-name>
```

The shared convention for this repo is to put worktrees under `../HermesTS-worktrees/<branch-name>/` next to the main checkout.

---

## Where to ask questions

- **Coordination / task assignment / blockers:** `SendMessage` to `team-lead@hermests-port`.
- **Strategy / scope / "is this in scope for the port":** open a `docs/` PR proposing the change against `PORTING_PLAN.md`.
- **Bugs in the porting tooling itself:** open an issue tagged `tooling`.

Keep `PORTING_PLAN.md` as the source of truth for what the port is and is not. This file only covers *how* contributors operate inside that plan.
