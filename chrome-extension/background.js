// FormStatus Chrome Extension - Background Service Worker

const API_BASE_URL = 'http://localhost:8080';
// const API_BASE_URL = 'https://app.formstatus.co'; // Production

// Extension state
let isAuthenticated = false;
let userData = null;
let authToken = null;
let isRecording = false;

// Initialize extension
chrome.runtime.onInstalled.addListener(() => {
  console.log('FormStatus extension installed');
  checkAuthStatus();
  // Clear any existing cookies on install
  clearCookies();
});

chrome.runtime.onStartup.addListener(() => {
  checkAuthStatus();
});

// Check authentication status on startup
async function checkAuthStatus() {
  try {
    const result = await chrome.storage.local.get(['isAuthenticated', 'userData', 'authToken']);
    isAuthenticated = result.isAuthenticated || false;
    userData = result.userData || null;
    authToken = result.authToken || null;

    // Verify token is still valid
    if (isAuthenticated && authToken) {
      const isValid = await verifySession();
      if (!isValid) {
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
    const response = await fetch(`${API_BASE_URL}/api/extension/user`, {
      method: 'GET',
      credentials: 'omit',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${authToken}`
      }
    });

    return response.ok;
  } catch (error) {
    console.error('Session verification failed:', error);
    return false;
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
    sendResponse({
      isAuthenticated,
      userData,
      isRecording
    });
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
});

// Handle login
async function handleLogin(credentials) {
  try {
    console.log('Attempting login to:', `${API_BASE_URL}/api/extension/login`);
    
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

    console.log('Login response status:', loginResponse.status);
    console.log('Login response ok:', loginResponse.ok);

    // Get response text first
    const responseText = await loginResponse.text();
    console.log('Response text:', responseText.substring(0, 200));

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
  return { success: true };
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

// Clear cookies for localhost
async function clearCookies() {
  try {
    const cookies = await chrome.cookies.getAll({
      domain: 'localhost'
    });

    for (const cookie of cookies) {
      await chrome.cookies.remove({
        url: `${API_BASE_URL}${cookie.path}`,
        name: cookie.name
      });
    }
  } catch (error) {
    console.error('Error clearing cookies:', error);
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
chrome.runtime.onMessage.addListener((request) => {
  if (request.type === 'RECORDING_STATE_CHANGED') {
    isRecording = request.isRecording;

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
