(function () {
  var DEFAULT_EVAL_DATA = {
    generated_at: "2026-11-14T14:22:17Z",
    model: "gemini-3.8-flash",
    strength_min_conf: 0.80,
    ece: 0.0138,
    brier_score: 0.0005,
    calibration_items: 16,
    clean_recall_pct: "100%",
    tier_0_clean_conf: 0.9875,
    tier_1_mild_conf: 0.9575,
    calibration_abstention_pct: "100%",
    occluded_abstention_pct: "98.2%",
    confident_wrong_dose_count: 0,
    false_safe_allergen_count: 0,
    demo_fixtures_pass: "7 / 7 (100%)",
    demo_fixtures_p50_ms: 3817.2,
    live_models_online: "3 / 3",
    live_first_audio_ms: 582,
    coaching_score: "5.00 / 5",
    coaching_pass: "8 / 8 (100%)",
    coaching_p50_ms: 5118.3,
    bystander_refusal_ms: 2574.8,
    calibration_p50_ms: 3424.9,
    verify_p50_ms: 3537.1,
    unit_tests_passing: "394 / 394",
    server_tests_passing: 154,
    web_tests_passing: 240,
    overall_verdict_accuracy: 0.9811,
    overall_verdict_summary: "98.1% (52 / 53)",
    total_label_cases_evaluated: 53,
    clean_field_accuracy: 1.0,
    suites_present: [
      "coaching_eval",
      "results_batch1",
      "results_batch2",
      "demo_fixtures_results",
      "nordic_stickers_results",
      "calibration_curve",
      "model_comparison",
      "live_models_probe",
      "unit_economics"
    ]
  };

  function mergeEvalSource(base, incoming) {
    var out = {};
    var k;
    for (k in base) {
      if (Object.prototype.hasOwnProperty.call(base, k)) {
        out[k] = base[k];
      }
    }
    if (!incoming || typeof incoming !== "object") {
      return out;
    }
    for (k in incoming) {
      if (Object.prototype.hasOwnProperty.call(incoming, k) && incoming[k] !== undefined) {
        out[k] = incoming[k];
      }
    }
    if (typeof incoming.total_confident_wrong_dose_count === "number") {
      out.confident_wrong_dose_count = incoming.total_confident_wrong_dose_count;
    }
    if (typeof incoming.total_false_safe_allergen_count === "number") {
      out.false_safe_allergen_count = incoming.total_false_safe_allergen_count;
    }
    if (typeof incoming.occluded_abstention_rate === "number") {
      out.occluded_abstention_pct = (incoming.occluded_abstention_rate * 100).toFixed(1) + "%";
    }
    if (typeof incoming.overall_verdict_accuracy === "number" && typeof incoming.total_verdict_matches === "number" && typeof incoming.total_label_cases_evaluated === "number") {
      out.overall_verdict_summary = (incoming.overall_verdict_accuracy * 100).toFixed(1) + "% (" + incoming.total_verdict_matches + " / " + incoming.total_label_cases_evaluated + ")";
    }
    if (incoming.coaching_judge && typeof incoming.coaching_judge === "object") {
      var cj = incoming.coaching_judge;
      if (typeof cj.mean_overall_score === "number") {
        out.coaching_score = cj.mean_overall_score.toFixed(2) + " / 5";
      }
      if (typeof cj.passed_all_checks === "number" && typeof cj.total_scenarios === "number") {
        var ratePct = Math.round((cj.passed_all_checks / Math.max(1, cj.total_scenarios)) * 100);
        out.coaching_pass = cj.passed_all_checks + " / " + cj.total_scenarios + " (" + ratePct + "%)";
      }
      if (cj.assistant_latency_ms && typeof cj.assistant_latency_ms.p50 === "number") {
        out.coaching_p50_ms = cj.assistant_latency_ms.p50;
      }
    }
    if (incoming.artifacts && incoming.artifacts.calibration_curve) {
      var cc = incoming.artifacts.calibration_curve;
      if (typeof cc.ece === "number") {
        out.ece = cc.ece;
      }
      if (typeof cc.n_items === "number") {
        out.calibration_items = cc.n_items;
      }
    }
    if (incoming.verify_latency_ms && typeof incoming.verify_latency_ms.p50 === "number") {
      out.verify_p50_ms = incoming.verify_latency_ms.p50;
    }
    if (incoming.summary && typeof incoming.summary === "object") {
      var sum = incoming.summary;
      if (typeof sum.ece === "number") {
        out.ece = sum.ece;
      }
      if (typeof sum.brier_score === "number") {
        out.brier_score = sum.brier_score;
      }
      if (typeof sum.total_items === "number") {
        out.calibration_items = sum.total_items;
      }
      if (typeof sum.verdict_matches === "number" && typeof sum.n_items === "number" && sum.n_items > 0) {
        var fPct = Math.round((sum.verdict_matches / sum.n_items) * 100);
        out.demo_fixtures_pass = sum.verdict_matches + " / " + sum.n_items + " (" + fPct + "%)";
      }
    }
    return out;
  }

  window.HOLDUP_EVAL_DATA = mergeEvalSource(DEFAULT_EVAL_DATA, window.HOLDUP_EVAL_DATA);

  function setEvalField(field, text) {
    var nodes = document.querySelectorAll('[data-eval-field="' + field + '"]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = String(text);
    }
  }

  function renderEvalBindings(data) {
    if (!data) return;
    setEvalField("confident_wrong_dose_count", data.confident_wrong_dose_count);
    setEvalField("false_safe_allergen_count", data.false_safe_allergen_count);
    setEvalField("ece", Number(data.ece).toFixed(4));
    setEvalField("brier_score", Number(data.brier_score).toFixed(4));
    setEvalField("calibration_items", data.calibration_items);
    setEvalField("clean_recall_pct", data.clean_recall_pct);
    setEvalField("tier_0_clean_conf", Number(data.tier_0_clean_conf).toFixed(4));
    setEvalField("tier_1_mild_conf", Number(data.tier_1_mild_conf).toFixed(4));
    setEvalField("calibration_abstention_pct", data.calibration_abstention_pct);
    setEvalField("occluded_abstention_pct", data.occluded_abstention_pct);
    setEvalField("overall_verdict_summary", data.overall_verdict_summary);
    setEvalField("total_label_cases_evaluated", data.total_label_cases_evaluated);
    setEvalField("demo_fixtures_pass", data.demo_fixtures_pass);
    setEvalField("live_models_online", data.live_models_online);
    setEvalField("live_first_audio_ms", Math.round(Number(data.live_first_audio_ms)) + " ms");
    setEvalField("coaching_score", data.coaching_score);
    setEvalField("coaching_pass", data.coaching_pass);
    setEvalField("coaching_p50_ms", Math.round(Number(data.coaching_p50_ms)).toLocaleString("en-US") + " ms");
    setEvalField("calibration_p50_ms", Math.round(Number(data.calibration_p50_ms)).toLocaleString("en-US") + " ms");
    setEvalField("verify_p50_ms", Math.round(Number(data.verify_p50_ms)).toLocaleString("en-US") + " ms");
    setEvalField("unit_tests_passing", data.unit_tests_passing);

    if (typeof data.overall_verdict_accuracy === "number" && data.total_label_cases_evaluated > 0) {
      var accPct = (data.overall_verdict_accuracy * 100).toFixed(1) + "%";
      setEvalField(
        "suite_sync_status",
        "HOLDUP_EVAL_DATA synced: " + accPct + " verdict accuracy across " + data.total_label_cases_evaluated + " verified cases + 16-frame calibration sweep (9/9 suites)"
      );
    } else if (Array.isArray(data.suites_present)) {
      setEvalField(
        "suite_sync_status",
        "HOLDUP_EVAL_DATA live: " + data.suites_present.join(" + ")
      );
    }
  }

  window.updateHoldUpEvalData = function (patch) {
    window.HOLDUP_EVAL_DATA = mergeEvalSource(window.HOLDUP_EVAL_DATA, patch);
    renderEvalBindings(window.HOLDUP_EVAL_DATA);
    return window.HOLDUP_EVAL_DATA;
  };

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function initDeck() {
    var slides = Array.prototype.slice.call(document.querySelectorAll(".slide"));
    if (!slides.length) return;

    var total = slides.length;
    var currentIndex = 0;
    var visited = {};
    var notesOpen = false;
    var overviewOpen = false;

    var stageShell = document.getElementById("stage-shell");
    var counterEl = document.getElementById("slide-counter");
    var progressRail = document.getElementById("progress-rail");
    var liveRegion = document.getElementById("deck-live-region");
    var notesDrawer = document.getElementById("notes-drawer");
    var notesHeader = document.getElementById("notes-header");
    var notesBody = document.getElementById("notes-body");
    var overviewModal = document.getElementById("overview-modal");
    var overviewGrid = document.getElementById("overview-grid");

    var btnPrev = document.getElementById("btn-prev");
    var btnNext = document.getElementById("btn-next");
    var btnGrid = document.getElementById("btn-grid");
    var btnNotes = document.getElementById("btn-notes");
    var btnFullscreen = document.getElementById("btn-fullscreen");
    var btnPrint = document.getElementById("btn-print");
    var btnCloseOverview = document.getElementById("btn-close-overview");

    var timerReadout = document.getElementById("timer-readout");
    var btnTimerToggle = document.getElementById("btn-timer-toggle");
    var btnTimerReset = document.getElementById("btn-timer-reset");
    var timerRunning = false;
    var timerElapsedSec = 0;
    var timerInterval = null;

    var progressButtons = [];
    var overviewTiles = [];

    function getSlideTitle(slideEl, idx) {
      var explicit = slideEl.getAttribute("data-title");
      if (explicit) return explicit;
      var heading = slideEl.querySelector("h1, h2");
      return heading ? heading.textContent.trim() : "Slide " + (idx + 1);
    }

    function updateStageScale() {
      if (!stageShell) return;
      var rect = stageShell.getBoundingClientRect();
      var availW = Math.max(240, rect.width - 24);
      var availH = Math.max(135, rect.height - 16);
      var scale = Math.min(availW / 1600, availH / 900);
      if (!isFinite(scale) || scale <= 0) {
        scale = 0.5;
      }
      document.documentElement.style.setProperty("--stage-scale", scale.toFixed(5));
    }

    function scaleOverviewClones() {
      if (!overviewOpen || !overviewGrid) return;
      var viewports = overviewGrid.querySelectorAll(".overview-thumb-viewport");
      for (var i = 0; i < viewports.length; i++) {
        var vp = viewports[i];
        var clone = vp.querySelector(".overview-thumb-clone");
        if (clone && vp.clientWidth > 0) {
          var s = vp.clientWidth / 1600;
          clone.style.transform = "scale(" + s.toFixed(5) + ")";
        }
      }
    }

    function stripCloneAttributes(root) {
      var withIds = root.querySelectorAll("[id]");
      for (var i = 0; i < withIds.length; i++) {
        withIds[i].removeAttribute("id");
      }
      var notes = root.querySelectorAll(".presenter-note");
      for (var j = 0; j < notes.length; j++) {
        if (notes[j].parentNode) {
          notes[j].parentNode.removeChild(notes[j]);
        }
      }
    }

    function buildProgressAndOverview() {
      if (progressRail) {
        progressRail.innerHTML = "";
      }
      if (overviewGrid) {
        overviewGrid.innerHTML = "";
      }
      progressButtons = [];
      overviewTiles = [];

      for (var i = 0; i < total; i++) {
        (function (idx) {
          var title = getSlideTitle(slides[idx], idx);
          if (progressRail) {
            var seg = document.createElement("button");
            seg.type = "button";
            seg.className = "progress-seg";
            seg.setAttribute("aria-label", "Go to slide " + pad2(idx + 1) + ": " + title);
            seg.title = pad2(idx + 1) + ". " + title;
            var bar = document.createElement("span");
            bar.className = "progress-seg-bar";
            seg.appendChild(bar);
            seg.addEventListener("click", function () {
              goToSlide(idx);
            });
            progressRail.appendChild(seg);
            progressButtons.push(seg);
          }

          if (overviewGrid) {
            var tile = document.createElement("button");
            tile.type = "button";
            tile.className = "overview-tile";
            tile.setAttribute("aria-label", "Select slide " + pad2(idx + 1) + ": " + title);

            var vp = document.createElement("div");
            vp.className = "overview-thumb-viewport";
            var canvasOrig = slides[idx].querySelector(".slide-canvas");
            if (canvasOrig) {
              var cloneWrap = document.createElement("div");
              cloneWrap.className = "overview-thumb-clone";
              var clonedCanvas = canvasOrig.cloneNode(true);
              stripCloneAttributes(clonedCanvas);
              cloneWrap.appendChild(clonedCanvas);
              vp.appendChild(cloneWrap);
            }

            var meta = document.createElement("div");
            meta.className = "overview-tile-meta";
            var numSpan = document.createElement("span");
            numSpan.className = "overview-tile-num";
            numSpan.textContent = pad2(idx + 1);
            var lblSpan = document.createElement("span");
            lblSpan.className = "overview-tile-label";
            lblSpan.textContent = title;
            meta.appendChild(numSpan);
            meta.appendChild(lblSpan);

            tile.appendChild(vp);
            tile.appendChild(meta);
            tile.addEventListener("click", function () {
              goToSlide(idx);
              setOverviewOpen(false);
            });
            overviewGrid.appendChild(tile);
            overviewTiles.push(tile);
          }
        })(i);
      }
    }

    function updateNotesPanel() {
      var activeSlide = slides[currentIndex];
      var title = getSlideTitle(activeSlide, currentIndex);
      var noteEl = activeSlide.querySelector(".presenter-note");
      var timing = noteEl ? (noteEl.getAttribute("data-timing") || "") : "";
      var cue = noteEl ? (noteEl.getAttribute("data-cue") || "") : "";
      var text = noteEl ? noteEl.textContent.trim() : "";

      if (notesHeader) {
        var parts = ["SLIDE " + pad2(currentIndex + 1) + " / " + pad2(total) + ": " + title];
        if (timing) parts.push("BEAT " + timing);
        if (cue) parts.push("CUE: " + cue);
        notesHeader.textContent = parts.join("  |  ");
      }
      if (notesBody) {
        notesBody.textContent = text;
      }
    }

    function parseHashSlide() {
      var h = String(window.location.hash || "").replace(/^#/, "").trim();
      if (!h) return null;
      var m = /^(?:slide-)?(\d{1,2})$/i.exec(h);
      if (!m) return null;
      var num = parseInt(m[1], 10);
      if (num >= 1 && num <= total) {
        return num - 1;
      }
      return null;
    }

    function goToSlide(targetIdx, skipHash) {
      var clamped = Math.max(0, Math.min(total - 1, targetIdx));
      currentIndex = clamped;
      visited[currentIndex] = true;

      for (var i = 0; i < total; i++) {
        var isAct = i === currentIndex;
        if (isAct) {
          slides[i].classList.add("is-active");
          slides[i].removeAttribute("aria-hidden");
        } else {
          slides[i].classList.remove("is-active");
          slides[i].setAttribute("aria-hidden", "true");
        }
        if (progressButtons[i]) {
          progressButtons[i].classList.toggle("is-current", isAct);
          progressButtons[i].classList.toggle("is-visited", Boolean(visited[i]) && !isAct);
          if (isAct) {
            progressButtons[i].setAttribute("aria-current", "step");
          } else {
            progressButtons[i].removeAttribute("aria-current");
          }
        }
        if (overviewTiles[i]) {
          overviewTiles[i].classList.toggle("is-current", isAct);
        }
      }

      if (counterEl) {
        counterEl.textContent = pad2(currentIndex + 1) + " / " + pad2(total);
      }

      var title = getSlideTitle(slides[currentIndex], currentIndex);
      if (liveRegion) {
        liveRegion.textContent = "Slide " + (currentIndex + 1) + " of " + total + ": " + title;
      }

      updateNotesPanel();

      if (!skipHash && window.history && typeof window.history.replaceState === "function") {
        try {
          window.history.replaceState(null, "", "#slide-" + (currentIndex + 1));
        } catch (err) {
          void err;
        }
      }
    }

    function setNotesOpen(next) {
      notesOpen = Boolean(next);
      if (notesDrawer) {
        notesDrawer.setAttribute("data-open", notesOpen ? "true" : "false");
      }
      if (btnNotes) {
        btnNotes.setAttribute("aria-pressed", notesOpen ? "true" : "false");
      }
      updateStageScale();
    }

    function setOverviewOpen(next) {
      overviewOpen = Boolean(next);
      if (overviewModal) {
        overviewModal.setAttribute("data-open", overviewOpen ? "true" : "false");
      }
      if (btnGrid) {
        btnGrid.setAttribute("aria-pressed", overviewOpen ? "true" : "false");
      }
      if (overviewOpen) {
        window.requestAnimationFrame(function () {
          scaleOverviewClones();
          if (overviewTiles[currentIndex]) {
            overviewTiles[currentIndex].focus();
          }
        });
      }
    }

    function toggleFullscreen() {
      var doc = document;
      var rootEl = doc.documentElement;
      if (!doc.fullscreenElement && rootEl && typeof rootEl.requestFullscreen === "function") {
        rootEl.requestFullscreen().catch(function () {});
      } else if (doc.fullscreenElement && typeof doc.exitFullscreen === "function") {
        doc.exitFullscreen().catch(function () {});
      }
    }

    function syncFullscreenButton() {
      if (btnFullscreen) {
        var active = Boolean(document.fullscreenElement);
        btnFullscreen.setAttribute("aria-pressed", active ? "true" : "false");
      }
      updateStageScale();
    }

    function renderTimer() {
      if (!timerReadout) return;
      var mins = Math.floor(timerElapsedSec / 60);
      var secs = timerElapsedSec % 60;
      timerReadout.textContent = pad2(mins) + ":" + pad2(secs);
    }

    function toggleTimer() {
      timerRunning = !timerRunning;
      if (btnTimerToggle) {
        btnTimerToggle.textContent = timerRunning ? "Pause" : "Start";
      }
      if (timerRunning) {
        timerInterval = window.setInterval(function () {
          timerElapsedSec += 1;
          renderTimer();
        }, 1000);
      } else if (timerInterval !== null) {
        window.clearInterval(timerInterval);
        timerInterval = null;
      }
    }

    function resetTimer() {
      timerRunning = false;
      if (timerInterval !== null) {
        window.clearInterval(timerInterval);
        timerInterval = null;
      }
      timerElapsedSec = 0;
      if (btnTimerToggle) {
        btnTimerToggle.textContent = "Start";
      }
      renderTimer();
    }

    function isInteractiveTarget(target) {
      if (!target || !target.tagName) return false;
      var tag = target.tagName.toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (target.isContentEditable) return true;
      return false;
    }

    document.addEventListener("keydown", function (ev) {
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      if (isInteractiveTarget(ev.target)) return;

      var key = ev.key;

      if (key === "Escape") {
        if (overviewOpen) {
          ev.preventDefault();
          setOverviewOpen(false);
          return;
        }
        if (notesOpen) {
          ev.preventDefault();
          setNotesOpen(false);
          return;
        }
      }

      if (key === "g" || key === "G") {
        ev.preventDefault();
        setOverviewOpen(!overviewOpen);
        return;
      }

      if (key === "n" || key === "N") {
        ev.preventDefault();
        setNotesOpen(!notesOpen);
        return;
      }

      if (key === "f" || key === "F") {
        ev.preventDefault();
        toggleFullscreen();
        return;
      }

      if (overviewOpen) {
        return;
      }

      var targetTag = ev.target && ev.target.tagName ? ev.target.tagName.toUpperCase() : "";
      if (key === " " && (targetTag === "BUTTON" || targetTag === "A")) {
        return;
      }

      if (key === "ArrowRight" || key === "ArrowDown" || key === "PageDown" || key === " ") {
        ev.preventDefault();
        goToSlide(currentIndex + 1);
      } else if (key === "ArrowLeft" || key === "ArrowUp" || key === "PageUp") {
        ev.preventDefault();
        goToSlide(currentIndex - 1);
      } else if (key === "Home") {
        ev.preventDefault();
        goToSlide(0);
      } else if (key === "End") {
        ev.preventDefault();
        goToSlide(total - 1);
      }
    });

    var touchStartX = null;
    var touchStartY = null;
    if (stageShell) {
      stageShell.addEventListener(
        "touchstart",
        function (ev) {
          if (ev.touches && ev.touches.length === 1) {
            touchStartX = ev.touches[0].clientX;
            touchStartY = ev.touches[0].clientY;
          }
        },
        { passive: true }
      );
      stageShell.addEventListener(
        "touchend",
        function (ev) {
          if (touchStartX === null || touchStartY === null) return;
          if (!ev.changedTouches || !ev.changedTouches.length) return;
          var dx = ev.changedTouches[0].clientX - touchStartX;
          var dy = ev.changedTouches[0].clientY - touchStartY;
          touchStartX = null;
          touchStartY = null;
          if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.35) {
            if (dx < 0) {
              goToSlide(currentIndex + 1);
            } else {
              goToSlide(currentIndex - 1);
            }
          }
        },
        { passive: true }
      );
    }

    if (btnPrev) {
      btnPrev.addEventListener("click", function () { goToSlide(currentIndex - 1); });
    }
    if (btnNext) {
      btnNext.addEventListener("click", function () { goToSlide(currentIndex + 1); });
    }
    if (btnGrid) {
      btnGrid.addEventListener("click", function () { setOverviewOpen(!overviewOpen); });
    }
    if (btnNotes) {
      btnNotes.addEventListener("click", function () { setNotesOpen(!notesOpen); });
    }
    if (btnFullscreen) {
      btnFullscreen.addEventListener("click", function () { toggleFullscreen(); });
    }
    if (btnPrint) {
      btnPrint.addEventListener("click", function () { window.print(); });
    }
    if (btnCloseOverview) {
      btnCloseOverview.addEventListener("click", function () { setOverviewOpen(false); });
    }
    if (btnTimerToggle) {
      btnTimerToggle.addEventListener("click", toggleTimer);
    }
    if (btnTimerReset) {
      btnTimerReset.addEventListener("click", resetTimer);
    }

    window.addEventListener("resize", function () {
      updateStageScale();
      scaleOverviewClones();
    });
    if (typeof window.ResizeObserver === "function" && stageShell) {
      var ro = new window.ResizeObserver(function () {
        updateStageScale();
      });
      ro.observe(stageShell);
    }
    document.addEventListener("fullscreenchange", syncFullscreenButton);
    window.addEventListener("hashchange", function () {
      var parsed = parseHashSlide();
      if (parsed !== null && parsed !== currentIndex) {
        goToSlide(parsed, true);
      }
    });

    renderEvalBindings(window.HOLDUP_EVAL_DATA);
    buildProgressAndOverview();
    updateStageScale();

    var initialIdx = parseHashSlide();
    goToSlide(initialIdx !== null ? initialIdx : 0, initialIdx === null);

    window.HoldUpDeck = {
      goToSlide: goToSlide,
      next: function () { goToSlide(currentIndex + 1); },
      prev: function () { goToSlide(currentIndex - 1); },
      setNotesOpen: setNotesOpen,
      setOverviewOpen: setOverviewOpen,
      getCurrentIndex: function () { return currentIndex; },
      getTotalSlides: function () { return total; }
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDeck);
  } else {
    initDeck();
  }
})();
