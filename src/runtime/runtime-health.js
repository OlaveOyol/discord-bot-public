function getMeaningfulActivityCooldownRemainingMs(activityTracker, globalIdleCommandCooldownMs, now = Date.now()) {
  if (!Number.isFinite(activityTracker?.lastMeaningfulActivityAt)) {
    return 0;
  }

  return Math.max(0, activityTracker.lastMeaningfulActivityAt + globalIdleCommandCooldownMs - now);
}

function getGuildActivityFlags(state) {
  return {
    recording: Boolean(state?.recording),
    playback: Boolean(state?.current || state?.isPlaying?.() || state?.isPaused?.()),
    queueActive: Boolean(state?.queue?.length > 0 || state?.playingNext),
  };
}

function summarizeIdleBlockers(blockers) {
  return blockers.map((blocker) => {
    switch (blocker.type) {
      case "active_recordings":
        return `${blocker.count} active recording ${blocker.count === 1 ? "session" : "sessions"}`;
      case "active_playback":
        return `${blocker.count} active playback ${blocker.count === 1 ? "session" : "sessions"}`;
      case "queue_active":
        return `${blocker.count} ${blocker.count === 1 ? "guild has" : "guilds have"} queued playback`;
      case "applying_update":
        return "update apply in progress";
      case "recent_activity":
        return `recent activity cooldown (${Math.ceil(blocker.remainingMs / 1000)}s remaining)`;
      default:
        return blocker.type;
    }
  });
}

