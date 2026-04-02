# OTA Supervisor Operations

The first artifact-based OTA path is implemented as a host-side supervisor flow.

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

The repo checkout can continue to live at `/opt/discord-bot`. The runtime executes from `/opt/discord-bot/current`, while `shared/.env` stays stable across releases.

## Main Scripts

- `deploy/scripts/package-release.js`
  - packages the current repo checkout into a tarball artifact
  - embeds `.release.json` so the runtime reports a concrete release id
  - writes a manifest with checksum and size metadata

- `deploy/scripts/ota-supervisor.js`
  - verifies the manifest and artifact checksum
  - stages the artifact locally
  - extracts and installs the release into `releases/<release-id>`
  - stages the update through `/internal/ota/*`
  - waits for eligibility, triggers prepare, flips `current`, restarts, verifies, and rolls back on failure

## Manual Workflow

```bash
cd /opt/discord-bot
node deploy/scripts/package-release.js --build-id "$(git rev-parse --short=12 HEAD)" --output-dir /opt/discord-bot/staging/artifacts
node deploy/scripts/ota-supervisor.js apply --manifest /opt/discord-bot/staging/artifacts/<manifest>.json
```

## Deploy Script Workflow

`deploy/scripts/deploy.sh` now:

1. updates the repo checkout
2. runs install and syntax validation in the checkout
3. packages a release artifact
4. stages and applies it through the external supervisor flow
5. restarts into `/opt/discord-bot/current`
6. rolls back to the previous symlink target if health/version verification fails
