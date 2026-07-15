(function () {
  "use strict";

  const API_URL = "https://ai-puuopas.jukipuu-fi.workers.dev/api/ask";
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
  const MAX_IMAGE_EDGE = 1600;
  const SUPPORTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
  const STORAGE_KEY = "puuopasConversationId";
  const TREE_SLOTS = [
    { title: "1. Yleiskuva", help: "Koko puu, latvus ja kasvutapa" },
    { title: "2. Runko", help: "Kaarna mahdollisimman läheltä" },
    { title: "3. Lehti tai silmu", help: "Tarkka lähikuva tuntomerkeistä" },
  ];

  const form = document.querySelector(".search-card");
  const input = document.querySelector("#question");
  const answerPanel = document.querySelector("#answerPanel");
  const answerText = document.querySelector("#answerText");

  if (!form || !input || !answerPanel || !answerText) return;

  const submitButton = form.querySelector('button[type="submit"], button');
  const searchRow = form.querySelector(".search-row") || form;
  let pendingImage = null;
  const treeImages = [null, null, null];

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
    @media (max-width: 720px) {
      .puuopas-tree-slots { grid-template-columns: 1fr; }
      .puuopas-tree-slot { min-height: 150px; }
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
    if (!question && !pendingImage) return;

    showMessage(pendingImage ? "📷 Tunnistan kuvaa..." : "🌳 Tutkin asiaa...");
    submitButton.disabled = true;
    input.disabled = true;
    attachButton.disabled = true;

    try {
      const data = await askApi({ question, image: pendingImage });
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

  function findTreeCard() {
    return Array.from(document.querySelectorAll(".card"))
      .find((card) => card.querySelector("h2")?.textContent.trim() === "Tunnista puu");
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
      '<h2 id="puuopasTreeTitle">Tunnista puu kolmesta kuvasta</h2>' +
      '<p class="puuopas-tree-intro">Lisää yleiskuva, kuva rungosta ja kuva lehdestä tai silmusta. Voit valita kuvan tai liittää sen paste-komennolla.</p>' +
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
      if (images.length !== 3) return;
      const totalBytes = images.reduce((sum, image) => sum + dataUrlSize(image.dataUrl), 0);
      if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
        showMessage("❌ Kuvien yhteiskoko on liian suuri. Valitse hieman pienemmät kuvat.");
        return;
      }

      identifyButton.disabled = true;
      status.textContent = "Tunnistan puuta kolmesta kuvasta...";
      showMessage("🌳 Vertailen yleiskuvaa, runkoa ja lehteä tai silmua...");
      try {
        const data = await askApi({ images });
        answerText.textContent = data.answer || "En saanut muodostettua tunnistusta.";
        status.textContent = "Tunnistus valmis";
        answerPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } catch (error) {
        console.error(error);
        status.textContent = "Tunnistus epäonnistui";
        answerText.textContent = "❌ " +
          (error.message || "AI-puuopas ei saanut vastausta juuri nyt. Kokeile hetken kuluttua uudelleen.");
      } finally {
        identifyButton.disabled = false;
      }
    });
  }

  buildTreeIdentifier();
})();
