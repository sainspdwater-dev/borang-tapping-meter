const AREAS = [
  { name: "Taman PD Utama", target: 214 },
  { name: "Taman Desa Permai", target: 86 },
  { name: "Taman Samudera", target: 51 },
  { name: "Taman Flora", target: 36 },
  { name: "Rumah Rakyat Kg Paya", target: 48 },
  { name: "Rumah Rakyat Pekan Lukut", target: 33 }
];

const config = window.APP_CONFIG || {};
const $ = (selector) => document.querySelector(selector);
const state = {
  stats: Object.fromEntries(AREAS.map((area) => [area.name, 0])),
  imageFile: null,
  imageUrl: null,
  preparedImage: null,
  confirmedImage: null,
  turnstileToken: "",
  widgetId: null
};

const form = $("#tappingForm");
const areaSelect = $("#areaSelect");
const meterImage = $("#meterImage");
const ocrModal = $("#ocrModal");
const toast = $("#toast");

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value);
  return div.innerHTML;
}

function showToast(message, type = "success") {
  toast.textContent = message;
  toast.className = `toast show ${type === "error" ? "error" : ""}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = "toast"; }, 3400);
}

function storedRecords() {
  try { return JSON.parse(localStorage.getItem("tapping-demo-records") || "[]"); }
  catch { return []; }
}

function renderStats() {
  const active = areaSelect.value;
  $("#areaCards").innerHTML = AREAS.map((area) => {
    const done = Number(state.stats[area.name] || 0);
    const percent = Math.min(100, Math.round((done / area.target) * 100));
    return `<article class="area-card ${active === area.name ? "active" : ""}">
      <div class="area-row"><strong>${escapeHtml(area.name)}</strong><span><b>${done}</b> / ${area.target}</span></div>
      <div class="mini-track"><div style="width:${percent}%"></div></div>
    </article>`;
  }).join("");

  const done = Object.values(state.stats).reduce((sum, n) => sum + Number(n || 0), 0);
  const target = AREAS.reduce((sum, area) => sum + area.target, 0);
  const percent = Math.min(100, Math.round((done / target) * 100));
  $("#overallDone").textContent = done;
  $("#overallTarget").textContent = target;
  $("#overallPercent").textContent = `${percent}%`;
  $("#overallBar").style.width = `${percent}%`;
  $("#overallRemaining").textContent = `${Math.max(0, target - done)} rekod lagi untuk disiapkan`;
}

async function loadStats() {
  const refresh = $("#refreshStats");
  refresh.classList.add("loading");
  try {
    if (config.apiBaseUrl && !config.demoMode) {
      const response = await fetch(`${config.apiBaseUrl}/api/stats`);
      if (!response.ok) throw new Error("Tidak dapat mendapatkan statistik.");
      const data = await response.json();
      state.stats = { ...state.stats, ...data.counts };
    } else {
      state.stats = Object.fromEntries(AREAS.map((area) => [
        area.name,
        storedRecords().filter((record) => record.area === area.name).length
      ]));
    }
    renderStats();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    refresh.classList.remove("loading");
  }
}

function setConfirmedMeter(value, { fromPhoto = false } = {}) {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
  if (!normalized) return showToast("Masukkan nombor meter dahulu.", "error");
  if (!/^(?:SAINS|JBANS)[A-Z0-9-]{4,25}$/.test(normalized)) {
    return showToast("Nombor meter mesti bermula dengan SAINS atau JBANS dan mempunyai sekurang-kurangnya 4 aksara selepasnya.", "error");
  }
  $("#meterValue").value = normalized;
  $("#confirmedMeterText").textContent = normalized;
  $("#confirmedMeter").hidden = false;
  $("#cameraMode").classList.remove("active");
  $("#manualMode").classList.remove("active");
  $("#meterStatus").textContent = "Sudah disahkan";
  $("#meterStatus").classList.add("ok");
  state.confirmedImage = fromPhoto ? state.preparedImage : null;
  if (!fromPhoto) state.preparedImage = null;
  $("#photoSaveStatus").hidden = !state.confirmedImage;
  clearSourceImage();
}

function clearConfirmedMeter() {
  $("#meterValue").value = "";
  $("#confirmedMeter").hidden = true;
  $("#meterStatus").textContent = "Belum disahkan";
  $("#meterStatus").classList.remove("ok");
  state.confirmedImage = null;
  state.preparedImage = null;
  $("#photoSaveStatus").hidden = true;
  const activeMode = $(".mode-button.active").dataset.mode;
  $(`#${activeMode}Mode`).classList.add("active");
}

function clearSourceImage() {
  if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
  state.imageUrl = null;
  state.imageFile = null;
  meterImage.value = "";
  $("#meterPreview").removeAttribute("src");
}

