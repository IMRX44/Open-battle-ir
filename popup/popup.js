/* Popup — a thin remote for the in-page panel. */
(function () {
  "use strict";

  var dot = document.getElementById("dot");
  var stateText = document.getElementById("stateText");
  var botBtn = document.getElementById("bot");
  var running = false;

  function withTab(fn) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || !tab.id) return;
      if (
        !/^https:\/\/([a-z0-9-]+\.)?(openbattle\.ir|openfront\.io)\//.test(
          tab.url || "",
        )
      ) {
        stateText.textContent = "این تب بازی نیست";
        return;
      }
      fn(tab);
    });
  }

  function send(cmd, cb) {
    withTab(function (tab) {
      chrome.tabs.sendMessage(tab.id, { cmd: cmd }, function (res) {
        if (chrome.runtime.lastError) {
          stateText.textContent = "صفحه را یک بار تازه کن";
          return;
        }
        if (cb) cb(res);
      });
    });
  }

  function refresh() {
    send("status", function (res) {
      var snap = res && res.snap;
      var live = !!(snap && snap.attached);
      dot.className = "dot" + (live ? " ok" : "");
      running = !!(snap && snap.bot && snap.bot.running);
      botBtn.disabled = !live;
      botBtn.textContent = running ? "توقف ربات" : "شروع بازی خودکار";
      if (!live) {
        stateText.textContent = "وارد یک بازی شو";
      } else if (snap.me) {
        stateText.textContent =
          snap.me.name + " · " + snap.me.tiles + " کاشی" + (running ? " · ربات فعال" : "");
      } else {
        stateText.textContent = "متصل به بازی";
      }
    });
  }

  document.getElementById("open").addEventListener("click", function () {
    send("togglePanel");
    window.close();
  });

  botBtn.addEventListener("click", function () {
    send(running ? "botStop" : "botStart", function () {
      setTimeout(refresh, 300);
    });
  });

  refresh();
  setInterval(refresh, 1200);
})();
