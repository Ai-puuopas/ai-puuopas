(function () {
  "use strict";

  const NOTICE_KEY = "puuopasPrivacyNoticeVersion";
  const NOTICE_VERSION = "2026-09-05-v2";

  function noticeHasBeenSeen() {
    try {
      return localStorage.getItem(NOTICE_KEY) === NOTICE_VERSION;
    } catch {
      return false;
    }
  }

  if (noticeHasBeenSeen()) {
    document.documentElement.classList.add("privacy-notice-seen");
  }

  document.addEventListener("DOMContentLoaded", () => {
    const gate = document.querySelector("#privacyGate");
    const continueButton = document.querySelector("#continueToGuide");
    const dialog = document.querySelector("#privacyPolicyDialog");
    const closeButton = document.querySelector("#closePrivacyPolicy");
    const appContent = document.querySelector("#appContent");
    const siteNavigation = document.querySelector("#siteNavigation");
    const openButtons = document.querySelectorAll("[data-open-privacy]");
    let lastTrigger = null;

    function unlockGuide() {
      document.documentElement.classList.add("privacy-notice-seen");
      gate?.setAttribute("hidden", "");
      appContent?.removeAttribute("inert");
      siteNavigation?.removeAttribute("inert");
    }

    function openPrivacyPolicy(event) {
      lastTrigger = event?.currentTarget || document.activeElement;
      if (typeof dialog?.showModal === "function") {
        dialog.showModal();
      } else {
        dialog?.setAttribute("open", "");
      }
      closeButton?.focus();
    }

    function closePrivacyPolicy() {
      if (typeof dialog?.close === "function") {
        dialog.close();
      } else {
        dialog?.removeAttribute("open");
      }
      lastTrigger?.focus?.();
    }

    if (noticeHasBeenSeen()) {
      unlockGuide();
    } else {
      continueButton?.focus();
    }

    continueButton?.addEventListener("click", () => {
      try {
        localStorage.setItem(NOTICE_KEY, NOTICE_VERSION);
      } catch {
        // The notice still works for this page load if browser storage is blocked.
      }
      unlockGuide();
      document.querySelector("#question")?.focus();
    });

    openButtons.forEach((button) => {
      button.addEventListener("click", openPrivacyPolicy);
    });

    closeButton?.addEventListener("click", closePrivacyPolicy);
    dialog?.addEventListener("cancel", (event) => {
      event.preventDefault();
      closePrivacyPolicy();
    });
  });
})();
