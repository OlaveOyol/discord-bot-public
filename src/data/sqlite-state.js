const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function isoOrNull(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseJsonArray(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value, fallback = null) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function json(value, fallback) {
  return JSON.stringify(value ?? fallback);
}

function createSqliteStateStore({ dbPath, logger }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
  `);

  const currentVersion = db.prepare("PRAGMA user_version").get().user_version || 0;
  if (currentVersion < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS recording_sessions (
        token TEXT PRIMARY KEY,
        directory_path TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        guild_name TEXT,
        channel_id TEXT,
        channel_name TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        participant_ids_json TEXT NOT NULL DEFAULT '[]',
        authorized_user_ids_json TEXT NOT NULL DEFAULT '[]',
        speaker_user_ids_json TEXT NOT NULL DEFAULT '[]',
        files_json TEXT NOT NULL DEFAULT '[]',
        archived INTEGER NOT NULL DEFAULT 0,
        archive_name TEXT,
        archive_path TEXT,
        retention_days INTEGER,
        expires_at TEXT,
        source_version INTEGER,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recording_files (
        session_token TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_size_bytes INTEGER NOT NULL DEFAULT 0,
        modified_at TEXT,
        PRIMARY KEY (session_token, file_name),
        FOREIGN KEY (session_token) REFERENCES recording_sessions(token) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_recording_sessions_guild_completed
        ON recording_sessions(guild_id, completed_at DESC, started_at DESC);

      CREATE TABLE IF NOT EXISTS playback_snapshots (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        controller_channel_id TEXT,
        panel_queue_visible INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0,
        current_track_json TEXT,
        queue_json TEXT NOT NULL DEFAULT '[]',
        history_json TEXT NOT NULL DEFAULT '[]',
        saved_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS radio_states (
        guild_id TEXT PRIMARY KEY,
        active INTEGER NOT NULL DEFAULT 1,
        bound_channel_id TEXT,
        controller_channel_id TEXT,
        seed_query TEXT,
        requested_by TEXT,
        source_mode TEXT,
        min_buffer_tracks INTEGER NOT NULL DEFAULT 3,
        recent_track_keys_json TEXT NOT NULL DEFAULT '[]',
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      PRAGMA user_version = 1;
    `);
  }

  const statements = {
    deleteAllRecordingFiles: db.prepare("DELETE FROM recording_files"),
    deleteAllRecordingSessions: db.prepare("DELETE FROM recording_sessions"),
    deleteRecordingSession: db.prepare("DELETE FROM recording_sessions WHERE token = ?"),
    upsertRecordingSession: db.prepare(`
      INSERT INTO recording_sessions (
        token,
        directory_path,
        guild_id,
        guild_name,
        channel_id,
        channel_name,
        started_at,
        completed_at,
        participant_ids_json,
        authorized_user_ids_json,
        speaker_user_ids_json,
        files_json,
        archived,
        archive_name,
        archive_path,
        retention_days,
        expires_at,
        source_version,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET
        directory_path = excluded.directory_path,
        guild_id = excluded.guild_id,
        guild_name = excluded.guild_name,
        channel_id = excluded.channel_id,
        channel_name = excluded.channel_name,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        participant_ids_json = excluded.participant_ids_json,
        authorized_user_ids_json = excluded.authorized_user_ids_json,
        speaker_user_ids_json = excluded.speaker_user_ids_json,
        files_json = excluded.files_json,
        archived = excluded.archived,
        archive_name = excluded.archive_name,
        archive_path = excluded.archive_path,
        retention_days = excluded.retention_days,
        expires_at = excluded.expires_at,
        source_version = excluded.source_version,
        updated_at = excluded.updated_at
    `),
    deleteRecordingFilesBySession: db.prepare("DELETE FROM recording_files WHERE session_token = ?"),
    insertRecordingFile: db.prepare(`
      INSERT INTO recording_files (session_token, file_name, file_size_bytes, modified_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_token, file_name) DO UPDATE SET
        file_size_bytes = excluded.file_size_bytes,
        modified_at = excluded.modified_at
    `),
    countRecordingSessions: db.prepare("SELECT COUNT(*) AS count FROM recording_sessions"),
    listRecordingSessions: db.prepare(`
      SELECT *
      FROM recording_sessions
      ORDER BY COALESCE(completed_at, started_at) DESC, token DESC
    `),
    getRecordingSession: db.prepare("SELECT * FROM recording_sessions WHERE token = ?"),
    getLatestRecordingSessionForGuild: db.prepare(`
      SELECT *
      FROM recording_sessions
      WHERE guild_id = ? AND completed_at IS NOT NULL
      ORDER BY completed_at DESC, started_at DESC, token DESC
      LIMIT 1
    `),
    listRecordingFiles: db.prepare(`
      SELECT file_name, file_size_bytes, modified_at
      FROM recording_files
      WHERE session_token = ?
      ORDER BY file_name ASC
    `),
    clearPlaybackSnapshots: db.prepare("DELETE FROM playback_snapshots"),
    upsertPlaybackSnapshot: db.prepare(`
      INSERT INTO playback_snapshots (
        guild_id,
        channel_id,
        controller_channel_id,
        panel_queue_visible,
        paused,
        current_track_json,
        queue_json,
        history_json,
        saved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        controller_channel_id = excluded.controller_channel_id,
        panel_queue_visible = excluded.panel_queue_visible,
        paused = excluded.paused,
        current_track_json = excluded.current_track_json,
        queue_json = excluded.queue_json,
        history_json = excluded.history_json,
        saved_at = excluded.saved_at
    `),
    loadPlaybackSnapshots: db.prepare(`
      SELECT *
      FROM playback_snapshots
      ORDER BY saved_at ASC, guild_id ASC
    `),
    deleteRadioState: db.prepare("DELETE FROM radio_states WHERE guild_id = ?"),
    upsertRadioState: db.prepare(`
      INSERT INTO radio_states (
        guild_id,
        active,
        bound_channel_id,
        controller_channel_id,
        seed_query,
        requested_by,
        source_mode,
        min_buffer_tracks,
        recent_track_keys_json,
        last_error,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        active = excluded.active,
        bound_channel_id = excluded.bound_channel_id,
        controller_channel_id = excluded.controller_channel_id,
        seed_query = excluded.seed_query,
        requested_by = excluded.requested_by,
        source_mode = excluded.source_mode,
        min_buffer_tracks = excluded.min_buffer_tracks,
        recent_track_keys_json = excluded.recent_track_keys_json,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `),
    listActiveRadioStates: db.prepare(`
      SELECT *
      FROM radio_states
      WHERE active = 1
      ORDER BY updated_at ASC, guild_id ASC
    `),
    getRadioState: db.prepare("SELECT * FROM radio_states WHERE guild_id = ?"),
  };

  function withTransaction(task) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = task();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function normalizeRecordingRecord(record) {
    return {
      token: String(record.token),
      directoryPath: String(record.directoryPath),
      guildId: String(record.guildId),
      guildName: typeof record.guildName === "string" ? record.guildName : null,
      channelId: typeof record.channelId === "string" ? record.channelId : null,
      channelName: typeof record.channelName === "string" ? record.channelName : null,
      startedAt: isoOrNull(record.startedAt),
      completedAt: isoOrNull(record.completedAt),
      participantIds: Array.isArray(record.participantIds) ? record.participantIds : [],
      authorizedUserIds: Array.isArray(record.authorizedUserIds) ? record.authorizedUserIds : [],
      speakerUserIds: Array.isArray(record.speakerUserIds) ? record.speakerUserIds : [],
      files: Array.isArray(record.files) ? record.files : [],
      archived: Boolean(record.archived),
      archiveName: typeof record.archiveName === "string" ? record.archiveName : null,
      archivePath: typeof record.archivePath === "string" ? record.archivePath : null,
      retentionDays: Number.isFinite(record.retentionDays) ? record.retentionDays : null,
      expiresAt: isoOrNull(record.expiresAt),
      sourceVersion: Number.isFinite(record.sourceVersion) ? record.sourceVersion : null,
      fileEntries: Array.isArray(record.fileEntries) ? record.fileEntries : [],
      updatedAt: isoOrNull(record.updatedAt) || new Date().toISOString(),
    };
  }

  function writeRecordingRecord(record) {
    const normalized = normalizeRecordingRecord(record);
    statements.upsertRecordingSession.run(
      normalized.token,
      normalized.directoryPath,
      normalized.guildId,
      normalized.guildName,
      normalized.channelId,
      normalized.channelName,
      normalized.startedAt,
      normalized.completedAt,
      json(normalized.participantIds, []),
      json(normalized.authorizedUserIds, []),
      json(normalized.speakerUserIds, []),
      json(normalized.files, []),
      normalized.archived ? 1 : 0,
      normalized.archiveName,
      normalized.archivePath,
      normalized.retentionDays,
      normalized.expiresAt,
      normalized.sourceVersion,
      normalized.updatedAt,
    );
    statements.deleteRecordingFilesBySession.run(normalized.token);
    for (const fileEntry of normalized.fileEntries) {
      statements.insertRecordingFile.run(
        normalized.token,
        String(fileEntry.fileName),
        Number.isFinite(fileEntry.fileSizeBytes) ? fileEntry.fileSizeBytes : 0,
        isoOrNull(fileEntry.modifiedAt),
      );
    }
  }

  function hydrateRecordingRow(row) {
    if (!row) {
      return null;
    }

    return {
      token: row.token,
      directoryPath: row.directory_path,
      guildId: row.guild_id,
      guildName: row.guild_name || null,
      channelId: row.channel_id || null,
      channelName: row.channel_name || null,
      startedAt: row.started_at || null,
      completedAt: row.completed_at || null,
      participantIds: parseJsonArray(row.participant_ids_json),
      authorizedUserIds: parseJsonArray(row.authorized_user_ids_json),
      speakerUserIds: parseJsonArray(row.speaker_user_ids_json),
      files: parseJsonArray(row.files_json),
      archived: Boolean(row.archived),
      archiveName: row.archive_name || null,
      archivePath: row.archive_path || null,
      retentionDays: Number.isFinite(row.retention_days) ? row.retention_days : null,
      expiresAt: row.expires_at || null,
      sourceVersion: Number.isFinite(row.source_version) ? row.source_version : null,
      updatedAt: row.updated_at || null,
      fileEntries: statements.listRecordingFiles.all(row.token).map((fileRow) => ({
        fileName: fileRow.file_name,
        fileSizeBytes: Number.isFinite(fileRow.file_size_bytes) ? fileRow.file_size_bytes : 0,
        modifiedAt: fileRow.modified_at || null,
      })),
    };
  }

  function replaceRecordingSessions(records) {
    const normalizedRecords = Array.isArray(records) ? records : [];
    withTransaction(() => {
      statements.deleteAllRecordingFiles.run();
      statements.deleteAllRecordingSessions.run();
      for (const record of normalizedRecords) {
        writeRecordingRecord(record);
      }
    });
    return normalizedRecords.length;
  }

  function upsertRecordingSession(record) {
    withTransaction(() => {
      writeRecordingRecord(record);
    });
  }

  function countRecordingSessions() {
    return statements.countRecordingSessions.get().count || 0;
  }

  function listRecordingSessions() {
    return statements.listRecordingSessions.all().map(hydrateRecordingRow);
  }

  function getRecordingSession(token) {
    return hydrateRecordingRow(statements.getRecordingSession.get(String(token)));
  }

  function getLatestRecordingSessionForGuild(guildId) {
    return hydrateRecordingRow(statements.getLatestRecordingSessionForGuild.get(String(guildId)));
  }

  function removeRecordingSession(token) {
    statements.deleteRecordingSession.run(String(token));
  }

  function replacePlaybackSnapshots(snapshots) {
    const normalizedSnapshots = Array.isArray(snapshots) ? snapshots : [];
    withTransaction(() => {
      statements.clearPlaybackSnapshots.run();
      for (const snapshot of normalizedSnapshots) {
        statements.upsertPlaybackSnapshot.run(
          String(snapshot.guildId),
          String(snapshot.channelId),
          snapshot.controllerChannelId || null,
          snapshot.panelQueueVisible ? 1 : 0,
          snapshot.paused ? 1 : 0,
          snapshot.current ? json(snapshot.current, null) : null,
          json(Array.isArray(snapshot.queue) ? snapshot.queue : [], []),
          json(Array.isArray(snapshot.history) ? snapshot.history : [], []),
          isoOrNull(snapshot.savedAt) || new Date().toISOString(),
        );
      }
    });
    return normalizedSnapshots.length;
  }

  function loadPlaybackSnapshots() {
    return statements.loadPlaybackSnapshots.all().map((row) => ({
      guildId: row.guild_id,
      channelId: row.channel_id,
      controllerChannelId: row.controller_channel_id || null,
      panelQueueVisible: Boolean(row.panel_queue_visible),
      paused: Boolean(row.paused),
      current: parseJsonObject(row.current_track_json, null),
      queue: parseJsonArray(row.queue_json),
      history: parseJsonArray(row.history_json),
      savedAt: row.saved_at,
    }));
  }

  function clearPlaybackSnapshots() {
    statements.clearPlaybackSnapshots.run();
  }

  function upsertRadioState(radioState) {
    statements.upsertRadioState.run(
      String(radioState.guildId),
      radioState.active === false ? 0 : 1,
      radioState.boundChannelId || null,
      radioState.controllerChannelId || null,
      radioState.seedQuery || null,
      radioState.requestedBy || null,
      radioState.sourceMode || null,
      Number.isFinite(radioState.minBufferTracks) ? radioState.minBufferTracks : 3,
      json(Array.isArray(radioState.recentTrackKeys) ? radioState.recentTrackKeys : [], []),
      radioState.lastError || null,
      isoOrNull(radioState.updatedAt) || new Date().toISOString(),
    );
  }

  function getRadioState(guildId) {
    const row = statements.getRadioState.get(String(guildId));
    if (!row) {
      return null;
    }

    return {
      guildId: row.guild_id,
      active: Boolean(row.active),
      boundChannelId: row.bound_channel_id || null,
      controllerChannelId: row.controller_channel_id || null,
      seedQuery: row.seed_query || null,
      requestedBy: row.requested_by || null,
      sourceMode: row.source_mode || null,
      minBufferTracks: Number.isFinite(row.min_buffer_tracks) ? row.min_buffer_tracks : 3,
      recentTrackKeys: parseJsonArray(row.recent_track_keys_json),
      lastError: row.last_error || null,
      updatedAt: row.updated_at || null,
    };
  }

  function listActiveRadioStates() {
    return statements.listActiveRadioStates.all().map((row) => ({
      guildId: row.guild_id,
      active: Boolean(row.active),
      boundChannelId: row.bound_channel_id || null,
      controllerChannelId: row.controller_channel_id || null,
      seedQuery: row.seed_query || null,
      requestedBy: row.requested_by || null,
      sourceMode: row.source_mode || null,
      minBufferTracks: Number.isFinite(row.min_buffer_tracks) ? row.min_buffer_tracks : 3,
      recentTrackKeys: parseJsonArray(row.recent_track_keys_json),
      lastError: row.last_error || null,
      updatedAt: row.updated_at || null,
    }));
  }

  function clearRadioState(guildId) {
    statements.deleteRadioState.run(String(guildId));
  }

  function close() {
    db.close();
  }

  logger?.info?.(`SQLite state store ready at ${dbPath}`);

  return {
    clearPlaybackSnapshots,
    clearRadioState,
    close,
    countRecordingSessions,
    dbPath,
    getLatestRecordingSessionForGuild,
    getRadioState,
    getRecordingSession,
    listActiveRadioStates,
    listRecordingSessions,
    loadPlaybackSnapshots,
    removeRecordingSession,
    replacePlaybackSnapshots,
    replaceRecordingSessions,
    upsertRadioState,
    upsertRecordingSession,
  };
}

module.exports = {
  createSqliteStateStore,
};
