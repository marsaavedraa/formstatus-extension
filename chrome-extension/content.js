// FormStatus Chrome Extension - Content Script
// This script runs on web pages to monitor forms

let isMonitoring = false;
let monitoredForms = new Set();

// Manual recording state
let isManualRecording = false;
let recordedFormData = null; // Stores the form structure during recording
let trackedFields = new Map(); // Map of field -> current value
let recordingEventListeners = [];

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

// Scan all forms on the page and return form data structure
function scanForms() {
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
      _formElement: form, // Store reference to the actual form element
      fields: []
    };

    // Get all form fields including buttons
    const fields = form.querySelectorAll('input, select, textarea, button');
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
        name: field.name || field.id || field.textContent.trim() || '',
        type: field.type || field.tagName.toLowerCase(),
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

      // For button elements, get the button text
      if (field.tagName === 'BUTTON') {
        fieldInfo.text = field.textContent.trim();
        fieldInfo.name = field.name || field.id || field.textContent.trim() || field.type || 'submit';
      }

      // Skip sensitive fields in reporting
      // But always include submit buttons
      const isSubmitButton = fieldType === 'submit' ||
                           (field.tagName === 'BUTTON' && fieldInfo.type === 'submit') ||
                           fieldInfo.name?.toLowerCase().includes('submit') ||
                           fieldInfo.class?.toLowerCase().includes('submit');

      if (isSubmitButton || (!isSensitiveField(fieldInfo.name) && fieldInfo.name)) {
        // Store reference to field for value tracking
        fieldInfo._element = field;
        formInfo.fields.push(fieldInfo);
      }
    });

    // Skip forms that are just search forms
    const isSearchForm = formInfo.fields.length === 1 && formInfo.fields[0].type === 'search';

    if (formInfo.fields.length > 0 && !isSearchForm) {
      formsData.forms.push(formInfo);
    }
  });

  console.log('FormStatus: Scanned forms', formsData);
  return formsData;
}

// Start manual recording mode
function startManualRecording() {
  console.log('FormStatus: Starting manual recording mode');

  isManualRecording = true;
  trackedFields.clear();

  // Scan and store form structure
  recordedFormData = scanForms();

  // Add event listeners to track field changes
  recordedFormData.forms.forEach(formInfo => {
    formInfo.fields.forEach(fieldInfo => {
      const field = fieldInfo._element;
      if (!field) return;

      // Skip buttons and submit inputs
      const fieldType = field.type || field.tagName.toLowerCase();
      if (fieldType === 'submit' || fieldType === 'button' || field.tagName === 'BUTTON') {
        return;
      }

      // Track input changes
      const inputHandler = () => {
        const value = getFieldValue(field);
        if (value !== null && value !== '' && !isSensitiveField(fieldInfo.name)) {
          trackedFields.set(field, {
            name: fieldInfo.name,
            type: fieldInfo.type,
            value: value,
            label: fieldInfo.label
          });
        }
      };

      field.addEventListener('input', inputHandler);
      field.addEventListener('change', inputHandler);

      recordingEventListeners.push({
        element: field,
        type: 'input',
        handler: inputHandler
      });
      recordingEventListeners.push({
        element: field,
        type: 'change',
        handler: inputHandler
      });
    });

    // Add submit listener to the form element to stop recording
    const formElement = formInfo._formElement;
    if (formElement) {
      const submitHandler = () => {
        console.log('FormStatus: Form submit detected, stopping recording');
        // Capture final values before submit
        formInfo.fields.forEach(fieldInfo => {
          const field = fieldInfo._element;
          if (!field) return;

          const value = getFieldValue(field);
          if (value !== null && value !== '' && !isSensitiveField(fieldInfo.name)) {
            trackedFields.set(field, {
              name: fieldInfo.name,
              type: fieldInfo.type,
              value: value,
              label: fieldInfo.label
            });
          }
        });

        // Stop recording and download
        stopManualRecording();
      };

      formElement.addEventListener('submit', submitHandler);
      recordingEventListeners.push({
        element: formElement,
        type: 'submit',
        handler: submitHandler
      });
    }

    // Also handle button clicks for forms that submit via button click
    formInfo.fields.forEach(fieldInfo => {
      const field = fieldInfo._element;
      if (!field) return;

      const fieldType = field.type || field.tagName.toLowerCase();

      // Check if this is a submit button
      const isSubmitButton = fieldType === 'submit' ||
                           field.tagName === 'BUTTON';

      if (isSubmitButton) {
        const clickHandler = () => {
          console.log('FormStatus: Submit button clicked, stopping recording');

          // Find the parent form
          let parentForm = field.form;
          if (!parentForm) {
            parentForm = field.closest('form');
          }

          // Capture final values before submit
          formInfo.fields.forEach(fInfo => {
            const f = fInfo._element;
            if (!f) return;

            const value = getFieldValue(f);
            if (value !== null && value !== '' && !isSensitiveField(fInfo.name)) {
              trackedFields.set(f, {
                name: fInfo.name,
                type: fInfo.type,
                value: value,
                label: fInfo.label
              });
            }
          });

          // Stop recording and download
          stopManualRecording();
        };

        field.addEventListener('click', clickHandler);
        recordingEventListeners.push({
          element: field,
          type: 'click',
          handler: clickHandler
        });
      }
    });
  });

  // Notify background script of recording state
  chrome.runtime.sendMessage({
    type: 'RECORDING_STATE_CHANGED',
    isRecording: true
  });

  return { success: true, isRecording: true };
}

