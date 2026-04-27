(() => {
  const extApi = globalThis.browser || globalThis.chrome;
  const RULES_KEY = "volumeRules";
  let activeVolume = 100;

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
    media.volume = Math.max(0, Math.min(1, activeVolume / 100));
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
  }

  async function refreshVolumeFromRules() {
    try {
      const stored = await storageGet({ [RULES_KEY]: [] });
      const rules = Array.isArray(stored[RULES_KEY]) ? stored[RULES_KEY] : [];
      const matched = globalThis.VolumeMatcher.findBestRule(rules, location.href);
      activeVolume = matched && Number.isFinite(matched.volume) ? matched.volume : 100;
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
