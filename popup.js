document.addEventListener("DOMContentLoaded", async () => {
  const content = document.getElementById("content");
  const status = document.getElementById("status");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes("threads.com")) {
    status.textContent = "Threads 페이지에서 사용해주세요.";
    return;
  }

  // ── Collect media from all sources ──
  const videoSet = new Set();
  const imageSet = new Set();

  // Source 1: Network-captured URLs
  try {
    const r = await chrome.runtime.sendMessage({ type: "GET_CAPTURED_URLS", tabId: tab.id });
    (r?.urls || []).forEach((u) => videoSet.add(u));
    (r?.imageUrls || []).forEach((u) => imageSet.add(u));
  } catch {}

  // Source 2: Scan page SSR JSON + DOM (includes thumbnails)
  let pageThumbnails = {};
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scanPage
    });
    if (result?.result) {
      result.result.videos.forEach((u) => videoSet.add(u));
      result.result.images.forEach((u) => imageSet.add(u));
      // Merge thumbnails: url -> thumbnailUrl
      Object.assign(pageThumbnails, result.result.thumbnails || {});
    }
  } catch {}

  // Source 3: Embed fallback (videos only)
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
  let html = "";

  // Videos section
  if (videos.length) {
    html += `<div class="section-title">Videos (${videos.length})</div>`;
    html += `<ul class="media-list">`;
    videos.forEach((url, i) => {
      const thumb = pageThumbnails[url] || null;
      html += mediaItem(url, i, "video", `Video ${i + 1}`, thumb);
    });
    html += `</ul>`;
  }

  // Images section
  if (images.length) {
    html += `<div class="section-title">Photos (${images.length})</div>`;
    html += `<ul class="media-list">`;
    images.forEach((url, i) => {
      const thumb = pageThumbnails[url] || url; // image URL itself is the thumbnail
      html += mediaItem(url, videos.length + i, "photo", `Photo ${i + 1}`, thumb);
    });
    html += `</ul>`;
  }

  // Download all
  html += `
    <div class="dl-all-wrap">
      <button class="dl-all" id="dl-all">모두 다운로드 (${total})</button>
    </div>`;

  content.innerHTML = html;

  // All media URLs + thumbnails in order
  const allMedia = [
    ...videos.map((u) => ({ url: u, ext: "mp4", thumb: pageThumbnails[u] || null })),
    ...images.map((u) => ({ url: u, ext: "jpg", thumb: u }))
  ];

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

function mediaItem(url, idx, type, label, thumbUrl) {
  const short = shortUrl(url);
  const typeClass = type === "video" ? "type-video" : "type-photo";
  const typeLabel = type === "video" ? "MP4" : "JPG";

  let thumbHtml;
  if (thumbUrl) {
    if (type === "video") {
      // Video thumbnail: use <video> element with poster
      thumbHtml = `<video muted playsinline src="${esc(thumbUrl)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"></video><div class="thumb-placeholder" style="display:none"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></div>`;
    } else {
      // Image thumbnail: use <img>
      thumbHtml = `<img src="${esc(thumbUrl)}" alt="${label}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2252%22 height=%2252%22><rect fill=%22%23f0f0f0%22 width=%2252%22 height=%2252%22 rx=%228%22/></svg>'">`;
    }
  } else {
    // No thumbnail: show placeholder
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

// Runs in content script context
function scanPage() {
  const videos = [];
  const images = [];
  const thumbnails = {}; // mediaUrl -> thumbnailUrl

  // SSR JSON
  for (const s of document.querySelectorAll('script[type="application/json"]')) {
    try { dig(JSON.parse(s.textContent), 0); } catch {}
  }

  // DOM video elements — capture src + poster
  for (const v of document.querySelectorAll("video")) {
    const src = v.currentSrc || v.src || "";
    if (src && !src.startsWith("blob:")) {
      videos.push(src);
      // Use video element's poster as thumbnail if available
      if (v.poster) thumbnails[src] = v.poster;
    }
    const source = v.querySelector("source");
    if (source?.src && !source.src.startsWith("blob:")) {
      videos.push(source.src);
      if (v.poster) thumbnails[source.src] = v.poster;
    }
  }

  // DOM img elements (CDN only, large)
  for (const img of document.querySelectorAll("img")) {
    const src = img.src || "";
    if (!src.includes("cdninstagram.com") && !src.includes("fbcdn.net")) continue;
    if (src.includes("/t51.2885-19/")) continue; // profile pic
    const r = img.getBoundingClientRect();
    if (r.width >= 150 && r.height >= 150) images.push(src);
  }

  return { videos: [...new Set(videos)], images: [...new Set(images)], thumbnails };

  function dig(obj, d) {
    if (d > 20 || !obj || typeof obj !== "object") return;
    if (Array.isArray(obj.video_versions)) {
      for (const v of obj.video_versions) if (v.url) videos.push(v.url);
      return;
    }
    if (typeof obj.video_url === "string") videos.push(obj.video_url);
    if (obj.image_versions2?.candidates) {
      for (const c of obj.image_versions2.candidates) if (c.url) images.push(c.url);
      return;
    }
    for (const v of (Array.isArray(obj) ? obj : Object.values(obj))) dig(v, d + 1);
  }
}

function extractPostId(url) {
  const p = new URL(url).pathname.split("/").filter(Boolean);
  const i = p.indexOf("post");
  return i !== -1 && p[i + 1] ? p[i + 1] : "threads";
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
