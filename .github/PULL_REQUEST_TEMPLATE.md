<!--
Per PORTING_PLAN.md, every section below MUST be filled.
An empty section is not acceptable — use `N/A — <reason>` explicitly if a section truly does not apply (e.g., infra-only PR with no upstream files ported).
-->

## Upstream files ported

<!--
List each upstream Python file ported in this PR with its LOC count.
Format: `- path/to/file.py — <LOC> LOC`
LOC source: `wc -l /Users/knosis/.opensrc/repos/github.com/nousresearch/hermes-agent/main/<path>`
-->

- N/A — <reason>

## TypeScript files produced

<!--
List each .ts file created or modified in this PR with its LOC count.
Format: `- packages/<name>/src/<file>.ts — <LOC> LOC`
-->

- N/A — <reason>

## Tests added

<!--
List each test file with the number of test cases it contains.
Format: `- packages/<name>/tests/<file>.test.ts — <N> cases`
-->

- N/A — <reason>

## Faithful Divergences

<!--
Every JS-idiomatic substitution made vs. the upstream Python must be listed here
with the upstream file:line reference, so reviewers can audit fidelity.
Examples:
  - `dict` → `Map` in `state.ts:42` (upstream `hermes_state.py:118`) — ordered iteration preserved.
  - `asyncio.Lock` → `async-mutex` Mutex in `agent.ts:77` (upstream `agent/runner.py:204`).
If you did NOT diverge, say so explicitly.
-->

- N/A — <reason>

## Coverage summary

<!--
Paste the actual `bun run test` coverage table output here. Do NOT claim 100% — show it.
The CI gate enforces 100% lines/statements/functions/branches; PRs that drop below will fail.
-->

```
<paste coverage table here>
```

## Deferred tests

<!--
Link each entry this PR adds to docs/deferred-tests.md.
Every `/* v8 ignore */` directive in this PR must correspond to either:
  (a) an entry here with rationale and a follow-up task ID, OR
  (b) a reviewer-signed inline justification in the diff.
-->

- N/A — <reason>

---

### Reviewer checklist

- [ ] Every section above is filled (no empty bullets, no removed sections).
- [ ] Coverage table pasted shows 100% across all four metrics (or deferred entries explain the gap).
- [ ] Faithful Divergences cite upstream `file:line`.
- [ ] CI is green.
