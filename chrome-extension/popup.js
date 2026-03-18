// FormStatus Chrome Extension - Popup Script

// DOM Elements
const loginView = document.getElementById('loginView');
const dashboardView = document.getElementById('dashboardView');
const loadingView = document.getElementById('loadingView');
const loginForm = document.getElementById('loginForm');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('loginBtn');
const errorMessage = document.getElementById('errorMessage');
const userEmail = document.getElementById('userEmail');
const userInitials = document.getElementById('userInitials');
const recordBtn = document.getElementById('recordBtn');
const logoutBtn = document.getElementById('logoutBtn');
const openDashboardBtn = document.getElementById('openDashboardBtn');

// Track recording state
let isRecording = false;

// Initialize popup
document.addEventListener('DOMContentLoaded', init);

async function init() {
  showView('loading');

  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATUS' });

    if (response.isAuthenticated) {
      showDashboard(response.userData);
      // Check recording state from content script
      await checkRecordingState();
    } else {
      showLogin();
    }
  } catch (error) {
    console.error('Error getting auth status:', error);
    showLogin();
  }

  // Event listeners
  loginForm.addEventListener('submit', handleLogin);
  recordBtn.addEventListener('click', handleRecord);
  logoutBtn.addEventListener('click', handleLogout);
  openDashboardBtn.addEventListener('click', handleOpenDashboard);
}

// Check if recording is active
async function checkRecordingState() {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      const response = await chrome.tabs.sendMessage(activeTab.id, { type: 'GET_RECORDING_STATUS' }).catch(() => null);
      if (response && response.isRecording) {
        setRecordingState(true);
      }
    }
  } catch (error) {
    // Tab might not be ready, ignore
  }
}

function showView(viewName) {
  loginView.style.display = 'none';
  dashboardView.style.display = 'none';
  loadingView.style.display = 'none';

  switch (viewName) {
    case 'login':
      loginView.style.display = 'block';
      break;
    case 'dashboard':
      dashboardView.style.display = 'block';
      break;
    case 'loading':
      loadingView.style.display = 'block';
      break;
  }
}

function showLogin() {
  showView('login');
  emailInput.value = '';
  passwordInput.value = '';
  hideError();
  emailInput.focus();
}

function showDashboard(userData) {
  showView('dashboard');

  if (userData) {
    userEmail.textContent = userData.email || 'Unknown';
    userInitials.textContent = getInitials(userData.name || userData.email || 'U');
  }
}

function setRecordingState(recording) {
  isRecording = recording;

  if (recording) {
    recordBtn.classList.add('recording');
    recordBtn.innerHTML = '<span class="record-icon">■</span> Stop Recording';
  } else {
    recordBtn.classList.remove('recording');
    recordBtn.innerHTML = '<span class="record-icon">●</span> Manual Recording';
  }
}

function getInitials(name) {
  const parts = name.split(' ');
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
}

async function handleLogin(e) {
  e.preventDefault();

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    showError('Please enter both email and password.');
    return;
  }

  hideError();
  setLoginLoading(true);

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'LOGIN',
      credentials: { email, password }
    });

    if (response.success) {
      showDashboard(response.userData);
    } else {
      showError(response.error || 'Login failed. Please try again.');
    }
  } catch (error) {
    console.error('Login error:', error);
    showError('An unexpected error occurred. Please try again.');
  } finally {
    setLoginLoading(false);
  }
}

async function handleLogout() {
  if (!confirm('Are you sure you want to sign out?')) {
    return;
  }

  try {
    await chrome.runtime.sendMessage({ type: 'LOGOUT' });
    showLogin();
  } catch (error) {
    console.error('Logout error:', error);
  }
}

function handleOpenDashboard() {
  chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
  window.close();
}

async function handleRecord() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!activeTab) {
    showError('No active tab found');
    return;
  }

  try {
    if (isRecording) {
      // Stop recording
      recordBtn.disabled = true;
      recordBtn.innerHTML = '<span class="record-icon">■</span> Stopping...';

      await chrome.tabs.sendMessage(activeTab.id, { type: 'STOP_RECORDING' });
      setRecordingState(false);

      recordBtn.disabled = false;
    } else {
      // Start recording
      recordBtn.disabled = true;
      recordBtn.innerHTML = '<span class="record-icon">●</span> Starting...';

      await chrome.tabs.sendMessage(activeTab.id, { type: 'START_RECORDING' });
      setRecordingState(true);

      // Keep button enabled so user can stop
      recordBtn.disabled = false;
    }
  } catch (error) {
    console.error('Recording error:', error);
    // Reset on error
    setRecordingState(false);
    recordBtn.disabled = false;
  }
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.style.display = 'block';
}

function hideError() {
  errorMessage.style.display = 'none';
}

function setLoginLoading(isLoading) {
  const btnText = loginBtn.querySelector('.btn-text');
  const btnLoader = loginBtn.querySelector('.btn-loader');

  if (isLoading) {
    loginBtn.disabled = true;
    btnText.style.display = 'none';
    btnLoader.style.display = 'inline-flex';
  } else {
    loginBtn.disabled = false;
    btnText.style.display = 'inline';
    btnLoader.style.display = 'none';
  }
}

// Listen for recording state changes from content script
chrome.runtime.onMessage.addListener((request) => {
  if (request.type === 'RECORDING_STATE_CHANGED') {
    setRecordingState(request.isRecording);
  }
  return true;
});