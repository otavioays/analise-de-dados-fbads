(function () {
  "use strict";

  if (window.__fbAdsConversionTrackerLoaded) {
    return;
  }

  window.__fbAdsConversionTrackerLoaded = true;

  var script = document.currentScript;
  if (!script) {
    var scripts = document.getElementsByTagName("script");
    script = scripts[scripts.length - 1];
  }

  var scriptUrl = new URL(script.src, window.location.href);
  var endpoint =
    script.getAttribute("data-endpoint") || scriptUrl.origin + "/api/events";
  var debug = script.getAttribute("data-debug") === "true";
  var autoPageViews = script.getAttribute("data-auto-page-view") !== "false";
  var storagePrefix =
    script.getAttribute("data-storage-prefix") || "fbads_conversion_tracker";

  var visitorStorageKey = storagePrefix + "_visitor_id";
  var sessionStorageKey = storagePrefix + "_session_id";
  var firstTouchStorageKey = storagePrefix + "_first_touch";
  var sessionAttributionKey = storagePrefix + "_session_attribution";

  function log() {
    if (!debug || !window.console) {
      return;
    }

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

  function getOrCreateId(storage, key) {
    var existing = readStorage(storage, key);
    if (existing) {
      return existing;
    }

    var created = uuid();
    writeStorage(storage, key, created);
    return created;
  }

  function parseJson(value) {
    if (!value) {
      return null;
    }

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
      if (value !== null && value !== undefined && value !== "") {
        output[key] = value;
      }
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
      fbclid: params.get("fbclid"),
    });
  }

  function hasAttribution(attribution) {
    return Object.keys(attribution).length > 0;
  }

  function resolveAttribution() {
    var current = readUrlAttribution();
    var firstTouch = parseJson(readStorage(window.localStorage, firstTouchStorageKey));
    var sessionTouch = parseJson(
      readStorage(window.sessionStorage, sessionAttributionKey),
    );

    if (hasAttribution(current)) {
      sessionTouch = current;
      writeStorage(
        window.sessionStorage,
        sessionAttributionKey,
        JSON.stringify(sessionTouch),
      );
    }

    if (!firstTouch && hasAttribution(current)) {
      firstTouch = Object.assign({}, current, {
        landing_page: window.location.href,
        captured_at: new Date().toISOString(),
      });
      writeStorage(
        window.localStorage,
        firstTouchStorageKey,
        JSON.stringify(firstTouch),
      );
    }

    return {
      active: sessionTouch || current || firstTouch || {},
      firstTouch: firstTouch || {},
    };
  }

  function getDeviceType() {
    var width = window.screen && window.screen.width ? window.screen.width : 0;

    if (width > 0 && width < 768) {
      return "mobile";
    }

    if (width >= 768 && width < 1_024) {
      return "tablet";
    }

    return "desktop";
  }

  var visitorId = getOrCreateId(window.localStorage, visitorStorageKey);
  var sessionId = getOrCreateId(window.sessionStorage, sessionStorageKey);
  var lastTrackedUrl = null;

  function buildPayload(eventName, properties) {
    var attribution = resolveAttribution();
    var active = attribution.active;
    var safeProperties =
      properties && typeof properties === "object" && !Array.isArray(properties)
        ? properties
        : {};

    return {
      event_id: uuid(),
      event_name: eventName,
      visitor_id: visitorId,
      session_id: sessionId,
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
      }),
    };
  }

  function send(payload) {
    log("sending", payload.event_name, payload);

    return fetch(endpoint, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("Tracking request failed with status " + response.status);
        }

        log("stored", payload.event_name);
        return true;
      })
      .catch(function (error) {
        log("failed", payload.event_name, error);
        return false;
      });
  }

  function track(eventName, properties) {
    if (
      typeof eventName !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(eventName)
    ) {
      log("ignored invalid event name", eventName);
      return Promise.resolve(false);
    }

    return send(buildPayload(eventName, properties));
  }

  function trackPageView() {
    var currentUrl = window.location.href;
    if (currentUrl === lastTrackedUrl) {
      return;
    }

    lastTrackedUrl = currentUrl;
    track("page_view");
  }

  function propertiesFromElement(element) {
    var customProperties = parseJson(
      element.getAttribute("data-track-properties"),
    );

    return Object.assign(
      {
        element_id: element.id || null,
        element_tag: element.tagName.toLowerCase(),
        element_text: (element.textContent || "").trim().slice(0, 200) || null,
      },
      customProperties && typeof customProperties === "object"
        ? customProperties
        : {},
    );
  }

  document.addEventListener(
    "click",
    function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== "function") {
        return;
      }

      var trackedElement = target.closest("[data-track]");
      if (!trackedElement) {
        return;
      }

      var eventName = trackedElement.getAttribute("data-track");
      track(eventName, propertiesFromElement(trackedElement));
    },
    true,
  );

  function installSpaNavigationTracking() {
    ["pushState", "replaceState"].forEach(function (methodName) {
      var original = window.history[methodName];
      if (typeof original !== "function") {
        return;
      }

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

  window.ConversionTracker = Object.freeze({
    track: track,
    visitorId: visitorId,
    sessionId: sessionId,
    endpoint: endpoint,
  });

  installSpaNavigationTracking();

  if (autoPageViews) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", trackPageView, { once: true });
    } else {
      trackPageView();
    }
  }

  log("ready", {
    visitor_id: visitorId,
    session_id: sessionId,
    endpoint: endpoint,
  });
})();
