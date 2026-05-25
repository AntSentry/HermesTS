# Port Brief: `@hermests/skills` (Task #7)

Upstream source: `nousresearch/hermes-agent` at `skills/` and `optional-skills/`.

---

## 1. Module summary

The upstream `skills/` and `optional-skills/` trees are the **content** half of
Hermes' skill system. Each skill is a self-contained directory whose entry
point is a `SKILL.md` markdown file with a YAML frontmatter block. Skills are
discovered at runtime by walking these trees and parsing the frontmatter; the
body markdown is injected into the model prompt when the skill is activated.
A subset of skills additionally ship Python helper scripts under `scripts/`
that the skill body invokes via the agent's shell-execution toolset (the model
calls `python skills/.../scripts/foo.py --flag` from inside its sandbox).

The **loader** — discovery, frontmatter parsing, platform gating, namespace
resolution, hub fetch, sync, guard, usage tracking — does **not** live in the
`skills/` tree. It lives in `agent/skill_utils.py`, `agent/skill_commands.py`,
`agent/prompt_builder.py`, `agent/curator.py`, `agent/curator_backup.py`,
`tools/skills_hub.py`, `tools/skills_sync.py`, `tools/skills_guard.py`,
`tools/skills_tool.py`, `tools/skill_usage.py`, `tools/skill_manager_tool.py`,
and `hermes_cli/skills_hub.py`. Those are covered by tasks **#5 (agent)**,
**#6 (tools)**, and **#14 (cli)** — **not** by this task.

What this task ports:

1. The 91 skill directories themselves — every `SKILL.md`, `README.md`,
   `references/*.md`, `templates/*`, `prompts/*`, asset, manifest, and lock
   file — copied or vendored verbatim into `packages/skills/`.
2. The **43 Python helper scripts** that ship inside skill directories and
   are invoked by skill bodies at runtime. These must be translated to
   equivalent TypeScript (`packages/skills/.../scripts/foo.ts` run via Bun) or
   left as Python with a documented runtime requirement, depending on the
   subdivision decisions below.
3. The handful of upstream tests that target skill scripts directly
   (only `skills/creative/comfyui/tests/`, 6 files, 1,072 LOC).
4. A `packages/skills/src/index.ts` that publishes the resolved on-disk path
   of the bundled `skills/` and `optional-skills/` trees so `@hermests/agent`
   can scan them via `iter_skill_index_files()`'s TS equivalent.

The package has **no runtime logic of its own** beyond exposing those paths
and (where ported) the helper-script entry points. It is closer to a
content package than a code package.

### LOC accounting

| Tree | Files (total) | `.py` files | `.py` LOC | Markdown / asset files |
|---|---|---|---|---|
| `skills/` | 570 | 43 | 13,084 | ~527 (mostly `.md`, plus `.txt`, `.json`, `.yaml`, `.lock`, `.svg`, `.png`, templates) |
| `optional-skills/` | (per task brief: 48 `.py` files, 16,786 LOC) | 48 | 16,786 | (remainder is markdown + manifests) |
| **Total** | ~660 | **91** | **29,870 LOC of Python** | ~530 content files |

The task description states "43 files, 13,084 LOC" for skills and "48 files,
16,786 LOC" for optional-skills — these refer to **`.py` files only**. The
markdown/asset count dwarfs the script count, which is exactly why this task
is content-heavy and **not** a typical port.

---

## 2. File inventory

### 2a. Top-level structure

```
skills/                              570 files total
├── apple/             (5 SKILL.md, 0 .py — pure markdown; calls system osascript)
├── autonomous-ai-agents/  (5 SKILL.md, 0 .py)
├── creative/          (~19 skills; 21 .py in 3 skills: comfyui, pixel-art, excalidraw)
├── data-science/      (1 skill, 0 .py)
├── devops/            (3 skills, 0 .py)
├── diagramming/       (1 skill, 0 .py)
├── dogfood/           (1 skill, 0 .py)
├── domain/            (markdown reference, 0 .py)
├── email/             (1 skill: himalaya, 0 .py — invokes himalaya CLI)
├── gaming/            (2 skills, 0 .py)
├── gifs/              (1 skill, 0 .py)
├── github/            (6 skills, 0 .py — wraps gh CLI)
├── index-cache/       (manifest only)
├── inference-sh/      (1 skill, 0 .py)
├── mcp/native-mcp/    (1 skill, 0 .py)
├── media/             (5 skills, 1 .py: youtube-content/fetch_transcript.py)
├── mlops/             (7 skills, 0 .py)
├── note-taking/       (1 skill: obsidian, 0 .py)
├── productivity/      (10 skills, ~13 .py: google-workspace, linear, maps, ocr-and-documents, powerpoint)
├── red-teaming/       (1 skill: godmode, 4 .py)
├── research/          (5 skills, 2 .py: arxiv, polymarket)
├── smart-home/        (1 skill, 0 .py)
├── social-media/      (1 skill, 0 .py)
├── software-development/ (11 skills, 0 .py — mostly process/methodology)
└── yuanbao/           (1 skill, 0 .py)

optional-skills/                     similarly structured
├── autonomous-ai-agents/  (2 skills, 0 .py)
├── blockchain/        (3 skills: evm, hyperliquid, solana — 3 large .py clients, 3,866 LOC)
├── communication/     (1 skill, 0 .py)
├── creative/          (5 skills, 3 .py: kanban-video-orchestrator, meme-generation)
├── devops/            (4 skills, 3 .py: watchers/{_watermark, watch_github, watch_http_json, watch_rss})
├── dogfood/           (1 skill, 0 .py)
├── email/             (1 skill: agentmail, 0 .py)
├── finance/           (8 skills, 4 .py: dcf-model, excel-author, stocks)
├── health/            (2 skills, 2 .py: fitness-nutrition)
├── mcp/               (2 skills, 4 .py + .py templates: fastmcp)
├── migration/         (1 skill, 1 .py: openclaw-to-hermes)
├── mlops/             (24 skills, 1 .py template: trl-fine-tuning)
├── productivity/      (7 skills, 3 .py: canvas, memento-flashcards, telephony)
├── research/          (11 skills, 16 .py: darwinian-evolver, domain-intel, drug-discovery, osint-investigation × 13)
├── security/          (3 skills, 1 .py: oss-forensics/evidence-store.py)
├── software-development/ (1 skill, 0 .py)
└── web-development/   (1 skill, 0 .py)
```

