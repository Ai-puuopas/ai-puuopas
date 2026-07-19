(function () {
  "use strict";

  const WORKER_ORIGIN = ["localhost", "127.0.0.1"].includes(location.hostname)
    ? location.origin
    : "https://ai-puuopas.jukipuu-fi.workers.dev";
  const API_URL = `${WORKER_ORIGIN}/api/ask`;
  const ASSESSMENT_LOGIN_URL = `${WORKER_ORIGIN}/api/assessment-login`;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
  const MAX_IMAGE_EDGE = 1600;
  const SUPPORTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
  const STORAGE_KEY = "puuopasConversationId";
  const TREE_SLOTS = [
    {
      title: "1. Lehti tai silmu",
      help: "Kuvaa yksi lehti suoraan tai silmu oksassa mahdollisimman tarkasti",
    },
    {
      title: "2. Runko",
      help: "Kuvaa kaarna rinnan korkeudelta niin, että rungon reunat hieman näkyvät",
    },
    {
      title: "3. Yleiskuva",
      help: "Siirry kauemmas ja kuvaa lopuksi koko puu sekä latvus",
    },
  ];

  const form = document.querySelector(".search-card");
  const input = document.querySelector("#question");
  const answerPanel = document.querySelector("#answerPanel");
  const answerText = document.querySelector("#answerText");

  if (!form || !input || !answerPanel || !answerText) return;

  const submitButton = form.querySelector('button[type="submit"], button');
  const searchRow = form.querySelector(".search-row") || form;
  let pendingImage = null;
  let requestInProgress = false;
  let loadingTimer = null;
  const treeImages = [null, null, null];
  const assessmentImages = [null, null, null, null];
  let assessmentAccessToken = "";

  const styles = document.createElement("style");
  styles.textContent = `
    .puuopas-attach-button {
      align-items: center; background: #eef5ef; border: 1px solid #b8cdbd;
      border-radius: 10px; color: #244b2d; cursor: pointer; display: inline-flex;
      font-size: 1.25rem; justify-content: center; min-height: 44px; min-width: 44px;
    }
    .puuopas-image-preview {
      align-items: center; background: #f5f8f5; border: 1px solid #cbd9ce;
      border-radius: 12px; display: none; gap: 12px; margin-top: 12px;
      padding: 10px 12px;
    }
    .puuopas-image-preview img {
      border-radius: 8px; height: 72px; object-fit: cover; width: 72px;
    }
    .puuopas-image-preview span { flex: 1; font-size: .9rem; }
    .puuopas-image-remove {
      background: transparent; border: 0; color: #8b2525; cursor: pointer;
      font: inherit; padding: 8px;
    }
    .puuopas-paste-help { color: #53655a; font-size: .86rem; margin: 8px 0 0; }
    .puuopas-tree-card { cursor: pointer; }
    .puuopas-tree-card:focus-visible { outline: 3px solid #4e7a57; outline-offset: 3px; }
    .puuopas-tree-panel {
      background: #f7faf7; border: 1px solid #bfd0c2; border-radius: 16px;
      display: none; margin: 18px 0; padding: 20px;
    }
    .puuopas-tree-panel.is-open { display: block; }
    .puuopas-tree-panel h2 { margin: 0 0 6px; }
    .puuopas-tree-intro { color: #53655a; margin: 0 0 16px; }
    .puuopas-tree-slots {
      display: grid; gap: 12px; grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .puuopas-tree-slot {
      background: white; border: 2px dashed #9bb5a0; border-radius: 14px;
      color: #244b2d; cursor: pointer; min-height: 190px; padding: 12px;
      position: relative; text-align: center;
    }
    .puuopas-tree-slot:focus-visible { outline: 3px solid #4e7a57; outline-offset: 2px; }
    .puuopas-tree-slot strong, .puuopas-tree-slot small { display: block; }
    .puuopas-tree-slot small { color: #65756a; margin-top: 5px; }
    .puuopas-tree-slot img {
      border-radius: 9px; display: none; height: 112px; margin: 8px auto 0;
      object-fit: cover; width: 100%;
    }
    .puuopas-tree-slot.has-image img { display: block; }
    .puuopas-tree-slot.has-image .puuopas-slot-prompt { display: none; }
    .puuopas-tree-remove {
      background: #fff; border: 1px solid #c6d3c8; border-radius: 7px;
      color: #8b2525; display: none; margin: 8px auto 0; padding: 5px 9px;
    }
    .puuopas-tree-slot.has-image .puuopas-tree-remove { display: block; }
    .puuopas-tree-actions { align-items: center; display: flex; gap: 12px; margin-top: 16px; }
    .puuopas-tree-submit {
      background: #2f633b; border: 0; border-radius: 10px; color: white;
      cursor: pointer; font: inherit; font-weight: 700; padding: 12px 18px;
    }
    .puuopas-tree-submit:disabled { cursor: not-allowed; opacity: .55; }
    .puuopas-tree-status { color: #53655a; font-size: .9rem; }
    .puuopas-assessment-card { cursor: pointer; }
    .puuopas-assessment-card:focus-visible { outline: 3px solid #4e7a57; outline-offset: 3px; }
    .puuopas-assessment-panel {
      background: #f7faf7; border: 1px solid #bfd0c2; border-radius: 16px;
      display: none; margin: 18px 0; padding: 22px; text-align: left;
    }
    .puuopas-assessment-panel.is-open { display: block; }
    .puuopas-assessment-panel h2 { margin: 0 0 6px; }
    .puuopas-assessment-gate {
      background: #fff; border: 1px solid #d7e3d9; border-radius: 14px;
      display: grid; gap: 10px; margin-top: 14px; max-width: 520px; padding: 18px;
    }
    .puuopas-assessment-gate h3, .puuopas-assessment-gate p { margin: 0; }
    .puuopas-assessment-gate label { color: #344b39; font-size: .92rem; font-weight: 700; }
    .puuopas-assessment-gate input {
      border: 1px solid #bfcfc2; border-radius: 9px; font: inherit;
      margin-top: 6px; padding: 10px 12px; width: 100%;
    }
    .puuopas-assessment-login {
      background: #2f633b; border: 0; border-radius: 9px; color: #fff;
      cursor: pointer; font: inherit; font-weight: 700; justify-self: start;
      padding: 10px 16px;
    }
    .puuopas-assessment-login:disabled { cursor: wait; opacity: .65; }
    .puuopas-assessment-login-status { color: #53655a; font-size: .9rem; }
    .puuopas-assessment-login-status.is-error { color: #8b2525; }
    .puuopas-assessment-form { display: none; }
    .puuopas-assessment-panel.is-unlocked .puuopas-assessment-gate { display: none; }
    .puuopas-assessment-panel.is-unlocked .puuopas-assessment-form { display: block; }
    .puuopas-assessment-intro { color: #53655a; margin: 0 0 18px; }
    .puuopas-assessment-section {
      background: #fff; border: 1px solid #d7e3d9; border-radius: 14px;
      margin-top: 14px; padding: 18px;
    }
    .puuopas-assessment-section h3 { margin: 0 0 12px; }
    .puuopas-assessment-grid {
      display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .puuopas-assessment-field { display: grid; gap: 6px; }
    .puuopas-assessment-field.is-wide { grid-column: 1 / -1; }
    .puuopas-assessment-field label { color: #344b39; font-size: .92rem; font-weight: 700; }
    .puuopas-assessment-field input,
    .puuopas-assessment-field textarea {
      border: 1px solid #bfcfc2; border-radius: 9px; font: inherit;
      padding: 10px 12px; width: 100%;
    }
    .puuopas-assessment-field textarea { min-height: 92px; resize: vertical; }
    .puuopas-location-box {
      background: #f3f8f4; border: 1px solid #c7d8ca; border-radius: 11px;
      display: grid; gap: 8px; padding: 12px;
    }
    .puuopas-location-button {
      background: #2f633b; border: 0; border-radius: 9px; color: #fff;
      cursor: pointer; font: inherit; font-weight: 700; justify-self: start;
      padding: 10px 14px;
    }
    .puuopas-location-button:disabled { cursor: wait; opacity: .65; }
    .puuopas-location-status { color: #53655a; font-size: .88rem; line-height: 1.4; }
    .puuopas-location-status.is-success { color: #245a30; font-weight: 700; }
    .puuopas-location-status.is-error { color: #8b2525; }
    .puuopas-assessment-photo {
      background: #f7faf7; border: 2px dashed #9bb5a0; border-radius: 12px;
      color: #244b2d; cursor: pointer; display: grid; min-height: 150px;
      place-items: center; padding: 12px; text-align: center;
    }
    .puuopas-assessment-photo.is-cover { min-height: 300px; }
    .puuopas-assessment-photo:focus-visible { outline: 3px solid #4e7a57; outline-offset: 2px; }
    .puuopas-assessment-photo img {
      border-radius: 9px; display: none; max-height: 360px; object-fit: contain;
      width: 100%;
    }
    .puuopas-assessment-photo.has-image img { display: block; }
    .puuopas-assessment-photo.has-image .puuopas-assessment-photo-prompt { display: none; }
    .puuopas-assessment-photo-remove {
      background: #fff; border: 1px solid #c6d3c8; border-radius: 7px;
      color: #8b2525; display: none; margin-top: 8px; padding: 5px 9px;
    }
    .puuopas-assessment-photo.has-image .puuopas-assessment-photo-remove { display: inline-block; }
    .puuopas-assessment-actions { align-items: center; display: flex; gap: 12px; margin-top: 16px; }
    .puuopas-assessment-submit, .puuopas-report-print {
      background: #2f633b; border: 0; border-radius: 10px; color: #fff;
      cursor: pointer; font: inherit; font-weight: 700; padding: 12px 18px;
    }
    .puuopas-assessment-submit:disabled { cursor: not-allowed; opacity: .55; }
    .puuopas-assessment-status { color: #53655a; font-size: .9rem; }
    .puuopas-assessment-report {
      background: #fff; border: 1px solid #bfd0c2; border-radius: 16px;
      display: none; margin: 20px 0; overflow: hidden; text-align: left;
    }
    .puuopas-assessment-report.is-visible { display: block; }
    .puuopas-report-cover {
      align-content: start; display: grid; min-height: 760px; padding: 38px;
    }
    .puuopas-report-cover h2 { font-size: 2rem; margin: 0 0 4px; }
    .puuopas-report-cover p { color: #53655a; margin: 3px 0; }
    .puuopas-report-cover img {
      border-radius: 8px; height: 560px; margin-top: 24px; object-fit: contain;
      width: 100%;
    }
    .puuopas-report-body { border-top: 1px solid #d7e3d9; padding: 32px 38px; }
    .puuopas-report-body pre { font: inherit; line-height: 1.55; white-space: pre-wrap; }
    .puuopas-report-disclaimer {
      background: #fff7df; border-left: 4px solid #d1a83a; margin-top: 22px;
      padding: 12px 14px;
    }
    .puuopas-report-actions { padding: 0 38px 32px; }
    .puuopas-loading {
      align-items: center; display: grid; gap: 12px; grid-template-columns: auto 1fr;
    }
    .puuopas-loading-spinner {
      animation: puuopas-spin 1s linear infinite; color: #2f633b;
      display: inline-block; font-size: 1.8rem; line-height: 1;
    }
    .puuopas-loading-phase { display: block; }
    .puuopas-loading-time {
      color: #2f633b; font-variant-numeric: tabular-nums; font-weight: 700;
      margin-top: 4px;
    }
    .puuopas-loading-note { color: #53655a; font-size: .92rem; margin-top: 5px; }
    @keyframes puuopas-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .puuopas-loading-spinner { animation: none; }
    }
    @media (max-width: 720px) {
      .puuopas-tree-slots { grid-template-columns: 1fr; }
      .puuopas-tree-slot { min-height: 150px; }
      .puuopas-assessment-grid { grid-template-columns: 1fr; }
      .puuopas-assessment-field.is-wide { grid-column: auto; }
      .puuopas-report-cover { min-height: auto; padding: 24px; }
      .puuopas-report-cover img { height: auto; max-height: 520px; }
      .puuopas-report-body, .puuopas-report-actions { padding-left: 24px; padding-right: 24px; }
    }
    @media print {
      body * { visibility: hidden !important; }
      .puuopas-assessment-report, .puuopas-assessment-report * { visibility: visible !important; }
      .puuopas-assessment-report {
        border: 0; display: block !important; left: 0; margin: 0; position: absolute;
        top: 0; width: 100%;
      }
      .puuopas-report-cover { break-after: page; min-height: 100vh; }
      .puuopas-report-actions { display: none; }
    }
  `;
  document.head.appendChild(styles);

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/jpeg,image/png,image/webp";
  fileInput.hidden = true;

  const attachButton = document.createElement("button");
  attachButton.type = "button";
  attachButton.className = "puuopas-attach-button";
  attachButton.setAttribute("aria-label", "Liitä kuva");
  attachButton.title = "Liitä kuva tai liitä se leikepöydältä";
  attachButton.textContent = "📷";

  const preview = document.createElement("div");
  preview.className = "puuopas-image-preview";
  preview.innerHTML =
    '<img alt="Liitetyn kuvan esikatselu">' +
    '<span>Kuva on mukana tunnistusta varten.</span>' +
    '<button type="button" class="puuopas-image-remove" aria-label="Poista kuva">Poista</button>';

  const help = document.createElement("p");
  help.className = "puuopas-paste-help";
  help.textContent = "Voit liittää kuvan kenttään myös paste-komennolla (Ctrl/⌘ + V).";

  searchRow.insertBefore(attachButton, submitButton || null);
  form.appendChild(fileInput);
  searchRow.insertAdjacentElement("afterend", preview);
  preview.insertAdjacentElement("afterend", help);

  function stopLoading() {
    if (loadingTimer) {
      clearInterval(loadingTimer);
      loadingTimer = null;
    }
  }

  function formatElapsed(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
  }

  function startLoading(initialPhase) {
    stopLoading();
    answerPanel.style.display = "block";
    answerText.innerHTML =
      '<div class="puuopas-loading" role="status" aria-live="polite">' +
        '<span class="puuopas-loading-spinner" aria-hidden="true">↻</span>' +
        '<div><strong class="puuopas-loading-phase"></strong>' +
          '<div class="puuopas-loading-time"></div>' +
          '<div class="puuopas-loading-note">Tietojen haku ja tarkistus voi kestää noin 1–1,5 minuuttia.</div>' +
        '</div>' +
      '</div>';

    const startedAt = Date.now();
    const phase = answerText.querySelector(".puuopas-loading-phase");
    const elapsed = answerText.querySelector(".puuopas-loading-time");

    function updateLoading() {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      if (seconds < 15) {
        phase.textContent = initialPhase;
      } else if (seconds < 45) {
        phase.textContent = "Tarkistan tuntomerkkejä ja tietoja...";
      } else if (seconds < 75) {
        phase.textContent = "Varmistan vastausta...";
      } else {
        phase.textContent = "Tarkistus jatkuu – järjestelmä työskentelee edelleen...";
      }
      elapsed.textContent = `⏱ Kulunut aika ${formatElapsed(seconds)}`;
    }

    updateLoading();
    loadingTimer = setInterval(updateLoading, 1000);
    return stopLoading;
  }

  function showMessage(message) {
    stopLoading();
    answerPanel.style.display = "block";
    answerText.textContent = message;
  }

  function clearImage() {
    pendingImage = null;
    fileInput.value = "";
    preview.style.display = "none";
    preview.querySelector("img").removeAttribute("src");
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Kuvaa ei voitu lukea."));
      };
      image.src = objectUrl;
    });
  }

  function dataUrlSize(dataUrl) {
    const base64 = dataUrl.split(",")[1] || "";
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
  }

  async function prepareImage(file) {
    if (!SUPPORTED_TYPES.has(file.type)) {
      throw new Error("Käytä JPG-, PNG- tai WebP-kuvaa.");
    }

    const image = await loadImage(file);
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);

    let mimeType = file.type === "image/png" ? "image/png" : "image/jpeg";
    let dataUrl = canvas.toDataURL(mimeType, 0.86);

    if (dataUrlSize(dataUrl) > MAX_IMAGE_BYTES && mimeType === "image/png") {
      mimeType = "image/jpeg";
      dataUrl = canvas.toDataURL(mimeType, 0.82);
    }

    if (dataUrlSize(dataUrl) > MAX_IMAGE_BYTES) {
      throw new Error("Kuva on liian suuri. Valitse enintään 5 Mt:n kuva.");
    }

    return { dataUrl, mimeType };
  }

  async function useImage(file) {
    try {
      showMessage("📷 Valmistelen kuvaa...");
      pendingImage = await prepareImage(file);
      preview.querySelector("img").src = pendingImage.dataUrl;
      preview.style.display = "flex";
      answerPanel.style.display = "none";
      input.focus();
    } catch (error) {
      clearImage();
      showMessage("❌ " + (error.message || "Kuvaa ei voitu liittää."));
    }
  }

  function getConversationId() {
    let id = localStorage.getItem(STORAGE_KEY) || "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      id = crypto.randomUUID ? crypto.randomUUID() :
        "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
          const random = Math.floor(Math.random() * 16);
          return (character === "x" ? random : (random & 3) | 8).toString(16);
        });
      localStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  }

  async function askApi(payload) {
    const response = await fetch(API_URL, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, conversationId: getConversationId() }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.answer || data.error || "API ei vastannut oikein");
    if (data.conversationId) localStorage.setItem(STORAGE_KEY, data.conversationId);
    return data;
  }

  attachButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files[0]) useImage(fileInput.files[0]);
  });
  preview.querySelector(".puuopas-image-remove").addEventListener("click", clearImage);

  input.addEventListener("paste", (event) => {
    const imageFile = Array.from(event.clipboardData?.files || [])
      .find((file) => file.type.startsWith("image/"));
    if (!imageFile) return;
    event.preventDefault();
    useImage(imageFile);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();

    const question = input.value.trim();
    if ((!question && !pendingImage) || requestInProgress) return;

    requestInProgress = true;
    const finishLoading = startLoading(
      pendingImage ? "Tunnistan kuvaa..." : "Haen ja tarkistan tietoja...",
    );
    submitButton.disabled = true;
    input.disabled = true;
    attachButton.disabled = true;

    try {
      const data = await askApi({ question, image: pendingImage });
      finishLoading();
      answerText.textContent = data.answer || "En saanut muodostettua vastausta.";
      clearImage();
    } catch (error) {
      console.error(error);
      finishLoading();
      answerText.textContent = "❌ " +
        (error.message || "AI-puuopas ei saanut vastausta juuri nyt. Kokeile hetken kuluttua uudelleen.");
    } finally {
      finishLoading();
      requestInProgress = false;
      submitButton.disabled = false;
      input.disabled = false;
      attachButton.disabled = false;
      input.focus();
    }
  }, true);

  function findTreeCard() {
    return Array.from(document.querySelectorAll(".card"))
      .find((card) => card.querySelector("h2")?.textContent.trim() === "Tunnista puu");
  }

  function findAssessmentCard() {
    return Array.from(document.querySelectorAll(".card"))
      .find((card) => card.querySelector("h2")?.textContent.trim() === "Tee kuntoarvio");
  }

  function buildAssessmentPrompt(panel) {
    const value = (name) => panel.querySelector(`[name="${name}"]`)?.value.trim() || "Ei ilmoitettu";
    return [
      "Laadi näistä tiedoista ja kuvista alustava puun kuntoarvion raakaversio.",
      "Älä keksi mittauksia tai havaintoja. Kerro puuttuvat ja epävarmat tiedot.",
      "",
      `Arviointipäivä: ${value("assessmentDate")}`,
      `Puulaji: ${value("species")}`,
      `Tieteellinen nimi: ${value("scientificName")}`,
      `Sijainti: ${value("location")}`,
      `GPS-koordinaatit (WGS84): ${value("latitude")}, ${value("longitude")}`,
      `GPS-mittauksen arvioitu tarkkuus: ${value("locationAccuracy")}`,
      `Arvioinnin tarkoitus ja lähtötilanne: ${value("purpose")}`,
      `Arvioitu ikä: ${value("age")}`,
      `Korkeus: ${value("height")}`,
      `Latvuksen leveys: ${value("crownWidth")}`,
      `Rungon ympärysmitta: ${value("circumference")}`,
      `Käytetyt tutkimusvälineet: ${value("tools")}`,
      `Mahdolliset vauriokohteet ja ympäristön kohteet: ${value("targets")}`,
      `Tyvi ja ympäristö – käyttäjän havainnot: ${value("rootNotes")}`,
      `Runko ja haaraliitokset – käyttäjän havainnot: ${value("trunkNotes")}`,
      `Latvus – käyttäjän havainnot: ${value("crownNotes")}`,
    ].join("\n").slice(0, 4000);
  }

  function renderAssessmentReport(panel, answer) {
    const report = document.querySelector(".puuopas-assessment-report");
    const cover = report.querySelector(".puuopas-report-cover");
    const value = (name) => panel.querySelector(`[name="${name}"]`)?.value.trim() || "Ei ilmoitettu";
    cover.textContent = "";

    const title = document.createElement("h2");
    title.textContent = "Puun kuntoarvio – raakaversio";
    const species = document.createElement("h3");
    species.textContent = value("species") +
      (value("scientificName") === "Ei ilmoitettu" ? "" : ` (${value("scientificName")})`);
    const date = document.createElement("p");
    date.textContent = `Arviointipäivä: ${value("assessmentDate")}`;
    const location = document.createElement("p");
    location.textContent = `Sijainti: ${value("location")}`;
    const coordinates = document.createElement("p");
    coordinates.textContent = value("latitude") === "Ei ilmoitettu"
      ? "GPS-sijainti: Ei ilmoitettu"
      : `GPS-sijainti: ${value("latitude")}, ${value("longitude")} (tarkkuus noin ${value("locationAccuracy")})`;
    const image = document.createElement("img");
    image.src = assessmentImages[0].dataUrl;
    image.alt = "Puun yleiskuva kuntoarvion kansisivulla";
    cover.append(title, species, date, location, coordinates, image);

    report.querySelector(".puuopas-report-draft").textContent = answer;
    report.classList.add("is-visible");
    report.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function buildConditionAssessment() {
    const card = findAssessmentCard();
    const cards = card?.closest(".cards");
    if (!card || !cards) return;

    card.classList.add("puuopas-assessment-card");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-expanded", "false");
    card.setAttribute("aria-controls", "puuopasAssessmentPanel");

    const panel = document.createElement("section");
    panel.id = "puuopasAssessmentPanel";
    panel.className = "puuopas-assessment-panel";
    panel.setAttribute("aria-labelledby", "puuopasAssessmentTitle");
    panel.innerHTML =
      '<h2 id="puuopasAssessmentTitle">Puun kuntoarvion raakaversio</h2>' +
      '<p class="puuopas-assessment-intro">Pohja perustuu JuKiPuun kuntoarvion rakenteeseen. Aloita puun yleiskuvasta ja täytä tiedot, jotka ovat varmasti tiedossa.</p>' +
      '<form class="puuopas-assessment-gate">' +
        '<h3>🔒 Kuntoarvion testikäyttö</h3>' +
        '<p>Syötä kuntoarvion salasana. Salasanaa ei tallenneta selaimeen.</p>' +
        '<label>Salasana<input type="password" name="assessmentPassword" autocomplete="current-password" required></label>' +
        '<button type="submit" class="puuopas-assessment-login">Avaa kuntoarvio</button>' +
        '<span class="puuopas-assessment-login-status" role="status" aria-live="polite"></span>' +
      '</form>' +
      '<form class="puuopas-assessment-form">' +
        '<section class="puuopas-assessment-section"><h3>1. Kansisivu ja yleiskuva</h3>' +
          '<div class="puuopas-assessment-photo is-cover" data-assessment-photo="0" tabindex="0" role="button" aria-label="Lisää puun yleiskuva">' +
            '<div class="puuopas-assessment-photo-prompt"><strong>Lisää puun yleiskuva *</strong><br><small>Koko puu, latvus ja kasvuympäristö</small><br><small>Valitse tai paste (Ctrl/⌘ + V)</small></div>' +
            '<img alt="Puun yleiskuvan esikatselu"><button type="button" class="puuopas-assessment-photo-remove">Poista</button>' +
          '</div>' +
          '<div class="puuopas-assessment-grid" style="margin-top:14px">' +
            '<div class="puuopas-assessment-field"><label>Arviointipäivä<input type="date" name="assessmentDate" required></label></div>' +
            '<div class="puuopas-assessment-field"><label>Puulaji<input name="species" placeholder="Esim. vaahtera"></label></div>' +
            '<div class="puuopas-assessment-field"><label>Tieteellinen nimi<input name="scientificName" placeholder="Esim. Acer platanoides"></label></div>' +
            '<div class="puuopas-assessment-field"><label>Sijainti<input name="location" placeholder="Osoite tai kohteen kuvaus"></label></div>' +
            '<div class="puuopas-assessment-field is-wide"><div class="puuopas-location-box">' +
              '<button type="button" class="puuopas-location-button">📍 Hae nykyinen sijainti</button>' +
              '<span class="puuopas-location-status" role="status" aria-live="polite">Sijaintia ei lueta automaattisesti. Puhelin kysyy luvan vasta painikkeesta.</span>' +
              '<input type="hidden" name="latitude"><input type="hidden" name="longitude"><input type="hidden" name="locationAccuracy">' +
            '</div></div>' +
          '</div></section>' +
        '<section class="puuopas-assessment-section"><h3>2. Lähtötilanne ja kohdetiedot</h3><div class="puuopas-assessment-grid">' +
          '<div class="puuopas-assessment-field is-wide"><label>Arvioinnin tarkoitus ja lähtötilanne<textarea name="purpose" placeholder="Miksi arvio tehdään ja mitä kohteesta tiedetään?"></textarea></label></div>' +
          '<div class="puuopas-assessment-field"><label>Arvioitu ikä<input name="age" placeholder="Esim. 90–120 vuotta"></label></div>' +
          '<div class="puuopas-assessment-field"><label>Korkeus<input name="height" placeholder="Esim. 22 m"></label></div>' +
          '<div class="puuopas-assessment-field"><label>Latvuksen leveys<input name="crownWidth" placeholder="Esim. 18 m"></label></div>' +
          '<div class="puuopas-assessment-field"><label>Rungon ympärysmitta<input name="circumference" placeholder="Mittauskorkeus ja tulos"></label></div>' +
          '<div class="puuopas-assessment-field is-wide"><label>Käytetyt tutkimusvälineet<input name="tools" placeholder="Esim. silmämääräinen tarkastus ja mittanauha"></label></div>' +
          '<div class="puuopas-assessment-field is-wide"><label>Ympäristön kohteet ja mahdolliset vauriokohteet<textarea name="targets" placeholder="Rakennukset, kulkuväylät, leikkipaikat, ajoneuvot..."></textarea></label></div>' +
        '</div></section>' +
        '<section class="puuopas-assessment-section"><h3>3. Tyvi ja ympäristö</h3><div class="puuopas-assessment-photo" data-assessment-photo="1" tabindex="0" role="button" aria-label="Lisää kuva tyvestä ja ympäristöstä"><div class="puuopas-assessment-photo-prompt"><strong>Tyven ja ympäristön kuva</strong><br><small>Valinnainen</small></div><img alt="Tyven ja ympäristön esikatselu"><button type="button" class="puuopas-assessment-photo-remove">Poista</button></div><div class="puuopas-assessment-field" style="margin-top:12px"><label>Omat havainnot<textarea name="rootNotes" placeholder="Juurenniska, maanpinta, halkeamat, käävät, vauriot..."></textarea></label></div></section>' +
        '<section class="puuopas-assessment-section"><h3>4. Runko ja haaraliitokset</h3><div class="puuopas-assessment-photo" data-assessment-photo="2" tabindex="0" role="button" aria-label="Lisää kuva rungosta"><div class="puuopas-assessment-photo-prompt"><strong>Rungon ja haaraliitosten kuva</strong><br><small>Valinnainen</small></div><img alt="Rungon esikatselu"><button type="button" class="puuopas-assessment-photo-remove">Poista</button></div><div class="puuopas-assessment-field" style="margin-top:12px"><label>Omat havainnot<textarea name="trunkNotes" placeholder="Haarautuminen, halkeamat, ontelot, nestevuodot, lahottajat..."></textarea></label></div></section>' +
        '<section class="puuopas-assessment-section"><h3>5. Latvus</h3><div class="puuopas-assessment-photo" data-assessment-photo="3" tabindex="0" role="button" aria-label="Lisää kuva latvuksesta"><div class="puuopas-assessment-photo-prompt"><strong>Latvuksen kuva</strong><br><small>Valinnainen</small></div><img alt="Latvuksen esikatselu"><button type="button" class="puuopas-assessment-photo-remove">Poista</button></div><div class="puuopas-assessment-field" style="margin-top:12px"><label>Omat havainnot<textarea name="crownNotes" placeholder="Elinvoima, kuolleet oksat, epätasapaino, aikaisemmat leikkaukset..."></textarea></label></div></section>' +
        '<div class="puuopas-assessment-actions"><button type="submit" class="puuopas-assessment-submit" disabled>Luo kuntoarvion raakaversio</button><span class="puuopas-assessment-status" aria-live="polite">Yleiskuva puuttuu</span></div>' +
      '</form>';
    cards.insertAdjacentElement("afterend", panel);

    const report = document.createElement("section");
    report.className = "puuopas-assessment-report";
    report.innerHTML =
      '<div class="puuopas-report-cover"></div>' +
      '<div class="puuopas-report-body"><h2>Kuntoarvion luonnos</h2><pre class="puuopas-report-draft"></pre>' +
        '<div class="puuopas-report-disclaimer"><strong>Rajaus:</strong> Tämä on kuvien ja annettujen tietojen perusteella laadittu alustava luonnos. Se ei korvaa paikan päällä tehtävää arboristin kuntoarviota.</div></div>' +
      '<div class="puuopas-report-actions"><button type="button" class="puuopas-report-print">Tulosta tai tallenna PDF</button></div>';
    panel.insertAdjacentElement("afterend", report);

    const assessmentForm = panel.querySelector(".puuopas-assessment-form");
    const assessmentGate = panel.querySelector(".puuopas-assessment-gate");
    const assessmentPassword = panel.querySelector('[name="assessmentPassword"]');
    const assessmentLogin = panel.querySelector(".puuopas-assessment-login");
    const assessmentLoginStatus = panel.querySelector(".puuopas-assessment-login-status");
    const assessmentSubmit = panel.querySelector(".puuopas-assessment-submit");
    const assessmentStatus = panel.querySelector(".puuopas-assessment-status");
    const locationButton = panel.querySelector(".puuopas-location-button");
    const locationStatus = panel.querySelector(".puuopas-location-status");
    panel.querySelector('[name="assessmentDate"]').value = new Date().toISOString().slice(0, 10);

    assessmentGate.addEventListener("submit", async (event) => {
      event.preventDefault();
      assessmentLogin.disabled = true;
      assessmentPassword.disabled = true;
      assessmentLoginStatus.className = "puuopas-assessment-login-status";
      assessmentLoginStatus.textContent = "Tarkistan salasanaa…";
      try {
        const response = await fetch(ASSESSMENT_LOGIN_URL, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: assessmentPassword.value }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data?.token) throw new Error(data.error || "Salasanaa ei voitu tarkistaa.");
        assessmentAccessToken = data.token;
        assessmentPassword.value = "";
        panel.classList.add("is-unlocked");
        panel.querySelector('[data-assessment-photo="0"]').focus();
      } catch (error) {
        assessmentLoginStatus.textContent = error.message || "Salasana ei ole oikein.";
        assessmentLoginStatus.classList.add("is-error");
      } finally {
        assessmentLogin.disabled = false;
        assessmentPassword.disabled = false;
      }
    });

    locationButton.addEventListener("click", () => {
      locationStatus.className = "puuopas-location-status";
      if (!navigator.geolocation) {
        locationStatus.textContent = "Tämä selain ei tue sijainnin lukemista. Kirjoita sijainti kenttään.";
        locationStatus.classList.add("is-error");
        return;
      }

      locationButton.disabled = true;
      locationStatus.textContent = "Odotan puhelimen sijaintilupaa ja haen koordinaatteja…";
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const latitude = position.coords.latitude.toFixed(6);
          const longitude = position.coords.longitude.toFixed(6);
          const accuracyMetres = Math.max(1, Math.round(position.coords.accuracy));
          panel.querySelector('[name="latitude"]').value = latitude;
          panel.querySelector('[name="longitude"]').value = longitude;
          panel.querySelector('[name="locationAccuracy"]').value = `${accuracyMetres} m`;
          locationStatus.textContent =
            `Sijainti hyväksytty: ${latitude}, ${longitude} – tarkkuus noin ${accuracyMetres} m. ` +
            "Tonttiraja on aina tarkistettava erikseen.";
          locationStatus.classList.add("is-success");
          locationButton.textContent = "📍 Päivitä sijainti";
          locationButton.disabled = false;
        },
        (error) => {
          const messages = {
            1: "Sijaintilupaa ei annettu. Voit sallia sijainnin selaimen asetuksista tai kirjoittaa sijainnin itse.",
            2: "Puhelin ei saanut sijaintia määritettyä. Siirry avoimemmalle paikalle ja yritä uudelleen.",
            3: "Sijainnin haku kesti liian kauan. Yritä uudelleen.",
          };
          locationStatus.textContent = messages[error.code] || "Sijaintia ei voitu lukea. Kirjoita sijainti kenttään.";
          locationStatus.classList.add("is-error");
          locationButton.disabled = false;
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
      );
    });

    panel.querySelectorAll("[data-assessment-photo]").forEach((slot) => {
      const index = Number(slot.dataset.assessmentPhoto);
      const slotInput = document.createElement("input");
      slotInput.type = "file";
      slotInput.accept = "image/jpeg,image/png,image/webp";
      slotInput.hidden = true;
      slot.appendChild(slotInput);

      async function setAssessmentImage(file) {
        try {
          assessmentStatus.textContent = `Valmistelen kuvaa ${index + 1}...`;
          assessmentImages[index] = await prepareImage(file);
          slot.querySelector("img").src = assessmentImages[index].dataUrl;
          slot.classList.add("has-image");
        } catch (error) {
          assessmentImages[index] = null;
          slot.classList.remove("has-image");
          showMessage("❌ " + (error.message || "Kuvaa ei voitu liittää."));
        } finally {
          assessmentSubmit.disabled = !assessmentImages[0];
          assessmentStatus.textContent = assessmentImages[0]
            ? `${assessmentImages.filter(Boolean).length}/4 kuvaa lisätty – voit luoda raakaversion`
            : "Yleiskuva puuttuu";
        }
      }

      slot.addEventListener("click", (event) => {
        if (event.target === slotInput || event.target.closest(".puuopas-assessment-photo-remove")) return;
        slotInput.click();
      });
      slot.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          slotInput.click();
        }
      });
      slot.addEventListener("paste", (event) => {
        const imageFile = Array.from(event.clipboardData?.files || [])
          .find((file) => file.type.startsWith("image/"));
        if (!imageFile) return;
        event.preventDefault();
        setAssessmentImage(imageFile);
      });
      slotInput.addEventListener("change", () => {
        if (slotInput.files && slotInput.files[0]) setAssessmentImage(slotInput.files[0]);
      });
      slot.querySelector(".puuopas-assessment-photo-remove").addEventListener("click", (event) => {
        event.stopPropagation();
        assessmentImages[index] = null;
        slotInput.value = "";
        slot.classList.remove("has-image");
        slot.querySelector("img").removeAttribute("src");
        assessmentSubmit.disabled = !assessmentImages[0];
        assessmentStatus.textContent = assessmentImages[0]
          ? `${assessmentImages.filter(Boolean).length}/4 kuvaa lisätty`
          : "Yleiskuva puuttuu";
      });
    });

    function toggleAssessmentPanel() {
      const open = !panel.classList.contains("is-open");
      panel.classList.toggle("is-open", open);
      card.setAttribute("aria-expanded", String(open));
      if (open) {
        (panel.classList.contains("is-unlocked")
          ? panel.querySelector('[data-assessment-photo="0"]')
          : assessmentPassword).focus();
      }
    }

    card.addEventListener("click", toggleAssessmentPanel);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleAssessmentPanel();
      }
    });

    assessmentForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!assessmentImages[0] || requestInProgress) return;
      const totalBytes = assessmentImages.filter(Boolean)
        .reduce((sum, image) => sum + dataUrlSize(image.dataUrl), 0);
      if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
        showMessage("❌ Kuvien yhteiskoko on liian suuri. Valitse hieman pienemmät kuvat.");
        return;
      }

      requestInProgress = true;
      assessmentSubmit.disabled = true;
      assessmentStatus.textContent = "Laadin kuntoarvion raakaversiota...";
      const finishLoading = startLoading("Tarkastelen yleiskuvaa ja kohdetietoja...");
      try {
        const data = await askApi({
          question: buildAssessmentPrompt(panel),
          images: assessmentImages,
          assessment: true,
          assessmentToken: assessmentAccessToken,
        });
        finishLoading();
        showMessage("🌳 Kuntoarvion raakaversio on valmis alla.");
        renderAssessmentReport(panel, data.answer || "En saanut muodostettua kuntoarvion luonnosta.");
        assessmentStatus.textContent = "Raakaversio valmis";
      } catch (error) {
        console.error(error);
        finishLoading();
        if (String(error.message || "").includes("salasanaistunto")) {
          assessmentAccessToken = "";
          panel.classList.remove("is-unlocked");
          assessmentPassword.focus();
        }
        showMessage("❌ " +
          (error.message || "AI-puuopas ei saanut kuntoarviota muodostettua juuri nyt."));
        assessmentStatus.textContent = "Raakaversio epäonnistui";
      } finally {
        finishLoading();
        requestInProgress = false;
        assessmentSubmit.disabled = !assessmentImages[0];
      }
    });

    report.querySelector(".puuopas-report-print").addEventListener("click", () => window.print());
  }

  function buildTreeIdentifier() {
    const card = findTreeCard();
    const cards = card?.closest(".cards");
    if (!card || !cards) return;

    card.classList.add("puuopas-tree-card");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-expanded", "false");
    card.setAttribute("aria-controls", "puuopasTreePanel");

    const panel = document.createElement("section");
    panel.id = "puuopasTreePanel";
    panel.className = "puuopas-tree-panel";
    panel.setAttribute("aria-labelledby", "puuopasTreeTitle");
    panel.innerHTML =
      '<h2 id="puuopasTreeTitle">Tunnista puu ohjatusti kolmesta kuvasta</h2>' +
      '<p class="puuopas-tree-intro">Aloita lehdestä tai silmusta, kuvaa seuraavaksi runko ja lopuksi koko puu. Sinun ei tarvitse itse tietää puun tuntomerkkejä – kuvausohjeet auttavat saamaan tunnistukseen sopivat kuvat.</p>' +
      '<div class="puuopas-tree-slots"></div>' +
      '<div class="puuopas-tree-actions">' +
        '<button type="button" class="puuopas-tree-submit" disabled>Tunnista puu</button>' +
        '<span class="puuopas-tree-status" aria-live="polite">0/3 kuvaa lisätty</span>' +
      '</div>';
    cards.insertAdjacentElement("afterend", panel);

    const slotsContainer = panel.querySelector(".puuopas-tree-slots");
    const identifyButton = panel.querySelector(".puuopas-tree-submit");
    const status = panel.querySelector(".puuopas-tree-status");

    function refreshTreeUi() {
      const count = treeImages.filter(Boolean).length;
      status.textContent = `${count}/3 kuvaa lisätty`;
      identifyButton.disabled = count !== 3;
    }

    TREE_SLOTS.forEach((definition, index) => {
      const slot = document.createElement("div");
      slot.className = "puuopas-tree-slot";
      slot.tabIndex = 0;
      slot.setAttribute("role", "button");
      slot.setAttribute("aria-label", `${definition.title}: valitse tai liitä kuva`);
      slot.innerHTML =
        `<div class="puuopas-slot-prompt"><strong>${definition.title}</strong>` +
        `<small>${definition.help}</small><small>Valitse tai paste (Ctrl/⌘ + V)</small></div>` +
        `<img alt="${definition.title} – esikatselu">` +
        '<button type="button" class="puuopas-tree-remove">Poista</button>';

      const slotInput = document.createElement("input");
      slotInput.type = "file";
      slotInput.accept = "image/jpeg,image/png,image/webp";
      slotInput.hidden = true;
      slot.appendChild(slotInput);
      slotsContainer.appendChild(slot);

      async function setSlotImage(file) {
        try {
          status.textContent = `Valmistelen kuvaa ${index + 1}...`;
          treeImages[index] = await prepareImage(file);
          slot.querySelector("img").src = treeImages[index].dataUrl;
          slot.classList.add("has-image");
        } catch (error) {
          treeImages[index] = null;
          slot.classList.remove("has-image");
          showMessage("❌ " + (error.message || "Kuvaa ei voitu liittää."));
        } finally {
          refreshTreeUi();
        }
      }

      slot.addEventListener("click", (event) => {
        if (
          event.target === slotInput ||
          event.target.closest(".puuopas-tree-remove")
        ) return;
        slotInput.click();
      });
      slot.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          slotInput.click();
        }
      });
      slot.addEventListener("paste", (event) => {
        const imageFile = Array.from(event.clipboardData?.files || [])
          .find((file) => file.type.startsWith("image/"));
        if (!imageFile) return;
        event.preventDefault();
        setSlotImage(imageFile);
      });
      slotInput.addEventListener("change", () => {
        if (slotInput.files && slotInput.files[0]) setSlotImage(slotInput.files[0]);
      });
      slot.querySelector(".puuopas-tree-remove").addEventListener("click", (event) => {
        event.stopPropagation();
        treeImages[index] = null;
        slotInput.value = "";
        slot.classList.remove("has-image");
        slot.querySelector("img").removeAttribute("src");
        refreshTreeUi();
      });
    });

    function togglePanel() {
      const open = !panel.classList.contains("is-open");
      panel.classList.toggle("is-open", open);
      card.setAttribute("aria-expanded", String(open));
      if (open) panel.querySelector(".puuopas-tree-slot").focus();
    }

    card.addEventListener("click", togglePanel);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        togglePanel();
      }
    });

    identifyButton.addEventListener("click", async () => {
      const images = treeImages.filter(Boolean);
      if (images.length !== 3 || requestInProgress) return;
      const totalBytes = images.reduce((sum, image) => sum + dataUrlSize(image.dataUrl), 0);
      if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
        showMessage("❌ Kuvien yhteiskoko on liian suuri. Valitse hieman pienemmät kuvat.");
        return;
      }

      requestInProgress = true;
      identifyButton.disabled = true;
      status.textContent = "Tunnistan puuta vaiheittain kolmesta kuvasta...";
      const finishLoading = startLoading(
        "Rajaukseen käytetään ensin lehteä tai silmua...",
      );
      try {
        const data = await askApi({ images });
        finishLoading();
        answerText.textContent = data.answer || "En saanut muodostettua tunnistusta.";
        status.textContent = "Tunnistus valmis";
        answerPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } catch (error) {
        console.error(error);
        finishLoading();
        status.textContent = "Tunnistus epäonnistui";
        answerText.textContent = "❌ " +
          (error.message || "AI-puuopas ei saanut vastausta juuri nyt. Kokeile hetken kuluttua uudelleen.");
      } finally {
        finishLoading();
        requestInProgress = false;
        identifyButton.disabled = false;
      }
    });
  }

  buildTreeIdentifier();
  buildConditionAssessment();
})();
