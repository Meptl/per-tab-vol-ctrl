(() => {
  const extApi = globalThis.browser || globalThis.chrome;
  const RULES_KEY = "volumeRules";
  const VOLUME_EPSILON = 0.0001;
  let domainRuleVolume = null;
  let tabOverride = null;
  let activeVolume = null;
  const mediaState = new WeakMap();

  function clampVolume(value) {
    return Math.max(0, Math.min(1, value));
  }

  function clampPercent(value) {
    if (!Number.isFinite(value)) {
      return 100;
    }
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  function normalizeTabOverride(candidate) {
    if (!candidate || typeof candidate !== "object") {
      return null;
    }

    return {
      volume: clampPercent(candidate.volume),
      muted: candidate.muted === true
    };
  }

  function getOrCreateMediaState(media) {
    const existing = mediaState.get(media);
    if (existing) {
      return existing;
    }
    const created = { baseVolume: clampVolume(media.volume), appliedPercent: null, isApplyingVolume: false };
    mediaState.set(media, created);
    return created;
  }

  function storageGet(defaults) {
    return extApi.storage.local.get(defaults);
  }

  function runtimeSendMessage(message) {
    return extApi.runtime.sendMessage(message);
  }

  function setMediaVolume(media) {
    const state = getOrCreateMediaState(media);

    if (!Number.isFinite(activeVolume)) {
      if (state.appliedPercent !== null) {
        media.volume = clampVolume(state.baseVolume);
        state.appliedPercent = null;
      }
      return;
    }

    if (Number.isFinite(state.appliedPercent)) {
      const previousFactor = clampVolume(state.appliedPercent / 100);
      if (previousFactor > 0) {
        state.baseVolume = clampVolume(media.volume / previousFactor);
      }
    } else {
      state.baseVolume = clampVolume(media.volume);
    }

    const currentFactor = clampVolume(activeVolume / 100);
    const nextVolume = clampVolume(state.baseVolume * currentFactor);
    const shouldWriteVolume = Math.abs(media.volume - nextVolume) > VOLUME_EPSILON;
    if (!shouldWriteVolume) {
      state.isApplyingVolume = false;
    } else {
      state.isApplyingVolume = true;
      media.volume = nextVolume;
    }
    state.appliedPercent = activeVolume;
  }

  function applyVolumeToPage() {
    const media = document.querySelectorAll("audio, video");
    for (const element of media) {
      setMediaVolume(element);
    }
  }

  function resolveEffectiveVolume() {
    if (tabOverride) {
      if (tabOverride.muted === true) {
        return 0;
      }
      return tabOverride.volume === 100 ? null : tabOverride.volume;
    }

    return domainRuleVolume;
  }

  function applyResolvedVolume() {
    activeVolume = resolveEffectiveVolume();
    applyVolumeToPage();
  }

  async function refreshDomainRuleVolume() {
    const stored = await storageGet({ [RULES_KEY]: [] });
    const rules = globalThis.VolumeMatcher.normalizeStoredRules(stored[RULES_KEY]);
    const matched = globalThis.VolumeMatcher.findBestRule(rules, location.href);
    if (matched && matched.muted === true) {
      domainRuleVolume = 0;
      return;
    }

    const matchedVolume = matched && Number.isFinite(matched.volume) ? matched.volume : null;
    domainRuleVolume = matchedVolume === 100 ? null : matchedVolume;
  }

  async function refreshTabOverrideFromBackground() {
    const response = await runtimeSendMessage({ type: "getTabVolumeOverride" });
    tabOverride = normalizeTabOverride(response && response.override);
  }

  async function refreshAllVolumeSources() {
    await Promise.allSettled([refreshDomainRuleVolume(), refreshTabOverrideFromBackground()]);
    applyResolvedVolume();
  }

  function observeNewMedia() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) {
            continue;
          }
          if (node.matches && node.matches("audio, video")) {
            setMediaVolume(node);
          }
          const nestedMedia = node.querySelectorAll ? node.querySelectorAll("audio, video") : [];
          for (const element of nestedMedia) {
            setMediaVolume(element);
          }
        }
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });

    document.addEventListener(
      "play",
      (event) => {
        const target = event.target;
        if (target instanceof HTMLMediaElement) {
          setMediaVolume(target);
        }
      },
      true
    );

    document.addEventListener(
      "volumechange",
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLMediaElement)) {
          return;
        }

        const state = getOrCreateMediaState(target);
        if (state.isApplyingVolume) {
          state.isApplyingVolume = false;
          return;
        }

        if (!Number.isFinite(activeVolume)) {
          state.baseVolume = clampVolume(target.volume);
          state.appliedPercent = null;
          return;
        }

        const factor = clampVolume(activeVolume / 100);
        state.appliedPercent = activeVolume;
        state.baseVolume = factor > 0 ? clampVolume(target.volume / factor) : state.baseVolume;
        setMediaVolume(target);
      },
      true
    );
  }

  function watchVolumeConfigChanges() {
    extApi.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes[RULES_KEY]) {
        refreshDomainRuleVolume()
          .then(() => {
            applyResolvedVolume();
          })
          .catch(() => {
            // Ignore storage read failures.
          });
      }
    });

    extApi.runtime.onMessage.addListener((message) => {
      if (!message || typeof message !== "object") {
        return;
      }

      if (message.type === "volumeRulesUpdated") {
        refreshDomainRuleVolume()
          .then(() => {
            applyResolvedVolume();
          })
          .catch(() => {
            // Ignore rules refresh failures.
          });
      }

      if (message.type === "tabVolumeOverrideUpdated") {
        tabOverride = normalizeTabOverride(message.override);
        applyResolvedVolume();
      }
    });
  }

  refreshAllVolumeSources();
  observeNewMedia();
  watchVolumeConfigChanges();
})();
