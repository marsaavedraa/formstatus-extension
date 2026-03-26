// FormStatus Chrome Extension - Content Script
// This script runs on web pages to monitor forms

let isMonitoring = false;
let monitoredForms = new Set();

// Manual recording state
let isManualRecording = false;
let recordedFormData = null; // Stores the form structure during recording
let trackedFields = new Map(); // Map of field -> current value
let recordingEventListeners = [];

// Enhanced recording state
let recordingState = {
  recordingId: null,
  startTime: null,
  actions: [],
  pages: [],
  currentPage: null,
  fieldInteractions: new Map(),
  focusTimers: new Map(), // field -> focus start time
  actionCounter: 0,
  isActive: false
};

// Navigation detection
let currentUrl = window.location.href;
let navigationCheckInterval = null;
let urlCheckInterval = null;
let originalPushState = null;
let originalReplaceState = null;

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

// ==================== Enhanced Recording Helper Functions ====================

// Generate a unique recording ID
function generateRecordingId() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const random = Math.random().toString(36).substring(2, 8);
  return `rec_${timestamp}_${random}`;
}

// Get relative time in milliseconds from recording start
function getRelativeTime() {
  if (!recordingState.startTime) return 0;
  return Date.now() - recordingState.startTime;
}

// Generate unique CSS selector for an element
function getFieldSelector(element) {
  if (element.id) {
    return `#${element.id}`;
  }
  if (element.name) {
    return `[name="${element.name}"]`;
  }

  // Generate path-based selector
  const path = [];
  let current = element;
  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      selector += `#${current.id}`;
      path.unshift(selector);
      break;
    }
    if (current.className && typeof current.className === 'string') {
      const classes = current.className.split(' ').filter(c => c && !c.includes(':'));
      if (classes.length > 0) {
        selector += `.${classes[0]}`;
      }
    }
    path.unshift(selector);
    current = current.parentElement;
  }
  return path.join(' > ');
}

// Get target information for an element
function getTargetInfo(element) {
  const fieldType = element.type || element.tagName.toLowerCase();
  return {
    elementType: element.tagName.toLowerCase(),
    fieldName: element.name || element.id || '',
    fieldId: element.id || '',
    fieldLabel: getFieldLabel(element),
    selector: getFieldSelector(element),
    fieldType: fieldType
  };
}

// Record an action
function recordAction(type, details) {
  const actionId = `act_${String(++recordingState.actionCounter).padStart(3, '0')}`;
  const action = {
    actionId,
    type,
    timestamp: Date.now(),
    relativeTime: getRelativeTime(),
    pageUrl: window.location.href,
    ...details
  };
  recordingState.actions.push(action);
  return action;
}

// Save recording state to chrome.storage.local
async function saveRecordingState() {
  try {
    // Convert Map to object for storage
    const stateToSave = {
      ...recordingState,
      fieldInteractions: Array.from(recordingState.fieldInteractions.entries()),
      focusTimers: Array.from(recordingState.focusTimers.entries())
    };
    await chrome.storage.local.set({ 'formstatus_recording': stateToSave });
  } catch (error) {
    console.error('FormStatus: Error saving recording state', error);
  }
}

// Load recording state from chrome.storage.local
async function loadRecordingState() {
  try {
    const result = await chrome.storage.local.get('formstatus_recording');
    if (result.formstatus_recording) {
      const saved = result.formstatus_recording;
      // Convert back to Map
      saved.fieldInteractions = new Map(saved.fieldInteractions || []);
      saved.focusTimers = new Map(saved.focusTimers || []);
      recordingState = saved;
      return true;
    }
  } catch (error) {
    console.error('FormStatus: Error loading recording state', error);
  }
  return false;
}

// Clear recording state from chrome.storage.local
async function clearRecordingState() {
  try {
    await chrome.storage.local.remove('formstatus_recording');
  } catch (error) {
    console.error('FormStatus: Error clearing recording state', error);
  }
}

