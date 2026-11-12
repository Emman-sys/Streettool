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

function panoDims(imgW, imgH, zoom) {
  if (!imgW || !imgH) {
    const n = 1 << zoom, ny = Math.max(1, n >> 1);
    return { z: zoom, W: n * TILE, H: ny * TILE, nx: n, ny };
  }
  const maxZ = Math.ceil(Math.log2(imgW / TILE));
  const z = Math.min(zoom, maxZ);
  const s = 2 ** (maxZ - z);
  const W = Math.round(imgW / s), H = Math.round(imgH / s);
  return { z, W, H, nx: Math.ceil(W / TILE), ny: Math.ceil(H / TILE) };
}

function buildRegion(cam, outW, outH, d) {
  const { W, H } = d;

  const hFov = cam.hfov;
  const vFov = 2 * Math.atan(Math.tan(hFov / 2) * (outH / outW));
  const margin = 1.18;

  const pxX = W / (2 * Math.PI);
  const pxY = H / Math.PI;

  // Roll rotates the horizontal and vertical extents into each other. Use
  // the diagonal ray angle for both axes so every reprojected corner is
  // covered by the fetched equirectangular band.
  const rayExtent = Math.atan(Math.hypot(Math.tan(hFov / 2), Math.tan(vFov / 2)));
  const yawSpan = Math.min(2 * Math.PI, 2 * rayExtent * margin);
  const pitchSpan = Math.min(Math.PI, 2 * rayExtent * margin);

  const x0 = Math.floor((cam.yaw + Math.PI) * pxX - (yawSpan / 2) * pxX) - 2;
  const x1 = Math.ceil(x0 + yawSpan * pxX) + 4;
  const y0 = Math.max(0, Math.floor((Math.PI / 2 - (cam.pitch + pitchSpan / 2)) * pxY) - 2);
  const y1 = Math.min(H, Math.ceil((Math.PI / 2 - (cam.pitch - pitchSpan / 2)) * pxY) + 2);

  return { ...d, x0, y0, width: x1 - x0, height: y1 - y0 };
}

/* ---------------- stitching ---------------- */

async function stitch(pano, region, onProgress) {
  const { z, W, H, nx, ny, x0, y0, width, height } = region;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#c8c8c8';
  ctx.fillRect(0, 0, width, height);

  const jobs = [];
  const w0 = Math.floor(x0 / W), w1 = Math.floor((x0 + width - 1) / W);
  const ty0 = Math.floor(y0 / TILE), ty1 = Math.floor((y0 + height - 1) / TILE);
  for (let wrap = w0; wrap <= w1; wrap++) {
    for (let tx = 0; tx < nx; tx++) {
      const px = wrap * W + tx * TILE;
      if (px + TILE <= x0 || px >= x0 + width) continue;
      for (let ty = Math.max(0, ty0); ty <= Math.min(ny - 1, ty1); ty++) jobs.push({ wrap, tx, ty });
    }
  }

  if (jobs.length > MAX_TILES) throw new Error(`Too many tiles (${jobs.length}). Lower the quality level.`);

  const total = jobs.length;
  let done = 0;
  let missing = 0;

  onProgress?.(0, total);
  await pool(jobs, async ({ wrap, tx, ty }) => {
    const bmp = await fetchTile(pano, tx, ty, z);
    if (bmp) {
      const vw = Math.min(TILE, W - tx * TILE, bmp.width);
      const vh = Math.min(TILE, H - ty * TILE, bmp.height);
      ctx.drawImage(bmp, 0, 0, vw, vh, wrap * W + tx * TILE - x0, ty * TILE - y0, vw, vh);
      bmp.close?.();
    } else {
      missing++;
    }
    done++;
    if (done % 4 === 0 || done === total) onProgress?.(done, total);
  }, CONCURRENCY);

  return { canvas, missing, total };
}

async function probeSize(pano) {
  const has = async (x, y) => !!(await fetchTile(pano, x, y, 5));
  if (await has(31, 15)) return { imgW: 16384, imgH: 8192 };
  if (await has(25, 12)) return { imgW: 13312, imgH: 6656 };
  return null;
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
  const distortion = Number.isFinite(cam.distortion) ? cam.distortion : 0;

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
    for (let x = 0; x < outW; x++) {
    const u = (x + 0.5) / outW;
    const centeredX = (u - 0.5) * 2;
    const centeredY = ((y + 0.5) / outH - 0.5) * -2;
    const radius2 = centeredX * centeredX + centeredY * centeredY;
    const correction = 1 + distortion * radius2;
    const rayX = centeredX * tanH * correction;
    const z0 = 1;
    const correctedV = centeredY * tanV * correction;

    const rollCos = Math.cos(-cam.roll), rollSin = Math.sin(-cam.roll);
    const x1 = rayX * rollCos - correctedV * rollSin;
    const y1 = rayX * rollSin + correctedV * rollCos;
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
      const sourceX = ((sourceU % 1) + 1) % 1 * W;
      const lat = Math.asin(y2 / len);
      const sourceV = 0.5 - lat / Math.PI;
      minV = Math.min(minV, sourceV);
      maxV = Math.max(maxV, sourceV);
      const sourceY = sourceV * H;
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
  let { imgW, imgH } = payload;
  if (!imgW) ({ imgW, imgH } = (await probeSize(pano)) || {});
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

  const d = panoDims(imgW, imgH, Math.max(0, Math.min(MAX_ZOOM, zoom | 0)));
  const report = (phase, done, total) =>
    chrome.runtime.sendMessage({ target: 'content', tabId, reqId, phase, done, total }).catch(() => {});

  const region = mode === 'pano'
    ? { ...d, x0: 0, y0: 0, width: d.W, height: d.H }
    : buildRegion(camera, outW, outH, d);

  report('fetch', 0, 1);
  const { canvas, missing, total: tiles } = await stitch(pano, region, (d, t) => report('fetch', d, t));

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