(() => {
  const WILDCARD = /\*/g;

  function escapeRegExp(input) {
    return input.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }

  function patternToRegExp(pattern) {
    const trimmed = String(pattern || "").trim();
    if (!trimmed) {
      return null;
    }

    const escaped = escapeRegExp(trimmed).replace(WILDCARD, ".*");
    return new RegExp(`^${escaped}$`, "i");
  }

  function normalizeRulePattern(input) {
    const raw = String(input || "").trim();
    if (!raw) {
      throw new Error("Pattern cannot be empty.");
    }

    if (/^[a-z*]+:\/\//i.test(raw)) {
      const parts = raw.split("://");
      const scheme = (parts[0] || "*").toLowerCase();
      const rest = parts.slice(1).join("://");
      const slashIndex = rest.indexOf("/");
      const host = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
      const path = slashIndex === -1 ? "/*" : rest.slice(slashIndex) || "/*";

      if (!host) {
        throw new Error("Pattern must include a host.");
      }

      return `${scheme}://${host}${path.startsWith("/") ? path : `/${path}`}`;
    }

    return `*://${raw}/*`;
  }

  function getDefaultPatternForUrl(urlString) {
    if (!urlString) {
      return "";
    }

    let parsed;
    try {
      parsed = new URL(urlString);
    } catch {
      return "";
    }

    if (!/^https?:$/i.test(parsed.protocol)) {
      return "";
    }

    return `*://${parsed.hostname}/*`;
  }

  function matchesPattern(pattern, urlString) {
    const matcher = patternToRegExp(pattern);
    if (!matcher || !urlString) {
      return false;
    }
    return matcher.test(urlString);
  }

  function patternSpecificity(pattern) {
    const value = String(pattern || "");
    return value.replace(WILDCARD, "").length;
  }

  function clampRuleVolume(value) {
    if (!Number.isFinite(value)) {
      return 100;
    }
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  function normalizeStoredRules(input) {
    if (!Array.isArray(input)) {
      return [];
    }

    const deduped = new Set();
    const normalized = [];

    for (const candidate of input) {
      if (!candidate || typeof candidate !== "object") {
        continue;
      }

      let pattern;
      try {
        pattern = normalizeRulePattern(candidate.pattern);
      } catch {
        continue;
      }

      const dedupeKey = pattern.toLowerCase();
      if (deduped.has(dedupeKey)) {
        continue;
      }
      deduped.add(dedupeKey);

      normalized.push({
        pattern,
        volume: clampRuleVolume(candidate.volume),
        muted: candidate.muted === true
      });
    }

    return normalized;
  }

  function findBestRule(rules, urlString) {
    if (!Array.isArray(rules) || !urlString) {
      return null;
    }

    const matches = rules.filter((rule) => matchesPattern(rule.pattern, urlString));
    if (matches.length === 0) {
      return null;
    }

    matches.sort((a, b) => {
      return patternSpecificity(b.pattern) - patternSpecificity(a.pattern);
    });

    return matches[0];
  }

  globalThis.VolumeMatcher = {
    normalizeRulePattern,
    normalizeStoredRules,
    getDefaultPatternForUrl,
    matchesPattern,
    findBestRule
  };
})();