// Check if a button is a navigation button (next/previous)
function getNavigationButtonType(button) {
  const text = (button.textContent || '').toLowerCase().trim();
  const classes = (button.className || '').toLowerCase();
  const ariaLabel = (button.getAttribute('aria-label') || '').toLowerCase();
  const name = (button.name || '').toLowerCase();
  const id = (button.id || '').toLowerCase();

  const combined = `${text} ${classes} ${ariaLabel} ${name} ${id}`;

  const nextPatterns = ['next', 'continue', 'forward', 'proceed', 'step', 'save and continue', 'save & continue', 'continue to'];
  const prevPatterns = ['previous', 'back', 'go back', 'return', 'go back to'];

  for (const pattern of nextPatterns) {
    if (combined.includes(pattern)) {
      return 'next';
    }
  }

  for (const pattern of prevPatterns) {
    if (combined.includes(pattern)) {
      return 'previous';
    }
  }

  return null;
}

// Check if button appears to be a submit button vs navigation
function determineButtonPurpose(button) {
  const navType = getNavigationButtonType(button);
  if (navType) return navType;

  // Check if it's explicitly a submit button
  if (button.type === 'submit') {
    // Check if form action points to same page (likely multi-page)
    const form = button.form || button.closest('form');
    if (form && form.action) {
      const formUrl = new URL(form.action, window.location.href);
      if (formUrl.pathname === window.location.pathname) {
        return 'next'; // Same page, likely multi-step form
      }
    }
    return 'submit';
  }

  return 'unknown';
}

// Handle navigation to new page
function handleNavigation(from, to) {
  if (!recordingState.isActive) return;

  // Finalize current page
  if (recordingState.currentPage) {
    recordingState.currentPage.endTime = Date.now();
    recordingState.currentPage.duration = recordingState.currentPage.endTime - recordingState.currentPage.startTime;
    recordingState.pages.push(recordingState.currentPage);
  }

  // Record navigation action
  recordAction('navigation', {
    navigationDetail: {
      from,
      to,
      navigationType: 'page_change'
    }
  });

  // Start new page
  recordingState.currentPage = {
    url: to,
    domain: window.location.hostname,
    pageTitle: document.title,
    startTime: Date.now(),
    actions: []
  };

  saveRecordingState();
}

// Setup navigation detection
function setupNavigationDetection() {
  // Store original methods
  originalPushState = history.pushState;
  originalReplaceState = history.replaceState;

  // Override pushState
  history.pushState = function(...args) {
    originalPushState.apply(this, args);
    setTimeout(() => {
      if (window.location.href !== currentUrl) {
        const from = currentUrl;
        currentUrl = window.location.href;
        handleNavigation(from, currentUrl);
      }
    }, 0);
  };

  // Override replaceState
  history.replaceState = function(...args) {
    originalReplaceState.apply(this, args);
    setTimeout(() => {
      if (window.location.href !== currentUrl) {
        const from = currentUrl;
        currentUrl = window.location.href;
        handleNavigation(from, currentUrl);
      }
    }, 0);
  };

  // Poll for URL changes (for traditional page loads)
  urlCheckInterval = setInterval(() => {
    if (window.location.href !== currentUrl) {
      const from = currentUrl;
      currentUrl = window.location.href;
      handleNavigation(from, currentUrl);
    }
  }, 100);

  // Listen for popstate (back/forward buttons)
  window.addEventListener('popstate', () => {
    setTimeout(() => {
      if (window.location.href !== currentUrl) {
        const from = currentUrl;
        currentUrl = window.location.href;
        handleNavigation(from, currentUrl);
      }
    }, 0);
  });
}

// Cleanup navigation detection
function cleanupNavigationDetection() {
  if (urlCheckInterval) {
    clearInterval(urlCheckInterval);
    urlCheckInterval = null;
  }

  if (originalPushState) {
    history.pushState = originalPushState;
    originalPushState = null;
  }

  if (originalReplaceState) {
    history.replaceState = originalReplaceState;
    originalReplaceState = null;
  }
}

