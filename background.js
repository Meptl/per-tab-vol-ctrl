(() => {
  const extApi = globalThis.browser || globalThis.chrome;
  const MENU_ID = "open-tab-volume";
  const POPUP_TARGET_TAB_ID_KEY = "popupTargetTabId";
  const TAB_OVERRIDES_KEY = "tabVolumeOverrides";

  function storageSessionGet(defaults) {
    return extApi.storage.session.get(defaults);
  }

  function storageSessionSet(items) {
    return extApi.storage.session.set(items);
  }

  async function removeTabOverride(tabId) {
    const tabKey = String(tabId);
    const stored = await storageSessionGet({ [TAB_OVERRIDES_KEY]: {} });
    const overrides = stored[TAB_OVERRIDES_KEY] || {};
    if (!(tabKey in overrides)) {
      return;
    }

    const nextOverrides = { ...overrides };
    delete nextOverrides[tabKey];
    await storageSessionSet({ [TAB_OVERRIDES_KEY]: nextOverrides });
  }

  async function consumePopupTargetTabId() {
    const stored = await storageSessionGet({ [POPUP_TARGET_TAB_ID_KEY]: null });
    const tabId = Number.isInteger(stored[POPUP_TARGET_TAB_ID_KEY])
      ? stored[POPUP_TARGET_TAB_ID_KEY]
      : null;
    await extApi.storage.session.remove(POPUP_TARGET_TAB_ID_KEY);
    return tabId;
  }

  async function initializeMenu() {
    try {
      await extApi.menus.remove(MENU_ID);
    } catch {
      // Ignore if the menu item does not exist.
    }

    extApi.menus.create({
      id: MENU_ID,
      contexts: ["tab"],
      title: "Set tab volume"
    });
  }

  extApi.runtime.onInstalled.addListener(() => {
    initializeMenu().catch(() => {
      // Ignore menu initialization failures.
    });
  });

  extApi.runtime.onStartup.addListener(() => {
    initializeMenu().catch(() => {
      // Ignore menu initialization failures.
    });
  });

  extApi.menus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== MENU_ID || !tab || !Number.isInteger(tab.id)) {
      return;
    }

    try {
      await storageSessionSet({ [POPUP_TARGET_TAB_ID_KEY]: tab.id });
      await extApi.action.openPopup({ windowId: tab.windowId });
    } catch {
      // Ignore menu failures.
    }
  });

  extApi.tabs.onRemoved.addListener((tabId) => {
    removeTabOverride(tabId).catch(() => {
      // Ignore storage cleanup failures.
    });
  });

  extApi.runtime.onMessage.addListener((message, sender) => {
    if (!message || typeof message !== "object") {
      return undefined;
    }

    if (message.type === "getEffectivePopupTabId") {
      return consumePopupTargetTabId().then((popupTabId) => {
        return { popupTabId };
      });
    }

    if (message.type === "getTabVolumeOverride") {
      const senderTabId = sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
      if (!Number.isInteger(senderTabId)) {
        return Promise.resolve({ override: null });
      }

      return storageSessionGet({ [TAB_OVERRIDES_KEY]: {} }).then((stored) => {
        const overrides = stored[TAB_OVERRIDES_KEY] || {};
        const override = overrides[String(senderTabId)] || null;
        return { override };
      });
    }

    return undefined;
  });

  initializeMenu().catch(() => {
    // Ignore menu initialization failures.
  });
})();
