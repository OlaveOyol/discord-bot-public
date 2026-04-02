const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { finished } = require("node:stream/promises");
const { execFile, spawn } = require("node:child_process");

const archiver = require("archiver");
const dotenv = require("dotenv");
const express = require("express");
const play = require("play-dl");
const prism = require("prism-media");
const {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  InteractionContextType,
  SlashCommandBuilder,
  escapeMarkdown,
} = require("discord.js");
const {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} = require("@discordjs/voice");

const BOT_DIR = __dirname;
dotenv.config({ path: path.join(BOT_DIR, ".env") });

function env(name, fallback = undefined) {
  const value = process.env[name];
  if (typeof value !== "string") {
    return fallback;
  }

  const cleaned = value.trim().replace(/^['"]|['"]$/g, "");
  return cleaned.length ? cleaned : fallback;
}

const TOKEN = env("DISCORD_TOKEN");
if (!TOKEN) {
  throw new Error("DISCORD_TOKEN is not set");
}

const DOWNLOAD_HOST = env("DOWNLOAD_HOST", "0.0.0.0");
const DOWNLOAD_PORT = Number.parseInt(env("DOWNLOAD_PORT", "8765"), 10);
const DOWNLOAD_BASE_URL_FROM_ENV = Boolean(process.env.DOWNLOAD_BASE_URL);
const DOWNLOAD_BASE_URL = env("DOWNLOAD_BASE_URL", `http://127.0.0.1:${DOWNLOAD_PORT}`);
const DOWNLOAD_PORT_SEARCH_ATTEMPTS = Math.max(
  1,
  Number.parseInt(env("DOWNLOAD_PORT_SEARCH_ATTEMPTS", "20"), 10),
);
const RECORDINGS_DIR = env("RECORDINGS_DIR", path.join(os.tmpdir(), "discord-bot-recordings"));
const RECORDINGS_TTL_DAYS = Math.max(1, Number.parseInt(env("RECORDINGS_TTL_DAYS", "7"), 10));
const CLEANUP_INTERVAL_SECONDS = Math.max(
  60,
  Number.parseInt(env("CLEANUP_INTERVAL_SECONDS", "3600"), 10),
);
const AFK_DISCONNECT_SECONDS = Math.max(
  30,
  Number.parseInt(env("AFK_DISCONNECT_SECONDS", "300"), 10),
);
const PLAYLIST_MAX_TRACKS = Math.max(
  1,
  Number.parseInt(env("PLAYLIST_MAX_TRACKS", "200"), 10),
);
const SPOTIFY_CLIENT_ID = env("SPOTIFY_CLIENT_ID") || env("SPOTIPY_CLIENT_ID");
const SPOTIFY_CLIENT_SECRET = env("SPOTIFY_CLIENT_SECRET") || env("SPOTIPY_CLIENT_SECRET");

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const logger = {
  info: (...args) => console.log(new Date().toISOString(), "INFO", "discord-bot -", ...args),
  warn: (...args) => console.warn(new Date().toISOString(), "WARN", "discord-bot -", ...args),
  error: (...args) => console.error(new Date().toISOString(), "ERROR", "discord-bot -", ...args),
};

const SPOTIFY_URL_RE = /^https?:\/\/open\.spotify\.com\/(track|album|playlist)\/([A-Za-z0-9]+)/i;
const SPOTIFY_TITLE_RE = /<meta property="og:title" content="([^"]+)"/i;
const SPOTIFY_DESC_RE = /<meta property="og:description" content="([^"]+)"/i;
const SPOTIFY_INITIAL_STATE_RE = /<script id="initialState" type="text\/plain">(.*?)<\/script>/is;
const SEVEN_DAYS_MS = RECORDINGS_TTL_DAYS * 24 * 60 * 60 * 1000;
const LOCAL_YTDLP_PATH = path.join(BOT_DIR, ".venv", "Scripts", "yt-dlp.exe");
const INSTANCE_LOCK_PATH = path.join(BOT_DIR, ".bot.lock");

let spotifyTokenCache = null;
let downloadBaseUrl = DOWNLOAD_BASE_URL;
let downloadServer = null;
let presenceCycleIndex = 0;
let soundCloudReady = false;

const guildStates = new Map();
const completedRecordings = new Map();
const latestRecordingByGuild = new Map();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let instanceLockFd = null;

function releaseInstanceLock() {
  if (instanceLockFd !== null) {
    try {
      fs.closeSync(instanceLockFd);
    } catch {}
    instanceLockFd = null;
  }

  try {
    fs.unlinkSync(INSTANCE_LOCK_PATH);
  } catch {}
}

function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireInstanceLock() {
  const payload = JSON.stringify(
    {
      pid: process.pid,
      startedAt: new Date().toISOString(),
    },
    null,
    2,
  );

  try {
    instanceLockFd = fs.openSync(INSTANCE_LOCK_PATH, "wx");
    fs.writeFileSync(instanceLockFd, payload);
    return;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }

  let existingPid = null;
  try {
    const existing = JSON.parse(fs.readFileSync(INSTANCE_LOCK_PATH, "utf8"));
    existingPid = Number.parseInt(String(existing.pid || ""), 10);
  } catch {}

  if (isPidRunning(existingPid)) {
    throw new Error(
      `Another discord-bot process is already running with PID ${existingPid}. Stop it before starting a second instance.`,
    );
  }

  try {
    fs.unlinkSync(INSTANCE_LOCK_PATH);
  } catch {}

  instanceLockFd = fs.openSync(INSTANCE_LOCK_PATH, "wx");
  fs.writeFileSync(instanceLockFd, payload);
}

acquireInstanceLock();
["exit", "SIGINT", "SIGTERM", "SIGBREAK"].forEach((signal) => {
  process.on(signal, () => {
    releaseInstanceLock();
    if (signal !== "exit") {
      process.exit(0);
    }
  });
});

function getGuildState(guildId) {
  let state = guildStates.get(guildId);
  if (!state) {
    state = new GuildState(guildId);
    guildStates.set(guildId, state);
  }
  return state;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) {
    return "--:--";
  }

  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function sanitizeFilename(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9._-]+/g, "_");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function truncate(value, limit) {
  if (!value || value.length <= limit) {
    return value;
  }

  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function isYouTubeUrl(value) {
  if (!isHttpUrl(value)) {
    return false;
  }

  const hostname = new URL(value).hostname.toLowerCase();
  return ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(hostname);
}

function normalizePlaybackQuery(query) {
  if (!isHttpUrl(query)) {
    return query;
  }

  const parsed = new URL(query);
  const host = parsed.hostname.toLowerCase();
  const isYoutubeHost = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host);
  const isShortYoutubeHost = host === "youtu.be";
  const isExplicitPlaylist = isYoutubeHost && parsed.pathname === "/playlist";
  const isWatchLike = (isYoutubeHost && parsed.pathname === "/watch") || isShortYoutubeHost;

  if (isWatchLike && !isExplicitPlaylist) {
    ["list", "index", "start_radio", "pp"].forEach((name) => parsed.searchParams.delete(name));
    if (isShortYoutubeHost) {
      const videoId = parsed.pathname.replace(/^\/+/, "").split("/")[0];
      const watchUrl = new URL("https://www.youtube.com/watch");
      watchUrl.searchParams.set("v", videoId);
      return watchUrl.toString();
    }
    parsed.hostname = "www.youtube.com";
    return parsed.toString();
  }

  return query;
}

function spotifySearchQuery(name, artists) {
  return `${name} ${artists.join(" ")} audio`.trim();
}

