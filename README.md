# PR Summary

A GitHub Action that automatically summarizes pull requests using Claude AI. Every time a PR is opened or updated, it posts a concise comment explaining what the PR does, the key changes, and any potential concerns.

## What it posts

For every PR, the bot adds a comment with:

- **What this PR does** — plain English summary, 2-3 sentences
- **Key changes** — the 3-6 most important specific changes (not generic)
- **Files changed** — which areas of the codebase are touched
- **Potential concerns** — edge cases, missing tests, security issues, breaking changes
- **Suggested reviewers** — what expertise should review this PR

The comment is updated (not duplicated) on every push to the PR branch.

## Setup

**1. Add your Anthropic API key to GitHub Secrets:**

Go to your repo → Settings → Secrets and variables → Actions → New repository secret

Name: `ANTHROPIC_API_KEY`
Value: your key from [console.anthropic.com](https://console.anthropic.com)

**2. Create `.github/workflows/pr-summary.yml` in your repo:**

```yaml
name: PR Summary

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  summarize:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - name: Generate PR Summary
        uses: Android-Tipster/pr-summary@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

That's it. Open a PR and the bot posts its first comment within 30 seconds.

## Cost

Each PR summary costs roughly $0.001-$0.003 using Claude Haiku (the fast, cheap model). A team merging 50 PRs/month spends under $0.15/month on API costs.

## Why not GitHub Copilot's PR summary?

Copilot's PR summary is locked behind GitHub Copilot Enterprise ($39/user/month). This action works with any GitHub repo — public or private — for the cost of a few API tokens.

## How it handles large PRs

Diffs larger than 40,000 characters are truncated before being sent to the model. The file list is always included in full, so the summary still covers what changed even when the full diff doesn't fit.

## Permissions

The action needs these permissions (already in the example workflow):

- `pull-requests: write` — to post and update the summary comment
- `contents: read` — to read the repo and diff

## Local testing

```bash
npm install
GITHUB_TOKEN=... ANTHROPIC_API_KEY=... GITHUB_REPOSITORY=owner/repo GITHUB_EVENT_PATH=./test-event.json node src/index.js
```

## License

MIT
