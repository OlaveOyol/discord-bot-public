function trackKey(track) {
  if (!track || typeof track !== "object") {
    return null;
  }

  const source = track.webpageUrl || track.streamUrl || track.searchQuery || track.title;
  return typeof source === "string" && source.trim().length > 0 ? source.trim().toLowerCase() : null;
}

function createRadioRuntime({
  logger,
  defaultMinBufferTracks,
  recentTracksLimit,
  fetchCandidates,
  persistState,
  clearPersistedState,
  loadPersistedStates,
}) {
  function ensureRadioStateContainer(state) {
    if (!state.radio) {
      state.radio = null;
    }
    return state.radio;
  }

  function buildRuntimeRadioState(state, radioState) {
    return {
      active: radioState?.active !== false,
      boundChannelId: radioState?.boundChannelId || null,
      controllerChannelId: radioState?.controllerChannelId || null,
      seedQuery: radioState?.seedQuery || null,
      requestedBy: radioState?.requestedBy || "radio",
      sourceMode: radioState?.sourceMode || "youtube-related+search",
      minBufferTracks: Number.isFinite(radioState?.minBufferTracks)
        ? Math.max(1, radioState.minBufferTracks)
        : defaultMinBufferTracks,
      recentTrackKeys: Array.isArray(radioState?.recentTrackKeys)
        ? radioState.recentTrackKeys.slice(-recentTracksLimit)
        : [],
      lastError: typeof radioState?.lastError === "string" ? radioState.lastError : null,
      updatedAt: radioState?.updatedAt || new Date().toISOString(),
      refillInFlight: false,
      refillTimer: null,
    };
  }

  async function persistRadioStateForGuild(state) {
    if (!state?.radio?.active) {
      if (state?.guildId) {
        clearPersistedState(state.guildId);
      }
      return;
    }

    await persistState({
      guildId: state.guildId,
      active: true,
      boundChannelId: state.radio.boundChannelId,
      controllerChannelId: state.radio.controllerChannelId,
      seedQuery: state.radio.seedQuery,
      requestedBy: state.radio.requestedBy,
      sourceMode: state.radio.sourceMode,
      minBufferTracks: state.radio.minBufferTracks,
      recentTrackKeys: state.radio.recentTrackKeys,
      lastError: state.radio.lastError,
      updatedAt: state.radio.updatedAt,
    });
  }

  function isActive(state) {
    return Boolean(state?.radio?.active);
  }

  function clearRefillTimer(state) {
    if (state?.radio?.refillTimer) {
      clearTimeout(state.radio.refillTimer);
      state.radio.refillTimer = null;
    }
  }

  function shouldProtectChannel(state, channelId) {
    return Boolean(isActive(state) && state.radio.boundChannelId && state.radio.boundChannelId === channelId);
  }

  function collectReservedTrackKeys(state) {
    const keys = new Set();
    for (const key of state.radio?.recentTrackKeys || []) {
      if (key) {
        keys.add(key);
      }
    }
    if (state.current) {
      const key = trackKey(state.current);
      if (key) {
        keys.add(key);
      }
    }
    for (const item of state.queue || []) {
      const key = trackKey(item);
      if (key) {
        keys.add(key);
      }
    }
    return keys;
  }

  async function start(state, options) {
    state.radio = buildRuntimeRadioState(state, {
      active: true,
      boundChannelId: options.boundChannelId,
      controllerChannelId: options.controllerChannelId || null,
      seedQuery: options.seedQuery,
      requestedBy: options.requestedBy || "radio",
      sourceMode: options.sourceMode || "youtube-related+search",
      minBufferTracks: options.minBufferTracks,
      recentTrackKeys: [],
      lastError: null,
      updatedAt: new Date().toISOString(),
    });
    await persistRadioStateForGuild(state);
  }

  async function restore(state, radioState) {
    state.radio = buildRuntimeRadioState(state, radioState);
    await persistRadioStateForGuild(state);
  }

  async function stop(state) {
    clearRefillTimer(state);
    state.radio = null;
    await persistRadioStateForGuild(state);
  }

  async function noteTrackStarted(state, track) {
    if (!isActive(state)) {
      return;
    }

    const key = trackKey(track);
    if (key) {
      state.radio.recentTrackKeys = [...state.radio.recentTrackKeys.filter((item) => item !== key), key]
        .slice(-recentTracksLimit);
    }
    state.radio.lastError = null;
    state.radio.updatedAt = new Date().toISOString();
    await persistRadioStateForGuild(state);
  }

  async function ensureRefill(state, reason = "unspecified") {
    ensureRadioStateContainer(state);
    if (!isActive(state) || state.radio.refillInFlight) {
      return { added: 0, skipped: true };
    }

    const connectedChannelId = state.connection?.joinConfig?.channelId || null;
    if (!connectedChannelId || (state.radio.boundChannelId && connectedChannelId !== state.radio.boundChannelId)) {
      return { added: 0, skipped: true };
    }

    const upcomingCount = Array.isArray(state.queue) ? state.queue.length : 0;
    const needsPlaybackKick = !state.current && upcomingCount === 0;
    const neededCount = Math.max(0, state.radio.minBufferTracks - upcomingCount);
    if (neededCount <= 0 && !needsPlaybackKick) {
      return { added: 0, skipped: true };
    }

    state.radio.refillInFlight = true;
    try {
      const reservedKeys = collectReservedTrackKeys(state);
      const requestedCount = Math.max(needsPlaybackKick ? 1 : 0, neededCount, 3);
      const candidates = await fetchCandidates({
        state,
        radioState: state.radio,
        reason,
        limit: requestedCount + 4,
        excludeKeys: [...reservedKeys],
      });

      const accepted = [];
      for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const key = trackKey(candidate);
        if (!key || reservedKeys.has(key)) {
          continue;
        }
        reservedKeys.add(key);
        accepted.push(candidate);
        if (accepted.length >= requestedCount) {
          break;
        }
      }

      if (accepted.length === 0) {
        state.radio.lastError = `No radio candidates available for '${state.radio.seedQuery}'.`;
        state.radio.updatedAt = new Date().toISOString();
        await persistRadioStateForGuild(state);
        return { added: 0, skipped: false };
      }

      await state.enqueue(accepted);
      state.radio.lastError = null;
      state.radio.updatedAt = new Date().toISOString();
      await persistRadioStateForGuild(state);
      logger.info(
        `Radio refill in guild ${state.guildId} added ${accepted.length} track(s) for '${state.radio.seedQuery}' (${reason}).`,
      );
      return { added: accepted.length, skipped: false };
    } catch (error) {
      state.radio.lastError = error.message;
      state.radio.updatedAt = new Date().toISOString();
      await persistRadioStateForGuild(state);
      logger.warn(`Radio refill failed in guild ${state.guildId}: ${error.message}`);
      return { added: 0, skipped: false, error };
    } finally {
      if (state.radio) {
        state.radio.refillInFlight = false;
      }
    }
  }

  function scheduleRefill(state, reason = "state_change") {
    ensureRadioStateContainer(state);
    if (!isActive(state) || state.radio.refillInFlight) {
      return;
    }

    clearRefillTimer(state);
    state.radio.refillTimer = setTimeout(() => {
      if (state.radio) {
        state.radio.refillTimer = null;
      }
      void ensureRefill(state, reason);
    }, 250);
  }

  function getStatus(state) {
    if (!isActive(state)) {
      return {
        active: false,
        boundChannelId: null,
        seedQuery: null,
        sourceMode: null,
        bufferedUpcomingCount: Array.isArray(state?.queue) ? state.queue.length : 0,
        lastError: null,
      };
    }

    return {
      active: true,
      boundChannelId: state.radio.boundChannelId,
      seedQuery: state.radio.seedQuery,
      sourceMode: state.radio.sourceMode,
      minBufferTracks: state.radio.minBufferTracks,
      bufferedUpcomingCount: Array.isArray(state.queue) ? state.queue.length : 0,
      requestedBy: state.radio.requestedBy,
      recentTrackKeys: state.radio.recentTrackKeys.slice(),
      lastError: state.radio.lastError,
      updatedAt: state.radio.updatedAt,
    };
  }

  function loadPersistedRadioStates() {
    return loadPersistedStates();
  }

  return {
    ensureRefill,
    getStatus,
    isActive,
    loadPersistedRadioStates,
    noteTrackStarted,
    restore,
    scheduleRefill,
    shouldProtectChannel,
    start,
    stop,
    trackKey,
  };
}

module.exports = {
  createRadioRuntime,
};
