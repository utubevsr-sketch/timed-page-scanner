const pageAspect = 0.73;
const longestEdge = 2200;
const jpegQuality = 0.72;

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
