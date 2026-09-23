const state = {
  imageUrl: null,
  videoSource: null, // { type: 'sample', sampleId } | { type: 'upload', videoUrl }
  videoDurationSeconds: null,
  samples: [],
  pendingJobs: 0,
};

const el = {
  page: document.querySelector(".page"),
  imageDropzone: document.getElementById("image-dropzone"),
  imageInput: document.getElementById("image-input"),
  imagePreview: document.getElementById("image-preview"),
  imagePreviewImg: document.getElementById("image-preview-img"),
  imagePreviewInfo: document.getElementById("image-preview-info"),
  imagePreviewRemove: document.getElementById("image-preview-remove"),
  samplesGrid: document.getElementById("samples-grid"),
  uploadOwnCard: document.getElementById("upload-own-card"),
  videoInput: document.getElementById("video-input"),
  generateBtn: document.getElementById("generate-btn"),
  resultsGrid: document.getElementById("results-grid"),
  resultCardTemplate: document.getElementById("result-card-template"),
  keepSound: document.getElementById("keep-sound"),
  promptInput: document.getElementById("prompt-input"),
  costMain: document.getElementById("cost-estimate-main"),
  costNote: document.getElementById("cost-estimate-note"),
  costWarning: document.getElementById("cost-estimate-warning"),
  tabBtnGenerate: document.getElementById("tab-btn-generate"),
  tabBtnHistory: document.getElementById("tab-btn-history"),
  generateView: document.getElementById("generate-view"),
  historyView: document.getElementById("history-view"),
  historyGrid: document.getElementById("history-grid"),
  historyCardTemplate: document.getElementById("history-card-template"),
  historyRefreshBtn: document.getElementById("history-refresh-btn"),
  cropperModal: document.getElementById("cropper-modal"),
  cropperImage: document.getElementById("cropper-image"),
  cropperReadout: document.getElementById("cropper-readout"),
  cropperWarning: document.getElementById("cropper-warning"),
  cropperCancel: document.getElementById("cropper-cancel"),
  cropperFull: document.getElementById("cropper-full"),
  cropperConfirm: document.getElementById("cropper-confirm"),
};

const MODEL_LABEL = el.page.dataset.modelLabel;

function videoUrlForJob(job) {
  return job.stored_result_url || job.result_url;
}

// Every API call goes through here so an expired session bounces to the login
// page instead of failing with an opaque error mid-flow.
async function api(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Session expired");
  }
  return res;
}

async function apiError(res, fallback) {
  try {
    return (await res.json()).detail || fallback;
  } catch {
    return fallback;
  }
}

// ---- Tabs ----

el.tabBtnGenerate.addEventListener("click", () => switchTab("generate"));
el.tabBtnHistory.addEventListener("click", () => switchTab("history"));

function switchTab(tab) {
  const isGenerate = tab === "generate";
  el.tabBtnGenerate.classList.toggle("active", isGenerate);
  el.tabBtnHistory.classList.toggle("active", !isGenerate);
  el.generateView.style.display = isGenerate ? "" : "none";
  el.historyView.style.display = isGenerate ? "none" : "";
  if (!isGenerate) loadHistory();
}

function updateGenerateEnabled() {
  el.generateBtn.disabled = !(state.imageUrl && state.videoSource);
}


// ---- Direct-to-fal upload ----
//
// Vercel caps a function request body at 4.5MB, so anything sizeable (a 30s
// reference clip is routinely 20MB+) cannot be proxied through our own API.
// The server mints an upload credential and the bytes go straight to fal.
// XHR rather than fetch, because only XHR reports upload progress.

