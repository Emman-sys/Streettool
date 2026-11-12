const TILE = 512;
const MAX_ZOOM = 5;
const CONCURRENCY = 6;
const MAX_TILES = 2200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tileUrls(pano, x, y, z) {
  const q = `cb_client=apiv3&panoid=${encodeURIComponent(pano)}&x=${x}&y=${y}&zoom=${z}&nbt=1&fover=2`;
  return [
    `https://streetviewpixels-pa.googleapis.com/v1/tile?${q}`,
    `https://cbk0.googleapis.com/cbk?${q}&output=tile`,
    `https://geo0.ggpht.com/cbk?${q}&output=tile`
  ];
}

async function fetchTile(pano, x, y, z) {
  for (const url of tileUrls(pano, x, y, z)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
        if (!r.ok) break;
        const blob = await r.blob();
        if (!blob.size) break;
        return await createImageBitmap(blob);
      } catch {
        await sleep(120 * (attempt + 1));
      }
    }
  }
  return null;
}

async function pool(items, worker, limit) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

/* ---------------- geometry ---------------- */

function buildRegion(pano, cam, outW, outH, zoom) {
  const n = 1 << zoom;
  const W = n * TILE;
  const hTiles = Math.max(1, n >> 1);
  const H = hTiles * TILE;

  const hFov = cam.hfov;
  const vFov = 2 * Math.atan(Math.tan(hFov / 2) * (outH / outW));
  const margin = 1.18;

  const pxX = W / (2 * Math.PI);
  const pxY = H / Math.PI;

  const yawSpan = Math.min(2 * Math.PI, hFov * margin);
  const pitchSpan = Math.min(Math.PI, vFov * margin);

  let x0 = (cam.yaw + Math.PI) * pxX - (yawSpan / 2) * pxX;
  let x1 = x0 + yawSpan * pxX;
  let y0 = (Math.PI / 2 - (cam.pitch + pitchSpan / 2)) * pxY;
  let y1 = (Math.PI / 2 - (cam.pitch - pitchSpan / 2)) * pxY;

  x0 = Math.floor(x0 / TILE) * TILE - TILE;
  x1 = Math.ceil(x1 / TILE) * TILE + TILE;
  y0 = Math.max(0, Math.floor(y0 / TILE) * TILE - TILE);
  y1 = Math.min(H, Math.ceil(y1 / TILE) * TILE + TILE);

  const tx0 = Math.floor(x0 / TILE);
  const tx1 = Math.ceil(x1 / TILE);
  const ty0 = Math.floor(y0 / TILE);
  const ty1 = Math.ceil(y1 / TILE);

  return { n, hTiles, W, H, x0, y0, width: x1 - x0, height: y1 - y0, tx0, tx1, ty0, ty1 };
}

/* ---------------- stitching ---------------- */

async function stitch(pano, region, zoom, onProgress) {
  const { n, hTiles, x0, y0, width, height, tx0, tx1, ty0, ty1 } = region;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#c8c8c8';
  ctx.fillRect(0, 0, width, height);

  const jobs = [];
  for (let ty = ty0; ty < ty1; ty++) {
    if (ty < 0 || ty >= hTiles) continue;
    for (let tx = tx0; tx < tx1; tx++) jobs.push({ tx, ty });
  }

  const total = jobs.length;
  let done = 0;
  let missing = 0;

  await pool(jobs, async ({ tx, ty }) => {
    const wx = ((tx % n) + n) % n;
    const bmp = await fetchTile(pano, wx, ty, zoom);
    if (bmp) {
      ctx.drawImage(bmp, tx * TILE - x0, ty * TILE - y0);
      bmp.close?.();
    } else {
      missing++;
    }
    done++;
    if (done % 4 === 0 || done === total) onProgress?.(done, total);
  }, CONCURRENCY);

  return { canvas, missing, total };
}

/* ---------------- reprojection ---------------- */

