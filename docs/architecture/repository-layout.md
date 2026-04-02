# Repository Layout

The project now uses a module-oriented layout without rewriting the fragile voice and media core.

## Runtime Code

```text
src/
  app/
    bot-main.js
  ota/
    artifact-ota.js
    ota-routes.js
    ota-runtime.js
    update-state.js
  runtime/
    runtime-health.js
    runtime-version.js
  web/
    recordings-web.js
```

- `bot.js` remains the stable top-level entrypoint and now only loads `src/app/bot-main.js`.
- `src/app/bot-main.js` still contains the main Discord/music/recording runtime so the high-risk internals remain in one place for now.
- OTA/update-policy code is grouped under `src/ota`.
- runtime version and health shaping live under `src/runtime`.
- the recordings web renderer lives under `src/web`.

## Deployment

```text
deploy/
  ota/
    release-manifest.example.json
  scripts/
    deploy.sh
    ota-supervisor.js
    package-release.js
    proxmox-create-lxc.sh
  systemd/
    discord-bot.service
```

- `deploy/scripts` is the canonical location for deployment and supervisor scripts.
- `scripts/` still exists as a compatibility wrapper layer so existing operator habits and automation do not break immediately.

## Intentional Non-Moves

The following stayed intentionally unsplit in this phase:

- `GuildState.playNext()` and related playback flow
- `RecordingSession.subscribeUser()` and recording stream handling
- the main Discord event/command registration flow

Those areas are still tightly coupled and more failure-prone, so they remain together in `src/app/bot-main.js` until there is a cleaner, lower-risk extraction seam.