// ==================== Event Handlers ====================

// Handle focus events
function handleFocus(event) {
  if (!recordingState.isActive) return;

  const field = event.target;
  const fieldInfo = getTargetInfo(field);

  // Record focus action
  recordAction('focus', {
    target: fieldInfo
  });

  // Track focus start time
  recordingState.focusTimers.set(field, Date.now());

  // Initialize field interaction if not exists
  if (!recordingState.fieldInteractions.has(field)) {
    recordingState.fieldInteractions.set(field, {
      selector: fieldInfo.selector,
      fieldName: fieldInfo.fieldName,
      fieldLabel: fieldInfo.fieldLabel,
      firstFocusTime: Date.now(),
      focusCount: 0,
      clickCount: 0,
      keystrokeCount: 0,
      valueChanges: [],
      initialValue: getFieldValue(field),
      actions: []
    });
  }

  const interaction = recordingState.fieldInteractions.get(field);
  interaction.focusCount++;

  saveRecordingState();
}

// Handle blur events
function handleBlur(event) {
  if (!recordingState.isActive) return;

  const field = event.target;
  const fieldInfo = getTargetInfo(field);

  // Calculate focus duration
  const focusStart = recordingState.focusTimers.get(field);
  const focusDuration = focusStart ? Date.now() - focusStart : 0;
  recordingState.focusTimers.delete(field);

  // Record blur action with duration
  recordAction('blur', {
    target: fieldInfo,
    focusDuration: focusDuration
  });

  // Update field interaction
  const interaction = recordingState.fieldInteractions.get(field);
  if (interaction) {
    interaction.totalFocusDuration = (interaction.totalFocusDuration || 0) + focusDuration;
    interaction.finalValue = getFieldValue(field);
  }

  saveRecordingState();
}

// Handle input events (keystroke-level tracking)
function handleInput(event) {
  if (!recordingState.isActive) return;

  const field = event.target;
  const fieldInfo = getTargetInfo(field);
  const currentValue = field.value;
  const previousValue = trackedFields.get(field) || '';

  // Determine input type
  let inputType = 'typing';
  if (event.inputType) {
    if (event.inputType === 'insertFromPaste') {
      inputType = 'paste';
    } else if (event.inputType.includes('delete')) {
      inputType = 'delete';
    } else if (event.inputType.includes('history')) {
      inputType = 'autocomplete';
    }
  }

  // Calculate character difference
  const charsAdded = currentValue.length - previousValue.length;

  // Record input action
  recordAction('input', {
    target: fieldInfo,
    inputDetail: {
      value: currentValue,
      inputType: inputType,
      characters: charsAdded
    }
  });

  // Update field interaction
  const interaction = recordingState.fieldInteractions.get(field);
  if (interaction) {
    interaction.keystrokeCount = (interaction.keystrokeCount || 0) + Math.abs(charsAdded);
    interaction.valueChanges.push({
      timestamp: Date.now(),
      value: currentValue,
      inputType: inputType
    });
  }

  trackedFields.set(field, currentValue);
  saveRecordingState();
}

// Handle change events (select, radio, checkbox)
function handleChange(event) {
  if (!recordingState.isActive) return;

  const field = event.target;
  const fieldInfo = getTargetInfo(field);

  let oldValue = trackedFields.get(field);
  const currentValue = getFieldValue(field);

  let selectedText = '';
  if (field.tagName === 'SELECT') {
    const selectedOption = field.options[field.selectedIndex];
    if (selectedOption) {
      selectedText = selectedOption.text;
    }
  }

  // Record change action
  recordAction('change', {
    target: fieldInfo,
    changeDetail: {
      oldValue: oldValue,
      newValue: currentValue,
      selectedText: selectedText
    }
  });

  trackedFields.set(field, currentValue);
  saveRecordingState();
}

