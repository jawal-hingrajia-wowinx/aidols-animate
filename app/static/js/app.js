const state = {
  imageUrl: null,
  videoSource: null, // { type: 'sample', sampleId, orientation } | { type: 'upload', videoUrl }
  samples: [],
  models: [],
  pendingJobs: 0,
};

const el = {
  imageDropzone: document.getElementById("image-dropzone"),
  imageInput: document.getElementById("image-input"),
  imagePreview: document.getElementById("image-preview"),
  imagePreviewImg: document.getElementById("image-preview-img"),
  imagePreviewInfo: document.getElementById("image-preview-info"),
  imagePreviewRemove: document.getElementById("image-preview-remove"),
  samplesGrid: document.getElementById("samples-grid"),
  uploadOwnCard: document.getElementById("upload-own-card"),
  videoInput: document.getElementById("video-input"),
  modelsList: document.getElementById("models-list"),
  generateBtn: document.getElementById("generate-btn"),
  resultsGrid: document.getElementById("results-grid"),
  resultCardTemplate: document.getElementById("result-card-template"),
  keepSound: document.getElementById("keep-sound"),
  promptInput: document.getElementById("prompt-input"),
  tabBtnGenerate: document.getElementById("tab-btn-generate"),
  tabBtnHistory: document.getElementById("tab-btn-history"),
  generateView: document.getElementById("generate-view"),
  historyView: document.getElementById("history-view"),
  historyGrid: document.getElementById("history-grid"),
  historyCardTemplate: document.getElementById("history-card-template"),
  historyRefreshBtn: document.getElementById("history-refresh-btn"),
};

function videoUrlForJob(job) {
  return job.stored_result_url || job.result_url;
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
  const anyModelChecked = el.modelsList.querySelectorAll("input[type=checkbox]:checked").length > 0;
  el.generateBtn.disabled = !(state.imageUrl && state.videoSource && anyModelChecked);
}

function setOrientation(value) {
  document.querySelector(`input[name="orientation"][value="${value}"]`).checked = true;
}

// ---- Step 1: image upload ----

el.imageDropzone.addEventListener("click", () => el.imageInput.click());

["dragover", "dragleave", "drop"].forEach((evt) => {
  el.imageDropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.imageDropzone.classList.toggle("dragover", evt === "dragover");
  });
});

el.imageDropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) uploadImage(file);
});

el.imageInput.addEventListener("change", () => {
  const file = el.imageInput.files[0];
  if (file) uploadImage(file);
});

el.imagePreviewRemove.addEventListener("click", () => {
  state.imageUrl = null;
  el.imagePreview.classList.remove("visible");
  el.imageDropzone.style.display = "";
  el.imageInput.value = "";
  updateGenerateEnabled();
});

async function uploadImage(file) {
  el.imagePreviewInfo.textContent = "Uploading...";
  el.imagePreview.classList.add("visible");
  el.imageDropzone.style.display = "none";
  el.imagePreviewImg.src = URL.createObjectURL(file);

  try {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/uploads/image", { method: "POST", body: formData });
    if (!res.ok) throw new Error((await res.json()).detail || "Upload failed");
    const data = await res.json();
    state.imageUrl = data.image_url;
    el.imagePreviewInfo.textContent = "Ready";
  } catch (err) {
    el.imagePreviewInfo.textContent = `Error: ${err.message}`;
    state.imageUrl = null;
  }
  updateGenerateEnabled();
}

// ---- Step 2: motion samples + custom upload ----

async function loadSamples() {
  const res = await fetch("/api/samples");
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

function selectSample(sample, cardEl) {
  clearSelection();
  cardEl.classList.add("selected");
  state.videoSource = { type: "sample", sampleId: sample.id };
  setOrientation(sample.character_orientation || "video");
  updateGenerateEnabled();
}

el.videoInput.addEventListener("change", async () => {
  const file = el.videoInput.files[0];
  if (!file) return;

  clearSelection();
  const uploadCard = document.getElementById("upload-own-card");
  uploadCard.classList.add("selected");
  uploadCard.textContent = "Uploading reference video...";

  try {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/uploads/video", { method: "POST", body: formData });
    if (!res.ok) throw new Error((await res.json()).detail || "Upload failed");
    const data = await res.json();
    state.videoSource = { type: "upload", videoUrl: data.video_url };
    uploadCard.textContent = `✓ ${file.name}`;
  } catch (err) {
    uploadCard.textContent = `Error: ${err.message}`;
    state.videoSource = null;
  }
  updateGenerateEnabled();
});

// ---- Step 4: model selection ----

async function loadModels() {
  const res = await fetch("/api/models");
  const data = await res.json();
  state.models = data.models || [];
  renderModels();
}

function renderModels() {
  el.modelsList.innerHTML = state.models
    .map(
      (model) => `
      <label class="model-option active" data-model-key="${model.key}">
        <input type="checkbox" value="${model.key}" checked />
        ${model.label}
      </label>
    `
    )
    .join("");

  el.modelsList.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", () => {
      cb.closest(".model-option").classList.toggle("active", cb.checked);
      updateGenerateEnabled();
    });
  });

  updateGenerateEnabled();
}

function selectedModels() {
  return Array.from(el.modelsList.querySelectorAll("input[type=checkbox]:checked")).map(
    (cb) => cb.value
  );
}

function modelLabel(modelKey) {
  const model = state.models.find((m) => m.key === modelKey);
  return model ? model.label : modelKey;
}

// ---- Step 3 + generate ----

el.generateBtn.addEventListener("click", generate);

async function generate() {
  const models = selectedModels();
  if (!models.length) return;

  el.generateBtn.disabled = true;
  el.resultsGrid.innerHTML = "";
  state.pendingJobs = models.length;

  const cardsByModel = {};
  models.forEach((modelKey) => {
    const card = createResultCard(modelKey);
    cardsByModel[modelKey] = card;
    el.resultsGrid.appendChild(card);
  });

  const orientation = document.querySelector('input[name="orientation"]:checked').value;
  const prompt = el.promptInput.value.trim();
  const body = {
    image_url: state.imageUrl,
    character_orientation: orientation,
    keep_original_sound: el.keepSound.checked,
    models,
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
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json()).detail || "Failed to start generation");
    const { jobs } = await res.json();

    jobs.forEach((job) => {
      const card = cardsByModel[job.model];
      if (job.error) {
        setCardStatus(card, `Failed: ${job.error}`, false, true);
        jobDone();
      } else {
        pollJob(job.job_id, card);
      }
    });
  } catch (err) {
    models.forEach((modelKey) => {
      setCardStatus(cardsByModel[modelKey], `Error: ${err.message}`, false, true);
    });
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

function createResultCard(modelKey) {
  const fragment = el.resultCardTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".result-card");
  card.querySelector(".result-card-header").textContent = modelLabel(modelKey);
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
    const res = await fetch(`/api/jobs/${jobId}`);
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
  const res = await fetch("/api/history");
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

    const res = await fetch(`/api/jobs/${jobId}`);
    const job = await res.json();
    job.model_label = modelLabel(job.model);
    applyJobToHistoryCard(card, job);

    if (job.status !== "completed" && job.status !== "failed") {
      setTimeout(tick, 3000);
    }
  };

  tick();
}

loadSamples();
loadModels();