function createTrack({
  title,
  webpageUrl,
  duration,
  thumbnail,
  requestedBy,
  streamUrl = null,
  searchQuery = null,
}) {
  return {
    title: title || "Unknown title",
    webpageUrl,
    duration: Number.isFinite(duration) ? duration : null,
    thumbnail: thumbnail || null,
    requestedBy: requestedBy || "unknown",
    streamUrl: streamUrl || null,
    searchQuery: searchQuery || null,
  };
}

class WaveFileWriter {
  constructor(filePath) {
    this.filePath = filePath;
    this.stream = fs.createWriteStream(filePath, { flags: "w" });
    this.dataBytes = 0;
    this.closed = false;
    this.stream.write(Buffer.alloc(44));
  }

  write(buffer) {
    if (this.closed || !buffer?.length) {
      return;
    }

    this.dataBytes += buffer.length;
    this.stream.write(buffer);
  }

  async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.stream.end();
    await finished(this.stream);

    const handle = await fsp.open(this.filePath, "r+");
    try {
      await handle.write(buildWavHeader(this.dataBytes), 0, 44, 0);
    } finally {
      await handle.close();
    }
  }
}

function buildWavHeader(dataBytes) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(48000 * 2 * 2, 28);
  header.writeUInt16LE(2 * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

class RecordingSession {
  constructor(guildId, channelId) {
    this.guildId = guildId;
    this.channelId = channelId;
    this.startedAt = new Date();
    this.completedAt = null;
    this.token = crypto.randomBytes(16).toString("base64url");
    this.directory = path.join(RECORDINGS_DIR, `${guildId}-${Date.now()}-${this.token}`);
    this.archivePath = null;
    this.receiver = null;
    this.connection = null;
    this.speakingListener = null;
    this.userStreams = new Map();
    this.fileWriters = new Map();
    fs.mkdirSync(this.directory, { recursive: true });
  }

  indexUrl() {
    return `${downloadBaseUrl}/recordings/${this.token}/`;
  }

  zipUrl() {
    return `${downloadBaseUrl}/recordings/${this.token}/session.zip`;
  }

  expiresAt() {
    const reference = this.completedAt || this.startedAt;
    return new Date(reference.getTime() + SEVEN_DAYS_MS);
  }

  isExpired(now = Date.now()) {
    return now >= this.expiresAt().getTime();
  }

  attach(connection, guild) {
    this.connection = connection;
    this.receiver = connection.receiver;
    this.speakingListener = (userId) => {
      void this.subscribeUser(guild, userId);
    };
    this.receiver.speaking.on("start", this.speakingListener);
  }

  getWriter(guild, userId) {
    let writer = this.fileWriters.get(userId);
    if (writer) {
      return writer;
    }

    const member = guild.members.cache.get(userId);
    const user = member?.user || client.users.cache.get(userId);
    const displayName = member?.displayName || user?.username || userId;
    const fileName = `${sanitizeFilename(displayName)}_${userId}.wav`;
    writer = new WaveFileWriter(path.join(this.directory, fileName));
    this.fileWriters.set(userId, writer);
    return writer;
  }

  async subscribeUser(guild, userId) {
    if (!this.receiver || this.userStreams.has(userId)) {
      return;
    }

    const opusStream = this.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 250,
      },
    });
    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });
    const writer = this.getWriter(guild, userId);

    const destroyEntry = () => {
      const entry = this.userStreams.get(userId);
      if (!entry) {
        return;
      }

      entry.opusStream.removeAllListeners();
      entry.decoder.removeAllListeners();
      entry.opusStream.destroy();
      entry.decoder.destroy();
      this.userStreams.delete(userId);
    };

    opusStream.on("error", (error) => {
      logger.warn(`Recording stream error for user ${userId} in guild ${guild.id}: ${error.message}`);
      destroyEntry();
    });
    decoder.on("error", (error) => {
      logger.warn(`Recording decoder error for user ${userId} in guild ${guild.id}: ${error.message}`);
      destroyEntry();
    });
    decoder.on("data", (chunk) => writer.write(chunk));
    opusStream.once("end", () => destroyEntry());
    opusStream.once("close", () => destroyEntry());
    opusStream.pipe(decoder);
    this.userStreams.set(userId, { opusStream, decoder });
  }

  async stop() {
    if (this.receiver && this.speakingListener) {
      this.receiver.speaking.off("start", this.speakingListener);
    }

    for (const { opusStream, decoder } of this.userStreams.values()) {
      opusStream.unpipe(decoder);
      opusStream.destroy();
      decoder.destroy();
    }
    this.userStreams.clear();

    for (const writer of this.fileWriters.values()) {
      await writer.close();
    }

    this.completedAt = new Date();
    const wavFiles = await this.wavFiles();
    if (wavFiles.length > 0) {
      this.archivePath = path.join(this.directory, "session.zip");
      await createZipArchive(this.directory, this.archivePath, wavFiles);
    }
  }

  async wavFiles() {
    const entries = await fsp.readdir(this.directory, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".wav"))
      .map((entry) => entry.name)
      .sort();
  }
}

async function createZipArchive(directory, destination, wavFiles) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destination);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);

    for (const fileName of wavFiles) {
      archive.file(path.join(directory, fileName), { name: fileName });
    }

    archive.finalize().catch(reject);
  });
}

class GuildState {
  constructor(guildId) {
    this.guildId = guildId;
    this.queue = [];
    this.history = [];
    this.current = null;
    this.controllerChannelId = null;
    this.playerMessageId = null;
    this.panelRefreshPromise = null;
    this.panelQueueVisible = false;
    this.recording = null;
    this.idleTimer = null;
    this.idleReason = null;
    this.disconnecting = false;
    this.playingNext = false;
    this.connection = null;
    this.deferPanelRefresh = false;
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    this.player.on("error", (error) => {
      logger.error(`Playback error in guild ${this.guildId}: ${error.message}`);
    });

    this.player.on(AudioPlayerStatus.Idle, (oldState) => {
      if (oldState.status !== AudioPlayerStatus.Idle) {
        void this.onTrackFinished();
      }
    });

    this.player.on("stateChange", () => {
      void this.refreshState();
    });
  }

  get guild() {
    return client.guilds.cache.get(this.guildId) || null;
  }

  playbackStatus() {
    return this.player.state.status;
  }

  isPlaying() {
    return this.playbackStatus() === AudioPlayerStatus.Playing;
  }

  isPaused() {
    return (
      this.playbackStatus() === AudioPlayerStatus.Paused ||
      this.playbackStatus() === AudioPlayerStatus.AutoPaused
    );
  }

  hasActivity() {
    return Boolean(this.current || this.queue.length > 0 || this.isPlaying() || this.isPaused());
  }

  async refreshState() {
    if (!this.deferPanelRefresh) {
      await refreshPlayerPanel(this.guildId);
    }
    refreshPresence();
    void refreshVoiceLifecycle(this.guildId);
  }

