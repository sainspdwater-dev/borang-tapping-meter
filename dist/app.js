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

function setConfirmedMeter(value) {
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
  clearImage();
}

function clearConfirmedMeter() {
  $("#meterValue").value = "";
  $("#confirmedMeter").hidden = true;
  $("#meterStatus").textContent = "Belum disahkan";
  $("#meterStatus").classList.remove("ok");
  const activeMode = $(".mode-button.active").dataset.mode;
  $(`#${activeMode}Mode`).classList.add("active");
}

function clearImage() {
  if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
  state.imageUrl = null;
  state.imageFile = null;
  meterImage.value = "";
  $("#meterPreview").removeAttribute("src");
}

function closeModal(clear = true) {
  ocrModal.hidden = true;
  document.body.style.overflow = "";
  $(".preview-frame").classList.remove("scanning");
  if (clear) clearImage();
}

async function loadTesseract() {
  if (window.Tesseract) return window.Tesseract;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Modul OCR tidak dapat dimuatkan. Cuba isi secara manual."));
    document.head.appendChild(script);
  });
  return window.Tesseract;
}

async function createOcrVariants(file) {
  const bitmap = await createImageBitmap(file);
  const longestSide = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(2.2, Math.max(1, 1900 / longestSide));
  const sourceWidth = Math.round(bitmap.width * scale);
  const sourceHeight = Math.round(bitmap.height * scale);
  const rotations = [90, 270, 0, 180];
  const fullImages = rotations.map((degrees) => {
    const sideways = degrees === 90 || degrees === 270;
    const canvas = document.createElement("canvas");
    canvas.width = sideways ? sourceHeight : sourceWidth;
    canvas.height = sideways ? sourceWidth : sourceHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.save();
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate((degrees * Math.PI) / 180);
    context.filter = "grayscale(1) contrast(1.8) brightness(1.08)";
    context.drawImage(bitmap, -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);
    context.restore();
    return { canvas, degrees, psm: "11", label: `${degrees}° penuh` };
  });
  bitmap.close();

  const bands = fullImages
    .filter(({ degrees }) => degrees === 90 || degrees === 270)
    .flatMap(({ canvas, degrees }) => {
      const cropY = Math.round(canvas.height * 0.18);
      const cropHeight = Math.round(canvas.height * 0.64);
      const band = document.createElement("canvas");
      band.width = canvas.width;
      band.height = cropHeight;
      const bandContext = band.getContext("2d", { willReadFrequently: true });
      bandContext.filter = "grayscale(1) contrast(2.5) brightness(1.08)";
      bandContext.drawImage(canvas, 0, cropY, canvas.width, cropHeight, 0, 0, band.width, band.height);

      const threshold = document.createElement("canvas");
      threshold.width = band.width;
      threshold.height = band.height;
      const thresholdContext = threshold.getContext("2d", { willReadFrequently: true });
      thresholdContext.drawImage(band, 0, 0);
      const imageData = thresholdContext.getImageData(0, 0, threshold.width, threshold.height);
      const pixels = imageData.data;
      for (let index = 0; index < pixels.length; index += 4) {
        const luminance = pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114;
        const value = luminance > 168 ? 0 : 255;
        pixels[index] = value;
        pixels[index + 1] = value;
        pixels[index + 2] = value;
      }
      thresholdContext.putImageData(imageData, 0, 0);
      return [
        { canvas: band, degrees, psm: "7", label: `${degrees}° jalur` },
        { canvas: threshold, degrees, psm: "7", label: `${degrees}° jalur jelas` }
      ];
    });

  return [...bands, ...fullImages];
}

function meterPrefixFromOcr(value) {
  if (value.length < 5) return "";
  const prefixes = [
    { name: "SAINS", patterns: [/[S5]/, /[A4]/, /[I1L]/, /[NM]/, /[S5]/] },
    { name: "JBANS", patterns: [/[J1I]/, /[B8]/, /[A4]/, /[NM]/, /[S5]/] }
  ];
  const exact = prefixes.find(({ name }) => value.startsWith(name));
  if (exact) return exact.name;
  return prefixes.find(({ patterns }) => patterns.every((pattern, index) => pattern.test(value[index])))?.name || "";
}

