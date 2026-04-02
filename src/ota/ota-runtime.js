const path = require("node:path");

const { loadArtifactManifest, normalizeArtifactManifest } = require("./artifact-ota");
const { createRuntimeHealthModel } = require("../runtime/runtime-health");
const {
  loadPersistedPendingUpdate,
  normalizePendingUpdate,
  pendingUpdatesEqual,
  writePersistedPendingUpdate,
} = require("./update-state");

function createOtaRuntime({
  logger,
  runtimeVersion,
  formatRuntimeVersion,
  updateStatePath,
  updateManifestPath,
  globalIdleCommandCooldownMs,
  globalIdleCommandCooldownSeconds,
  securityUpdateDrainMs,
  supervisorPrepareTimeoutMs,
  supervisorPrepareTimeoutSeconds,
  supervisorToken,
  supervisorContractVersion,
  loopbackRemoteAddresses,
  formatDateTime,
  getGuildStates,
  getUptimeSeconds,
  savePlaybackSnapshot,
  finalizeActiveUpdateWork,
}) {
  const runtimeLifecycle = {
    startedAt: new Date().toISOString(),
    readyAt: null,
    unhealthyReason: null,
    unhealthyAt: null,
    lastClientError: null,
    lastClientErrorAt: null,
  };

  const activityTracker = {
    lastMeaningfulActivityAt: null,
    lastMeaningfulActivityReason: "startup",
  };

  const updateCoordinator = {
    pendingUpdate: null,
    syncPromise: null,
    applyingUpdate: false,
    lastLoggedPolicyKey: null,
  };

  const healthModel = createRuntimeHealthModel({
    runtimeVersion,
    runtimeLifecycle,
    activityTracker,
    getGuildStates,
    getPendingUpdate: () => updateCoordinator.pendingUpdate,
    isApplyingUpdate: () => updateCoordinator.applyingUpdate,
    globalIdleCommandCooldownMs,
    globalIdleCommandCooldownSeconds,
    getUptimeSeconds,
  });

  function setRuntimeReady() {
    if (!runtimeLifecycle.readyAt) {
      runtimeLifecycle.readyAt = new Date().toISOString();
    }
  }

  function recordClientError(error) {
    runtimeLifecycle.lastClientError = error?.message || String(error || "Unknown client error");
    runtimeLifecycle.lastClientErrorAt = new Date().toISOString();
  }

  function trackMeaningfulActivity(reason) {
    activityTracker.lastMeaningfulActivityAt = Date.now();
    activityTracker.lastMeaningfulActivityReason = reason;
  }

  function normalizeRemoteAddress(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function isLoopbackRequest(req) {
    return loopbackRemoteAddresses.has(normalizeRemoteAddress(req.socket?.remoteAddress));
  }

  function getSupervisorAuthToken(req) {
    const authorization = String(req.headers.authorization || "");
    if (/^Bearer\s+/i.test(authorization)) {
      return authorization.replace(/^Bearer\s+/i, "").trim();
    }

    const headerToken = req.headers["x-supervisor-token"];
    return typeof headerToken === "string" ? headerToken.trim() : "";
  }

  function requireSupervisorAccess(req, res) {
    if (!isLoopbackRequest(req)) {
      res.status(403).json({ error: "Supervisor routes are loopback-only." });
      return false;
    }

    if (supervisorToken && getSupervisorAuthToken(req) !== supervisorToken) {
      res.status(401).json({ error: "Supervisor token is invalid." });
      return false;
    }

    return true;
  }

  function matchesCurrentRuntimeVersion(pendingUpdate) {
    return pendingUpdate?.version === runtimeVersion.releaseId || pendingUpdate?.version === runtimeVersion.version;
  }

  function buildSupervisorSnapshot(now = Date.now()) {
    const health = healthModel.buildHealthSnapshot(now);
    const policy = healthModel.getPendingUpdatePolicy(now);

    return {
      contractVersion: supervisorContractVersion,
      runtimeVersion: formatRuntimeVersion(),
      currentVersion: runtimeVersion.version,
      currentReleaseId: runtimeVersion.releaseId,
      health,
      update: {
        pending: updateCoordinator.pendingUpdate,
        policy: {
          phase: policy.phase,
          securityDrainActive: policy.securityDrainActive,
          applyReady: policy.applyReady,
          forceApply: policy.forceApply,
          canStartLongLivedActions: policy.canStartLongLivedActions,
        },
        statePath: updateStatePath,
        manifestPath: updateManifestPath,
      },
      supervisor: {
        loopbackOnly: true,
        tokenRequired: Boolean(supervisorToken),
        prepareTimeoutSeconds: supervisorPrepareTimeoutSeconds,
        expectedNextAction: policy.applyReady || policy.forceApply
          ? "prepare then external restart into staged artifact"
          : "stage artifact and wait for readiness policy",
      },
    };
  }

  async function persistPendingUpdateState(pendingUpdate, { reason = null } = {}) {
    updateCoordinator.pendingUpdate = pendingUpdate;
    if (reason) {
      logger.info(reason);
    }
    await writePersistedPendingUpdate(updateStatePath, pendingUpdate);
    logPendingUpdatePolicy(healthModel.getPendingUpdatePolicy());
    return updateCoordinator.pendingUpdate;
  }

  async function clearPendingUpdateState(reason) {
    return persistPendingUpdateState(null, { reason });
  }

  async function loadAutoManifestPendingUpdate(existingPendingUpdate) {
    const manifestUpdate = await loadArtifactManifest(updateManifestPath, {
      now: Date.now(),
    });
    if (!manifestUpdate) {
      return null;
    }

    return normalizePendingUpdate(
      {
        ...manifestUpdate,
        source: "artifact_manifest",
      },
      {
        existing: existingPendingUpdate,
        now: Date.now(),
        defaultSecurityDrainMs: securityUpdateDrainMs,
      },
    );
  }

  async function resolveStageRequestPayload(body = {}) {
    const requestedManifestPath =
      typeof body.manifestPath === "string" && body.manifestPath.trim().length > 0
        ? body.manifestPath
        : updateManifestPath;

    if (body.manifestPath || (!body.manifest && Object.keys(body).length === 0)) {
      const manifestUpdate = await loadArtifactManifest(requestedManifestPath, {
        now: Date.now(),
      });
      if (!manifestUpdate) {
        throw new Error(`Artifact manifest not found at ${path.resolve(String(requestedManifestPath))}.`);
      }

      return normalizePendingUpdate(
        {
          ...manifestUpdate,
          source: "supervisor_api",
        },
        {
          existing: updateCoordinator.pendingUpdate,
          now: Date.now(),
          defaultSecurityDrainMs: securityUpdateDrainMs,
        },
      );
    }

    const manifestPayload =
      body.manifest && typeof body.manifest === "object"
        ? await normalizeArtifactManifest(body.manifest, { now: Date.now() })
        : normalizePendingUpdate(body, {
            existing: updateCoordinator.pendingUpdate,
            now: Date.now(),
            defaultSecurityDrainMs: securityUpdateDrainMs,
          });

    if (!manifestPayload) {
      throw new Error("Supervisor stage request did not include a valid manifest or pending update payload.");
    }
    if (!manifestPayload.artifactPath) {
      throw new Error("Supervisor stage request must include a staged artifact path.");
    }

    return normalizePendingUpdate(
      {
        ...manifestPayload,
        source: "supervisor_api",
      },
      {
        existing: updateCoordinator.pendingUpdate,
        now: Date.now(),
        defaultSecurityDrainMs: securityUpdateDrainMs,
      },
    );
  }

  function logPendingUpdatePolicy(policy) {
    const key = JSON.stringify({
      version: policy.pendingUpdate?.version || null,
      severity: policy.pendingUpdate?.severity || null,
      phase: policy.phase,
      applyReady: policy.applyReady,
      forceApply: policy.forceApply,
      idle: policy.idleState.idle,
    });
    if (updateCoordinator.lastLoggedPolicyKey === key) {
      return;
    }

    updateCoordinator.lastLoggedPolicyKey = key;
    if (!policy.pendingUpdate) {
      logger.info("No pending OTA update is currently staged.");
      return;
    }

    logger.info(
      `Pending OTA update ${policy.pendingUpdate.version} (${policy.pendingUpdate.severity}) phase=${policy.phase} ` +
        `applyReady=${policy.applyReady} forceApply=${policy.forceApply} idle=${policy.idleState.idle}`,
    );
  }

  async function syncPendingUpdateState() {
    if (updateCoordinator.syncPromise) {
      return updateCoordinator.syncPromise;
    }

    updateCoordinator.syncPromise = (async () => {
      try {
        const persisted = await loadPersistedPendingUpdate(updateStatePath);
        const normalizedPersisted = normalizePendingUpdate(persisted, {
          existing: updateCoordinator.pendingUpdate,
          now: Date.now(),
          defaultSecurityDrainMs: securityUpdateDrainMs,
        });
        const manifestUpdate = await loadAutoManifestPendingUpdate(normalizedPersisted);
        let normalized = normalizedPersisted;

        if (
          manifestUpdate &&
          (
            !normalized ||
            normalized.source === "artifact_manifest" ||
            normalized.version === manifestUpdate.version
          )
        ) {
          normalized = manifestUpdate;
        } else if (!manifestUpdate && normalized?.source === "artifact_manifest" && !normalized.applyingAt) {
          normalized = null;
        }

        if (matchesCurrentRuntimeVersion(normalized)) {
          logger.info(`Runtime version ${runtimeVersion.version} matches the staged OTA update; clearing pending update state.`);
          normalized = null;
        }

        if (!pendingUpdatesEqual(updateCoordinator.pendingUpdate, normalized)) {
          if (!normalized && updateCoordinator.pendingUpdate) {
            logger.info("Cleared pending OTA update state.");
          } else if (!updateCoordinator.pendingUpdate || updateCoordinator.pendingUpdate.version !== normalized.version) {
            logger.info(
              `Loaded pending OTA update ${normalized.version} (${normalized.severity}) from ${normalized.source || "state"}.`,
            );
          }
          updateCoordinator.pendingUpdate = normalized;
        }

        if (!pendingUpdatesEqual(normalizedPersisted, normalized)) {
          await writePersistedPendingUpdate(updateStatePath, normalized);
        }

        logPendingUpdatePolicy(healthModel.getPendingUpdatePolicy());
        return updateCoordinator.pendingUpdate;
      } catch (error) {
        logger.warn(`Failed to synchronize pending OTA update state: ${error.message}`);
        return updateCoordinator.pendingUpdate;
      }
    })().finally(() => {
      updateCoordinator.syncPromise = null;
    });

    return updateCoordinator.syncPromise;
  }

  function getLongLivedActionBlockReason(actionDescription) {
    const policy = healthModel.getPendingUpdatePolicy();
    if (updateCoordinator.applyingUpdate) {
      return `Cannot ${actionDescription} while an update is applying.`;
    }

    if (!policy.securityDrainActive || !policy.pendingUpdate) {
      return null;
    }

    const deadlineText = policy.pendingUpdate.forcedApplyDeadline
      ? ` Forced apply deadline: ${formatDateTime(policy.pendingUpdate.forcedApplyDeadline)}.`
      : "";
    return (
      `Cannot ${actionDescription} while security update ${policy.pendingUpdate.version} is draining.` +
      ` New playback and recordings are temporarily blocked.${deadlineText}`
    );
  }

  function assertLongLivedActionAllowed(actionDescription) {
    const reason = getLongLivedActionBlockReason(actionDescription);
    if (reason) {
      throw new Error(reason);
    }
  }

  async function prepareForPendingUpdateApply({ force = false, reason = "pending update apply" } = {}) {
    await syncPendingUpdateState();
    const policy = healthModel.getPendingUpdatePolicy();
    if (!policy.pendingUpdate) {
      return {
        prepared: false,
        reason: "no_pending_update",
        supervisor: buildSupervisorSnapshot(),
      };
    }
    if (!policy.pendingUpdate.artifactPath) {
      return {
        prepared: false,
        reason: "missing_artifact_path",
        supervisor: buildSupervisorSnapshot(),
      };
    }
    if (updateCoordinator.applyingUpdate) {
      return {
        prepared: true,
        alreadyApplying: true,
        version: updateCoordinator.pendingUpdate.version,
        supervisor: buildSupervisorSnapshot(),
      };
    }
    if (!policy.applyReady && !force) {
      return {
        prepared: false,
        reason: "update_not_ready",
        blockers: policy.idleState.blockers,
        supervisor: buildSupervisorSnapshot(),
      };
    }

    updateCoordinator.applyingUpdate = true;
    const preparedPendingUpdate = {
      ...policy.pendingUpdate,
      applyingAt: new Date().toISOString(),
      preparedAt: new Date().toISOString(),
    };
    await persistPendingUpdateState(preparedPendingUpdate);

    logger.info(`Preparing supervised restart for ${reason}.`);
    try {
      await savePlaybackSnapshot();
    } catch (error) {
      logger.warn(`Failed to save playback snapshot before update apply: ${error.message}`);
    }

    const { finalizedRecordings = 0 } = await finalizeActiveUpdateWork();

    return {
      prepared: true,
      version: updateCoordinator.pendingUpdate.version,
      finalizedRecordings,
      applyBySupervisorBefore: new Date(Date.now() + supervisorPrepareTimeoutMs).toISOString(),
      restart: {
        required: true,
        mode: "external_supervisor",
        artifactPath: updateCoordinator.pendingUpdate.artifactPath || null,
      },
      supervisor: buildSupervisorSnapshot(),
    };
  }

  async function stagePendingUpdateRequest(body = {}) {
    await syncPendingUpdateState();
    if (updateCoordinator.applyingUpdate) {
      return {
        statusCode: 409,
        body: {
          error: "An update is already being prepared for apply.",
          supervisor: buildSupervisorSnapshot(),
        },
      };
    }

    const pendingUpdate = await resolveStageRequestPayload(body);
    if (matchesCurrentRuntimeVersion(pendingUpdate)) {
      await clearPendingUpdateState(`Ignored staged OTA update ${pendingUpdate.version} because this runtime is already current.`);
      return {
        statusCode: 200,
        body: {
          staged: false,
          reason: "already_running_current_version",
          supervisor: buildSupervisorSnapshot(),
        },
      };
    }

    await persistPendingUpdateState(
      pendingUpdate,
      { reason: `Staged OTA update ${pendingUpdate.version} (${pendingUpdate.severity}) via supervisor API.` },
    );
    return {
      statusCode: 202,
      body: {
        staged: true,
        pendingUpdate: updateCoordinator.pendingUpdate,
        supervisor: buildSupervisorSnapshot(),
      },
    };
  }

  async function clearPendingUpdateRequest({ force = false } = {}) {
    if (updateCoordinator.applyingUpdate && !force) {
      return {
        statusCode: 409,
        body: {
          error: "Update apply is in progress. Pass force=true to clear anyway.",
          supervisor: buildSupervisorSnapshot(),
        },
      };
    }

    updateCoordinator.applyingUpdate = false;
    await clearPendingUpdateState("Cleared pending OTA update via supervisor API.");
    return {
      statusCode: 200,
      body: {
        cleared: true,
        supervisor: buildSupervisorSnapshot(),
      },
    };
  }

  return {
    assertLongLivedActionAllowed,
    buildHealthSnapshot: healthModel.buildHealthSnapshot,
    buildSupervisorSnapshot,
    clearPendingUpdateRequest,
    getPendingUpdatePolicy: healthModel.getPendingUpdatePolicy,
    prepareForPendingUpdateApply,
    recordClientError,
    requireSupervisorAccess,
    setRuntimeReady,
    stagePendingUpdateRequest,
    syncPendingUpdateState,
    trackMeaningfulActivity,
  };
}

module.exports = {
  createOtaRuntime,
};
