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
const { createSqliteStateStore } = require("../data/sqlite-state");
const { registerOtaRoutes } = require("../ota/ota-routes");
const { createOtaRuntime } = require("../ota/ota-runtime");
const { createRadioRuntime } = require("../radio/radio-runtime");
const play = require("play-dl");
const prism = require("prism-media");
const { formatRuntimeVersion, getRuntimeVersion } = require("../runtime/runtime-version");
const {
  renderRecordingAccessDeniedPage,
  renderRecordingsHelpPage,
  renderRecordingsHomePage,
  renderRecordingsListPage,
  renderRecordingSessionPage,
} = require("../web/recordings-web");
const {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  InteractionContextType,
  PermissionFlagsBits,
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

const BOT_DIR = path.resolve(__dirname, "..", "..");
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
const SQLITE_DB_PATH = env("SQLITE_DB_PATH", path.join(RECORDINGS_DIR, "_state.sqlite"));
const PLAYBACK_STATE_PATH = env("PLAYBACK_STATE_PATH", path.join(RECORDINGS_DIR, "_playback-state.json"));
const UPDATE_STATE_PATH = env("UPDATE_STATE_PATH", path.join(RECORDINGS_DIR, "_update-state.json"));
const UPDATE_MANIFEST_PATH = env("UPDATE_MANIFEST_PATH", path.join(RECORDINGS_DIR, "_staged-release-manifest.json"));
const RECORDING_NICKNAME_INDICATOR = " 🔴";
const RESUME_EARLY_END_THRESHOLD_MS = 5_000;
const RECORDINGS_TTL_DAYS = Math.min(31, Math.max(1, Number.parseInt(env("RECORDINGS_TTL_DAYS", "30"), 10)));
const RECENT_RECORDINGS_DAYS = Math.min(
  RECORDINGS_TTL_DAYS,
  Math.max(1, Number.parseInt(env("RECENT_RECORDINGS_DAYS", "7"), 10)),
);
const CLEANUP_INTERVAL_SECONDS = Math.max(
  60,
  Number.parseInt(env("CLEANUP_INTERVAL_SECONDS", "3600"), 10),
);
const AFK_DISCONNECT_SECONDS = Math.max(
  30,
  Number.parseInt(env("AFK_DISCONNECT_SECONDS", "300"), 10),
);
const GLOBAL_IDLE_COMMAND_COOLDOWN_SECONDS = Math.max(
  15,
  Number.parseInt(env("GLOBAL_IDLE_COMMAND_COOLDOWN_SECONDS", "90"), 10),
);
const UPDATE_STATE_POLL_SECONDS = Math.max(
  5,
  Number.parseInt(env("UPDATE_STATE_POLL_SECONDS", "15"), 10),
);
const SECURITY_UPDATE_DRAIN_SECONDS = Math.max(
  15,
  Number.parseInt(env("SECURITY_UPDATE_DRAIN_SECONDS", "120"), 10),
);
const SUPERVISOR_PREPARE_TIMEOUT_SECONDS = Math.max(
  15,
  Number.parseInt(env("SUPERVISOR_PREPARE_TIMEOUT_SECONDS", "180"), 10),
);
const PLAYLIST_MAX_TRACKS = Math.max(
  1,
  Number.parseInt(env("PLAYLIST_MAX_TRACKS", "500"), 10),
);
const SPOTIFY_MARKET = env("SPOTIFY_MARKET", "US")?.toUpperCase();
const SPOTIFY_PLAYLIST_PAGE_SIZE = 50;
const RADIO_MIN_BUFFER_TRACKS = Math.max(
  1,
  Number.parseInt(env("RADIO_MIN_BUFFER_TRACKS", "3"), 10),
);
const RADIO_RECENT_TRACKS_LIMIT = Math.max(
  10,
  Number.parseInt(env("RADIO_RECENT_TRACKS_LIMIT", "30"), 10),
);
const SPOTIFY_CLIENT_ID = env("SPOTIFY_CLIENT_ID") || env("SPOTIPY_CLIENT_ID");
const SPOTIFY_CLIENT_SECRET = env("SPOTIFY_CLIENT_SECRET") || env("SPOTIPY_CLIENT_SECRET");
const SPOTIFY_REFRESH_TOKEN = env("SPOTIFY_REFRESH_TOKEN");
const SPOTIFY_REDIRECT_URI = env("SPOTIFY_REDIRECT_URI");
const SPOTIFY_REFRESH_TOKEN_PATH = env("SPOTIFY_REFRESH_TOKEN_PATH", path.join(RECORDINGS_DIR, "_spotify-refresh-token"));
const SPOTIFY_OAUTH_SETUP_SECRET = env("SPOTIFY_OAUTH_SETUP_SECRET");
const DISCORD_CLIENT_ID = env("DISCORD_CLIENT_ID");
const DISCORD_CLIENT_SECRET = env("DISCORD_CLIENT_SECRET");
const DISCORD_REDIRECT_URI = env("DISCORD_REDIRECT_URI");
const WEB_SESSION_SECRET = env("WEB_SESSION_SECRET") || env("SESSION_SECRET");
const SUPERVISOR_TOKEN = env("SUPERVISOR_TOKEN");

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const logger = {
  info: (...args) => console.log(new Date().toISOString(), "INFO", "discord-bot -", ...args),
  warn: (...args) => console.warn(new Date().toISOString(), "WARN", "discord-bot -", ...args),
  error: (...args) => console.error(new Date().toISOString(), "ERROR", "discord-bot -", ...args),
};

const stateStore = createSqliteStateStore({
  dbPath: SQLITE_DB_PATH,
  logger,
});

const SPOTIFY_URL_RE = /^https?:\/\/open\.spotify\.com\/(track|album|playlist)\/([A-Za-z0-9]+)/i;
const SPOTIFY_TITLE_RE = /<meta property="og:title" content="([^"]+)"/i;
const SPOTIFY_DESC_RE = /<meta property="og:description" content="([^"]+)"/i;
const SPOTIFY_INITIAL_STATE_RE = /<script id="initialState" type="text\/plain">(.*?)<\/script>/is;
const SPOTIFY_OAUTH_SCOPES = "playlist-read-private playlist-read-collaborative";
const SPOTIFY_PARTNER_PLAYLIST_QUERY_NAME = "queryPlaylist";
const SPOTIFY_PARTNER_PLAYLIST_QUERY_HASH = "908a5597b4d0af0489a9ad6a2d41bc3b416ff47c0884016d92bbd6822d0eb6d8";
const RECORDINGS_TTL_MS = RECORDINGS_TTL_DAYS * 24 * 60 * 60 * 1000;
const RECENT_RECORDINGS_MS = RECENT_RECORDINGS_DAYS * 24 * 60 * 60 * 1000;
const LOCAL_YTDLP_PATH = path.join(BOT_DIR, ".venv", "Scripts", "yt-dlp.exe");
const INSTANCE_LOCK_PATH = path.join(BOT_DIR, ".bot.lock");
const RECORDING_METADATA_FILE = "session.json";
const WEB_SESSION_COOKIE_NAME = "recfile_session";
const OAUTH_STATE_COOKIE_NAME = "recfile_oauth";
const SPOTIFY_OAUTH_STATE_COOKIE_NAME = "spotify_oauth";
const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUDIO_FILE_EXTENSIONS = new Set([".wav", ".flac", ".ogg", ".opus", ".mp3", ".m4a", ".aac"]);
const ARCHIVE_AUDIO_EXTENSION = ".ogg";
const ARCHIVE_AUDIO_BITRATE = env("ARCHIVE_AUDIO_BITRATE", "48k");
const RECORDING_OUTPUT_FORMAT = ["wav", "flac"].includes(env("RECORDING_OUTPUT_FORMAT", "flac")?.toLowerCase())
  ? env("RECORDING_OUTPUT_FORMAT", "flac").toLowerCase()
  : "flac";
const RECORDING_RESUBSCRIBE_DELAY_MS = Math.max(
  100,
  Number.parseInt(env("RECORDING_RESUBSCRIBE_DELAY_MS", "350"), 10),
);
const PCM_SAMPLE_RATE = 48000;
const PCM_CHANNELS = 2;
const PCM_BITS_PER_SAMPLE = 16;
const PCM_BYTES_PER_SAMPLE = PCM_BITS_PER_SAMPLE / 8;
const PCM_BLOCK_ALIGN = PCM_CHANNELS * PCM_BYTES_PER_SAMPLE;
const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * PCM_BLOCK_ALIGN;
const GLOBAL_IDLE_COMMAND_COOLDOWN_MS = GLOBAL_IDLE_COMMAND_COOLDOWN_SECONDS * 1000;
const SECURITY_UPDATE_DRAIN_MS = SECURITY_UPDATE_DRAIN_SECONDS * 1000;
const SUPERVISOR_PREPARE_TIMEOUT_MS = SUPERVISOR_PREPARE_TIMEOUT_SECONDS * 1000;
const LOOPBACK_REMOTE_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const SUPERVISOR_CONTRACT_VERSION = 1;
const RUNTIME_VERSION = getRuntimeVersion();

let spotifyTokenCache = null;
let spotifyUserTokenCache = null;
let downloadBaseUrl = DOWNLOAD_BASE_URL;
let downloadServer = null;
let presenceCycleIndex = 0;
let soundCloudReady = false;
let playbackPersistTimer = null;
let playbackPersistPromise = null;

const guildStates = new Map();
const completedRecordings = new Map();
const latestRecordingByGuild = new Map();
const meaningfulPlayerActions = new Set(["pause_resume", "previous", "skip", "stop", "shuffle"]);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const otaRuntime = createOtaRuntime({
  logger,
  runtimeVersion: RUNTIME_VERSION,
  formatRuntimeVersion,
  updateStatePath: UPDATE_STATE_PATH,
  updateManifestPath: UPDATE_MANIFEST_PATH,
  globalIdleCommandCooldownMs: GLOBAL_IDLE_COMMAND_COOLDOWN_MS,
  globalIdleCommandCooldownSeconds: GLOBAL_IDLE_COMMAND_COOLDOWN_SECONDS,
  securityUpdateDrainMs: SECURITY_UPDATE_DRAIN_MS,
  supervisorPrepareTimeoutMs: SUPERVISOR_PREPARE_TIMEOUT_MS,
  supervisorPrepareTimeoutSeconds: SUPERVISOR_PREPARE_TIMEOUT_SECONDS,
  supervisorToken: SUPERVISOR_TOKEN,
  supervisorContractVersion: SUPERVISOR_CONTRACT_VERSION,
  loopbackRemoteAddresses: LOOPBACK_REMOTE_ADDRESSES,
  formatDateTime,
  getGuildStates: () => guildStates.values(),
  getUptimeSeconds: () => Math.floor(process.uptime()),
  savePlaybackSnapshot,
  finalizeActiveUpdateWork,
});

