import { appendPage, clearDraft, DraftChangedError, getDraft, getPage, openStorage, replacePage } from "./pages.js";
import { followingDeadline, jpegFromCamera, openPageCamera, pageCrop } from "./capture.js?v=2";
import { makeZip } from "./zip.js";

const byId = (id) => document.getElementById(id);
const camera = byId("camera");
const finder = byId("viewfinder");
const guide = byId("guide");
const captureButton = byId("capture");
const stopButton = byId("camera-stop");
const intervalInput = byId("interval");
const goalInput = byId("goal");
const soundInput = byId("sound");
const saveLink = byId("save");
const shareButton = byId("share");
const reviewDialog = byId("review-dialog");
const clearDialog = byId("clear-dialog");
const canvas = document.createElement("canvas");
const context = canvas.getContext("2d", { alpha: false });

let database;
let draft = { count: 0, bytes: 0, revision: 0 };
let busy = "Loading scanner";
let notice = "";
let stream = null;
let cameraReady = false;
let cameraLens = "";
let cameraRequest = 0;
let run = null;
let frameRequest = null;
let countdown = 0;
let saving = false;
let retake = null;
let wakeLock = null;
let audio = null;
let archive = null;
let reviewNumber = 0;
let reviewRequest = 0;
let reviewUrl = null;

