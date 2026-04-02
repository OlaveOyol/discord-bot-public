#!/usr/bin/env node

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const { loadArtifactManifest } = require("../../src/ota/artifact-ota");

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      args._.push(value);
      continue;
    }

    const [rawKey, inlineValue] = value.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      args[rawKey] = inlineValue;
      continue;
    }

    const nextValue = argv[index + 1];
    if (nextValue && !nextValue.startsWith("--")) {
      args[rawKey] = nextValue;
      index += 1;
    } else {
      args[rawKey] = true;
    }
  }
  return args;
}

function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function logInfo(message) {
  process.stderr.write(`${new Date().toISOString()} INFO ota-supervisor - ${message}\n`);
}

function logWarn(message) {
  process.stderr.write(`${new Date().toISOString()} WARN ota-supervisor - ${message}\n`);
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function runCommand(command, args, { cwd = undefined, env = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function fileExists(filePath) {
  return fsp
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

async function ensureReleaseLayout({ appDir, legacyEnvPath }) {
  const releasesDir = path.join(appDir, "releases");
  const sharedDir = path.join(appDir, "shared");
  const stagingDir = path.join(appDir, "staging");
  await Promise.all([ensureDir(releasesDir), ensureDir(sharedDir), ensureDir(stagingDir)]);

  const sharedEnvPath = path.join(sharedDir, ".env");
  if (!(await fileExists(sharedEnvPath)) && legacyEnvPath && (await fileExists(legacyEnvPath))) {
    await fsp.copyFile(legacyEnvPath, sharedEnvPath);
    logInfo(`Copied legacy env file into ${sharedEnvPath}.`);
  }

  return {
    releasesDir,
    sharedDir,
    sharedEnvPath,
    stagingDir,
    currentPath: path.join(appDir, "current"),
  };
}

async function verifyManifestArtifact(manifest) {
  const stats = await fsp.stat(manifest.artifactPath);
  if (!stats.isFile()) {
    throw new Error(`Artifact path is not a file: ${manifest.artifactPath}`);
  }

  if (manifest.artifactSizeBytes && stats.size !== manifest.artifactSizeBytes) {
    throw new Error(
      `Artifact size mismatch: expected ${manifest.artifactSizeBytes}, found ${stats.size} for ${manifest.artifactPath}`,
    );
  }

  if (manifest.artifactSha256) {
    const digest = await sha256File(manifest.artifactPath);
    if (digest !== manifest.artifactSha256) {
      throw new Error(`Artifact checksum mismatch for ${manifest.artifactPath}`);
    }
  }
}

async function copyManifestAndArtifact(manifest, layout) {
  const versionStageDir = path.join(layout.stagingDir, manifest.version);
  await fsp.rm(versionStageDir, { recursive: true, force: true }).catch(() => {});
  await ensureDir(versionStageDir);

  const stagedArtifactPath = path.join(versionStageDir, path.basename(manifest.artifactPath));
  const stagedManifestPath = path.join(versionStageDir, "release-manifest.json");
  await fsp.copyFile(manifest.artifactPath, stagedArtifactPath);

  const stagedManifest = {
    schemaVersion: manifest.manifestSchemaVersion || 1,
    version: manifest.version,
    severity: manifest.severity,
    releasedAt: manifest.releasedAt || manifest.detectedAt || new Date().toISOString(),
    applyAfterIdle: manifest.applyAfterIdle,
    releaseNotesUrl: manifest.releaseNotesUrl || null,
    artifact: {
      path: stagedArtifactPath,
      sha256: manifest.artifactSha256 || null,
      sizeBytes: manifest.artifactSizeBytes || null,
    },
  };
  await fsp.writeFile(stagedManifestPath, `${JSON.stringify(stagedManifest, null, 2)}\n`, "utf8");

  return {
    stagedArtifactPath,
    stagedManifestPath,
    versionStageDir,
  };
}

async function extractRelease(manifest, layout, { appUser = null, appGroup = null } = {}) {
  const versionStageDir = path.join(layout.stagingDir, manifest.version);
  const extractDir = path.join(versionStageDir, "extract");
  await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
  await ensureDir(extractDir);

  await runCommand("tar", ["-xzf", manifest.artifactPath, "-C", extractDir]);

  const topEntries = await fsp.readdir(extractDir, { withFileTypes: true });
  let candidateDir = extractDir;
  if (topEntries.length === 1 && topEntries[0].isDirectory()) {
    candidateDir = path.join(extractDir, topEntries[0].name);
  }
  if (!(await fileExists(path.join(candidateDir, "package.json")))) {
    throw new Error(`Extracted artifact for ${manifest.version} does not contain package.json at its root.`);
  }

  const releaseDir = path.join(layout.releasesDir, manifest.version);
  await fsp.rm(releaseDir, { recursive: true, force: true }).catch(() => {});
  await ensureDir(releaseDir);
  await runCommand("tar", ["-xzf", manifest.artifactPath, "-C", releaseDir]);

  const releaseEntries = await fsp.readdir(releaseDir, { withFileTypes: true }).catch(() => []);
  if (
    releaseEntries.length === 1 &&
    releaseEntries[0].isDirectory() &&
    !(await fileExists(path.join(releaseDir, "package.json")))
  ) {
    const nestedDir = path.join(releaseDir, releaseEntries[0].name);
    if (await fileExists(path.join(nestedDir, "package.json"))) {
      const tempDir = path.join(layout.stagingDir, manifest.version, "normalized-release");
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      await fsp.rename(nestedDir, tempDir);
      await fsp.rm(releaseDir, { recursive: true, force: true }).catch(() => {});
      await fsp.rename(tempDir, releaseDir);
    }
  }

  await runCommand("npm", ["ci", "--omit=dev"], { cwd: releaseDir });
  await runCommand("npm", ["run", "check"], { cwd: releaseDir });
  await fsp.copyFile(path.join(versionStageDir, "release-manifest.json"), path.join(releaseDir, "release-manifest.json"));

  if (appUser) {
    const owner = appGroup ? `${appUser}:${appGroup}` : appUser;
    await runCommand("chown", ["-R", owner, releaseDir]).catch((error) => {
      logWarn(`Could not chown ${releaseDir}: ${error.message}`);
    });
  }

  return releaseDir;
}

async function getSymlinkTarget(linkPath) {
  try {
    const target = await fsp.readlink(linkPath);
    return path.resolve(path.dirname(linkPath), target);
  } catch {
    return null;
  }
}

async function switchCurrentSymlink(currentPath, targetPath) {
  const relativeTarget = path.relative(path.dirname(currentPath), targetPath) || ".";
  await runCommand("ln", ["-sfn", relativeTarget, currentPath]);
}

async function requestJson(method, url, { token = null, body = undefined } = {}) {
  const headers = { Accept: "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((error) => {
    throw new Error(`Request to ${url} failed: ${error.message}`);
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    json,
  };
}

async function waitFor(predicate, { timeoutMs, intervalMs, onTick } = {}) {
  const startedAt = Date.now();
  while (true) {
    const result = await predicate();
    if (result.done) {
      return result.value;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(result.errorMessage || "Timed out waiting for condition.");
    }
    if (onTick) {
      onTick(result);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function defaultUrls(baseUrl) {
  const trimmedBase = String(baseUrl).replace(/\/+$/, "");
  return {
    healthz: `${trimmedBase}/healthz`,
    readyz: `${trimmedBase}/readyz`,
    status: `${trimmedBase}/internal/ota/status`,
    stage: `${trimmedBase}/internal/ota/stage`,
    prepare: `${trimmedBase}/internal/ota/prepare`,
    clear: `${trimmedBase}/internal/ota/clear`,
  };
}

async function waitForApplyEligibility(urls, token, timeoutMs) {
  return waitFor(
    async () => {
      const response = await requestJson("GET", urls.status, { token }).catch((error) => ({
        done: false,
        errorMessage: error.message,
      }));
      if (response.done === false) {
        return response;
      }

      if (!response.ok || !response.json?.update?.policy) {
        return {
          done: false,
          errorMessage: `Supervisor status endpoint returned ${response.status}.`,
        };
      }

      const policy = response.json.update.policy;
      if (policy.applyReady || policy.forceApply) {
        return {
          done: true,
          value: response.json,
        };
      }

      return {
        done: false,
        errorMessage: "Timed out waiting for OTA apply eligibility.",
      };
    },
    {
      timeoutMs,
      intervalMs: 5_000,
    },
  );
}

async function verifyRuntime(urls, token, expectedVersion, timeoutMs) {
  return waitFor(
    async () => {
      const health = await requestJson("GET", urls.healthz, { token }).catch((error) => ({
        done: false,
        errorMessage: error.message,
      }));
      if (health.done === false) {
        return health;
      }

      const runtimeReleaseId = health.json?.runtime?.releaseId || health.json?.runtime?.version || null;
      if (health.ok && runtimeReleaseId === expectedVersion) {
        return {
          done: true,
          value: health.json,
        };
      }

      return {
        done: false,
        errorMessage: `Runtime did not become healthy on version ${expectedVersion}.`,
      };
    },
    {
      timeoutMs,
      intervalMs: 4_000,
    },
  );
}

async function restartService(serviceName) {
  await runCommand("systemctl", ["restart", serviceName]);
}

async function maybeStageAndPrepare(urls, token, manifestPath, manifest, { timeoutMs, allowBootstrap }) {
  const statusResponse = await requestJson("GET", urls.status, { token }).catch(() => null);
  if (!statusResponse?.ok || !statusResponse.json?.update) {
    if (allowBootstrap) {
      logWarn("Existing runtime did not expose the OTA supervisor contract; continuing in bootstrap mode.");
      return { bootstrap: true };
    }
    throw new Error("Runtime OTA status endpoint is unavailable.");
  }

  const stageResponse = await requestJson("POST", urls.stage, {
    token,
    body: { manifestPath },
  });
  if (!stageResponse.ok && stageResponse.status !== 202 && stageResponse.status !== 200) {
    throw new Error(`Failed to stage OTA update: ${JSON.stringify(stageResponse.json)}`);
  }

  logInfo(`Staged OTA update ${manifest.version}; waiting for apply eligibility.`);
  await waitForApplyEligibility(urls, token, timeoutMs);

  const prepareResponse = await requestJson("POST", urls.prepare, {
    token,
    body: { reason: `Applying staged artifact ${manifest.version}` },
  });
  if (!prepareResponse.ok || !prepareResponse.json?.prepared) {
    throw new Error(`Failed to prepare OTA update: ${JSON.stringify(prepareResponse.json)}`);
  }

  return {
    bootstrap: false,
    prepareResponse: prepareResponse.json,
  };
}

async function tryClearPendingUpdate(urls, token) {
  const response = await requestJson("POST", urls.clear, {
    token,
    body: { force: true },
  }).catch(() => null);
  if (!response?.ok) {
    logWarn("Could not clear pending OTA state after rollback; manual clear may be required.");
  }
}

async function applyRelease(args) {
  const manifestPath = normalizeString(args.manifest, null);
  if (!manifestPath) {
    throw new Error("Usage: ota-supervisor.js apply --manifest <manifest-path>");
  }

  const appDir = path.resolve(normalizeString(args["app-dir"], process.env.APP_DIR || "/opt/discord-bot"));
  const appUser = normalizeString(args["app-user"], process.env.APP_USER || null);
  const appGroup = normalizeString(args["app-group"], process.env.APP_GROUP || appUser || null);
  const serviceName = normalizeString(args["service-name"], process.env.SERVICE_NAME || "discord-bot");
  const otaBaseUrl = normalizeString(args["ota-base-url"], process.env.OTA_BASE_URL || "http://127.0.0.1:8765");
  const token = normalizeString(args["supervisor-token"], process.env.SUPERVISOR_TOKEN || null);
  const timeoutMs = normalizeInteger(args["wait-timeout-seconds"], 900) * 1000;
  const verifyTimeoutMs = normalizeInteger(args["verify-timeout-seconds"], 120) * 1000;
  const allowBootstrap = args.bootstrap !== "false";
  const legacyEnvPath = normalizeString(args["legacy-env-path"], path.join(appDir, ".env"));
  const urls = defaultUrls(otaBaseUrl);

  const manifest = await loadArtifactManifest(manifestPath);
  if (!manifest) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  logInfo(`Verifying artifact ${manifest.artifactPath} for version ${manifest.version}.`);
  await verifyManifestArtifact(manifest);

  const layout = await ensureReleaseLayout({ appDir, legacyEnvPath });
  const staged = await copyManifestAndArtifact(manifest, layout);
  const stagedManifest = await loadArtifactManifest(staged.stagedManifestPath);
  await verifyManifestArtifact(stagedManifest);

  logInfo(`Extracting and installing staged release ${stagedManifest.version}.`);
  const releaseDir = await extractRelease(stagedManifest, layout, { appUser, appGroup });

  const previousTarget = await getSymlinkTarget(layout.currentPath);
  const prepareResult = await maybeStageAndPrepare(
    urls,
    token,
    staged.stagedManifestPath,
    stagedManifest,
    { timeoutMs, allowBootstrap },
  );

  try {
    logInfo(`Switching ${layout.currentPath} to ${releaseDir}.`);
    await switchCurrentSymlink(layout.currentPath, releaseDir);
    if (appUser) {
      const owner = appGroup ? `${appUser}:${appGroup}` : appUser;
      await runCommand("chown", ["-h", owner, layout.currentPath]).catch((error) => {
        logWarn(`Could not chown ${layout.currentPath}: ${error.message}`);
      });
    }

    logInfo(`Restarting ${serviceName}.`);
    await restartService(serviceName);
    await verifyRuntime(urls, token, stagedManifest.version, verifyTimeoutMs);

    logInfo(`Release ${stagedManifest.version} is active and healthy.`);
    process.stdout.write(
      `${JSON.stringify(
        {
          applied: true,
          version: stagedManifest.version,
          bootstrap: prepareResult.bootstrap,
          releaseDir,
          currentPath: layout.currentPath,
          manifestPath: staged.stagedManifestPath,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    logWarn(`Apply failed: ${error.message}`);
    if (previousTarget) {
      logWarn(`Rolling back to ${previousTarget}.`);
      await switchCurrentSymlink(layout.currentPath, previousTarget);
      await restartService(serviceName).catch((restartError) => {
        logWarn(`Rollback restart failed: ${restartError.message}`);
      });
      await tryClearPendingUpdate(urls, token);
    }
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "apply";
  switch (command) {
    case "apply":
      await applyRelease(args);
      return;
    default:
      throw new Error(`Unsupported command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
