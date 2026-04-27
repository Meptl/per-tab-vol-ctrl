(() => {
  const extApi = globalThis.browser || globalThis.chrome;
  const RULES_KEY = "volumeRules";
  const rulesList = document.getElementById("rules-list");
  const form = document.getElementById("add-rule-form");
  const patternInput = document.getElementById("pattern-input");
  const statusEl = document.getElementById("status");

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

  function setStatus(message) {
    statusEl.textContent = message || "";
  }

  function sortRules() {
    rules.sort((a, b) => a.pattern.localeCompare(b.pattern));
  }

  async function persistRules() {
    rules = globalThis.VolumeMatcher.normalizeStoredRules(rules);
    await storageSet({ [RULES_KEY]: rules });
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
    item.textContent = "No rules yet. Add one above.";
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
      mute.textContent = isMuted ? "🔇" : "🔊";
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
      remove.textContent = "X";
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
