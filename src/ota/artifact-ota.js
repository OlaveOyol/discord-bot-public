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

function normalizeSeverity(value) {
  return String(value || "").toLowerCase() === "security" ? "security" : "normal";
}

function normalizeSha256(value) {
  const cleaned = normalizeString(value);
  if (!cleaned) {
    return null;
  }

  const lowered = cleaned.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(lowered)) {
    throw new Error("Artifact SHA-256 must be a 64-character hexadecimal string.");
  }
  return lowered;
}

function resolvePath(basePath, targetPath) {
  const cleaned = normalizeString(targetPath);
  if (!cleaned) {
    return null;
  }

  if (path.isAbsolute(cleaned)) {
    return path.normalize(cleaned);
  }

  if (basePath) {
    return path.resolve(path.dirname(basePath), cleaned);
  }

  return path.resolve(cleaned);
}

async function readJsonFile(filePath) {
  return fsp
    .readFile(filePath, "utf8")
    .then((content) => JSON.parse(content))
    .catch((error) => {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    });
}

async function statRegularFile(filePath) {
  if (!filePath) {
    return null;
  }

  const stats = await fsp.stat(filePath).catch((error) => {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  });

  if (!stats) {
    return null;
  }

  if (!stats.isFile()) {
    throw new Error(`Artifact path is not a regular file: ${filePath}`);
  }

  return stats;
}

async function normalizeArtifactManifest(input, { manifestPath = null, now = Date.now() } = {}) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const artifact = input.artifact && typeof input.artifact === "object" ? input.artifact : {};
  const resolvedManifestPath = manifestPath ? path.resolve(manifestPath) : resolvePath(null, input.manifestPath);
  const version = normalizeString(input.version);
  if (!version) {
    throw new Error("Artifact manifest must include a version.");
  }

  const artifactPath = resolvePath(resolvedManifestPath, artifact.path ?? input.artifactPath);
  if (!artifactPath) {
    throw new Error("Artifact manifest must include artifact.path or artifactPath.");
  }

  const artifactSha256 = normalizeSha256(artifact.sha256 ?? input.artifactSha256);
  let artifactSizeBytes = normalizePositiveInteger(artifact.sizeBytes ?? input.artifactSizeBytes, null);
  const artifactStats = await statRegularFile(artifactPath);
  if (artifactSizeBytes && artifactStats && artifactStats.size !== artifactSizeBytes) {
    throw new Error(
      `Artifact size mismatch for ${artifactPath}: manifest=${artifactSizeBytes} actual=${artifactStats.size}.`,
    );
  }
  if (!artifactSizeBytes && artifactStats) {
    artifactSizeBytes = artifactStats.size;
  }

  const severity = normalizeSeverity(input.severity);
  const applyAfterIdle = normalizeBoolean(input.applyAfterIdle, true);
  const detectedAt = normalizeIsoDate(input.detectedAt) || normalizeIsoDate(input.releasedAt) || new Date(now).toISOString();
  const stagedAt = artifactStats
    ? normalizeIsoDate(input.stagedAt) || artifactStats.mtime.toISOString()
    : null;

  return {
    version,
    severity,
    downloaded: Boolean(artifactStats),
    staged: Boolean(artifactStats),
    applyAfterIdle,
    detectedAt,
    stagedAt,
    artifactPath,
    artifactSha256,
    artifactSizeBytes,
    manifestPath: resolvedManifestPath,
    manifestSchemaVersion: normalizePositiveInteger(input.schemaVersion, 1) || 1,
    releaseNotesUrl: normalizeString(input.releaseNotesUrl),
    releasedAt: normalizeIsoDate(input.releasedAt),
    source: normalizeString(input.source) || "artifact_manifest",
  };
}

async function loadArtifactManifest(manifestPath, options = {}) {
  const resolvedManifestPath = resolvePath(null, manifestPath);
  if (!resolvedManifestPath) {
    return null;
  }

  const payload = await readJsonFile(resolvedManifestPath);
  if (!payload) {
    return null;
  }

  return normalizeArtifactManifest(payload, {
    ...options,
    manifestPath: resolvedManifestPath,
  });
}

module.exports = {
  loadArtifactManifest,
  normalizeArtifactManifest,
};