async function uploadToFal(blob, filename, onProgress) {
  const res = await api("/api/uploads/token", { method: "POST" });
  if (!res.ok) throw new Error(await apiError(res, "Couldn't get an upload token"));
  const { upload_url, authorization } = await res.json();

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", upload_url, true);
    xhr.setRequestHeader("Authorization", authorization);
    xhr.setRequestHeader("Content-Type", blob.type || "application/octet-stream");
    xhr.setRequestHeader("X-Fal-File-Name", filename);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Upload failed (${xhr.status})`));
        return;
      }
      try {
        const url = JSON.parse(xhr.responseText).access_url;
        url ? resolve(url) : reject(new Error("Upload returned no URL"));
      } catch {
        reject(new Error("Upload returned an unreadable response"));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.send(blob);
  });
}

// Falls back to proxying through our own API, which still works for anything
// under the 4.5MB body cap, if the direct route is unavailable.
async function uploadWithFallback(blob, filename, endpoint, urlKey, onProgress) {
  try {
    return await uploadToFal(blob, filename, onProgress);
  } catch (err) {
    if (blob.size > MAX_PROXY_BYTES) throw err;
    const formData = new FormData();
    formData.append("file", blob, filename);
    const res = await api(endpoint, { method: "POST", body: formData });
    if (!res.ok) throw new Error(await apiError(res, "Upload failed"));
    return (await res.json())[urlKey];
  }
}

// ---- Step 1: image upload + crop ----

// Kling Pro motion-control input limits. minShortEdge and the aspect band are
// enforced while dragging; maxLongEdge is applied on export instead, so the
// user is never blocked from selecting the whole of a large photo.
const IMAGE_LIMITS = {
  minShortEdge: 340,
  maxLongEdge: 3850,
  minAspect: 1 / 2.5,
  maxAspect: 2.5,
  maxBytes: 12 * 1024 * 1024, // generous: direct upload isn't bound by the 4.5MB body cap
};

// what the proxied fallback can still carry (Vercel's request body limit)
const MAX_PROXY_BYTES = 4 * 1024 * 1024;
// sanity ceiling for a reference clip, well above a 30s 1080p export
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

// The cropper only ever displays a downscaled copy — a 48MP photo drawn at full
// size can exhaust memory on mobile. Crop coordinates are scaled back up to the
// source bitmap on export, so nothing is lost.
const DISPLAY_MAX_EDGE = 2000;

const crop = {
  cropper: null,
  bitmap: null, // full-resolution, EXIF-oriented
  displayScale: 1, // displayed px -> source px
  sourceName: "image.jpg",
  clamping: false,
};

el.imageDropzone.addEventListener("click", () => el.imageInput.click());

["dragover", "dragleave", "drop"].forEach((evt) => {
  el.imageDropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.imageDropzone.classList.toggle("dragover", evt === "dragover");
  });
});

el.imageDropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) openCropper(file);
});

el.imageInput.addEventListener("change", () => {
  const file = el.imageInput.files[0];
  if (file) openCropper(file);
  el.imageInput.value = ""; // so picking the same file twice still fires
});

el.imagePreviewRemove.addEventListener("click", () => {
  state.imageUrl = null;
  el.imagePreview.classList.remove("visible");
  el.imageDropzone.style.display = "";
  el.imageInput.value = "";
  updateGenerateEnabled();
});

function largestValidRect(width, height) {
  const ratio = width / height;
  if (ratio > IMAGE_LIMITS.maxAspect) {
    return { width: Math.round(height * IMAGE_LIMITS.maxAspect), height };
  }
  if (ratio < IMAGE_LIMITS.minAspect) {
    return { width, height: Math.round(width / IMAGE_LIMITS.minAspect) };
  }
  return { width, height };
}

// Only shrinks. The aspect band guarantees the short edge stays above
// minShortEdge: at 2.5:1 a 3850px long edge still leaves 1540px.
function exportSize(width, height) {
  const longEdge = Math.max(width, height);
  const scale = longEdge > IMAGE_LIMITS.maxLongEdge ? IMAGE_LIMITS.maxLongEdge / longEdge : 1;
  return { width: Math.round(width * scale), height: Math.round(height * scale), scale };
}

async function openCropper(file) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    showImageError(`Unsupported file type: ${file.type || "unknown"}`);
    return;
  }

  let bitmap;
  try {
    // from-image applies the EXIF rotation flag; without it phone photos crop sideways
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    showImageError("Couldn't read that image file.");
    return;
  }

  if (Math.min(bitmap.width, bitmap.height) < IMAGE_LIMITS.minShortEdge) {
    showImageError(
      `Image is only ${bitmap.width}x${bitmap.height}. The shorter side must be at least ` +
        `${IMAGE_LIMITS.minShortEdge}px for this model.`
    );
    bitmap.close?.();
    return;
  }

  crop.bitmap = bitmap;
  crop.sourceName = file.name || "image.jpg";

  const displayScale = Math.min(1, DISPLAY_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  crop.displayScale = displayScale;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * displayScale);
  canvas.height = Math.round(bitmap.height * displayScale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  el.cropperImage.src = canvas.toDataURL("image/jpeg", 0.92);
  el.cropperModal.hidden = false;
  el.cropperWarning.textContent = "";

  initCropper();
}

function initCropper() {
  crop.cropper?.destroy();
  crop.cropper = new Cropper(el.cropperImage, {
    viewMode: 1,
    autoCropArea: 1,
    background: false,
    responsive: true,
    dragMode: "move",
    toggleDragModeOnDblclick: false,
    // the panel scrolls on small screens; without this a wheel over the image
    // zooms instead, which silently breaks "Use full image" (viewMode 1 confines
    // the crop box to the visible canvas, so a zoomed view can't hold the frame)
    zoomOnWheel: false,
    ready: () => selectFullImage(),
    crop: onCropChange,
  });
}

// Cropper keeps the canvas size it was built with, so after a viewport change
// (rotating a phone mid-crop) viewMode:1 would confine the selection to the old
// layout and make the full image unselectable. Rebuilding re-fits it.
let cropResizeTimer = null;
window.addEventListener("resize", () => {
  if (el.cropperModal.hidden || !crop.cropper) return;
  clearTimeout(cropResizeTimer);
  cropResizeTimer = setTimeout(initCropper, 200);
});

// Clamps the selection into the allowed aspect band as the user drags, rather
// than letting them build an invalid crop and rejecting it at the end.
function onCropChange() {
  if (!crop.cropper || crop.clamping) return;
  const d = crop.cropper.getData(true);
  if (!d.width || !d.height) return;

  const ratio = d.width / d.height;
  let next = null;
  if (ratio > IMAGE_LIMITS.maxAspect) {
    next = { ...d, width: Math.round(d.height * IMAGE_LIMITS.maxAspect) };
  } else if (ratio < IMAGE_LIMITS.minAspect) {
    next = { ...d, height: Math.round(d.width / IMAGE_LIMITS.minAspect) };
  }

  if (next) {
    crop.clamping = true;
    crop.cropper.setData(next);
    crop.clamping = false;
  }

  updateCropReadout();
}

function currentCropSourcePx() {
  const d = crop.cropper.getData(true);
  const x = Math.max(0, Math.round(d.x / crop.displayScale));
  const y = Math.max(0, Math.round(d.y / crop.displayScale));
  // Scaling display coords back up can land a pixel past the edge; sampling
  // outside the bitmap would leave a black seam in the exported JPEG.
  return {
    x,
    y,
    width: Math.min(Math.round(d.width / crop.displayScale), crop.bitmap.width - x),
    height: Math.min(Math.round(d.height / crop.displayScale), crop.bitmap.height - y),
  };
}

function updateCropReadout() {
  const src = currentCropSourcePx();
  const out = exportSize(src.width, src.height);
  const shortEdge = Math.min(out.width, out.height);
  const tooSmall = shortEdge < IMAGE_LIMITS.minShortEdge;

  el.cropperReadout.textContent =
    `Output ${out.width} x ${out.height}px` +
    (out.scale < 1 ? ` (scaled down from ${src.width} x ${src.height})` : "") +
    ` - ratio ${(out.width / out.height).toFixed(2)}:1`;

  el.cropperWarning.textContent = tooSmall
    ? `Crop too small - the shorter side must be at least ${IMAGE_LIMITS.minShortEdge}px.`
    : "";
  el.cropperConfirm.disabled = tooSmall;
}

function selectFullImage() {
  if (!crop.cropper) return;
  // Undo any pan/zoom first: with viewMode 1 the crop box cannot leave the
  // visible canvas, so from a zoomed-in view the full frame is unreachable.
  crop.clamping = true;
  crop.cropper.reset();
  crop.clamping = false;

  const img = crop.cropper.getImageData();
  const full = largestValidRect(img.naturalWidth, img.naturalHeight);
  crop.clamping = true;
  crop.cropper.setData({
    x: Math.round((img.naturalWidth - full.width) / 2),
    y: Math.round((img.naturalHeight - full.height) / 2),
    width: full.width,
    height: full.height,
  });
  crop.clamping = false;
  updateCropReadout();
}

el.cropperFull.addEventListener("click", selectFullImage);
el.cropperCancel.addEventListener("click", closeCropper);
el.cropperConfirm.addEventListener("click", confirmCrop);

function closeCropper() {
  crop.cropper?.destroy();
  crop.cropper = null;
  crop.bitmap?.close?.();
  crop.bitmap = null;
  el.cropperImage.src = "";
  el.cropperModal.hidden = true;
}

// Re-encodes as JPEG, stepping quality down if the result would exceed the
// upload cap (Vercel rejects request bodies over ~4.5MB).
async function encodeWithinLimit(canvas) {
  for (const quality of [0.92, 0.85, 0.75, 0.65, 0.5]) {
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", quality));
    if (blob && blob.size <= IMAGE_LIMITS.maxBytes) return blob;
  }
  return null;
}

async function confirmCrop() {
  const src = currentCropSourcePx();
  const out = exportSize(src.width, src.height);

  const canvas = document.createElement("canvas");
  canvas.width = out.width;
  canvas.height = out.height;
  canvas
    .getContext("2d")
    .drawImage(crop.bitmap, src.x, src.y, src.width, src.height, 0, 0, out.width, out.height);

  const blob = await encodeWithinLimit(canvas);
  if (!blob) {
    el.cropperWarning.textContent = "Couldn't compress this crop small enough - try a tighter crop.";
    return;
  }

  const previewUrl = canvas.toDataURL("image/jpeg", 0.7);
  closeCropper();
  uploadImage(blob, previewUrl, `${out.width}x${out.height}`);
}

function showImageError(message) {
  el.imagePreview.classList.add("visible");
  el.imageDropzone.style.display = "none";
  el.imagePreviewImg.removeAttribute("src");
  el.imagePreviewInfo.textContent = `Error: ${message}`;
  state.imageUrl = null;
  updateGenerateEnabled();
}

async function uploadImage(blob, previewUrl, dimensions) {
  el.imagePreviewInfo.textContent = "Uploading...";
  el.imagePreview.classList.add("visible");
  el.imageDropzone.style.display = "none";
  el.imagePreviewImg.src = previewUrl;

  try {
    state.imageUrl = await uploadWithFallback(
      blob,
      "crop.jpg",
      "/api/uploads/image",
      "image_url",
      (p) => {
        el.imagePreviewInfo.textContent = `Uploading... ${Math.round(p * 100)}%`;
      }
    );
    el.imagePreviewInfo.textContent = `Ready - ${dimensions}`;
  } catch (err) {
    el.imagePreviewInfo.textContent = `Error: ${err.message}`;
    state.imageUrl = null;
  }
  updateGenerateEnabled();
}

// ---- Step 2: motion samples + custom upload ----

async function loadSamples() {
  const res = await api("/api/samples");
  const data = await res.json();
  state.samples = data.samples || [];
  renderSamples();
}

function renderSamples() {
  const cards = state.samples.map((sample) => {
    const thumb = sample.available
      ? `<video class="sample-thumb" controls preload="metadata" src="${sample.video_url}#t=0.1"></video>`
      : `<div class="sample-thumb-fallback">🎬</div>`;
    return `
      <div class="sample-card ${sample.available ? "" : "unavailable"}" data-sample-id="${sample.id}">
        ${thumb}
        <div class="sample-info">
          <div class="name">${sample.name}</div>
          <div class="desc">${sample.available ? sample.description : "Video not uploaded yet"}</div>
        </div>
      </div>
    `;
  });

  el.samplesGrid.innerHTML = cards.join("") + el.uploadOwnCard.outerHTML;
  // re-bind upload-own card (innerHTML replaced the node)
  document.getElementById("upload-own-card").addEventListener("click", () => el.videoInput.click());

  el.samplesGrid.querySelectorAll(".sample-card[data-sample-id]").forEach((card) => {
    card.addEventListener("click", () => {
      const sample = state.samples.find((s) => s.id === card.dataset.sampleId);
      if (!sample || !sample.available) return;
      selectSample(sample, card);
    });
  });
}

function clearSelection() {
  el.samplesGrid.querySelectorAll(".sample-card").forEach((c) => c.classList.remove("selected"));
}

// Reads the clip length off a <video>. The element may not have its metadata
// yet when the user clicks, so wait for it rather than reporting NaN.
function readDuration(video) {
  return new Promise((resolve) => {
    if (video.readyState >= 1 && Number.isFinite(video.duration)) {
      resolve(video.duration);
      return;
    }
    const done = () => {
      cleanup();
      resolve(Number.isFinite(video.duration) ? video.duration : null);
    };
    const fail = () => {
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", done);
      video.removeEventListener("error", fail);
    };
    video.addEventListener("loadedmetadata", done);
    video.addEventListener("error", fail);
  });
}

function probeFileDuration(file) {
  const video = document.createElement("video");
  video.preload = "metadata";
  video.src = URL.createObjectURL(file);
  return readDuration(video).finally(() => URL.revokeObjectURL(video.src));
}

async function selectSample(sample, cardEl) {
  clearSelection();
  cardEl.classList.add("selected");
  state.videoSource = { type: "sample", sampleId: sample.id };
  updateGenerateEnabled();

  const thumb = cardEl.querySelector(".sample-thumb");
  state.videoDurationSeconds = thumb ? await readDuration(thumb) : null;
  refreshEstimate();
}

el.videoInput.addEventListener("change", async () => {
  const file = el.videoInput.files[0];
  if (!file) return;

  clearSelection();
  const uploadCard = document.getElementById("upload-own-card");
  uploadCard.classList.add("selected");
  uploadCard.textContent = "Uploading reference video...";

  // measured before the upload so the estimate can appear as soon as it lands
  const duration = await probeFileDuration(file);

  if (file.size > MAX_VIDEO_BYTES) {
    uploadCard.textContent = `Too large (${(file.size / 1048576).toFixed(0)}MB, max 200MB)`;
    state.videoSource = null;
    state.videoDurationSeconds = null;
    updateGenerateEnabled();
    refreshEstimate();
    return;
  }

  const sizeLabel = `${(file.size / 1048576).toFixed(1)}MB`;
  try {
    const videoUrl = await uploadWithFallback(
      file,
      file.name || "reference.mp4",
      "/api/uploads/video",
      "video_url",
      (p) => {
        uploadCard.textContent = `Uploading ${sizeLabel}... ${Math.round(p * 100)}%`;
      }
    );
    state.videoSource = { type: "upload", videoUrl };
    state.videoDurationSeconds = duration;
    uploadCard.textContent = `✓ ${file.name}`;
    refreshEstimate();
  } catch (err) {
    uploadCard.textContent = `Error: ${err.message}`;
    state.videoSource = null;
    state.videoDurationSeconds = null;
    refreshEstimate();
  }
  updateGenerateEnabled();
});

// ---- Cost estimate ----

function currencySymbol(currency) {
  return currency === "USD" ? "$" : `${currency} `;
}

function money(amount, currency) {
  return `${currencySymbol(currency)}${amount.toFixed(2)}`;
}

// The per-second rate carries real precision ($0.112), so two decimals would
// round it into a different number — show up to four, without trailing zeros.
function rate(amount, currency) {
  return `${currencySymbol(currency)}${parseFloat(amount.toFixed(4))}`;
}

async function refreshEstimate() {
  el.costWarning.textContent = "";
  el.costNote.textContent = "";

  if (!state.videoSource) {
    el.costMain.textContent = "Pick a reference motion to see the estimated cost.";
    return;
  }
  if (!state.videoDurationSeconds) {
    el.costMain.textContent = "Couldn't read the reference clip's length — cost unknown.";
    return;
  }

  el.costMain.textContent = "Estimating cost...";

  try {
    const res = await api("/api/estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ duration_seconds: state.videoDurationSeconds }),
    });
    if (!res.ok) throw new Error(await apiError(res, "Estimate failed"));
    const data = await res.json();

    el.costMain.textContent =
      `Estimated cost: ${money(data.cost, data.currency)} — ` +
      `${data.seconds_billed}s at ${rate(data.price_per_second, data.currency)}/s ` +
      `· ${data.model_label}`;

    if (data.source === "rate-card") {
      el.costNote.textContent = "Based on the published rate card — fal's live pricing was unavailable.";
    }
    if (data.clamped) {
      el.costWarning.textContent =
        `Your clip is ${Math.round(state.videoDurationSeconds)}s but the model caps at ` +
        `${data.max_seconds}s — fal may reject or truncate it.`;
    }
  } catch (err) {
    el.costMain.textContent = `Couldn't estimate cost: ${err.message}`;
  }
}