  async ensureConnection(member, { requireReceive = false } = {}) {
    const voiceChannel = member?.voice?.channel;
    if (!voiceChannel) {
      throw new Error("You must join a voice channel first.");
    }

    let connection = this.connection || getVoiceConnection(this.guildId);
    const desiredSelfDeaf = !requireReceive;

    if (!connection) {
      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: desiredSelfDeaf,
        selfMute: false,
      });
      attachConnectionHandlers(this, connection);
    } else if (
      connection.joinConfig.channelId !== voiceChannel.id ||
      connection.joinConfig.selfDeaf !== desiredSelfDeaf
    ) {
      connection.rejoin({
        channelId: voiceChannel.id,
        selfDeaf: desiredSelfDeaf,
        selfMute: false,
      });
    }

    this.connection = connection;
    connection.subscribe(this.player);
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    return connection;
  }

  async updateReceiveMode(requireReceive) {
    const connection = this.connection || getVoiceConnection(this.guildId);
    if (!connection || !connection.joinConfig.channelId) {
      return;
    }

    if (connection.joinConfig.selfDeaf === !requireReceive) {
      return;
    }

    connection.rejoin({
      channelId: connection.joinConfig.channelId,
      selfDeaf: !requireReceive,
      selfMute: false,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000).catch(() => {});
  }

  async enqueue(tracks) {
    if (!tracks.length) {
      return 0;
    }

    this.queue.push(...tracks);
    if (!this.current && this.playbackStatus() === AudioPlayerStatus.Idle) {
      await this.playNext();
    }
    await this.refreshState();
    return this.queue.length;
  }

  async enqueueNext(tracks) {
    if (!tracks.length) {
      return 0;
    }

    this.queue.unshift(...tracks.reverse());
    if (!this.current && this.playbackStatus() === AudioPlayerStatus.Idle) {
      await this.playNext();
    }
    await this.refreshState();
    return this.queue.length;
  }

  async playNext() {
    if (this.playingNext) {
      return;
    }

    this.playingNext = true;
    try {
      while (true) {
        const connection = this.connection || getVoiceConnection(this.guildId);
        if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
          this.current = null;
          break;
        }

        if (this.current || this.isPlaying() || this.isPaused()) {
          break;
        }

        const nextTrack = this.queue.shift();
        if (!nextTrack) {
          this.current = null;
          break;
        }

        this.current = nextTrack;
        try {
          const { resource, stream } = await createPlaybackResource(nextTrack);
          this.player.play(resource);
          if (stream && typeof play.attachListeners === "function") {
            play.attachListeners(this.player, stream);
          }
          break;
        } catch (error) {
          logger.warn(`Failed to play track in guild ${this.guildId}: ${error.message}`);
          this.current = null;
        }
      }
    } finally {
      this.playingNext = false;
      await this.refreshState();
    }
  }

  async onTrackFinished() {
    if (this.current) {
      this.history.unshift(this.current);
      this.history = this.history.slice(0, 20);
    }
    this.current = null;
    await this.playNext();
  }

  async pause() {
    const paused = this.player.pause(true);
    if (paused) {
      await this.refreshState();
    }
    return paused;
  }

  async resume() {
    const resumed = this.player.unpause();
    if (resumed) {
      await this.refreshState();
    }
    return resumed;
  }

  async skip() {
    if (!this.current && this.playbackStatus() === AudioPlayerStatus.Idle) {
      return false;
    }

    this.player.stop(true);
    await this.refreshState();
    return true;
  }

  async previous() {
    const previousTrack = this.history.shift();
    if (!previousTrack) {
      return false;
    }

    if (this.current) {
      this.queue.unshift(this.current);
    }
    this.queue.unshift(previousTrack);

    if (this.playbackStatus() === AudioPlayerStatus.Idle) {
      this.current = null;
      await this.playNext();
    } else {
      this.player.stop(true);
    }

    await this.refreshState();
    return true;
  }

  async stopPlayback() {
    this.queue = [];
    this.current = null;
    this.panelQueueVisible = false;
    this.player.stop(true);
    await this.refreshState();
  }

  async shuffleQueue() {
    if (this.queue.length < 2) {
      return false;
    }

    for (let index = this.queue.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [this.queue[index], this.queue[swapIndex]] = [this.queue[swapIndex], this.queue[index]];
    }
    await this.refreshState();
    return true;
  }
}

function attachConnectionHandlers(state, connection) {
  if (connection.__discordBotHandlersAttached) {
    return;
  }

  connection.__discordBotHandlersAttached = true;
  connection.on("error", (error) => {
    logger.warn(`Voice connection error in guild ${state.guildId}: ${error.message}`);
  });

  connection.on("stateChange", async (_, newState) => {
    if (newState.status === VoiceConnectionStatus.Destroyed) {
      state.connection = null;
      await state.refreshState();
      return;
    }

    if (newState.status === VoiceConnectionStatus.Disconnected) {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        await disconnectGuild(state.guildId, "Voice connection lost");
      }
    }
  });
}

async function configurePlayDl() {
  try {
    const clientId = await play.getFreeClientID();
    await play.setToken({ soundcloud: { client_id: clientId } });
    soundCloudReady = true;
    logger.info("SoundCloud support enabled.");
  } catch (error) {
    soundCloudReady = false;
    logger.warn(`SoundCloud support is limited: ${error.message}`);
  }
}

async function spotifyAccessToken() {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    return null;
  }

  if (spotifyTokenCache && spotifyTokenCache.expiresAt > Date.now() + 30_000) {
    return spotifyTokenCache.token;
  }

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });

  if (!response.ok) {
    throw new Error(`Spotify token request failed with status ${response.status}`);
  }

  const payload = await response.json();
  spotifyTokenCache = {
    token: payload.access_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
  };
  return spotifyTokenCache.token;
}

async function spotifyApiGet(pathname) {
  const token = await spotifyAccessToken();
  if (!token) {
    throw new Error("Spotify credentials are not configured.");
  }

  const response = await fetch(`https://api.spotify.com/v1/${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Spotify API request failed with status ${response.status}`);
  }

  return response.json();
}

async function spotifyPublicToken() {
  const response = await fetch(
    "https://open.spotify.com/get_access_token?reason=transport&productType=web_player",
    {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json",
      },
    },
  );
  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  return payload.accessToken || null;
}

function queueTrackFromSpotifyApi(track, requestedBy) {
  const trackName = track?.name;
  if (!trackName) {
    return null;
  }

  const artists = Array.isArray(track.artists)
    ? track.artists.map((artist) => artist?.name).filter(Boolean)
    : [];
  return createTrack({
    title: `${trackName} - ${artists.join(", ") || "Unknown artist"}`,
    webpageUrl: spotifySearchQuery(trackName, artists),
    searchQuery: spotifySearchQuery(trackName, artists),
    duration: track.duration_ms ? Math.floor(track.duration_ms / 1000) : null,
    thumbnail: track.album?.images?.[0]?.url || null,
    requestedBy,
  });
}

function decodeSpotifyHtmlState(page) {
  const match = page.match(SPOTIFY_INITIAL_STATE_RE);
  if (!match) {
    return null;
  }

  const rawState = match[1]
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&#x2F;", "/")
    .trim();
  const padded = rawState + "=".repeat((4 - (rawState.length % 4)) % 4);
  const decoded = Buffer.from(padded, "base64").toString("utf8");
  return JSON.parse(decoded);
}

function spotifyPlaylistItemsFromHtmlState(state, spotifyId) {
  const itemsByUri = state?.entities?.items || {};
  const playlistUri = `spotify:playlist:${spotifyId}`;
  let playlist = itemsByUri[playlistUri];
  if (!playlist) {
    playlist = Object.entries(itemsByUri).find(([key]) => key.startsWith(playlistUri))?.[1];
  }
  if (!playlist) {
    return [];
  }

  const contentItems = playlist?.content?.items || [];
  const tracks = [];
  for (const row of contentItems) {
    const track = row?.itemV2?.data || row?.item || row?.track;
    if (!track || typeof track !== "object") {
      continue;
    }

    const uri = String(track.uri || "");
    if (track.__typename !== "Track" && !uri.startsWith("spotify:track:")) {
      continue;
    }

    tracks.push(track);
  }
  return tracks;
}

