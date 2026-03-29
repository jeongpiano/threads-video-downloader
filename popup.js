document.addEventListener("DOMContentLoaded", async () => {
  const content = document.getElementById("content");
  const status = document.getElementById("status");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes("threads.com")) {
    status.textContent = "Threads 페이지에서 사용해주세요.";
    return;
  }

  // ── Collect media from CURRENT PAGE ──
  const videoSet = new Set();
  const imageSet = new Set();
  const allThumbnails = {};
  const viewportPositions = {}; // url -> { y, inViewport }

  // Scan current page DOM with viewport info
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scanPageWithViewport
    });
    if (result?.result) {
      result.result.videos.forEach((item) => {
        videoSet.add(item.url);
        viewportPositions[item.url] = { y: item.y, inViewport: item.inViewport };
      });
      result.result.images.forEach((item) => {
        imageSet.add(item.url);
        viewportPositions[item.url] = { y: item.y, inViewport: item.inViewport };
      });
      Object.assign(allThumbnails, result.result.thumbnails || {});
    }
  } catch (e) {
    status.textContent = "페이지 스캔 실패. 새로고침 후 다시 시도해주세요.";
    return;
  }

  // Supplement: network-captured URLs + thumbnails
  try {
    const r = await chrome.runtime.sendMessage({ type: "GET_CAPTURED_URLS", tabId: tab.id });
    (r?.urls || []).forEach((u) => {
      if (u.includes(".mp4") || u.includes("/v/t16/")) videoSet.add(u);
    });
    (r?.imageUrls || []).forEach((u) => {
      if (!u.includes("/t51.2885-19/")) imageSet.add(u);
    });
    if (r?.thumbnails) Object.assign(allThumbnails, r.thumbnails);
  } catch {}

  // Final fallback: embed endpoint
  if (videoSet.size === 0) {
    try {
      const postUrl = tab.url.split("?")[0];
      const r = await chrome.runtime.sendMessage({ type: "FETCH_EMBED_VIDEOS", postUrl });
      (r?.videoUrls || []).forEach((u) => videoSet.add(u));
    } catch {}
  }

  const videos = [...videoSet];
  const images = [...imageSet];
  const total = videos.length + images.length;

  if (total === 0) {
    content.innerHTML = `
      <div class="status">미디어를 찾지 못했습니다.</div>
      <button class="scan-btn" id="rescan">다시 검색</button>`;
    document.getElementById("rescan")?.addEventListener("click", () => location.reload());
    return;
  }

  const postId = extractPostId(tab.url);

  // Build combined media list with viewport sorting
  const allMedia = [
    ...videos.map((u) => ({ url: u, ext: "mp4", type: "video", thumb: allThumbnails[u] || null })),
    ...images.map((u) => ({ url: u, ext: "jpg", type: "image", thumb: allThumbnails[u] || u }))
  ];

  // Sort: in-viewport first (by y), then off-screen (by y)
  allMedia.sort((a, b) => {
    const posA = viewportPositions[a.url] || { y: 99999, inViewport: false };
    const posB = viewportPositions[b.url] || { y: 99999, inViewport: false };
    if (posA.inViewport && !posB.inViewport) return -1;
    if (!posA.inViewport && posB.inViewport) return 1;
    return posA.y - posB.y;
  });

  // Count viewport items
  const viewportCount = allMedia.filter((m) => viewportPositions[m.url]?.inViewport).length;

  let html = "";

  // Viewport section
  if (viewportCount > 0) {
    html += `<div class="section-title">📍 현재 화면 (${viewportCount})</div>`;
    html += `<ul class="media-list">`;
    allMedia.slice(0, viewportCount).forEach((m, i) => {
      html += mediaItem(m.url, i, m.type === "video" ? "video" : "photo",
        `${m.type === "video" ? "Video" : "Photo"} ${i + 1}`, m.thumb);
    });
    html += `</ul>`;
  }

  // Rest section
  if (allMedia.length > viewportCount) {
    const restLabel = viewportCount > 0 ? "기타 미디어" : "미디어";
    html += `<div class="section-title">${restLabel} (${allMedia.length - viewportCount})</div>`;
    html += `<ul class="media-list">`;
    allMedia.slice(viewportCount).forEach((m, i) => {
      const idx = viewportCount + i;
      html += mediaItem(m.url, idx, m.type === "video" ? "video" : "photo",
        `${m.type === "video" ? "Video" : "Photo"} ${idx + 1}`, m.thumb);
    });
    html += `</ul>`;
  }

  // Download all
  html += `
    <div class="dl-all-wrap">
      <button class="dl-all" id="dl-all">모두 다운로드 (${total})</button>
    </div>`;

  content.innerHTML = html;

  // Individual buttons
  content.querySelectorAll(".dl-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const m = allMedia[idx];
      btn.disabled = true;
      btn.textContent = "...";
      const filename = `threads/${postId}_${idx + 1}.${m.ext}`;
      const r = await chrome.runtime.sendMessage({ type: "DOWNLOAD_MEDIA", url: m.url, filename });
      btn.textContent = r?.ok ? "Done!" : "Failed";
      if (r?.ok) btn.className = "dl-btn done";
      else btn.disabled = false;
    });
  });

  // Download all
  document.getElementById("dl-all")?.addEventListener("click", async (e) => {
    const b = e.target;
    b.disabled = true;
    b.textContent = "다운로드 중...";
    for (let i = 0; i < allMedia.length; i++) {
      const m = allMedia[i];
      const filename = `threads/${postId}_${i + 1}.${m.ext}`;
      await chrome.runtime.sendMessage({ type: "DOWNLOAD_MEDIA", url: m.url, filename });
      await new Promise((r) => setTimeout(r, 200));
    }
    b.textContent = "완료!";
    b.style.background = "#27ae60";
    content.querySelectorAll(".dl-btn").forEach((btn) => {
      btn.textContent = "Done!";
      btn.className = "dl-btn done";
    });
  });
});

