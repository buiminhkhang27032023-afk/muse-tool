// Tiến trình nền của extension: làm "đồng hồ" cho các tab AI.
// Tab ở nền bị Chrome làm chậm setTimeout/setInterval, nhưng tin nhắn qua cổng thì không bị chậm.
const ports = new Set();
chrome.runtime.onConnect.addListener(function(port) {
  if (port.name !== "muse-clock") return;
  ports.add(port);
  port.onMessage.addListener(function() { /* nhận nhịp "hb" từ tab để giữ tiến trình nền sống */ });
  port.onDisconnect.addListener(function() { ports.delete(port); });
});
setInterval(function() {
  ports.forEach(function(p) { try { p.postMessage({ t: "tick" }); } catch (e) { ports.delete(p); } });
}, 500);
