# Deep Brown: brown noise generator (PWA)

Brown noise is generated live on the device (an AudioWorklet, off the main thread), so depth can be changed
while it plays and it never loops or repeats. Works offline once loaded.

## Run it

A PWA needs HTTPS (or `localhost`). Opening `index.html` from the file system will not work.

* Quick test on your computer:  `python3 -m http.server 8080` in this folder, then open http://localhost:8080
* To use it on your Android phone: upload this folder to any static HTTPS host
  (GitHub Pages, Cloudflare Pages, Netlify Drop, your own server), open the URL in Chrome, then
  menu > "Install app" (or tap the Install button in the app).

## For rock-solid background playback on Android

1. Install the app (so it runs as its own window), then press play once. Audio keeps going with the screen off
   and shows a player in the notification shade / lock screen (play, pause, previous/next preset).
2. Settings > Apps > Chrome (and the installed "Deep Brown" entry, if listed) > Battery > **Unrestricted**.
   Aggressive battery savers (Xiaomi, Huawei, Samsung "sleeping apps") can still kill background audio otherwise.
3. Don't force-close the app from the recents screen while it plays.

## Files

index.html, styles.css, app.js        the app
noise-processor.js                    the noise generator (audio thread)
sw.js, manifest.webmanifest, icons/   offline + installability

When you change any file, bump `CACHE` in sw.js so installed copies pick up the update on next launch.
