# Timed Page Scanner

[Open the scanner](https://utubevsr-sketch.github.io/timed-page-scanner/) in Safari or Chrome on your phone.

1. Tap **Enable camera** and frame the page. The scanner tries 0.7× zoom, then an ultra-wide lens if the browser offers one. Tap **Start capture** to begin a three-second countdown.
2. Turn the page after each tick. The default interval is one second and the target is 200 photos. Select 0.5 seconds to scan faster or a longer interval if pages blur.
3. Tap **Prepare ZIP**, then **Save ZIP**. The archive contains numbered grayscale JPEGs in capture order.

The scanner compresses and saves one photo at a time in your browser. You can pause and resume, review saved photos, and retake individual pages. The app has no upload code. Clear your browser's saved photos in the app once you have checked the exported ZIP.

To run the static source locally, run `python3 -m http.server 8000` from the repository root and open `http://localhost:8000` in the same computer's browser. Camera access requires HTTPS or localhost.