function queueTrackFromSpotifyHtml(track, requestedBy) {
  const trackName = track?.name;
  if (!trackName) {
    return null;
  }

  const artistItems = track?.artists?.items || track?.artists || [];
  const artists = artistItems
    .map((artist) => artist?.profile?.name || artist?.name)
    .filter(Boolean);
  const durationMs = track?.duration?.totalMilliseconds || track?.duration_ms || null;
  const coverSources = track?.albumOfTrack?.coverArt?.sources || track?.album?.images || [];
  return createTrack({
    title: `${trackName} - ${artists.join(", ") || "Unknown artist"}`,
    webpageUrl: spotifySearchQuery(trackName, artists),
    searchQuery: spotifySearchQuery(trackName, artists),
    duration: durationMs ? Math.floor(durationMs / 1000) : null,
    thumbnail: coverSources?.[0]?.url || null,
    requestedBy,
  });
}

async function spotifyFallbackPlaylistTracks(spotifyId, requestedBy) {
  const token = await spotifyPublicToken();
  if (token) {
    const items = [];
    let offset = 0;
    while (items.length < PLAYLIST_MAX_TRACKS) {
      const limit = Math.min(100, PLAYLIST_MAX_TRACKS - items.length);
      const url = new URL(`https://api.spotify.com/v1/playlists/${spotifyId}/tracks`);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("additional_types", "track");

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0",
        },
      });
      if (!response.ok) {
        break;
      }

      const payload = await response.json();
      const rows = payload.items || [];
      for (const row of rows) {
        const item = queueTrackFromSpotifyApi(row.track, requestedBy);
        if (item) {
          items.push(item);
        }
        if (items.length >= PLAYLIST_MAX_TRACKS) {
          break;
        }
      }

      if (!payload.next || rows.length === 0) {
        break;
      }
      offset += rows.length;
    }
    if (items.length > 0) {
      return items;
    }
  }

  const response = await fetch(`https://open.spotify.com/playlist/${spotifyId}`, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!response.ok) {
    throw new Error(`Spotify playlist fallback failed with status ${response.status}`);
  }

  const page = await response.text();
  const state = decodeSpotifyHtmlState(page);
  if (!state) {
    throw new Error("Spotify playlist HTML fallback did not include initial state.");
  }

  const tracks = spotifyPlaylistItemsFromHtmlState(state, spotifyId);
  const items = [];
  for (const track of tracks) {
    const item = queueTrackFromSpotifyHtml(track, requestedBy);
    if (item) {
      items.push(item);
    }
    if (items.length >= PLAYLIST_MAX_TRACKS) {
      break;
    }
  }
  return items;
}

async function resolveSpotifyQuery(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!response.ok) {
    throw new Error(`Spotify metadata request failed with status ${response.status}`);
  }

  const text = await response.text();
  const title = text.match(SPOTIFY_TITLE_RE)?.[1] || "";
  const description = text.match(SPOTIFY_DESC_RE)?.[1] || "";
  const titleText = title.replaceAll("&amp;", "&");
  const descriptionText = description.replaceAll("&amp;", "&");

  if (titleText && descriptionText) {
    return `${titleText} ${descriptionText}`.trim();
  }
  if (titleText) {
    return titleText;
  }
  return url;
}

async function resolveSpotifySources(url, requestedBy) {
  const match = url.match(SPOTIFY_URL_RE);
  if (!match) {
    return [];
  }

  const [, kind, spotifyId] = match;
  if (kind === "track") {
    if (SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET) {
      const track = await spotifyApiGet(`tracks/${spotifyId}`);
      return [queueTrackFromSpotifyApi(track, requestedBy)].filter(Boolean);
    }

    const query = await resolveSpotifyQuery(url);
    const item = await resolveSearchTrack(query, requestedBy);
    return [item];
  }

  if (kind === "playlist") {
    if (SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET) {
      try {
        let page = await spotifyApiGet(
          `playlists/${spotifyId}/tracks?limit=${Math.min(100, PLAYLIST_MAX_TRACKS)}&additional_types=track`,
        );
        const items = [];
        while (page && items.length < PLAYLIST_MAX_TRACKS) {
          for (const row of page.items || []) {
            const item = queueTrackFromSpotifyApi(row.track, requestedBy);
            if (item) {
              items.push(item);
            }
            if (items.length >= PLAYLIST_MAX_TRACKS) {
              break;
            }
          }

          if (items.length >= PLAYLIST_MAX_TRACKS || !page.next) {
            break;
          }

          const response = await fetch(page.next, {
            headers: { Authorization: `Bearer ${await spotifyAccessToken()}` },
          });
          if (!response.ok) {
            break;
          }
          page = await response.json();
        }
        if (items.length > 0) {
          return items;
        }
      } catch (error) {
        logger.warn(`Spotify playlist API lookup failed, trying fallback: ${error.message}`);
      }
    }

    const fallbackItems = await spotifyFallbackPlaylistTracks(spotifyId, requestedBy);
    if (fallbackItems.length === 0) {
      throw new Error("No playable tracks found for that Spotify playlist.");
    }
    return fallbackItems;
  }

  if (kind === "album") {
    if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
      throw new Error("Spotify album expansion requires SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.");
    }

    const album = await spotifyApiGet(`albums/${spotifyId}`);
    return (album.tracks?.items || [])
      .slice(0, PLAYLIST_MAX_TRACKS)
      .map((track) =>
        queueTrackFromSpotifyApi(
          {
            ...track,
            album: { images: album.images || [] },
          },
          requestedBy,
        ),
      )
      .filter(Boolean);
  }

  return [];
}

async function resolveSearchTrack(query, requestedBy) {
  const results = await play.search(query, {
    limit: 1,
    source: { youtube: "video" },
  });
  const result = results[0];
  if (!result) {
    throw new Error("No playable results found for that query.");
  }

  return createTrack({
    title: result.title,
    webpageUrl: result.url,
    duration: result.durationInSec,
    thumbnail: result.thumbnails?.at(-1)?.url || null,
    requestedBy,
  });
}

async function resolveSoundCloudSources(url, requestedBy) {
  if (!soundCloudReady) {
    throw new Error("SoundCloud support is unavailable right now.");
  }

  const info = await play.soundcloud(url);
  if (info.type === "track") {
    return [
      createTrack({
        title: `${info.name} - ${info.user?.name || "Unknown artist"}`,
        webpageUrl: info.permalink || info.url,
        duration: info.durationInSec,
        thumbnail: info.thumbnail,
        requestedBy,
      }),
    ];
  }

  const tracks = await info.all_tracks();
  return tracks.slice(0, PLAYLIST_MAX_TRACKS).map((track) =>
    createTrack({
      title: `${track.name} - ${track.user?.name || "Unknown artist"}`,
      webpageUrl: track.permalink || track.url,
      duration: track.durationInSec,
      thumbnail: track.thumbnail,
      requestedBy,
    }),
  );
}

async function resolveYouTubeSources(url, requestedBy) {
  const validation = play.yt_validate(url);
  if (validation === "playlist") {
    const playlist = await play.playlist_info(url, { incomplete: true });
    const videos = await playlist.all_videos();
    return videos.slice(0, PLAYLIST_MAX_TRACKS).map((video) =>
      createTrack({
        title: video.title,
        webpageUrl: video.url,
        duration: video.durationInSec,
        thumbnail: video.thumbnails?.at(-1)?.url || null,
        requestedBy,
      }),
    );
  }

  const info = await play.video_basic_info(url);
  const video = info.video_details;
  return [
    createTrack({
      title: video.title,
      webpageUrl: video.url,
      duration: video.durationInSec,
      thumbnail: video.thumbnails?.at(-1)?.url || null,
      requestedBy,
    }),
  ];
}

