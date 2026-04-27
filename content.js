(() => {
  const extApi = globalThis.browser || globalThis.chrome;
  const RULES_KEY = "volumeRules";
  let activeVolume = null;
  const observedRoots = new WeakSet();
  const ignoreNextVolumeChange = new WeakSet();
  const VOLUME_EPSILON = 0.0001;

  function clampVolume(value) {
    return Math.max(0, Math.min(1, value));
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

  function getTargetVolume() {
    if (!Number.isFinite(activeVolume)) {
      return null;
    }
    return clampVolume(activeVolume / 100);
  }

  function setMediaVolume(media) {
    const targetVolume = getTargetVolume();
    if (!Number.isFinite(targetVolume)) {
      return;
    }

    if (Math.abs(media.volume - targetVolume) <= VOLUME_EPSILON) {
      return;
    }

    ignoreNextVolumeChange.add(media);
    media.volume = targetVolume;
  }

  function applyVolumeToRoot(root) {
    if (!root || typeof root.querySelectorAll !== "function") {
      return;
    }

    const media = root.querySelectorAll("audio, video");
    for (const element of media) {
      setMediaVolume(element);
    }
  }

  function forEachOpenShadowRoot(root, visitor) {
    if (!root || typeof root.querySelectorAll !== "function") {
      return;
    }

    const hosts = root.querySelectorAll("*");
    for (const host of hosts) {
      if (host.shadowRoot) {
        visitor(host.shadowRoot);
      }
    }
  }

  function applyVolumeToPage() {
    applyVolumeToRoot(document);
    forEachOpenShadowRoot(document, (shadowRoot) => {
      applyVolumeToRoot(shadowRoot);
    });
  }

  function observeNewMedia() {
    let observer;

    function observeRoot(root) {
      if (!root || observedRoots.has(root)) {
        return;
      }

      observedRoots.add(root);
      observer.observe(root, { childList: true, subtree: true });
    }

    function inspectNode(node) {
      if (!(node instanceof Element)) {
        return;
      }

      if (node.matches && node.matches("audio, video")) {
        setMediaVolume(node);
      }

      const nestedMedia = node.querySelectorAll ? node.querySelectorAll("audio, video") : [];
      for (const element of nestedMedia) {
        setMediaVolume(element);
      }

      if (node.shadowRoot) {
        observeRoot(node.shadowRoot);
        applyVolumeToRoot(node.shadowRoot);
      }

      forEachOpenShadowRoot(node, (shadowRoot) => {
        observeRoot(shadowRoot);
        applyVolumeToRoot(shadowRoot);
      });
    }

    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          inspectNode(node);
        }
      }
    });

    observeRoot(document.documentElement);
    forEachOpenShadowRoot(document, (shadowRoot) => {
      observeRoot(shadowRoot);
    });

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

        if (ignoreNextVolumeChange.has(target)) {
          ignoreNextVolumeChange.delete(target);
          return;
        }

        setMediaVolume(target);
      },
      true
    );
  }

  async function refreshVolumeFromRules() {
    try {
      const stored = await storageGet({ [RULES_KEY]: [] });
      const rules = globalThis.VolumeMatcher.normalizeStoredRules(stored[RULES_KEY]);
      const matched = globalThis.VolumeMatcher.findBestRule(rules, location.href);
      if (matched && matched.muted === true) {
        activeVolume = 0;
      } else {
        activeVolume = matched && Number.isFinite(matched.volume) ? matched.volume : null;
      }
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

  function watchRuntimeMessages() {
    if (!extApi.runtime || !extApi.runtime.onMessage) {
      return;
    }

    extApi.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== "volumeRulesUpdated") {
        return;
      }

      const rules = globalThis.VolumeMatcher.normalizeStoredRules(message.rules);
      const matched = globalThis.VolumeMatcher.findBestRule(rules, location.href);
      if (matched && matched.muted === true) {
        activeVolume = 0;
      } else {
        activeVolume = matched && Number.isFinite(matched.volume) ? matched.volume : null;
      }

      applyVolumeToPage();
    });
  }

  refreshVolumeFromRules();
  observeNewMedia();
  watchRuleChanges();
  watchRuntimeMessages();
})();
