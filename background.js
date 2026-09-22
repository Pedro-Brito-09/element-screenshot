// Capture passes, selected by data-element-shot-bg on <html>. USER origin so these beat the
// page's own !important rules.
// - "black" / "white" (shape): only the target and its children are visible and the page is solid
//   black or white. content.js compares both to get exactly what the element paints, as alpha.
//   With the background option on (data-element-shot-box) the target also gets an opaque
//   background, so the shape becomes its whole box (border and rounded corners included).
// - "backdrop" (color, only used with the background option): siblings and unrelated elements are
//   hidden, but the target's ancestors (data-element-shot-path) stay visible, so the element is
//   seen over its real background without overlays such as a modal backdrop.
const SHOT_CSS = `
html[data-element-shot-bg="black"] { background: #000 !important; }
html[data-element-shot-bg="white"] { background: #fff !important; }
html:is([data-element-shot-bg="black"], [data-element-shot-bg="white"]) body,
html:is([data-element-shot-bg="black"], [data-element-shot-bg="white"])
  body *:not([data-element-shot-target]):not([data-element-shot-target] *) {
  visibility: hidden !important;
}
html:is([data-element-shot-bg="black"], [data-element-shot-bg="white"]) [data-element-shot-target] {
  visibility: visible !important;
}
html:is([data-element-shot-bg="black"], [data-element-shot-bg="white"])
  [data-element-shot-target][data-element-shot-box] {
  background-color: #808080 !important;
  background-clip: border-box !important;
}
html[data-element-shot-bg="backdrop"]
  body *:not([data-element-shot-path]):not([data-element-shot-target]):not([data-element-shot-target] *) {
  visibility: hidden !important;
}
html[data-element-shot-bg] *,
html[data-element-shot-bg] *::before,
html[data-element-shot-bg] *::after { transition: none !important; }
`;

const DEFAULT_TITLE = 'Screenshot an element (Alt+Shift+S)';
const attached = new Set();

// Toolbar click or Alt+Shift+S (_execute_action) -> start the picker in the current tab.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (err) {
    // chrome://, the Web Store, the PDF viewer, etc. do not allow scripts.
    console.warn('Element Screenshot: cannot run on this page.', err);
    flashBadge(tab.id);
  }
});

chrome.debugger.onDetach.addListener((source) => attached.delete(source.tabId));

const handlers = {
  // Attach the debugger and re-render the tab at `scale` device pixels per CSS pixel.
  // Width/height 0 = keep the real viewport size, so the layout does not change.
  async begin(tabId, { scale }) {
    const target = { tabId };
    if (!attached.has(tabId)) {
      await chrome.debugger.attach(target, '1.3');
      attached.add(tabId);
    }
    await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
      width: 0, height: 0, deviceScaleFactor: scale, mobile: false,
    });
    await chrome.scripting.insertCSS({ target, css: SHOT_CSS, origin: 'USER' });
  },

  // Whole visible viewport; content.js crops it, measuring the scale from the image itself.
  async capture(tabId) {
    const { data } = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    if (!data) throw new Error('Chrome returned an empty screenshot');
    return { dataUrl: 'data:image/png;base64,' + data };
  },

  async end(tabId) {
    const target = { tabId };
    await chrome.scripting.removeCSS({ target, css: SHOT_CSS, origin: 'USER' }).catch(() => {});
    if (attached.has(tabId)) {
      await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
      await chrome.debugger.detach(target).catch(() => {});
      attached.delete(tabId);
    }
  },

  async download(tabId, { dataUrl, filename }) {
    const id = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    return { id };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg.type];
  const tabId = sender.tab && sender.tab.id;
  if (!handler || tabId == null) return;
  handler(tabId, msg).then(
    (result) => sendResponse(result || {}),
    (err) => sendResponse({ error: err.message || String(err) })
  );
  return true;
});

function flashBadge(tabId) {
  chrome.action.setBadgeBackgroundColor({ color: '#d93025', tabId });
  chrome.action.setBadgeText({ text: '!', tabId });
  chrome.action.setTitle({ title: 'Element Screenshot cannot run on this page', tabId });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '', tabId });
    chrome.action.setTitle({ title: DEFAULT_TITLE, tabId });
  }, 3000);
}
