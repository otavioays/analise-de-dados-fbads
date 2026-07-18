(function () {
  "use strict";

  if (window.__fbAdsConversionTrackerLoaded) return;
  window.__fbAdsConversionTrackerLoaded = true;

  var script = document.currentScript;
  if (!script) {
    var scripts = document.getElementsByTagName("script");
    script = scripts[scripts.length - 1];
  }

  var scriptUrl = new URL(script.src, window.location.href);
  var endpoint = script.getAttribute("data-endpoint") || scriptUrl.origin + "/api/events";
  var debug = script.getAttribute("data-debug") === "true";
  var autoPageViews = script.getAttribute("data-auto-page-view") !== "false";
  var autoBehavior = script.getAttribute("data-auto-behavior") !== "false";
  var storagePrefix = script.getAttribute("data-storage-prefix") || "fbads_conversion_tracker";
  var requestedTimeout = Number(script.getAttribute("data-session-timeout-minutes") || 30);
  var sessionTimeoutMinutes = Number.isFinite(requestedTimeout)
    ? Math.max(5, Math.min(240, requestedTimeout))
    : 30;
  var sessionTimeoutMs = sessionTimeoutMinutes * 60 * 1000;

  var visitorStorageKey = storagePrefix + "_visitor_id";
  var sessionStorageKey = storagePrefix + "_session_v2";
  var legacySessionStorageKey = storagePrefix + "_session_id";
  var firstTouchStorageKey = storagePrefix + "_first_touch";
  var sessionAttributionKey = storagePrefix + "_session_attribution_v2";
  var internalTrafficStorageKey = storagePrefix + "_internal_traffic";

  function log() {
    if (!debug || !window.console) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[ConversionTracker]");
    window.console.log.apply(window.console, args);
  }

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var random = Math.floor(Math.random() * 16);
      var value = c === "x" ? random : (random & 3) | 8;
      return value.toString(16);
    });
  }

  function readStorage(storage, key) {
    try {
      return storage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function writeStorage(storage, key, value) {
    try {
      storage.setItem(key, value);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function removeStorage(storage, key) {
    try {
      storage.removeItem(key);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function getOrCreateId(storage, key) {
    var existing = readStorage(storage, key);
    if (existing) return existing;
    var created = uuid();
    writeStorage(storage, key, created);
    return created;
  }

  function parseJson(value) {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch (_error) {
      return null;
    }
  }

  function compactObject(object) {
    var output = {};
    Object.keys(object).forEach(function (key) {
      var value = object[key];
      if (value !== null && value !== undefined && value !== "") output[key] = value;
    });
    return output;
  }

  function readUrlAttribution() {
    var params = new URLSearchParams(window.location.search);
    return compactObject({
      utm_source: params.get("utm_source"),
      utm_medium: params.get("utm_medium"),
      utm_campaign: params.get("utm_campaign"),
      utm_content: params.get("utm_content"),
      utm_term: params.get("utm_term"),
      fbclid: params.get("fbclid")
    });
  }

  function hasAttribution(value) {
    return Boolean(value && typeof value === "object" && Object.keys(value).length);
  }

  function applyInternalTrafficControls() {
    var params = new URLSearchParams(window.location.search);
    var queryValue = params.get("ct_internal");

    if (queryValue === "1" || queryValue === "true") {
      writeStorage(window.localStorage, internalTrafficStorageKey, "true");
    } else if (queryValue === "0" || queryValue === "false") {
      removeStorage(window.localStorage, internalTrafficStorageKey);
    }
  }

  function isInternalTraffic() {
    if (script.getAttribute("data-internal") === "true") return true;
    return readStorage(window.localStorage, internalTrafficStorageKey) === "true";
  }

  function setInternalTraffic(enabled) {
    if (enabled) {
      writeStorage(window.localStorage, internalTrafficStorageKey, "true");
    } else {
      removeStorage(window.localStorage, internalTrafficStorageKey);
    }
    return isInternalTraffic();
  }

  function validSessionRecord(record) {
    return Boolean(
      record &&
        typeof record.id === "string" &&
        typeof record.started_at === "number" &&
        typeof record.last_activity_at === "number" &&
        Number.isFinite(record.started_at) &&
        Number.isFinite(record.last_activity_at)
    );
  }

  function sessionExpired(record, now) {
    if (!validSessionRecord(record)) return true;
    if (record.last_activity_at > now + 5 * 60 * 1000) return true;
    return now - record.last_activity_at > sessionTimeoutMs;
  }

  function clearSessionAttribution() {
    removeStorage(window.localStorage, sessionAttributionKey);
  }

  function createSession(now) {
    var record = {
      id: uuid(),
      started_at: now,
      last_activity_at: now,
      version: 2
    };
    writeStorage(window.localStorage, sessionStorageKey, JSON.stringify(record));
    removeStorage(window.sessionStorage, legacySessionStorageKey);
    clearSessionAttribution();
    return record;
  }

  function ensureSession() {
    var now = Date.now();
    var stored = parseJson(readStorage(window.localStorage, sessionStorageKey));
    var isNew = sessionExpired(stored, now);
    var record = isNew ? createSession(now) : stored;

    record.last_activity_at = now;
    writeStorage(window.localStorage, sessionStorageKey, JSON.stringify(record));

    return { record: record, isNew: isNew };
  }

  function resetSession() {
    removeStorage(window.localStorage, sessionStorageKey);
    clearSessionAttribution();
    lastTrackedPageKey = null;
    return ensureSession().record.id;
  }

  function resolveAttribution(sessionRecord) {
    var current = readUrlAttribution();
    var firstTouch = parseJson(readStorage(window.localStorage, firstTouchStorageKey));
    var storedSessionTouch = parseJson(
      readStorage(window.localStorage, sessionAttributionKey)
    );
    var sessionTouch =
      storedSessionTouch && storedSessionTouch.session_id === sessionRecord.id
        ? storedSessionTouch.attribution
        : null;

    if (hasAttribution(current)) {
      sessionTouch = current;
      writeStorage(
        window.localStorage,
        sessionAttributionKey,
        JSON.stringify({
          session_id: sessionRecord.id,
          attribution: sessionTouch,
          captured_at: new Date().toISOString()
        })
      );
    }

    if (!firstTouch && hasAttribution(current)) {
      firstTouch = Object.assign({}, current, {
        landing_page: window.location.href,
        captured_at: new Date().toISOString()
      });
      writeStorage(window.localStorage, firstTouchStorageKey, JSON.stringify(firstTouch));
    }

    var active = hasAttribution(sessionTouch)
      ? sessionTouch
      : hasAttribution(current)
        ? current
        : hasAttribution(firstTouch)
          ? firstTouch
          : {};

    return { active: active, firstTouch: firstTouch || {} };
  }

  function getDeviceType() {
    var width = window.screen && window.screen.width ? window.screen.width : 0;
    if (width > 0 && width < 768) return "mobile";
    if (width >= 768 && width < 1024) return "tablet";
    return "desktop";
  }

  applyInternalTrafficControls();

  var visitorId = getOrCreateId(window.localStorage, visitorStorageKey);
  var initialSession = ensureSession().record;
  var lastTrackedPageKey = null;

  function buildPayload(eventName, properties, sessionRecord) {
    var attribution = resolveAttribution(sessionRecord);
    var active = attribution.active;
    var safeProperties =
      properties && typeof properties === "object" && !Array.isArray(properties)
        ? properties
        : {};

    return {
      event_id: uuid(),
      event_name: eventName,
      visitor_id: visitorId,
      session_id: sessionRecord.id,
      client_timestamp: new Date().toISOString(),
      page_url: window.location.href,
      page_path: window.location.pathname + window.location.search,
      page_title: document.title || null,
      referrer: document.referrer || null,
      utm_source: active.utm_source || null,
      utm_medium: active.utm_medium || null,
      utm_campaign: active.utm_campaign || null,
      utm_content: active.utm_content || null,
      utm_term: active.utm_term || null,
      fbclid: active.fbclid || null,
      device_type: getDeviceType(),
      screen_width: window.screen && window.screen.width ? window.screen.width : null,
      language: navigator.language || null,
      properties: Object.assign({}, safeProperties, {
        first_touch: attribution.firstTouch,
        internal_traffic: isInternalTraffic(),
        session_started_at: new Date(sessionRecord.started_at).toISOString(),
        session_last_activity_at: new Date(sessionRecord.last_activity_at).toISOString(),
        session_timeout_minutes: sessionTimeoutMinutes,
        session_storage_version: 2
      })
    };
  }

  function send(payload) {
    log("sending", payload.event_name, payload);
    return fetch(endpoint, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("Tracking request failed with status " + response.status);
        }
        return true;
      })
      .catch(function (error) {
        log("failed", payload.event_name, error);
        return false;
      });
  }

  function track(eventName, properties) {
    if (typeof eventName !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(eventName)) {
      return Promise.resolve(false);
    }

    var sessionState = ensureSession();
    var record = sessionState.record;

    if (sessionState.isNew && eventName !== "page_view") {
      lastTrackedPageKey = null;
      return send(
        buildPayload("page_view", { session_restarted_after_inactivity: true }, record)
      ).then(function () {
        lastTrackedPageKey = record.id + "|" + window.location.href;
        return send(buildPayload(eventName, properties, ensureSession().record));
      });
    }

    return send(buildPayload(eventName, properties, record));
  }

  function trackPageView() {
    var record = ensureSession().record;
    var pageKey = record.id + "|" + window.location.href;
    if (pageKey === lastTrackedPageKey) return;
    lastTrackedPageKey = pageKey;
    track("page_view");
  }

  function propertiesFromElement(element) {
    var customProperties = parseJson(element.getAttribute("data-track-properties"));
    return Object.assign(
      {
        element_id: element.id || null,
        element_tag: element.tagName.toLowerCase(),
        element_text: (element.textContent || "").trim().slice(0, 200) || null
      },
      customProperties && typeof customProperties === "object" ? customProperties : {}
    );
  }

  document.addEventListener(
    "click",
    function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== "function") return;
      var trackedElement = target.closest("[data-track]");
      if (!trackedElement) return;
      track(trackedElement.getAttribute("data-track"), propertiesFromElement(trackedElement));
    },
    true
  );

  function installSpaNavigationTracking() {
    ["pushState", "replaceState"].forEach(function (methodName) {
      var original = window.history[methodName];
      if (typeof original !== "function") return;
      window.history[methodName] = function () {
        var result = original.apply(this, arguments);
        window.setTimeout(trackPageView, 0);
        return result;
      };
    });
    window.addEventListener("popstate", function () {
      window.setTimeout(trackPageView, 0);
    });
  }

  function installBehaviorTracking() {
    var startedAt = Date.now();
    var maxScroll = 0;
    var visibleStartedAt = document.visibilityState === "visible" ? Date.now() : null;
    var visibleMs = 0;
    var sentScroll = {};
    var sentTime = {};
    var seenSections = {};
    var summarySent = false;

    function visibleSeconds() {
      var total = visibleMs;
      if (visibleStartedAt !== null) total += Date.now() - visibleStartedAt;
      return Math.max(0, Math.round(total / 1000));
    }

    function updateScroll() {
      var scrollable = document.documentElement.scrollHeight - window.innerHeight;
      var depth = scrollable > 0 ? Math.round((window.scrollY / scrollable) * 100) : 100;
      var milestones = [25, 50, 75, 90, 100];
      depth = Math.max(0, Math.min(100, depth));
      maxScroll = Math.max(maxScroll, depth);
      milestones.forEach(function (milestone) {
        if (depth >= milestone && !sentScroll[milestone]) {
          sentScroll[milestone] = true;
          track("scroll_depth", { depth: milestone, seconds_visible: visibleSeconds() });
        }
      });
    }

    [10, 30, 60, 120].forEach(function (seconds) {
      window.setTimeout(function () {
        if (document.visibilityState !== "visible" || sentTime[seconds]) return;
        sentTime[seconds] = true;
        track("time_milestone", { seconds: seconds, max_scroll_depth: maxScroll });
      }, seconds * 1000);
    });

    if ("IntersectionObserver" in window) {
      var sections = document.querySelectorAll("[data-chapter]");
      var observer = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            var element = entry.target;
            var key = element.getAttribute("data-chapter") || element.id || "unknown";
            if (!entry.isIntersecting || entry.intersectionRatio < 0.45 || seenSections[key]) {
              return;
            }
            seenSections[key] = true;
            track("section_view", {
              section_id: element.id || null,
              chapter: element.getAttribute("data-chapter") || null,
              section_name: element.getAttribute("data-chapter-title") || null,
              seconds_visible: visibleSeconds(),
              max_scroll_depth: maxScroll
            });
          });
        },
        { threshold: [0.45] }
      );
      Array.prototype.forEach.call(sections, function (section) {
        observer.observe(section);
      });
    }

    document.addEventListener(
      "click",
      function (event) {
        var target = event.target;
        if (!target || typeof target.closest !== "function") return;
        var link = target.closest("a");
        if (!link) return;
        var isBuy =
          link.classList.contains("header-buy") ||
          link.classList.contains("hero-buy-primary") ||
          link.classList.contains("buy-button") ||
          link.classList.contains("desktop-buy-dock") ||
          Boolean(link.closest(".mobile-buy")) ||
          Boolean(link.closest(".menu-panel"));
        if (!isBuy) return;
        track("buy_intent_timing", {
          seconds_to_click: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
          seconds_visible: visibleSeconds(),
          max_scroll_depth: maxScroll,
          placement: link.classList.contains("hero-buy-primary")
            ? "hero"
            : link.classList.contains("header-buy")
              ? "header"
              : link.classList.contains("desktop-buy-dock")
                ? "desktop_dock"
                : link.closest(".mobile-buy")
                  ? "mobile_sticky"
                  : link.closest(".menu-panel")
                    ? "menu"
                    : "offer"
        });
      },
      true
    );

    function sendSummary(reason) {
      if (summarySent) return;
      summarySent = true;
      track("session_summary", {
        reason: reason,
        duration_seconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
        visible_seconds: visibleSeconds(),
        max_scroll_depth: maxScroll,
        sections_viewed: Object.keys(seenSections).length,
        quick_exit: visibleSeconds() < 10 && maxScroll < 25
      });
    }

    window.addEventListener("error", function (event) {
      track("javascript_error", {
        message: String(event.message || "Unknown JavaScript error").slice(0, 500),
        filename: event.filename || null,
        line: event.lineno || null,
        column: event.colno || null
      });
    });

    window.addEventListener("unhandledrejection", function (event) {
      track("javascript_error", {
        message: String(event.reason || "Unhandled promise rejection").slice(0, 500),
        kind: "unhandledrejection"
      });
    });

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        visibleStartedAt = Date.now();
      } else if (visibleStartedAt !== null) {
        visibleMs += Date.now() - visibleStartedAt;
        visibleStartedAt = null;
      }
    });

    window.addEventListener("scroll", updateScroll, { passive: true });
    window.addEventListener("pagehide", function () {
      sendSummary("pagehide");
    });
    updateScroll();
  }

  var api = {
    track: track,
    endpoint: endpoint,
    visitorId: visitorId,
    getSessionId: function () {
      return ensureSession().record.id;
    },
    resetSession: resetSession,
    isInternalTraffic: isInternalTraffic,
    setInternalTraffic: setInternalTraffic,
    sessionTimeoutMinutes: sessionTimeoutMinutes
  };

  Object.defineProperty(api, "sessionId", {
    enumerable: true,
    get: function () {
      return ensureSession().record.id;
    }
  });

  window.ConversionTracker = Object.freeze(api);

  installSpaNavigationTracking();
  if (autoBehavior) installBehaviorTracking();

  if (autoPageViews) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", trackPageView, { once: true });
    } else {
      trackPageView();
    }
  }

  log("ready", {
    visitor_id: visitorId,
    session_id: initialSession.id,
    session_timeout_minutes: sessionTimeoutMinutes,
    internal_traffic: isInternalTraffic(),
    endpoint: endpoint
  });
})();
