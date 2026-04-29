(() => {
  const extApi = globalThis.browser || globalThis.chrome;
  const RULES_KEY = "volumeRules";
  const VOLUME_EPSILON = 0.0001;
  let domainRuleVolume = null;
  let tabOverride = null;
  let activeVolume = null;
  let sharedAudioContext = null;
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
      muted: candidate.muted === true,
      active: candidate.active !== false
    };
  }

  function getAudioContext() {
    if (sharedAudioContext) {
      return sharedAudioContext;
    }

    const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextCtor) {
      return null;
    }

    sharedAudioContext = new AudioContextCtor();
    return sharedAudioContext;
  }

  function getOrCreateMediaState(media) {
    const existing = mediaState.get(media);
    if (existing) {
      return existing;
    }

    const created = {
      gainNode: null,
      sourceNode: null,
      isConnected: false,
      shouldBypass: false,
      appliedPercent: null
    };
    mediaState.set(media, created);
    return created;
  }

  function storageGet(defaults) {
    return extApi.storage.local.get(defaults);
  }

  function runtimeSendMessage(message) {
    return extApi.runtime.sendMessage(message);
  }

  function ensureMediaGainNode(media, state) {
    if (state.gainNode || state.shouldBypass) {
      return;
    }

    const context = getAudioContext();
    if (!context) {
      state.shouldBypass = true;
      return;
    }

    try {
      state.sourceNode = context.createMediaElementSource(media);
      state.gainNode = context.createGain();
      state.sourceNode.connect(state.gainNode);
      state.gainNode.connect(context.destination);
      state.isConnected = true;
    } catch {
      state.shouldBypass = true;
    }
  }

  function resolveGainFactor() {
    if (!Number.isFinite(activeVolume)) {
      return 1;
    }
    return clampVolume(activeVolume / 100);
  }

  function setMediaVolume(media, options = {}) {
    const { allowAttach = false } = options;

    if (!Number.isFinite(activeVolume)) {
      const state = mediaState.get(media);
      if (state && state.gainNode && state.isConnected) {
        state.gainNode.gain.value = 1;
        state.appliedPercent = null;
      }
      return;
    }

    const state = getOrCreateMediaState(media);
    if (!state.gainNode && !state.shouldBypass && !allowAttach) {
      return;
    }

    if (!state.gainNode && !state.shouldBypass) {
      ensureMediaGainNode(media, state);
    }

    if (!state.gainNode || !state.isConnected) {
      return;
    }

    const nextFactor = resolveGainFactor();
    const currentFactor = clampVolume(state.gainNode.gain.value);
    if (Math.abs(currentFactor - nextFactor) <= VOLUME_EPSILON) {
      state.appliedPercent = activeVolume;
      return;
    }

    state.gainNode.gain.value = nextFactor;
    state.appliedPercent = activeVolume;
  }

  function applyVolumeToPage() {
    const media = document.querySelectorAll("audio, video");
    for (const element of media) {
      const shouldAttach = !element.paused || element.autoplay;
      setMediaVolume(element, { allowAttach: shouldAttach });
    }
  }

  function resolveEffectiveVolume() {
    if (tabOverride && tabOverride.active !== false) {
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
        if (!(target instanceof HTMLMediaElement)) {
          return;
        }

        if (!Number.isFinite(activeVolume)) {
          return;
        }

        const context = getAudioContext();
        if (context && context.state === "suspended") {
          context.resume().catch(() => {
            // Ignore resume failures.
          });
        }

        globalThis.setTimeout(() => {
          setMediaVolume(target, { allowAttach: true });
        }, 0);
      },
      true
    );

    document.addEventListener(
      "volumechange",
      (event) => {
        const target = event.target;
        if (!Number.isFinite(activeVolume)) {
          return;
        }

        if (target instanceof HTMLMediaElement) {
          setMediaVolume(target);
        }
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
