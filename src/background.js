/* Draw Over — background. Routes the toolbar button and keyboard commands
 * to the content script, injecting it if the page predates the extension. */
const api = globalThis.chrome || globalThis.browser;   // chrome.* is callback-style in both browsers
const action = api.action || api.browserAction;

function send(tabId, type) {
  return new Promise((resolve, reject) => {
    try {
      api.tabs.sendMessage(tabId, { type }, (res) => {
        const err = api.runtime.lastError;
        err ? reject(new Error(err.message)) : resolve(res);
      });
    } catch (e) { reject(e); }
  });
}

async function inject(tabId) {
  if (api.scripting && api.scripting.executeScript) {
    await api.scripting.executeScript({ target: { tabId, allFrames: false }, files: ['content.js'] });
  } else {
    await api.tabs.executeScript(tabId, { file: 'content.js' });
  }
}

async function dispatch(tab, type) {
  if (!tab || tab.id == null) return;
  try {
    await send(tab.id, type);
  } catch (_) {
    try {
      await inject(tab.id);
      await send(tab.id, type);
    } catch (err) {
      console.warn('Draw Over cannot run on this page:', tab.url, err && err.message);
    }
  }
}

action.onClicked.addListener((tab) => dispatch(tab, 'toggle-overlay'));

function activeTab() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (tabs) => { if (!done) { done = true; resolve((tabs || [])[0]); } };
    const r = api.tabs.query({ active: true, currentWindow: true }, finish);
    if (r && typeof r.then === 'function') r.then(finish, () => finish([]));
  });
}

if (api.commands && api.commands.onCommand) {
  api.commands.onCommand.addListener(async (command) => {
    dispatch(await activeTab(), command);
  });
}

/* Badge mirrors whether the overlay is up on that tab. */
api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'status' || !sender.tab) return;
  const tabId = sender.tab.id;
  try {
    action.setBadgeText({ tabId, text: msg.active ? 'ON' : '' });
    if (action.setBadgeBackgroundColor) action.setBadgeBackgroundColor({ tabId, color: '#0a84ff' });
  } catch (_) {}
});