// ---- Generate ----

el.generateBtn.addEventListener("click", generate);

async function generate() {
  el.generateBtn.disabled = true;
  el.resultsGrid.innerHTML = "";
  state.pendingJobs = 1;

  const card = createResultCard(MODEL_LABEL);
  el.resultsGrid.appendChild(card);

  const prompt = el.promptInput.value.trim();
  const body = {
    image_url: state.imageUrl,
    keep_original_sound: el.keepSound.checked,
  };
  if (prompt) {
    body.prompt = prompt;
  }
  if (state.videoSource.type === "sample") {
    body.sample_id = state.videoSource.sampleId;
  } else {
    body.video_url = state.videoSource.videoUrl;
  }

  try {
    const res = await api("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await apiError(res, "Failed to start generation"));
    const job = await res.json();

    if (job.model_label) {
      card.querySelector(".result-card-header").textContent = job.model_label;
    }
    if (job.error) {
      setCardStatus(card, `Failed: ${job.error}`, false, true);
      jobDone();
    } else {
      pollJob(job.job_id, card);
    }
  } catch (err) {
    setCardStatus(card, `Error: ${err.message}`, false, true);
    state.pendingJobs = 0;
    el.generateBtn.disabled = false;
  }
}

function jobDone() {
  state.pendingJobs = Math.max(0, state.pendingJobs - 1);
  if (state.pendingJobs === 0) {
    el.generateBtn.disabled = false;
  }
}

function createResultCard(label) {
  const fragment = el.resultCardTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".result-card");
  card.querySelector(".result-card-header").textContent = label;
  return card;
}

