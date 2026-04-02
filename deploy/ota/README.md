# OTA Supervisor

This directory contains the first local-only artifact OTA path for the bot.

## Release Layout

Recommended host layout under `/opt/discord-bot`:

```text
/opt/discord-bot/
  current -> releases/<release-id>
  releases/
    <release-id>/
  shared/
    .env
  staging/
    <release-id>/
      release-manifest.json
      <artifact>.tar.gz
  deploy/
  scripts/
  bot.js
  package.json
  ...
```

The repo checkout can continue to live at `/opt/discord-bot`. The runtime now executes from `/opt/discord-bot/current`, while `shared/.env` stays stable across releases.

## Host Scripts

- `deploy/scripts/package-release.js`
  - packages the current repo checkout into a tarball artifact
  - embeds `.release.json` so the runtime can report a concrete release id
  - writes a manifest with checksum and size metadata

- `deploy/scripts/ota-supervisor.js`
  - verifies the manifest and artifact checksum
  - stages the artifact locally
  - extracts and installs the release into `releases/<release-id>`
  - stages the update through the bot's `/internal/ota/*` contract
  - waits for apply eligibility, triggers prepare, flips `current`, restarts, verifies, and rolls back on failure

## Operator Workflow

Manual apply example:

```bash
cd /opt/discord-bot
node deploy/scripts/package-release.js --build-id "$(git rev-parse --short=12 HEAD)" --output-dir /opt/discord-bot/staging/artifacts
node deploy/scripts/ota-supervisor.js apply --manifest /opt/discord-bot/staging/artifacts/<manifest>.json
```

The normal deploy path now packages the checked-out repo and invokes the supervisor automatically via `scripts/deploy.sh`.