async function resolveSources(query, requestedBy) {
  const resolvedQuery = normalizePlaybackQuery(query.trim());
  if (!resolvedQuery) {
    throw new Error("Query is empty.");
  }

  if (SPOTIFY_URL_RE.test(resolvedQuery)) {
    return resolveSpotifySources(resolvedQuery, requestedBy);
  }

  if (!isHttpUrl(resolvedQuery)) {
    return [await resolveSearchTrack(resolvedQuery, requestedBy)];
  }

  const sourceType = await play.validate(resolvedQuery);
  switch (sourceType) {
    case "yt_video":
    case "yt_playlist":
      return resolveYouTubeSources(resolvedQuery, requestedBy);
    case "so_track":
    case "so_playlist":
      return resolveSoundCloudSources(resolvedQuery, requestedBy);
    default:
      throw new Error("Unsupported URL. Use a YouTube, Spotify, or SoundCloud link, or a search query.");
  }
}

async function hydrateTrack(track) {
  let sourceUrl = track.streamUrl || track.webpageUrl;
  const needsSearchResolution = track.searchQuery || !isHttpUrl(sourceUrl);

  if (needsSearchResolution) {
    const searchTerm = track.searchQuery || track.title;
    const result = await resolveSearchTrack(searchTerm, track.requestedBy);
    track.title = result.title;
    track.webpageUrl = result.webpageUrl;
    track.duration = result.duration;
    track.thumbnail = result.thumbnail;
    sourceUrl = result.webpageUrl;
  }

  track.streamUrl = sourceUrl;
  return { track, sourceUrl };
}

async function createPlaybackResource(track) {
  const hydrated = await hydrateTrack(track);
  const sourceUrl = hydrated.sourceUrl;

  if (isYouTubeUrl(sourceUrl)) {
    return { resource: await createYouTubeResource(track, sourceUrl), stream: null };
  }

  const stream = await play.stream(sourceUrl);
  const resource = createAudioResource(stream.stream, {
    inputType: stream.type || StreamType.Arbitrary,
    metadata: track,
  });
  return { resource, stream };
}

function resolveYtDlpPath() {
  const configured = env("YTDLP_PATH");
  if (configured && fs.existsSync(configured)) {
    return configured;
  }
  if (fs.existsSync(LOCAL_YTDLP_PATH)) {
    return LOCAL_YTDLP_PATH;
  }
  return "yt-dlp";
}

async function runYtDlp(args) {
  const ytDlpPath = resolveYtDlpPath();
  return await new Promise((resolve, reject) => {
    execFile(ytDlpPath, args, { windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function resolveYouTubeMediaUrl(track, url) {
  const attempts = [
    {
      args: [
        "--js-runtimes",
        "node",
        "--no-playlist",
        "--force-ipv4",
        "--no-progress",
        "-f",
        "bestaudio[ext=webm][acodec=opus]/bestaudio[acodec=opus]/bestaudio",
        "-g",
        url,
      ],
      tolerateMissingJsRuntime: true,
    },
    {
      args: [
        "--no-playlist",
        "--force-ipv4",
        "--no-progress",
        "-f",
        "bestaudio[ext=webm][acodec=opus]/bestaudio[acodec=opus]/bestaudio",
        "-g",
        url,
      ],
    },
    {
      args: ["--no-playlist", "--force-ipv4", "--no-progress", "-f", "bestaudio/best", "-g", url],
    },
    {
      args: [
        "--no-playlist",
        "--force-ipv4",
        "--no-progress",
        "--extractor-args",
        "youtube:player_client=android",
        "-f",
        "bestaudio/best",
        "-g",
        url,
      ],
    },
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const { stdout, stderr } = await runYtDlp(attempt.args);
      const lines = String(stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (stderr?.trim()) {
        logger.warn(`yt-dlp resolver for '${track.title}': ${stderr.trim()}`);
      }
      const mediaUrl = lines[0];
      if (!mediaUrl || !isHttpUrl(mediaUrl)) {
        throw new Error("yt-dlp did not return a playable media URL");
      }
      return mediaUrl;
    } catch (error) {
      lastError = error;
      const stderr = String(error?.stderr || "").trim();
      if (stderr && !(attempt.tolerateMissingJsRuntime && stderr.includes("no such option: --js-runtimes"))) {
        logger.warn(`yt-dlp resolver failed for '${track.title}': ${stderr}`);
      }
      if (attempt.tolerateMissingJsRuntime && stderr.includes("no such option: --js-runtimes")) {
        continue;
      }
    }
  }

  throw new Error(lastError?.stderr?.trim() || lastError?.message || "yt-dlp failed to resolve a media URL");
}

async function createYouTubeResource(track, url) {
  const mediaUrl = await resolveYouTubeMediaUrl(track, url);
  const ffmpeg = spawn(
    env("FFMPEG_PATH", "ffmpeg"),
    [
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "5",
      "-probesize",
      "32M",
      "-analyzeduration",
      "32M",
      "-loglevel",
      "error",
      "-i",
      mediaUrl,
      "-vn",
      "-sn",
      "-dn",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "pipe:1",
    ],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const cleanup = () => {
    if (!ffmpeg.killed) {
      ffmpeg.kill();
    }
  };

  ffmpeg.stderr.on("data", (chunk) => {
    const text = String(chunk || "").trim();
    if (text) {
      logger.warn(`ffmpeg playback helper for '${track.title}': ${text}`);
    }
  });
  ffmpeg.on("error", (error) => {
    logger.warn(`FFmpeg playback helper failed for '${track.title}': ${error.message}`);
    cleanup();
  });
  ffmpeg.once("close", (code) => {
    if (code && code !== 0) {
      logger.warn(`ffmpeg exited with code ${code} for '${track.title}'`);
    }
    cleanup();
  });
  ffmpeg.stdout.once("close", cleanup);
  ffmpeg.stdout.once("end", cleanup);

  return createAudioResource(ffmpeg.stdout, {
    inputType: StreamType.Raw,
    metadata: track,
  });
}

function buildPlayerEmbed(state) {
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle("Music Player");
  const queueSize = state.queue.length;
  const isRecording = Boolean(state.recording);
  const playbackState = state.isPaused()
    ? "Paused"
    : state.isPlaying()
      ? "Playing"
      : state.current
        ? "Resolving"
        : "Idle";

  if (state.current) {
    embed.setDescription(
      `**Now playing**\n[${truncate(state.current.title, 200)}](${state.current.webpageUrl})\n` +
        `\`${formatDuration(state.current.duration)}\` • requested by \`${escapeMarkdown(state.current.requestedBy)}\``,
    );
    if (state.current.thumbnail) {
      embed.setThumbnail(state.current.thumbnail);
    }
  } else {
    embed.setDescription("Use `/play` or `/playnext` to queue something.");
  }

  embed.addFields(
    {
      name: "Status",
      value:
        `Playback: **${playbackState}**\n` +
        `Recording: **${isRecording ? "On" : "Off"}**\n` +
        `Queued: **${queueSize}**`,
      inline: true,
    },
    {
      name: "Previous",
      value: state.history[0]
        ? `${truncate(state.history[0].title, 100)}\n\`${formatDuration(state.history[0].duration)}\``
        : "Nothing played yet.",
      inline: true,
    },
  );

  if (state.panelQueueVisible) {
    const preview = state.queue.slice(0, 5);
    const queueValue =
      preview.length > 0
        ? preview
            .map((track, index) => `\`${index + 1}.\` ${truncate(track.title, 90)} [${formatDuration(track.duration)}]`)
            .concat(state.queue.length > preview.length ? [`\`…\` +${state.queue.length - preview.length} more`] : [])
            .join("\n")
        : "Queue is empty.";
    embed.addFields({ name: "Up Next", value: truncate(queueValue, 1024), inline: false });
    embed.setFooter({ text: "Queue shown. Use the queue button to hide it." });
  } else {
    embed.setFooter({ text: "Queue hidden. Use the queue button to expand it." });
  }

  return embed;
}

function buildPlayerComponents(state) {
  const queueToggleLabel = state.panelQueueVisible ? "Hide Queue" : "Show Queue";
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`player:${state.guildId}:pause_resume`)
        .setLabel(state.isPaused() ? "Resume" : "Pause")
        .setStyle(state.isPaused() ? ButtonStyle.Primary : ButtonStyle.Success)
        .setDisabled(!(state.isPlaying() || state.isPaused())),
      new ButtonBuilder()
        .setCustomId(`player:${state.guildId}:previous`)
        .setLabel("Previous")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(state.history.length === 0),
      new ButtonBuilder()
        .setCustomId(`player:${state.guildId}:skip`)
        .setLabel("Skip")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!(state.current || state.queue.length > 0)),
      new ButtonBuilder()
        .setCustomId(`player:${state.guildId}:stop`)
        .setLabel("Stop")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!(state.current || state.queue.length > 0 || state.isPlaying() || state.isPaused())),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`player:${state.guildId}:queue_toggle`)
        .setLabel(queueToggleLabel)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!(state.queue.length > 0 || state.panelQueueVisible)),
    ),
  ];
}