### 2b. Skills with helper scripts (the actual porting work)

These are the only skills that contain executable code. Everything else is
markdown + assets and is a `cp -R` vendoring exercise.

#### Required (`skills/`) — 12 skills with scripts, 43 `.py` files, 13,084 LOC

| Skill | Files | LOC | Notes |
|---|---|---|---|
| `creative/comfyui` | 10 scripts + 6 tests | 3,996 + 1,072 | Largest. WS monitor, workflow runner, dep checker, hardware probe. Heavy. Has the only tests in `skills/`. |
| `creative/excalidraw` | 1 (upload.py) | 95 | Small CLI uploader. |
| `creative/pixel-art` | 4 (pixel_art, pixel_art_video, palettes, __init__) | 738 | PIL-style image manipulation. |
| `media/youtube-content` | 1 (fetch_transcript.py) | ~150 | Fetches transcripts via youtube-transcript-api (or its TS equivalent). |
| `productivity/google-workspace` | 4 (_hermes_home, google_api, gws_bridge, setup) | 1,829 | OAuth flow + Google APIs. Largest single helper file (`google_api.py`, 1,221 LOC). |
| `productivity/linear` | 1 (linear_api.py) | 445 | GraphQL client. |
| `productivity/maps` | 1 (maps_client.py) | 1,298 | Multi-provider geocoding/routing client. |
| `productivity/ocr-and-documents` | 2 (extract_marker, extract_pymupdf) | 185 | PDF → text via two backends. |
| `productivity/powerpoint` | 4 + nested helpers (add_slide, clean, office/pack, helpers/{merge_runs, simplify_redlines}, __init__ × 2) | 568 | python-pptx wrapper. |
| `red-teaming/godmode` | 4 (auto_jailbreak, godmode_race, load_godmode, parseltongue) | 1,894 | Largest single skill by LOC. |
| `research/arxiv` | 1 (search_arxiv.py) | ~190 | arXiv API client. |
| `research/polymarket` | 1 (polymarket.py) | ~280 | Polymarket API client. |

#### Optional (`optional-skills/`) — 18 skills with scripts, 48 `.py` files, 16,786 LOC

