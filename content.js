(() => {
  "use strict";

  const PROCESSED = "data-tmd";
  const WRAP_CLASS = "tmd-wrap";
  const BTN_CLASS = "tmd-btn";
  const VISIBLE_CLASS = "tmd-visible";

  // CDN domains used by Threads/Instagram
  const CDN_PATTERN = /cdninstagram\.com|fbcdn\.net/;

  let lastUrl = location.href;
  let scanTimer = null;
  let isNavigating = false;

  // ── DEBUG: visible test marker (confirms script is running) ──
  function showDebug(msg, videos, imgs) {
    let el = document.getElementById("tmd-debug");
    if (!el) {
      el = document.createElement("div");
      el.id = "tmd-debug";
      Object.assign(el.style, {
        position: "fixed", top: "0", left: "0", zIndex: "999999",
        background: "#6C63FF", color: "#fff", padding: "8px 16px",
        fontSize: "13px", fontFamily: "monospace", pointerEvents: "none",
        lineHeight: "1.6"
      });
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = `[TMD] ${msg} | videos:${videos} imgs:${imgs}`;
  }

  function init() {
    const videos = document.querySelectorAll("video").length;
    const imgs = document.querySelectorAll("img").length;
    showDebug("init", videos, imgs);
    injectStyles();
    extractVideoUrlsFromScripts();
    scheduleScan();

    // MutationObserver: DOM structure changes (covers React/Virtual DOM re-renders)
    const obs = new MutationObserver(() => {
      if (location.href !== lastUrl) onNavigate();
      scheduleScan();
    });
    obs.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });

    // History API: SPA navigation
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
  }

  function onNavigate() {
    if (isNavigating) return;
    isNavigating = true;
    lastUrl = location.href;

    // Cancel any pending scan so cleanup + fresh scan run cleanly
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }

    cleanup();

    // Wait for React to finish rendering before extracting/scanning
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        extractVideoUrlsFromScripts();
        scheduleScan();
        isNavigating = false;
      });
    });
  }

  // ── SSR JSON parsing (video_versions / image_versions2) ──
  // Extracts URLs + thumbnail + viewport position → sent to popup for ordered display
  function extractVideoUrlsFromScripts() {
    const media = []; // { url, type, thumb, y }
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      try {
        findMediaUrls(JSON.parse(script.textContent), media, 0);
      } catch { /* skip */ }
    }
    if (media.length) {
      // Sort by viewport position (top to bottom)
      media.sort((a, b) => a.y - b.y);
      const urls = media.map((m) => m.url);
      const thumbnails = {};
      media.forEach((m) => { if (m.thumb) thumbnails[m.url] = m.thumb; });
      try {
        chrome.runtime.sendMessage({ type: "EXTRACT_FROM_SCRIPTS", urls, thumbnails });
      } catch (_) {}
    }
  }

  function findMediaUrls(obj, out, depth) {
    if (depth > 20 || !obj || typeof obj !== "object") return;
    // video
    if (Array.isArray(obj.video_versions)) {
      for (const v of obj.video_versions) {
        if (v.url) out.push({ url: v.url, type: "video", thumb: v.thumbnail_url || null, y: out.length });
      }
      return;
    }
    if (typeof obj.video_url === "string") {
      out.push({ url: obj.video_url, type: "video", thumb: null, y: out.length });
    }
    // image — collect all candidates, use highest quality
    if (obj.image_versions2?.candidates) {
      const cands = obj.image_versions2.candidates;
      if (cands.length) {
        const best = cands[cands.length - 1] || cands[0];
        if (best.url) {
          out.push({ url: best.url, type: "image", thumb: best.url, y: out.length });
        }
      }
      return;
    }
    // Carousel: nested media array
    if (obj.carousel_media) {
      for (const m of obj.carousel_media) findMediaUrls(m, out, depth + 1);
      return;
    }
    for (const val of (Array.isArray(obj) ? obj : Object.values(obj))) {
      findMediaUrls(val, out, depth + 1);
    }
  }

  // ── DOM scan: attach buttons on images & videos ──
  function scheduleScan() {
    if (scanTimer) {
      // Reschedule: new content may have arrived, push the timer out
      clearTimeout(scanTimer);
    }
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 800);
  }

  function scan() {
    const videos = document.querySelectorAll("video");
    const imgs = document.querySelectorAll("img");
    console.log("[TMD] scan: videos=", videos.length, "imgs=", imgs.length);

    // Videos
    for (const video of videos) {
      if (video.hasAttribute(PROCESSED)) continue;
      video.setAttribute(PROCESSED, "video");
      const container = findContainer(video, true);
      if (container) attachOverlay(container, video, "video");
    }

    // Images – only large CDN images (skip avatars, icons)
    for (const img of document.querySelectorAll("img")) {
      if (img.hasAttribute(PROCESSED)) continue;
      const src = img.src || img.currentSrc || "";
      if (!src || !CDN_PATTERN.test(src)) continue;
      // Skip small images (profile pics, icons)
      const rect = img.getBoundingClientRect();
      if (rect.width < 150 || rect.height < 150) continue;
      // Skip profile pictures path
      if (src.includes("/t51.2885-19/")) continue;

      img.setAttribute(PROCESSED, "image");
      const container = findContainer(img, false);
      if (container) attachOverlay(container, img, "image");
    }
  }

  function findContainer(el, isVideo) {
    // For videos: always use the video element itself as container
    // (CSS will position the button at top-right OUTSIDE the video content area)
    if (isVideo) return el;
    // For images: standard traversal
    let node = el.parentElement;
    for (let i = 0; i < 8 && node; i++) {
      const r = node.getBoundingClientRect();
      if (r.width >= 150 && r.height >= 150) return node;
      node = node.parentElement;
    }
    return el.parentElement;
  }

  // ── Overlay button with JS-based hover ──
  function attachOverlay(container, mediaEl, mediaType) {
    const isVideo = mediaType === "video";

    // For videos: make the video element positionable (it IS the container)
    if (isVideo) {
      if (getComputedStyle(mediaEl).position === "static") {
        mediaEl.style.position = "relative";
      }
    } else {
      if (getComputedStyle(container).position === "static") {
        container.style.position = "relative";
      }
    }

    const wrap = document.createElement("div");
    wrap.className = WRAP_CLASS + (isVideo ? " tmd-video" : "");

    const label = isVideo ? "Video" : "Photo";
    const icon = isVideo ? ICON_VIDEO_DL : ICON_IMG_DL;

    const btn = document.createElement("button");
    btn.type = "button";
    // Apply inline styles directly — no CSS class dependency
    const posStyle = isVideo
      ? "position:absolute;right:10px;top:10px;z-index:2147483647;opacity:1"
      : "position:absolute;right:10px;bottom:10px;z-index:2147483647;opacity:0.5";
    wrap.setAttribute("style", posStyle);

    btn.setAttribute("style", [
      "display:inline-flex",
      "align-items:center",
      "gap:6px",
      "padding:8px 14px",
      "border:none",
      "border-radius:20px",
      "background:rgba(0,0,0,0.78)",
      "color:#fff",
      "font-size:13px",
      "font-weight:600",
      "font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif",
      "cursor:pointer",
      "backdrop-filter:blur(10px)",
      "box-shadow:0 2px 16px rgba(0,0,0,0.35)",
      "white-space:nowrap",
      "user-select:none",
      "pointer-events:auto"
    ].join(";"));

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (isVideo) {
        downloadVideo(mediaEl, btn);
      } else {
        downloadImage(mediaEl, btn);
      }
    });

    // Hover effect: adjust opacity
    mediaEl.addEventListener("mouseenter", () => {
      if (!isVideo) wrap.setAttribute("style", posStyle + ";opacity:1");
    });
    mediaEl.addEventListener("mouseleave", () => {
      if (!isVideo) wrap.setAttribute("style", posStyle);
    });

    wrap.appendChild(btn);
    container.appendChild(wrap);

    // Also watch for src changes on video — capture poster thumbnail too
    if (isVideo) {
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

  // ── Download: Image ──
  async function downloadImage(img, btn) {
    const prev = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `${ICON_SPINNER}<span>Saving...</span>`;

    // Get highest resolution: try srcset first, then src
    let url = getBestImageUrl(img);
    if (!url) {
      showStatus(btn, prev, "No image found", 2000);
      return;
    }

    const filename = buildFilename("jpg");
    const resp = await sendMsg({ type: "DOWNLOAD_MEDIA", url, filename });
    if (resp?.ok) {
      showStatus(btn, prev, `${ICON_CHECK}<span>Saved!</span>`, 2500);
    } else {
      showStatus(btn, prev, "<span>Failed</span>", 2000);
    }
  }

  function getBestImageUrl(img) {
    // Check srcset for highest resolution
    const srcset = img.getAttribute("srcset");
    if (srcset) {
      const candidates = srcset.split(",").map((s) => {
        const parts = s.trim().split(/\s+/);
        const w = parseInt(parts[1]) || 0;
        return { url: parts[0], w };
      });
      candidates.sort((a, b) => b.w - a.w);
      if (candidates[0]?.url) return candidates[0].url;
    }
    return img.src || img.currentSrc || "";
  }

  // ── Download: Video (multi-strategy) ──
  async function downloadVideo(video, btn) {
    const prev = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `${ICON_SPINNER}<span>Saving...</span>`;

    try {
      let url = "";

      // Strategy 1 (primary): video element's src — specific to THIS video
      url = getNonBlobSrc(video);

      // Strategy 2: look in parent article/post data for direct URL
      if (!url) {
        url = findVideoUrlInPost(video);
      }

      // Strategy 3: from SSR JSON scripts near this video
      if (!url) {
        url = findVideoUrlFromScriptsNear(video);
      }

      // Strategy 4: network-captured CDN URLs — fall back only if no direct URL found
      if (!url) {
        const captured = await sendMsg({ type: "GET_CAPTURED_URLS" });
        const capturedUrls = captured?.urls || [];
        if (capturedUrls.length) {
          url = capturedUrls[capturedUrls.length - 1];
        }
      }

      // Strategy 5: embed endpoint fallback
      if (!url) {
        const postUrl = location.href.split("?")[0];
        const embed = await sendMsg({ type: "FETCH_EMBED_VIDEOS", postUrl });
        const embedUrls = embed?.videoUrls || [];
        if (embedUrls.length) url = embedUrls[0];
      }

      if (!url) {
        showStatus(btn, prev, "No video found", 2500);
        return;
      }

      const filename = buildFilename("mp4");
      const resp = await sendMsg({ type: "DOWNLOAD_MEDIA", url, filename });
      if (resp?.ok) {
        showStatus(btn, prev, `${ICON_CHECK}<span>Saved!</span>`, 2500);
      } else {
        showStatus(btn, prev, "<span>Failed</span>", 2500);
      }
    } catch (err) {
      console.error("[TMD]", err);
      showStatus(btn, prev, "<span>Error</span>", 2000);
    }
  }

  // ── Find video URL from parent article/post element ──
  function findVideoUrlInPost(video) {
    // Walk up from the video to find a post/article container
    let node = video;
    for (let i = 0; i < 10 && node; i++) {
      const url = node.dataset?.videoUrl || node.dataset?.video_url;
      if (url && !url.startsWith("blob:") && (url.includes(".mp4") || url.includes("/v/"))) {
        return url;
      }
      node = node.parentElement;
    }
    // Try: find adjacent JSON script in parent tree
    return "";
  }

  // ── Find video URL from SSR JSON near the video element ──
  function findVideoUrlFromScriptsNear(video) {
    // Find the post/article container
    let postNode = video;
    for (let i = 0; i < 10 && postNode; i++) {
      if (postNode.tagName === "ARTICLE" || postNode.tagName === "SECTION" ||
          (postNode.id && /post|thread|item|entry/i.test(postNode.id))) {
        break;
      }
      postNode = postNode.parentElement;
    }
    if (!postNode) return "";

    // Look for JSON scripts inside or near this post
    const scripts = postNode.querySelectorAll ? postNode.querySelectorAll('script[type="application/json"]') : [];
    for (const script of scripts) {
      try {
        const urls = [];
        findMediaUrls(JSON.parse(script.textContent), urls, 0);
        // Return first video URL found in this post's scripts
        for (const item of urls) {
          if (item.type === "video" && item.url) return item.url;
        }
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

  // ── Helpers ──
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
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          resolve(chrome.runtime.lastError ? null : r);
        });
      } catch (e) {
        // Service worker may be unavailable or restarting
        resolve(null);
      }
    });
  }

  function cleanup() {
    // Remove all overlay wrappers
    document.querySelectorAll(`.${WRAP_CLASS}`).forEach((el) => el.remove());
    // Remove processed markers so elements are re-scanned on new page
    document.querySelectorAll(`[${PROCESSED}]`).forEach((el) => el.removeAttribute(PROCESSED));
    // Reset per-page timer state
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
  }

  // ── Inline SVG icons ──
  const ICON_VIDEO_DL = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
  const ICON_IMG_DL = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`;
  const ICON_CHECK = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const ICON_SPINNER = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="tmd-spin"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/></svg>`;

  // Inject styles helper (defined before init but called from init)
  function injectStyles() {
    if (document.getElementById("tmd-styles")) return;
    const css = `
      .tmd-wrap { pointer-events: none !important; }
      .tmd-wrap .tmd-btn { pointer-events: auto !important; }
      @keyframes tmd-spin { to { transform: rotate(360deg); } }
    `;
    const el = document.createElement("style");
    el.id = "tmd-styles";
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  }

  init();
})();