// ── Runs in content script context: scan with viewport position info ──
function scanPageWithViewport() {
  const vH = window.innerHeight;
  const videos = [];
  const images = [];
  const thumbnails = {};

  // SSR JSON
  for (const s of document.querySelectorAll('script[type="application/json"]')) {
    try { dig(JSON.parse(s.textContent), 0); } catch {}
  }

  // DOM video elements
  for (const v of document.querySelectorAll("video")) {
    const src = v.currentSrc || v.src || "";
    if (src && !src.startsWith("blob:")) {
      const rect = v.getBoundingClientRect();
      const inViewport = rect.top < vH && rect.bottom > 0;
      videos.push({ url: src, y: rect.top + window.scrollY, inViewport });
      if (v.poster) thumbnails[src] = v.poster;
    }
    const source = v.querySelector("source");
    if (source?.src && !source.src.startsWith("blob:")) {
      const rect = v.getBoundingClientRect();
      const inViewport = rect.top < vH && rect.bottom > 0;
      videos.push({ url: source.src, y: rect.top + window.scrollY, inViewport });
      if (v.poster) thumbnails[source.src] = v.poster;
    }

    // Fallback thumbnail from sibling img
    const thumbSrc = src || source?.src || "";
    if (thumbSrc && !thumbnails[thumbSrc]) {
      const thumbImg = v.closest("[data-image], [data-thumb]")?.querySelector("img")
        || v.parentElement?.querySelector("img[src*='cdninstagram'], img[src*='fbcdn']")
        || v.parentElement?.parentElement?.querySelector("img[src*='cdninstagram'], img[src*='fbcdn']");
      if (thumbImg) {
        const tSrc = thumbImg.src || thumbImg.getAttribute("srcset")?.split(",")?.[0]?.split(" ")?.[0] || "";
        if (tSrc) thumbnails[thumbSrc] = tSrc;
      }
    }
  }

  // DOM img elements (CDN only, large)
  for (const img of document.querySelectorAll("img")) {
    const src = img.src || "";
    if (!src.includes("cdninstagram.com") && !src.includes("fbcdn.net")) continue;
    if (src.includes("/t51.2885-19/")) continue;
    const rect = img.getBoundingClientRect();
    if (rect.width >= 100 && rect.height >= 100) {
      const inViewport = rect.top < vH && rect.bottom > 0;
      images.push({ url: src, y: rect.top + window.scrollY, inViewport });
      thumbnails[src] = src;
    }
  }

  // Deduplicate
  const seenV = new Set();
  const seenI = new Set();
  return {
    videos: videos.filter((v) => { if (seenV.has(v.url)) return false; seenV.add(v.url); return true; }),
    images: images.filter((v) => { if (seenI.has(v.url)) return false; seenI.add(v.url); return true; }),
    thumbnails
  };

  function dig(obj, d) {
    if (d > 20 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj.video_versions)) {
      for (const v of obj.video_versions) if (v.url) {
        videos.push({ url: v.url, y: 0, inViewport: false });
        if (v.thumbnail_url) thumbnails[v.url] = v.thumbnail_url;
      }
      return;
    }
    if (typeof obj.video_url === "string") videos.push({ url: obj.video_url, y: 0, inViewport: false });
    if (obj.image_versions2?.candidates) {
      const cands = obj.image_versions2.candidates;
      const sorted = [...cands].sort((a, b) => (b.width || 0) - (a.width || 0));
      const best = sorted[0] || cands[0];
      if (best?.url) {
        images.push({ url: best.url, y: 0, inViewport: false });
        thumbnails[best.url] = best.url;
      }
      return;
    }
    if (obj.carousel_media) {
      for (const m of obj.carousel_media) dig(m, d + 1);
      return;
    }
    for (const v of (Array.isArray(obj) ? obj : Object.values(obj))) dig(v, d + 1);
  }
}

function mediaItem(url, idx, type, label, thumbUrl) {
  const short = shortUrl(url);
  const typeClass = type === "video" ? "type-video" : "type-photo";
  const typeLabel = type === "video" ? "MP4" : "JPG";

  let thumbHtml;
  if (thumbUrl) {
    if (type === "video") {
      thumbHtml = `<img src="${esc(thumbUrl)}" alt="${label}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="thumb-placeholder" style="display:none"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>`;
    } else {
      thumbHtml = `<img src="${esc(thumbUrl)}" alt="${label}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2252%22 height=%2252%22><rect fill=%22%23f0f0f0%22 width=%2252%22 height=%2252%22 rx=%228%22/></svg>'">`;
    }
  } else {
    const icon = type === "video"
      ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`
      : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`;
    thumbHtml = `<div class="thumb-placeholder">${icon}</div>`;
  }

  return `
    <li class="media-item">
      <div class="media-thumb">${thumbHtml}</div>
      <div class="media-info">
        <span class="media-type ${typeClass}">${typeLabel}</span>
        <span style="font-size:13px;font-weight:600;margin-left:4px">${label}</span>
        <div class="media-url" title="${esc(url)}">${esc(short)}</div>
      </div>
      <button class="dl-btn" data-idx="${idx}">Save</button>
    </li>`;
}

function shortUrl(url) {
  try { return new URL(url).pathname.split("/").pop()?.slice(0, 35) || "media"; }
  catch { return "media"; }
}

function extractPostId(url) {
  const p = new URL(url).pathname.split("/").filter(Boolean);
  const i = p.indexOf("post");
  return i !== -1 && p[i + 1] ? p[i + 1] : "threads";
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