// Handle click events on fields
function handleFieldClick(event) {
  if (!recordingState.isActive) return;

  const field = event.target;
  const fieldInfo = getTargetInfo(field);

  // Record click action
  recordAction('click', {
    target: fieldInfo
  });

  // Update field interaction
  const interaction = recordingState.fieldInteractions.get(field);
  if (interaction) {
    interaction.clickCount = (interaction.clickCount || 0) + 1;
  }

  saveRecordingState();
}

// Handle paste events
function handlePaste(event) {
  if (!recordingState.isActive) return;

  const field = event.target;
  const fieldInfo = getTargetInfo(field);

  // Get pasted content
  const pastedData = (event.clipboardData || window.clipboardData).getData('text');

  recordAction('paste', {
    target: fieldInfo,
    pasteDetail: {
      length: pastedData.length,
      preview: pastedData.substring(0, 50)
    }
  });

  saveRecordingState();
}

// Handle keydown events (special keys)
function handleKeydown(event) {
  if (!recordingState.isActive) return;

  const field = event.target;
  const fieldInfo = getTargetInfo(field);

  // Track delete/backspace
  if (event.key === 'Backspace' || event.key === 'Delete') {
    recordAction('keydown', {
      target: fieldInfo,
      keyDetail: {
        key: event.key,
        code: event.code
      }
    });

    // Update field interaction
    const interaction = recordingState.fieldInteractions.get(field);
    if (interaction) {
      interaction.keystrokeCount = (interaction.keystrokeCount || 0) + 1;
    }

    saveRecordingState();
  }
}

// Handle button clicks (submit, next, previous)
function handleButtonClick(event) {
  if (!recordingState.isActive) return;

  const button = event.target;
  const buttonPurpose = determineButtonPurpose(button);

  const buttonInfo = {
    elementType: button.tagName.toLowerCase(),
    fieldName: button.name || button.id || '',
    fieldId: button.id || '',
    fieldLabel: button.textContent.trim(),
    selector: getFieldSelector(button)
  };

  // Record button click
  recordAction('click', {
    target: buttonInfo,
    buttonDetail: {
      buttonText: button.textContent.trim(),
      buttonPurpose: buttonPurpose
    }
  });

  saveRecordingState();

  // If it's a final submit, stop recording
  if (buttonPurpose === 'submit') {
    event.preventDefault();
    event.stopPropagation();
    // Delay stop to capture the click action
    setTimeout(() => {
      stopManualRecording();
    }, 100);
    return false;
  }

  // For navigation buttons, let the navigation happen naturally
  // The navigation detection will handle recording the page change
}

// ==================== Start Manual Recording ====================

