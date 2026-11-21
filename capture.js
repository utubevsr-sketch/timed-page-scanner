const pageAspect = 0.73;
const longestEdge = 2200;
const jpegQuality = 0.72;
const wideZoom = 0.7;
const ultraWideLabel = /ultra[\s-]*wide|\b0[.,][56]\s*[x×]/i;

async function tryWideZoom(track) {
  if (Math.abs(track.getSettings?.().zoom - wideZoom) < 0.02) return true;
  const range = track.getCapabilities?.().zoom;
  if (!range || !(range.min <= wideZoom && wideZoom <= range.max)) return false;

  try {
    await track.applyConstraints({ ...track.getConstraints?.(), zoom: { exact: wideZoom } });
    return Math.abs(track.getSettings().zoom - wideZoom) < 0.02;
  } catch {
    return false;
  }
}

export async function openPageCamera(mediaDevices, stillWanted) {
  const open = (selection) => mediaDevices.getUserMedia({
    audio: false,
    video: { width: { ideal: 3840 }, height: { ideal: 2160 }, ...selection },
  });
  const rear = { facingMode: { ideal: "environment" } };
  const feed = await open(rear);
  const standard = { feed, lens: "Standard camera" };
  if (!stillWanted()) return standard;

  const track = feed.getVideoTracks()[0];
  if (await tryWideZoom(track)) return { feed, lens: "0.7× camera" };
  if (ultraWideLabel.test(track.label)) return { feed, lens: "Ultra-wide camera" };

  const devices = await mediaDevices.enumerateDevices?.().catch(() => []);
  const wide = devices?.find((device) => device.kind === "videoinput" && device.deviceId && ultraWideLabel.test(device.label));
  if (!wide || !stillWanted()) return standard;

  // Release the first camera before opening another lens on phones with one active camera at a time.
  feed.getTracks().forEach((active) => active.stop());
  let wider;
  try {
    wider = await open({ deviceId: { exact: wide.deviceId } });
  } catch {
    return stillWanted() ? { ...standard, feed: await open(rear) } : standard;
  }

  const widerTrack = wider.getVideoTracks()[0];
  let lens = widerTrack.getSettings?.().deviceId === wide.deviceId || ultraWideLabel.test(widerTrack.label) ?
    "Ultra-wide camera" : standard.lens;
  if (stillWanted() && await tryWideZoom(widerTrack)) lens = "0.7× camera";
  return { feed: wider, lens };
}

export function pageCrop(width, height) {
  const cropHeight = Math.floor(Math.min(width * 0.95 / pageAspect, height * 0.95));
  const cropWidth = Math.floor(cropHeight * pageAspect);
  return {
    x: Math.floor((width - cropWidth) / 2),
    y: Math.floor((height - cropHeight) / 2),
    width: cropWidth,
    height: cropHeight,
  };
}

export function followingDeadline(deadline, now, interval) {
  // Preserve the cadence without catching up with a burst of duplicate frames.
  return deadline + (Math.floor((now - deadline) / interval) + 1) * interval;
}

export function jpegFromCamera(video, canvas, context) {
  const crop = pageCrop(video.videoWidth, video.videoHeight);
  if (!crop.width || !crop.height || video.readyState < 2) {
    throw new Error("The camera frame is unavailable. Turn the camera on again.");
  }

  const scale = Math.min(1, longestEdge / crop.height);
  const width = Math.round(crop.width * scale);
  const height = Math.round(crop.height * scale);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);

  // A neutral color with saturation blending removes chroma without reading pixels into JS.
  context.globalCompositeOperation = "saturation";
  context.fillStyle = "#808080";
  context.fillRect(0, 0, width, height);
  context.globalCompositeOperation = "source-over";

  return new Promise((resolve, reject) => {
    canvas.toBlob((photo) => {
      if (photo?.type === "image/jpeg" && photo.size > 0) resolve(photo);
      else reject(new Error("The browser could not create a JPEG."));
    }, "image/jpeg", jpegQuality);
  });
}
