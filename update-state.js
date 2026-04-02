const path = require("node:path");
const fsp = require("node:fs/promises");

function normalizeString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeBoolean(value, fallback = false) {
  return value === undefined ? fallback : Boolean(value);
}

function normalizeIsoDate(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizePositiveInteger(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeSha256(value) {
  const cleaned = normalizeString(value);
  if (!cleaned) {
    return null;
  }

  const lowered = cleaned.toLowerCase();
  return /^[a-f0-9]{64}$/.test(lowered) ? lowered : null;
}

function normalizeSeverity(value) {
  return String(value || "").toLowerCase() === "security" ? "security" : "normal";
}

function normalizePendingUpdate(input, { existing = null, now = Date.now(), defaultSecurityDrainMs = 120_000 } = {}) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const version = normalizeString(input.version);
  if (!version) {
    return null;
  }

  const severity = normalizeSeverity(input.severity ?? existing?.severity);
  const downloaded = normalizeBoolean(input.downloaded, Boolean(existing?.downloaded));
  const staged = normalizeBoolean(input.staged, downloaded || Boolean(existing?.staged));
  const applyAfterIdle = normalizeBoolean(input.applyAfterIdle, existing?.applyAfterIdle ?? true);
  const detectedAt = normalizeIsoDate(input.detectedAt) || existing?.detectedAt || new Date(now).toISOString();
  const stagedAt = staged
    ? normalizeIsoDate(input.stagedAt) || existing?.stagedAt || new Date(now).toISOString()
    : null;

  const drainTimeoutMs = severity === "security"
    ? normalizePositiveInteger(input.drainTimeoutMs, existing?.drainTimeoutMs || defaultSecurityDrainMs)
    : null;

  let drainStartedAt = severity === "security" && staged
    ? normalizeIsoDate(input.drainStartedAt) || existing?.drainStartedAt || new Date(now).toISOString()
    : null;
  let forcedApplyDeadline = severity === "security" && staged
    ? normalizeIsoDate(input.forcedApplyDeadline) || existing?.forcedApplyDeadline || null
    : null;

  if (severity === "security" && staged && !forcedApplyDeadline && drainStartedAt && drainTimeoutMs) {
    forcedApplyDeadline = new Date(Date.parse(drainStartedAt) + drainTimeoutMs).toISOString();
  }

  if (severity !== "security") {
    drainStartedAt = null;
    forcedApplyDeadline = null;
  }

  return {
    version,
    severity,
    downloaded,
    staged,
    applyAfterIdle,
    detectedAt,
    stagedAt,
    drainStartedAt,
    forcedApplyDeadline,
    drainTimeoutMs,
    artifactPath: normalizeString(input.artifactPath) || existing?.artifactPath || null,
    artifactSha256: normalizeSha256(input.artifactSha256) || existing?.artifactSha256 || null,
    artifactSizeBytes: normalizePositiveInteger(input.artifactSizeBytes, existing?.artifactSizeBytes || null),
    manifestPath: normalizeString(input.manifestPath) || existing?.manifestPath || null,
    manifestSchemaVersion: normalizePositiveInteger(
      input.manifestSchemaVersion,
      existing?.manifestSchemaVersion || null,
    ),
    releaseNotesUrl: normalizeString(input.releaseNotesUrl) || existing?.releaseNotesUrl || null,
    releasedAt: normalizeIsoDate(input.releasedAt) || existing?.releasedAt || null,
    source: normalizeString(input.source) || existing?.source || null,
    preparedAt: normalizeIsoDate(input.preparedAt) || existing?.preparedAt || null,
    applyingAt: normalizeIsoDate(input.applyingAt) || existing?.applyingAt || null,
  };
}

function serializePendingUpdate(pendingUpdate) {
  return JSON.stringify(pendingUpdate || null);
}

function pendingUpdatesEqual(left, right) {
  return serializePendingUpdate(left) === serializePendingUpdate(right);
}

async function loadPersistedPendingUpdate(updateStatePath) {
  const payload = await fsp
    .readFile(updateStatePath, "utf8")
    .then((content) => JSON.parse(content))
    .catch((error) => {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    });

  if (!payload) {
    return null;
  }

  if (payload.pendingUpdate && typeof payload.pendingUpdate === "object") {
    return payload.pendingUpdate;
  }

  return payload;
}

async function writePersistedPendingUpdate(updateStatePath, pendingUpdate) {
  if (!pendingUpdate) {
    await fsp.rm(updateStatePath, { force: true }).catch(() => {});
    return;
  }

  await fsp.mkdir(path.dirname(updateStatePath), { recursive: true });
  const payload = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    pendingUpdate,
  };
  await fsp.writeFile(updateStatePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

module.exports = {
  loadPersistedPendingUpdate,
  normalizePendingUpdate,
  pendingUpdatesEqual,
  serializePendingUpdate,
  writePersistedPendingUpdate,
};
