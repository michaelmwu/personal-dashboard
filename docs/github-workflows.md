# GitHub Workflows

This repo follows the 508 devkit convention of keeping GitHub automation small, explicit, and least-privilege.

## Included Defaults

- `.github/PULL_REQUEST_TEMPLATE.md` asks for summary, validation, risk, and screenshots.
- `.github/ISSUE_TEMPLATE/bug_report.yml` captures reproducible defects.
- `.github/ISSUE_TEMPLATE/feature_request.yml` captures product or workflow requests.
- `.github/ISSUE_TEMPLATE/docs_request.yml` captures documentation gaps.
- `.github/workflows/ci.yml` runs the Bun install, format, lint, typecheck, and test checks.

## Workflow Policy

- Use frozen installs.
- Prefer pinned third-party action SHAs for nontrivial workflows.
- Keep permissions narrow.
- Keep deployment workflows separate from validation workflows.
