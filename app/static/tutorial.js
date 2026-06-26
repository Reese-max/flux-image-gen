(function () {
  'use strict';

  var STORAGE_KEY = 'aiImageTutorialSeen.v1';
  var tutorialModal;
  var dontShowTutorialAgain;
  var finishTutorial;

  function rememberTutorialSeen() {
    try {
      window.localStorage.setItem(STORAGE_KEY, 'true');
    } catch (err) {
      // localStorage 可能被隱私模式或瀏覽器政策擋下；不影響教學視窗操作。
    }
  }

  function hasSeenTutorial() {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === 'true';
    } catch (err) {
      return false;
    }
  }

  function openTutorial() {
    if (!tutorialModal) {
      tutorialModal = document.getElementById('tutorialModal');
    }
    if (!finishTutorial) {
      finishTutorial = document.getElementById('finishTutorial');
    }
    if (!tutorialModal) {
      return;
    }

    if (window.ModalA11y && typeof window.ModalA11y.open === 'function') {
      window.ModalA11y.open(tutorialModal, finishTutorial);
    } else {
      tutorialModal.hidden = false;
    }
    if (!window.ModalA11y && finishTutorial && typeof finishTutorial.focus === 'function') {
      finishTutorial.focus();
    }
  }

  function closeTutorial(markSeen) {
    if (!tutorialModal) {
      tutorialModal = document.getElementById('tutorialModal');
    }
    if (!dontShowTutorialAgain) {
      dontShowTutorialAgain = document.getElementById('dontShowTutorialAgain');
    }

    if (markSeen || (dontShowTutorialAgain && dontShowTutorialAgain.checked)) {
      rememberTutorialSeen();
    }
    if (tutorialModal && window.ModalA11y && typeof window.ModalA11y.close === 'function') {
      window.ModalA11y.close(tutorialModal);
    } else if (tutorialModal) {
      tutorialModal.hidden = true;
    }
  }

  function bindTutorial() {
    var openTutorialButton = document.getElementById('openTutorial');
    var closeTutorialButton = document.getElementById('closeTutorial');

    tutorialModal = document.getElementById('tutorialModal');
    dontShowTutorialAgain = document.getElementById('dontShowTutorialAgain');
    finishTutorial = document.getElementById('finishTutorial');

    if (openTutorialButton) {
      openTutorialButton.addEventListener('click', openTutorial);
    }
    if (closeTutorialButton) {
      closeTutorialButton.addEventListener('click', function () {
        closeTutorial(false);
      });
    }
    if (finishTutorial) {
      finishTutorial.addEventListener('click', function () {
        closeTutorial(true);
      });
    }
    if (tutorialModal) {
      tutorialModal.addEventListener('click', function (event) {
        if (event.target === tutorialModal) {
          closeTutorial(false);
        }
      });
    }

    if (!hasSeenTutorial()) {
      window.setTimeout(openTutorial, 350);
    }
  }

  document.addEventListener('DOMContentLoaded', bindTutorial);
  window.openTutorial = openTutorial;
})();