function formatSize(bytes) {
  if (bytes < 1_000_000) return `${Math.ceil(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function validTarget() {
  const goal = goalInput.valueAsNumber;
  return Number.isInteger(goal) && goal >= 1 && goal <= 999;
}

function render() {
  const validGoal = validTarget();
  const goal = goalInput.valueAsNumber;
  const finished = validGoal && draft.count >= goal;
  const locked = !database || Boolean(busy || run || saving);
  const state = busy || (!database ? "Storage unavailable" : countdown ? `Starting in ${countdown}` : run ? "Capturing" : saving ? "Saving photo" :
    finished && !retake ? "Target reached" : cameraReady ? (draft.count ? "Paused" : "Camera ready") : "Camera off");
  const status = byId("state");
  if (status.textContent !== state) status.textContent = state;
  byId("count").textContent = draft.count;
  byId("goal-label").textContent = validGoal ? ` / ${goal} pages` : " pages";
  byId("size").textContent = `${formatSize(draft.bytes)} stored`;
  byId("lens").textContent = cameraLens;
  byId("lens").hidden = !cameraReady;
  const progress = byId("progress");
  progress.max = validGoal ? goal : Math.max(1, draft.count);
  progress.value = draft.count;
  const countdownElement = byId("countdown");
  countdownElement.hidden = !countdown;
  countdownElement.textContent = countdown || "";

  camera.hidden = !stream;
  byId("camera-off").hidden = Boolean(stream);
  guide.hidden = !cameraReady;
  intervalInput.disabled = locked;
  goalInput.disabled = locked;
  captureButton.disabled = !database || Boolean(busy) || (!run && (saving || (!retake && (!validGoal || finished))));
  captureButton.textContent = run ? "Pause" : finished && !retake ? "Complete" : !stream ? "Enable camera" :
    retake ? `Retake page ${retake}` : draft.count ? "Resume capture" : "Start capture";
  stopButton.hidden = !cameraReady || Boolean(run || saving || busy);
  byId("cancel-retake").hidden = !retake || locked;
  byId("help").textContent = retake ? `Frame page ${retake}. The new photo will replace it.` :
    run ? "Turn the page after each capture. Keep this tab open." : "Frame the whole page. Turn it after each tick.";
  const feedback = byId("notice");
  feedback.textContent = notice;
  feedback.hidden = !notice;

  byId("review").disabled = locked || !draft.count;
  byId("prepare").disabled = locked || !draft.count;
  byId("prepare").hidden = Boolean(archive);
  byId("reset").disabled = locked || !draft.count;
  saveLink.hidden = locked || !archive;
  shareButton.hidden = locked || !archive?.shareable;
}

function applyGuide() {
  if (!camera.videoWidth || !camera.videoHeight) return;
  const crop = pageCrop(camera.videoWidth, camera.videoHeight);
  const scale = Math.min(finder.clientWidth / camera.videoWidth, finder.clientHeight / camera.videoHeight);
  guide.style.width = `${crop.width * scale}px`;
  guide.style.height = `${crop.height * scale}px`;
}

function discardArchive() {
  if (!archive) return;
  URL.revokeObjectURL(archive.url);
  saveLink.removeAttribute("href");
  archive = null;
}

function stopCapture() {
  run = null;
  countdown = 0;
  if (frameRequest !== null) {
    if (camera.cancelVideoFrameCallback) camera.cancelVideoFrameCallback(frameRequest);
    else cancelAnimationFrame(frameRequest);
    frameRequest = null;
  }
  if (wakeLock) {
    void wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

function turnCameraOff(message = "") {
  stopCapture();
  cameraRequest += 1;
  if (busy === "Opening camera") busy = "";
  const active = stream;
  stream = null;
  cameraReady = false;
  cameraLens = "";
  camera.pause();
  camera.srcObject = null;
  active?.getTracks().forEach((track) => track.stop());
  if (message) notice = message;
  render();
}

async function enableCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    notice = "Open the secure scanner link directly in Safari or Chrome to use the camera.";
    render();
    return;
  }
  const requested = ++cameraRequest;
  busy = "Opening camera";
  notice = "";
  render();
  try {
    const { feed, lens } = await openPageCamera(navigator.mediaDevices, () => requested === cameraRequest && !document.hidden);
    if (requested !== cameraRequest || document.hidden) {
      feed.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = feed;
    camera.srcObject = feed;
    render();
    await camera.play();
    if (requested !== cameraRequest) return;
    const track = feed.getVideoTracks()[0];
    track.addEventListener("ended", () => {
      if (stream === feed) turnCameraOff("Camera disconnected. Enable it to continue.");
    });
    track.addEventListener("mute", () => {
      if (stream === feed && run) turnCameraOff("Camera paused. Enable it to continue.");
    });
    cameraReady = true;
    cameraLens = lens;
    applyGuide();
  } catch (error) {
    if (requested !== cameraRequest) return;
    const messages = {
      NotAllowedError: "Allow camera access in your browser’s site settings, then try again.",
      NotFoundError: "A camera is unavailable. Open the scanner on your phone.",
      NotReadableError: "The camera may be in use. Close other camera apps and try again.",
    };
    turnCameraOff(messages[error.name] ?? "The camera could not start. Try again from a regular browser tab.");
  } finally {
    if (requested === cameraRequest) {
      busy = "";
      render();
    }
  }
}

function activateTick() {
  if (!soundInput.checked) return;
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) return;
  try {
    audio ??= new Audio();
    void audio.resume().catch(() => {});
  } catch {
    // The counter and flash also indicate a saved photo.
  }
}

function signalSaved() {
  finder.classList.add("shot");
  setTimeout(() => finder.classList.remove("shot"), 230);
  if (!soundInput.checked || audio?.state !== "running") return;
  const tone = audio.createOscillator();
  const volume = audio.createGain();
  const start = audio.currentTime;
  tone.frequency.value = 880;
  volume.gain.setValueAtTime(0.09, start);
  volume.gain.exponentialRampToValueAtTime(0.001, start + 0.075);
  tone.connect(volume).connect(audio.destination);
  tone.start(start);
  tone.stop(start + 0.08);
  tone.onended = () => volume.disconnect();
}

function beginRun() {
  if (!cameraReady || (!retake && (!validTarget() || draft.count >= goalInput.valueAsNumber))) return;
  notice = "";
  activateTick();
  const active = {
    deadline: performance.now() + 3000,
    interval: Number(intervalInput.value),
    target: goalInput.valueAsNumber,
    retake,
  };
  run = active;
  countdown = 3;
  render();
  if (navigator.wakeLock) {
    void navigator.wakeLock.request("screen").then((lock) => {
      if (run === active) wakeLock = lock;
      else return lock.release();
    }).catch(() => {});
  }
  requestFrame();
}

function requestFrame() {
  if (!run || frameRequest !== null) return;
  frameRequest = camera.requestVideoFrameCallback ? camera.requestVideoFrameCallback(onFrame) : requestAnimationFrame(onFrame);
}

function onFrame(now) {
  frameRequest = null;
  const active = run;
  if (!active || document.hidden) return;
  const remaining = active.deadline - now;
  if (remaining > 0 || camera.readyState < 2) {
    if (countdown) {
      const seconds = Math.ceil(Math.max(0, remaining) / 1000);
      if (seconds !== countdown) {
        countdown = seconds;
        render();
      }
    }
    requestFrame();
    return;
  }
  countdown = 0;
  active.deadline = followingDeadline(active.deadline, now, active.interval);
  void saveFrame(active);
}

async function reportError(error) {
  if (error instanceof DraftChangedError) {
    try {
      draft = await getDraft(database);
      retake = null;
      discardArchive();
    } catch {
      notice = "The saved list could not refresh. Reload the scanner to continue.";
      return;
    }
  }
  notice = error.name === "QuotaExceededError" ? "Storage is full. Save a ZIP of the photos already captured." :
    error.message || "The browser could not save the photo. Try again.";
}

async function saveFrame(active) {
  saving = true;
  render();
  try {
    const photo = await jpegFromCamera(camera, canvas, context);
    draft = active.retake ? await replacePage(database, draft.revision, active.retake, photo) :
      await appendPage(database, draft.revision, photo);
    discardArchive();
    if (active.retake) retake = null;
    if (!document.hidden) signalSaved();
    if (!active.retake && draft.count >= active.target) turnCameraOff();
    else if (!run || active.retake) stopCapture();
  } catch (error) {
    stopCapture();
    await reportError(error);
  } finally {
    saving = false;
    render();
    requestFrame();
  }
}

async function prepareArchive() {
  busy = "Preparing ZIP";
  notice = "";
  render();
  const snapshot = draft;
  try {
    const zip = await makeZip(snapshot.count, (number) => getPage(database, number));
    if ((await getDraft(database)).revision !== snapshot.revision) {
      throw new DraftChangedError("These photos changed in another tab. Prepare the ZIP again.");
    }
    const name = `scanned-pages-${String(snapshot.count).padStart(3, "0")}.zip`;
    const file = new File([zip], name, { type: zip.type });
    archive = { file, url: URL.createObjectURL(file), shareable: Boolean(navigator.canShare?.({ files: [file] })) };
    saveLink.href = archive.url;
    saveLink.download = name;
  } catch (error) {
    await reportError(error);
  } finally {
    busy = "";
    render();
  }
}

async function shareArchive() {
  if (!archive?.shareable) return;
  try {
    await navigator.share({ files: [archive.file] });
  } catch (error) {
    if (error.name !== "AbortError") {
      notice = "Sharing is unavailable. Use Save ZIP to download the file.";
      render();
    }
  }
}

function clearReviewPhoto() {
  if (reviewUrl) URL.revokeObjectURL(reviewUrl);
  reviewUrl = null;
  const photo = byId("review-image");
  photo.removeAttribute("src");
  photo.hidden = true;
}

async function showPhoto(number) {
  const requested = ++reviewRequest;
  reviewNumber = number;
  byId("review-title").textContent = `Page ${number} of ${draft.count}`;
  byId("previous").disabled = number <= 1;
  byId("next").disabled = number >= draft.count;
  byId("retake").disabled = true;
  clearReviewPhoto();
  if (!reviewDialog.open) reviewDialog.showModal();
  try {
    const file = await getPage(database, number);
    if (requested !== reviewRequest || !reviewDialog.open) return;
    reviewUrl = URL.createObjectURL(file);
    const photo = byId("review-image");
    photo.src = reviewUrl;
    photo.alt = `Photo of page ${number}`;
    photo.hidden = false;
    byId("retake").disabled = false;
  } catch (error) {
    if (requested !== reviewRequest) return;
    reviewDialog.close();
    await reportError(error);
    render();
  }
}

async function deletePhotos() {
  clearDialog.close();
  busy = "Clearing photos";
  notice = "";
  render();
  try {
    draft = await clearDraft(database, draft.revision);
    retake = null;
    discardArchive();
  } catch (error) {
    await reportError(error);
  } finally {
    busy = "";
    render();
  }
}

function saveSettings() {
  if (!validTarget()) return;
  try {
    localStorage.setItem("scanner-settings", JSON.stringify({ goal: goalInput.value, interval: intervalInput.value, sound: soundInput.checked }));
  } catch {
    // Running a scan only requires access to IndexedDB.
  }
}

async function initialize() {
  try {
    const saved = JSON.parse(localStorage.getItem("scanner-settings") ?? "null");
    if (saved && Number.isInteger(Number(saved.goal)) && saved.goal >= 1 && saved.goal <= 999) goalInput.value = saved.goal;
    if (saved && [...intervalInput.options].some((option) => option.value === saved.interval)) intervalInput.value = saved.interval;
    if (typeof saved?.sound === "boolean") soundInput.checked = saved.sound;
  } catch {
    // Defaults also work in browsers that restrict preference storage.
  }
  try {
    database = await openStorage();
    draft = await getDraft(database);
  } catch {
    database?.close();
    database = undefined;
    notice = "Browser storage is unavailable. Open the link in a regular Safari or Chrome tab.";
  } finally {
    busy = "";
    render();
  }
}

captureButton.addEventListener("click", () => {
  if (run) {
    stopCapture();
    render();
  } else if (!stream) {
    void enableCamera();
  } else {
    beginRun();
  }
});
stopButton.addEventListener("click", () => turnCameraOff());
byId("cancel-retake").addEventListener("click", () => { retake = null; render(); });
goalInput.addEventListener("input", render);
for (const input of [goalInput, intervalInput, soundInput]) input.addEventListener("change", saveSettings);
camera.addEventListener("resize", applyGuide);
new ResizeObserver(applyGuide).observe(finder);
document.addEventListener("visibilitychange", () => {
  if (document.hidden && (stream || busy === "Opening camera")) {
    turnCameraOff(run ? "Capture paused. Keep this tab in front and enable the camera to continue." : "");
  }
});
window.addEventListener("pagehide", () => {
  turnCameraOff();
  discardArchive();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    discardArchive();
    void getDraft(database).then((value) => { draft = value; render(); }).catch(() => {});
  }
});
byId("review").addEventListener("click", () => void showPhoto(draft.count));
byId("review-close").addEventListener("click", () => reviewDialog.close());
reviewDialog.addEventListener("close", () => { reviewRequest += 1; clearReviewPhoto(); });
byId("previous").addEventListener("click", () => void showPhoto(reviewNumber - 1));
byId("next").addEventListener("click", () => void showPhoto(reviewNumber + 1));
byId("retake").addEventListener("click", () => {
  retake = reviewNumber;
  reviewDialog.close();
  render();
  captureButton.focus({ preventScroll: false });
});
byId("prepare").addEventListener("click", () => void prepareArchive());
shareButton.addEventListener("click", () => void shareArchive());
byId("reset").addEventListener("click", () => clearDialog.showModal());
byId("keep").addEventListener("click", () => clearDialog.close());
byId("delete").addEventListener("click", () => void deletePhotos());
void initialize();