function clearImage() {
  clearSourceImage();
  state.preparedImage = null;
}

function closeModal(clear = true) {
  ocrModal.hidden = true;
  document.body.style.overflow = "";
  $(".preview-frame").classList.remove("scanning");
  if (clear) clearImage();
}

function dataUrlByteSize(dataUrl) {
  const base64 = String(dataUrl).split(",")[1] || "";
  return Math.max(0, Math.floor((base64.length * 3) / 4) - ((base64.match(/=+$/) || [""])[0].length));
}

async function prepareOcrImage(file) {
  const bitmap = await createImageBitmap(file);
  const maxSide = 1600;
  const longestSide = Math.max(bitmap.width, bitmap.height);
  const targetSide = Math.min(maxSide, Math.max(1024, longestSide));
  let scale = targetSide / longestSide;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  let quality = 0.88;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrlByteSize(dataUrl) > 1_000_000) {
    if (quality > 0.58) {
      quality -= 0.08;
    } else {
      const resized = document.createElement("canvas");
      resized.width = Math.max(480, Math.round(canvas.width * 0.84));
      resized.height = Math.max(480, Math.round(canvas.height * 0.84));
      resized.getContext("2d").drawImage(canvas, 0, 0, resized.width, resized.height);
      canvas.width = resized.width;
      canvas.height = resized.height;
      context.drawImage(resized, 0, 0);
      quality = 0.72;
    }
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  canvas.width = 1;
  canvas.height = 1;
  return dataUrl;
}