// Start manual recording mode
function startManualRecording() {
  console.log('FormStatus: Starting enhanced manual recording mode');

  // Initialize recording state
  recordingState = {
    recordingId: generateRecordingId(),
    startTime: Date.now(),
    actions: [],
    pages: [],
    currentPage: {
      url: window.location.href,
      domain: window.location.hostname,
      pageTitle: document.title,
      startTime: Date.now(),
      endTime: null,
      duration: null,
      actions: []
    },
    fieldInteractions: new Map(),
    focusTimers: new Map(),
    actionCounter: 0,
    isActive: true
  };

  isManualRecording = true;
  trackedFields.clear();
  currentUrl = window.location.href;

  // Scan and store form structure
  recordedFormData = scanForms();

  // Setup navigation detection for multi-page forms
  setupNavigationDetection();

  // Record initial page load action
  recordAction('page_load', {
    pageDetail: {
      url: window.location.href,
      pageTitle: document.title
    }
  });

  // Add enhanced event listeners to all form fields
  recordedFormData.forms.forEach(formInfo => {
    formInfo.fields.forEach(fieldInfo => {
      const field = fieldInfo._element;
      if (!field) return;

      const fieldType = field.type || field.tagName.toLowerCase();
      const isButton = fieldType === 'submit' || fieldType === 'button' || field.tagName === 'BUTTON';

      if (isButton) {
        // Handle button clicks (submit, next, previous)
        field.addEventListener('click', handleButtonClick, true);
        recordingEventListeners.push({ element: field, type: 'click', handler: handleButtonClick, capture: true });
      } else {
        // Handle all field interactions
        field.addEventListener('focus', handleFocus);
        field.addEventListener('blur', handleBlur);
        field.addEventListener('input', handleInput);
        field.addEventListener('change', handleChange);
        field.addEventListener('click', handleFieldClick);
        field.addEventListener('paste', handlePaste);
        field.addEventListener('keydown', handleKeydown);

        recordingEventListeners.push({ element: field, type: 'focus', handler: handleFocus });
        recordingEventListeners.push({ element: field, type: 'blur', handler: handleBlur });
        recordingEventListeners.push({ element: field, type: 'input', handler: handleInput });
        recordingEventListeners.push({ element: field, type: 'change', handler: handleChange });
        recordingEventListeners.push({ element: field, type: 'click', handler: handleFieldClick });
        recordingEventListeners.push({ element: field, type: 'paste', handler: handlePaste });
        recordingEventListeners.push({ element: field, type: 'keydown', handler: handleKeydown });
      }
    });

    // Add form submit listener as backup
    const formElement = formInfo._formElement;
    if (formElement) {
      const submitHandler = (e) => {
        if (!recordingState.isActive) return;
        console.log('FormStatus: Form submit detected');
        recordAction('submit', {
          formDetail: {
            formId: formInfo.id,
            formAction: formInfo.action
          }
        });
        // Stop recording after a short delay
        setTimeout(() => stopManualRecording(), 100);
      };
      formElement.addEventListener('submit', submitHandler);
      recordingEventListeners.push({ element: formElement, type: 'submit', handler: submitHandler });
    }
  });

  // Save initial state
  saveRecordingState();

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
  console.log('FormStatus: Stopping enhanced manual recording');

  if (!isManualRecording || !recordingState.isActive) {
    return { success: true, message: 'No active recording' };
  }

  isManualRecording = false;
  recordingState.isActive = false;

  // Add a small delay to ensure all values are captured
  setTimeout(() => {
    // Remove all event listeners
    recordingEventListeners.forEach(({ element, type, handler, capture }) => {
      if (capture) {
        element.removeEventListener(type, handler, true);
      } else {
        element.removeEventListener(type, handler);
      }
    });
    recordingEventListeners = [];

    // Cleanup navigation detection
    cleanupNavigationDetection();

    // Finalize current page
    if (recordingState.currentPage) {
      recordingState.currentPage.endTime = Date.now();
      recordingState.currentPage.duration = recordingState.currentPage.endTime - recordingState.currentPage.startTime;
      recordingState.pages.push(recordingState.currentPage);
    }

    // Build enhanced final data
    const finalData = buildEnhancedRecordingData();

    // Download the JSON
    downloadEnhancedRecordingAsJSON(finalData);

    // Clear state
    trackedFields.clear();
    recordedFormData = null;
    recordingState = {
      recordingId: null,
      startTime: null,
      actions: [],
      pages: [],
      currentPage: null,
      fieldInteractions: new Map(),
      focusTimers: new Map(),
      actionCounter: 0,
      isActive: false
    };

    // Clear storage
    clearRecordingState();

    // Notify background script
    chrome.runtime.sendMessage({
      type: 'RECORDING_STATE_CHANGED',
      isRecording: false
    });
  }, 100);

  return { success: true, downloaded: true };
}