| Skill | Files | LOC | Notes |
|---|---|---|---|
| `blockchain/evm` | 1 (evm_client.py) | 1,508 | Multi-chain EVM client, stdlib only. |
| `blockchain/hyperliquid` | 1 (hyperliquid_client.py) | 1,660 | Hyperliquid `/info` client, stdlib only. |
| `blockchain/solana` | 1 (solana_client.py) | 698 | Solana RPC + CoinGecko, stdlib only. |
| `creative/kanban-video-orchestrator` | 2 (bootstrap_pipeline, monitor) | ~500 | Pipeline orchestrator. |
| `creative/meme-generation` | 1 (generate_meme.py) | ~200 | Meme-template renderer. |
| `devops/watchers` | 4 (_watermark, watch_github, watch_http_json, watch_rss) | ~550 | Cron-friendly poller scripts. |
| `finance/dcf-model` | 1 (validate_dcf.py) | 292 | DCF validator. |
| `finance/excel-author` | 1 (recalc.py) | 88 | xlsx recalc trigger. |
| `finance/stocks` | 1 (stocks_client.py) | 755 | Multi-provider stocks API. |
| `health/fitness-nutrition` | 2 (body_calc, nutrition_search) | ~400 | BMI/nutrition calculators. |
| `mcp/fastmcp` | 1 script (scaffold_fastmcp.py) + 3 template `.py` files | ~600 | Scaffolder. Templates are **not** executed by Hermes; they are emitted into user projects. |
| `migration/openclaw-migration` | 1 (openclaw_to_hermes.py) | ~400 | One-shot migration tool. |
| `mlops/training/trl-fine-tuning` | 1 template (basic_grpo_training.py) | ~200 | **Template, not runtime code** — emitted into user projects. |
| `productivity/canvas` | 1 (canvas_api.py) | ~300 | Canvas LMS client. |
| `productivity/memento-flashcards` | 2 (memento_cards, youtube_quiz) | ~500 | Flashcard ops. |
| `productivity/telephony` | 1 (telephony.py) | ~400 | Telephony provider client. |
| `research/darwinian-evolver` | 2 scripts + 1 template (parrot_openrouter, show_snapshot, custom_problem_template) | ~600 | Evolution loop driver. |
| `research/domain-intel` | 1 (domain_intel.py) | ~400 | Domain WHOIS/DNS intel. |
| `research/drug-discovery` | 2 (chembl_target, ro5_screen) | ~400 | ChEMBL + Lipinski Ro5. |
| `research/osint-investigation` | 16 scripts (12 fetchers + entity_resolution + build_findings + timing_analysis + _http + _normalize) | 2,875 | **Largest single skill in the project.** Fetchers for SEC EDGAR, OFAC SDN, OpenCorporates, ICIJ Offshore, GDELT, CourtListener, NYC ACRIS, Senate LD, USA Spending, Wayback, Wikipedia. |
| `security/oss-forensics` | 1 (evidence-store.py) | ~250 | Evidence chain-of-custody store. |

### 2c. Content-only skills (markdown + assets, no `.py`)

There are roughly **73 skills with no scripts** — pure markdown SKILL.md
plus optional `references/`, `templates/`, `prompts/`, and asset folders.
These vendor verbatim with **zero porting effort beyond the file copy**.
Examples: every `apple/*` skill (uses macOS `osascript`), every `github/*`
skill (wraps `gh`), `email/himalaya` (wraps `himalaya` CLI), all of
`software-development/*` (pure methodology docs), all of `mlops/*` (24 of
27 are markdown-only), `note-taking/obsidian`, `social-media/xurl`,
`smart-home/openhue`, etc.

---

## 3. Internal dep graph

The `skills/` and `optional-skills/` trees have **almost no intra-tree
dependencies**. Each skill is a self-contained unit. The few internal links
are:

1. **Within-skill helpers** — every skill that ships scripts has them under
   its own `scripts/` dir; nothing reaches across skills. Example:
   `skills/creative/comfyui/scripts/run_workflow.py` imports `_common.py`
   from the same dir.
2. **Sub-helpers in osint-investigation** — `_http.py` and `_normalize.py`
   are shared by the 14 fetcher scripts in the same skill. Same dir.
3. **Powerpoint nested helpers** — `scripts/office/helpers/` is shared by
   `scripts/office/pack.py` and `scripts/add_slide.py`. Same skill.
4. **`SKILL.md` cross-references via `metadata.hermes.related_skills`** —
   declarative, not an import. Loader uses these to surface "see also" hints.
   The `evm` skill declares `related_skills: [solana]`; some `creative/*`
   skills link to each other. Cosmetic only; no code dependency.

There is **no shared `lib/` or `common/` directory** across the trees.
Subdivision is therefore trivial from a dep-graph standpoint: any grouping
that doesn't split a single skill's `scripts/` folder is safe.

---

## 4. External dep graph

### 4a. Markdown-only skills

Zero Python dependencies. The skill body may instruct the model to invoke
external CLIs (`gh`, `osascript`, `himalaya`, `xurl`, `openhue`, `kubectl`,
`docker`, `terraform`, `claude`, `codex`, `opencode`, `obsidian-cli`, etc.).
The port does not need to install those CLIs — the skill body already tells
the model "if not present, install via `brew install foo`". The TS port
behaves identically: bundle the markdown, let the model invoke the CLI from
the agent's terminal toolset.

### 4b. Helper scripts (the dependency surface that matters)

Categorised by what each script imports:

**Stdlib-only (zero install)** — `urllib`, `json`, `argparse`, `pathlib`,
`subprocess`, `re`, `os`, `sys`, `dataclasses`, `datetime`, `time`,
`threading`, `concurrent.futures`. Trivial TS rewrite using `fetch` +
`Bun.argv` + `node:fs/promises`. Covers: **all 3 blockchain clients** (evm,
hyperliquid, solana — combined 3,866 LOC), most of `osint-investigation`,
`stocks_client`, `domain_intel`, `polymarket`, `arxiv`, the
`watchers/watch_*` scripts, `dcf-model/validate_dcf`, `nutrition_search`,
`body_calc`, `chembl_target`, `ro5_screen`, `pixel-art/palettes`,
`load_godmode`, `youtube_quiz`, `memento_cards`, `_watermark`, `_hermes_home`,
`_http`, `_normalize`. About **two-thirds of all helper LOC** falls in this
bucket and ports straight to TS with no third-party packages.