async function runOcr() {
  if (!state.imageFile) return;
  const button = $("#runOcr");
  button.disabled = true;
  button.textContent = "Sedang membaca…";
  $(".preview-frame").classList.add("scanning");
  $("#ocrMessage").textContent = "Cloudflare AI sedang membaca nombor siri pada meter…";
  try {
    if (!config.apiBaseUrl || config.demoMode) throw new Error("Cloudflare AI belum tersedia.");
    const image = state.preparedImage || await prepareOcrImage(state.imageFile);
    state.preparedImage = image;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let response;
    try {
      response = await fetch(`${config.apiBaseUrl}/api/ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    const body = await response.json();
    const meter = body.meter || "";
    if (!response.ok && response.status !== 422) throw new Error(body.error || "Cloudflare AI gagal membaca gambar.");

    $("#ocrResult").value = meter;
    $("#ocrResultWrap").hidden = false;
    $("#confirmOcr").hidden = false;
    button.hidden = true;
    $("#ocrMessage").textContent = meter
      ? "Adakah nombor ini sama seperti yang tertera pada meter?"
      : "OCR belum dapat membaca nombor penuh. Taip nombor penuh bermula dengan SAINS atau JBANS berdasarkan meter.";
  } catch (error) {
    const message = error.name === "AbortError" ? "Bacaan mengambil masa terlalu lama. Cuba sekali lagi." : error.message;
    showToast(message, "error");
    $("#ocrMessage").textContent = "OCR gagal membaca imej. Ambil semula gambar atau gunakan isi manual.";
  } finally {
    button.disabled = false;
    button.textContent = "Baca nombor";
    $(".preview-frame").classList.remove("scanning");
  }
}

function initTurnstile() {
  if (!config.turnstileSiteKey) return;
  $("#turnstileDemo").hidden = true;
  const attempt = () => {
    if (!window.turnstile) return setTimeout(attempt, 250);
    state.widgetId = window.turnstile.render("#turnstileWidget", {
      sitekey: config.turnstileSiteKey,
      callback: (token) => { state.turnstileToken = token; },
      "expired-callback": () => { state.turnstileToken = ""; }
    });
  };
  attempt();
}

async function submitRecord(event) {
  event.preventDefault();
  if (!$("#meterValue").value && $("#manualMode").classList.contains("active") && $("#manualMeter").value.trim()) {
    setConfirmedMeter($("#manualMeter").value);
    if (!$("#meterValue").value) return;
  }
  const data = {
    area: areaSelect.value,
    meter: $("#meterValue").value,
    coordinates: $("#coordinates").value.trim(),
    turnstileToken: state.turnstileToken,
    image: state.confirmedImage || ""
  };
  if (!data.area) return showToast("Pilih nama kawasan.", "error");
  if (!data.meter) return showToast("Sahkan nombor meter dahulu.", "error");
  if (!data.coordinates) return showToast("Masukkan koordinat atau gunakan lokasi semasa.", "error");
  if (config.turnstileSiteKey && !data.turnstileToken) {
    return showToast("Sila lengkapkan pengesahan Turnstile.", "error");
  }

  const button = $("#submitButton");
  button.disabled = true;
  button.firstElementChild.textContent = "Sedang menyimpan…";
  try {
    if (config.apiBaseUrl && !config.demoMode) {
      const response = await fetch(`${config.apiBaseUrl}/api/submissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Rekod gagal disimpan.");
    } else {
      const records = storedRecords();
      records.push({ ...data, createdAt: new Date().toISOString() });
      localStorage.setItem("tapping-demo-records", JSON.stringify(records));
    }
    const retainedArea = data.area;
    form.reset();
    areaSelect.value = retainedArea;
    localStorage.setItem("tapping-active-area", retainedArea);
    clearConfirmedMeter();
    clearImage();
    await loadStats();
    if (state.widgetId !== null && window.turnstile) window.turnstile.reset(state.widgetId);
    state.turnstileToken = "";
    showToast(data.image ? "Rekod dan gambar berjaya disimpan." : "Rekod berjaya disimpan.");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.firstElementChild.textContent = "Simpan rekod";
  }
}

function init() {
  areaSelect.innerHTML = AREAS.map((area) => `<option value="${escapeHtml(area.name)}">${escapeHtml(area.name)}</option>`).join("");
  const storedArea = localStorage.getItem("tapping-active-area");
  if (AREAS.some((area) => area.name === storedArea)) areaSelect.value = storedArea;
  renderStats();
  loadStats();
  initTurnstile();

  areaSelect.addEventListener("change", () => {
    localStorage.setItem("tapping-active-area", areaSelect.value);
    renderStats();
  });
  $("#refreshStats").addEventListener("click", loadStats);
  $("#openCamera").addEventListener("click", () => meterImage.click());
  meterImage.addEventListener("change", () => {
    const selectedFile = meterImage.files[0];
    if (!selectedFile) return;
    clearImage();
    state.confirmedImage = null;
    $("#photoSaveStatus").hidden = true;
    state.imageFile = selectedFile;
    state.imageUrl = URL.createObjectURL(state.imageFile);
    $("#meterPreview").src = state.imageUrl;
    $("#ocrResultWrap").hidden = true;
    $("#confirmOcr").hidden = true;
    $("#runOcr").hidden = false;
    $("#ocrMessage").textContent = "Pastikan nombor dalam gambar kelihatan jelas sebelum bacaan dimulakan.";
    ocrModal.hidden = false;
    document.body.style.overflow = "hidden";
    runOcr();
  });
  $("#runOcr").addEventListener("click", runOcr);
  $("#confirmOcr").addEventListener("click", () => {
    const value = $("#ocrResult").value;
    if (!value.trim()) return showToast("Nombor meter masih kosong.", "error");
    setConfirmedMeter(value, { fromPhoto: true });
    closeModal(false);
    showToast("Nombor meter disahkan. Gambar sedia disimpan ke Google Drive.");
  });
  $("#retakePhoto").addEventListener("click", () => { closeModal(); meterImage.click(); });
  $("#closeModal").addEventListener("click", () => closeModal());
  $(".modal-backdrop").addEventListener("click", () => closeModal());

  document.querySelectorAll(".mode-button").forEach((button) => {
    button.addEventListener("click", () => {
      if ($("#meterValue").value) clearConfirmedMeter();
      document.querySelectorAll(".mode-button").forEach((item) => item.classList.toggle("active", item === button));
      document.querySelectorAll(".meter-mode").forEach((item) => item.classList.remove("active"));
      $(`#${button.dataset.mode}Mode`).classList.add("active");
    });
  });
  $("#confirmManual").addEventListener("click", () => setConfirmedMeter($("#manualMeter").value));
  $("#editMeter").addEventListener("click", clearConfirmedMeter);

  $("#getLocation").addEventListener("click", () => {
    if (!navigator.geolocation) return showToast("Peranti ini tidak menyokong lokasi.", "error");
    const button = $("#getLocation");
    button.classList.add("loading");
    button.disabled = true;
    $("#locationHint").textContent = "Sedang mendapatkan lokasi GPS…";
    navigator.geolocation.getCurrentPosition((position) => {
      const { latitude, longitude, accuracy } = position.coords;
      $("#coordinates").value = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
      $("#locationHint").textContent = `Ketepatan anggaran ±${Math.round(accuracy)} meter.`;
      button.classList.remove("loading");
      button.disabled = false;
      showToast("Lokasi semasa berjaya diambil.");
    }, (error) => {
      const message = error.code === 1 ? "Kebenaran lokasi tidak diberikan." : "Lokasi semasa tidak dapat diperoleh.";
      $("#locationHint").textContent = "Isi latitude, longitude atau cuba semula.";
      button.classList.remove("loading");
      button.disabled = false;
      showToast(message, "error");
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
  form.addEventListener("submit", submitRecord);
  window.addEventListener("online", () => { $("#connectionText").textContent = "Sedia digunakan"; });
  window.addEventListener("offline", () => { $("#connectionText").textContent = "Tiada sambungan"; });
}

init();
