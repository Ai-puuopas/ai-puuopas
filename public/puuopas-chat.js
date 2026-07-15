(function () {
  "use strict";

  const API_URL = "https://ai-puuopas.jukipuu-fi.workers.dev/api/ask";
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const MAX_IMAGE_EDGE = 1600;
  const SUPPORTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
  const STORAGE_KEY = "puuopasConversationId";

  const form = document.querySelector(".search-card");
  const input = document.querySelector("#question");
  const answerPanel = document.querySelector("#answerPanel");
  const answerText = document.querySelector("#answerText");

  if (!form || !input || !answerPanel || !answerText) return;

  const submitButton = form.querySelector('button[type="submit"], button');
  const searchRow = form.querySelector(".search-row") || form;
  let pendingImage = null;

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

  function showMessage(message) {
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

  function canvasToDataUrl(canvas, mimeType, quality) {
    return canvas.toDataURL(mimeType, quality);
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
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    let mimeType = file.type === "image/png" ? "image/png" : "image/jpeg";
    let dataUrl = canvasToDataUrl(canvas, mimeType, 0.86);

    if (dataUrlSize(dataUrl) > MAX_IMAGE_BYTES && mimeType === "image/png") {
      mimeType = "image/jpeg";
      dataUrl = canvasToDataUrl(canvas, mimeType, 0.82);
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

  attachButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files[0]) useImage(fileInput.files[0]);
  });
  preview.querySelector(".puuopas-image-remove").addEventListener("click", clearImage);

  input.addEventListener("paste", (event) => {
    const files = Array.from(event.clipboardData?.files || []);
    const imageFile = files.find((file) => file.type.startsWith("image/"));
    if (!imageFile) return;
    event.preventDefault();
    useImage(imageFile);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();

    const question = input.value.trim();
    if (!question && !pendingImage) return;

    showMessage(pendingImage ? "📷 Tunnistan kuvaa..." : "🌳 Tutkin asiaa...");
    submitButton.disabled = true;
    input.disabled = true;
    attachButton.disabled = true;

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          image: pendingImage,
          conversationId: getConversationId(),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.answer || data.error || "API ei vastannut oikein");
      if (data.conversationId) localStorage.setItem(STORAGE_KEY, data.conversationId);
      answerText.textContent = data.answer || "En saanut muodostettua vastausta.";
      clearImage();
    } catch (error) {
      console.error(error);
      answerText.textContent = "❌ " +
        (error.message || "AI-puuopas ei saanut vastausta juuri nyt. Kokeile hetken kuluttua uudelleen.");
    } finally {
      submitButton.disabled = false;
      input.disabled = false;
      attachButton.disabled = false;
      input.focus();
    }
  }, true);
})();
