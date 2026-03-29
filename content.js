(() => {
  "use strict";

  const PROCESSED = "data-tmd";
  const WRAP_CLASS = "tmd-wrap";
  const BTN_CLASS = "tmd-btn";
  const VISIBLE_CLASS = "tmd-visible";

  const CDN_PATTERN = /cdninstagram\.com|fbcdn\.net/;

  let lastUrl = location.href;
  let scanTimer = null;
  let isNavigating = false;

  init();

  function init() {
    extractVideoUrlsFromScripts();
    scheduleScan();

    const obs = new MutationObserver(() => {
      if (location.href !== lastUrl) onNavigate();
      scheduleScan();
    });
    obs.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });

    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;
    history.pushState = function (...args) {
      const result = origPushState.apply(this, args);
      if (location.href !== lastUrl) onNavigate();
      return result;
    };
    history.replaceState = function (...args) {
      const result = origReplaceState.apply(this, args);
      if (location.href !== lastUrl) onNavigate();
      return result;
    };

    window.addEventListener("popstate", () => {
      if (location.href !== lastUrl) onNavigate();
    });

    // Real browser fullscreen
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);

    // Periodic re-check: catches Threads /media view, overlay modals, 
    // and any dynamically injected videos that MutationObserver misses
    setInterval(() => {
      // Check URL change (Threads SPA sometimes doesn't trigger popstate)
      if (location.href !== lastUrl) {
        onNavigate();
        return;
      }
      // Find any unprocessed videos and large images
      detectNewMedia();
    }, 1200);
  }

  // Detect any unprocessed media — covers /media view, overlays, lazy-loaded content
  function detectNewMedia() {
    // Any unprocessed video on the page
    for (const video of document.querySelectorAll("video")) {
      if (video.hasAttribute(PROCESSED)) continue;
      video.setAttribute(PROCESSED, "video");
      const container = findMediaContainer(video);
      if (container) {
        container.setAttribute("data-tmd-has-video", "1");
        attachOverlay(container, video, "video");
      }
    }

    // Any unprocessed large CDN image
    for (const img of document.querySelectorAll("img")) {
      if (img.hasAttribute(PROCESSED)) continue;
      const src = img.src || img.currentSrc || "";
      if (!src || !CDN_PATTERN.test(src)) continue;
      const rect = img.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 80) continue;
      if (src.includes("/t51.2885-19/")) continue;

      img.setAttribute(PROCESSED, "image");
      const isVideo = hasVideoNearby(img);
      const container = findMediaContainer(img);
      if (container?.getAttribute("data-tmd-has-video") === "1") continue;
      if (container) attachOverlay(container, img, isVideo ? "video" : "image");
    }
  }

  function onFullscreenChange() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      fsEl.querySelectorAll(`.${WRAP_CLASS}`).forEach((el) => el.remove());
      fsEl.querySelectorAll(`[${PROCESSED}]`).forEach((el) => el.removeAttribute(PROCESSED));
      setTimeout(() => scanInside(fsEl), 400);
      setTimeout(() => scanInside(fsEl), 1000);
      setTimeout(() => scanInside(fsEl), 2000);
    } else {
      scheduleScan();
    }
  }

  function scanInside(root) {
    for (const video of root.querySelectorAll("video")) {
      if (video.hasAttribute(PROCESSED)) continue;
      video.setAttribute(PROCESSED, "video");
      const container = findContainerInFullscreen(video, root);
      if (container) attachOverlay(container, video, "video");
    }
    for (const img of root.querySelectorAll("img")) {
      if (img.hasAttribute(PROCESSED)) continue;
      const src = img.src || img.currentSrc || "";
      if (!src || !CDN_PATTERN.test(src)) continue;
      if (src.includes("/t51.2885-19/")) continue;
      const rect = img.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 80) continue;
      img.setAttribute(PROCESSED, "image");
      const isVideo = hasVideoNearby(img);
      const container = findContainerInFullscreen(img, root);
      if (container) attachOverlay(container, img, isVideo ? "video" : "image");
    }
  }

  function findContainerInFullscreen(el, fsRoot) {
    let node = el.parentElement;
    for (let i = 0; i < 8 && node && node !== fsRoot; i++) {
      const r = node.getBoundingClientRect();
      if (r.width >= 80 && r.height >= 80) return node;
      node = node.parentElement;
    }
    if (getComputedStyle(fsRoot).position === "static") {
      fsRoot.style.position = "relative";
    }
    return fsRoot;
  }

  function onNavigate() {
    if (isNavigating) return;
    isNavigating = true;
    lastUrl = location.href;
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    cleanup();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        extractVideoUrlsFromScripts();
        scheduleScan();
        isNavigating = false;
      });
    });
  }

  // ── SSR JSON parsing ──
  function extractVideoUrlsFromScripts() {
    const media = [];
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      try { findMediaUrls(JSON.parse(script.textContent), media, 0); } catch {}
    }
    if (media.length) {
      media.sort((a, b) => a.y - b.y);
      const urls = media.map((m) => m.url);
      const thumbnails = {};
      media.forEach((m) => { if (m.thumb) thumbnails[m.url] = m.thumb; });
      try { chrome.runtime.sendMessage({ type: "EXTRACT_FROM_SCRIPTS", urls, thumbnails }); } catch (_) {}
    }
  }

  function findMediaUrls(obj, out, depth) {
    if (depth > 20 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj.video_versions)) {
      for (const v of obj.video_versions) {
        if (v.url) out.push({ url: v.url, type: "video", thumb: v.thumbnail_url || null, y: out.length });
      }
      return;
    }
    if (typeof obj.video_url === "string") {
      out.push({ url: obj.video_url, type: "video", thumb: null, y: out.length });
    }
    if (obj.image_versions2?.candidates) {
      const cands = obj.image_versions2.candidates;
      if (cands.length) {
        const sorted = [...cands].sort((a, b) => (b.width || 0) - (a.width || 0));
        const best = sorted[0] || cands[0];
        if (best.url) out.push({ url: best.url, type: "image", thumb: best.url, y: out.length });
      }
      return;
    }
    if (obj.carousel_media) {
      for (const m of obj.carousel_media) findMediaUrls(m, out, depth + 1);
      return;
    }
    for (const val of (Array.isArray(obj) ? obj : Object.values(obj))) {
      findMediaUrls(val, out, depth + 1);
    }
  }

  // ── DOM scan ──
  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 600);
  }

  function scan() {
    if (document.fullscreenElement || document.webkitFullscreenElement) return;

    // Videos first
    for (const video of document.querySelectorAll("video")) {
      if (video.hasAttribute(PROCESSED)) continue;
      video.setAttribute(PROCESSED, "video");
      const container = findMediaContainer(video);
      if (container) {
        container.setAttribute("data-tmd-has-video", "1");
        attachOverlay(container, video, "video");
      }
    }

    // Images
    for (const img of document.querySelectorAll("img")) {
      if (img.hasAttribute(PROCESSED)) continue;
      const src = img.src || img.currentSrc || "";
      if (!src || !CDN_PATTERN.test(src)) continue;
      const rect = img.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 80) continue;
      if (src.includes("/t51.2885-19/")) continue;

      img.setAttribute(PROCESSED, "image");
      const isVideo = hasVideoNearby(img);
      const container = findMediaContainer(img);
      if (container?.getAttribute("data-tmd-has-video") === "1") continue;
      if (container) attachOverlay(container, img, isVideo ? "video" : "image");
    }
  }

  // Check if this specific image is a video poster (not just near a video in carousel)
  function hasVideoNearby(img) {
    // Only check 2 levels up — enough for video poster wrapper, but not carousel-wide
    let node = img;
    for (let i = 0; i < 2 && node; i++) {
      node = node.parentElement;
      if (!node) break;

      // Direct sibling or child <video> means this img IS the poster
      const video = node.querySelector(":scope > video, :scope > div > video");
      if (video) return true;

      // Audio/mute button as DIRECT child of this container = video controls
      for (const btn of node.querySelectorAll(":scope > button, :scope > div > button, :scope > [role='button']")) {
        const label = (btn.getAttribute("aria-label") || "").toLowerCase();
        if (label.includes("mute") || label.includes("unmute") ||
            label.includes("sound") || label.includes("audio") ||
            label.includes("음소거") || label.includes("소리") ||
            label.includes("오디오")) {
          return true;
        }
      }
    }
    return false;
  }

  function findMediaContainer(el) {
    let node = el.parentElement;
    let bestContainer = null;
    for (let i = 0; i < 8 && node; i++) {
      const r = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (r.width >= 80 && r.height >= 80) {
        // Pick the first good container, but prefer ones with overflow:hidden
        // (typical media wrapper) or position:relative
        if (!bestContainer) bestContainer = node;
        // If this is a positioned container, prefer it
        if (style.position !== "static" || style.overflow === "hidden") {
          return node;
        }
      }
      node = node.parentElement;
    }
    return bestContainer || el.parentElement;
  }

  // ── Overlay button ──
  function attachOverlay(container, mediaEl, mediaType) {
    const isVideo = mediaType === "video";

    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }

    const wrap = document.createElement("div");
    wrap.className = WRAP_CLASS;

    const label = isVideo ? "Video" : "Photo";
    const icon = isVideo ? ICON_VIDEO_DL : ICON_IMG_DL;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = BTN_CLASS;
    btn.innerHTML = `${icon}<span>${label}</span>`;

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (isVideo) {
        const actualVideo = mediaEl.tagName === "VIDEO" ? mediaEl : findNearestVideo(mediaEl);
        downloadVideo(actualVideo || mediaEl, btn);
      } else {
        downloadImage(mediaEl, btn);
      }
    });

    wrap.appendChild(btn);
    container.appendChild(wrap);

    const show = () => wrap.classList.add(VISIBLE_CLASS);
    const hide = () => {
      setTimeout(() => {
        if (!wrap.matches(":hover") && !container.matches(":hover")) {
          wrap.classList.remove(VISIBLE_CLASS);
        }
      }, 300);
    };

    container.addEventListener("mouseenter", show);
    container.addEventListener("mouseleave", hide);
    mediaEl.addEventListener("mouseenter", show);
    mediaEl.addEventListener("mouseleave", hide);
    wrap.addEventListener("mouseenter", show);
    wrap.addEventListener("mouseleave", hide);

    if (mediaEl.tagName === "VIDEO") {
      const srcObs = new MutationObserver(() => {
        const s = mediaEl.currentSrc || mediaEl.src || "";
        const poster = mediaEl.poster || "";
        if (s && !s.startsWith("blob:")) {
          const msg = { type: "EXTRACT_FROM_SCRIPTS", urls: [s] };
          if (poster) msg.thumbnails = { [s]: poster };
          try { chrome.runtime.sendMessage(msg); } catch (_) {}
        }
      });
      srcObs.observe(mediaEl, { attributes: true, attributeFilter: ["src"] });
    }
  }

  function findNearestVideo(img) {
    let node = img;
    for (let i = 0; i < 6 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const v = node.querySelector("video");
      if (v) return v;
    }
    return null;
  }

  // ── Download: Image ──
  async function downloadImage(img, btn) {
    const prev = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `${ICON_SPINNER}<span>Saving...</span>`;
    let url = getBestImageUrl(img);
    if (!url) { showStatus(btn, prev, "No image found", 2000); return; }
    const filename = buildFilename("jpg");
    const resp = await sendMsg({ type: "DOWNLOAD_MEDIA", url, filename });
    showStatus(btn, prev, resp?.ok ? `${ICON_CHECK}<span>Saved!</span>` : "<span>Failed</span>", 2500);
  }

  function getBestImageUrl(img) {
    const srcset = img.getAttribute("srcset");
    if (srcset) {
      const candidates = srcset.split(",").map((s) => {
        const parts = s.trim().split(/\s+/);
        return { url: parts[0], w: parseInt(parts[1]) || 0 };
      });
      candidates.sort((a, b) => b.w - a.w);
      if (candidates[0]?.url) return candidates[0].url;
    }
    return img.src || img.currentSrc || "";
  }

  // ── Download: Video ──
  async function downloadVideo(video, btn) {
    const prev = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `${ICON_SPINNER}<span>Saving...</span>`;
    try {
      let url = "";
      if (video.tagName === "VIDEO") url = getNonBlobSrc(video);
      if (!url) url = findVideoUrlInPost(video);
      if (!url) url = findVideoUrlFromScriptsNear(video);
      if (!url) {
        const captured = await sendMsg({ type: "GET_CAPTURED_URLS" });
        const capturedUrls = captured?.urls || [];
        if (capturedUrls.length) url = capturedUrls[capturedUrls.length - 1];
      }
      if (!url) {
        const postUrl = location.href.split("?")[0];
        const embed = await sendMsg({ type: "FETCH_EMBED_VIDEOS", postUrl });
        const embedUrls = embed?.videoUrls || [];
        if (embedUrls.length) url = embedUrls[0];
      }
      if (!url) { showStatus(btn, prev, "No video found", 2500); return; }
      const filename = buildFilename("mp4");
      const resp = await sendMsg({ type: "DOWNLOAD_MEDIA", url, filename });
      showStatus(btn, prev, resp?.ok ? `${ICON_CHECK}<span>Saved!</span>` : "<span>Failed</span>", 2500);
    } catch (err) {
      console.error("[TMD]", err);
      showStatus(btn, prev, "<span>Error</span>", 2000);
    }
  }

  function findVideoUrlInPost(el) {
    let node = el;
    for (let i = 0; i < 10 && node; i++) {
      const url = node.dataset?.videoUrl || node.dataset?.video_url;
      if (url && !url.startsWith("blob:") && (url.includes(".mp4") || url.includes("/v/"))) return url;
      node = node.parentElement;
    }
    return "";
  }

  function findVideoUrlFromScriptsNear(el) {
    let postNode = el;
    for (let i = 0; i < 10 && postNode; i++) {
      if (postNode.tagName === "ARTICLE" || postNode.tagName === "SECTION" ||
          (postNode.id && /post|thread|item|entry/i.test(postNode.id))) break;
      postNode = postNode.parentElement;
    }
    if (!postNode) return "";
    const scripts = postNode.querySelectorAll('script[type="application/json"]');
    for (const script of scripts) {
      try {
        const urls = [];
        findMediaUrls(JSON.parse(script.textContent), urls, 0);
        for (const item of urls) { if (item.type === "video" && item.url) return item.url; }
      } catch {}
    }
    return "";
  }

  function getNonBlobSrc(video) {
    const src = video.currentSrc || video.src || "";
    if (src && !src.startsWith("blob:")) return src;
    const source = video.querySelector("source");
    if (source) {
      const s = source.src || source.getAttribute("src") || "";
      if (s && !s.startsWith("blob:")) return s;
    }
    return "";
  }

  function buildFilename(ext) {
    const parts = location.pathname.split("/").filter(Boolean);
    const postIdx = parts.indexOf("post");
    const postId = (postIdx !== -1 && parts[postIdx + 1]) ? parts[postIdx + 1] : "threads";
    return `threads/${postId}_${Date.now()}.${ext}`;
  }

  function showStatus(btn, restoreHtml, html, delay) {
    btn.innerHTML = html;
    setTimeout(() => { btn.innerHTML = restoreHtml; btn.disabled = false; }, delay);
  }

  function sendMsg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (r) => {
        resolve(chrome.runtime.lastError ? null : r);
      });
    });
  }

  function cleanup() {
    document.querySelectorAll(`.${WRAP_CLASS}`).forEach((el) => el.remove());
    document.querySelectorAll(`[${PROCESSED}]`).forEach((el) => el.removeAttribute(PROCESSED));
    document.querySelectorAll("[data-tmd-has-video]").forEach((el) => el.removeAttribute("data-tmd-has-video"));
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
  }

  const ICON_VIDEO_DL = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
  const ICON_IMG_DL = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`;
  const ICON_CHECK = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const ICON_SPINNER = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="tmd-spin"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/></svg>`;
})();