**Third-party Python — narrow** (1-2 packages per script, with obvious TS
equivalents):

| Skill / script | Python deps | TS replacement |
|---|---|---|
| `comfyui/scripts/*` | `httpx`, `websockets`, `pyyaml` | `fetch`, `ws`, `yaml` |
| `comfyui/scripts/hardware_check.py` | `psutil`, `GPUtil` | `systeminformation`, `node-nvidia-smi` |
| `comfyui/scripts/ws_monitor.py` | `websockets` | `ws` |
| `excalidraw/scripts/upload.py` | `httpx` | `fetch` |
| `pixel-art/scripts/pixel_art*.py` | `Pillow`, `ffmpeg-python` | `sharp`, `fluent-ffmpeg` |
| `media/youtube-content/scripts/fetch_transcript.py` | `youtube-transcript-api` | `youtube-transcript` (npm) or shell out to `yt-dlp` |
| `productivity/google-workspace/scripts/google_api.py` | `google-api-python-client`, `google-auth-oauthlib`, `google-auth-httplib2` | `googleapis` (npm) — **complex, OAuth flow** |
| `productivity/linear/scripts/linear_api.py` | `httpx` (GraphQL via raw POST) | `fetch` + GraphQL string templates, or `@linear/sdk` |
| `productivity/maps/scripts/maps_client.py` | `httpx`, several provider SDKs | `fetch` + per-provider TS SDKs |
| `productivity/ocr-and-documents/scripts/extract_marker.py` | `marker-pdf` (model-based PDF→text) | **No clean TS equivalent.** Either shell-out to Python `marker` CLI or keep this script as Python. |
| `productivity/ocr-and-documents/scripts/extract_pymupdf.py` | `PyMuPDF` (a.k.a. `fitz`) | `mupdf-js` or shell-out. |
| `productivity/powerpoint/scripts/*` | `python-pptx`, `lxml` | `pptxgenjs` (npm) — **not 1:1 API; needs careful reimpl.** |
| `red-teaming/godmode/scripts/auto_jailbreak.py` | `anthropic`, `openai` | `@anthropic-ai/sdk`, `openai` (npm) — trivial. |
| `red-teaming/godmode/scripts/godmode_race.py` | `httpx`, `asyncio` | `fetch` + `Promise.all` |
| `red-teaming/godmode/scripts/parseltongue.py` | `httpx` | `fetch` |
| `optional-skills/finance/excel-author/scripts/recalc.py` | `openpyxl` | `exceljs` (npm) |
| `optional-skills/finance/dcf-model/scripts/validate_dcf.py` | `openpyxl` | `exceljs` |
| `optional-skills/finance/stocks/scripts/stocks_client.py` | `httpx`, `yfinance` | `fetch` + `yahoo-finance2` (npm) |
| `optional-skills/health/fitness-nutrition/scripts/*` | `httpx` | `fetch` |
| `optional-skills/mcp/fastmcp/scripts/scaffold_fastmcp.py` | stdlib | stdlib (jinja-like string templating in TS) |
| `optional-skills/mcp/fastmcp/templates/*.py` | n/a (templates — not executed) | **Leave as-is.** These are scaffolding output. Decide whether to also ship TS template variants (recommended). |
| `optional-skills/migration/openclaw-migration/scripts/openclaw_to_hermes.py` | stdlib | stdlib TS |
| `optional-skills/mlops/training/trl-fine-tuning/templates/basic_grpo_training.py` | `trl`, `transformers`, `accelerate`, `torch` | **Leave as Python.** This is a template that gets dropped into a user's training repo; it is run by `python`, not by HermesTS. No TS equivalent makes sense for the GPU training stack. |
| `optional-skills/productivity/canvas/scripts/canvas_api.py` | `httpx` | `fetch` |
| `optional-skills/productivity/memento-flashcards/scripts/*` | `httpx`, `genanki`-style logic | `fetch` + custom; no clean equivalent for `genanki` — write custom SQLite-pack-to-`.apkg` if used. |
| `optional-skills/productivity/telephony/scripts/telephony.py` | `httpx` (Twilio-style HTTP) | `fetch` |
| `optional-skills/research/darwinian-evolver/scripts/*` | `httpx` | `fetch` |
| `optional-skills/research/osint-investigation/scripts/*` | **stdlib only by design** (no API keys, no third-party) | stdlib TS |
| `optional-skills/security/oss-forensics/scripts/evidence-store.py` | stdlib (sqlite3) | `bun:sqlite` |
| `optional-skills/creative/kanban-video-orchestrator/scripts/*` | stdlib + `httpx` | stdlib TS + `fetch` |
| `optional-skills/creative/meme-generation/scripts/generate_meme.py` | `Pillow` | `sharp` or `@napi-rs/canvas` |
| `optional-skills/devops/watchers/scripts/*` | stdlib + `httpx` | stdlib TS + `fetch` |
| `optional-skills/research/domain-intel/scripts/domain_intel.py` | `httpx`, `dnspython` | `fetch` + Node `dns/promises` |
| `optional-skills/research/drug-discovery/scripts/*` | `httpx` | `fetch` |

