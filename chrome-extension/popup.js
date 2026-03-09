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

// Initialize popup
document.addEventListener('DOMContentLoaded', init);

async function init() {
  showView('loading');

  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATUS' });

    if (response.isAuthenticated) {
      showDashboard(response.userData);
      // Check and update recording state
      updateRecordingButton();
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

async function updateRecordingButton() {
  try {
    await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATUS' });

    // Always show manual recording button (no toggle state needed)
    recordBtn.classList.remove('recording');
    recordBtn.innerHTML = '<span class="record-icon">●</span> Manual Recording';
  } catch (error) {
    console.error('Error getting recording status:', error);
  }
}

function getInitials(name) {
  const parts = name.split(' ');
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
}

function showLoading() {
  showView('loading');
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
  try {
    // Show recording state
    recordBtn.disabled = true;
    recordBtn.classList.add('recording');
    recordBtn.innerHTML = '<span class="record-icon">●</span> Recording in progress...';

    // Trigger recording (scan and download) - don't wait for response
    chrome.runtime.sendMessage({ type: 'TOGGLE_RECORDING' }).catch(err => {
      console.error('Recording error:', err);
      // Reset on error
      recordBtn.disabled = false;
      recordBtn.classList.remove('recording');
      recordBtn.innerHTML = '<span class="record-icon">●</span> Manual Recording';
    });

    // Wait briefly then reset button (recording happens in content script)
    setTimeout(() => {
      recordBtn.disabled = false;
      recordBtn.classList.remove('recording');
      recordBtn.innerHTML = '<span class="record-icon">●</span> Manual Recording';
    }, 1500);
  } catch (error) {
    console.error('Recording error:', error);
    recordBtn.disabled = false;
    recordBtn.classList.remove('recording');
    recordBtn.innerHTML = '<span class="record-icon">●</span> Manual Recording';
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