function buildQueueEmbed(state, page = 1, pageSize = 10) {
  const totalItems = state.queue.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = (safePage - 1) * pageSize;
  const slice = state.queue.slice(start, start + pageSize);

  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle("Queue");
  if (state.current) {
    embed.setDescription(
      `Now playing: ${truncate(state.current.title, 200)} [${formatDuration(state.current.duration)}]`,
    );
  }

  if (slice.length === 0) {
    embed.addFields({ name: "Up next", value: "Queue is empty.", inline: false });
  } else {
    embed.addFields({
      name: "Up next",
      value: slice
        .map((track, index) => `${start + index + 1}. ${truncate(track.title, 120)} [${formatDuration(track.duration)}]`)
        .join("\n"),
      inline: false,
    });
  }

  embed.setFooter({ text: `Page ${safePage}/${totalPages} • ${totalItems} queued` });
  return { embed, page: safePage, totalPages };
}

function buildQueueComponents(guildId, page, totalPages) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`queue:${guildId}:${page - 1}`)
        .setLabel("<")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 1),
      new ButtonBuilder()
        .setCustomId(`queue:${guildId}:${page + 1}`)
        .setLabel(">")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages),
    ),
  ];
}

async function refreshPlayerPanel(guildId) {
  const state = getGuildState(guildId);
  const task = Promise.resolve(state.panelRefreshPromise)
    .catch(() => {})
    .then(async () => {
      if (!state.controllerChannelId) {
        return;
      }

      const guild = state.guild;
      if (!guild) {
        return;
      }

      const channel = guild.channels.cache.get(state.controllerChannelId);
      if (!channel?.isTextBased()) {
        return;
      }

      const payload = {
        embeds: [buildPlayerEmbed(state)],
        components: buildPlayerComponents(state),
      };

      let message = null;
      if (state.playerMessageId) {
        try {
          message = await channel.messages.fetch(state.playerMessageId);
          await message.edit(payload);
        } catch (error) {
          if (error?.code !== 10008) {
            logger.warn(`Unable to update player panel in guild ${guildId}: ${error.message}`);
          }
          message = null;
        }
      }

      if (!message) {
        message = await channel.send(payload);
        state.playerMessageId = message.id;
      }

      try {
        const recentMessages = await channel.messages.fetch({ limit: 20 });
        const stalePanels = [...recentMessages.values()].filter(
          (item) =>
            item.id !== state.playerMessageId &&
            item.author?.id === client.user?.id &&
            item.embeds?.[0]?.title === "Music Player",
        );
        for (const stale of stalePanels) {
          await stale.delete().catch(() => {});
        }
      } catch (error) {
        logger.warn(`Unable to prune old player panels in guild ${guildId}: ${error.message}`);
      }
    });

  state.panelRefreshPromise = task;
  try {
    await task;
  } finally {
    if (state.panelRefreshPromise === task) {
      state.panelRefreshPromise = null;
    }
  }
}

async function finalizeRecording(session) {
  await session.stop();
  completedRecordings.set(session.token, session);
  latestRecordingByGuild.set(session.guildId, session.token);
}

function clearIdleTimer(state) {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  state.idleReason = null;
}

function armIdleTimer(state, reason) {
  if (state.idleTimer && state.idleReason === reason) {
    return;
  }

  clearIdleTimer(state);
  state.idleReason = reason;
  state.idleTimer = setTimeout(() => {
    void disconnectGuild(state.guildId, reason);
  }, AFK_DISCONNECT_SECONDS * 1000);
}

async function disconnectGuild(guildId, reason) {
  const state = getGuildState(guildId);
  if (state.disconnecting) {
    return;
  }

  state.disconnecting = true;
  clearIdleTimer(state);

  try {
    if (state.recording) {
      const session = state.recording;
      state.recording = null;
      await finalizeRecording(session);
    }

    state.queue = [];
    state.current = null;
    state.panelQueueVisible = false;
    state.player.stop(true);

    const connection = state.connection || getVoiceConnection(guildId);
    if (connection) {
      connection.destroy();
    }
    state.connection = null;
    refreshPresence();
    logger.info(`${reason} in guild ${guildId}`);
  } finally {
    state.disconnecting = false;
    await refreshPlayerPanel(guildId).catch(() => {});
  }
}

async function refreshVoiceLifecycle(guildId) {
  const state = getGuildState(guildId);
  const guild = state.guild;
  if (!guild) {
    clearIdleTimer(state);
    refreshPresence();
    return;
  }

  const connection = state.connection || getVoiceConnection(guildId);
  state.connection = connection || null;
  if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
    clearIdleTimer(state);
    refreshPresence();
    return;
  }

  const channelId = connection.joinConfig.channelId;
  const channel = channelId ? guild.channels.cache.get(channelId) : null;
  const members = channel?.members ? [...channel.members.values()] : [];
  const nonBotMembers = members.filter((member) => !member.user.bot);
  if (nonBotMembers.length === 0) {
    armIdleTimer(state, `Bot was alone in voice channel for ${AFK_DISCONNECT_SECONDS} seconds`);
    refreshPresence();
    return;
  }

  if (state.recording || state.hasActivity()) {
    clearIdleTimer(state);
    refreshPresence();
    return;
  }

  if (state.idleTimer) {
    refreshPresence();
    return;
  }

  armIdleTimer(state, `AFK timeout after ${AFK_DISCONNECT_SECONDS} seconds`);
  refreshPresence();
}

function activePresenceEntries() {
  const entries = [];
  const recordingCount = [...guildStates.values()].filter((state) => Boolean(state.recording)).length;
  if (recordingCount > 0) {
    entries.push({
      type: ActivityType.Playing,
      name: recordingCount === 1 ? "Recording voice" : `Recording in ${recordingCount} guilds`,
    });
  }

  const firstPlaying = [...guildStates.values()].find((state) => state.current);
  if (firstPlaying?.current) {
    entries.push({
      type: ActivityType.Listening,
      name: truncate(firstPlaying.current.title, 128),
    });
  }

  if (entries.length === 0) {
    entries.push({ type: ActivityType.Playing, name: "Idle" });
  }
  return entries;
}

async function applyPresence() {
  if (!client.isReady()) {
    return;
  }

  const activities = activePresenceEntries();
  const activity = activities[presenceCycleIndex % activities.length];
  await client.user.setActivity(activity.name, { type: activity.type });
}