**No-port-needed templates** — `templates/*.py` files in `mcp/fastmcp/`,
`mlops/training/trl-fine-tuning/`, `research/darwinian-evolver/` are *output*
the skill emits into the user's project. They never execute inside Hermes.
Ship them verbatim as data files.

---

## 5. Tricky upstream constructs

1. **The loader is not in this tree.** The single biggest risk is mistaking
   this for a code-port task. The loader lives in `agent/skill_utils.py`,
   `agent/skill_commands.py`, etc. Sub-task agents must be told explicitly:
   "do not port `iter_skill_index_files`, `parse_frontmatter`,
   `skill_matches_platform`, `extract_skill_conditions`, etc. — those
   belong to task #5."

2. **Frontmatter is YAML, not JSON.** Every `SKILL.md` starts with a
   YAML 1.2 frontmatter block. The TS port (in `@hermests/agent`) uses
   `yaml` (eemeli) for parsing. The skills package itself never parses;
   it just exposes the directory. But sub-task agents adding new helper
   scripts must respect that any frontmatter changes ripple to the loader.

3. **Hermes-specific metadata schema.** The frontmatter has a nested
   `metadata.hermes.{tags,category,related_skills,requires_toolsets,
   fallback_for_toolsets,requires_tools,fallback_for_tools,config}` block.
   This shape is **load-bearing** for the agent's activation logic and
   curator. Sub-tasks that touch any `SKILL.md` (e.g. to fix a path
   reference because a `.py` became `.ts`) must preserve this exactly.

4. **Platform gating via `platforms: [macos, linux, windows]`.** The
   `apple/*` skills are macOS-only. The loader (in `agent/`) filters at
   discovery time. Don't strip the `platforms:` field when vendoring.

5. **`is_excluded_skill_path` and `EXCLUDED_SKILL_DIRS`.** The Python loader
   prunes `.git`, `.hub`, `.archive`, `node_modules`, `__pycache__`, `.venv`,
   etc. when walking. **Do not ship any of those inside `packages/skills/`.**
   In particular, the upstream `optional-skills/mlops/*` skills may contain
   `references/` markdown but should never include vendored model weights or
   `.venv` dirs. The vendoring script for each sub-task should run a
   gitignore-aware copy.

6. **Hub-managed skills under `~/.hermes/skills/.hub/`.** The upstream loader
   walks both bundled trees AND `~/.hermes/skills/` (user-installed hub
   skills). This is **not** our concern for the skills package — that
   path-discovery logic is in `@hermests/agent` and the hub-fetch logic is
   in `@hermests/tools` (`tools/skills_hub.py`, 3,456 LOC) and
   `@hermests/cli` (`hermes_cli/skills_hub.py`, 1,600 LOC). But sub-task
   agents may stumble on references to "hub", "tap", "lock.json",
   "quarantine", "index-cache" inside SKILL.md examples — those are
   documentation, not behaviour we need to implement here.

