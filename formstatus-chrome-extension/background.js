// FormStatus Chrome Extension - Background Service Worker

const DEFAULT_API_URL = 'https://app.formstatus.co';
let API_BASE_URL = DEFAULT_API_URL;

async function loadApiUrl() {
  const result = await chrome.storage.local.get(['fs_api_url']);
  API_BASE_URL = result.fs_api_url || DEFAULT_API_URL;
}

loadApiUrl();

// Extension state
let isAuthenticated = false;
let userData = null;
let authToken = null;
let isRecording = false;
let recordingTabId = null;
let authReady = null;

// Initialize extension
chrome.runtime.onInstalled.addListener((details) => {
  console.log('FormStatus extension installed:', details.reason);
  if (details.reason === 'install') {
    clearCookies();
  }
  authReady = checkAuthStatus();
});

chrome.runtime.onStartup.addListener(() => {
  authReady = checkAuthStatus();
});

// Check authentication status on startup
async function checkAuthStatus() {
  try {
    const result = await chrome.storage.local.get(['isAuthenticated', 'userData', 'authToken']);
    isAuthenticated = result.isAuthenticated || false;
    userData = result.userData || null;
    authToken = result.authToken || null;

    if (isAuthenticated && authToken) {
      const verifyResult = await verifySession();
      if (verifyResult === 'invalid') {
        await clearAuth();
      }
    }

    updateBadge();
  } catch (error) {
    console.error('Error checking auth status:', error);
  }
}

// Verify token with server
async function verifySession() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${API_BASE_URL}/api/extension/user`, {
      method: 'GET',
      credentials: 'omit',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${authToken}`
      }
    });

    clearTimeout(timeoutId);

    if (response.status === 401) {
      return 'invalid';
    }

    return response.ok ? 'valid' : 'unknown';
  } catch (error) {
    console.warn('Session verification failed (network error), keeping session:', error.message);
    return 'unknown';
  }
}

// Handle authentication from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'LOGIN') {
    handleLogin(request.credentials).then(sendResponse);
    return true; // async response
  }

  if (request.type === 'LOGOUT') {
    handleLogout().then(sendResponse);
    return true;
  }

  if (request.type === 'GET_AUTH_STATUS') {
    (async () => {
      if (authReady) {
        await authReady;
      }
      if (!isAuthenticated) {
        const result = await chrome.storage.local.get(['isAuthenticated', 'userData', 'authToken']);
        isAuthenticated = result.isAuthenticated || false;
        userData = result.userData || null;
        authToken = result.authToken || null;
      }
      sendResponse({
        isAuthenticated,
        userData,
        isRecording
      });
    })();
    return true;
  }

  if (request.type === 'OPEN_DASHBOARD') {
    chrome.tabs.create({ url: `${API_BASE_URL}/dashboard` });
    sendResponse({ success: true });
    return true;
  }

  if (request.type === 'TOGGLE_RECORDING') {
    handleToggleRecording().then(sendResponse);
    return true;
  }

  if (request.type === 'GET_API_URL') {
    sendResponse({ url: API_BASE_URL });
    return true;
  }

  if (request.type === 'SET_API_URL') {
    (async () => {
      API_BASE_URL = request.url;
      await chrome.storage.local.set({ fs_api_url: request.url });
      sendResponse({ success: true, url: API_BASE_URL });
    })();
    return true;
  }
});

// Handle login
async function handleLogin(credentials) {
  try {
    const loginResponse = await fetch(`${API_BASE_URL}/api/extension/login`, {
      method: 'POST',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password
      })
    });

    const responseText = await loginResponse.text();

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      console.error('Failed to parse JSON:', e);
      return {
        success: false,
        error: `Server error (HTTP ${loginResponse.status}). Please check your credentials.`
      };
    }

    if (loginResponse.ok && data.success) {
      userData = data.user;
      authToken = data.token;
      isAuthenticated = true;

      await chrome.storage.local.set({
        isAuthenticated: true,
        userData: userData,
        authToken: authToken
      });

      updateBadge();

      // Bridge to website: write the web session cookies directly into the
      // browser's main cookie jar (no tab opened). This sidesteps cookie-store
      // partitioning that would otherwise isolate extension-set cookies.
      if (data.exchange_code) {
        seedWebSession(data.exchange_code);
      }

      return {
        success: true,
        userData: userData
      };
    }

    return {
      success: false,
      error: data.message || 'Login failed. Please check your credentials.'
    };
  } catch (error) {
    console.error('Login error:', error);
    return {
      success: false,
      error: `Network error: ${error.message}`
    };
  }
}