function refreshPresence({ resetCycle = true } = {}) {
  if (resetCycle) {
    presenceCycleIndex = 0;
  }
  void applyPresence().catch((error) => {
    logger.warn(`Failed to update bot presence: ${error.message}`);
  });
}

function startPresenceLoop() {
  setInterval(() => {
    const activities = activePresenceEntries();
    if (activities.length > 1) {
      presenceCycleIndex += 1;
      void applyPresence().catch((error) => {
        logger.warn(`Failed to update bot presence: ${error.message}`);
      });
    }
  }, 12_000);
}

async function pruneExpiredRecordings() {
  const now = Date.now();
  for (const [token, session] of completedRecordings.entries()) {
    if (!session.isExpired(now)) {
      continue;
    }

    completedRecordings.delete(token);
    if (latestRecordingByGuild.get(session.guildId) === token) {
      latestRecordingByGuild.delete(session.guildId);
    }
    await fsp.rm(session.directory, { recursive: true, force: true }).catch(() => {});
  }
}

function recordingLinkMessage(session, wavFiles) {
  if (wavFiles.length === 0) {
    return "Recording stopped, but no audio files were captured.";
  }

  const links = wavFiles.map((name) => `[${name}](${session.indexUrl()}${encodeURIComponent(name)})`).join(", ");
  const zipPart = session.archivePath ? ` | ZIP: [session.zip](${session.zipUrl()})` : "";
  return `Recording saved. Download files: ${links}${zipPart} | Expires: ${session.expiresAt().toISOString()}`;
}

async function startDownloadServer() {
  const app = express();

  app.get("/recordings/:token/", async (req, res) => {
    await pruneExpiredRecordings();
    const token = req.params.token;
    const session =
      completedRecordings.get(token) ||
      [...guildStates.values()].map((state) => state.recording).find((item) => item?.token === token);
    if (!session) {
      res.status(404).send("Recording session not found");
      return;
    }

    const wavFiles = await session.wavFiles();
    const links = wavFiles
      .map((name) => `<li><a href="${encodeURIComponent(name)}">${escapeHtml(name)}</a></li>`)
      .join("");
    res.type("html").send(`<html><body><h1>Recording files</h1><ul>${links}</ul></body></html>`);
  });

  app.get("/recordings/:token/session.zip", async (req, res) => {
    await pruneExpiredRecordings();
    const session = completedRecordings.get(req.params.token);
    if (!session?.archivePath) {
      res.status(404).send("Archive not found");
      return;
    }

    res.sendFile(path.resolve(session.archivePath));
  });

  app.get("/recordings/:token/:filename", async (req, res) => {
    await pruneExpiredRecordings();
    const token = req.params.token;
    const session =
      completedRecordings.get(token) ||
      [...guildStates.values()].map((state) => state.recording).find((item) => item?.token === token);
    if (!session) {
      res.status(404).send("Recording session not found");
      return;
    }

    const requestedPath = path.resolve(session.directory, req.params.filename);
    const sessionPath = path.resolve(session.directory);
    if (!(requestedPath === sessionPath || requestedPath.startsWith(`${sessionPath}${path.sep}`))) {
      res.status(403).send("Invalid file path");
      return;
    }

    res.sendFile(requestedPath, (error) => {
      if (error) {
        res.status(error.statusCode || 404).end();
      }
    });
  });

  for (let offset = 0; offset < DOWNLOAD_PORT_SEARCH_ATTEMPTS; offset += 1) {
    const candidatePort = DOWNLOAD_PORT + offset;
    try {
      const server = http.createServer(app);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(candidatePort, DOWNLOAD_HOST, resolve);
      });
      downloadServer = server;
      downloadBaseUrl = DOWNLOAD_BASE_URL_FROM_ENV ? DOWNLOAD_BASE_URL : `http://127.0.0.1:${candidatePort}`;
      logger.info(`Download server started on ${DOWNLOAD_HOST}:${candidatePort}`);
      logger.info(`Recording links base URL: ${downloadBaseUrl}`);
      return;
    } catch (error) {
      if (DOWNLOAD_BASE_URL_FROM_ENV || offset === DOWNLOAD_PORT_SEARCH_ATTEMPTS - 1) {
        throw error;
      }
    }
  }
}

async function safeReply(interaction, content, options = {}) {
  if (interaction.deferred || interaction.replied) {
    return interaction.followUp({ content, ...options });
  }
  return interaction.reply({ content, ...options });
}

async function fetchInteractionMember(interaction) {
  if (!interaction.guild) {
    throw new Error("This command must be used in a guild.");
  }

  return interaction.guild.members.fetch(interaction.user.id);
}

const COMMANDS = [
  new SlashCommandBuilder().setName("ping").setDescription("Check if the bot is online"),
  new SlashCommandBuilder().setName("join").setDescription("Join your current voice channel"),
  new SlashCommandBuilder().setName("leave").setDescription("Disconnect from voice and clear playback/recording state"),
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a YouTube, Spotify, or SoundCloud link, or a search term")
    .addStringOption((option) => option.setName("query").setDescription("Track, playlist, or search").setRequired(true)),
  new SlashCommandBuilder()
    .setName("playnext")
    .setDescription("Add a track or playlist next in the queue")
    .addStringOption((option) => option.setName("query").setDescription("Track, playlist, or search").setRequired(true)),
  new SlashCommandBuilder().setName("skip").setDescription("Skip the current track"),
  new SlashCommandBuilder().setName("pause").setDescription("Pause playback"),
  new SlashCommandBuilder().setName("resume").setDescription("Resume playback"),
  new SlashCommandBuilder().setName("stop").setDescription("Stop playback and clear the queue"),
  new SlashCommandBuilder().setName("queue").setDescription("Show the current queue"),
  new SlashCommandBuilder().setName("shuffle").setDescription("Shuffle queued tracks"),
  new SlashCommandBuilder().setName("recordstart").setDescription("Start recording the current voice channel"),
  new SlashCommandBuilder().setName("recordstop").setDescription("Stop recording and return a download link"),
  new SlashCommandBuilder().setName("recordlink").setDescription("Get the download link for the latest recording"),
  new SlashCommandBuilder().setName("status").setDescription("Show playback and recording status"),
].map((command) =>
  command
    .setContexts(InteractionContextType.Guild)
    .toJSON(),
);

async function syncCommands() {
  if (client.application) {
    await client.application.commands.set([]);
  }
  for (const guild of client.guilds.cache.values()) {
    await guild.commands.set(COMMANDS);
  }
}

async function handlePlay(interaction, { next = false } = {}) {
  await interaction.deferReply();
  const guild = interaction.guild;
  const member = await fetchInteractionMember(interaction);
  if (!guild || !member?.voice?.channel) {
    throw new Error("You must join a voice channel first.");
  }

  const state = getGuildState(guild.id);
  state.controllerChannelId = interaction.channelId;
  await state.ensureConnection(member, { requireReceive: Boolean(state.recording) });

  const query = interaction.options.getString("query", true);
  const requestedBy = interaction.member?.displayName || interaction.user.username;
  const tracks = await resolveSources(query, requestedBy);
  if (!tracks.length) {
    throw new Error("No playable tracks found for that input.");
  }

  state.deferPanelRefresh = true;
  try {
    if (next) {
      await state.enqueueNext(tracks);
    } else {
      await state.enqueue(tracks);
    }
  } finally {
    state.deferPanelRefresh = false;
  }

  const message =
    tracks.length === 1
      ? `${next ? "Added next" : "Queued"}: ${tracks[0].title}`
      : `${next ? "Queued next batch" : "Queued playlist"} with ${tracks.length} tracks${tracks.length >= PLAYLIST_MAX_TRACKS ? " (capped)" : ""}.`;
  await safeReply(interaction, message);
  await state.refreshState();
}

