# Discord Music And Recording Bot

Standalone public repo for the Node.js Discord music and recording bot.

This bot can:

- join and leave voice channels
- play YouTube, SoundCloud, and Spotify inputs
- queue playlists and single tracks
- add tracks next in queue with `/playnext`
- shuffle, skip, pause, resume, stop, and inspect queue/state
- show a single playback panel with live buttons
- record incoming user voice to per-user WAV files
- serve recording downloads for up to 30 days, including a ZIP archive
- leave voice automatically when idle for 5 minutes or when left alone

## Setup

1. Install Node.js `24.x` LTS.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and fill in your values.
4. Install `ffmpeg` and a current `yt-dlp` release on the host or in the container. YouTube playback depends on both.
5. Start the bot:

   ```bash
   npm start
   ```

   Windows:

   ```powershell
   npm start
   ```

## Environment Variables

- `DISCORD_TOKEN` - required Discord bot token
- `DISCORD_CLIENT_ID` - optional Discord OAuth client ID for website sign-in
- `DISCORD_CLIENT_SECRET` - optional Discord OAuth client secret for website sign-in
- `DISCORD_REDIRECT_URI` - optional Discord OAuth callback URL, for example `https://recording.olavehome.uk/auth/discord/callback`
- `WEB_SESSION_SECRET` - optional signing secret for website login cookies
- `DOWNLOAD_HOST` - bind host for the recording server, default `0.0.0.0`
- `DOWNLOAD_PORT` - preferred recording server port, default `8765`
- `DOWNLOAD_BASE_URL` - public base URL for recording links, default `http://127.0.0.1:8765`
- `DOWNLOAD_PORT_SEARCH_ATTEMPTS` - number of ports to try starting from `DOWNLOAD_PORT`, default `20`
- `RECORDINGS_DIR` - recording output directory, default temp path
- `RECORDINGS_TTL_DAYS` - recording retention window in days, default `30`, capped at `31`
- `CLEANUP_INTERVAL_SECONDS` - expired-recording cleanup interval, default `3600`
- `AFK_DISCONNECT_SECONDS` - idle timeout before leaving voice, default `300`
- `SPOTIFY_CLIENT_ID` - recommended for Spotify track, playlist, and album expansion
- `SPOTIFY_CLIENT_SECRET` - recommended for Spotify track, playlist, and album expansion
- `PLAYLIST_MAX_TRACKS` - max tracks imported from one playlist or album, default `200`

## Commands

- `/ping`
- `/join`
- `/leave`
- `/play query`
- `/playnext query`
- `/skip`
- `/pause`
- `/resume`
- `/stop`
- `/queue`
- `/shuffle`
- `/recordstart`
- `/recordstop`
- `/recordlink`
- `/status`

## Player Panel

When you run `/play`, the bot creates or refreshes one player panel in that text channel with:

- now playing, playback state, recording state, previous track, and optional queue preview
- `Pause` or `Resume`
- `Previous`
- `Skip`
- `Stop`
- `Show Queue` or `Hide Queue`

The panel is re-posted on refresh so it stays near the bottom of the channel, which is the closest Discord allows to a sticky bottom panel.

`/queue` still opens a paged queue view for the full queue.

## Recording

- recording captures incoming user voice only
- each speaker is written to a separate WAV file
- `/recordstop` returns individual file links and a ZIP archive when audio was captured
- completed recordings expire after 30 days by default
- set `DOWNLOAD_BASE_URL=https://recording.olavehome.uk` when you put the bot behind your reverse proxy
- if Discord OAuth is configured, the recordings website can show a `My Sessions` view filtered to sessions that include the signed-in Discord user

## Notes

- Spotify audio is not streamed directly. Spotify links are expanded into metadata and then resolved to a playable source.
- Spotify playlist links fall back to Spotify web metadata when API calls fail.
- SoundCloud playback is enabled through `play-dl` and depends on its free client ID lookup succeeding at startup.
- Commands are synced per guild on startup so they appear quickly in servers the bot is already in.
- Discord voice receive is still not officially documented by Discord, but the Node voice stack here is the chosen path over the previous Python receive extension.
- The website login uses Discord OAuth `identify` scope only. Session matching works by the Discord user IDs already embedded in per-user WAV filenames.

## Proxmox / LXC

Recommended container setup:

1. Use a Debian or Ubuntu LXC with `nodejs`, `npm`, and `ffmpeg` installed.
2. Store the bot in a persistent path such as `/opt/discord-bot`.
3. Keep `RECORDINGS_DIR` on persistent storage if you want recordings to survive container restarts.
4. Open the download port you use in `DOWNLOAD_PORT`, or reverse-proxy it instead.
5. Set `DISCORD_TOKEN` and Spotify credentials in environment variables or `.env`, not in code.
6. If you want browser-accessible links from outside the LXC, set `DOWNLOAD_BASE_URL` to the public hostname and port.