function renderView(src, region, outW, outH, cam) {
  const { W, H, x0, y0, width, height } = region;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  const sdata = sctx.getImageData(0, 0, width, height).data;

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const octx = out.getContext('2d');
  const img = octx.createImageData(outW, outH);
  const od = img.data;

  const tanH = Math.tan(cam.hfov / 2);
  const tanV = tanH * (outH / outW);

  const sample = (fx, fy, o) => {
    if (fx < 0 || fy < 0 || fx > width - 1 || fy > height - 1) {
      od[o] = 200; od[o + 1] = 200; od[o + 2] = 200; od[o + 3] = 255;
      return;
    }
    const ix = width > 1 ? Math.min(width - 2, Math.floor(fx)) : 0;
    const iy = height > 1 ? Math.min(height - 2, Math.floor(fy)) : 0;
    const dx = fx - ix, dy = fy - iy;
    const i00 = (iy * width + ix) * 4;
    const i10 = width > 1 ? i00 + 4 : i00;
    const i01 = height > 1 ? i00 + width * 4 : i00;
    const i11 = height > 1 && width > 1 ? i01 + 4 : i01;
    for (let c = 0; c < 3; c++) {
      const top = sdata[i00 + c] * (1 - dx) + sdata[i10 + c] * dx;
      const bot = sdata[i01 + c] * (1 - dx) + sdata[i11 + c] * dx;
      od[o + c] = top * (1 - dy) + bot * dy;
    }
    od[o + 3] = 255;
  };

  let minV = 1;
  let maxV = 0;
  let bandMisses = 0;
  for (let y = 0; y < outH; y++) {
    const v = (0.5 - (y + 0.5) / outH) * 2 * tanV;
    for (let x = 0; x < outW; x++) {
    const u = (x + 0.5) / outW;
    const rayX = (u - 0.5) * 2 * tanH;
    const z0 = 1;

    const rollCos = Math.cos(-cam.roll), rollSin = Math.sin(-cam.roll);
    const x1 = rayX * rollCos - v * rollSin;
    const y1 = rayX * rollSin + v * rollCos;
    const pitchCos = Math.cos(cam.pitch), pitchSin = Math.sin(cam.pitch);
    const y2 = y1 * pitchCos + z0 * pitchSin;
    const z2 = -y1 * pitchSin + z0 * pitchCos;
    const yawCos = Math.cos(cam.yaw), yawSin = Math.sin(cam.yaw);
    const x2 = x1 * yawCos + z2 * yawSin;
    const z3 = -x1 * yawSin + z2 * yawCos;

    const len = Math.hypot(x2, y2, z3);
    const elev = Math.asin(y2 / len);
    const az = Math.atan2(x2, z3);

      const sourceU = 0.5 + az / (2 * Math.PI);
      const sourceX = ((sourceU % 1) + 1) % 1 * (W - 1);
      const lat = Math.asin(y2 / len);
      const sourceV = 0.5 - lat / Math.PI;
      minV = Math.min(minV, sourceV);
      maxV = Math.max(maxV, sourceV);
      const sourceY = sourceV * (H - 1);
      if (sourceY < y0 || sourceY > y0 + height - 1) bandMisses++;

      const sampleX = sourceX + Math.ceil((x0 - sourceX) / W) * W;

      sample(sampleX - x0, sourceY - y0, (y * outW + x) * 4);
    }
  }

  if (minV < -0.01 || maxV > 1.01) {
    console.warn('Equirectangular v out of range', {
      minV,
      maxV,
      pitch: (cam.pitch * 180) / Math.PI
    });
  }
  if (bandMisses) {
    console.warn('Equirectangular sample outside fetched tile band', {
      bandMisses,
      y0,
      bandBottom: y0 + height - 1,
      sourceHeight: H
    });
  }

  octx.putImageData(img, 0, 0);
  return out;
}

/* ---------------- orchestration ---------------- */

async function run(payload) {
  const { pano, camera, zoom, outW, outH, mode, reqId, tabId } = payload;
  console.info('[Street View Stitcher] Stitch request', {
    pano,
    reqId,
    mode,
    zoom,
    yaw: (camera?.yaw * 180 / Math.PI).toFixed?.(2),
    pitch: (camera?.pitch * 180 / Math.PI).toFixed?.(2),
    roll: (camera?.roll * 180 / Math.PI).toFixed?.(2)
  });
  if (!pano) throw new Error('No panorama id detected.');
  if (
    !camera ||
    !Number.isFinite(camera.yaw) ||
    !Number.isFinite(camera.pitch) ||
    !Number.isFinite(camera.roll) ||
    !Number.isFinite(camera.hfov)
  ) {
    throw new Error('Invalid camera parameters.');
  }

  const z = Math.max(0, Math.min(MAX_ZOOM, zoom | 0));
  const report = (phase, done, total) =>
    chrome.runtime.sendMessage({ target: 'content', tabId, reqId, phase, done, total }).catch(() => {});

  let region;
  if (mode === 'pano') {
    const n = 1 << z;
    const hTiles = Math.max(1, n >> 1);
    const size = n * TILE;
    const height = hTiles * TILE;
    region = { n, hTiles, W: size, H: height, x0: 0, y0: 0, width: size, height, tx0: 0, tx1: n, ty0: 0, ty1: hTiles };
  } else {
    region = buildRegion(pano, camera, outW, outH, z);
  }

  const tiles =
    (region.tx1 - region.tx0) * (region.ty1 - region.ty0);
  if (tiles > MAX_TILES) throw new Error(`Too many tiles (${tiles}). Lower the quality level.`);

  report('fetch', 0, tiles);
  const { canvas, missing } = await stitch(pano, region, z, (d, t) => report('fetch', d, t));

  report('render', 0, 1);
  const finalCanvas =
    mode === 'pano'
      ? canvas
      : renderView(canvas, region, outW, outH, camera);
  report('render', 1, 1);

  const blob = await new Promise((res) => finalCanvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('Encoding failed.');

  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  }

  return {
    ok: true,
    dataUrl: `data:image/png;base64,${btoa(bin)}`,
    missing,
    tiles
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'PING') {
    sendResponse({ pong: true });
    return;
  }
  run(msg)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});