async function handleCommand(interaction) {
  const guild = interaction.guild;
  const guildId = interaction.guildId;
  const state = guildId ? getGuildState(guildId) : null;

  switch (interaction.commandName) {
    case "ping":
      await interaction.reply({ content: "Pong!", ephemeral: true });
      return;
    case "join": {
      const member = await fetchInteractionMember(interaction);
      if (!guild || !member?.voice?.channel) {
        throw new Error("You must join a voice channel first.");
      }
      await state.ensureConnection(member, { requireReceive: Boolean(state.recording) });
      await interaction.reply({ content: "Joined your voice channel.", ephemeral: true });
      return;
    }
    case "leave":
      await interaction.deferReply({ ephemeral: true });
      await disconnectGuild(guildId, "Manual leave requested");
      await safeReply(interaction, "Disconnected from voice and cleared playback state.", { ephemeral: true });
      return;
    case "play":
      await handlePlay(interaction, { next: false });
      return;
    case "playnext":
      await handlePlay(interaction, { next: true });
      return;
    case "skip": {
      const skipped = await state.skip();
      await interaction.reply({ content: skipped ? "Skipped." : "Nothing is playing.", ephemeral: true });
      return;
    }
    case "pause": {
      const paused = await state.pause();
      await interaction.reply({ content: paused ? "Paused." : "Nothing is playing.", ephemeral: true });
      return;
    }
    case "resume": {
      const resumed = await state.resume();
      await interaction.reply({ content: resumed ? "Resumed." : "Nothing is paused.", ephemeral: true });
      return;
    }
    case "stop":
      await state.stopPlayback();
      await interaction.reply({ content: "Stopped.", ephemeral: true });
      return;
    case "queue": {
      const { embed, page, totalPages } = buildQueueEmbed(state, 1);
      await interaction.reply({
        embeds: [embed],
        components: buildQueueComponents(guildId, page, totalPages),
        ephemeral: true,
      });
      return;
    }
    case "shuffle": {
      const shuffled = await state.shuffleQueue();
      await interaction.reply({
        content: shuffled ? "Queue shuffled." : "Need at least 2 queued tracks.",
        ephemeral: true,
      });
      return;
    }
    case "recordstart": {
      const member = await fetchInteractionMember(interaction);
      if (!guild || !member?.voice?.channel) {
        throw new Error("You must join a voice channel first.");
      }
      if (state.recording) {
        throw new Error("Recording is already active in this guild.");
      }

      await interaction.deferReply({ ephemeral: true });
      const connection = await state.ensureConnection(member, { requireReceive: true });
      await state.updateReceiveMode(true);

      const session = new RecordingSession(guildId, member.voice.channel.id);
      session.attach(connection, guild);
      state.recording = session;
      await state.refreshState();
      await safeReply(interaction, `Recording started. Files will be available at ${session.indexUrl()}`, {
        ephemeral: true,
      });
      return;
    }
    case "recordstop": {
      if (!state.recording) {
        throw new Error("There is no active recording in this guild.");
      }

      await interaction.deferReply({ ephemeral: true });
      const session = state.recording;
      state.recording = null;
      await finalizeRecording(session);
      await state.updateReceiveMode(false);
      await state.refreshState();
      const wavFiles = await session.wavFiles();
      await safeReply(interaction, recordingLinkMessage(session, wavFiles), { ephemeral: true });
      return;
    }
    case "recordlink": {
      await interaction.deferReply({ ephemeral: true });
      if (state.recording) {
        await safeReply(interaction, `Recording in progress: ${state.recording.indexUrl()}`, { ephemeral: true });
        return;
      }

      const latestToken = latestRecordingByGuild.get(guildId);
      const latest = latestToken ? completedRecordings.get(latestToken) : null;
      if (!latest) {
        throw new Error("No recording is available for this guild.");
      }

      await safeReply(
        interaction,
        `Latest recording: ${latest.indexUrl()} | ZIP: ${latest.archivePath ? latest.zipUrl() : "not available"}`,
        { ephemeral: true },
      );
      return;
    }
    case "status": {
      const lines = [];
      if (state.current) {
        lines.push(`Playback: now playing ${state.current.title}`);
      } else if (state.queue.length > 0) {
        lines.push(`Playback: queued ${state.queue.length} item(s)`);
      } else {
        lines.push("Playback: idle");
      }

      if (state.isPlaying()) {
        lines.push("Voice client: playing");
      } else if (state.isPaused()) {
        lines.push("Voice client: paused");
      } else {
        lines.push("Voice client: idle");
      }

      lines.push(state.recording ? "Recording: active" : "Recording: inactive");
      await interaction.reply({ content: lines.join("\n"), ephemeral: true });
      return;
    }
    default:
      throw new Error("Unsupported command.");
  }
}

async function handlePlayerButton(interaction, guildId, action) {
  const state = getGuildState(guildId);
  await interaction.deferUpdate();

  switch (action) {
    case "pause_resume":
      if (state.isPaused()) {
        await state.resume();
      } else {
        await state.pause();
      }
      return;
    case "previous":
      await state.previous();
      return;
    case "skip":
      await state.skip();
      return;
    case "stop":
      await state.stopPlayback();
      return;
    case "queue_toggle":
      state.panelQueueVisible = !state.panelQueueVisible;
      await state.refreshState();
      return;
    default:
      throw new Error("Unsupported player action.");
  }
}

async function handleQueueButton(interaction, guildId, page) {
  const state = getGuildState(guildId);
  const { embed, page: safePage, totalPages } = buildQueueEmbed(state, page);
  await interaction.update({
    embeds: [embed],
    components: buildQueueComponents(guildId, safePage, totalPages),
  });
}

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleCommand(interaction);
      return;
    }

    if (interaction.isButton()) {
      const [kind, guildId, value] = interaction.customId.split(":");
      if (kind === "player") {
        await handlePlayerButton(interaction, guildId, value);
        return;
      }
      if (kind === "queue") {
        await handleQueueButton(interaction, guildId, Number.parseInt(value, 10));
      }
    }
  } catch (error) {
    const message = error?.message || "Something went wrong.";
    logger.error(message);
    if (interaction.isButton()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
      } else {
        await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
      }
      return;
    }

    await safeReply(interaction, message, { ephemeral: true }).catch(() => {});
  }
});

client.on("voiceStateUpdate", (oldState, newState) => {
  const guildId = newState.guild.id || oldState.guild.id;
  if (guildId) {
    void refreshVoiceLifecycle(guildId);
  }
});

client.on("guildCreate", async (guild) => {
  await guild.commands.set(COMMANDS).catch((error) => {
    logger.warn(`Failed to sync commands for guild ${guild.id}: ${error.message}`);
  });
});

client.once("ready", async () => {
  logger.info(`Logged in as ${client.user.tag}`);
  logger.info(`Runtime executable: node ${process.version}`);

  await configurePlayDl();
  await startDownloadServer();
  await syncCommands();
  refreshPresence();
  startPresenceLoop();
  setInterval(() => {
    void pruneExpiredRecordings();
  }, CLEANUP_INTERVAL_SECONDS * 1000);
});

client.on("error", (error) => {
  logger.error(`Client error: ${error.message}`);
});

process.on("SIGINT", async () => {
  logger.info("Shutting down...");
  if (downloadServer) {
    downloadServer.close();
  }

  for (const state of guildStates.values()) {
    if (state.recording) {
      const session = state.recording;
      state.recording = null;
      await finalizeRecording(session);
    }
    const connection = state.connection || getVoiceConnection(state.guildId);
    connection?.destroy();
  }

  await client.destroy();
  process.exit(0);
});

client.login(TOKEN);
