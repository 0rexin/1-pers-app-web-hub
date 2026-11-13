// Stands in for Okapi's native side when its UI runs in the hub: same bridge, HTTP underneath.
(function () {
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.okapi) return;
  function deliver(msg, tries) {
    if (window.okapi && typeof window.okapi.receive === "function") return window.okapi.receive(msg);
    if ((tries || 0) < 100) setTimeout(function () { deliver(msg, (tries || 0) + 1); }, 50);
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(String(text || "")).catch(function () {});
  }
  var queue = Promise.resolve(); // keep message order
  function postMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "copy" || msg.type === "paste") return copy(msg.text);
    queue = queue.then(function () {
      return fetch("/api/okapi", {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub": "1" },
        body: JSON.stringify(msg),
      }).then(function (r) { return r.json(); }).then(function (d) {
        (d.messages || []).forEach(function (m) { deliver(m); });
      });
    }).catch(function () {});
  }
  window.webkit = window.webkit || {};
  window.webkit.messageHandlers = window.webkit.messageHandlers || {};
  window.webkit.messageHandlers.okapi = { postMessage: postMessage };
})();
