// FormStatus Chrome Extension - Content Script
// This script runs on web pages to monitor forms

let isMonitoring = false;
let monitoredForms = new Set();

// Check if user is authenticated before monitoring forms
async function checkAuthAndInit() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATUS' });

    if (response.isAuthenticated && response.userData) {
      initFormMonitoring();
    }
  } catch (error) {
    console.log('FormStatus: Not authenticated, skipping form monitoring');
  }
}

// Initialize form monitoring
function initFormMonitoring() {
  if (isMonitoring) return;

  console.log('FormStatus: Initializing form monitoring');
  isMonitoring = true;

  // Monitor existing forms
  document.querySelectorAll('form').forEach(monitorForm);

  // Observe DOM changes for dynamically added forms
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // Check if the added node is a form or contains forms
          if (node.tagName === 'FORM') {
            monitorForm(node);
          } else {
            node.querySelectorAll?.('form').forEach(monitorForm);
          }
        }
      });
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

// Monitor a single form
function monitorForm(form) {
  const formId = getFormId(form);

  if (monitoredForms.has(formId)) return;

  monitoredForms.add(formId);

  console.log('FormStatus: Monitoring form', formId);

  // Track form submissions
  form.addEventListener('submit', async (e) => {
    await handleFormSubmit(form, formId);
  });

  // Track form interactions (optional - for analytics)
  form.addEventListener('input', debounce(() => {
    trackFormInteraction(form, formId);
  }, 1000));
}

// Get a unique identifier for a form
function getFormId(form) {
  if (form.id) return `#${form.id}`;
  if (form.name) return `[name="${form.name}"]`;
  if (form.action) return form.action;
  if (form.classList.length > 0) {
    return `.${Array.from(form.classList).join('.')}`;
  }

  // Generate a unique ID based on position
  const forms = Array.from(document.querySelectorAll('form'));
  const index = forms.indexOf(form);
  return `form-${index}`;
}

// Handle form submission
async function handleFormSubmit(form, formId) {
  console.log('FormStatus: Form submitted', formId);

  const formData = new FormData(form);
  const data = {};

  for (const [key, value] of formData.entries()) {
    // Don't include sensitive fields
    if (!isSensitiveField(key)) {
      data[key] = value;
    }
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'FORM_SUBMIT',
      data: {
        formId,
        url: window.location.href,
        timestamp: Date.now(),
        fields: Object.keys(data).length
      }
    });

    if (response.success) {
      console.log('FormStatus: Submission tracked');
    }
  } catch (error) {
    console.error('FormStatus: Error tracking submission', error);
  }
}

// Track form interaction
async function trackFormInteraction(form, formId) {
  // Send interaction data (debounced)
  console.log('FormStatus: Form interaction', formId);
}

// Check if a field name suggests sensitive data
function isSensitiveField(fieldName) {
  const sensitive = [
    'password', 'pass', 'pwd',
    'credit', 'card', 'cvv', 'cvc',
    'ssn', 'social',
    'token', 'secret'
  ];

  const lower = fieldName.toLowerCase();
  return sensitive.some(s => lower.includes(s));
}

// Debounce utility
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkAuthAndInit);
} else {
  checkAuthAndInit();
}

// Listen for auth state changes
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'AUTH_STATE_CHANGED') {
    if (request.isAuthenticated) {
      initFormMonitoring();
    } else {
      // Stop monitoring if logged out
      isMonitoring = false;
      monitoredForms.clear();
    }
  }
  return true;
});
