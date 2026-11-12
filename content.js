(() => {
  if (window.__svsLoaded) return;
  window.__svsLoaded = true;

  let reqId = 0;
  let busy = false;
  let lastUrl = '';
  let centreLookupPano = '';
  let centreLookupToken = 0;
  let panoSize = null;

  const fab = document.createElement('button');
  fab.id = 'svs-fab';
  fab.textContent = '⤓';
  fab.title = 'Capture Street View';

  const panel = document.createElement('div');
  panel.id = 'svs-panel';
  panel.innerHTML = `
    <h1>Street View Capture</h1>
    <label>Panorama ID</label>
    <input id="svs-pano" type="text" spellcheck="false">
    <label>Heading <span class="svs-val" id="svs-yawv">0</span>°</label>
    <input id="svs-yaw" type="range" min="0" max="360" value="0">
    <label>Panorama centre heading <span class="svs-val" id="svs-centrev">-106</span>°</label>
    <input id="svs-centre" type="number" min="-180" max="180" step="1" value="-106">
    <label>Pitch <span class="svs-val" id="svs-pitchv">-5</span>°</label>
    <input id="svs-pitch" type="range" min="-80" max="80" value="-5">
    <label>Roll <span class="svs-val" id="svs-rollv">0</span>°</label>
    <input id="svs-roll" type="range" min="-45" max="45" value="0">
    <label>Field of view <span class="svs-val" id="svs-fovv">90</span>°</label>
    <input id="svs-fov" type="range" min="30" max="110" value="90">
    <label>Tile quality</label>
    <select id="svs-zoom">
      <option value="2">Low (fast)</option>
      <option value="3" selected>Normal</option>
      <option value="4">High</option>
      <option value="5">Maximum</option>
    </select>
    <label>Output size</label>
    <select id="svs-size">
      <option value="1920x1080" selected>1920 × 1080</option>
      <option value="2560x1440">2560 × 1440</option>
      <option value="3840x2160">3840 × 2160</option>
    </select>
    <div class="svs-row">
      <button id="svs-go">Capture 16:9</button>
      <button id="svs-raw">Panorama</button>
    </div>
    <div id="svs-bar"><i></i></div>
    <div id="svs-status"></div>
  `;

  const $ = (id) => panel.querySelector('#' + id);
  const statusEl = $('svs-status');
  const barEl = panel.querySelector('#svs-bar > i');
  const goBtn = $('svs-go');
  const rawBtn = $('svs-raw');
  const SETTINGS_KEY = 'streetViewSettings';
  const settingIds = ['svs-pitch', 'svs-roll', 'svs-fov', 'svs-zoom', 'svs-size'];

  function mount() {
    if (!document.body.contains(fab)) {
      document.body.append(fab, panel);
    }
  }

  function setStatus(text, isError) {
    statusEl.textContent = text || '';
    statusEl.classList.toggle('err', !!isError);
    if (!text) barEl.style.width = '0%';
  }

  function inStreetView() {
    const u = location.href;
    return /\/maps\//.test(location.pathname) && /(!1s[A-Za-z0-9_-]{20,}|[?&]pano=)/.test(u);
  }

  function readState() {
    const u = location.href;
    const pano =
      u.match(/!1s([A-Za-z0-9_-]{20,})/)?.[1] ||
      new URLSearchParams(location.search).get('pano') ||
      '';
    const cam = u.match(/@(-?[\d.]+),(-?[\d.]+),\d+a,(-?[\d.]+)y,(-?[\d.]+)h,(-?[\d.]+)t/);
    const state = {
      pano,
      pitch: cam ? parseFloat(cam[5]) - 90 : null,
      yaw: cam ? parseFloat(cam[4]) : null,
      fov: cam ? parseFloat(cam[3]) : null
    };
    console.debug('[Street View Stitcher] Camera URL state', {
      href: u,
      matched: !!cam,
      match: cam?.[0] || null,
      fields: cam ? {
        fovY: cam[3],
        headingH: cam[4],
        tiltT: cam[5],
        signedPitch: state.pitch
      } : null,
      state
    });
    return state;
  }

  const DEG = Math.PI / 180;
  const norm360 = (heading) => ((heading % 360) + 360) % 360;

  function readCamera(
    manualHeading,
    manualCentreHeading,
    manualPitch,
    manualFov,
    manualRoll,
    outW,
    outH
  ) {
    const hfov = Number.isFinite(manualFov) ? manualFov * DEG : 90 * DEG;
    const vfov = 2 * Math.atan(Math.tan(hfov / 2) * (outH / outW));
    const limit = Math.max(0, Math.PI / 2 - vfov / 2);
    const pitchDegrees = Number.isFinite(manualPitch) ? manualPitch : 0;
    const pitch = Math.max(-limit, Math.min(limit, pitchDegrees * DEG));
    return {
      yaw: norm360(
        (Number.isFinite(manualHeading) ? manualHeading : 0) -
        (Number.isFinite(manualCentreHeading) ? manualCentreHeading : 0)
      ) * DEG,
      pitch,
      roll: Math.max(-45, Math.min(45, manualRoll)) * DEG,
      hfov
    };
  }

  function syncFromUrl() {
    if (busy) return;
    const s = readState();
    console.debug('[Street View Stitcher] Syncing camera controls', {
      yaw: s.yaw,
      pitch: s.pitch,
      yawFocused: document.activeElement === $('svs-yaw'),
      pitchFocused: document.activeElement === $('svs-pitch'),
      currentYaw: $('svs-yaw').value,
      currentPitch: $('svs-pitch').value
    });
    const panoInput = $('svs-pano');
    if (s.pano) {
      if (document.activeElement !== panoInput) panoInput.value = s.pano;
      if (s.pano !== centreLookupPano) {
        centreLookupPano = s.pano;
        const token = ++centreLookupToken;
        console.info('[Street View Stitcher] New panorama detected', { pano: s.pano, token });
        lookupCentreHeading(s.pano, token);
      }
    }

    async function lookupCentreHeading(pano, token) {
      panoSize = null;
      const url =
        'https://www.google.com/maps/photometa/v1?authuser=0&hl=en&pb=' +
        '!1m4!1smaps_sv.tactile!11m2!2m1!1b1!2m2!1sen!2sus!3m3!1m2!1e2!2s' +
        encodeURIComponent(pano) +
        '!4m57!1e1!1e2!1e3!1e4!1e5!1e6!1e8!1e12!2m1!1e1!4m1!1i48!5m1!1e1' +
        '!5m1!1e2!6m1!1e1!6m1!1e2!9m36!1m3!1e2!2b1!3e2!1m3!1e2!2b0!3e3' +
        '!1m3!1e3!2b1!3e2!1m3!1e3!2b0!3e3!1m3!1e8!2b0!3e3!1m3!1e1!2b0' +
        '!3e3!1m3!1e4!2b0!3e3!1m3!1e10!2b1!3e2!1m3!1e10!2b0!3e3';
      try {
        console.info('[Street View Stitcher] Looking up panorama centre heading', { pano, token });
        const response = await fetch(url, { credentials: 'omit' });
        if (!response.ok) {
          console.warn('[Street View Stitcher] PhotoMeta request failed; keeping manual centre heading', {
            pano, token, status: response.status
          });
          return;
        }
        if (token !== centreLookupToken) {
          console.debug('[Street View Stitcher] Ignoring stale PhotoMeta response', { pano, token });
          return;
        }
        const text = await response.text();
        console.debug('[Street View Stitcher] PhotoMeta response received', {
          pano,
          token,
          bytes: text.length,
          preview: text.slice(0, 300)
        });
        let metadata;
        try {
          metadata = JSON.parse(text.replace(/^\)\]\}'\s*/, ''));
        } catch (e) {
          console.warn('[Street View Stitcher] PhotoMeta was not valid JSON; keeping manual centre heading', {
            pano, token, error: e
          });
          return;
        }
        if (token !== centreLookupToken) {
          console.debug('[Street View Stitcher] Ignoring stale PhotoMeta response', { pano, token });
          return;
        }
        const sz = metadata?.[1]?.[0]?.[2]?.[2];
        if (Array.isArray(sz) && sz[0] > 0 && sz[1] > 0) panoSize = { pano, w: sz[1], h: sz[0] };
        console.info('[Street View Stitcher] Pano size', sz);
        const panoHeading = metadata?.[1]?.[0]?.[5]?.[0]?.[1]?.[2]?.[0];
        if (!Number.isFinite(panoHeading)) {
          console.warn('[Street View Stitcher] PhotoMeta has no positional panorama heading; keeping manual centre heading', {
            pano, token
          });
          return;
        }
        if (token !== centreLookupToken) {
          console.debug('[Street View Stitcher] Ignoring stale PhotoMeta response', { pano, token });
          return;
        }
        const centre = norm360(panoHeading);
        if (!Number.isFinite(centre)) {
          console.warn('[Street View Stitcher] Invalid positional panorama heading; keeping manual centre heading', {
            pano, token, value: panoHeading
          });
          return;
        }
        $('svs-centre').value = Math.round(centre);
        $('svs-centrev').textContent = $('svs-centre').value;
        console.info('[Street View Stitcher] Applied panorama centre heading', {
          pano,
          token,
          panoYaw: panoHeading,
          centreHeading: $('svs-centre').value,
          currentPitch: $('svs-pitch').value,
          currentUrlState: readState()
        });
      } catch (e) {
        console.warn('[Street View Stitcher] Panorama centre heading metadata unavailable; keeping manual centre heading', {
          pano, token, error: e
        });
      }
    }
    if (s.yaw != null && document.activeElement !== $('svs-yaw')) {
      $('svs-yaw').value = Math.round(s.yaw) % 360;
      $('svs-yawv').textContent = $('svs-yaw').value;
      console.debug('[Street View Stitcher] Applied automatic heading', { value: $('svs-yaw').value });
    }
    if (s.pitch != null && document.activeElement !== $('svs-pitch')) {
      const pitch = Math.max(-80, Math.min(80, s.pitch));
      $('svs-pitch').value = Math.round(pitch);
      $('svs-pitchv').textContent = $('svs-pitch').value;
      console.debug('[Street View Stitcher] Applied automatic pitch', {
        rawUrlTilt: s.pitch + 90,
        signedUrlPitch: s.pitch,
        sliderRange: { min: -80, max: 80 },
        clamped: pitch,
        value: $('svs-pitch').value,
        atSliderLimit: Math.abs(pitch) === 80
      });
    } else if (s.pitch == null) {
      console.warn('[Street View Stitcher] Could not auto-adjust pitch: camera URL did not match pitch format', {
        href: location.href
      });
    }
  }

  function getSettings() {
    return Object.fromEntries(settingIds.map((id) => [
      id,
      $(id).type === 'checkbox' ? $(id).checked : $(id).value
    ]));
  }

  async function saveSettings() {
    try {
      await chrome.storage.local.set({ [SETTINGS_KEY]: getSettings() });
    } catch (e) {
      console.error('Unable to save Street View settings', e);
    }
  }

  async function restoreSettings() {
    try {
      const result = await chrome.storage.local.get(SETTINGS_KEY);
      const saved = result?.[SETTINGS_KEY];
      if (!saved || typeof saved !== 'object') return;
      for (const id of settingIds) {
        if (!$(id)) continue;
        if ($(id).type === 'checkbox' && typeof saved[id] === 'boolean') {
          $(id).checked = saved[id];
        } else if (typeof saved[id] === 'string') {
          $(id).value = saved[id];
        }
      }
      for (const [id, out] of [['svs-yaw', 'svs-yawv'], ['svs-pitch', 'svs-pitchv'], ['svs-roll', 'svs-rollv'], ['svs-fov', 'svs-fovv']]) {
        $(out).textContent = $(id).value;
      }
      $('svs-centrev').textContent = $('svs-centre').value;
    } catch (e) {
      console.error('Unable to restore Street View settings', e);
    }
  }

  function tick() {
    mount();
    const sv = inStreetView();
    fab.style.display = sv ? '' : 'none';
    if (!sv) panel.classList.remove('open');
    if (location.href !== lastUrl) {
      console.debug('[Street View Stitcher] Maps URL changed', {
        previous: lastUrl,
        current: location.href
      });
      lastUrl = location.href;
      syncFromUrl();
    }
  }

  fab.addEventListener('click', () => {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) syncFromUrl();
  });

  for (const [id, out] of [['svs-yaw', 'svs-yawv'], ['svs-pitch', 'svs-pitchv'], ['svs-roll', 'svs-rollv'], ['svs-fov', 'svs-fovv']]) {
    $(id).addEventListener('input', (e) => {
      if (id === 'svs-yaw') {
        e.target.value = norm360(parseFloat(e.target.value));
      }
      $(out).textContent = e.target.value;
    });
  }
  $('svs-centre').addEventListener('input', (e) => {
    const value = Math.max(-180, Math.min(180, Number(e.target.value) || 0));
    e.target.value = value;
    $('svs-centrev').textContent = value;
  });
  for (const id of settingIds) $(id).addEventListener('input', saveSettings);
  for (const id of ['svs-zoom', 'svs-size']) $(id).addEventListener('change', saveSettings);

  function download(dataUrl, name) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function capture(mode) {
    if (busy) return;
    const pano = $('svs-pano').value.trim();
    if (!pano) { setStatus('No panorama id — pan around in Street View first.', true); return; }

    const [outW, outH] = $('svs-size').value.split('x').map(Number);
    const rawPitch = Number($('svs-pitch').value);
    const id = ++reqId;
    busy = true;
    goBtn.disabled = rawBtn.disabled = true;
    setStatus('Starting…');

    try {
      const camera = readCamera(
        Number($('svs-yaw').value),
        Number($('svs-centre').value),
        rawPitch,
        Number($('svs-fov').value),
        Number($('svs-roll').value),
        outW,
        outH
      );
      console.debug('[Street View Stitcher] Capture control values', {
        heading: $('svs-yaw').value,
        pitch: $('svs-pitch').value,
        rawPitch,
        renderPitchDegrees: camera.pitch / DEG,
        renderPitchLimitDegrees: (Math.PI / 2 -
          (2 * Math.atan(Math.tan(Number($('svs-fov').value) * DEG / 2) * (outH / outW))) / 2) / DEG,
        fov: $('svs-fov').value,
        roll: $('svs-roll').value,
        sourceState: readState()
      });
      console.info('[Street View Stitcher] Capture camera', {
        pano,
        heading: Number($('svs-yaw').value),
        centreHeading: Number($('svs-centre').value),
        relativeYaw: (camera.yaw / DEG).toFixed(2),
        pitch: Number($('svs-pitch').value),
        roll: Number($('svs-roll').value),
        fov: Number($('svs-fov').value)
      });
      console.debug('Street View capture camera', {
        yaw: (camera.yaw / DEG).toFixed(2),
        pitch: (camera.pitch / DEG).toFixed(2),
        roll: (camera.roll / DEG).toFixed(2),
        hfov: (camera.hfov / DEG).toFixed(2),
        centreHeading: Number($('svs-centre').value)
      });
      const res = await chrome.runtime.sendMessage({
        target: 'bg',
        type: 'STITCH',
        payload: {
          reqId: id,
          pano,
          camera,
          zoom: Number($('svs-zoom').value),
          outW,
          outH,
          mode,
          imgW: panoSize?.pano === pano ? panoSize.w : undefined,
          imgH: panoSize?.pano === pano ? panoSize.h : undefined
        }
      });

      if (!res?.ok) throw new Error(res?.error || 'Capture failed.');

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const name = mode === 'pano' ? `streetview-pano-${pano}.png` : `streetview-${pano}-${stamp}.png`;
      download(res.dataUrl, name);

      setStatus(
        `Saved ${mode === 'pano' ? 'panorama' : outW + '×' + outH + ' view'}` +
          (res.missing ? ` · ${res.missing}/${res.tiles} tiles unavailable` : '')
      );
    } catch (e) {
      setStatus(String(e?.message || e), true);
    } finally {
      busy = false;
      goBtn.disabled = rawBtn.disabled = false;
    }
  }

  goBtn.addEventListener('click', () => capture('view'));
  rawBtn.addEventListener('click', () => capture('pano'));
  window.addEventListener('keydown', (e) => {
    if ((e.key && e.key.toLowerCase() !== 'p') || e.code !== 'KeyP' ||
        e.ctrlKey || e.metaKey || e.altKey || e.repeat || busy) return;
    const target = e.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement || target.isContentEditable) return;
    if (!$('svs-pano').value.trim()) return;
    e.preventDefault();
    e.stopPropagation();
    capture('view');
  }, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.target !== 'content' || msg.reqId !== reqId) return;
    if (msg.phase === 'fetch') {
      barEl.style.width = Math.round((msg.done / Math.max(1, msg.total)) * 100) + '%';
      setStatus(`Fetching tiles ${msg.done}/${msg.total}…`);
    } else if (msg.phase === 'render') {
      barEl.style.width = '100%';
      setStatus('Reprojecting…');
    }
  });

  restoreSettings().finally(() => {
    setInterval(tick, 600);
    tick();
  });
})();