// Handle logout
async function handleLogout() {
  try {
    await fetch(`${API_BASE_URL}/api/extension/logout`, {
      method: 'POST',
      credentials: 'omit',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${authToken}`
      }
    });
  } catch (error) {
    console.error('Logout error:', error);
  }

  await clearAuth();

  // Also log out any open FS site tabs. Without this, the site tab keeps
  // the user logged in (Inertia state) and ExtensionBridge re-sends
  // SITE_LOGIN on the next render, undoing the extension logout.
  await logoutSiteTabs();

  return { success: true };
}

// Destroy the web session on every open FS site tab by calling /logout
// from within the tab's own context (same-origin, sends the real session
// cookie). The tab then reloads to reflect the logged-out state.
async function logoutSiteTabs() {
  try {
    const origin = new URL(API_BASE_URL).origin;
    const tabs = await chrome.tabs.query({ url: `${origin}/*` });

    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async () => {
            // Same-origin: the browser attaches the session cookie automatically.
            await fetch('/logout', { credentials: 'include' });
            window.location.reload();
          },
        });
      } catch (e) {
        // Tab may be a chrome:// page or otherwise not scriptable; skip it.
        console.warn('[FormStatus BG] could not script tab', tab.id, ':', e.message);
      }
    }
  } catch (e) {
    console.warn('[FormStatus BG] logoutSiteTabs failed:', e.message);
  }
}

// Bridge extension login -> website session, without opening a tab.
//
// Cookie-store partitioning means a fetch from the extension's service worker
// can't set cookies in the browser's main jar, and we can't read Set-Cookie
// headers from fetch responses. So we ask the backend for the raw encrypted
// cookie values (exchange-for-cookies), then write them via the privileged
// chrome.cookies.set() API, which writes to the main jar regardless of
// partitioning.
async function seedWebSession(exchangeCode) {
  try {
    const resp = await fetch(
      `${API_BASE_URL}/api/extension/exchange-for-cookies?code=${encodeURIComponent(exchangeCode)}`,
      {
        method: 'GET',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
      }
    );

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.success || !data.cookies) {
      return;
    }

    const attrs = data.cookie_attributes || {};
    const expirationDate = Math.floor(Date.now() / 1000) + (attrs.expiration_minutes || 120) * 60;
    const isHttps = API_BASE_URL.startsWith('https://');
    const cookieUrl = API_BASE_URL;

    for (const [name, value] of Object.entries(data.cookies)) {
      try {
        await chrome.cookies.set({
          url: cookieUrl,
          name,
          value,
          path: attrs.path || '/',
          secure: isHttps,
          httpOnly: name !== 'XSRF-TOKEN',
          sameSite: 'lax',
          expirationDate,
        });
      } catch (e) {
        console.warn(`[FormStatus BG] chrome.cookies.set failed for ${name}:`, e.message);
      }
    }
  } catch (e) {
    console.warn('FormStatus: seedWebSession failed:', e.message);
  }
}

// Clear authentication data
async function clearAuth() {
  isAuthenticated = false;
  userData = null;
  authToken = null;

  await chrome.storage.local.remove(['isAuthenticated', 'userData', 'authToken']);
  
  await clearCookies();

  updateBadge();
}

async function clearCookies() {
  try {
    // Use `url` filter (not `domain`) so we match exactly the cookies that
    // seedWebSession wrote via chrome.cookies.set({ url: API_BASE_URL, ... }).
    // The `domain` filter behaves differently for localhost and can miss cookies.
    const cookies = await chrome.cookies.getAll({ url: API_BASE_URL });

    for (const cookie of cookies) {
      const removeUrl = API_BASE_URL.replace(/\/$/, '') + (cookie.path || '/');
      await chrome.cookies.remove({ url: removeUrl, name: cookie.name });
    }
  } catch (error) {
    console.error('[FormStatus BG] clearCookies error:', error);
  }
}

// Update extension badge based on auth status
function updateBadge() {
  if (isAuthenticated) {
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeTextColor({ color: '#ffffff' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// Set up periodic auth check
chrome.alarms.create('checkAuth', { periodInMinutes: 30 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkAuth') {
    checkAuthStatus();
  }
});

// Handle toggle recording
async function handleToggleRecording() {
  // Get the active tab and send recording command
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (activeTab) {
    try {
      await chrome.tabs.sendMessage(activeTab.id, { type: 'START_RECORDING' });
      return { success: true };
    } catch (e) {
      console.error('FormStatus: Error sending message to active tab', e);
      return { success: false, error: 'Could not communicate with tab' };
    }
  }

  return { success: false, error: 'No active tab' };
}

// Listen for recording state changes from content script
chrome.runtime.onMessage.addListener((request, sender) => {
  if (request.type === 'RECORDING_STATE_CHANGED') {
    isRecording = request.isRecording;
    recordingTabId = request.isRecording
      ? (sender.tab && sender.tab.id) || recordingTabId
      : null;

    if (isRecording) {
      chrome.action.setBadgeText({ text: 'REC' });
      chrome.action.setBadgeTextColor({ color: '#ffffff' });
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    } else {
      updateBadge();
    }
  }
  return true;
});

// Re-inject content script after navigation within the recording tab (multi-page forms)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (recordingTabId !== tabId) return;
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || /^(chrome|edge|about|chrome-extension):/i.test(tab.url)) return;

  chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  }).catch((e) => {
    console.warn('FormStatus: Could not re-inject content script on navigation:', e.message);
  });
});

// Reset recording state if the recording tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (recordingTabId === tabId) {
    recordingTabId = null;
    isRecording = false;
    updateBadge();
  }
});

// ==================== Site <-> Extension auth sync ====================
//
// The website (app.formstatus.co and friends) sends messages here via
// chrome.runtime.sendMessage(EXTENSION_ID, ...). We accept two message types:
//   - SITE_LOGIN  { code }  : swap a one-time code for a bearer token
//   - SITE_LOGOUT           : clear extension auth state
//
// The reverse direction (extension -> site) is not supported: due to cookie
// store partitioning, the extension cannot reliably seed a web session in
// the browser's main cookie jar. Site-initiated login/logout is the only
// sync direction.

const ALLOWED_EXTERNAL_ORIGINS = new Set([
  'https://app.formstatus.co',
  'https://stg-app.formstatus.co',
  'https://dev-app.formstatus.co',
  'http://localhost:8080',
]);

chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
  if (!ALLOWED_EXTERNAL_ORIGINS.has(sender.origin)) {
    return false; // unauthorized origin; ignore
  }

  (async () => {
    try {
      if (request.type === 'SITE_LOGIN' && request.code) {
        // Adopt the site's environment so we exchange against the correct
        // backend (e.g., localhost in dev, app.formstatus.co in prod).
        if (request.apiUrl && /^http:\/\/localhost|^https:\/\/.*\.formstatus\.(co|test)/i.test(request.apiUrl)) {
          if (API_BASE_URL !== request.apiUrl) {
            API_BASE_URL = request.apiUrl;
            await chrome.storage.local.set({ fs_api_url: API_BASE_URL });
          }
        }

        const resp = await fetch(`${API_BASE_URL}/api/extension/exchange-token`, {
          method: 'POST',
          credentials: 'omit',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({ code: request.code })
        });

        const data = await resp.json().catch(() => ({}));

        if (resp.ok && data.success && data.token) {
          userData = data.user;
          authToken = data.token;
          isAuthenticated = true;

          await chrome.storage.local.set({
            isAuthenticated: true,
            userData: userData,
            authToken: authToken
          });

          updateBadge();
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, message: data.message || 'Code exchange failed.' });
        }
      } else if (request.type === 'SITE_LOGOUT') {
        // Revoke the extension bearer token (best effort) and clear local state.
        try {
          if (authToken) {
            await fetch(`${API_BASE_URL}/api/extension/logout`, {
              method: 'POST',
              credentials: 'omit',
              headers: {
                'Accept': 'application/json',
                'Authorization': `Bearer ${authToken}`
              }
            });
          }
        } catch (e) {
          // ignore network errors; the site initiated this logout already
        }
        await clearAuth();
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, message: 'Unknown message type.' });
      }
    } catch (e) {
      console.error('FormStatus: external message handler error:', e);
      sendResponse({ success: false, error: e.message });
    }
  })();

  return true; // keep the message channel open for the async sendResponse
});
