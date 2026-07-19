(function () {
  "use strict";

  if (window.__fbAdsConversionTrackerLoaderLoaded || window.__fbAdsConversionTrackerLoaded) return;
  window.__fbAdsConversionTrackerLoaderLoaded = true;

  var source = document.currentScript;
  if (!source) {
    var scripts = document.getElementsByTagName("script");
    source = scripts[scripts.length - 1];
  }

  var sourceUrl = new URL(source.src, window.location.href);
  var next = document.createElement("script");
  next.src = sourceUrl.origin + "/tracker-v3.js";
  next.async = source.async !== false;

  Array.prototype.forEach.call(source.attributes || [], function (attribute) {
    if (attribute.name.indexOf("data-") === 0) {
      next.setAttribute(attribute.name, attribute.value);
    }
  });

  next.addEventListener("error", function () {
    if (window.console) window.console.error("[ConversionTracker] Could not load tracker-v3.js");
  });

  (source.parentNode || document.head || document.documentElement).insertBefore(next, source.nextSibling);
})();
