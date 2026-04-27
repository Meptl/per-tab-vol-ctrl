(() => {
  const extApi = globalThis.browser || globalThis.chrome;
  const RULES_KEY = "volumeRules";
  let activeVolume = null;
  const mediaState = new WeakMap();

  function clampVolume(value) {
    return Math.max(0, Math.min(1, value));
  }

  function getOrCreateMediaState(media) {
    const existing = mediaState.get(media);
    if (existing) {
      return existing;
    }
    const created = { baseVolume: clampVolume(media.volume), appliedPercent: null };
    mediaState.set(media, created);
    return created;
  }

  function storageGet(defaults) {
    try {
      const maybePromise = extApi.storage.local.get(defaults);
      if (maybePromise && typeof maybePromise.then === "function") {
        return maybePromise;
      }
    } catch {
      // Ignore and fall back to callback style.
    }

    return new Promise((resolve, reject) => {
      extApi.storage.local.get(defaults, (result) => {
        const error = extApi.runtime && extApi.runtime.lastError;
        if (error) {
          reject(error);
          return;
        }
        resolve(result);
      });
    });
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
    media.volume = clampVolume(state.baseVolume * currentFactor);
    state.appliedPercent = activeVolume;
  }

  function applyVolumeToPage() {
    const media = document.querySelectorAll("audio, video");
    for (const element of media) {
      setMediaVolume(element);
    }
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
        if (!Number.isFinite(activeVolume)) {
          state.baseVolume = clampVolume(target.volume);
          state.appliedPercent = null;
          return;
        }

        const factor = clampVolume(activeVolume / 100);
        state.appliedPercent = activeVolume;
        state.baseVolume = factor > 0 ? clampVolume(target.volume / factor) : state.baseVolume;
      },
      true
    );
  }

  async function refreshVolumeFromRules() {
    try {
      const stored = await storageGet({ [RULES_KEY]: [] });
      const rules = Array.isArray(stored[RULES_KEY]) ? stored[RULES_KEY] : [];
      const matched = globalThis.VolumeMatcher.findBestRule(rules, location.href);
      activeVolume = matched && Number.isFinite(matched.volume) ? matched.volume : null;
      applyVolumeToPage();
    } catch {
      // Ignore storage read failures and keep default volume.
    }
  }

  function watchRuleChanges() {
    extApi.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes[RULES_KEY]) {
        return;
      }
      refreshVolumeFromRules();
    });
  }

  refreshVolumeFromRules();
  observeNewMedia();
  watchRuleChanges();
})();