7. **Namespace-qualified names (`namespace:skill-name`).** Plugin-provided
   skills can override bundled ones via `namespace:` prefixes
   (`parse_qualified_name` in `agent/skill_utils.py`). Plugins live in
   `plugins/` (task #8). Skill bodies sometimes reference qualified names
   in cross-skill links; preserve the `:` syntax verbatim.

8. **`disabled` skills list in `~/.hermes/config.yaml`.** Users can disable
   bundled skills via `skills.disabled: [foo, bar]` or
   `skills.platform_disabled.<platform>: [foo]`. Again — loader logic, not
   our problem. Just don't rename skill `name:` fields when vendoring;
   user configs reference them.

9. **The `comfyui` skill's `tests/` directory.** It is the **only** skill
   in the entire `skills/` tree that ships its own tests
   (1,072 LOC across 6 files). They use `pytest` with mock WebSocket
   servers. These are *integration tests for skill helper scripts* — they
   need to be ported to Vitest alongside the helper-script port (see
   sub-task #7e below). Coverage gate (100%) applies.

10. **External CLI assumptions in markdown.** Many `SKILL.md` bodies say
    "run `gh pr create ...`" or "use `osascript -e 'tell application
    \"Notes\"'`". The TS port does **not** need to implement those CLIs —
    the model invokes them via the agent's terminal toolset. But if a
    skill assumes `python` is on PATH to run its own `scripts/foo.py`,
    and we port that script to `scripts/foo.ts`, the **`SKILL.md` body
    must be updated** to invoke `bun scripts/foo.ts` instead. Every
    sub-task that ports `.py → .ts` MUST also patch the corresponding
    `SKILL.md` invocation lines.

11. **`requirements.txt` and `pyproject.toml` files inside skills.** Some
    skills (e.g. `comfyui`) ship a `requirements.txt`. When the script is
    ported to TS, replace with `package.json` listing equivalent npm
    dependencies; also remove or repurpose `requirements.txt`. Keep
    `pyproject.toml` only for skills where we're keeping Python (e.g.
    `trl-fine-tuning` template).

12. **Skill `version:` and `license:` fields.** Preserve verbatim — they
    drive the curator UI and SBOM generation.

13. **`PORT_NOTES.md` files already present.** A few skills
    (`skills/creative/baoyu-article-illustrator/PORT_NOTES.md`) have
    upstream porting notes. Read these first before re-porting.

14. **Skills referencing absolute paths under `~/.hermes/`.** Several
    helper scripts (e.g. `productivity/google-workspace/scripts/_hermes_home.py`)
    read `HERMES_HOME` via `hermes_constants.get_hermes_home()`. In the TS
    port, these scripts must call `@hermests/core`'s `getHermesHome()`
    equivalent. **Sub-tasks that port scripts MUST take a dep on
    `@hermests/core` and not reimplement path resolution.**

---

## 6. Upstream test mapping

The `skills/` and `optional-skills/` trees contain **only one tests/
directory**:

`skills/creative/comfyui/tests/` — 6 files, 1,072 LOC:
- `conftest.py` (64) — pytest fixtures, mock WS server
- `test_check_deps.py` (68) — dep-presence checks
- `test_cloud_integration.py` (95) — cloud comfyui endpoint
- `test_common.py` (447) — `_common.py` utilities (largest, with parametrised cases)
- `test_extract_schema.py` (185) — workflow-schema extraction
- `test_run_workflow.py` (213) — end-to-end workflow run with mock WS

All other helper scripts in `skills/` and `optional-skills/` are **untested
upstream**. The TS port must therefore *write* tests from scratch to hit the
100% line/branch/function/statement coverage gate. Estimate +2-3x the script
LOC for new test code per skill.

Repo-level tests that touch the skill loader (in `tests/` at the upstream
repo root) — `tests/test_skill_*.py`, `tests/test_skills_hub_*.py`,
`tests/test_skill_utils.py`, etc. — belong to tasks **#5 (agent)**, **#6
(tools)**, and **#14 (cli)**. They are **not** in scope for this task.

---

## 7. Subdivision plan

### Design rule

- One skill **never** spans two sub-tasks. Each skill is a self-contained
  directory; we group whole skills, never split them.
- `skills/` and `optional-skills/` get separate sub-tasks. The task brief
  required this.
- Group by **porting complexity**, not alphabetical order. We want each
  sub-task to be ~1-2 days of work — content-heavy batches can hold many
  skills; helper-heavy batches hold few.
- Markdown-only skills (the majority) batch into one or two large vendoring
  sub-tasks each per tree.

### Eleven sub-tasks total

| # | Subject | Scope | Est. effort |
|---|---|---|---|
| **#7a** | Bundle markdown-only skills from `skills/` (vendoring) | All ~31 skills in `skills/` with **no `.py` scripts**: `apple/*`, `autonomous-ai-agents/*`, `creative/{architecture-diagram, ascii-art, ascii-video, baoyu-*, claude-design, creative-ideation, design-md, humanizer, manim-video, p5js, popular-web-designs, pretext, sketch, songwriting-and-ai-music, touchdesigner-mcp}`, `data-science/*`, `devops/*`, `diagramming/*`, `dogfood/*`, `domain/*`, `email/himalaya`, `gaming/*`, `gifs/*`, `github/*`, `index-cache/*`, `inference-sh/*`, `mcp/native-mcp`, `media/{gif-search, heartmula, songsee, spotify}`, `mlops/*`, `note-taking/obsidian`, `productivity/{airtable, nano-pdf, notion, teams-meeting-pipeline}`, `smart-home/openhue`, `social-media/xurl`, `software-development/*`, `yuanbao/*`. Vendor verbatim into `packages/skills/skills/`. Validate every frontmatter parses. Re-emit a `packages/skills/src/manifest.ts` listing skill names + paths. Add a smoke test: every bundled `SKILL.md` parses as valid YAML frontmatter + body. | S (4-6h) |
| **#7b** | Port `creative/comfyui` (heaviest single skill) | 10 helper scripts (3,996 LOC) + 6 upstream tests (1,072 LOC) → TS. Replace `httpx`→`fetch`, `websockets`→`ws`, `pyyaml`→`yaml`, `psutil`→`systeminformation`. Port the 6 pytest files to Vitest. Patch `SKILL.md` to invoke `bun scripts/*.ts`. Hit 100% coverage. | L (1.5-2d) |
| **#7c** | Port productivity-heavy skills: `productivity/{google-workspace, linear, maps}` | Three skills, 7 scripts, ~3,572 LOC. `google-workspace` is the largest single file (`google_api.py` 1,221 LOC) and the only one with non-trivial OAuth. `maps_client.py` 1,298 LOC. `linear_api.py` 445 LOC. Replace `httpx`→`fetch`, `google-api-python-client`→`googleapis` npm. Write tests from scratch (no upstream tests). | L (1.5-2d) |
| **#7d** | Port remaining `skills/` scripts: `creative/{excalidraw, pixel-art}`, `media/youtube-content`, `productivity/{ocr-and-documents, powerpoint}`, `research/{arxiv, polymarket}` | 7 skills, 12 scripts, ~2,266 LOC. Mix of stdlib and narrow third-party (`Pillow`, `youtube-transcript-api`, `python-pptx`, `PyMuPDF`). `extract_marker.py` and `extract_pymupdf.py` may **keep Python and shell out** (document the runtime requirement in `SKILL.md`). Write tests from scratch. | M (1d) |
| **#7e** | Port `red-teaming/godmode` (sensitive, 1,894 LOC) | 4 scripts. `auto_jailbreak.py`, `godmode_race.py`, `parseltongue.py`, `load_godmode.py`. Use `@anthropic-ai/sdk` + `openai` npm packages. **Sensitive content**: must preserve safety-rail semantics from upstream verbatim. Write tests from scratch with mocked LLM clients. | M (1d) |
| **#7f** | Bundle markdown-only skills from `optional-skills/` (vendoring) | All ~30 `optional-skills/` with no `.py`: `autonomous-ai-agents/*`, `communication/*`, `creative/{blender-mcp, concept-diagrams, hyperframes}`, `devops/{cli, docker-management, pinggy-tunnel}`, `dogfood/*`, `email/agentmail`, `finance/{3-statement-model, comps-analysis, lbo-model, merger-model, pptx-author}`, `health/neuroskill-bci`, `mcp/mcporter`, `mlops/{accelerate, chroma, clip, faiss, flash-attention, guidance, huggingface-tokenizers, inference, instructor, lambda-labs, llava, modal, nemo-curator, peft, pinecone, pytorch-fsdp, pytorch-lightning, qdrant, saelens, simpo, slime, stable-diffusion, tensorrt-llm, torchtitan, whisper}`, `productivity/{here-now, shop-app, shopify, siyuan}`, `research/{bioinformatics, parallel-cli, qmd, scrapling, searxng-search, duckduckgo-search, gitnexus-explorer}`, `security/{1password, sherlock}`, `software-development/rest-graphql-debug`, `web-development/page-agent`. Vendor verbatim into `packages/skills/optional-skills/`. Same frontmatter-parse smoke test. | M (6-8h) |
| **#7g** | Port `optional-skills/blockchain/*` (3 large stdlib clients) | `evm/scripts/evm_client.py` (1,508 LOC), `hyperliquid/scripts/hyperliquid_client.py` (1,660 LOC), `solana/scripts/solana_client.py` (698 LOC). Total 3,866 LOC. All stdlib-only (urllib, json, argparse, threading) — straight 1:1 port. Add tests from scratch with `fetch`-mocked RPC responses. | L (1.5-2d) |
| **#7h** | Port `optional-skills/research/osint-investigation` (largest single skill, 16 scripts) | 14 fetchers + 2 helpers = 16 scripts, 2,875 LOC. All stdlib-only by upstream design (zero third-party). Each fetcher hits a different public API (SEC EDGAR, OFAC SDN, OpenCorporates, ICIJ Offshore, GDELT, CourtListener, NYC ACRIS, Senate LD, USA Spending, Wayback, Wikipedia). Port `_http.py` and `_normalize.py` first; the fetchers depend on them. Tests with recorded fixtures (don't hit live APIs in CI). | L (1.5-2d) |
| **#7i** | Port `optional-skills/finance/*` + `optional-skills/health/*` scripts | `finance/{dcf-model, excel-author, stocks}` (4 scripts, 1,135 LOC) + `health/fitness-nutrition` (2 scripts, ~400 LOC). `openpyxl`→`exceljs`, `yfinance`→`yahoo-finance2`. Tests from scratch. | M (1d) |
| **#7j** | Port `optional-skills/research/{darwinian-evolver, domain-intel, drug-discovery}` + `optional-skills/security/oss-forensics` + `optional-skills/migration/openclaw-migration` | ~10 scripts, ~2,000 LOC. Stdlib + `fetch`. `evidence-store.py` uses sqlite — port to `bun:sqlite`. `darwinian-evolver/custom_problem_template.py` is a template — leave as Python and ship as data. Tests from scratch. | M (1d) |
| **#7k** | Port remaining `optional-skills/` scripts and templates: `creative/{kanban-video-orchestrator, meme-generation}`, `devops/watchers`, `mcp/fastmcp`, `productivity/{canvas, memento-flashcards, telephony}`, `mlops/training/trl-fine-tuning` (template-only) | 14 scripts + 4 templates, ~3,000 LOC. Mostly `fetch` + stdlib. `meme-generation` uses `Pillow` → `sharp`. `fastmcp` scaffolder emits template files (keep templates as data, port scaffolder logic to TS). `trl-fine-tuning/templates/basic_grpo_training.py` **stays Python** (it's GPU training code, no TS analogue) — ship verbatim with a `README.md` noting Python runtime requirement. `memento-flashcards` may need a custom `.apkg` writer if Anki integration is in scope. Tests from scratch. | M (1d) |

### Sub-task dependency notes

- **#7a and #7f are unblocked once the package skeleton exists** — they
  only copy files. Spawn first.
- **#7b through #7e (skills/ ports) and #7g through #7k (optional-skills/
  ports) can run fully in parallel** — no cross-skill imports exist.