function createRuntimeHealthModel({
  runtimeVersion,
  runtimeLifecycle,
  activityTracker,
  getGuildStates,
  getPendingUpdate,
  isApplyingUpdate,
  globalIdleCommandCooldownMs,
  globalIdleCommandCooldownSeconds,
  getUptimeSeconds,
}) {
  function getGlobalIdleState(now = Date.now()) {
    const blockers = [];
    const states = [...getGuildStates()];
    const recordingGuildIds = states.filter((state) => getGuildActivityFlags(state).recording).map((state) => state.guildId);
    const playbackGuildIds = states.filter((state) => getGuildActivityFlags(state).playback).map((state) => state.guildId);
    const queueGuildIds = states.filter((state) => getGuildActivityFlags(state).queueActive).map((state) => state.guildId);
    const cooldownRemainingMs = getMeaningfulActivityCooldownRemainingMs(activityTracker, globalIdleCommandCooldownMs, now);

    if (recordingGuildIds.length > 0) {
      blockers.push({
        type: "active_recordings",
        count: recordingGuildIds.length,
        guildIds: recordingGuildIds,
      });
    }

    if (playbackGuildIds.length > 0) {
      blockers.push({
        type: "active_playback",
        count: playbackGuildIds.length,
        guildIds: playbackGuildIds,
      });
    }

    if (queueGuildIds.length > 0) {
      blockers.push({
        type: "queue_active",
        count: queueGuildIds.length,
        guildIds: queueGuildIds,
      });
    }

    if (isApplyingUpdate()) {
      blockers.push({ type: "applying_update" });
    }

    if (cooldownRemainingMs > 0) {
      blockers.push({
        type: "recent_activity",
        remainingMs: cooldownRemainingMs,
        reason: activityTracker.lastMeaningfulActivityReason,
        lastActivityAt: new Date(activityTracker.lastMeaningfulActivityAt).toISOString(),
      });
    }

    return {
      idle: blockers.length === 0,
      blockers,
      lastMeaningfulActivityAt: Number.isFinite(activityTracker.lastMeaningfulActivityAt)
        ? new Date(activityTracker.lastMeaningfulActivityAt).toISOString()
        : null,
      lastMeaningfulActivityReason: activityTracker.lastMeaningfulActivityReason,
      cooldownRemainingMs,
    };
  }

  function getPendingUpdatePolicy(now = Date.now()) {
    const pendingUpdate = getPendingUpdate() ? { ...getPendingUpdate() } : null;
    const idleState = getGlobalIdleState(now);
    if (!pendingUpdate) {
      return {
        pendingUpdate: null,
        idleState,
        securityDrainActive: false,
        applyReady: false,
        forceApply: false,
        canStartLongLivedActions: !isApplyingUpdate(),
        phase: isApplyingUpdate() ? "applying" : "none",
      };
    }

    const deadlineMs = pendingUpdate.forcedApplyDeadline ? Date.parse(pendingUpdate.forcedApplyDeadline) : null;
    const forceApply = Number.isFinite(deadlineMs) ? now >= deadlineMs : false;
    const staged = Boolean(pendingUpdate.staged);
    const applyReady = staged && (forceApply || pendingUpdate.applyAfterIdle === false || idleState.idle);
    const securityDrainActive = pendingUpdate.severity === "security" && staged && !isApplyingUpdate();

    return {
      pendingUpdate,
      idleState,
      securityDrainActive,
      applyReady,
      forceApply,
      canStartLongLivedActions: !securityDrainActive && !isApplyingUpdate(),
      phase: isApplyingUpdate() ? "applying" : securityDrainActive ? "draining" : "pending",
    };
  }

  function getRuntimeHealthStatus(now = Date.now()) {
    if (runtimeLifecycle.unhealthyReason) {
      return "unhealthy";
    }
    if (isApplyingUpdate()) {
      return "applying_update";
    }
    if (!runtimeLifecycle.readyAt) {
      return "starting";
    }
    return getPendingUpdatePolicy(now).securityDrainActive ? "draining_for_update" : "ready";
  }

  function buildHealthSnapshot(now = Date.now()) {
    const idleState = getGlobalIdleState(now);
    const policy = getPendingUpdatePolicy(now);
    const status = getRuntimeHealthStatus(now);
    const safeIdleBlockers = idleState.blockers.map((blocker) => {
      const { guildIds, ...rest } = blocker;
      return rest;
    });
    const safePendingUpdate = policy.pendingUpdate
      ? {
          version: policy.pendingUpdate.version,
          severity: policy.pendingUpdate.severity,
          downloaded: policy.pendingUpdate.downloaded,
          staged: policy.pendingUpdate.staged,
          applyAfterIdle: policy.pendingUpdate.applyAfterIdle,
          detectedAt: policy.pendingUpdate.detectedAt,
          stagedAt: policy.pendingUpdate.stagedAt,
          drainStartedAt: policy.pendingUpdate.drainStartedAt,
          forcedApplyDeadline: policy.pendingUpdate.forcedApplyDeadline,
          preparedAt: policy.pendingUpdate.preparedAt,
          applyingAt: policy.pendingUpdate.applyingAt,
        }
      : null;

    return {
      status,
      ready: status === "ready",
      runtime: {
        ...runtimeVersion,
        pid: process.pid,
        startedAt: runtimeLifecycle.startedAt,
        readyAt: runtimeLifecycle.readyAt,
        uptimeSeconds: getUptimeSeconds(),
      },
      idle: {
        global: idleState.idle,
        blockers: safeIdleBlockers,
        blockerSummary: summarizeIdleBlockers(idleState.blockers),
        cooldownWindowSeconds: globalIdleCommandCooldownSeconds,
        lastMeaningfulActivityAt: idleState.lastMeaningfulActivityAt,
        lastMeaningfulActivityReason: idleState.lastMeaningfulActivityReason,
        cooldownRemainingMs: idleState.cooldownRemainingMs,
      },
      update: {
        pending: safePendingUpdate,
        policy: {
          phase: policy.phase,
          securityDrainActive: policy.securityDrainActive,
          applyReady: policy.applyReady,
          forceApply: policy.forceApply,
          canStartLongLivedActions: policy.canStartLongLivedActions,
        },
      },
      errors: {
        unhealthyReason: runtimeLifecycle.unhealthyReason,
        unhealthyAt: runtimeLifecycle.unhealthyAt,
        lastClientError: runtimeLifecycle.lastClientError,
        lastClientErrorAt: runtimeLifecycle.lastClientErrorAt,
      },
    };
  }

  return {
    buildHealthSnapshot,
    getGlobalIdleState,
    getPendingUpdatePolicy,
    getRuntimeHealthStatus,
    summarizeIdleBlockers,
  };
}

module.exports = {
  createRuntimeHealthModel,
  getGuildActivityFlags,
  getMeaningfulActivityCooldownRemainingMs,
  summarizeIdleBlockers,
};
