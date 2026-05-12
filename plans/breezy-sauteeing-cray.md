# IaC Sweep — Update Providers, Terraform, Lock Files

## Context

User updated `sc-common-iac` (latest commit `a3df7e4 chore: regen terraform lock files for linux+darwin`). Now sweeps **all sibling IaC** in the workspace to align provider/terraform constraints with `sc-common-iac` and refresh `.terraform.lock.hcl` files (multi-platform: `linux_amd64`, `darwin_amd64`, `darwin_arm64`).

Two repos lag with old AWS provider (`expedition-service`, `expedition-service-ui` dev). Four repos pin `archive ~> 2.4` (locked at `2.7.1`) and lack lock files entirely. Goal: every repo on `aws ~> 6.40` + `archive ~> 2.7` (where used), every env dir has a fresh multi-platform lock file, every change validated by `terraform plan` against real backend state.

Local toolchain: `terraform 1.14.8` on `darwin_arm64`. AWS creds present locally (S3 backend `sc-tfstate-mob3h3e9r422`).

## Target Versions (match sc-common-iac)

- `terraform required_version = ">= 1.4"`
- `aws = "~> 6.40"` (hashicorp/aws, locked 6.40.0)
- `archive = "~> 2.7"` (hashicorp/archive, locked 2.7.1) — bump from `~> 2.4`
- `random = "~> 3.6"` (where present, only `expedition-service/global` doesn't use it)
- Lock platforms: `linux_amd64 darwin_amd64 darwin_arm64`

## Survey Results

| Repo | Env(s) | aws (now) | archive (now) | Lock files |
|---|---|---|---|---|
| sc-expedition-service | dev, global | `~> 5.0` / `~> 4.62` | — | none |
| sc-expedition-service-ui | dev, prod | `~> 5.0` / `~> 6.40` | — | dev only |
| sc-feedback-service | dev | `~> 6.40` | `~> 2.4` | none |
| sc-fleet-service | dev | `~> 6.40` | — | none |
| sc-location-service | dev | `~> 6.40` | `~> 2.4` | dev |
| sc-template-service | dev | `~> 6.40` | `~> 2.4` | none |
| sc-user-service | dev | `~> 6.40` | `~> 2.4` | none |
| sc-vehicle-service | dev | `~> 6.40` | `~> 2.4` | dev |

Out of scope: `sc-common-iac` (already done), `sc-e2e-tests` (no IaC), `sc-shared-workflows` (no IaC).

## Work Units (8 — one PR per repo)

### 1. sc-expedition-service
- Files: `iac/envs/dev/provider.tf`, `iac/envs/global/provider.tf`
- Changes: bump `aws "~> 5.0"` → `"~> 6.40"` (dev) and `"~> 4.62"` → `"~> 6.40"` (global)
- Lock: generate `iac/envs/dev/.terraform.lock.hcl` and `iac/envs/global/.terraform.lock.hcl`
- **Higher risk**: AWS provider 4 → 6 jump (global env). Worker MUST inspect `terraform plan` output carefully — flag any non-trivial drift in the PR description. Common AWS 4→6 breaking changes affect S3 bucket attributes, IAM role assume-policy syntax, and provider default tags.

### 2. sc-expedition-service-ui
- Files: `iac/envs/dev/terraform.tf`
- Changes: bump `aws "~> 5.0"` → `"~> 6.40"` (dev only; prod already at 6.40)
- Lock: generate `iac/envs/dev/.terraform.lock.hcl` and `iac/envs/prod/.terraform.lock.hcl`

### 3. sc-feedback-service
- Files: `iac/envs/dev/provider.tf`
- Changes: bump `archive "~> 2.4"` → `"~> 2.7"`
- Lock: generate `iac/envs/dev/.terraform.lock.hcl`

### 4. sc-fleet-service
- Files: none (constraints already aligned)
- Lock: generate `iac/envs/dev/.terraform.lock.hcl`

### 5. sc-location-service
- Files: `iac/envs/dev/provider.tf`
- Changes: bump `archive "~> 2.4"` → `"~> 2.7"`
- Lock: regen `iac/envs/dev/.terraform.lock.hcl` (existing — refresh)

### 6. sc-template-service
- Files: `iac/envs/dev/provider.tf`
- Changes: bump `archive "~> 2.4"` → `"~> 2.7"`
- Lock: generate `iac/envs/dev/.terraform.lock.hcl`
- Note: SAM `template.yaml` is for Lambda packaging — not a Terraform provider concern. Leave alone.

### 7. sc-user-service
- Files: `iac/envs/dev/provider.tf`
- Changes: bump `archive "~> 2.4"` → `"~> 2.7"`
- Lock: generate `iac/envs/dev/.terraform.lock.hcl`

### 8. sc-vehicle-service
- Files: `iac/envs/dev/provider.tf`
- Changes: bump `archive "~> 2.4"` → `"~> 2.7"`
- Lock: regen `iac/envs/dev/.terraform.lock.hcl` (existing — refresh)

## Verification Recipe (per env directory)

Each worker, in each env dir under `iac/envs/<env>/`:

```bash
cd iac/envs/<env>
terraform init -upgrade -backend=true
terraform providers lock \
  -platform=linux_amd64 \
  -platform=darwin_amd64 \
  -platform=darwin_arm64
terraform validate
terraform plan -lock=false -detailed-exitcode
```

Expected `terraform plan` exit codes:
- `0` = no changes (ideal — provider bump is non-breaking)
- `2` = changes detected — **inspect output**, summarize in PR body, do NOT apply
- non-zero non-2 = error — fix or report

Workers MUST NOT run `terraform apply` — read-only verification only. Plan output proves the new provider version still understands existing state.

## Worker Instructions Template

Each background agent (in isolated worktree) gets:

```
You are upgrading Terraform IaC in the <REPO> repo as part of a workspace-wide sweep.

# Context
Sibling repo sc-common-iac was updated to terraform >= 1.4, aws ~> 6.40, archive ~> 2.7
(locked 2.7.1), with multi-platform locks (linux_amd64, darwin_amd64, darwin_arm64).
This unit aligns <REPO> to the same versions.

# Your task
<UNIT-SPECIFIC FILES + CHANGES from plan>

# Conventions
- Use Terraform 1.14.8 locally (the user's installed version).
- Provider blocks live in iac/envs/<env>/provider.tf (or terraform.tf for the UI repo).
- Multi-platform lock files are generated via `terraform providers lock -platform=...`.
- AWS S3 backend is sc-tfstate-mob3h3e9r422 — user's local AWS creds work.
- Do NOT run `terraform apply`. Plan is verification.

# Verification
For each env dir under iac/envs/:
  cd iac/envs/<env>
  terraform init -upgrade -backend=true
  terraform providers lock -platform=linux_amd64 -platform=darwin_amd64 -platform=darwin_arm64
  terraform validate
  terraform plan -lock=false -detailed-exitcode

Plan exit 0 = clean (ideal). Exit 2 = changes — capture full plan output and include
a summary in the PR body. Anything else = error, fix or report failure.

# After implementing
1. Simplify — invoke `Skill` with `skill: "simplify"` to review changes.
2. Run unit tests — there are no Terraform unit tests; skip this step.
3. Test end-to-end — follow the verification recipe above.
4. Commit + push + PR — title: "chore(iac): bump terraform providers + regen locks".
   Body: list constraint changes, plan exit code per env, summary of any drift.
   Use `gh pr create`.
5. Report — end with `PR: <url>`.
```

## Risks

- **expedition-service global** (aws 4.62 → 6.40) is the only one crossing major versions. Plan may show drift on IAM/S3 resources. Worker flags but does not fix in same PR — drift fixes ship separately.
- AWS creds requirement: agents inherit user shell env; if `aws sts get-caller-identity` fails in the worktree, init fails. Worker reports rather than guessing.
- Lock file generation downloads providers from registry — slow first time per worktree.

## Tracking

After spawn, render status table per `/batch` Phase 3.