## Production Deployment

Recommended production shape:

- Debian 12 LXC
- `2` vCPU
- `1024 MB` RAM minimum, `2048 MB` preferred if you want to use VS Code Remote SSH comfortably
- `120 GB` disk
- persistent recordings in `/var/lib/discord-bot/recordings`
- reverse proxy `recording.olavehome.uk -> http://container-ip:8765`

Storage sizing for recordings:

- the bot currently writes `48 kHz`, `16-bit`, stereo WAV per speaker
- that is about `659 MiB/hour/user`
- a `6` hour session is about `3.9 GiB` per actively speaking user
- `120 GB` is enough for long sessions, but your `7` day retention window means frequent large recordings will accumulate quickly

### Automated Proxmox Create

Run this on the Proxmox host as `root`:

```bash
cd /root
git clone https://github.com/OlaveOyol/discord-bot-public.git
cd discord-bot-public
chmod +x scripts/proxmox-create-lxc.sh
START_CTID=192 \
START_IP=192.168.68.15 \
SSH_PUBLIC_KEY_FILE=/root/.ssh/id_ed25519.pub \
REPO_URL=https://github.com/OlaveOyol/discord-bot-public.git \
./scripts/proxmox-create-lxc.sh
```

What it does:

- finds the next free container ID starting at `192`
- finds the next free static IP starting at `192.168.68.15`
- creates an unprivileged Debian 12 LXC
- installs `git`, `ffmpeg`, `openssh-server`, `sudo`, and `Node.js 24`
- enables `onboot`
- creates a login user called `deploy` with passwordless `sudo`

Useful overrides:

- `PVE_TEMPLATE_STORAGE=local`
- `PVE_ROOTFS_STORAGE=local-lvm`
- `ROOTFS_SIZE_GB=120`
- `CORES=2`
- `MEMORY_MB=1024`
- `SWAP_MB=512`
- `BRIDGE=vmbr0`
- `GATEWAY=192.168.68.1`
- `REPO_URL=https://github.com/OlaveOyol/discord-bot-public.git`

### First Bootstrap

Once the container exists:

```bash
ssh deploy@<container-ip>
sudo mkdir -p /opt/discord-bot
```

Clone the repo into `/opt/discord-bot`, copy `.env`, then run:

```bash
cd /opt/discord-bot
chmod +x scripts/deploy.sh
sudo APP_DIR=/opt/discord-bot SERVICE_NAME=discord-bot BRANCH=main ./scripts/deploy.sh
```

The deploy script:

- updates the checkout to the target branch
- runs `npm ci --omit=dev`
- runs `npm run check`
- installs or refreshes the `systemd` unit
- restarts the bot service

### GitHub Actions Deploy

The repo includes [deploy.yml](./.github/workflows/deploy.yml). Pushes to `main` and manual workflow runs will SSH into the container and run `scripts/deploy.sh`.

Required GitHub repository secrets:

- `DEPLOY_HOST`
- `DEPLOY_PORT`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`
- `DEPLOY_KNOWN_HOSTS`

Optional GitHub repository variables:

- `DEPLOY_APP_DIR`
- `DEPLOY_SERVICE_NAME`

Recommended values:

- `DEPLOY_HOST=<container-ip-or-dns>`
- `DEPLOY_PORT=22`
- `DEPLOY_USER=deploy`
- `DEPLOY_APP_DIR=/opt/discord-bot`
- `DEPLOY_SERVICE_NAME=discord-bot`

To build `DEPLOY_KNOWN_HOSTS` locally:

```bash
ssh-keyscan -H <container-ip-or-dns>
```

`DEPLOY_SSH_KEY` should be the private key for the user you use to SSH into the container. Keep `.env` on the server and do not store it in GitHub.

### VS Code Remote SSH

If you want direct editing from your IDE as well, point VS Code Remote SSH at the container and open `/opt/discord-bot`. That works well for emergency hotfixes, but the cleaner day-to-day flow is:

1. edit locally
2. push to `main`
3. let GitHub Actions deploy

### Service Management

The systemd unit lives at [discord-bot.service](./deploy/systemd/discord-bot.service).

Common commands on the container:

```bash
sudo systemctl status discord-bot
sudo systemctl restart discord-bot
sudo journalctl -u discord-bot -n 200 --no-pager
sudo journalctl -u discord-bot -f
```