- All eleven sub-tasks share blocker **#6 (`@hermests/tools`)** because
  some ported helper scripts will want to register themselves with the
  agent's tool registry (they currently shell out — but the TS rewrite
  may expose them as in-process tools where it's cheaper). They also
  share blocker **#5 (`@hermests/agent`)** because the loader path
  resolution lives there.

---

## 8. Effort estimates

### Per-sub-task estimate (rolled up from §7)

| Sub-task | Skills | Scripts | Python LOC | TS LOC estimate (incl. tests at 2x) | Effort |
|---|---|---|---|---|---|
| #7a | 31 | 0 | 0 | 0 (vendoring) + ~100 (manifest + smoke test) | 4-6h |
| #7b | 1 (comfyui) | 10 + 6 tests | 3,996 + 1,072 | ~8,000 | 1.5-2d |
| #7c | 3 (google-workspace, linear, maps) | 7 | 3,572 | ~10,000 | 1.5-2d |
| #7d | 7 (excalidraw, pixel-art, youtube-content, ocr, powerpoint, arxiv, polymarket) | 12 | 2,266 | ~6,800 | 1d |
| #7e | 1 (godmode) | 4 | 1,894 | ~5,500 | 1d |
| #7f | 30 | 0 | 0 | 0 + ~100 | 6-8h |
| #7g | 3 (evm, hyperliquid, solana) | 3 | 3,866 | ~11,000 | 1.5-2d |
| #7h | 1 (osint-investigation) | 16 | 2,875 | ~8,500 | 1.5-2d |
| #7i | 4 (dcf, excel-author, stocks, fitness-nutrition) | 6 | 1,535 | ~4,500 | 1d |
| #7j | 5 (darwinian-evolver, domain-intel, drug-discovery, oss-forensics, openclaw-migration) | 10 | ~2,000 | ~6,000 | 1d |
| #7k | 7 (kanban-video, meme-gen, watchers, fastmcp, canvas, memento-flashcards, telephony, trl-fine-tuning) | 14 + 4 templates | ~3,000 | ~9,000 | 1d |