function setCardStatus(card, text, spinning, isError = false, isDone = false) {
  card.querySelector(".result-status-text").textContent = text;
  card.querySelector(".spinner").style.display = spinning ? "inline-block" : "none";
  card.querySelector(".result-status").classList.toggle("error", isError);
  card.querySelector(".result-status").classList.toggle("done", isDone);
}

async function pollJob(jobId, card) {
  setCardStatus(card, "Submitted...", true);

  const tick = async () => {
    const res = await api(`/api/jobs/${jobId}`);
    const job = await res.json();

    if (job.status === "completed") {
      setCardStatus(card, "Done", false, false, true);
      const video = card.querySelector(".result-video");
      video.src = videoUrlForJob(job);
      video.classList.add("visible");
      const link = card.querySelector(".download-link");
      link.href = videoUrlForJob(job);
      link.classList.add("visible");
      jobDone();
      return;
    }

    if (job.status === "failed") {
      setCardStatus(card, `Failed: ${job.error || "unknown error"}`, false, true);
      jobDone();
      return;
    }

    setCardStatus(card, `Status: ${job.status}`, true);
    setTimeout(tick, 2500);
  };

  tick();
}

// ---- History tab ----

el.historyRefreshBtn.addEventListener("click", loadHistory);

async function loadHistory() {
  const res = await api("/api/history");
  const data = await res.json();
  const jobs = data.jobs || [];

  el.historyGrid.innerHTML = "";

  if (!jobs.length) {
    el.historyGrid.innerHTML = '<div class="history-empty">No generations yet.</div>';
    return;
  }

  jobs.forEach((job) => {
    const card = createHistoryCard(job);
    el.historyGrid.appendChild(card);
    applyJobToHistoryCard(card, job);
    if (job.status !== "completed" && job.status !== "failed") {
      pollHistoryJob(job.id, card);
    }
  });
}

