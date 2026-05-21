# dac-peerserver

PeerJS signaling broker for **Divide & Conquer**.

## Deploy to Render (free, ~2 minutes)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/for-he-s-loved/dac-peerserver)

1. Click the button above.
2. Sign in to Render (GitHub OAuth, free).
3. Click **Apply** — Render reads `render.yaml` and provisions a free Node.js web service.
4. Wait ~90 seconds for the first build.
5. Copy the service URL — e.g. `https://dac-peerserver.onrender.com`.

Then update `js/peer.js` in the main game repo:

```js
host: 'dac-peerserver.onrender.com',  // your Render URL, no protocol
port: 443,
path: '/peerjs',
secure: true,
```

## Local

```bash
npm install
npm start
```
