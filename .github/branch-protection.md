# Branch Protection — `main`

Branch protection settings cannot be enforced from this repo (they live in GitHub repo settings). This document is the canonical spec for what `main` MUST be configured to require. Apply via the GitHub UI (Settings → Branches → Branch protection rules → Add rule) or via `gh api` (snippet below).

## Required settings for `main`

| Setting | Value |
| --- | --- |
| Branch name pattern | `main` |
| Require a pull request before merging | **Enabled** |
| Required approving reviews | **1** |
| Dismiss stale approvals on new commits | **Enabled** |
| Require review from Code Owners | **Enabled** |
| Require status checks to pass before merging | **Enabled** |
| Require branches to be up to date before merging | **Enabled** |
| Required status checks | `verify` (job name from `.github/workflows/ci.yml`) |
| Require conversation resolution before merging | **Enabled** |
| Require signed commits | Optional — enable when contributor GPG keys are set up |
| Require linear history | **Enabled** |
| Restrict who can push | Repo admins only |
| Allow force pushes | **Disabled** |
| Allow deletions | **Disabled** |

## One-shot `gh` snippet

Requires `gh auth login` with admin scope on the repo.

```bash
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  /repos/AntSentry/HermesTS/branches/main/protection \
  -f required_status_checks[strict]=true \
  -f 'required_status_checks[contexts][]=verify' \
  -f enforce_admins=false \
  -F required_pull_request_reviews[required_approving_review_count]=1 \
  -F required_pull_request_reviews[dismiss_stale_reviews]=true \
  -F required_pull_request_reviews[require_code_owner_reviews]=true \
  -F required_conversation_resolution=true \
  -F required_linear_history=true \
  -F allow_force_pushes=false \
  -F allow_deletions=false \
  -F restrictions=null
```

## Verification after applying

```bash
gh api /repos/AntSentry/HermesTS/branches/main/protection | jq '{
  pr_reviews: .required_pull_request_reviews,
  checks: .required_status_checks,
  linear: .required_linear_history.enabled,
  force_push: .allow_force_pushes.enabled,
  deletions: .allow_deletions.enabled
}'
```

Expected output:
- `pr_reviews.required_approving_review_count == 1`
- `pr_reviews.require_code_owner_reviews == true`
- `checks.contexts` contains `"verify"`
- `linear == true`
- `force_push == false`
- `deletions == false`

## When to revisit

- Adding additional required CI jobs (lint, integration, etc.) → append job names to `contexts`.
- Onboarding more reviewers → bump `required_approving_review_count` to 2.
- Enabling commit signing → flip `require_signed_commits` once contributors have signing keys configured.