function createHistoryCard(job) {
  const fragment = el.historyCardTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".history-card");
  card.dataset.jobId = job.id;
  return card;
}

function applyJobToHistoryCard(card, job) {
  card.querySelector(".history-card-model").textContent = job.model_label || job.model;

  const statusEl = card.querySelector(".history-card-status");
  statusEl.textContent = job.status;
  statusEl.className = `history-card-status ${job.status}`;

  const date = new Date(job.created_at);
  card.querySelector(".history-card-date").textContent = date.toLocaleString();
  card.querySelector(".history-card-source").textContent = job.source || "";

  const video = card.querySelector(".result-video");
  const link = card.querySelector(".download-link");
  const url = videoUrlForJob(job);
  if (job.status === "completed" && url) {
    video.src = url;
    video.classList.add("visible");
    link.href = url;
    link.classList.add("visible");
  } else {
    video.classList.remove("visible");
    link.classList.remove("visible");
  }
}

function pollHistoryJob(jobId, card) {
  const tick = async () => {
    // the card may have been replaced by a full-grid refresh in the meantime
    if (!el.historyGrid.contains(card)) return;

    const res = await api(`/api/jobs/${jobId}`);
    const job = await res.json();
    applyJobToHistoryCard(card, job);

    if (job.status !== "completed" && job.status !== "failed") {
      setTimeout(tick, 3000);
    }
  };

  tick();
}

loadSamples();