// Build enhanced recording data structure
function buildEnhancedRecordingData() {
  const endTime = Date.now();
  const totalDuration = endTime - recordingState.startTime;

  // Calculate statistics
  const stats = {
    totalClicks: recordingState.actions.filter(a => a.type === 'click').length,
    totalKeystrokes: recordingState.actions.filter(a => a.type === 'input').length +
                     recordingState.actions.filter(a => a.type === 'keydown').length,
    totalFocusEvents: recordingState.actions.filter(a => a.type === 'focus').length,
    totalBlurEvents: recordingState.actions.filter(a => a.type === 'blur').length,
    fieldsInteracted: recordingState.fieldInteractions.size,
    totalActions: recordingState.actions.length
  };

  // Calculate average field interaction time
  let totalFocusTime = 0;
  let focusFieldCount = 0;
  recordingState.fieldInteractions.forEach((interaction) => {
    if (interaction.totalFocusDuration) {
      totalFocusTime += interaction.totalFocusDuration;
      focusFieldCount++;
    }
  });
  stats.averageFieldInteractionTime = focusFieldCount > 0 ? Math.round(totalFocusTime / focusFieldCount) : 0;

  // Build field summaries from interactions
  const fieldSummaries = [];
  recordingState.fieldInteractions.forEach((interaction, key) => {
    // Find the element reference to get current value
    let element = null;
    if (key instanceof HTMLElement) {
      element = key;
    }

    fieldSummaries.push({
      selector: interaction.selector,
      fieldName: interaction.fieldName,
      fieldLabel: interaction.fieldLabel,
      focusCount: interaction.focusCount || 0,
      clickCount: interaction.clickCount || 0,
      keystrokeCount: interaction.keystrokeCount || 0,
      totalFocusDuration: interaction.totalFocusDuration || 0,
      initialValue: interaction.initialValue,
      finalValue: interaction.finalValue,
      valueChangeCount: interaction.valueChanges ? interaction.valueChanges.length : 0
    });
  });

  // Build forms data (from last scan)
  const forms = [];
  if (recordedFormData && recordedFormData.forms) {
    recordedFormData.forms.forEach(formInfo => {
      const form = {
        id: formInfo.id,
        action: formInfo.action,
        method: formInfo.method,
        field_count: formInfo.fields.length,
        fields: formInfo.fields.map(fieldInfo => {
          const field = fieldInfo._element;
          const trackedValue = field ? trackedFields.get(field) : null;

          const fieldData = {
            name: fieldInfo.name,
            type: fieldInfo.type,
            required: fieldInfo.required,
            label: fieldInfo.label,
            placeholder: fieldInfo.placeholder,
            id: fieldInfo.id,
            class: fieldInfo.class
          };

          if (fieldInfo.options && fieldInfo.options.length > 0) {
            fieldData.options = fieldInfo.options;
          }

          // Include captured value if available (not sensitive)
          if (trackedValue && !isSensitiveField(fieldInfo.name)) {
            fieldData.value = trackedValue.value;
          }

          return fieldData;
        })
      };
      forms.push(form);
    });
  }

  return {
    recordingId: recordingState.recordingId,
    recordingType: 'manual-form-recording',
    recordingStart: new Date(recordingState.startTime).toISOString(),
    recordingEnd: new Date(endTime).toISOString(),
    totalDuration: totalDuration,
    pageCount: recordingState.pages.length,
    pages: recordingState.pages,
    actions: recordingState.actions,
    statistics: stats,
    fieldSummaries: fieldSummaries,
    forms: forms,
    metadata: {
      capturedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      screenResolution: `${window.screen.width}x${window.screen.height}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }
  };
}

// Download enhanced recording data as JSON file
function downloadEnhancedRecordingAsJSON(recordingData) {
  // Create filename based on domain and timestamp
  const domain = window.location.hostname.replace(/[^a-z0-9]/gi, '_');
  const timestamp = new Date().getTime();
  const filename = `formstatus_${domain}_${timestamp}.json`;

  const jsonString = JSON.stringify(recordingData, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  // Create download link and trigger download
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  console.log('FormStatus: Downloaded enhanced recording JSON', filename);
}

// Legacy function for backward compatibility - redirects to enhanced version
function downloadFormsAsJSON(formsData) {
  // Convert old format to enhanced format
  const enhancedData = {
    recordingId: generateRecordingId(),
    recordingType: 'manual-form-recording',
    recordingStart: formsData.timestamp || new Date().toISOString(),
    recordingEnd: new Date().toISOString(),
    totalDuration: 0,
    pageCount: 1,
    pages: [{
      url: formsData.url,
      domain: formsData.domain,
      startTime: new Date(formsData.timestamp).getTime(),
      endTime: Date.now(),
      duration: 0,
      actions: []
    }],
    actions: [],
    statistics: {
      totalClicks: 0,
      totalKeystrokes: 0,
      totalFocusEvents: 0,
      totalBlurEvents: 0,
      fieldsInteracted: 0,
      totalActions: 0,
      averageFieldInteractionTime: 0
    },
    fieldSummaries: [],
    forms: formsData.forms || [],
    metadata: {
      capturedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      screenResolution: `${window.screen.width}x${window.screen.height}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }
  };

  downloadEnhancedRecordingAsJSON(enhancedData);
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
  document.addEventListener('DOMContentLoaded', initializeContentScript);
} else {
  initializeContentScript();
}