// Get the current value of a field
function getFieldValue(field) {
  const fieldType = field.type || field.tagName.toLowerCase();

  if (fieldType === 'checkbox') {
    return field.checked;
  }

  if (fieldType === 'radio') {
    return field.checked ? field.value : null;
  }

  if (field.tagName === 'SELECT') {
    return field.value;
  }

  return field.value;
}

// Stop manual recording and download
function stopManualRecording() {
  console.log('FormStatus: Stopping manual recording');

  if (!isManualRecording) {
    return { success: true, message: 'No active recording' };
  }

  isManualRecording = false;

  // Add a small delay to ensure all values are captured
  setTimeout(() => {
    // Remove all event listeners
    recordingEventListeners.forEach(({ element, type, handler }) => {
      element.removeEventListener(type, handler);
    });
    recordingEventListeners = [];

    // Build final data with captured values
    const finalData = {
      url: recordedFormData.url,
      domain: recordedFormData.domain,
      timestamp: new Date().toISOString(),
      forms: recordedFormData.forms.map(formInfo => ({
        id: formInfo.id,
        action: formInfo.action,
        method: formInfo.method,
        field_count: formInfo.fields.length,
        fields: formInfo.fields.map(fieldInfo => {
          const field = fieldInfo._element;
          const trackedValue = field ? trackedFields.get(field) : null;

          return {
            name: fieldInfo.name,
            type: fieldInfo.type,
            required: fieldInfo.required,
            label: fieldInfo.label,
            placeholder: fieldInfo.placeholder,
            id: fieldInfo.id,
            class: fieldInfo.class,
            options: fieldInfo.options.length > 0 ? fieldInfo.options : undefined,
            // Include captured value if available (not sensitive)
            value: trackedValue && !isSensitiveField(fieldInfo.name) ? trackedValue.value : undefined
          };
        })
      }))
    };

    // Download the JSON
    downloadFormsAsJSON(finalData);

    // Clear state
    trackedFields.clear();
    recordedFormData = null;

    // Notify background script
    chrome.runtime.sendMessage({
      type: 'RECORDING_STATE_CHANGED',
      isRecording: false
    });
  }, 100);

  return { success: true, downloaded: true };
}

// Download forms data as JSON file
function downloadFormsAsJSON(formsData) {
  // Clean the data - remove _element references
  const cleanData = {
    url: formsData.url,
    domain: formsData.domain,
    timestamp: formsData.timestamp,
    forms: formsData.forms.map(form => ({
      id: form.id,
      action: form.action,
      method: form.method,
      field_count: form.field_count,
      fields: form.fields.map(field => {
        const fieldData = {
          name: field.name,
          type: field.type,
          required: field.required,
          label: field.label,
          placeholder: field.placeholder,
          id: field.id,
          class: field.class
        };

        if (field.options) {
          fieldData.options = field.options;
        }

        if (field.value !== undefined) {
          fieldData.value = field.value;
        }

        return fieldData;
      })
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

// Listen for messages from background script
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
    const result = startManualRecording();
    sendResponse(result);
    return true;
  }

  if (request.type === 'STOP_RECORDING') {
    const result = stopManualRecording();
    sendResponse(result);
    return true;
  }

  if (request.type === 'GET_RECORDING_STATUS') {
    sendResponse({ isRecording: isManualRecording });
    return true;
  }

  return true;
});