const radioRuntime = createRadioRuntime({
  logger,
  defaultMinBufferTracks: RADIO_MIN_BUFFER_TRACKS,
  recentTracksLimit: RADIO_RECENT_TRACKS_LIMIT,
  fetchCandidates: fetchRadioCandidates,
  persistState: async (radioState) => {
    stateStore.upsertRadioState(radioState);
  },
  clearPersistedState: (guildId) => {
    stateStore.clearRadioState(guildId);
  },
  loadPersistedStates: () => stateStore.listActiveRadioStates(),
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
process.on("exit", () => {
  releaseInstanceLock();
});

function getGuildState(guildId) {
  let state = guildStates.get(guildId);
  if (!state) {
    state = new GuildState(guildId);
    guildStates.set(guildId, state);
  }
  return state;
}

function trackFromSnapshot(track) {
  if (!track || typeof track !== "object") {
    return null;
  }

  return createTrack({
    title: track.title,
    webpageUrl: track.webpageUrl,
    duration: track.duration,
    thumbnail: track.thumbnail,
    requestedBy: track.requestedBy,
    streamUrl: track.streamUrl,
    searchQuery: track.searchQuery,
    resumeOffsetMs: track.resumeOffsetMs,
  });
}

function buildPlaybackSnapshots() {
  return [...guildStates.values()]
    .map((state) => state.toPlaybackSnapshot())
    .filter(Boolean)
    .map((snapshot) => ({
      ...snapshot,
      savedAt: new Date().toISOString(),
    }));
}

async function writeLegacyPlaybackSnapshot(guilds) {
  if (guilds.length === 0) {
    await fsp.rm(PLAYBACK_STATE_PATH, { force: true }).catch(() => {});
    return;
  }

  const payload = {
    version: 1,
    savedAt: new Date().toISOString(),
    guilds,
  };
  await fsp.writeFile(PLAYBACK_STATE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function persistPlaybackSnapshots({ writeLegacy = false } = {}) {
  const guilds = buildPlaybackSnapshots();
  stateStore.replacePlaybackSnapshots(guilds);
  if (writeLegacy) {
    await writeLegacyPlaybackSnapshot(guilds);
  } else if (guilds.length === 0) {
    await fsp.rm(PLAYBACK_STATE_PATH, { force: true }).catch(() => {});
  }
}

function schedulePlaybackSnapshotPersist() {
  if (shuttingDown) {
    return;
  }

  if (playbackPersistTimer) {
    clearTimeout(playbackPersistTimer);
  }

  playbackPersistTimer = setTimeout(() => {
    playbackPersistTimer = null;
    playbackPersistPromise = persistPlaybackSnapshots().catch((error) => {
      logger.warn(`Failed to persist playback state: ${error.message}`);
    });
  }, 500);
}

async function flushPendingPlaybackSnapshotPersist() {
  if (playbackPersistTimer) {
    clearTimeout(playbackPersistTimer);
    playbackPersistTimer = null;
    playbackPersistPromise = persistPlaybackSnapshots().catch((error) => {
      logger.warn(`Failed to persist playback state: ${error.message}`);
    });
  }

  await playbackPersistPromise;
}

async function savePlaybackSnapshot() {
  await flushPendingPlaybackSnapshotPersist();
  await persistPlaybackSnapshots({ writeLegacy: true });
}

async function readLegacyPlaybackSnapshot() {
  return fsp
    .readFile(PLAYBACK_STATE_PATH, "utf8")
    .then((content) => JSON.parse(content))
    .catch(() => null);
}

async function restorePlaybackSnapshot() {
  let payload = {
    guilds: stateStore.loadPlaybackSnapshots(),
  };

  if (!Array.isArray(payload.guilds) || payload.guilds.length === 0) {
    payload = await readLegacyPlaybackSnapshot();
  }

  if (!payload || !Array.isArray(payload.guilds) || payload.guilds.length === 0) {
    return;
  }

  stateStore.clearPlaybackSnapshots();
  await fsp.rm(PLAYBACK_STATE_PATH, { force: true }).catch(() => {});

  for (const guildSnapshot of payload.guilds) {
    const guild = client.guilds.cache.get(guildSnapshot.guildId);
    if (!guild) {
      continue;
    }

    const channel = guild.channels.cache.get(guildSnapshot.channelId)
      || (await guild.channels.fetch(guildSnapshot.channelId).catch(() => null));
    if (!channel?.isVoiceBased?.()) {
      continue;
    }

    const state = getGuildState(guild.id);
    state.controllerChannelId = guildSnapshot.controllerChannelId || state.controllerChannelId;
    state.panelQueueVisible = Boolean(guildSnapshot.panelQueueVisible);
    state.history = Array.isArray(guildSnapshot.history)
      ? guildSnapshot.history.map(trackFromSnapshot).filter(Boolean)
      : [];

    const restoredQueue = [];
    const restoredCurrent = trackFromSnapshot(guildSnapshot.current);
    if (restoredCurrent) {
      restoredQueue.push(restoredCurrent);
    }
    if (Array.isArray(guildSnapshot.queue)) {
      restoredQueue.push(...guildSnapshot.queue.map(trackFromSnapshot).filter(Boolean));
    }
    if (restoredQueue.length === 0) {
      continue;
    }

    state.queue = restoredQueue;
    state.current = null;
    state.currentOffsetMs = 0;
    state.playbackStartedAtMs = null;

    try {
      await state.ensureConnectionToChannel(channel);
      await state.playNext();
      if (guildSnapshot.paused) {
        await state.pause();
      }
      logger.info(
        `Restored playback state in guild ${guild.id} with ${restoredQueue.length} track(s) from pre-restart snapshot.`,
      );
    } catch (error) {
      logger.warn(`Failed to restore playback state in guild ${guild.id}: ${error.message}`);
      state.queue = [];
      state.current = null;
      state.currentOffsetMs = 0;
      state.playbackStartedAtMs = null;
    }
  }
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

function trimRecordingIndicator(text) {
  return String(text || "").startsWith(RECORDING_NICKNAME_INDICATOR)
    ? String(text).slice(RECORDING_NICKNAME_INDICATOR.length)
    : String(text || "");
}

function buildRecordingNickname(baseName) {
  const base = trimRecordingIndicator(baseName).trim();
  const source = base || client.user?.username || "Recorder";
  const maxBaseLength = Math.max(1, 32 - RECORDING_NICKNAME_INDICATOR.length);
  return `${RECORDING_NICKNAME_INDICATOR}${source.slice(0, maxBaseLength)}`;
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

function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return date.toISOString().replace("T", " ").replace(".000Z", " UTC");
}

async function finalizeActiveUpdateWork() {
  let finalizedRecordings = 0;
  for (const state of guildStates.values()) {
    if (!state.recording) {
      continue;
    }

    const session = state.recording;
    state.recording = null;
    await finalizeRecording(session, state.guild).catch((error) => {
      logger.warn(`Failed to finalize recording during update apply prep in guild ${state.guildId}: ${error.message}`);
    });
    await state.updateReceiveMode(false).catch(() => {});
    await refreshRecordingNickname(state.guildId).catch(() => {});
    await state.refreshState().catch(() => {});
    finalizedRecordings += 1;
  }

  return { finalizedRecordings };
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function parseParticipantIdsFromFileNames(fileNames) {
  const ids = new Set();
  for (const fileName of fileNames) {
    const match = String(fileName).match(/_(\d{15,22})\.(?:wav|flac|ogg|opus|mp3|m4a|aac)$/i);
    if (match) {
      ids.add(match[1]);
    }
  }
  return [...ids].sort();
}

function normalizeDiscordUserIds(values) {
  const items = Array.isArray(values) ? values : values === undefined || values === null ? [] : [values];
  return [...new Set(items.map((value) => String(value || "").trim()).filter((value) => /^\d{15,22}$/.test(value)))].sort();
}

function mergeDiscordUserIds(existing, values) {
  const current = Array.isArray(existing) ? existing : [];
  const next = Array.isArray(values) ? values : values === undefined || values === null ? [] : [values];
  return normalizeDiscordUserIds([...current, ...next]);
}

function normalizeAudioFileNames(fileNames) {
  const items = Array.isArray(fileNames) ? fileNames : [];
  return [...new Set(
    items
      .map((value) => String(value || "").trim())
      .filter((value) => value && path.basename(value) === value && AUDIO_FILE_EXTENSIONS.has(path.extname(value).toLowerCase())),
  )].sort();
}

function listVoiceChannelMemberIds(guild, channelId) {
  const channel = channelId ? guild?.channels?.cache?.get(channelId) : null;
  if (!channel?.members) {
    return [];
  }

  return [...channel.members.values()]
    .filter((member) => !member.user?.bot)
    .map((member) => member.id);
}

function getSessionReferenceTime(session) {
  return session.completedAt || session.startedAt;
}

function isRecentRecordingSession(session, now = Date.now()) {
  return now - getSessionReferenceTime(session).getTime() < RECENT_RECORDINGS_MS;
}

function hasDiscordWebAuth() {
  return Boolean(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET && DISCORD_REDIRECT_URI && WEB_SESSION_SECRET);
}

function spotifyRedirectUri() {
  return SPOTIFY_REDIRECT_URI || `${downloadBaseUrl.replace(/\/$/, "")}/auth/spotify/callback`;
}

function hasSpotifyWebAuth() {
  return Boolean(
    SPOTIFY_CLIENT_ID
      && SPOTIFY_CLIENT_SECRET
      && spotifyRedirectUri()
      && WEB_SESSION_SECRET
      && SPOTIFY_OAUTH_SETUP_SECRET,
  );
}

function parseCookieHeader(header) {
  const cookies = {};
  for (const entry of String(header || "").split(";")) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const name = entry.slice(0, separatorIndex).trim();
    const value = entry.slice(separatorIndex + 1).trim();
    if (!name) {
      continue;
    }
    cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function hmacSignature(payload) {
  return crypto.createHmac("sha256", WEB_SESSION_SECRET).update(payload).digest("base64url");
}

function encodeSignedPayload(payload) {
  const encoded = base64UrlJson(payload);
  return `${encoded}.${hmacSignature(encoded)}`;
}

function decodeSignedPayload(value) {
  if (!WEB_SESSION_SECRET || typeof value !== "string") {
    return null;
  }
  const separatorIndex = value.lastIndexOf(".");
  if (separatorIndex <= 0) {
    return null;
  }

  const encoded = value.slice(0, separatorIndex);
  const providedSignature = value.slice(separatorIndex + 1);
  const expectedSignature = hmacSignature(encoded);
  const providedBuffer = Buffer.from(providedSignature, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (payload?.exp && Date.now() > payload.exp) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function isSecureCookieRequest() {
  return downloadBaseUrl.startsWith("https://");
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || "/"}`);
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  } else {
    parts.push(isSecureCookieRequest() ? "SameSite=None" : "SameSite=Lax");
  }
  if (options.secure ?? isSecureCookieRequest()) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function setCookie(res, name, value, options = {}) {
  const serialized = serializeCookie(name, value, options);
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", serialized);
    return;
  }

  if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, serialized]);
    return;
  }

  res.setHeader("Set-Cookie", [existing, serialized]);
}

function clearCookie(res, name) {
  setCookie(res, name, "", { maxAge: 0 });
}

function getAuthenticatedRecordingUser(req) {
  const cookies = parseCookieHeader(req.headers.cookie);
  return decodeSignedPayload(cookies[WEB_SESSION_COOKIE_NAME]);
}

function sanitizeReturnPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/recordings/";
  }
  return value;
}

function timingSafeSecretEquals(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function spotifySetupSecretFromRequest(req) {
  if (typeof req.query.setup === "string" && req.query.setup.length > 0) {
    return req.query.setup;
  }
  const headerValue = req.headers["x-setup-secret"];
  return typeof headerValue === "string" && headerValue.length > 0 ? headerValue : "";
}

function currentSpotifyRefreshToken() {
  if (SPOTIFY_REFRESH_TOKEN) {
    return SPOTIFY_REFRESH_TOKEN;
  }

  try {
    const value = fs.readFileSync(SPOTIFY_REFRESH_TOKEN_PATH, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

async function saveSpotifyRefreshToken(refreshToken) {
  const token = String(refreshToken || "").trim();
  if (!token) {
    throw new Error("Spotify OAuth did not return a refresh token.");
  }

  await fsp.mkdir(path.dirname(SPOTIFY_REFRESH_TOKEN_PATH), { recursive: true });
  await fsp.writeFile(SPOTIFY_REFRESH_TOKEN_PATH, `${token}\n`, { mode: 0o600 });
  spotifyUserTokenCache = null;
}

function renderSpotifyAuthResultPage({ title, message, details = null }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: system-ui, sans-serif; background: #101419; color: #f5f7fa; }
    main { max-width: 720px; margin: 10vh auto; padding: 32px 24px; }
    .card { background: #18212b; border: 1px solid #2c3948; border-radius: 16px; padding: 24px; box-shadow: 0 18px 50px rgba(0,0,0,0.35); }
    h1 { margin-top: 0; font-size: 1.8rem; }
    p, li { line-height: 1.55; color: #d6dee8; }
    code { background: #0f1720; padding: 0.15em 0.35em; border-radius: 6px; }
    pre { background: #0f1720; padding: 14px; border-radius: 10px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
    a { color: #8ad7ff; }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      ${details ? `<pre>${escapeHtml(details)}</pre>` : ""}
      <p><a href="/recordings/help/">Back to recordings help</a></p>
    </section>
  </main>
</body>
</html>`;
}

function discordAvatarUrl(user) {
  if (!user?.id || !user?.avatar) {
    return null;
  }
  const extension = user.avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${extension}?size=128`;
}

async function getSessionParticipantIds(session) {
  if (Array.isArray(session.authorizedUserIds) && session.authorizedUserIds.length > 0) {
    return session.authorizedUserIds;
  }
  if (Array.isArray(session.participantIds) && session.participantIds.length > 0) {
    return session.participantIds;
  }
  if (Array.isArray(session.speakerUserIds) && session.speakerUserIds.length > 0) {
    session.participantIds = session.speakerUserIds;
    return session.participantIds;
  }
  const audioFiles = await getSessionDownloadableAudioFiles(session);
  const speakerUserIds = parseParticipantIdsFromFileNames(audioFiles);
  session.speakerUserIds = speakerUserIds;
  const participantIds = speakerUserIds;
  session.participantIds = participantIds;
  return participantIds;
}

async function getSessionDownloadableAudioFiles(session) {
  const manifestFiles = normalizeAudioFileNames(session.files);
  if (manifestFiles.length > 0) {
    return manifestFiles;
  }

  const audioFiles = await session.audioFiles();
  session.files = normalizeAudioFileNames(audioFiles);
  return session.files;
}

async function requireRecordingAccess(req, res, session) {
  if (!hasDiscordWebAuth()) {
    return true;
  }

  const viewer = getAuthenticatedRecordingUser(req);
  if (!viewer?.id) {
    res.redirect(`/auth/discord/login?next=${encodeURIComponent(req.originalUrl || "/recordings/")}`);
    return false;
  }

  const participantIds = await getSessionParticipantIds(session);
  if (!participantIds.includes(viewer.id)) {
    res.status(403).type("html").send(renderRecordingAccessDeniedPage());
    return false;
  }

  return true;
}

function createTrack({
  title,
  webpageUrl,
  duration,
  thumbnail,
  requestedBy,
  streamUrl = null,
  searchQuery = null,
  resumeOffsetMs = 0,
}) {
  return {
    title: title || "Unknown title",
    webpageUrl,
    duration: Number.isFinite(duration) ? duration : null,
    thumbnail: thumbnail || null,
    requestedBy: requestedBy || "unknown",
    streamUrl: streamUrl || null,
    searchQuery: searchQuery || null,
    resumeOffsetMs: Number.isFinite(resumeOffsetMs) ? Math.max(0, Math.floor(resumeOffsetMs)) : 0,
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

  writeSilence(byteCount) {
    if (this.closed || !Number.isFinite(byteCount) || byteCount <= 0) {
      return;
    }

    const remainingTarget = Math.floor(byteCount / PCM_BLOCK_ALIGN) * PCM_BLOCK_ALIGN;
    if (remainingTarget <= 0) {
      return;
    }

    const silenceChunk = Buffer.alloc(Math.min(PCM_BYTES_PER_SECOND, remainingTarget));
    let remaining = remainingTarget;
    while (remaining > 0) {
      const chunk = remaining >= silenceChunk.length ? silenceChunk : Buffer.alloc(remaining);
      this.write(chunk);
      remaining -= chunk.length;
    }
  }

  padToBytePosition(targetBytes) {
    const alignedTarget = Math.floor(Math.max(0, targetBytes) / PCM_BLOCK_ALIGN) * PCM_BLOCK_ALIGN;
    if (alignedTarget <= this.dataBytes) {
      return;
    }
    this.writeSilence(alignedTarget - this.dataBytes);
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
  header.writeUInt16LE(PCM_CHANNELS, 22);
  header.writeUInt32LE(PCM_SAMPLE_RATE, 24);
  header.writeUInt32LE(PCM_BYTES_PER_SECOND, 28);
  header.writeUInt16LE(PCM_BLOCK_ALIGN, 32);
  header.writeUInt16LE(PCM_BITS_PER_SAMPLE, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

class RecordingSession {
  constructor(guildId, channelId) {
    this.guildId = guildId;
    this.channelId = channelId;
    this.guildName = null;
    this.channelName = null;
    this.startedAt = new Date();
    this.completedAt = null;
    this.token = crypto.randomBytes(16).toString("base64url");
    this.directory = path.join(RECORDINGS_DIR, `${guildId}-${Date.now()}-${this.token}`);
    this.archivePath = null;
    this.archived = false;
    this.participantIds = null;
    this.authorizedUserIds = [];
    this.speakerUserIds = [];
    this.files = [];
    this.receiver = null;
    this.connection = null;
    this.speakingListener = null;
    this.startedHrTime = process.hrtime.bigint();
    this.userStreams = new Map();
    this.fileWriters = new Map();
    this.resubscribeTimers = new Map();
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
    return new Date(reference.getTime() + RECORDINGS_TTL_MS);
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
    this.subscribePresentMembers(guild);
  }

  captureAttendanceSnapshot(guild) {
    const memberIds = listVoiceChannelMemberIds(guild, this.channelId);
    if (memberIds.length === 0) {
      return [];
    }

    this.authorizedUserIds = mergeDiscordUserIds(this.authorizedUserIds, memberIds);
    this.participantIds = [...this.authorizedUserIds];
    return memberIds;
  }

  noteAuthorizedUser(userId) {
    this.authorizedUserIds = mergeDiscordUserIds(this.authorizedUserIds, userId);
    this.participantIds = [...this.authorizedUserIds];
  }

  noteSpeakerUser(userId) {
    this.speakerUserIds = mergeDiscordUserIds(this.speakerUserIds, userId);
    this.noteAuthorizedUser(userId);
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

  subscribePresentMembers(guild) {
    for (const userId of this.captureAttendanceSnapshot(guild)) {
      void this.subscribeUser(guild, userId).catch((error) => {
        logger.warn(`Recording subscribe error for user ${userId} in guild ${guild.id}: ${error.message}`);
      });
    }
  }

  timelineBytePosition(reference = process.hrtime.bigint()) {
    const elapsedNs = Number(reference - this.startedHrTime);
    const samples = Math.max(0, Math.round((elapsedNs * PCM_SAMPLE_RATE) / 1_000_000_000));
    return samples * PCM_BLOCK_ALIGN;
  }

  async subscribeUser(guild, userId) {
    if (!this.receiver || this.userStreams.has(userId)) {
      return;
    }

    const existingTimer = this.resubscribeTimers.get(userId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.resubscribeTimers.delete(userId);
    }

    const opusStream = this.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.Manual,
      },
    });
    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });

    const destroyEntry = ({ resubscribe = false } = {}) => {
      const entry = this.userStreams.get(userId);
      if (!entry) {
        return;
      }

      entry.opusStream.removeAllListeners();
      entry.decoder.removeAllListeners();
      entry.opusStream.destroy();
      entry.decoder.destroy();
      this.userStreams.delete(userId);

      if (resubscribe && this.receiver) {
        const timer = setTimeout(() => {
          this.resubscribeTimers.delete(userId);
          void this.subscribeUser(guild, userId).catch((error) => {
            logger.warn(`Recording resubscribe error for user ${userId} in guild ${guild.id}: ${error.message}`);
          });
        }, RECORDING_RESUBSCRIBE_DELAY_MS);
        this.resubscribeTimers.set(userId, timer);
      }
    };

    opusStream.on("error", (error) => {
      logger.warn(`Recording stream error for user ${userId} in guild ${guild.id}: ${error.message}`);
      destroyEntry({ resubscribe: true });
    });
    decoder.on("error", (error) => {
      logger.warn(`Recording decoder error for user ${userId} in guild ${guild.id}: ${error.message}`);
      destroyEntry({ resubscribe: true });
    });
    decoder.on("data", (chunk) => {
      const entry = this.userStreams.get(userId);
      if (!entry) {
        return;
      }
      const chunkLength = Math.floor(chunk.length / PCM_BLOCK_ALIGN) * PCM_BLOCK_ALIGN;
      if (chunkLength <= 0) {
        return;
      }
      this.noteSpeakerUser(userId);
      const writer = entry.writer || this.getWriter(guild, userId);
      entry.writer = writer;
      entry.receivedPcmBytes += chunkLength;
      const targetEnd = this.timelineBytePosition();
      const targetStart = Math.max(writer.dataBytes, targetEnd - chunkLength);
      writer.padToBytePosition(targetStart);
      writer.write(chunkLength === chunk.length ? chunk : chunk.subarray(0, chunkLength));
    });
    opusStream.once("end", () => destroyEntry());
    opusStream.once("close", () => destroyEntry());
    opusStream.pipe(decoder);
    this.userStreams.set(userId, { opusStream, decoder, writer: null, receivedPcmBytes: 0 });
  }

  async stop(guild = null) {
    if (guild) {
      this.captureAttendanceSnapshot(guild);
    }
    if (this.receiver && this.speakingListener) {
      this.receiver.speaking.off("start", this.speakingListener);
    }

    for (const { opusStream, decoder } of this.userStreams.values()) {
      opusStream.unpipe(decoder);
      opusStream.destroy();
      decoder.destroy();
    }
    this.userStreams.clear();

    for (const timer of this.resubscribeTimers.values()) {
      clearTimeout(timer);
    }
    this.resubscribeTimers.clear();

    const sessionEndBytes = this.timelineBytePosition();
    for (const writer of this.fileWriters.values()) {
      writer.padToBytePosition(sessionEndBytes);
      await writer.close();
    }

    this.completedAt = new Date();
    await this.optimizeRecentAudioIfNeeded();
    this.archived = false;
    const audioFiles = await this.audioFiles();
    if (audioFiles.length > 0) {
      this.archivePath = path.join(this.directory, "session.zip");
      await createZipArchive(this.directory, this.archivePath, audioFiles);
    }
    await this.writeMetadata();
    await syncRecordingSessionIndex(this);
  }

  async audioFiles({ extensions = null } = {}) {
    const entries = await fsp.readdir(this.directory, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => {
        if (!entry.isFile()) {
          return false;
        }
        const extension = path.extname(entry.name).toLowerCase();
        if (extensions) {
          return extensions.includes(extension);
        }
        return AUDIO_FILE_EXTENSIONS.has(extension);
      })
      .map((entry) => entry.name)
      .sort();
  }

  async wavFiles() {
    return this.audioFiles({ extensions: [".wav"] });
  }

  async optimizeRecentAudioIfNeeded() {
    if (RECORDING_OUTPUT_FORMAT === "wav") {
      return;
    }

    const wavFiles = await this.wavFiles();
    if (wavFiles.length === 0) {
      return;
    }

    const optimizedFiles = [];
    try {
      for (const wavFile of wavFiles) {
        const inputPath = path.join(this.directory, wavFile);
        const outputName = `${path.basename(wavFile, path.extname(wavFile))}.${RECORDING_OUTPUT_FORMAT}`;
        const outputPath = path.join(this.directory, outputName);
        await transcodeAudioFile(inputPath, outputPath, RECORDING_OUTPUT_FORMAT);
        optimizedFiles.push({ inputPath, outputPath });
      }

      for (const { inputPath } of optimizedFiles) {
        await fsp.rm(inputPath, { force: true }).catch(() => {});
      }
    } catch (error) {
      logger.warn(`Failed to optimize recent recording session ${this.token}: ${error.stderr?.trim() || error.message}`);
      for (const { outputPath } of optimizedFiles) {
        await fsp.rm(outputPath, { force: true }).catch(() => {});
      }
    }
  }

  metadataPath() {
    return path.join(this.directory, RECORDING_METADATA_FILE);
  }

  async writeMetadata() {
    const audioFiles = await this.audioFiles();
    const normalizedFiles = normalizeAudioFileNames(audioFiles);
    const speakerUserIds = normalizeDiscordUserIds(
      this.speakerUserIds.length > 0 ? this.speakerUserIds : parseParticipantIdsFromFileNames(normalizedFiles),
    );
    const authorizedUserIds = normalizeDiscordUserIds(
      this.authorizedUserIds.length > 0 ? this.authorizedUserIds : this.participantIds,
    );
    const participantIds = authorizedUserIds.length > 0 ? [...authorizedUserIds] : [...speakerUserIds];
    this.files = normalizedFiles;
    this.speakerUserIds = speakerUserIds;
    this.authorizedUserIds = authorizedUserIds;
    this.participantIds = participantIds;
    const payload = {
      version: 2,
      token: this.token,
      guildId: this.guildId,
      guildName: this.guildName || null,
      channelId: this.channelId || null,
      channelName: this.channelName || null,
      startedAt: this.startedAt.toISOString(),
      completedAt: this.completedAt ? this.completedAt.toISOString() : null,
      participantIds,
      authorizedUserIds,
      speakerUserIds,
      files: normalizedFiles,
      recentWindowDays: RECENT_RECORDINGS_DAYS,
      archived: Boolean(this.archived),
      archiveName: this.archivePath ? path.basename(this.archivePath) : null,
    };
    await fsp.writeFile(this.metadataPath(), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}

async function restoreRecordingSessionFromDirectory(directoryPath) {
  const directoryName = path.basename(directoryPath);
  const match = directoryName.match(/^(\d+)-(\d+)-([A-Za-z0-9_-]+)$/);
  if (!match) {
    return null;
  }

  const [, guildId, startedMs, token] = match;
  const startedAt = new Date(Number.parseInt(startedMs, 10));
  const archivePath = path.join(directoryPath, "session.zip");
  const archiveStat = await fsp.stat(archivePath).catch(() => null);
  const directoryStat = await fsp.stat(directoryPath).catch(() => null);
  const metadata = await fsp
    .readFile(path.join(directoryPath, RECORDING_METADATA_FILE), "utf8")
    .then((content) => JSON.parse(content))
    .catch(() => null);

  const session = Object.create(RecordingSession.prototype);
  session.guildId = guildId;
  session.channelId = metadata?.channelId || null;
  session.guildName = metadata?.guildName || null;
  session.channelName = metadata?.channelName || null;
  session.startedAt = metadata?.startedAt ? new Date(metadata.startedAt) : startedAt;
  session.completedAt = metadata?.completedAt
    ? new Date(metadata.completedAt)
    : archiveStat?.mtime || directoryStat?.mtime || startedAt;
  session.token = token;
  session.directory = directoryPath;
  session.archivePath = archiveStat ? archivePath : null;
  session.archived = Boolean(metadata?.archived);
  session.participantIds = normalizeDiscordUserIds(metadata?.participantIds);
  session.authorizedUserIds = normalizeDiscordUserIds(metadata?.authorizedUserIds);
  session.speakerUserIds = normalizeDiscordUserIds(metadata?.speakerUserIds);
  session.files = normalizeAudioFileNames(metadata?.files);
  session.receiver = null;
  session.connection = null;
  session.speakingListener = null;
  session.startedHrTime = process.hrtime.bigint();
  session.userStreams = new Map();
  session.fileWriters = new Map();
  session.resubscribeTimers = new Map();
  return session;
}

function restoreRecordingSessionFromIndexRecord(record) {
  if (!record?.token || !record.directoryPath) {
    return null;
  }

  const session = Object.create(RecordingSession.prototype);
  session.guildId = record.guildId;
  session.channelId = record.channelId || null;
  session.guildName = record.guildName || null;
  session.channelName = record.channelName || null;
  session.startedAt = record.startedAt ? new Date(record.startedAt) : new Date();
  session.completedAt = record.completedAt ? new Date(record.completedAt) : null;
  session.token = record.token;
  session.directory = record.directoryPath;
  session.archivePath = record.archivePath || null;
  session.archived = Boolean(record.archived);
  session.participantIds = normalizeDiscordUserIds(record.participantIds);
  session.authorizedUserIds = normalizeDiscordUserIds(record.authorizedUserIds);
  session.speakerUserIds = normalizeDiscordUserIds(record.speakerUserIds);
  session.files = normalizeAudioFileNames(record.files);
  session.fileEntries = Array.isArray(record.fileEntries)
    ? record.fileEntries.map((fileEntry) => ({
        fileName: String(fileEntry.fileName),
        fileSizeBytes: Number.isFinite(fileEntry.fileSizeBytes) ? fileEntry.fileSizeBytes : 0,
        modifiedAt: fileEntry.modifiedAt || null,
      }))
    : [];
  session.receiver = null;
  session.connection = null;
  session.speakingListener = null;
  session.startedHrTime = process.hrtime.bigint();
  session.userStreams = new Map();
  session.fileWriters = new Map();
  session.resubscribeTimers = new Map();
  return session;
}

async function collectRecordingFileEntries(session, fileNames = null) {
  const names = normalizeAudioFileNames(fileNames || (await getSessionDownloadableAudioFiles(session)));
  return Promise.all(
    names.map(async (fileName) => {
      const stat = await fsp.stat(path.join(session.directory, fileName)).catch(() => null);
      return {
        fileName,
        fileSizeBytes: stat?.size || 0,
        modifiedAt: stat?.mtime ? stat.mtime.toISOString() : null,
      };
    }),
  );
}

async function buildRecordingIndexRecord(session) {
  const files = await getSessionDownloadableAudioFiles(session);
  const participantIds = await getSessionParticipantIds(session);
  return {
    token: session.token,
    directoryPath: session.directory,
    guildId: session.guildId,
    guildName: session.guildName || null,
    channelId: session.channelId || null,
    channelName: session.channelName || null,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    participantIds,
    authorizedUserIds: normalizeDiscordUserIds(session.authorizedUserIds),
    speakerUserIds: normalizeDiscordUserIds(session.speakerUserIds),
    files,
    archived: Boolean(session.archived),
    archiveName: session.archivePath ? path.basename(session.archivePath) : null,
    archivePath: session.archivePath || null,
    retentionDays: RECORDINGS_TTL_DAYS,
    expiresAt: session.expiresAt(),
    sourceVersion: 2,
    fileEntries: await collectRecordingFileEntries(session, files),
    updatedAt: new Date(),
  };
}

async function syncRecordingSessionIndex(session) {
  stateStore.upsertRecordingSession(await buildRecordingIndexRecord(session));
}

async function rebuildRecordingIndexFromDisk({ logSummary = false } = {}) {
  const entries = await fsp.readdir(RECORDINGS_DIR, { withFileTypes: true }).catch(() => []);
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const session = await restoreRecordingSessionFromDirectory(path.join(RECORDINGS_DIR, entry.name));
    if (!session) {
      continue;
    }
    sessions.push(session);
  }

  const records = [];
  for (const session of sessions) {
    records.push(await buildRecordingIndexRecord(session));
  }

  stateStore.replaceRecordingSessions(records);
  if (logSummary) {
    logger.info(`Indexed ${records.length} recording session(s) into SQLite.`);
  }
  return sessions;
}

async function loadStoredCompletedSessions() {
  return stateStore.listRecordingSessions().map(restoreRecordingSessionFromIndexRecord).filter(Boolean);
}

async function resolveRecordingSession(token) {
  const active = [...guildStates.values()].map((state) => state.recording).find((item) => item?.token === token);
  if (active) {
    return active;
  }

  const inMemory = completedRecordings.get(token);
  if (inMemory) {
    return inMemory;
  }

  let stored = restoreRecordingSessionFromIndexRecord(stateStore.getRecordingSession(token));
  if (!stored) {
    await rebuildRecordingIndexFromDisk();
    stored = restoreRecordingSessionFromIndexRecord(stateStore.getRecordingSession(token));
  }
  if (stored) {
    completedRecordings.set(stored.token, stored);
    return stored;
  }

  return null;
}

async function listRecordingSessions() {
  const storedSessions = await loadStoredCompletedSessions();
  const merged = new Map();

  for (const session of storedSessions) {
    merged.set(session.token, session);
  }
  for (const session of completedRecordings.values()) {
    merged.set(session.token, session);
  }
  for (const session of [...guildStates.values()].map((state) => state.recording).filter(Boolean)) {
    merged.set(session.token, session);
  }

  return [...merged.values()].sort((left, right) => {
    const leftTime = (left.completedAt || left.startedAt).getTime();
    const rightTime = (right.completedAt || right.startedAt).getTime();
    return rightTime - leftTime;
  });
}

async function findLatestCompletedRecordingForGuild(guildId) {
  const cachedToken = latestRecordingByGuild.get(guildId);
  if (cachedToken) {
    const cached = await resolveRecordingSession(cachedToken);
    if (cached?.guildId === guildId && cached.completedAt) {
      return cached;
    }
  }

  const latest = restoreRecordingSessionFromIndexRecord(stateStore.getLatestRecordingSessionForGuild(guildId))
    || (await listRecordingSessions()).find((session) => session.guildId === guildId && session.completedAt)
    || null;
  if (latest) {
    latestRecordingByGuild.set(guildId, latest.token);
  }
  return latest;
}

async function summarizeRecordingSession(session) {
  const audioFiles = await getSessionDownloadableAudioFiles(session);
  const indexedFiles = Array.isArray(session.fileEntries)
    ? new Map(session.fileEntries.map((fileEntry) => [fileEntry.fileName, fileEntry]))
    : null;
  const audioStats = await Promise.all(
    audioFiles.map(async (name) => {
      const indexed = indexedFiles?.get(name);
      if (indexed) {
        return { name, size: indexed.fileSizeBytes || 0 };
      }
      const filePath = path.join(session.directory, name);
      const stat = await fsp.stat(filePath).catch(() => null);
      return { name, size: stat?.size || 0 };
    }),
  );
  const archiveSize = ((await fsp.stat(session.archivePath).catch(() => null))?.size || 0);
  const participantIds = await getSessionParticipantIds(session);
  session.participantIds = participantIds;
  const archived = Boolean(session.archived);

  return {
    session,
    audioFiles,
    audioStats,
    archiveSize,
    participantIds,
    totalSize: audioStats.reduce((sum, file) => sum + file.size, 0) + archiveSize,
    status: session.completedAt ? "Ready" : "Recording",
    title: session.guildName || `Guild ${session.guildId}`,
    subtitle: [
      session.channelName ? `Channel ${session.channelName}` : `Session ${session.token.slice(0, 8)}`,
      `${audioFiles.length} file${audioFiles.length === 1 ? "" : "s"}`,
    ].join(" • "),
    archived,
  };
}

function buildViewerModel(viewer) {
  if (!viewer?.id) {
    return null;
  }
  return {
    id: viewer.id,
    username: viewer.username || viewer.id,
    displayName: viewer.global_name || viewer.globalName || viewer.username || viewer.id,
    avatarUrl: discordAvatarUrl(viewer),
  };
}

async function loadRecordingSummaries() {
  return Promise.all((await listRecordingSessions()).map((session) => summarizeRecordingSession(session)));
}

function isArchivedRecordingSummary(summary, now = Date.now()) {
  return Boolean(summary.session.completedAt) && !isRecentRecordingSession(summary.session, now);
}

function buildRecordingStats(summaries, viewerId = null, now = Date.now()) {
  const total = summaries.length;
  const recent = summaries.filter((summary) => isRecentRecordingSession(summary.session, now)).length;
  const archived = summaries.filter((summary) => isArchivedRecordingSummary(summary, now)).length;
  const active = summaries.filter((summary) => !summary.session.completedAt).length;
  const mine = viewerId
    ? summaries.filter((summary) => summary.participantIds.includes(viewerId)).length
    : null;

  return { total, recent, archived, active, mine };
}

function buildRecordingRowView(summary, viewer = null) {
  const { session, audioStats, totalSize, status, title, subtitle, participantIds, archived } = summary;
  return {
    icon: session.completedAt ? "🗂" : "●",
    title,
    subtitle: `${subtitle} • ${formatBytes(totalSize)}`,
    details: `Started ${formatDateTime(session.startedAt)}${session.completedAt ? ` • Completed ${formatDateTime(session.completedAt)}` : ""}`,
    status,
    archived,
    includesViewer: Boolean(viewer?.id && participantIds.includes(viewer.id)),
    sideText: `Expires ${formatDateTime(session.expiresAt())}`,
    openHref: `/recordings/${encodeURIComponent(session.token)}/`,
    zipHref: session.archivePath ? `/recordings/${encodeURIComponent(session.token)}/session.zip` : null,
    fileChips: audioStats.slice(0, 4).map((file) => ({
      href: `/recordings/${encodeURIComponent(session.token)}/${encodeURIComponent(file.name)}`,
      label: file.name,
      sizeLabel: formatBytes(file.size),
    })),
    sortKey: String(getSessionReferenceTime(session).getTime()),
    searchLabel: `${title} ${subtitle} ${audioStats.map((file) => file.name).join(" ")}`.toLowerCase(),
  };
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

async function transcodeAudioFile(inputPath, outputPath, format) {
  const args = ["-y", "-i", inputPath, "-vn"];
  switch (format) {
    case "flac":
      args.push("-c:a", "flac");
      break;
    case "ogg":
      args.push("-c:a", "libopus", "-b:a", ARCHIVE_AUDIO_BITRATE, "-vbr", "on");
      break;
    case "wav":
      args.push("-c:a", "pcm_s16le");
      break;
    default:
      throw new Error(`Unsupported audio transcode format: ${format}`);
  }
  args.push(outputPath);
  await runFfmpeg(args);
}

async function runFfmpeg(args) {
  return await new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
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

async function archiveRecordingSessionIfNeeded(session, now = Date.now()) {
  if (!session.completedAt || session.isExpired(now) || isRecentRecordingSession(session, now) || session.archived) {
    return;
  }

  const sourceFiles = await session.audioFiles();
  if (sourceFiles.length === 0) {
    return;
  }

  logger.info(`Archiving recording session ${session.token} with ${sourceFiles.length} audio file(s).`);
  const archivedFiles = [];
  try {
    for (const sourceFile of sourceFiles) {
      const inputPath = path.join(session.directory, sourceFile);
      const outputName = `${path.basename(sourceFile, path.extname(sourceFile))}${ARCHIVE_AUDIO_EXTENSION}`;
      const outputPath = path.join(session.directory, outputName);
      await transcodeAudioFile(inputPath, outputPath, "ogg");
      archivedFiles.push(outputName);
    }

    const nextArchivePath = path.join(session.directory, "session.zip");
    await fsp.rm(nextArchivePath, { force: true }).catch(() => {});
    await createZipArchive(session.directory, nextArchivePath, archivedFiles);

    for (const sourceFile of sourceFiles) {
      await fsp.rm(path.join(session.directory, sourceFile), { force: true }).catch(() => {});
    }

    session.archivePath = nextArchivePath;
    session.archived = true;
    await session.writeMetadata();
    await syncRecordingSessionIndex(session);
  } catch (error) {
    logger.warn(`Failed to archive recording session ${session.token}: ${error.stderr?.trim() || error.message}`);
  }
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
    this.radio = null;
    this.recording = null;
    this.idleTimer = null;
    this.idleReason = null;
    this.disconnecting = false;
    this.playingNext = false;
    this.connection = null;
    this.deferPanelRefresh = false;
    this.currentOffsetMs = 0;
    this.playbackStartedAtMs = null;
    this.baseNickname = undefined;
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

    this.player.on("stateChange", (oldState, newState) => {
      if (oldState.status === AudioPlayerStatus.Playing && newState.status !== AudioPlayerStatus.Playing) {
        this.capturePlaybackOffset();
      } else if (oldState.status !== AudioPlayerStatus.Playing && newState.status === AudioPlayerStatus.Playing && this.current) {
        this.playbackStartedAtMs = Date.now();
      }
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

  currentPlaybackOffsetMs() {
    if (!this.current) {
      return 0;
    }

    let offset = this.currentOffsetMs;
    if (this.playbackStartedAtMs && this.isPlaying()) {
      offset += Math.max(0, Date.now() - this.playbackStartedAtMs);
    }

    const durationMs = Number.isFinite(this.current.duration) ? this.current.duration * 1000 : null;
    if (durationMs !== null) {
      offset = Math.min(offset, Math.max(0, durationMs));
    }
    return Math.max(0, Math.floor(offset));
  }

  capturePlaybackOffset() {
    if (!this.current) {
      this.currentOffsetMs = 0;
      this.playbackStartedAtMs = null;
      return 0;
    }

    let offset = this.currentOffsetMs;
    if (this.playbackStartedAtMs) {
      offset += Math.max(0, Date.now() - this.playbackStartedAtMs);
    }

    const durationMs = Number.isFinite(this.current.duration) ? this.current.duration * 1000 : null;
    if (durationMs !== null) {
      offset = Math.min(offset, Math.max(0, durationMs));
    }

    this.currentOffsetMs = Math.max(0, Math.floor(offset));
    this.playbackStartedAtMs = null;
    return this.currentOffsetMs;
  }

  async ensureConnectionToChannel(voiceChannel, { requireReceive = false } = {}) {
    if (!voiceChannel) {
      throw new Error("Voice channel is required.");
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

  async refreshState() {
    if (!this.deferPanelRefresh) {
      await refreshPlayerPanel(this.guildId);
    }
    schedulePlaybackSnapshotPersist();
    radioRuntime.scheduleRefill(this, "state_refresh");
    refreshPresence();
    void refreshVoiceLifecycle(this.guildId);
  }

  async ensureConnection(member, { requireReceive = false } = {}) {
    const voiceChannel = member?.voice?.channel;
    if (!voiceChannel) {
      throw new Error("You must join a voice channel first.");
    }
    return this.ensureConnectionToChannel(voiceChannel, { requireReceive });
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

  async moveQueueItem(fromPosition, toPosition) {
    if (this.queue.length === 0) {
      return { moved: false, reason: "empty_queue" };
    }

    if (!Number.isInteger(fromPosition) || !Number.isInteger(toPosition)) {
      throw new Error("Queue positions must be whole numbers.");
    }

    if (fromPosition < 1 || fromPosition > this.queue.length) {
      throw new Error(`Track ${fromPosition} is not in the queue. Use \`/queue\` to see valid positions.`);
    }

    if (toPosition < 1 || toPosition > this.queue.length) {
      throw new Error(`Target position must be between 1 and ${this.queue.length}.`);
    }

    if (fromPosition === toPosition) {
      return {
        moved: false,
        reason: "same_position",
        track: this.queue[fromPosition - 1] || null,
        fromPosition,
        toPosition,
      };
    }

    const [track] = this.queue.splice(fromPosition - 1, 1);
    this.queue.splice(toPosition - 1, 0, track);
    await this.refreshState();
    return {
      moved: true,
      track,
      fromPosition,
      toPosition,
    };
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
        this.currentOffsetMs = Number.isFinite(nextTrack.resumeOffsetMs) ? Math.max(0, nextTrack.resumeOffsetMs) : 0;
        this.playbackStartedAtMs = null;
        try {
          const { resource, stream } = await createPlaybackResource(nextTrack);
          this.currentOffsetMs = Number.isFinite(nextTrack.resumeOffsetMs) ? Math.max(0, nextTrack.resumeOffsetMs) : 0;
          this.player.play(resource);
          if (stream && typeof play.attachListeners === "function") {
            play.attachListeners(this.player, stream);
          }
          await radioRuntime.noteTrackStarted(this, nextTrack);
          break;
        } catch (error) {
          if ((nextTrack.resumeOffsetMs || 0) > 0) {
            logger.warn(
              `Failed to resume '${nextTrack.title}' in guild ${this.guildId} at ${Math.floor(nextTrack.resumeOffsetMs / 1000)}s; retrying from the start: ${error.message}`,
            );
            nextTrack.resumeOffsetMs = 0;
            this.queue.unshift(nextTrack);
            this.current = null;
            this.currentOffsetMs = 0;
            this.playbackStartedAtMs = null;
            continue;
          }
          logger.warn(`Failed to play track in guild ${this.guildId}: ${error.message}`);
          this.current = null;
          this.currentOffsetMs = 0;
          this.playbackStartedAtMs = null;
        }
      }
    } finally {
      this.playingNext = false;
      await this.refreshState();
    }
  }

  async onTrackFinished() {
    if (this.current) {
      const resumeOffsetMs = Number.isFinite(this.current.resumeOffsetMs) ? Math.max(0, this.current.resumeOffsetMs) : 0;
      const playbackOffsetMs = this.currentOffsetMs;
      const resumedForMs = Math.max(0, playbackOffsetMs - resumeOffsetMs);
      const durationMs = Number.isFinite(this.current.duration) ? this.current.duration * 1000 : null;
      const remainingMs = durationMs === null ? null : Math.max(0, durationMs - playbackOffsetMs);
      if (
        resumeOffsetMs > 0 &&
        !this.current.resumeFallbackTried &&
        resumedForMs > 0 &&
        resumedForMs < RESUME_EARLY_END_THRESHOLD_MS &&
        (remainingMs === null || remainingMs > RESUME_EARLY_END_THRESHOLD_MS)
      ) {
        logger.warn(
          `Resumed playback for '${this.current.title}' in guild ${this.guildId} ended after ${Math.floor(resumedForMs / 1000)}s; retrying from the start.`,
        );
        this.current.resumeOffsetMs = 0;
        this.current.resumeFallbackTried = true;
        this.queue.unshift(this.current);
        this.current = null;
        this.currentOffsetMs = 0;
        this.playbackStartedAtMs = null;
        await this.playNext();
        return;
      }

      this.current.resumeOffsetMs = 0;
      this.history.unshift(this.current);
      this.history = this.history.slice(0, 20);
    }
    this.current = null;
    this.currentOffsetMs = 0;
    this.playbackStartedAtMs = null;
    await this.playNext();
  }

  async pause() {
    const paused = this.player.pause(true);
    if (paused) {
      this.capturePlaybackOffset();
      await this.refreshState();
    }
    return paused;
  }

  async resume() {
    const resumed = this.player.unpause();
    if (resumed) {
      this.playbackStartedAtMs = Date.now();
      await this.refreshState();
    }
    return resumed;
  }

  async skip() {
    if (!this.current && this.playbackStatus() === AudioPlayerStatus.Idle) {
      return false;
    }

    this.currentOffsetMs = 0;
    this.playbackStartedAtMs = null;
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
    this.currentOffsetMs = 0;
    this.playbackStartedAtMs = null;
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

  toPlaybackSnapshot() {
    const channelId = this.connection?.joinConfig?.channelId || null;
    const current = this.current
      ? {
          ...this.current,
          resumeOffsetMs: this.currentPlaybackOffsetMs(),
        }
      : null;
    if (!channelId || (!current && this.queue.length === 0)) {
      return null;
    }

    return {
      guildId: this.guildId,
      channelId,
      controllerChannelId: this.controllerChannelId || null,
      panelQueueVisible: Boolean(this.panelQueueVisible),
      current,
      queue: this.queue.map((track) => ({ ...track, resumeOffsetMs: 0 })),
      history: this.history.slice(0, 20).map((track) => ({ ...track, resumeOffsetMs: 0 })),
      paused: this.isPaused(),
    };
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

async function spotifyUserAccessToken() {
  const refreshToken = currentSpotifyRefreshToken();
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !refreshToken) {
    return null;
  }

  if (spotifyUserTokenCache && spotifyUserTokenCache.expiresAt > Date.now() + 30_000) {
    return spotifyUserTokenCache.token;
  }

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`Spotify user token request failed with status ${response.status}`);
  }

  const payload = await response.json();
  spotifyUserTokenCache = {
    token: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in || 3600) * 1000,
  };
  return spotifyUserTokenCache.token;
}

async function spotifyApiGet(pathname) {
  const token = await spotifyAccessToken();
  if (!token) {
    throw new Error("Spotify credentials are not configured.");
  }

  const response = await fetch(spotifyApiUrl(pathname), {
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

function spotifyApiUrl(pathnameOrUrl, params = {}) {
  const url = pathnameOrUrl.startsWith("http")
    ? new URL(pathnameOrUrl)
    : new URL(`https://api.spotify.com/v1/${pathnameOrUrl}`);

  if (SPOTIFY_MARKET && !url.searchParams.has("market")) {
    url.searchParams.set("market", SPOTIFY_MARKET);
  }

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || url.searchParams.has(key)) {
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  return url;
}

function spotifyPartnerPlaylistRequest(spotifyId, offset = 0, limit = 100) {
  return {
    url: "https://api-partner.spotify.com/pathfinder/v1/query",
    body: {
      operationName: SPOTIFY_PARTNER_PLAYLIST_QUERY_NAME,
      variables: {
        uri: `spotify:playlist:${spotifyId}`,
        offset,
        limit,
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: SPOTIFY_PARTNER_PLAYLIST_QUERY_HASH,
        },
      },
    },
  };
}

function spotifyPlaylistLooksComplete(itemCount, expectedTotal) {
  if (!Number.isInteger(expectedTotal)) {
    return itemCount > 0;
  }
  return itemCount >= Math.min(expectedTotal, PLAYLIST_MAX_TRACKS);
}

function spotifyTrackFromContentRow(row) {
  return row?.itemV2?.data || row?.item?.data || row?.item || row?.track || null;
}

function spotifyPlaylistTotalFromHtmlState(state, spotifyId) {
  const itemsByUri = state?.entities?.items || {};
  const playlistUri = `spotify:playlist:${spotifyId}`;
  const playlist =
    itemsByUri[playlistUri] || Object.entries(itemsByUri).find(([key]) => key.startsWith(playlistUri))?.[1];
  if (!playlist || typeof playlist !== "object") {
    return null;
  }

  const candidates = [
    playlist?.content?.totalCount,
    playlist?.content?.total,
    playlist?.tracks?.totalCount,
    playlist?.tracks?.total,
    playlist?.trackCount,
    playlist?.length,
  ];
  for (const candidate of candidates) {
    if (Number.isInteger(candidate) && candidate >= 0) {
      return candidate;
    }
  }
  return null;
}

async function spotifyPlaylistTracksWithToken(spotifyId, requestedBy, getToken) {
  const items = [];
  let offset = 0;
  let expectedTotal = null;

  while (items.length < PLAYLIST_MAX_TRACKS) {
    const limit = Math.min(SPOTIFY_PLAYLIST_PAGE_SIZE, PLAYLIST_MAX_TRACKS - items.length);
    const token = await getToken();
    if (!token) {
      break;
    }

    const response = await fetch(
      spotifyApiUrl(`playlists/${spotifyId}/tracks`, {
        limit,
        offset,
        additional_types: "track",
      }),
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`Spotify playlist request failed with status ${response.status}`);
    }

    const payload = await response.json();
    if (Number.isInteger(payload.total)) {
      expectedTotal = payload.total;
    }

    const rows = payload.items || [];
    for (const row of rows) {
      const item = queueTrackFromSpotifyApi(row.item || row.track, requestedBy);
      if (item) {
        items.push(item);
      }
      if (items.length >= PLAYLIST_MAX_TRACKS) {
        break;
      }
    }

    offset += rows.length;
    if (rows.length === 0) {
      break;
    }
    if (Number.isInteger(expectedTotal) && offset >= expectedTotal) {
      break;
    }
    if (!payload.next && !Number.isInteger(expectedTotal)) {
      break;
    }
  }

  return { items, expectedTotal };
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
    const track = spotifyTrackFromContentRow(row);
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

async function spotifyPartnerPlaylistTracks(spotifyId, requestedBy, getToken) {
  const items = [];
  let offset = 0;
  let expectedTotal = null;
  let pageLimit = 100;

  while (items.length < PLAYLIST_MAX_TRACKS) {
    const token = await getToken();
    if (!token) {
      break;
    }

    const remaining = PLAYLIST_MAX_TRACKS - items.length;
    const limit = Math.max(1, Math.min(pageLimit, remaining));
    const request = spotifyPartnerPlaylistRequest(spotifyId, offset, limit);
    const response = await fetch(request.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
      },
      body: JSON.stringify(request.body),
    });

    if (!response.ok) {
      throw new Error(`Spotify public playlist metadata request failed with status ${response.status}`);
    }

    const payload = await response.json();
    const content = payload?.data?.playlistV2?.content || null;
    if (Number.isInteger(content?.totalCount)) {
      expectedTotal = content.totalCount;
    }

    const rows = Array.isArray(content?.items) ? content.items : [];
    for (const row of rows) {
      const track = spotifyTrackFromContentRow(row);
      const item = queueTrackFromSpotifyHtml(track, requestedBy);
      if (item) {
        items.push(item);
      }
      if (items.length >= PLAYLIST_MAX_TRACKS) {
        break;
      }
    }

    const nextOffset = content?.pagingInfo?.nextOffset;
    if (!Number.isInteger(nextOffset) || nextOffset <= offset || rows.length === 0) {
      break;
    }

    offset = nextOffset;
  }

  return { items, expectedTotal };
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
  let partnerFailure = null;
  try {
    const { items, expectedTotal } = await spotifyPartnerPlaylistTracks(
      spotifyId,
      requestedBy,
      spotifyPublicToken,
    );
    if (spotifyPlaylistLooksComplete(items.length, expectedTotal)) {
      return items;
    }
    if (items.length > 0) {
      logger.warn(
        `Spotify public partner playlist fallback was partial for ${spotifyId}: resolved ${items.length} of ${expectedTotal}.`,
      );
    }
  } catch (error) {
    partnerFailure = error;
    logger.warn(`Spotify public partner playlist fallback failed: ${error.message}`);
  }

  if (currentSpotifyRefreshToken() && SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET) {
    try {
      const { items, expectedTotal } = await spotifyPartnerPlaylistTracks(
        spotifyId,
        requestedBy,
        spotifyUserAccessToken,
      );
      if (spotifyPlaylistLooksComplete(items.length, expectedTotal)) {
        return items;
      }
      if (items.length > 0) {
        logger.warn(
          `Spotify user partner playlist fallback was partial for ${spotifyId}: resolved ${items.length} of ${expectedTotal}.`,
        );
      }
    } catch (error) {
      if (!partnerFailure) {
        partnerFailure = error;
      }
      logger.warn(`Spotify user partner playlist fallback failed: ${error.message}`);
    }
  }

  let publicTokenFailure = null;
  try {
    const { items, expectedTotal } = await spotifyPlaylistTracksWithToken(
      spotifyId,
      requestedBy,
      spotifyPublicToken,
    );
    if (spotifyPlaylistLooksComplete(items.length, expectedTotal)) {
      return items;
    }
    if (items.length > 0) {
      logger.warn(
        `Spotify public playlist fallback was partial for ${spotifyId}: resolved ${items.length} of ${expectedTotal}.`,
      );
    }
  } catch (error) {
    publicTokenFailure = error;
    logger.warn(`Spotify public playlist fallback failed: ${error.message}`);
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
  const expectedTotal = spotifyPlaylistTotalFromHtmlState(state, spotifyId);
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
  if (items.length > 0 && !spotifyPlaylistLooksComplete(items.length, expectedTotal)) {
    const partnerDetail = partnerFailure ? ` Public playlist scrape failed first: ${partnerFailure.message}.` : "";
    const publicTokenDetail = publicTokenFailure ? ` Public-token API lookup failed after that: ${publicTokenFailure.message}.` : "";
    logger.warn(
      `Spotify playlist expansion is continuing with ${items.length} of ${expectedTotal} tracks.${partnerDetail}${publicTokenDetail}`,
    );
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
    let spotifyUserFailure = null;
    if (currentSpotifyRefreshToken() && SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET) {
      try {
        const { items, expectedTotal } = await spotifyPlaylistTracksWithToken(
          spotifyId,
          requestedBy,
          spotifyUserAccessToken,
        );
        if (spotifyPlaylistLooksComplete(items.length, expectedTotal)) {
          return items;
        }
        if (items.length > 0) {
          logger.warn(
            `Spotify playlist user-token lookup was partial for ${spotifyId}: resolved ${items.length} of ${expectedTotal}.`,
          );
        }
      } catch (error) {
        spotifyUserFailure = error;
        logger.warn(`Spotify playlist user-token lookup failed, trying app fallback: ${error.message}`);
      }
    }

    let spotifyApiFailure = null;
    if (SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET) {
      try {
        const { items, expectedTotal } = await spotifyPlaylistTracksWithToken(
          spotifyId,
          requestedBy,
          spotifyAccessToken,
        );
        if (spotifyPlaylistLooksComplete(items.length, expectedTotal)) {
          return items;
        }
        if (items.length > 0) {
          logger.warn(
            `Spotify playlist API lookup was partial for ${spotifyId}: resolved ${items.length} of ${expectedTotal}.`,
          );
        }
      } catch (error) {
        spotifyApiFailure = error;
        logger.warn(`Spotify playlist API lookup failed, trying fallback: ${error.message}`);
      }
    }

    try {
      const fallbackItems = await spotifyFallbackPlaylistTracks(spotifyId, requestedBy);
      if (fallbackItems.length === 0) {
        throw new Error("No playable tracks found for that Spotify playlist.");
      }
      return fallbackItems;
    } catch (error) {
      if (spotifyUserFailure) {
        error.message = `${error.message} Spotify user-token lookup failed first: ${spotifyUserFailure.message}.`;
      }
      if (spotifyApiFailure) {
        error.message = `${error.message} Spotify API lookup failed first: ${spotifyApiFailure.message}.`;
      }
      throw error;
    }
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

async function resolveSearchTracks(query, requestedBy, limit = 1) {
  const safeLimit = Math.max(1, Math.min(10, limit));
  const results = await play.search(query, {
    limit: safeLimit,
    source: { youtube: "video" },
  });
  return results.map((result) =>
    createTrack({
      title: result.title,
      webpageUrl: result.url,
      duration: result.durationInSec,
      thumbnail: result.thumbnails?.at(-1)?.url || null,
      requestedBy,
    }),
  );
}

async function resolveSearchTrack(query, requestedBy) {
  const tracks = await resolveSearchTracks(query, requestedBy, 1);
  const result = tracks[0];
  if (!result) {
    throw new Error("No playable results found for that query.");
  }

  return result;
}

function buildRadioSearchQueries(seedQuery, basisTrack = null) {
  const values = [
    basisTrack?.searchQuery,
    basisTrack?.title,
    seedQuery,
    seedQuery ? `${seedQuery} music` : null,
    seedQuery ? `${seedQuery} mix` : null,
    basisTrack?.title && seedQuery ? `${basisTrack.title} ${seedQuery}` : null,
  ];
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

async function resolveRadioSeedTrack(query, requestedBy) {
  const tracks = await resolveSources(query, requestedBy);
  const seedTrack = tracks[0];
  if (!seedTrack) {
    throw new Error("No playable seed track found for that radio query.");
  }
  return seedTrack;
}

async function resolveRadioRelatedTracks(track, requestedBy, limit = 5) {
  const sourceUrl = track?.streamUrl || track?.webpageUrl || null;
  if (!isYouTubeUrl(sourceUrl)) {
    return [];
  }

  const info = await play.video_basic_info(sourceUrl);
  const urls = Array.isArray(info.related_videos) ? info.related_videos : [];
  const relatedTracks = [];
  for (const url of urls) {
    try {
      const items = await resolveYouTubeSources(url, requestedBy);
      if (items[0]) {
        relatedTracks.push(items[0]);
      }
    } catch {}
    if (relatedTracks.length >= limit) {
      break;
    }
  }
  return relatedTracks;
}

async function fetchRadioCandidates({ state, radioState, limit }) {
  const basisTrack = state.current || state.history[0] || null;
  const requestedBy = radioState.requestedBy || "radio";
  const relatedTracks = basisTrack ? await resolveRadioRelatedTracks(basisTrack, requestedBy, limit) : [];
  if (relatedTracks.length > 0) {
    return relatedTracks;
  }

  const queries = buildRadioSearchQueries(radioState.seedQuery, basisTrack);
  for (const query of queries) {
    const items = await resolveSearchTracks(query, requestedBy, limit);
    if (items.length > 0) {
      return items;
    }
  }
  return [];
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
  const seekSeconds = Math.max(0, Math.floor((track.resumeOffsetMs || 0) / 1000));

  if (isYouTubeUrl(sourceUrl)) {
    return { resource: await createYouTubeResource(track, sourceUrl, seekSeconds), stream: null };
  }

  let stream;
  try {
    stream = seekSeconds > 0 ? await play.stream(sourceUrl, { seek: seekSeconds }) : await play.stream(sourceUrl);
  } catch (error) {
    if (seekSeconds > 0) {
      logger.warn(`Playback resume seek unsupported for '${track.title}', retrying from the start: ${error.message}`);
      track.resumeOffsetMs = 0;
      stream = await play.stream(sourceUrl);
    } else {
      throw error;
    }
  }
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

async function createYouTubeResource(track, url, seekSeconds = 0) {
  const mediaUrl = await resolveYouTubeMediaUrl(track, url);
  const seekArgs = seekSeconds > 0 ? ["-ss", String(seekSeconds)] : [];
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
      ...seekArgs,
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
        .setCustomId(`player:${state.guildId}:shuffle`)
        .setLabel("Shuffle")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(state.queue.length < 2),
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

async function refreshPlayerPanel(guildId, { repost = false } = {}) {
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
      if (state.playerMessageId && !repost) {
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

      if (state.playerMessageId && repost) {
        try {
          const previous = await channel.messages.fetch(state.playerMessageId);
          await previous.delete().catch(() => {});
        } catch (error) {
          if (error?.code !== 10008) {
            logger.warn(`Unable to replace player panel in guild ${guildId}: ${error.message}`);
          }
        }
        state.playerMessageId = null;
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

async function finalizeRecording(session, guild = null) {
  await session.stop(guild);
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
      await finalizeRecording(session, state.guild);
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
    await refreshRecordingNickname(guildId);
    schedulePlaybackSnapshotPersist();
    refreshPresence();
    logger.info(`${reason} in guild ${guildId}`);
  } finally {
    state.disconnecting = false;
    await refreshPlayerPanel(guildId).catch(() => {});
  }
}

async function refreshRecordingNickname(guildId) {
  const guild = client.guilds.cache.get(guildId);
  const state = getGuildState(guildId);
  if (!guild || !client.user) {
    return;
  }

  const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
  if (!me) {
    return;
  }

  const canChangeOwnNickname = me.permissions.has(PermissionFlagsBits.ChangeNickname);
  const canManageNicknames = me.manageable && me.permissions.has(PermissionFlagsBits.ManageNicknames);
  if (!canChangeOwnNickname && !canManageNicknames) {
    logger.warn(`Cannot update recording nickname in guild ${guildId}: missing ChangeNickname/ManageNicknames permission.`);
    return;
  }

  const currentNickname = me.nickname;
  if (state.recording) {
    if (state.baseNickname === undefined) {
      state.baseNickname = currentNickname === null ? null : trimRecordingIndicator(currentNickname);
    }
    const targetNickname = buildRecordingNickname(state.baseNickname ?? currentNickname ?? "");
    if (currentNickname === targetNickname) {
      return;
    }
    let updated = false;
    await me.setNickname(targetNickname, "Recording active").then(() => {
      updated = true;
    }).catch(async (error) => {
      logger.warn(`Primary nickname update failed in guild ${guildId}: ${error.message}`);
      await guild.members.edit(client.user.id, { nick: targetNickname, reason: "Recording active" }).then(() => {
        updated = true;
      }).catch((fallbackError) => {
        logger.warn(`Failed to set recording nickname in guild ${guildId}: ${fallbackError.message}`);
      });
    });
    if (updated) {
      logger.info(`Recording nickname enabled in guild ${guildId}.`);
    }
    return;
  }

  if (state.baseNickname === undefined) {
    if (currentNickname && currentNickname.startsWith(RECORDING_NICKNAME_INDICATOR)) {
      state.baseNickname = trimRecordingIndicator(currentNickname);
    } else {
      return;
    }
  }

  const restoreNickname = state.baseNickname || null;
  if ((currentNickname || null) === restoreNickname) {
    state.baseNickname = undefined;
    return;
  }
  let restored = false;
  await me.setNickname(restoreNickname, "Recording inactive").then(() => {
    restored = true;
  }).catch(async (error) => {
    logger.warn(`Primary nickname restore failed in guild ${guildId}: ${error.message}`);
    await guild.members.edit(client.user.id, { nick: restoreNickname, reason: "Recording inactive" }).then(() => {
      restored = true;
    }).catch((fallbackError) => {
      logger.warn(`Failed to restore nickname in guild ${guildId}: ${fallbackError.message}`);
    });
  });
  if (restored) {
    logger.info(`Recording nickname cleared in guild ${guildId}.`);
  }
  state.baseNickname = undefined;
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
  if (radioRuntime.shouldProtectChannel(state, channelId)) {
    clearIdleTimer(state);
    radioRuntime.scheduleRefill(state, "voice_lifecycle");
    refreshPresence();
    return;
  }

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
  const sessions = await listRecordingSessions();
  for (const session of sessions) {
    if (!session.isExpired(now)) {
      await archiveRecordingSessionIfNeeded(session, now);
      continue;
    }

    completedRecordings.delete(session.token);
    if (latestRecordingByGuild.get(session.guildId) === session.token) {
      latestRecordingByGuild.delete(session.guildId);
    }
    stateStore.removeRecordingSession(session.token);
    await fsp.rm(session.directory, { recursive: true, force: true }).catch(() => {});
  }
}

function recordingLinkMessage(session, audioFiles, { prefix = "Recording saved." } = {}) {
  if (audioFiles.length === 0) {
    return "Recording stopped, but no audio files were captured.";
  }

  const lines = [`${prefix} Session: ${session.indexUrl()}`];
  if (session.archivePath) {
    lines.push(`ZIP: ${session.zipUrl()}`);
  }
  lines.push(`Expires: ${session.expiresAt().toISOString()}`);
  return lines.join("\n");
}

function buildDiscordAuthorizationUrl(state) {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    response_type: "code",
    redirect_uri: DISCORD_REDIRECT_URI,
    scope: "identify",
    state,
    prompt: "consent",
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

function buildSpotifyAuthorizationUrl(state) {
  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: spotifyRedirectUri(),
    scope: SPOTIFY_OAUTH_SCOPES,
    state,
    show_dialog: "true",
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function exchangeDiscordCodeForToken(code) {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    client_secret: DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: DISCORD_REDIRECT_URI,
  });
  const response = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.error_description || payload?.error || "Discord OAuth token exchange failed.");
  }
  return payload.access_token;
}

async function fetchDiscordIdentity(accessToken) {
  const response = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.id) {
    throw new Error(payload?.message || "Discord user lookup failed.");
  }
  return payload;
}

async function exchangeSpotifyCodeForToken(code) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: spotifyRedirectUri(),
  });
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.error_description || payload?.error || "Spotify OAuth token exchange failed.");
  }
  return payload;
}

async function startDownloadServer() {
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", async (_req, res) => {
    await otaRuntime.syncPendingUpdateState();
    const snapshot = otaRuntime.buildHealthSnapshot();
    res.setHeader("Cache-Control", "no-store");
    res.status(snapshot.status === "unhealthy" ? 503 : 200).json(snapshot);
  });

  app.get("/readyz", async (_req, res) => {
    await otaRuntime.syncPendingUpdateState();
    const snapshot = otaRuntime.buildHealthSnapshot();
    res.setHeader("Cache-Control", "no-store");
    res.status(snapshot.ready ? 200 : 503).json(snapshot);
  });
  registerOtaRoutes(app, { logger, otaRuntime });

  const renderHome = async (req) => {
    const viewer = getAuthenticatedRecordingUser(req);
    const viewerModel = buildViewerModel(viewer);
    const summaries = viewer?.id
      ? (await loadRecordingSummaries()).filter((summary) => summary.participantIds.includes(viewer.id))
      : [];
    const stats = buildRecordingStats(summaries, viewer?.id || null);
    return renderRecordingsHomePage({
      viewer: viewerModel,
      oauthConfigured: hasDiscordWebAuth(),
      retentionDays: RECORDINGS_TTL_DAYS,
      storageRoot: RECORDINGS_DIR,
      recentWindowDays: RECENT_RECORDINGS_DAYS,
      stats: [
        { id: "sessionCount", label: "My sessions", value: String(stats.total) },
        { label: `Recent (${RECENT_RECORDINGS_DAYS}d)`, value: String(stats.recent) },
        { label: "Archives", value: String(stats.archived) },
        { label: "Active captures", value: String(stats.active) },
      ],
    });
  };

  const renderListPage = async (req, { currentPath, heroText, toolbarLabel, sessionCountLabel, filter, emptyText }) => {
    const viewer = getAuthenticatedRecordingUser(req);
    const viewerModel = buildViewerModel(viewer);
    const baseSummaries = viewer?.id
      ? (await loadRecordingSummaries()).filter((summary) => summary.participantIds.includes(viewer.id))
      : [];
    const summaries = baseSummaries.filter(filter);
    const stats = buildRecordingStats(summaries, viewer?.id || null);
    return renderRecordingsListPage({
      viewer: viewerModel,
      oauthConfigured: hasDiscordWebAuth(),
      currentPath,
      retentionDays: RECORDINGS_TTL_DAYS,
      storageRoot: RECORDINGS_DIR,
      heroText,
      toolbarLabel,
      sessionCountLabel,
      stats: [
        { id: "sessionCount", label: sessionCountLabel, value: String(summaries.length) },
        { label: "Ready downloads", value: String(summaries.filter((summary) => Boolean(summary.session.completedAt)).length) },
        { label: "Active captures", value: String(summaries.filter((summary) => !summary.session.completedAt).length) },
        { label: "Compressed", value: String(summaries.filter((summary) => summary.archived).length) },
      ],
      rows: summaries.map((summary) => buildRecordingRowView(summary, viewer)),
      emptyText,
    });
  };

  app.get("/auth/discord/login", async (req, res) => {
    if (!hasDiscordWebAuth()) {
      res.status(503).type("html").send("Discord web login is not configured.");
      return;
    }

    const nextPath = sanitizeReturnPath(typeof req.query.next === "string" ? req.query.next : "/recordings/mine/");
    const nonce = crypto.randomBytes(18).toString("base64url");
    const statePayload = {
      nonce,
      nextPath,
      exp: Date.now() + 10 * 60 * 1000,
    };
    setCookie(res, OAUTH_STATE_COOKIE_NAME, encodeSignedPayload(statePayload), {
      maxAge: 10 * 60,
    });
    res.redirect(buildDiscordAuthorizationUrl(nonce));
  });

  app.get("/auth/discord/callback", async (req, res) => {
    if (!hasDiscordWebAuth()) {
      res.status(503).type("html").send("Discord web login is not configured.");
      return;
    }

    try {
      const cookies = parseCookieHeader(req.headers.cookie);
      const storedState = decodeSignedPayload(cookies[OAUTH_STATE_COOKIE_NAME]);
      const receivedState = typeof req.query.state === "string" ? req.query.state : "";
      const code = typeof req.query.code === "string" ? req.query.code : "";
      if (!storedState?.nonce || !receivedState || storedState.nonce !== receivedState || !code) {
        throw new Error("Discord login state could not be validated.");
      }

      const accessToken = await exchangeDiscordCodeForToken(code);
      const user = await fetchDiscordIdentity(accessToken);
      setCookie(
        res,
        WEB_SESSION_COOKIE_NAME,
        encodeSignedPayload({
          id: user.id,
          username: user.username,
          globalName: user.global_name || null,
          avatar: user.avatar || null,
          exp: Date.now() + WEB_SESSION_TTL_MS,
        }),
        {
          maxAge: WEB_SESSION_TTL_MS / 1000,
        },
      );
      clearCookie(res, OAUTH_STATE_COOKIE_NAME);
      res.redirect(sanitizeReturnPath(storedState.nextPath));
    } catch (error) {
      logger.warn(`Discord web login failed: ${error.message}`);
      clearCookie(res, OAUTH_STATE_COOKIE_NAME);
      res.status(400).type("html").send(`Discord login failed: ${escapeHtml(error.message)}`);
    }
  });

  app.get("/auth/spotify/login", async (req, res) => {
    if (!hasSpotifyWebAuth()) {
      res.status(503).type("html").send(
        renderSpotifyAuthResultPage({
          title: "Spotify OAuth Not Configured",
          message: "Set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI, WEB_SESSION_SECRET, and SPOTIFY_OAUTH_SETUP_SECRET first.",
          details: `Expected redirect URI: ${spotifyRedirectUri()}`,
        }),
      );
      return;
    }

    if (!timingSafeSecretEquals(spotifySetupSecretFromRequest(req), SPOTIFY_OAUTH_SETUP_SECRET)) {
      res.status(403).type("html").send(
        renderSpotifyAuthResultPage({
          title: "Spotify OAuth Locked",
          message: "Provide the setup secret to start Spotify linking.",
          details: 'Open /auth/spotify/login?setup=YOUR_SETUP_SECRET while signed into the dedicated Spotify bot account.',
        }),
      );
      return;
    }

    const nextPath = sanitizeReturnPath(typeof req.query.next === "string" ? req.query.next : "/recordings/help/");
    const nonce = crypto.randomBytes(18).toString("base64url");
    const statePayload = {
      nonce,
      nextPath,
      exp: Date.now() + 10 * 60 * 1000,
    };
    setCookie(res, SPOTIFY_OAUTH_STATE_COOKIE_NAME, encodeSignedPayload(statePayload), {
      maxAge: 10 * 60,
    });
    res.redirect(buildSpotifyAuthorizationUrl(nonce));
  });

  app.get("/auth/spotify/callback", async (req, res) => {
    if (!hasSpotifyWebAuth()) {
      res.status(503).type("html").send(
        renderSpotifyAuthResultPage({
          title: "Spotify OAuth Not Configured",
          message: "Spotify web auth is not configured on this bot.",
          details: `Expected redirect URI: ${spotifyRedirectUri()}`,
        }),
      );
      return;
    }

    try {
      const cookies = parseCookieHeader(req.headers.cookie);
      const storedState = decodeSignedPayload(cookies[SPOTIFY_OAUTH_STATE_COOKIE_NAME]);
      const receivedState = typeof req.query.state === "string" ? req.query.state : "";
      const code = typeof req.query.code === "string" ? req.query.code : "";
      if (!storedState?.nonce || !receivedState || storedState.nonce !== receivedState || !code) {
        throw new Error("Spotify login state could not be validated.");
      }

      const tokenPayload = await exchangeSpotifyCodeForToken(code);
      if (!tokenPayload.refresh_token && !currentSpotifyRefreshToken()) {
        throw new Error("Spotify did not return a refresh token. Re-run the flow with show_dialog enabled.");
      }

      if (tokenPayload.refresh_token) {
        await saveSpotifyRefreshToken(tokenPayload.refresh_token);
      }

      clearCookie(res, SPOTIFY_OAUTH_STATE_COOKIE_NAME);
      res.status(200).type("html").send(
        renderSpotifyAuthResultPage({
          title: "Spotify Bot Account Linked",
          message: "The Spotify refresh token is now stored on the server and playlist expansion can use the bot account.",
          details: `Stored token path: ${SPOTIFY_REFRESH_TOKEN_PATH}\nScopes: ${tokenPayload.scope || SPOTIFY_OAUTH_SCOPES}\nRedirect URI: ${spotifyRedirectUri()}`,
        }),
      );
    } catch (error) {
      logger.warn(`Spotify web login failed: ${error.message}`);
      clearCookie(res, SPOTIFY_OAUTH_STATE_COOKIE_NAME);
      res.status(400).type("html").send(
        renderSpotifyAuthResultPage({
          title: "Spotify Linking Failed",
          message: error.message,
          details: `Configured redirect URI: ${spotifyRedirectUri()}`,
        }),
      );
    }
  });

  app.get("/auth/logout", (req, res) => {
    clearCookie(res, WEB_SESSION_COOKIE_NAME);
    clearCookie(res, OAUTH_STATE_COOKIE_NAME);
    clearCookie(res, SPOTIFY_OAUTH_STATE_COOKIE_NAME);
    const nextPath = sanitizeReturnPath(typeof req.query.next === "string" ? req.query.next : "/recordings/");
    res.redirect(nextPath);
  });

  app.get("/", async (req, res) => {
    await pruneExpiredRecordings();
    res.type("html").send(await renderHome(req));
  });

  app.get(["/recordings", "/recordings/"], async (req, res) => {
    await pruneExpiredRecordings();
    res.type("html").send(await renderHome(req));
  });

  app.get(["/recordings/recent", "/recordings/recent/"], async (req, res) => {
    await pruneExpiredRecordings();
    res.type("html").send(
      await renderListPage(req, {
        currentPath: "/recordings/recent/",
        heroText: getAuthenticatedRecordingUser(req)?.id
          ? `Recent Sessions contains your recordings from the last ${RECENT_RECORDINGS_DAYS} days.`
          : "Sign in with Discord to see your recent recordings.",
        toolbarLabel: "Showing your recent sessions",
        sessionCountLabel: "Recent sessions",
        filter: (summary) => isRecentRecordingSession(summary.session),
        emptyText: hasDiscordWebAuth()
          ? 'Sign in with Discord to view your recent recordings. Use the "Link Discord" button in the sidebar.'
          : "No recent recording sessions are available right now.",
      }),
    );
  });

  app.get(["/recordings/archives", "/recordings/archives/"], async (req, res) => {
    await pruneExpiredRecordings();
    res.type("html").send(
      await renderListPage(req, {
        currentPath: "/recordings/archives/",
        heroText: getAuthenticatedRecordingUser(req)?.id
          ? `Archives contains your recordings older than ${RECENT_RECORDINGS_DAYS} days. These are stored as smaller compressed files.`
          : "Sign in with Discord to see your archived recordings.",
        toolbarLabel: "Showing your archived sessions",
        sessionCountLabel: "Archived sessions",
        filter: (summary) => isArchivedRecordingSummary(summary),
        emptyText: hasDiscordWebAuth()
          ? 'Sign in with Discord to view your archived recordings. Use the "Link Discord" button in the sidebar.'
          : "No archived sessions are available yet.",
      }),
    );
  });

  app.get(["/recordings/help", "/recordings/help/"], async (req, res) => {
    await pruneExpiredRecordings();
    res.type("html").send(
      renderRecordingsHelpPage({
        viewer: buildViewerModel(getAuthenticatedRecordingUser(req)),
        oauthConfigured: hasDiscordWebAuth(),
        currentPath: "/recordings/help/",
        retentionDays: RECORDINGS_TTL_DAYS,
        storageRoot: RECORDINGS_DIR,
        recentWindowDays: RECENT_RECORDINGS_DAYS,
      }),
    );
  });

  app.get(["/recordings/mine", "/recordings/mine/"], async (req, res) => {
    await pruneExpiredRecordings();
    if (!hasDiscordWebAuth()) {
      res
        .status(503)
        .type("html")
        .send("Discord web login is not configured yet. Set DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI, and WEB_SESSION_SECRET.");
      return;
    }

    const viewer = getAuthenticatedRecordingUser(req);
    if (!viewer?.id) {
      res.type("html").send(
        await renderListPage(req, {
          currentPath: "/recordings/mine/",
          heroText: "Sign in with Discord to see only the recordings that include your own voice.",
          toolbarLabel: "Showing your matched sessions",
          sessionCountLabel: "Matched sessions",
          filter: () => false,
          emptyText: 'Sign in with Discord to view sessions that include your audio. Use the "Link Discord" button in the sidebar.',
        }),
      );
      return;
    }

    res.type("html").send(
      await renderListPage(req, {
        currentPath: "/recordings/mine/",
        heroText: `Showing all recordings that include your voice capture, ${viewer.global_name || viewer.globalName || viewer.username}.`,
        toolbarLabel: "Showing all of your matched sessions",
        sessionCountLabel: "Matched sessions",
        filter: (summary) => summary.participantIds.includes(viewer.id),
        emptyText: "No recordings matching your Discord account were found yet.",
      }),
    );
  });

  app.get("/recordings/:token/", async (req, res) => {
    await pruneExpiredRecordings();
    const token = req.params.token;
    const session = await resolveRecordingSession(token);
    if (!session) {
      res.status(404).send("Recording session not found");
      return;
    }
    if (!(await requireRecordingAccess(req, res, session))) {
      return;
    }

    const audioFiles = await getSessionDownloadableAudioFiles(session);
    const indexedFiles = Array.isArray(session.fileEntries)
      ? new Map(session.fileEntries.map((fileEntry) => [fileEntry.fileName, fileEntry]))
      : null;
    const fileStats = await Promise.all(
      audioFiles.map(async (name) => {
        const indexed = indexedFiles?.get(name);
        const stat = indexed
          ? { size: indexed.fileSizeBytes || 0 }
          : await fsp.stat(path.join(session.directory, name)).catch(() => null);
        return {
          name,
          sizeLabel: formatBytes(stat?.size || 0),
          href: `/recordings/${encodeURIComponent(token)}/${encodeURIComponent(name)}`,
          archived: path.extname(name).toLowerCase() !== ".wav",
        };
      }),
    );
    res.type("html").send(
      renderRecordingSessionPage({
        viewer: buildViewerModel(getAuthenticatedRecordingUser(req)),
        oauthConfigured: hasDiscordWebAuth(),
        currentPath: "/recordings/mine/",
        retentionDays: RECORDINGS_TTL_DAYS,
        storageRoot: RECORDINGS_DIR,
        title: session.guildName || `Guild ${session.guildId}`,
        subtitle: session.channelName ? `Channel ${session.channelName}` : `Session ${session.token.slice(0, 8)}`,
        details: `Started ${formatDateTime(session.startedAt)}${session.completedAt ? ` • Completed ${formatDateTime(session.completedAt)}` : ""} • Expires ${formatDateTime(session.expiresAt())}`,
        zipHref: session.archivePath ? `/recordings/${encodeURIComponent(token)}/session.zip` : null,
        files: fileStats,
        archived: audioFiles.length > 0 && audioFiles.every((name) => path.extname(name).toLowerCase() !== ".wav"),
      }),
    );
  });

  app.get("/recordings/:token/session.zip", async (req, res) => {
    await pruneExpiredRecordings();
    const session = await resolveRecordingSession(req.params.token);
    if (!session?.archivePath) {
      res.status(404).send("Archive not found");
      return;
    }
    if (!(await requireRecordingAccess(req, res, session))) {
      return;
    }

    res.sendFile(path.resolve(session.archivePath));
  });

  app.get("/recordings/:token/:filename", async (req, res) => {
    await pruneExpiredRecordings();
    const token = req.params.token;
    const session = await resolveRecordingSession(token);
    if (!session) {
      res.status(404).send("Recording session not found");
      return;
    }
    if (!(await requireRecordingAccess(req, res, session))) {
      return;
    }

    const requestedPath = path.resolve(session.directory, req.params.filename);
    const sessionPath = path.resolve(session.directory);
    if (!(requestedPath === sessionPath || requestedPath.startsWith(`${sessionPath}${path.sep}`))) {
      res.status(403).send("Invalid file path");
      return;
    }

    const requestedName = path.basename(req.params.filename);
    if (requestedName !== req.params.filename) {
      res.status(404).send("File not found");
      return;
    }

    const allowedFiles = await getSessionDownloadableAudioFiles(session);
    if (!allowedFiles.includes(requestedName)) {
      res.status(404).send("File not found");
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

function getActiveVoiceChannelId(state) {
  if (state?.recording?.channelId) {
    return state.recording.channelId;
  }

  const connection = state?.connection || (state?.guildId ? getVoiceConnection(state.guildId) : null);
  if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
    return null;
  }

  return connection.joinConfig.channelId || null;
}

async function requireSameVoiceContext(interaction, state, { actionDescription, requireVoiceWhenDisconnected = false } = {}) {
  const member = await fetchInteractionMember(interaction);
  const memberChannelId = member.voice?.channelId || null;
  const activeChannelId = getActiveVoiceChannelId(state);
  if (activeChannelId) {
    if (!memberChannelId) {
      throw new Error(`Join <#${activeChannelId}> to ${actionDescription}.`);
    }
    if (memberChannelId !== activeChannelId) {
      throw new Error(`You must be in <#${activeChannelId}> to ${actionDescription}.`);
    }
    return member;
  }

  if (requireVoiceWhenDisconnected && !memberChannelId) {
    throw new Error("You must join a voice channel first.");
  }

  return member;
}

function resolveRequestedRadioChannel(member, requestedChannel) {
  const memberChannel = member.voice?.channel || null;
  if (!memberChannel?.isVoiceBased?.()) {
    throw new Error("You must join a voice channel first.");
  }

  if (!requestedChannel) {
    return memberChannel;
  }

  if (!requestedChannel.isVoiceBased?.()) {
    throw new Error("Radio can only be bound to a voice channel.");
  }

  if (requestedChannel.id !== memberChannel.id) {
    throw new Error(`Join <#${requestedChannel.id}> before binding radio there.`);
  }

  return requestedChannel;
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
  new SlashCommandBuilder()
    .setName("move")
    .setDescription("Move a queued track to a different position")
    .addIntegerOption((option) =>
      option.setName("from").setDescription("Current 1-based queue position").setRequired(true).setMinValue(1),
    )
    .addIntegerOption((option) =>
      option.setName("to").setDescription("New 1-based queue position").setRequired(true).setMinValue(1),
    ),
  new SlashCommandBuilder().setName("shuffle").setDescription("Shuffle queued tracks"),
  new SlashCommandBuilder().setName("recordstart").setDescription("Start recording the current voice channel"),
  new SlashCommandBuilder().setName("recordstop").setDescription("Stop recording and return a download link"),
  new SlashCommandBuilder().setName("recordlink").setDescription("Get the download link for the latest recording"),
  new SlashCommandBuilder()
    .setName("radio")
    .setDescription("Start or inspect continuous radio playback")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("start")
        .setDescription("Start radio in a voice channel and keep it refilled")
        .addStringOption((option) => option.setName("query").setDescription("Genre, vibe, or seed query").setRequired(true))
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Voice channel to bind radio to")
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("stop")
        .setDescription("Stop radio and clear playback")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Show radio status")
    ),
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

async function restorePersistedRadioStates() {
  const persistedStates = radioRuntime.loadPersistedRadioStates();
  for (const persisted of persistedStates) {
    const guild = client.guilds.cache.get(persisted.guildId);
    if (!guild) {
      continue;
    }

    const channel = guild.channels.cache.get(persisted.boundChannelId)
      || (await guild.channels.fetch(persisted.boundChannelId).catch(() => null));
    if (!channel?.isVoiceBased?.()) {
      logger.warn(`Skipping persisted radio in guild ${persisted.guildId}: bound channel is unavailable.`);
      stateStore.clearRadioState(persisted.guildId);
      continue;
    }

    const state = getGuildState(persisted.guildId);
    state.controllerChannelId = persisted.controllerChannelId || state.controllerChannelId;
    await radioRuntime.restore(state, persisted);
    try {
      await state.ensureConnectionToChannel(channel, { requireReceive: Boolean(state.recording) });
      radioRuntime.scheduleRefill(state, "startup_restore");
      logger.info(`Restored radio mode in guild ${persisted.guildId} for '${persisted.seedQuery}'.`);
    } catch (error) {
      logger.warn(`Failed to restore radio mode in guild ${persisted.guildId}: ${error.message}`);
    }
  }
}

async function handlePlay(interaction, { next = false } = {}) {
  const guild = interaction.guild;
  if (!guild) {
    throw new Error("This command must be used in a guild.");
  }
  otaRuntime.assertLongLivedActionAllowed(next ? "queue more playback" : "start playback");
  const state = getGuildState(guild.id);
  const member = await requireSameVoiceContext(interaction, state, {
    actionDescription: next ? "queue tracks next" : "queue music",
    requireVoiceWhenDisconnected: true,
  });
  otaRuntime.trackMeaningfulActivity(next ? "playnext command" : "play command");
  await interaction.deferReply();
  state.controllerChannelId = interaction.channelId;
  await state.ensureConnection(member, { requireReceive: Boolean(state.recording) });

  const radioWasActive = radioRuntime.isActive(state);
  if (radioWasActive) {
    await radioRuntime.stop(state);
  }

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
      ? `${radioWasActive ? "Radio disabled. " : ""}${next ? "Added next" : "Queued"}: ${tracks[0].title}`
      : `${radioWasActive ? "Radio disabled. " : ""}${next ? "Queued next batch" : "Queued playlist"} with ${tracks.length} tracks${tracks.length >= PLAYLIST_MAX_TRACKS ? " (capped)" : ""}.`;
  await safeReply(interaction, message);
  await refreshPlayerPanel(guild.id, { repost: true });
  refreshPresence();
  void refreshVoiceLifecycle(guild.id);
}

async function handleCommand(interaction) {
  const guild = interaction.guild;
  const guildId = interaction.guildId;
  const state = guildId ? getGuildState(guildId) : null;
  await otaRuntime.syncPendingUpdateState();

  switch (interaction.commandName) {
    case "ping":
      await interaction.reply({ content: "Pong!", ephemeral: true });
      return;
    case "join": {
      const member = await requireSameVoiceContext(interaction, state, {
        actionDescription: "make the bot join voice",
        requireVoiceWhenDisconnected: true,
      });
      otaRuntime.trackMeaningfulActivity("join command");
      await state.ensureConnection(member, { requireReceive: Boolean(state.recording) });
      await interaction.reply({ content: "Joined your voice channel.", ephemeral: true });
      return;
    }
    case "leave":
      await requireSameVoiceContext(interaction, state, { actionDescription: "make the bot leave voice" });
      otaRuntime.trackMeaningfulActivity("leave command");
      await interaction.deferReply({ ephemeral: true });
      if (radioRuntime.isActive(state)) {
        await radioRuntime.stop(state);
      }
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
      await requireSameVoiceContext(interaction, state, { actionDescription: "skip tracks" });
      otaRuntime.trackMeaningfulActivity("skip command");
      const skipped = await state.skip();
      await interaction.reply({ content: skipped ? "Skipped." : "Nothing is playing.", ephemeral: true });
      return;
    }
    case "pause": {
      await requireSameVoiceContext(interaction, state, { actionDescription: "pause playback" });
      otaRuntime.trackMeaningfulActivity("pause command");
      const paused = await state.pause();
      await interaction.reply({ content: paused ? "Paused." : "Nothing is playing.", ephemeral: true });
      return;
    }
    case "resume": {
      await requireSameVoiceContext(interaction, state, { actionDescription: "resume playback" });
      otaRuntime.trackMeaningfulActivity("resume command");
      const resumed = await state.resume();
      await interaction.reply({ content: resumed ? "Resumed." : "Nothing is paused.", ephemeral: true });
      return;
    }
    case "stop":
      await requireSameVoiceContext(interaction, state, { actionDescription: "stop playback" });
      otaRuntime.trackMeaningfulActivity("stop command");
      if (radioRuntime.isActive(state)) {
        await radioRuntime.stop(state);
      }
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
    case "move": {
      await requireSameVoiceContext(interaction, state, { actionDescription: "reorder the queue" });
      otaRuntime.trackMeaningfulActivity("move command");
      const fromPosition = interaction.options.getInteger("from", true);
      const toPosition = interaction.options.getInteger("to", true);
      const result = await state.moveQueueItem(fromPosition, toPosition);
      const content = !result.moved
        ? result.reason === "empty_queue"
          ? "Queue is empty."
          : `Track ${fromPosition} is already at position ${toPosition}.`
        : `Moved \`${truncate(result.track?.title || "track", 80)}\` from ${fromPosition} to ${toPosition}.`;
      await interaction.reply({ content, ephemeral: true });
      return;
    }
    case "shuffle": {
      await requireSameVoiceContext(interaction, state, { actionDescription: "shuffle the queue" });
      otaRuntime.trackMeaningfulActivity("shuffle command");
      const shuffled = await state.shuffleQueue();
      await interaction.reply({
        content: shuffled ? "Queue shuffled." : "Need at least 2 queued tracks.",
        ephemeral: true,
      });
      return;
    }
    case "recordstart": {
      otaRuntime.assertLongLivedActionAllowed("start a new recording");
      const member = await requireSameVoiceContext(interaction, state, {
        actionDescription: "start recording",
        requireVoiceWhenDisconnected: true,
      });
      if (state.recording) {
        throw new Error("Recording is already active in this guild.");
      }

      otaRuntime.trackMeaningfulActivity("recordstart command");
      await interaction.deferReply();
      const connection = await state.ensureConnection(member, { requireReceive: true });
      await state.updateReceiveMode(true);

      const session = new RecordingSession(guildId, member.voice.channel.id);
      session.guildName = guild.name;
      session.channelName = member.voice.channel.name;
      session.attach(connection, guild);
      state.recording = session;
      await refreshRecordingNickname(guildId);
      await state.refreshState();
      await safeReply(interaction, `Recording started. Browse recordings at ${downloadBaseUrl}`);
      return;
    }
    case "recordstop": {
      await requireSameVoiceContext(interaction, state, { actionDescription: "stop recording" });
      if (!state.recording) {
        throw new Error("There is no active recording in this guild.");
      }

      otaRuntime.trackMeaningfulActivity("recordstop command");
      await interaction.deferReply();
      const session = state.recording;
      state.recording = null;
      await finalizeRecording(session, guild);
      await state.updateReceiveMode(false);
      await refreshRecordingNickname(guildId);
      await state.refreshState();
      const audioFiles = await getSessionDownloadableAudioFiles(session);
      await safeReply(interaction, recordingLinkMessage(session, audioFiles));
      return;
    }
    case "recordlink": {
      await interaction.deferReply({ ephemeral: true });
      const latest = await findLatestCompletedRecordingForGuild(guildId);
      if (!latest) {
        if (state.recording) {
          throw new Error("A recording is in progress, but no completed recording is available yet.");
        }
        throw new Error("No completed recording is available for this guild.");
      }

      const audioFiles = await getSessionDownloadableAudioFiles(latest);
      await safeReply(
        interaction,
        recordingLinkMessage(latest, audioFiles, {
          prefix: state.recording ? "A recording is in progress. Latest completed recording:" : "Latest recording:",
        }),
        { ephemeral: true },
      );
      return;
    }
    case "radio": {
      const subcommand = interaction.options.getSubcommand(true);
      if (subcommand === "status") {
        const radioStatus = radioRuntime.getStatus(state);
        const lines = radioStatus.active
          ? [
              "Radio: active",
              `Bound channel: <#${radioStatus.boundChannelId}>`,
              `Seed: ${radioStatus.seedQuery}`,
              `Source mode: ${radioStatus.sourceMode}`,
              `Buffered upcoming: ${radioStatus.bufferedUpcomingCount}`,
              `Min buffer: ${radioStatus.minBufferTracks}`,
              `Last error: ${radioStatus.lastError || "none"}`,
            ]
          : ["Radio: inactive"];
        await interaction.reply({ content: lines.join("\n"), ephemeral: true });
        return;
      }

      if (subcommand === "stop") {
        await requireSameVoiceContext(interaction, state, { actionDescription: "stop radio" });
        otaRuntime.trackMeaningfulActivity("radio stop command");
        const wasActive = radioRuntime.isActive(state);
        await radioRuntime.stop(state);
        await state.stopPlayback();
        await interaction.reply({
          content: wasActive ? "Radio stopped and playback cleared." : "Radio was already inactive.",
          ephemeral: true,
        });
        return;
      }

      if (subcommand === "start") {
        const member = await requireSameVoiceContext(interaction, state, {
          actionDescription: "start radio",
          requireVoiceWhenDisconnected: true,
        });
        otaRuntime.trackMeaningfulActivity("radio start command");
        await interaction.deferReply({ ephemeral: true });
        const targetChannel = resolveRequestedRadioChannel(
          member,
          interaction.options.getChannel("channel", false),
        );
        const query = interaction.options.getString("query", true);
        const requestedBy = interaction.member?.displayName || interaction.user.username;
        const seedTrack = await resolveRadioSeedTrack(query, requestedBy);

        state.controllerChannelId = interaction.channelId;
        await state.ensureConnectionToChannel(targetChannel, { requireReceive: Boolean(state.recording) });
        if (radioRuntime.isActive(state)) {
          await radioRuntime.stop(state);
        }
        await state.stopPlayback();
        await radioRuntime.start(state, {
          boundChannelId: targetChannel.id,
          controllerChannelId: interaction.channelId,
          seedQuery: query,
          requestedBy,
          sourceMode: "youtube-related+search",
        });
        await state.enqueue([seedTrack]);
        await radioRuntime.ensureRefill(state, "radio_start");
        await safeReply(
          interaction,
          `Radio started in <#${targetChannel.id}> with seed \`${truncate(query, 100)}\`.`,
          { ephemeral: true },
        );
        await refreshPlayerPanel(guildId, { repost: true });
        return;
      }

      throw new Error("Unsupported radio subcommand.");
    }
    case "status": {
      const health = otaRuntime.buildHealthSnapshot();
      const policy = otaRuntime.getPendingUpdatePolicy();
      const lines = [];
      lines.push(`Version: ${formatRuntimeVersion()}`);
      lines.push(`Runtime: ${health.status}`);
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
      lines.push(`Global idle: ${health.idle.global ? "yes" : "no"}`);
      if (!health.idle.global) {
        lines.push(`Idle blockers: ${health.idle.blockerSummary.join(", ")}`);
      }
      if (policy.pendingUpdate) {
        lines.push(
          `Pending update: ${policy.pendingUpdate.version} (${policy.pendingUpdate.severity}, ${policy.phase})` +
            `${policy.pendingUpdate.forcedApplyDeadline ? `, deadline ${formatDateTime(policy.pendingUpdate.forcedApplyDeadline)}` : ""}`,
        );
        lines.push(`Long-lived actions: ${policy.canStartLongLivedActions ? "allowed" : "blocked"}`);
      } else {
        lines.push("Pending update: none");
      }
      const radioStatus = radioRuntime.getStatus(state);
      lines.push(`Radio: ${radioStatus.active ? `active in <#${radioStatus.boundChannelId}>` : "inactive"}`);
      if (radioStatus.active) {
        lines.push(`Radio seed: ${radioStatus.seedQuery}`);
        lines.push(`Radio source: ${radioStatus.sourceMode}`);
        lines.push(`Radio buffered upcoming: ${radioStatus.bufferedUpcomingCount}`);
      }
      await interaction.reply({ content: lines.join("\n"), ephemeral: true });
      return;
    }
    default:
      throw new Error("Unsupported command.");
  }
}

async function handlePlayerButton(interaction, guildId, action) {
  await otaRuntime.syncPendingUpdateState();
  const state = getGuildState(guildId);
  await requireSameVoiceContext(interaction, state, { actionDescription: "use player controls" });
  if (meaningfulPlayerActions.has(action)) {
    otaRuntime.trackMeaningfulActivity(`player:${action}`);
  }
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
      if (radioRuntime.isActive(state)) {
        await radioRuntime.stop(state);
      }
      await state.stopPlayback();
      return;
    case "shuffle":
      await state.shuffleQueue();
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

  const state = guildId ? getGuildState(guildId) : null;
  const recording = state?.recording;
  if (
    recording &&
    (newState.channelId === recording.channelId || oldState.channelId === recording.channelId) &&
    !(newState.member?.user?.bot || oldState.member?.user?.bot)
  ) {
    recording.noteAuthorizedUser(newState.id || oldState.id);
    if (newState.channelId === recording.channelId) {
      void recording.subscribeUser(newState.guild, newState.id).catch((error) => {
        logger.warn(`Recording subscribe error for user ${newState.id} in guild ${guildId}: ${error.message}`);
      });
    }
  }
});

client.on("guildCreate", async (guild) => {
  await guild.commands.set(COMMANDS).catch((error) => {
    logger.warn(`Failed to sync commands for guild ${guild.id}: ${error.message}`);
  });
});

client.once("ready", async () => {
  logger.info(`Logged in as ${client.user.tag}`);
  logger.info(`Runtime version: ${formatRuntimeVersion()}`);
  logger.info(`Runtime executable: node ${process.version}`);
  logger.info(`Pending update state path: ${UPDATE_STATE_PATH}`);
  logger.info(`Artifact manifest path: ${UPDATE_MANIFEST_PATH}`);
  logger.info(`SQLite state path: ${SQLITE_DB_PATH}`);
  logger.info(`Supervisor contract: loopback-only${SUPERVISOR_TOKEN ? " with token auth" : " without token auth"}`);

  await configurePlayDl();
  await startDownloadServer();
  await otaRuntime.syncPendingUpdateState();
  await rebuildRecordingIndexFromDisk({ logSummary: true });
  await syncCommands();
  await restorePlaybackSnapshot();
  await restorePersistedRadioStates();
  otaRuntime.setRuntimeReady();
  refreshPresence();
  startPresenceLoop();
  setInterval(() => {
    void pruneExpiredRecordings();
  }, CLEANUP_INTERVAL_SECONDS * 1000);
  setInterval(() => {
    void otaRuntime.syncPendingUpdateState().catch((error) => {
      logger.warn(`Failed to refresh pending update state: ${error.message}`);
    });
  }, UPDATE_STATE_POLL_SECONDS * 1000);
});

client.on("error", (error) => {
  otaRuntime.recordClientError(error);
  logger.error(`Client error: ${error.message}`);
});

let shuttingDown = false;
async function shutdown(signal = "unknown") {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info(`Shutting down on ${signal}...`);

  try {
    await savePlaybackSnapshot();
  } catch (error) {
    logger.warn(`Failed to save playback snapshot during shutdown: ${error.message}`);
  }

  if (downloadServer) {
    downloadServer.close();
  }

  await flushPendingPlaybackSnapshotPersist();

  for (const state of guildStates.values()) {
    if (state.recording) {
      const session = state.recording;
      state.recording = null;
      await finalizeRecording(session, state.guild).catch((error) => {
        logger.warn(`Failed to finalize recording during shutdown in guild ${state.guildId}: ${error.message}`);
      });
    }
    const connection = state.connection || getVoiceConnection(state.guildId);
    connection?.destroy();
  }

  await client.destroy().catch(() => {});
  stateStore.close();
  releaseInstanceLock();
  process.exit(0);
}

["SIGINT", "SIGTERM", "SIGBREAK"].forEach((signal) => {
  process.on(signal, () => {
    void shutdown(signal);
  });
});

client.login(TOKEN);
