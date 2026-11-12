let creating = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function offscreenExists() {
  if (chrome.runtime.getContexts) {
    const ctxs = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    return ctxs.length > 0;
  }
  return chrome.offscreen.hasDocument();
}

async function createOffscreen() {
  if (creating) return creating;
  creating = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS', 'DOM_PARSER'],
        justification: 'Fetch, stitch and encode Street View tiles onto a canvas.'
      });
    } catch (e) {
      // benign race: another call won, or it already exists
      if (!/single offscreen/i.test(String(e?.message))) throw e;
    } finally {
      creating = null;
    }
  })();
  return creating;
}

async function ping() {
  try {
    const r = await Promise.race([
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'PING' }),
      sleep(400).then(() => null)
    ]);
    return r?.pong === true;
  } catch {
    return false;
  }
}

async function ensureOffscreen() {
  for (let i = 0; i < 25; i++) {
    if (await ping()) return;
    if (!(await offscreenExists())) await createOffscreen();
    await sleep(120);
  }
  throw new Error(
    'Offscreen document never became ready. Check chrome://extensions → ' +
    'this extension → "Inspect views" for an offscreen.html entry and its console.'
  );
}

async function sendToOffscreen(msg) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await ensureOffscreen();
    try {
      return await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
    } catch (e) {
      if (attempt === 1 || !/Receiving end/i.test(String(e?.message))) throw e;
      await sleep(250); // document died between ping and send — retry once
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'content') {
    if (msg.tabId) chrome.tabs.sendMessage(msg.tabId, msg).catch(() => {});
    return;
  }
  if (msg?.target !== 'bg') return;

  if (msg.type === 'STITCH') {
    const tabId = sender.tab?.id ?? null;
    (async () => {
      try {
        const res = await sendToOffscreen({ ...msg.payload, tabId });
        sendResponse(res);
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
});