function extractMeterNumber(text) {
  const lines = String(text || "")
    .toUpperCase()
    .split(/\r?\n/)
    .map((line) => line.replace(/[^A-Z0-9]/g, ""))
    .filter(Boolean);
  const joined = lines.join("");
  const sources = [...lines, joined];
  const candidates = [];

  for (const source of sources) {
    for (let index = 0; index <= source.length - 5; index += 1) {
      const rest = source.slice(index);
      const prefix = meterPrefixFromOcr(rest);
      if (!prefix) continue;
      const exact = rest.startsWith(prefix);
      const corrected = `${prefix}${rest.slice(5)}`;
      const match = corrected.match(/^(?:SAINS|JBANS)[A-Z]{0,5}\d{4,12}/) || corrected.match(/^(?:SAINS|JBANS)[A-Z0-9]{4,20}/);
      if (!match) continue;
      const value = match[0].slice(0, 30);
      const digitCount = (value.match(/\d/g) || []).length;
      candidates.push({ value, score: (exact ? 100 : 70) + digitCount * 3 - Math.abs(value.length - 12) });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.value.length - b.value.length);
  return candidates[0]?.value || "";
}

async function runOcr() {
  if (!state.imageFile) return;
  const button = $("#runOcr");
  button.disabled = true;
  button.textContent = "Sedang membaca…";
  $(".preview-frame").classList.add("scanning");
  $("#ocrMessage").textContent = "OCR sedang mencari corak nombor pada imej. Ini mungkin mengambil beberapa saat.";
  try {
    const Tesseract = await loadTesseract();
    const variants = await createOcrVariants(state.imageFile);
    const worker = await Tesseract.createWorker("eng", 1, {
      logger: (progress) => {
        if (progress.status === "recognizing text") {
          button.textContent = `Membaca ${Math.round(progress.progress * 100)}%`;
        }
      }
    });
    await worker.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      tessedit_pageseg_mode: "11",
      preserve_interword_spaces: "1"
    });

    let meter = "";
    try {
      for (let index = 0; index < variants.length; index += 1) {
        button.textContent = `Mencuba bacaan ${index + 1}/${variants.length}…`;
        await worker.setParameters({ tessedit_pageseg_mode: variants[index].psm });
        const result = await worker.recognize(variants[index].canvas);
        meter = extractMeterNumber(result.data.text);
        if (meter) break;
      }
    } finally {
      await worker.terminate();
      variants.forEach(({ canvas }) => { canvas.width = 1; canvas.height = 1; });
    }

    $("#ocrResult").value = meter;
    $("#ocrResultWrap").hidden = false;
    $("#confirmOcr").hidden = false;
    button.hidden = true;
    $("#ocrMessage").textContent = meter
      ? "Adakah nombor ini sama seperti yang tertera pada meter?"
      : "OCR belum dapat membaca nombor penuh. Taip nombor penuh bermula dengan SAINS atau JBANS berdasarkan meter.";
  } catch (error) {
    showToast(error.message, "error");
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
  const data = {
    area: areaSelect.value,
    meter: $("#meterValue").value,
    coordinates: $("#coordinates").value.trim(),
    turnstileToken: state.turnstileToken
  };
  if (!data.area || !data.meter || !data.coordinates) {
    return showToast("Lengkapkan kawasan, nombor meter dan koordinat.", "error");
  }
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
    await loadStats();
    if (state.widgetId !== null && window.turnstile) window.turnstile.reset(state.widgetId);
    state.turnstileToken = "";
    showToast("Rekod berjaya disimpan.");
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
    state.imageFile = selectedFile;
    state.imageUrl = URL.createObjectURL(state.imageFile);
    $("#meterPreview").src = state.imageUrl;
    $("#ocrResultWrap").hidden = true;
    $("#confirmOcr").hidden = true;
    $("#runOcr").hidden = false;
    $("#ocrMessage").textContent = "Pastikan nombor dalam gambar kelihatan jelas sebelum bacaan dimulakan.";
    ocrModal.hidden = false;
    document.body.style.overflow = "hidden";
  });
  $("#runOcr").addEventListener("click", runOcr);
  $("#confirmOcr").addEventListener("click", () => {
    const value = $("#ocrResult").value;
    if (!value.trim()) return showToast("Nombor meter masih kosong.", "error");
    setConfirmedMeter(value);
    closeModal(false);
    showToast("Nombor meter disahkan. Gambar telah dipadam.");
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
