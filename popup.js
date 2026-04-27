(() => {
  const extApi = globalThis.browser || globalThis.chrome;
  const RULES_KEY = "volumeRules";
  const TAB_OVERRIDES_KEY = "tabVolumeOverrides";
  const rulesList = document.getElementById("rules-list");
  const tabOverridesList = document.getElementById("tab-overrides-list");
  const addTabOverrideBtn = document.getElementById("add-tab-override-btn");
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
    x: ["M18 6l-12 12", "M6 6l12 12"]
  };

  let rules = [];
  let currentUrl = "";
  let currentTabId = null;
  let tabOverrides = {};

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

  function normalizeTabOverrides(candidate) {
    if (!candidate || typeof candidate !== "object") {
      return {};
    }

    const normalized = {};
    for (const [tabId, value] of Object.entries(candidate)) {
      const override = normalizeTabOverride(value);
      if (override) {
        normalized[tabId] = override;
      }
    }

    return normalized;
  }

  function storageGet(defaults) {
    return extApi.storage.local.get(defaults);
  }

  function storageSet(items) {
    return extApi.storage.local.set(items);
  }

  function storageSessionGet(defaults) {
    return extApi.storage.session.get(defaults);
  }

  function storageSessionSet(items) {
    return extApi.storage.session.set(items);
  }

  function runtimeSendMessage(message) {
    return extApi.runtime.sendMessage(message);
  }

  function tabsQuery(queryInfo) {
    return extApi.tabs.query(queryInfo);
  }

  function tabsGet(tabId) {
    return extApi.tabs.get(tabId);
  }

  function tabsSendMessage(tabId, message) {
    if (!Number.isInteger(tabId)) {
      return Promise.resolve();
    }

    return extApi.tabs.sendMessage(tabId, message).catch(() => {
      // Ignore when a tab has no content script.
    });
  }

  async function persistRules() {
    const normalizedRules = globalThis.VolumeMatcher.normalizeStoredRules(rules);
    await storageSet({ [RULES_KEY]: normalizedRules });
    await tabsSendMessage(currentTabId, { type: "volumeRulesUpdated", rules: normalizedRules });
  }

  async function persistTabOverride(tabId, nextOverride) {
    if (!Number.isInteger(tabId)) {
      return;
    }

    const stored = await storageSessionGet({ [TAB_OVERRIDES_KEY]: {} });
    const overrides = normalizeTabOverrides(stored[TAB_OVERRIDES_KEY]);
    const nextOverrides = { ...overrides };

    if (nextOverride) {
      nextOverrides[String(tabId)] = nextOverride;
    } else {
      delete nextOverrides[String(tabId)];
    }

    await storageSessionSet({ [TAB_OVERRIDES_KEY]: nextOverrides });
    await tabsSendMessage(tabId, { type: "tabVolumeOverrideUpdated", override: nextOverride });
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

  async function resolveCurrentTab() {
    let popupTabId = null;
    try {
      const response = await runtimeSendMessage({ type: "getEffectivePopupTabId" });
      popupTabId = response && Number.isInteger(response.popupTabId) ? response.popupTabId : null;
    } catch {
      // Ignore and fall back to active tab.
    }

    if (Number.isInteger(popupTabId)) {
      try {
        const tab = await tabsGet(popupTabId);
        if (tab && Number.isInteger(tab.id)) {
          currentTabId = tab.id;
          currentUrl = tab.url || "";
          return;
        }
      } catch {
        // Ignore and fall back to active tab.
      }
    }

    const tabs = await tabsQuery({ active: true, currentWindow: true });
    const tab = tabs[0];
    currentTabId = tab && Number.isInteger(tab.id) ? tab.id : null;
    currentUrl = tab && tab.url ? tab.url : "";
  }

  async function readTabOverrides() {
    const stored = await storageSessionGet({ [TAB_OVERRIDES_KEY]: {} });
    tabOverrides = normalizeTabOverrides(stored[TAB_OVERRIDES_KEY]);
  }

  function createEmptyMessage(message) {
    const item = document.createElement("li");
    item.className = "empty";
    item.textContent = message;
    return item;
  }

  function createVolumeControlItem({
    label,
    labelElement,
    volume,
    muted,
    isCurrent,
    muteAriaLabel,
    removeAriaLabel,
    onToggleMute,
    onVolumeInput,
    onRemove
  }) {
    const li = document.createElement("li");
    li.className = "rule-item";

    if (isCurrent) {
      li.classList.add("rule-item-current");
    }

    const row = document.createElement("div");
    row.className = "rule-row";

    const meta = document.createElement("div");
    meta.className = "rule-meta";

    if (labelElement) {
      meta.appendChild(labelElement);
    } else {
      const pattern = document.createElement("p");
      pattern.className = "pattern";
      pattern.textContent = label;
      meta.appendChild(pattern);
    }

    const mute = document.createElement("button");
    mute.type = "button";
    mute.className = "mute-btn";
    mute.appendChild(createIcon(muted ? "volumeOff" : "volume"));
    mute.setAttribute("aria-label", muteAriaLabel);
    mute.addEventListener("click", onToggleMute);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "1";
    slider.value = String(volume);

    const value = document.createElement("output");
    value.className = "volume-value";
    value.textContent = `${slider.value}%`;

    slider.addEventListener("input", () => {
      const nextVolume = Number(slider.value);
      value.textContent = `${slider.value}%`;
      onVolumeInput(nextVolume);
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-btn";
    remove.appendChild(createIcon("x"));
    remove.setAttribute("aria-label", removeAriaLabel);
    remove.addEventListener("click", onRemove);

    row.append(meta, mute, slider, value, remove);
    li.appendChild(row);

    return li;
  }

  function renderRules() {
    rulesList.textContent = "";

    if (rules.length === 0) {
      rulesList.appendChild(createEmptyMessage("No domain rules."));
      return;
    }

    const currentTabOverride =
      Number.isInteger(currentTabId) && tabOverrides[String(currentTabId)]
        ? tabOverrides[String(currentTabId)]
        : null;
    const shouldHighlightCurrentDomainRule = !(currentTabOverride && currentTabOverride.active !== false);

    const orderedRules = [...rules].sort((a, b) => {
      const aMatchesCurrent = Boolean(
        shouldHighlightCurrentDomainRule &&
          currentUrl &&
          globalThis.VolumeMatcher.matchesPattern(a.pattern, currentUrl)
      );
      const bMatchesCurrent = Boolean(
        shouldHighlightCurrentDomainRule &&
          currentUrl &&
          globalThis.VolumeMatcher.matchesPattern(b.pattern, currentUrl)
      );

      if (aMatchesCurrent !== bMatchesCurrent) {
        return aMatchesCurrent ? -1 : 1;
      }

      return a.pattern.localeCompare(b.pattern);
    });

    for (const rule of orderedRules) {
      const matchesCurrent = Boolean(
        shouldHighlightCurrentDomainRule &&
          currentUrl &&
          globalThis.VolumeMatcher.matchesPattern(rule.pattern, currentUrl)
      );
      const item = createVolumeControlItem({
        label: rule.pattern,
        volume: Number.isFinite(rule.volume) ? rule.volume : 100,
        muted: rule.muted === true,
        isCurrent: matchesCurrent,
        muteAriaLabel: rule.muted === true ? "Unmute rule" : "Mute rule",
        removeAriaLabel: `Remove ${rule.pattern}`,
        onToggleMute: () => {
          rule.muted = !(rule.muted === true);
          persistRules()
            .then(() => {
              renderRules();
            })
            .catch(() => {
              setStatus("Could not save extension state.");
            });
        },
        onVolumeInput: (nextVolume) => {
          rule.volume = nextVolume;
          persistRules().catch(() => {
            setStatus("Could not save extension state.");
          });
        },
        onRemove: () => {
          rules = rules.filter((entry) => entry.pattern !== rule.pattern);
          persistRules()
            .then(() => {
              renderRules();
            })
            .catch(() => {
              setStatus("Could not save extension state.");
            });
        }
      });

      rulesList.appendChild(item);
    }
  }

  function getTabDisplayTitle(tab, tabId) {
    const rawTitle = tab && typeof tab.title === "string" ? tab.title.trim() : "";
    if (rawTitle) {
      return rawTitle;
    }

    const fallbackUrl = tab && typeof tab.url === "string" ? tab.url : "";
    if (fallbackUrl) {
      return fallbackUrl;
    }

    return `Tab ${tabId}`;
  }

  function createTabEntryLabel(tab, tabId) {
    const wrapper = document.createElement("div");
    wrapper.className = "tab-entry-label";

    const faviconUrl = tab && typeof tab.favIconUrl === "string" ? tab.favIconUrl : "";
    if (faviconUrl) {
      const favicon = document.createElement("img");
      favicon.className = "tab-entry-favicon";
      favicon.src = faviconUrl;
      favicon.alt = "";
      favicon.loading = "lazy";
      favicon.referrerPolicy = "no-referrer";
      favicon.addEventListener("error", () => {
        favicon.remove();
      });
      wrapper.appendChild(favicon);
    }

    const title = document.createElement("p");
    title.className = "tab-entry-title";
    title.textContent = getTabDisplayTitle(tab, tabId);
    wrapper.appendChild(title);

    return wrapper;
  }

  async function renderTabOverrides() {
    tabOverridesList.textContent = "";

    const entries = Object.entries(tabOverrides)
      .map(([tabId, override]) => {
        const numericTabId = Number(tabId);
        if (!Number.isInteger(numericTabId)) {
          return null;
        }

        return {
          tabId: numericTabId,
          override
        };
      })
      .filter(Boolean);

    if (entries.length === 0) {
      tabOverridesList.appendChild(createEmptyMessage("No tab overrides yet."));
      return;
    }

    const entriesWithTabInfo = await Promise.all(
      entries.map(async (entry) => {
        try {
          const tab = await tabsGet(entry.tabId);
          return {
            ...entry,
            tab
          };
        } catch {
          return {
            ...entry,
            tab: null
          };
        }
      })
    );

    entriesWithTabInfo.sort((a, b) => {
      const aIsCurrent = a.tabId === currentTabId;
      const bIsCurrent = b.tabId === currentTabId;

      if (aIsCurrent !== bIsCurrent) {
        return aIsCurrent ? -1 : 1;
      }

      const aLabel = getTabDisplayTitle(a.tab, a.tabId);
      const bLabel = getTabDisplayTitle(b.tab, b.tabId);
      return aLabel.localeCompare(bLabel);
    });

    for (const entry of entriesWithTabInfo) {
      const item = createVolumeControlItem({
        label: getTabDisplayTitle(entry.tab, entry.tabId),
        labelElement: createTabEntryLabel(entry.tab, entry.tabId),
        volume: entry.override.volume,
        muted: entry.override.muted,
        isCurrent: entry.tabId === currentTabId,
        muteAriaLabel: entry.override.muted ? "Unmute tab override" : "Mute tab override",
        removeAriaLabel: `Clear override for tab ${entry.tabId}`,
        onToggleMute: () => {
          const nextOverride = {
            volume: entry.override.volume,
            muted: !entry.override.muted,
            active: true
          };

          tabOverrides[String(entry.tabId)] = nextOverride;
          persistTabOverride(entry.tabId, nextOverride)
            .then(() => {
              renderRules();
              renderTabOverrides().catch(() => {
                setStatus("Could not render tab overrides.");
              });
            })
            .catch(() => {
              setStatus("Could not save tab override.");
            });
        },
        onVolumeInput: (nextVolume) => {
          const nextOverride = {
            volume: clampPercent(nextVolume),
            muted: entry.override.muted,
            active: true
          };

          tabOverrides[String(entry.tabId)] = nextOverride;
          entry.override = nextOverride;
          renderRules();
          persistTabOverride(entry.tabId, nextOverride).catch(() => {
            setStatus("Could not save tab override.");
          });
        },
        onRemove: () => {
          delete tabOverrides[String(entry.tabId)];
          persistTabOverride(entry.tabId, null)
            .then(() => {
              renderRules();
              renderTabOverrides().catch(() => {
                setStatus("Could not render tab overrides.");
              });
            })
            .catch(() => {
              setStatus("Could not clear tab override.");
            });
        }
      });

      tabOverridesList.appendChild(item);
    }
  }

  addTabOverrideBtn.addEventListener("click", () => {
    setStatus("");

    if (!Number.isInteger(currentTabId)) {
      setStatus("Could not resolve current tab.");
      return;
    }

    if (tabOverrides[String(currentTabId)]) {
      setStatus("Current tab already has an override.");
      return;
    }

    const nextOverride = {
      volume: 100,
      muted: false,
      active: true
    };

    tabOverrides[String(currentTabId)] = nextOverride;
    persistTabOverride(currentTabId, nextOverride)
      .then(() => {
        renderRules();
        return renderTabOverrides();
      })
      .catch(() => {
        setStatus("Could not save tab override.");
      });
  });

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

    await resolveCurrentTab();
    await readTabOverrides();

    const defaultPattern = globalThis.VolumeMatcher.getDefaultPatternForUrl(currentUrl);
    patternInput.value = defaultPattern || "";

    renderRules();
    await renderTabOverrides();
  }

  initialize().catch(() => {
    setStatus("Could not load extension state.");
    renderRules();
    renderTabOverrides().catch(() => {
      // Ignore initial render failures.
    });
  });
})();
