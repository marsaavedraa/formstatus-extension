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

// Scan all forms on the page and report to background
function scanAndReportForms() {
  const forms = document.querySelectorAll('form');
  const formsData = {
    url: window.location.href,
    domain: window.location.hostname,
    timestamp: new Date().toISOString(),
    forms: []
  };

  forms.forEach((form) => {
    const formInfo = {
      id: getFormId(form),
      action: form.action || window.location.href,
      method: form.method || 'GET',
      fields: []
    };

    // Get all form fields
    const fields = form.querySelectorAll('input, select, textarea');
    fields.forEach((field) => {
      // Skip invisible/internal fields
      const fieldType = field.type || 'text';
      const fieldClass = field.className || '';

      // Only skip hidden fields (keep submit buttons and other visible fields)
      if (fieldType === 'hidden') {
        return;
      }

      // Skip fields with "hidden" in their class name
      if (fieldClass.toLowerCase().includes('hidden')) {
        return;
      }

      // Skip fields that are not visible via CSS
      const style = window.getComputedStyle(field);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return;
      }

      const fieldInfo = {
        name: field.name || field.id || '',
        type: field.type || 'text',
        required: field.required || false,
        label: getFieldLabel(field),
        placeholder: field.placeholder || '',
        id: field.id || '',
        class: field.className || '',
        options: []
      };

      // Get options for select elements
      if (field.tagName === 'SELECT') {
        field.querySelectorAll('option').forEach((option) => {
          if (option.value) {
            fieldInfo.options.push({
              value: option.value,
              text: option.text
            });
          }
        });
      }

      // Get checked state for checkboxes/radios
      if (fieldType === 'checkbox' || fieldType === 'radio') {
        fieldInfo.checked = field.checked;
      }

      // Skip sensitive fields in reporting
      if (!isSensitiveField(fieldInfo.name) && fieldInfo.name) {
        formInfo.fields.push(fieldInfo);
      }
    });

    if (formInfo.fields.length > 0) {
      formsData.forms.push(formInfo);
    }
  });

  console.log('FormStatus: Scanned forms', formsData);
  return formsData;
}

// Download forms data as JSON file
function downloadFormsAsJSON(formsData) {
  // Create a clean JSON structure
  const cleanData = {
    url: formsData.url,
    domain: formsData.domain,
    timestamp: formsData.timestamp,
    forms: formsData.forms.map(form => ({
      id: form.id,
      action: form.action,
      method: form.method,
      field_count: form.fields.length,
      fields: form.fields.map(field => ({
        name: field.name,
        type: field.type,
        required: field.required,
        label: field.label,
        placeholder: field.placeholder,
        id: field.id,
        class: field.class,
        options: field.options.length > 0 ? field.options : undefined
      }))
    }))
  };

  const jsonString = JSON.stringify(cleanData, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  // Generate filename based on domain and timestamp
  const domain = formsData.domain.replace(/[^a-z0-9]/gi, '_');
  const timestamp = new Date().getTime();
  const filename = `formstatus_${domain}_${timestamp}.json`;

  // Create download link and trigger download
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  console.log('FormStatus: Downloaded forms JSON', filename);
}

// Get the label for a field
function getFieldLabel(field) {
  // Try to find associated label
  if (field.id) {
    const label = document.querySelector(`label[for="${field.id}"]`);
    if (label) return label.textContent.trim();
  }

  // Try to find parent label
  const parentLabel = field.closest('label');
  if (parentLabel) {
    // Exclude the field's own value from the label text
    return parentLabel.textContent.replace(field.value || '', '').trim();
  }

  // Try placeholder
  if (field.placeholder) return field.placeholder;

  // Use name or ID as fallback
  return field.name || field.id || '';
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

  if (request.type === 'START_RECORDING') {
    console.log('FormStatus: Starting manual recording');
    isMonitoring = true;
    const formsData = scanAndReportForms();
    downloadFormsAsJSON(formsData);
    initFormMonitoring();
    sendResponse({ success: true, forms: formsData });
    return true;
  }

  if (request.type === 'STOP_RECORDING') {
    console.log('FormStatus: Stopping manual recording');
    isMonitoring = false;
    monitoredForms.clear();
    sendResponse({ success: true });
    return true;
  }

  return true;
});
