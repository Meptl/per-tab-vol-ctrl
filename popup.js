(() => {
  const extApi = globalThis.browser || globalThis.chrome;
  const RULES_KEY = "volumeRules";
  const rulesList = document.getElementById("rules-list");
  const form = document.getElementById("add-rule-form");
  const patternInput = document.getElementById("pattern-input");
  const statusEl = document.getElementById("status");
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICON_PATHS = {
    volume: [
      "M15 8a5 5 0 0 1 0 8",
      "M17.7 5a9 9 0 0 1 0 14",
      "M6 15h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l3.5 -4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5"
    ],
    volumeOff: [
      "M15 8a5 5 0 0 1 1.912 4.934m-1.377 2.602a5 5 0 0 1 -.535 .464",
      "M17.7 5a9 9 0 0 1 2.362 11.086m-1.676 2.299a9 9 0 0 1 -.686 .615",
      "M9.069 5.054l.431 -.554a.8 .8 0 0 1 1.5 .5v2m0 4v8a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l1.294 -1.664",
      "M3 3l18 18"
    ],
    x: [
      "M18 6l-12 12",
      "M6 6l12 12"
    ]
  };

  let rules = [];
  let currentUrl = "";

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

  function storageSet(items) {
    try {
      const maybePromise = extApi.storage.local.set(items);
      if (maybePromise && typeof maybePromise.then === "function") {
        return maybePromise;
      }
    } catch {
      // Ignore and fall back to callback style.
    }

    return new Promise((resolve, reject) => {
      extApi.storage.local.set(items, () => {
        const error = extApi.runtime && extApi.runtime.lastError;
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  function tabsQuery(queryInfo) {
    try {
      const maybePromise = extApi.tabs.query(queryInfo);
      if (maybePromise && typeof maybePromise.then === "function") {
        return maybePromise;
      }
    } catch {
      // Ignore and fall back to callback style.
    }

    return new Promise((resolve, reject) => {
      extApi.tabs.query(queryInfo, (tabs) => {
        const error = extApi.runtime && extApi.runtime.lastError;
        if (error) {
          reject(error);
          return;
        }
        resolve(tabs || []);
      });
    });
  }

  function tabsSendMessage(tabId, message) {
    if (!Number.isInteger(tabId)) {
      return Promise.resolve();
    }

    try {
      const maybePromise = extApi.tabs.sendMessage(tabId, message);
      if (maybePromise && typeof maybePromise.then === "function") {
        return maybePromise.catch(() => {
          // Ignore when the active tab has no content script.
        });
      }
    } catch {
      // Ignore and fall back to callback style.
    }

    return new Promise((resolve) => {
      extApi.tabs.sendMessage(tabId, message, () => {
        // Ignore lastError: active tab might not have a content script.
        resolve();
      });
    });
  }

  async function applyRulesToActiveTab(nextRules) {
    const tabs = await tabsQuery({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !Number.isInteger(tab.id)) {
      return;
    }

    await tabsSendMessage(tab.id, { type: "volumeRulesUpdated", rules: nextRules });
  }

  function setStatus(message) {
    statusEl.textContent = message || "";
  }

  function sortRules() {
    rules.sort((a, b) => a.pattern.localeCompare(b.pattern));
  }

  function createIcon(iconName) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");

    for (const d of ICON_PATHS[iconName]) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }

    return svg;
  }

  async function persistRules() {
    const normalizedRules = globalThis.VolumeMatcher.normalizeStoredRules(rules);
    await storageSet({ [RULES_KEY]: normalizedRules });
    await applyRulesToActiveTab(normalizedRules);
  }

  async function refreshCurrentTab() {
    const tabs = await tabsQuery({ active: true, currentWindow: true });
    const tab = tabs[0];
    currentUrl = tab && tab.url ? tab.url : "";

    if (currentUrl) {
      const defaultPattern = globalThis.VolumeMatcher.getDefaultPatternForUrl(currentUrl);
      if (defaultPattern) {
        patternInput.value = defaultPattern;
      }
    }
  }

  function createEmptyMessage() {
    const item = document.createElement("li");
    item.className = "empty";
    return item;
  }

  function renderRules() {
    rulesList.textContent = "";

    if (rules.length === 0) {
      rulesList.appendChild(createEmptyMessage());
      return;
    }

    const orderedRules = [...rules].sort((a, b) => {
      const aMatchesCurrent = Boolean(
        currentUrl && globalThis.VolumeMatcher.matchesPattern(a.pattern, currentUrl)
      );
      const bMatchesCurrent = Boolean(
        currentUrl && globalThis.VolumeMatcher.matchesPattern(b.pattern, currentUrl)
      );

      if (aMatchesCurrent !== bMatchesCurrent) {
        return aMatchesCurrent ? -1 : 1;
      }

      return a.pattern.localeCompare(b.pattern);
    });

    for (const rule of orderedRules) {
      const li = document.createElement("li");
      li.className = "rule-item";

      const row = document.createElement("div");
      row.className = "rule-row";

      const meta = document.createElement("div");
      meta.className = "rule-meta";

      const pattern = document.createElement("p");
      pattern.className = "pattern";
      pattern.textContent = rule.pattern;
      meta.appendChild(pattern);

      const matchesCurrent = currentUrl && globalThis.VolumeMatcher.matchesPattern(rule.pattern, currentUrl);
      if (matchesCurrent) {
        li.classList.add("rule-item-current");
      }

      const mute = document.createElement("button");
      mute.type = "button";
      mute.className = "mute-btn";
      const isMuted = rule.muted === true;
      mute.appendChild(createIcon(isMuted ? "volumeOff" : "volume"));
      mute.setAttribute("aria-label", isMuted ? "Unmute rule" : "Mute rule");
      mute.addEventListener("click", async () => {
        rule.muted = !(rule.muted === true);
        await persistRules();
        renderRules();
      });

      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "100";
      slider.step = "1";
      slider.value = String(Number.isFinite(rule.volume) ? rule.volume : 100);

      const value = document.createElement("output");
      value.className = "volume-value";
      value.textContent = `${slider.value}%`;

      slider.addEventListener("input", () => {
        rule.volume = Number(slider.value);
        value.textContent = `${slider.value}%`;
        persistRules().catch(() => {
          setStatus("Could not save extension state.");
        });
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "delete-btn";
      remove.appendChild(createIcon("x"));
      remove.setAttribute("aria-label", `Remove ${rule.pattern}`);
      remove.addEventListener("click", async () => {
        rules = rules.filter((item) => item.pattern !== rule.pattern);
        await persistRules();
        renderRules();
      });

      row.append(meta, mute, slider, value, remove);
      li.appendChild(row);

      rulesList.appendChild(li);
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus("");

    try {
      const normalized = globalThis.VolumeMatcher.normalizeRulePattern(patternInput.value);
      const exists = rules.some((rule) => rule.pattern.toLowerCase() === normalized.toLowerCase());
      if (exists) {
        setStatus("That pattern already exists.");
        return;
      }

      rules.push({ pattern: normalized, volume: 100, muted: false });
      sortRules();
      await persistRules();
      renderRules();

      patternInput.value = globalThis.VolumeMatcher.getDefaultPatternForUrl(currentUrl) || "";
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Invalid pattern.");
    }
  });

  async function initialize() {
    const stored = await storageGet({ [RULES_KEY]: [] });
    rules = globalThis.VolumeMatcher.normalizeStoredRules(stored[RULES_KEY]);
    sortRules();
    await refreshCurrentTab();
    renderRules();
  }

  initialize().catch(() => {
    setStatus("Could not load extension state.");
    renderRules();
  });
})();