### Totals

- **Sub-tasks:** 11 (within the "aim for ~10" guidance)
- **Total Python LOC ported or vendored:** 29,870 (matches §1)
- **Expected TS LOC produced:** ~70,000 (with tests at ~2x scripts; markdown is straight copy)
- **Total wall-clock if run serially:** ~13-15 dev days
- **Total wall-clock if 4 agents run in parallel** (#7a/#7f vendoring first, then 4 script ports in parallel for skills/, then 4 in parallel for optional-skills/): **~4 dev days**

### Risk-adjusted notes

- **`creative/comfyui`** (#7b) and **`productivity/google-workspace`** (in #7c)
  are the two highest-risk sub-tasks. comfyui has the only upstream tests
  (so we have a verification harness) but also the most third-party
  dependencies. google-workspace has zero upstream tests AND OAuth — write
  contract tests against the `googleapis` npm client with mocked HTTP.
- **`research/osint-investigation`** (#7h) has 16 separate fetchers and no
  upstream tests. The 16 fetchers should be ported in lockstep
  (`_http.ts` and `_normalize.ts` first, then the 14 fetchers in a single
  pass to keep the shared helper signatures stable).
- **`extract_marker.py` and `extract_pymupdf.py`** (#7d) — the only scripts
  where keeping Python is genuinely the right call. Recommend documenting
  a "Python sidecar" pattern in `PORTING_PLAN.md` so future sub-tasks know
  this is an allowed escape hatch with a precedent.
- **`mlops/training/trl-fine-tuning/templates/basic_grpo_training.py`** —
  same: stays Python (it's a template that lands in the user's GPU training
  repo and is run by `python`, never by HermesTS).
- **Markdown vendoring (#7a, #7f)** is low-risk but high-volume. The smoke
  test (`every SKILL.md parses as valid YAML frontmatter`) is critical — if
  someone introduces a frontmatter regression here, the entire
  `@hermests/agent` loader breaks at discovery time.

### Acceptance criteria for this task (#23) being "done"

1. `docs/port-briefs/skills.md` (this file) committed to `docs/brief-skills`.
2. PR titled "docs: skills port brief" opened.
3. Sub-tasks #7a through #7k created in the team task list, each blocked by
   task #6.
4. Task #23 marked completed.
5. Team lead notified with PR URL + sub-task count.