// Main initialization function
async function initializeContentScript() {
  // Check for and resume active recording session
  const hasActiveRecording = await loadRecordingState();
  if (hasActiveRecording && recordingState.isActive) {
    console.log('FormStatus: Resuming active recording session');
    isManualRecording = true;
    currentUrl = window.location.href;
    recordedFormData = scanForms();

    // Re-attach event listeners to new page's forms
    recordedFormData.forms.forEach(formInfo => {
      formInfo.fields.forEach(fieldInfo => {
        const field = fieldInfo._element;
        if (!field) return;

        const fieldType = field.type || field.tagName.toLowerCase();
        const isButton = fieldType === 'submit' || fieldType === 'button' || field.tagName === 'BUTTON';

        if (isButton) {
          field.addEventListener('click', handleButtonClick, true);
          recordingEventListeners.push({ element: field, type: 'click', handler: handleButtonClick, capture: true });
        } else {
          field.addEventListener('focus', handleFocus);
          field.addEventListener('blur', handleBlur);
          field.addEventListener('input', handleInput);
          field.addEventListener('change', handleChange);
          field.addEventListener('click', handleFieldClick);
          field.addEventListener('paste', handlePaste);
          field.addEventListener('keydown', handleKeydown);

          recordingEventListeners.push({ element: field, type: 'focus', handler: handleFocus });
          recordingEventListeners.push({ element: field, type: 'blur', handler: handleBlur });
          recordingEventListeners.push({ element: field, type: 'input', handler: handleInput });
          recordingEventListeners.push({ element: field, type: 'change', handler: handleChange });
          recordingEventListeners.push({ element: field, type: 'click', handler: handleFieldClick });
          recordingEventListeners.push({ element: field, type: 'paste', handler: handlePaste });
          recordingEventListeners.push({ element: field, type: 'keydown', handler: handleKeydown });
        }
      });

      // Add form submit listener
      const formElement = formInfo._formElement;
      if (formElement) {
        const submitHandler = () => {
          if (!recordingState.isActive) return;
          console.log('FormStatus: Form submit detected');
          recordAction('submit', {
            formDetail: {
              formId: formInfo.id,
              formAction: formInfo.action
            }
          });
          setTimeout(() => stopManualRecording(), 100);
        };
        formElement.addEventListener('submit', submitHandler);
        recordingEventListeners.push({ element: formElement, type: 'submit', handler: submitHandler });
      }
    });

    // Record page load action for resumed session
    recordAction('page_load', {
      pageDetail: {
        url: window.location.href,
        pageTitle: document.title,
        resumed: true
      }
    });

    // Re-setup navigation detection
    setupNavigationDetection();

    // Notify background script
    chrome.runtime.sendMessage({
      type: 'RECORDING_STATE_CHANGED',
      isRecording: true
    });
  } else {
    // Normal initialization
    await checkAuthAndInit();
  }
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