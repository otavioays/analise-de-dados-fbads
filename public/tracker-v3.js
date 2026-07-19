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
  var visitorStateKey = storagePrefix + "_visitor_state_v3";
  var sessionStorageKey = storagePrefix + "_session_v2";
  var firstTouchStorageKey = storagePrefix + "_first_touch";
  var sessionAttributionKey = storagePrefix + "_session_attribution_v2";
  var internalTrafficStorageKey = storagePrefix + "_internal_traffic";
  var tabStorageKey = storagePrefix + "_tab_id";
  var outboxStorageKey = storagePrefix + "_outbox_v3";

  function log() {
    if (!debug || !window.console) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[ConversionTracker v3]");
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
    } catch (_error) {}
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
    Object.keys(object || {}).forEach(function (key) {
      var value = object[key];
      if (value !== null && value !== undefined && value !== "") output[key] = value;
    });
    return output;
  }

  function hasValues(value) {
    return value && typeof value === "object" && Object.keys(value).length > 0;
  }

  function getOrCreateId(storage, key) {
    var existing = readStorage(storage, key);
    if (existing) return existing;
    var created = uuid();
    writeStorage(storage, key, created);
    return created;
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
      gclid: params.get("gclid"),
      ttclid: params.get("ttclid")
    });
  }

  function normalizeSessionState(candidate) {
    if (!candidate || typeof candidate !== "object" || typeof candidate.id !== "string") return null;
    var startedAt = Number(candidate.started_at);
    var lastActivityAt = Number(candidate.last_activity_at);
    if (!Number.isFinite(startedAt) || !Number.isFinite(lastActivityAt)) return null;
    return {
      id: candidate.id,
      started_at: startedAt,
      last_activity_at: lastActivityAt,
      version: 3,
      page_views: Math.max(0, Number(candidate.page_views || 0))
    };
  }

  function createSessionState(now) {
    var state = {
      id: uuid(),
      started_at: now,
      last_activity_at: now,
      version: 3,
      page_views: 0
    };
    writeStorage(window.localStorage, sessionStorageKey, JSON.stringify(state));
    removeStorage(window.localStorage, sessionAttributionKey);
    return state;
  }

  function resolveSessionState(options) {
    var settings = options || {};
    var now = Date.now();
    var stored = normalizeSessionState(parseJson(readStorage(window.localStorage, sessionStorageKey)));
    var expired = !stored || now - stored.last_activity_at > sessionTimeoutMs;
    var state = settings.forceNew || expired ? createSessionState(now) : stored;
    if (settings.touch !== false) {
      state.last_activity_at = now;
      writeStorage(window.localStorage, sessionStorageKey, JSON.stringify(state));
    }
    return state;
  }

  function internalTrafficFromUrl() {
    var value = new URLSearchParams(window.location.search).get("ct_internal");
    if (value === "1" || value === "true") return true;
    if (value === "0" || value === "false") return false;
    return null;
  }

  function resolveInternalTraffic() {
    var urlSetting = internalTrafficFromUrl();
    if (urlSetting !== null) {
      writeStorage(window.localStorage, internalTrafficStorageKey, urlSetting ? "true" : "false");
      return urlSetting;
    }
    if (script.getAttribute("data-internal") === "true") return true;
    return readStorage(window.localStorage, internalTrafficStorageKey) === "true";
  }

  function resolveAttribution(sessionState) {
    var current = readUrlAttribution();
    var firstTouch = parseJson(readStorage(window.localStorage, firstTouchStorageKey));
    var storedSessionTouch = parseJson(readStorage(window.localStorage, sessionAttributionKey));
    var sessionTouch =
      storedSessionTouch && storedSessionTouch.session_id === sessionState.id
        ? storedSessionTouch.attribution
        : null;

    if (hasValues(current)) {
      sessionTouch = current;
      writeStorage(
        window.localStorage,
        sessionAttributionKey,
        JSON.stringify({ session_id: sessionState.id, attribution: sessionTouch })
      );
    }

    if (!hasValues(firstTouch) && hasValues(current)) {
      firstTouch = Object.assign({}, current, {
        landing_page: window.location.href,
        captured_at: new Date().toISOString()
      });
      writeStorage(window.localStorage, firstTouchStorageKey, JSON.stringify(firstTouch));
    }

    return {
      active: hasValues(sessionTouch) ? sessionTouch : hasValues(current) ? current : firstTouch || {},
      firstTouch: firstTouch || {}
    };
  }

  function getDeviceType() {
    var width = window.innerWidth || (window.screen && window.screen.width) || 0;
    if (width > 0 && width < 768) return "mobile";
    if (width >= 768 && width < 1024) return "tablet";
    return "desktop";
  }

  function mediaMatches(query) {
    try {
      return Boolean(window.matchMedia && window.matchMedia(query).matches);
    } catch (_error) {
      return false;
    }
  }

  function connectionContext() {
    var connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!connection) return {};
    return compactObject({
      connection_type: connection.type,
      effective_connection_type: connection.effectiveType,
      downlink_mbps: connection.downlink,
      network_rtt_ms: connection.rtt,
      save_data: connection.saveData
    });
  }

  function navigationType() {
    try {
      var entries = performance.getEntriesByType("navigation");
      if (entries && entries[0] && entries[0].type) return entries[0].type;
    } catch (_error) {}
    return null;
  }

  function commonTechnicalContext() {
    return Object.assign(
      {
        tracker_version: 3,
        viewport_width: window.innerWidth || null,
        viewport_height: window.innerHeight || null,
        screen_height: window.screen && window.screen.height ? window.screen.height : null,
        device_pixel_ratio: window.devicePixelRatio || 1,
        timezone: Intl && Intl.DateTimeFormat ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
        platform: navigator.userAgentData && navigator.userAgentData.platform
          ? navigator.userAgentData.platform
          : navigator.platform || null,
        cookie_enabled: navigator.cookieEnabled,
        online: navigator.onLine,
        color_scheme: mediaMatches("(prefers-color-scheme: dark)") ? "dark" : "light",
        reduced_motion: mediaMatches("(prefers-reduced-motion: reduce)"),
        navigation_type: navigationType()
      },
      connectionContext()
    );
  }

  var visitorId = getOrCreateId(window.localStorage, visitorStorageKey);
  var tabId = getOrCreateId(window.sessionStorage, tabStorageKey);
  var pageInstanceId = uuid();
  var sessionState = resolveSessionState({ touch: true });
  var internalTraffic = resolveInternalTraffic();
  var lastTrackedUrl = null;

  function updateVisitorState() {
    var now = Date.now();
    var stored = parseJson(readStorage(window.localStorage, visitorStateKey)) || {};
    var newSession = stored.last_session_id !== sessionState.id;
    var state = {
      first_seen_at: Number(stored.first_seen_at || now),
      last_seen_at: now,
      visit_number: Math.max(0, Number(stored.visit_number || 0)) + (newSession ? 1 : 0),
      page_views_total: Math.max(0, Number(stored.page_views_total || 0)) + 1,
      last_session_id: sessionState.id
    };
    writeStorage(window.localStorage, visitorStateKey, JSON.stringify(state));
    return state;
  }

  sessionState.page_views += 1;
  writeStorage(window.localStorage, sessionStorageKey, JSON.stringify(sessionState));
  var visitorState = updateVisitorState();
  var technicalContext = commonTechnicalContext();

  function currentSessionState() {
    sessionState = resolveSessionState({ touch: true });
    return sessionState;
  }

  function buildPayload(eventName, properties) {
    var activeSession = currentSessionState();
    var attribution = resolveAttribution(activeSession);
    var active = attribution.active || {};
    var safeProperties =
      properties && typeof properties === "object" && !Array.isArray(properties) ? properties : {};

    return {
      event_id: uuid(),
      event_name: eventName,
      visitor_id: visitorId,
      session_id: activeSession.id,
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
      properties: Object.assign({}, technicalContext, safeProperties, {
        first_touch: attribution.firstTouch,
        gclid: active.gclid || null,
        ttclid: active.ttclid || null,
        session_storage_version: 3,
        session_started_at: new Date(activeSession.started_at).toISOString(),
        session_last_activity_at: new Date(activeSession.last_activity_at).toISOString(),
        session_timeout_minutes: sessionTimeoutMinutes,
        page_view_index_session: activeSession.page_views,
        page_view_index_visitor: visitorState.page_views_total,
        visit_number: visitorState.visit_number,
        visitor_first_seen_at: new Date(visitorState.first_seen_at).toISOString(),
        returning_visitor: visitorState.visit_number > 1 || visitorState.page_views_total > 1,
        page_instance_id: pageInstanceId,
        tab_id: tabId,
        internal_traffic: internalTraffic,
        test: internalTraffic || safeProperties.test === true
      })
    };
  }

  function readOutbox() {
    var parsed = parseJson(readStorage(window.localStorage, outboxStorageKey));
    return Array.isArray(parsed) ? parsed.slice(-100) : [];
  }

  function writeOutbox(items) {
    writeStorage(window.localStorage, outboxStorageKey, JSON.stringify(items.slice(-100)));
  }

  function enqueue(payload) {
    var items = readOutbox();
    if (!items.some(function (item) { return item && item.event_id === payload.event_id; })) {
      items.push(payload);
      writeOutbox(items);
    }
  }

  function send(payload, options) {
    var settings = options || {};
    log("sending", payload.event_name, payload);

    if (settings.beacon && navigator.sendBeacon) {
      try {
        var blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
        if (navigator.sendBeacon(endpoint, blob)) return Promise.resolve(true);
      } catch (_error) {}
    }

    return fetch(endpoint, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (response) {
        if (!response.ok) throw new Error("Tracking request failed with status " + response.status);
        return true;
      })
      .catch(function (error) {
        log("failed", payload.event_name, error);
        if (settings.queue !== false) enqueue(payload);
        return false;
      });
  }

  function flushOutbox() {
    if (!navigator.onLine) return Promise.resolve(false);
    var items = readOutbox();
    if (!items.length) return Promise.resolve(true);
    var remaining = items.slice();
    var chain = Promise.resolve();
    items.slice(0, 20).forEach(function (payload) {
      chain = chain.then(function () {
        return send(payload, { queue: false }).then(function (ok) {
          if (ok) remaining = remaining.filter(function (item) { return item.event_id !== payload.event_id; });
        });
      });
    });
    return chain.then(function () {
      writeOutbox(remaining);
      return remaining.length === 0;
    });
  }

  function track(eventName, properties, options) {
    if (typeof eventName !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(eventName)) {
      log("ignored invalid event name", eventName);
      return Promise.resolve(false);
    }
    return send(buildPayload(eventName, properties), options);
  }

  function trackPageView() {
    var currentUrl = window.location.href;
    if (currentUrl === lastTrackedUrl) return;
    lastTrackedUrl = currentUrl;
    track("page_view", {
      document_visibility: document.visibilityState,
      history_length: window.history.length,
      referrer_host: document.referrer ? new URL(document.referrer).hostname : null
    });
  }

  function describeElement(element) {
    if (!element || !element.tagName) return {};
    return {
      element_id: element.id || null,
      element_tag: element.tagName.toLowerCase(),
      element_role: element.getAttribute("role") || null,
      element_text: (element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 160) || null,
      element_class: typeof element.className === "string" ? element.className.slice(0, 240) : null
    };
  }

  function propertiesFromElement(element) {
    var customProperties = parseJson(element.getAttribute("data-track-properties"));
    return Object.assign(
      {},
      describeElement(element),
      customProperties && typeof customProperties === "object" ? customProperties : {}
    );
  }

  document.addEventListener(
    "click",
    function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== "function") return;
      var trackedElement = target.closest("[data-track]");
      if (trackedElement) {
        track(trackedElement.getAttribute("data-track"), propertiesFromElement(trackedElement));
      }
      var link = target.closest("a[href]");
      if (link) {
        try {
          var destination = new URL(link.href, window.location.href);
          if (destination.hostname && destination.hostname !== window.location.hostname) {
            track("outbound_link_click", Object.assign(describeElement(link), {
              destination_host: destination.hostname,
              destination_path: destination.pathname,
              modified_click: Boolean(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
            }));
          }
        } catch (_error) {}
      }
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
    var activeSections = {};
    var sectionDurations = {};
    var summarySequence = 0;
    var lastSummaryAt = 0;
    var hiddenCount = 0;
    var returnCount = 0;
    var focusCount = document.hasFocus && document.hasFocus() ? 1 : 0;
    var blurCount = 0;
    var clickCount = 0;
    var pointerCount = 0;
    var firstInteractionAt = null;
    var lastInteractionAt = null;
    var rageClickCount = 0;
    var deadClickCount = 0;
    var recentClicks = [];
    var lastRageAt = 0;
    var mutationCounter = 0;
    var performanceMetrics = {
      fcp_ms: null,
      lcp_ms: null,
      cls: 0,
      inp_ms: null
    };

    if (window.MutationObserver) {
      new MutationObserver(function (mutations) {
        mutationCounter += mutations.length;
      }).observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    }

    function visibleSeconds() {
      var total = visibleMs;
      if (visibleStartedAt !== null) total += Date.now() - visibleStartedAt;
      return Math.max(0, Math.round(total / 1000));
    }

    function elapsedSeconds() {
      return Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    }

    function scrollDepth() {
      var scrollable = document.documentElement.scrollHeight - window.innerHeight;
      var depth = scrollable > 0 ? Math.round((window.scrollY / scrollable) * 100) : 100;
      return Math.max(0, Math.min(100, depth));
    }

    function updateScroll() {
      var depth = scrollDepth();
      var milestones = [10, 25, 50, 75, 90, 100];
      maxScroll = Math.max(maxScroll, depth);
      milestones.forEach(function (milestone) {
        if (depth >= milestone && !sentScroll[milestone]) {
          sentScroll[milestone] = true;
          track("scroll_depth", {
            depth: milestone,
            seconds_visible: visibleSeconds(),
            seconds_elapsed: elapsedSeconds()
          });
        }
      });
    }

    [5, 10, 30, 60, 120, 300].forEach(function (seconds) {
      window.setTimeout(function () {
        if (document.visibilityState !== "visible" || sentTime[seconds]) return;
        sentTime[seconds] = true;
        track("time_milestone", {
          seconds: seconds,
          max_scroll_depth: maxScroll,
          interactions: pointerCount
        });
      }, seconds * 1000);
    });

    function sectionKey(element) {
      return element.getAttribute("data-track-section") ||
        element.getAttribute("data-chapter") ||
        element.id ||
        "unknown";
    }

    function closeSection(key, reason) {
      if (!activeSections[key]) return;
      var durationMs = Math.max(0, Date.now() - activeSections[key]);
      delete activeSections[key];
      sectionDurations[key] = (sectionDurations[key] || 0) + durationMs;
      if (durationMs >= 750) {
        track("section_engagement", {
          section_key: key,
          visible_ms: durationMs,
          cumulative_visible_ms: sectionDurations[key],
          reason: reason,
          max_scroll_depth: maxScroll
        });
      }
    }

    if ("IntersectionObserver" in window) {
      var sections = document.querySelectorAll("[data-chapter], [data-track-section]");
      var observer = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            var element = entry.target;
            var key = sectionKey(element);
            if (entry.isIntersecting && entry.intersectionRatio >= 0.45) {
              if (!activeSections[key]) activeSections[key] = Date.now();
              if (!seenSections[key]) {
                seenSections[key] = true;
                track("section_view", {
                  section_id: element.id || null,
                  chapter: element.getAttribute("data-chapter") || null,
                  section_name: element.getAttribute("data-chapter-title") || null,
                  section_key: key,
                  seconds_visible: visibleSeconds(),
                  max_scroll_depth: maxScroll
                });
              }
            } else {
              closeSection(key, "intersection_exit");
            }
          });
        },
        { threshold: [0, 0.45, 0.75] }
      );
      Array.prototype.forEach.call(sections, function (section) {
        observer.observe(section);
      });
    }

    function markInteraction() {
      var now = Date.now();
      pointerCount += 1;
      if (firstInteractionAt === null) firstInteractionAt = now;
      lastInteractionAt = now;
    }

    document.addEventListener("pointerdown", markInteraction, true);
    document.addEventListener(
      "click",
      function (event) {
        clickCount += 1;
        var now = Date.now();
        var target = event.target && typeof event.target.closest === "function" ? event.target : null;
        recentClicks.push({ x: event.clientX, y: event.clientY, t: now });
        recentClicks = recentClicks.filter(function (item) { return now - item.t <= 1400; });

        if (recentClicks.length >= 3 && now - lastRageAt > 5000) {
          var anchor = recentClicks[recentClicks.length - 1];
          var clustered = recentClicks.slice(-3).every(function (item) {
            var dx = item.x - anchor.x;
            var dy = item.y - anchor.y;
            return Math.sqrt(dx * dx + dy * dy) <= 48;
          });
          if (clustered) {
            lastRageAt = now;
            rageClickCount += 1;
            track("interaction_anomaly", Object.assign(describeElement(target), {
              anomaly_type: "rage_click",
              click_count: 3,
              x: anchor.x,
              y: anchor.y,
              seconds_elapsed: elapsedSeconds()
            }));
          }
        }

        if (!target) return;
        var interactive = target.closest(
          "a,button,input,select,textarea,label,[role='button'],[role='link'],[onclick],[data-track]"
        );
        if (interactive) return;
        var beforeUrl = window.location.href;
        var beforeMutations = mutationCounter;
        window.setTimeout(function () {
          if (window.location.href === beforeUrl && mutationCounter === beforeMutations) {
            deadClickCount += 1;
            track("interaction_anomaly", Object.assign(describeElement(target), {
              anomaly_type: "dead_click",
              x: event.clientX,
              y: event.clientY,
              seconds_elapsed: elapsedSeconds()
            }));
          }
        }, 700);
      },
      true
    );

    function collectNavigationMetrics() {
      try {
        var nav = performance.getEntriesByType("navigation")[0];
        if (!nav) return {};
        return compactObject({
          navigation_type: nav.type,
          dns_ms: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
          connect_ms: Math.round(nav.connectEnd - nav.connectStart),
          tls_ms: nav.secureConnectionStart > 0 ? Math.round(nav.connectEnd - nav.secureConnectionStart) : null,
          ttfb_ms: Math.round(nav.responseStart - nav.requestStart),
          response_ms: Math.round(nav.responseEnd - nav.responseStart),
          dom_interactive_ms: Math.round(nav.domInteractive - nav.startTime),
          dom_content_loaded_ms: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
          load_ms: Math.round(nav.loadEventEnd - nav.startTime),
          transfer_size: nav.transferSize,
          encoded_body_size: nav.encodedBodySize,
          decoded_body_size: nav.decodedBodySize
        });
      } catch (_error) {
        return {};
      }
    }

    try {
      var paints = performance.getEntriesByType("paint");
      paints.forEach(function (entry) {
        if (entry.name === "first-contentful-paint") performanceMetrics.fcp_ms = Math.round(entry.startTime);
      });
    } catch (_error) {}

    if (window.PerformanceObserver) {
      try {
        new PerformanceObserver(function (list) {
          var entries = list.getEntries();
          var last = entries[entries.length - 1];
          if (last) performanceMetrics.lcp_ms = Math.round(last.startTime);
        }).observe({ type: "largest-contentful-paint", buffered: true });
      } catch (_error) {}
      try {
        new PerformanceObserver(function (list) {
          list.getEntries().forEach(function (entry) {
            if (!entry.hadRecentInput) performanceMetrics.cls += entry.value;
          });
        }).observe({ type: "layout-shift", buffered: true });
      } catch (_error) {}
      try {
        new PerformanceObserver(function (list) {
          list.getEntries().forEach(function (entry) {
            if (performanceMetrics.inp_ms === null || entry.duration > performanceMetrics.inp_ms) {
              performanceMetrics.inp_ms = Math.round(entry.duration);
            }
          });
        }).observe({ type: "event", buffered: true, durationThreshold: 40 });
      } catch (_error) {}
    }

    function summaryProperties(reason, final) {
      Object.keys(activeSections).forEach(function (key) { closeSection(key, reason); });
      var normalizedSectionDurations = {};
      Object.keys(sectionDurations).forEach(function (key) {
        normalizedSectionDurations[key] = Math.round(sectionDurations[key]);
      });
      return Object.assign({}, collectNavigationMetrics(), performanceMetrics, {
        reason: reason,
        is_final: Boolean(final),
        summary_sequence: summarySequence,
        duration_seconds: elapsedSeconds(),
        visible_seconds: visibleSeconds(),
        max_scroll_depth: maxScroll,
        sections_viewed: Object.keys(seenSections).length,
        section_visible_ms: normalizedSectionDurations,
        quick_exit: visibleSeconds() < 10 && maxScroll < 25 && pointerCount === 0,
        hidden_count: hiddenCount,
        return_count: returnCount,
        focus_count: focusCount,
        blur_count: blurCount,
        pointer_interactions: pointerCount,
        click_count: clickCount,
        first_interaction_ms: firstInteractionAt === null ? null : firstInteractionAt - startedAt,
        last_interaction_ms: lastInteractionAt === null ? null : lastInteractionAt - startedAt,
        rage_click_count: rageClickCount,
        dead_click_count: deadClickCount
      });
    }

    function sendSummary(reason, final) {
      var now = Date.now();
      if (!final && now - lastSummaryAt < 3000) return;
      lastSummaryAt = now;
      summarySequence += 1;
      track("session_summary", summaryProperties(reason, final), {
        beacon: Boolean(final),
        queue: !final
      });
    }

    function sendPerformance() {
      track("page_performance", Object.assign({}, collectNavigationMetrics(), performanceMetrics));
    }

    window.addEventListener("load", function () {
      window.setTimeout(sendPerformance, 0);
      window.setTimeout(sendPerformance, 8000);
    }, { once: true });

    window.setInterval(function () {
      if (document.visibilityState === "visible") sendSummary("interval_30s", false);
    }, 30000);

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") {
        visibleStartedAt = Date.now();
        returnCount += 1;
        sendSummary("visibility_return", false);
      } else {
        hiddenCount += 1;
        if (visibleStartedAt !== null) {
          visibleMs += Date.now() - visibleStartedAt;
          visibleStartedAt = null;
        }
        sendSummary("visibility_hidden", false);
      }
    });

    window.addEventListener("focus", function () { focusCount += 1; });
    window.addEventListener("blur", function () { blurCount += 1; });
    window.addEventListener("scroll", updateScroll, { passive: true });
    window.addEventListener("pagehide", function () { sendSummary("pagehide", true); });

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

    updateScroll();
  }

  function forceNewSession() {
    sessionState = resolveSessionState({ forceNew: true, touch: true });
    sessionState.page_views = 1;
    writeStorage(window.localStorage, sessionStorageKey, JSON.stringify(sessionState));
    log("new session", sessionState.id);
    return sessionState.id;
  }

  function setInternalTraffic(value) {
    internalTraffic = Boolean(value);
    writeStorage(window.localStorage, internalTrafficStorageKey, internalTraffic ? "true" : "false");
    return internalTraffic;
  }

  window.addEventListener("storage", function (event) {
    if (event.key === sessionStorageKey && event.newValue) {
      var incoming = normalizeSessionState(parseJson(event.newValue));
      if (incoming) sessionState = incoming;
    }
    if (event.key === internalTrafficStorageKey) internalTraffic = event.newValue === "true";
  });
  window.addEventListener("online", flushOutbox);

  window.ConversionTracker = Object.freeze({
    track: track,
    forceNewSession: forceNewSession,
    setInternalTraffic: setInternalTraffic,
    flush: flushOutbox,
    getVisitorId: function () { return visitorId; },
    getSessionId: function () { return currentSessionState().id; },
    getPageInstanceId: function () { return pageInstanceId; },
    isInternalTraffic: function () { return internalTraffic; },
    endpoint: endpoint,
    version: 3
  });

  installSpaNavigationTracking();
  if (autoBehavior) installBehaviorTracking();

  if (autoPageViews) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", trackPageView, { once: true });
    } else {
      trackPageView();
    }
  }

  window.setTimeout(flushOutbox, 500);
  log("ready", {
    visitor_id: visitorId,
    session_id: sessionState.id,
    page_instance_id: pageInstanceId,
    internal_traffic: internalTraffic,
    endpoint: endpoint,
    version: 3
  });
})();
