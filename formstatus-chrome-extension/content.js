// FormStatus Chrome Extension - Content Script
// This script runs on web pages to monitor forms

let isMonitoring = false;
let monitoredForms = new Set();

// Manual recording state
let isManualRecording = false;
let recordedFormData = null;
let trackedFields = new Map();
let recordingEventListeners = [];
let globalRecordingListeners = [];
let rescanInterval = null;

// Enhanced recording state
let recordingState = {
  recordingId: null,
  startTime: null,
  actions: [],
  pages: [],
  currentPage: null,
  pageIndex: 0, // Track which page of multi-page form we're on
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

function isCaptchaField(field) {
  const name = (field.name || '').toLowerCase();
  const id = (field.id || '').toLowerCase();
  const cls = (field.className && typeof field.className === 'string') ? field.className.toLowerCase() : '';
  const combined = `${name} ${id} ${cls}`;

  if (
    combined.includes('g-recaptcha') ||
    combined.includes('grecaptcha') ||
    combined.includes('recaptcha') ||
    combined.includes('h-captcha') ||
    combined.includes('hcaptcha') ||
    combined.includes('turnstile') ||
    combined.includes('cf-turnstile') ||
    combined.includes('captcha')
  ) {
    return true;
  }

  if (field.tagName === 'TEXTAREA' && name === 'g-recaptcha-response') {
    return true;
  }

  if (
    field.type === 'hidden' &&
    (name.includes('recaptcha') || name.includes('captcha') || name.includes('turnstile'))
  ) {
    return true;
  }

  const closest = field.closest('.grecaptcha-badge, .h-captcha, [data-sitekey], [data-recaptcha], .captcha, .cf-turnstile');
  if (closest) {
    return true;
  }

  return false;
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

      if (isCaptchaField(field)) {
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
  const info = {
    elementType: element.tagName.toLowerCase(),
    fieldName: element.name || element.id || '',
    fieldId: element.id || '',
    fieldLabel: getFieldLabel(element),
    selector: getFieldSelector(element),
    fieldType: fieldType
  };

  if (element.tagName === 'SELECT') {
    info.options = Array.from(element.querySelectorAll('option'))
      .filter(opt => opt.value)
      .map(opt => ({ value: opt.value, text: opt.text }));
  }

  return info;
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
    pageIndex: recordingState.pageIndex || 0, // Track which page this action belongs to
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
  const text = (button.textContent || button.value || '').toLowerCase().trim();
  const classes = (button.className || '').toLowerCase();
  const ariaLabel = (button.getAttribute('aria-label') || '').toLowerCase();
  const name = (button.name || '').toLowerCase();
  const id = (button.id || '').toLowerCase();

  const dataSubmissionType = (button.getAttribute('data-submission-type') || '').toLowerCase();

  const combined = `${text} ${classes} ${ariaLabel} ${name} ${id} ${dataSubmissionType}`;

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
    const id = (button.id || '').toLowerCase();
    const value = (button.value || '').toLowerCase();
    const text = (button.textContent || '').toLowerCase().trim();

    if (id.includes('submit') && !id.includes('next')) {
      return 'submit';
    }
    if (value === 'submit') {
      return 'submit';
    }

    // Since getNavigationButtonType already returned null, the text doesn't
    // match navigation patterns (next, continue, etc.). Check for submit-specific
    // text BEFORE the same-page heuristic to avoid false "next" classification.
    const submitIndicators = ['submit', 'send', 'finish', 'complete'];
    if (submitIndicators.some(w => text.includes(w) || value.includes(w))) {
      return 'submit';
    }

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

  // Increment page index for multi-page form tracking
  recordingState.pageIndex = (recordingState.pageIndex || 0) + 1;

  // Start new page
  recordingState.currentPage = {
    url: to,
    domain: window.location.hostname,
    pageTitle: document.title,
    startTime: Date.now(),
    actions: []
  };

  // Re-attach event listeners to new page's forms
  reattachEventListeners();

  saveRecordingState();
}

// ==================== SPA Page Transition Detection ====================

// Track currently visible page elements for multi-page forms
let visiblePageElements = new Set();
let pageTransitionObserver = null;
let dynamicButtonObserver = null;

// Detect SPA page transitions (Forminator, WPForms, etc.)
function setupSPATransitionDetection() {
  if (pageTransitionObserver) return;

  // Use MutationObserver to detect page transitions
  pageTransitionObserver = new MutationObserver((mutations) => {
    if (!recordingState.isActive) return;

    // Check for aria-hidden or hidden attribute changes on page containers
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' &&
          (mutation.attributeName === 'aria-hidden' ||
           mutation.attributeName === 'hidden' ||
           mutation.attributeName === 'class')) {

        const target = mutation.target;

        // Check if this is a page container becoming visible
        const isNowVisible = isElementVisible(target);
        const wasVisible = visiblePageElements.has(target);

        if (isNowVisible && !wasVisible) {
          // New page became visible - handle page transition
          handleSPAPageTransition(target);
        }

        // Update visibility tracking
        if (isNowVisible) {
          visiblePageElements.add(target);
        } else {
          visiblePageElements.delete(target);
        }
      }
    }
  });

  // Start observing
  pageTransitionObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['aria-hidden', 'hidden', 'class'],
    subtree: true
  });

  // Initialize visible elements
  scanVisiblePageElements();
}

// Check if an element is visible
function isElementVisible(element) {
  if (!element) return false;

  const style = window.getComputedStyle(element);
  const ariaHidden = element.getAttribute('aria-hidden');
  const hasHiddenAttr = element.hasAttribute('hidden');

  return style.display !== 'none' &&
         style.visibility !== 'hidden' &&
         ariaHidden !== 'true' &&
         !hasHiddenAttr &&
         element.offsetParent !== null;
}

// Scan for currently visible page elements
function scanVisiblePageElements() {
  visiblePageElements.clear();

  // Find Forminator page containers
  const forminatorPages = document.querySelectorAll('[role="tabpanel"].forminator-pagination, .forminator-pagination > div');
  forminatorPages.forEach(page => {
    if (isElementVisible(page)) {
      visiblePageElements.add(page);
    }
  });

  // Find Gravity Forms page containers
  const gformPages = document.querySelectorAll('.gform_page');
  gformPages.forEach(page => {
    if (isElementVisible(page)) {
      visiblePageElements.add(page);
    }
  });

  // Find WPForms page containers
  const wpformsPages = document.querySelectorAll('.wpforms-page');
  wpformsPages.forEach(page => {
    if (isElementVisible(page)) {
      visiblePageElements.add(page);
    }
  });

  // Find other common multi-page form containers
  const otherPages = document.querySelectorAll('[data-page], .form-page, .step-page, [role="page"]');
  otherPages.forEach(page => {
    if (isElementVisible(page)) {
      visiblePageElements.add(page);
    }
  });
}

// Handle SPA page transition
function handleSPAPageTransition(newPageElement) {
  if (!recordingState.isActive) return;

  console.log('FormStatus: SPA page transition detected', newPageElement);

  // Extract the page/step number from Forminator classes
  // Forminator uses classes like "forminator-step-0", "forminator-step-1", "forminator-step-2"
  let newPageIndex = recordingState.pageIndex || 0;
  const classList = newPageElement.className || '';

  // Try to extract step number from Forminator classes
  const stepMatch = classList.match(/forminator-step-(\d+)/);
  if (stepMatch) {
    newPageIndex = parseInt(stepMatch[1], 10);
    console.log('FormStatus: Detected Forminator step', newPageIndex);
  } else {
    // For other form types, try to extract page number from data-page attribute
    const dataPage = newPageElement.getAttribute('data-page');
    if (dataPage !== null) {
      newPageIndex = parseInt(dataPage, 10);
    } else {
      // Fallback: increment page index only for meaningful transitions
      // Skip hover, focus, and other micro-transitions
      const isMeaningfulTransition =
        classList.includes('forminator-pagination') ||  // Page navigation
        classList.includes('forminator-step') ||          // Step change
        classList.includes('current') ||                   // Current page marker
        classList.includes('active');                      // Active page marker

      if (isMeaningfulTransition) {
        newPageIndex = (recordingState.pageIndex || 0) + 1;
      }
    }
  }

  // Only record transition if page index actually changed
  if (newPageIndex !== recordingState.pageIndex) {
    console.log('FormStatus: Page index changed from', recordingState.pageIndex, 'to', newPageIndex);

    // Finalize current page
    if (recordingState.currentPage) {
      recordingState.currentPage.endTime = Date.now();
      recordingState.currentPage.duration = recordingState.currentPage.endTime - recordingState.currentPage.startTime;
      recordingState.pages.push(recordingState.currentPage);
    }

    // Update page index
    recordingState.pageIndex = newPageIndex;

    // Record page transition action
    recordAction('page_transition', {
      transitionDetail: {
        pageType: newPageElement.className || newPageElement.role || 'unknown',
        transitionType: 'spa'
      }
    });

    // Start new page
    recordingState.currentPage = {
      url: window.location.href,
      domain: window.location.hostname,
      pageTitle: document.title,
      startTime: Date.now(),
      actions: []
    };

    // Record page load action for new page
    recordAction('page_load', {
      pageDetail: {
        url: window.location.href,
        pageTitle: document.title,
        spaTransition: true
      }
    });

    // Re-attach event listeners to newly visible fields
    reattachEventListeners();

    saveRecordingState();
  }
}

// Re-attach event listeners to all form fields (for SPA page transitions)
function reattachEventListeners() {
  console.log('FormStatus: Re-attaching event listeners after page transition');

  // ALWAYS re-scan forms to get fresh element references
  // After SPA page transitions, old element references are stale
  recordedFormData = scanForms();

  if (!recordedFormData || !recordedFormData.forms) {
    console.warn('FormStatus: No forms found after page transition');
    return;
  }

  console.log(`FormStatus: Found ${recordedFormData.forms.length} form(s) to re-attach listeners`);

  // Attach listeners to all form fields
  recordedFormData.forms.forEach(formInfo => {
    formInfo.fields.forEach(fieldInfo => {
      const field = fieldInfo._element;
      if (!field) return;

      // Skip if already has listeners
      if (field._hasFormStatusListeners) return;

      const fieldType = field.type || field.tagName.toLowerCase();
      const isButton = fieldType === 'submit' || fieldType === 'button' || field.tagName === 'BUTTON';

      if (isButton) {
        field.addEventListener('click', handleButtonClick, true);
        recordingEventListeners.push({ element: field, type: 'click', handler: handleButtonClick, capture: true });
        console.log(`FormStatus: Attached click listener to button: ${fieldInfo.fieldLabel || fieldInfo.name}`);
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
        console.log(`FormStatus: Attached listeners to field: ${fieldInfo.fieldLabel || fieldInfo.name}`);
      }

      // Mark as having listeners
      field._hasFormStatusListeners = true;
    });
  });
}

// Cleanup SPA transition detection
function cleanupSPATransitionDetection() {
  if (pageTransitionObserver) {
    pageTransitionObserver.disconnect();
    pageTransitionObserver = null;
  }
  visiblePageElements.clear();
}

function isButtonLikeElement(el) {
  if (el.tagName === 'BUTTON') return true;
  if (el.tagName === 'INPUT') {
    const t = (el.type || '').toLowerCase();
    return t === 'submit' || t === 'button';
  }
  return false;
}

function attachDynamicButtonListener(button) {
  if (button._hasFormStatusListeners) return;
  if (!recordingState.isActive) return;

  button.addEventListener('click', handleButtonClick, true);
  recordingEventListeners.push({ element: button, type: 'click', handler: handleButtonClick, capture: true });
  button._hasFormStatusListeners = true;
}

function setupDynamicButtonObserver() {
  if (dynamicButtonObserver) return;

  dynamicButtonObserver = new MutationObserver((mutations) => {
    if (!recordingState.isActive) return;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        if (isButtonLikeElement(node)) {
          attachDynamicButtonListener(node);
        }

        const buttons = node.querySelectorAll?.('button, input[type="submit"], input[type="button"]');
        if (buttons) {
          buttons.forEach(attachDynamicButtonListener);
        }
      }
    }
  });

  dynamicButtonObserver.observe(document.body, {
    childList: true,
    subtree: true
  });
}

function cleanupDynamicButtonObserver() {
  if (dynamicButtonObserver) {
    dynamicButtonObserver.disconnect();
    dynamicButtonObserver = null;
  }
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

// Handle focus events - just track timing, don't record action yet
function handleFocus(event) {
  if (!recordingState.isActive) return;

  const field = event.target;
  const fieldInfo = getTargetInfo(field);

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

// Handle blur events - record a single field_fill action with complete info
function handleBlur(event) {
  if (!recordingState.isActive) return;

  const field = event.target;
  const fieldInfo = getTargetInfo(field);

  // Calculate focus duration
  const focusStart = recordingState.focusTimers.get(field);
  const focusDuration = focusStart ? Date.now() - focusStart : 0;
  recordingState.focusTimers.delete(field);

  const currentValue = getFieldValue(field);
  const initialValue = recordingState.fieldInteractions.get(field)?.initialValue || '';

  // Only record if the value actually changed (or it's a select/radio/checkbox)
  const fieldType = field.type || field.tagName.toLowerCase();
  const isSelectionField = fieldType === 'select' || fieldType === 'radio' || fieldType === 'checkbox';

  if (currentValue !== initialValue || isSelectionField) {
    const interaction = recordingState.fieldInteractions.get(field);
    const inputType = interaction?.lastInputType || 'typing';

    // Record a single combined field_fill action
    recordAction('field_fill', {
      target: fieldInfo,
      fieldFillDetail: {
        value: currentValue,
        initialValue: initialValue,
        inputType: inputType,
        focusDuration: focusDuration,
        keystrokeCount: interaction?.keystrokeCount || 0
      }
    });
  }

  // Update field interaction
  const interaction = recordingState.fieldInteractions.get(field);
  if (interaction) {
    interaction.totalFocusDuration = (interaction.totalFocusDuration || 0) + focusDuration;
    interaction.finalValue = currentValue;
  }

  saveRecordingState();
}

// Handle input events - just track value changes, don't record each keystroke
function handleInput(event) {
  if (!recordingState.isActive) return;

  const field = event.target;

  // Just update tracked value, don't record individual keystroke actions
  trackedFields.set(field, field.value);

  // Update field interaction stats for analytics only
  const interaction = recordingState.fieldInteractions.get(field);
  if (interaction) {
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
    interaction.keystrokeCount = (interaction.keystrokeCount || 0) + 1;
    interaction.lastInputType = inputType;
  }
}

// Handle change events (select, radio, checkbox) - record as click
function handleChange(event) {
  if (!recordingState.isActive) return;

  const field = event.target;
  const fieldType = field.type || field.tagName.toLowerCase();

  if (fieldType === 'radio' || fieldType === 'checkbox') {
    const fieldInfo = getTargetInfo(field);
    recordAction('click', {
      target: fieldInfo
    });
  } else {
    const fieldInfo = getTargetInfo(field);
    const initialValue = trackedFields.get(field) || '';
    const currentValue = getFieldValue(field);

    recordAction('click', {
      target: fieldInfo,
      fieldFillDetail: {
        value: currentValue,
        initialValue: initialValue,
      }
    });

    trackedFields.set(field, currentValue);
  }

  saveRecordingState();
}

// Get all options in a radio/checkbox group
function getRadioCheckboxGroupInfo(field) {
  const fieldName = field.name;
  const fieldType = field.type;

  // Find all inputs with the same name (same group)
  const allOptions = Array.from(document.querySelectorAll(
    `input[type="${fieldType}"][name="${CSS.escape(fieldName)}"]`
  ));

  // Get group label from fieldset/legend or surrounding container
  const groupLabel = getFieldGroupLabel(field);
  const groupId = field.closest('fieldset')?.id || field.closest('.forminator-field')?.id || '';

  // Build options array with label, value, checked state
  const options = allOptions.map((option) => {
    const optionLabel = getRadioCheckboxOptionLabel(option);
    return {
      id: option.id || '',
      selector: getFieldSelector(option),
      label: optionLabel,
      value: option.value,
      checked: option.checked
    };
  });

  return {
    name: fieldName,
    type: fieldType,
    groupLabel: groupLabel,
    groupId: groupId,
    options: options
  };
}

// Get the label for a single radio/checkbox option
function getRadioCheckboxOptionLabel(option) {
  // Try to find associated label
  if (option.id) {
    const label = document.querySelector(`label[for="${option.id}"]`);
    if (label) {
      // Return label text without the input's value
      return label.textContent.replace(option.value || '', '').trim();
    }
  }

  // Try to find parent label
  const parentLabel = option.closest('label');
  if (parentLabel) {
    return parentLabel.textContent.replace(option.value || '', '').trim();
  }

  // Use value as fallback
  return option.value || '';
}

// Get the group label for a radio/checkbox group
function getFieldGroupLabel(field) {
  // Try fieldset > legend
  const fieldset = field.closest('fieldset');
  if (fieldset) {
    const legend = fieldset.querySelector('legend');
    if (legend) {
      return legend.textContent.trim();
    }
  }

  // Try Forminator-specific structure
  const forminatorField = field.closest('.forminator-field');
  if (forminatorField) {
    const label = forminatorField.querySelector('.forminator-label, .forminator-title, .forminator-group-title');
    if (label) {
      return label.textContent.trim();
    }
  }

  // Try common patterns for radio/checkbox group labels
  const parent = field.parentElement;
  if (parent) {
    // Look for labels that might be the group label
    const groupLabel = parent.querySelector('label:first-child, .group-label, .field-label, .form-label');
    if (groupLabel && !groupLabel.contains(field)) {
      return groupLabel.textContent.trim();
    }
  }

  // Default to field name
  return field.name || '';
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

// Handle keydown events (special keys like Tab)
function handleKeydown(event) {
  if (!recordingState.isActive) return;

  const field = event.target;

  // Track Tab key as navigation - record BEFORE the blur happens
  if (event.key === 'Tab') {
    const fieldInfo = getTargetInfo(field);

    // Record the current field's value before tabbing away
    const currentValue = getFieldValue(field);
    const initialValue = recordingState.fieldInteractions.get(field)?.initialValue || '';

    // If there's a value that was entered, record it first
    if (currentValue !== initialValue) {
      const interaction = recordingState.fieldInteractions.get(field);
      const focusStart = recordingState.focusTimers.get(field);
      const focusDuration = focusStart ? Date.now() - focusStart : 0;

      recordAction('field_fill', {
        target: fieldInfo,
        fieldFillDetail: {
          value: currentValue,
          initialValue: initialValue,
          inputType: interaction?.lastInputType || 'typing',
          focusDuration: focusDuration,
          keystrokeCount: interaction?.keystrokeCount || 0
        }
      });
    }

    // Now record the tab navigation action
    recordAction('tab', {
      target: fieldInfo,
      tabDetail: {
        direction: event.shiftKey ? 'backward' : 'forward'
      }
    });

    // Update field interaction for analytics
    const interaction = recordingState.fieldInteractions.get(field);
    if (interaction) {
      interaction.keystrokeCount = (interaction.keystrokeCount || 0) + 1;
    }

    saveRecordingState();
  }

  // Track delete/backspace (for analytics only, no separate action)
  if (event.key === 'Backspace' || event.key === 'Delete') {
    const interaction = recordingState.fieldInteractions.get(field);
    if (interaction) {
      interaction.keystrokeCount = (interaction.keystrokeCount || 0) + 1;
    }
    // No action recorded - just part of the field_fill that will be recorded on blur
  }
}

let lastButtonPurpose = null;

// Handle button clicks (submit, next, previous)
function handleButtonClick(event) {
  if (!recordingState.isActive) return;

  const button = event.target.closest('button, input[type="submit"], input[type="button"]') || event.target;
  const buttonPurpose = determineButtonPurpose(button);
  lastButtonPurpose = buttonPurpose;

  const buttonText = button.textContent.trim() || button.value?.trim() || '';

  const buttonInfo = {
    elementType: button.tagName.toLowerCase(),
    fieldName: button.name || button.id || '',
    fieldId: button.id || '',
    fieldLabel: buttonText,
    selector: getFieldSelector(button)
  };

  // Record button click
  recordAction('click', {
    target: buttonInfo,
    buttonDetail: {
      buttonText: buttonText,
      buttonPurpose: buttonPurpose
    }
  });

  saveRecordingState();

  // If it's a final submit, stop recording but wait for submission to complete before saving
  if (buttonPurpose === 'submit') {
    isManualRecording = false;
    recordingState.isActive = false;

    recordingEventListeners.forEach(({ element, type, handler, capture }) => {
      if (capture) {
        element.removeEventListener(type, handler, true);
      } else {
        element.removeEventListener(type, handler);
      }
    });
    recordingEventListeners = [];

    cleanupNavigationDetection();
    cleanupSPATransitionDetection();
    cleanupDynamicButtonObserver();
    cleanupGlobalRecordingListeners();
    stopFormRescan();

    chrome.runtime.sendMessage({
      type: 'RECORDING_STATE_CHANGED',
      isRecording: false
    });

    const form = button.closest('form');
    waitForFormSubmission(form || document.body, button).then(() => {
      if (recordingState.currentPage) {
        recordingState.currentPage.endTime = Date.now();
        recordingState.currentPage.duration = recordingState.currentPage.endTime - recordingState.currentPage.startTime;
        recordingState.pages.push(recordingState.currentPage);
      }

      const finalData = buildEnhancedRecordingData();
      downloadEnhancedRecordingAsJSON(finalData);

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

      clearRecordingState();
    });
  }

  // For navigation buttons, let the navigation happen naturally
  // The navigation detection will handle recording the page change
}

function waitForFormSubmission(formContainer, submitButton) {
  return new Promise((resolve) => {
    let resolved = false;
    const MAX_WAIT = 20000;
    const MIN_WAIT = 2000;
    const startTime = Date.now();
    let wasLoading = false;

    const done = () => {
      if (resolved) return;
      resolved = true;
      observer.disconnect();
      clearTimeout(fallbackTimer);
      window.removeEventListener('beforeunload', onBeforeUnload);
      setTimeout(resolve, 3000);
    };

    const tryDone = () => {
      if (resolved) return;
      if (Date.now() - startTime < MIN_WAIT) return;
      done();
    };

    const onBeforeUnload = () => {
      done();
    };

    window.addEventListener('beforeunload', onBeforeUnload);

    const isButtonLoading = () => {
      if (!submitButton || !submitButton.isConnected) return false;

      if (submitButton.disabled) return true;

      const cls = (submitButton.className || '').toLowerCase();
      if (
        cls.includes('loading') ||
        cls.includes('submitting') ||
        cls.includes('processing') ||
        cls.includes('spinner') ||
        cls.includes('is-loading') ||
        cls.includes('is-submitting') ||
        cls.includes('gf-disabled') ||
        cls.includes('disabled')
      ) return true;

      const text = (submitButton.textContent || submitButton.value || '').toLowerCase().trim();
      if (
        text.includes('submitting') ||
        text.includes('sending') ||
        text.includes('processing') ||
        text.includes('please wait') ||
        text.includes('loading')
      ) return true;

      const style = window.getComputedStyle(submitButton);
      if (style.opacity === '0' || style.opacity === '0.5' || style.cursor === 'wait') return true;

      const ariaBusy = submitButton.getAttribute('aria-busy');
      if (ariaBusy === 'true') return true;

      return false;
    };

    const observer = new MutationObserver(() => {
      if (resolved) return;

      if (isButtonLoading()) {
        wasLoading = true;
        return;
      }

      if (wasLoading) {
        tryDone();
        return;
      }

      const responseSelectors = [
        '[class*="success"]', '[class*="confirm"]', '[class*="thank"]',
        '[class*="message"]', '[class*="response"]', '[class*="notice"]',
        '[class*="error"]', '[class*="validation"]', '[class*="alert"]',
        '.gform_confirmation_wrapper', '.gform_confirmation_message',
        '.forminator-response-message', '.wpforms-confirmation-container-full',
        '.wpcf7-response-output', '.nf-response-msg',
        '.frm_message', '.frm_error_style',
        '.elementor-message', '.et-pb-contact-message'
      ];

      for (const sel of responseSelectors) {
        const el = formContainer.querySelector(sel);
        if (el && el.offsetParent !== null) {
          tryDone();
          return;
        }
      }
    });

    observer.observe(formContainer, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'disabled', 'aria-busy', 'value']
    });

    const fallbackTimer = setTimeout(done, MAX_WAIT);
  });
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
    pageIndex: 0, // Start on page 0 (first page)
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

  // Setup SPA page transition detection
  setupSPATransitionDetection();

  // Setup observer for dynamically injected buttons (Forminator, Elementor, etc.)
  setupDynamicButtonObserver();

  // Record initial page load action
  recordAction('page_load', {
    pageDetail: {
      url: window.location.href,
      pageTitle: document.title
    }
  });

  attachEventListenersToForms();

  setupGlobalRecordingListeners();

  startFormRescan();

  saveRecordingState();

  // Notify background script of recording state
  chrome.runtime.sendMessage({
    type: 'RECORDING_STATE_CHANGED',
    isRecording: true
  });

  return { success: true, isRecording: true };
}

// Attach event listeners to all form fields
function attachEventListenersToForms() {
  if (!recordedFormData || !recordedFormData.forms) return;

  recordedFormData.forms.forEach(formInfo => {
    formInfo.fields.forEach(fieldInfo => {
      const field = fieldInfo._element;
      if (!field || field._hasFormStatusListeners) return;

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

      // Mark as having listeners to avoid duplicates
      field._hasFormStatusListeners = true;
    });

    // Add form submit listener as backup
    const formElement = formInfo._formElement;
    if (formElement && !formElement._hasFormStatusListeners) {
      const submitHandler = (e) => {
        if (!recordingState.isActive) return;
        if (lastButtonPurpose === 'next' || lastButtonPurpose === 'previous') {
          lastButtonPurpose = null;
          return;
        }
        lastButtonPurpose = null;
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
      formElement._hasFormStatusListeners = true;
    }
  });
}

function setupGlobalRecordingListeners() {
  const events = [
    { type: 'focus', handler: globalFocusHandler },
    { type: 'blur', handler: globalBlurHandler },
    { type: 'input', handler: globalInputHandler },
    { type: 'change', handler: globalChangeHandler },
    { type: 'click', handler: globalClickHandler },
  ];

  events.forEach(({ type, handler }) => {
    document.addEventListener(type, handler, true);
    globalRecordingListeners.push({ type, handler });
  });

  console.log('FormStatus: Global recording listeners attached');
}

function cleanupGlobalRecordingListeners() {
  globalRecordingListeners.forEach(({ type, handler }) => {
    document.removeEventListener(type, handler, true);
  });
  globalRecordingListeners = [];
}

function isFormField(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return true;
  if (tag === 'button') return true;
  if (tag === 'input') {
    const t = (el.type || '').toLowerCase();
    if (t === 'submit' || t === 'button') return true;
  }
  return false;
}

function globalFocusHandler(event) {
  if (!recordingState.isActive) return;
  const field = event.target;
  if (!isFormField(field)) return;
  if (isButtonLikeElement(field)) return;
  if (isCaptchaField(field)) return;
  if (field._hasFormStatusListeners) return;
  handleFocus(event);
}

function globalBlurHandler(event) {
  if (!recordingState.isActive) return;
  const field = event.target;
  if (!isFormField(field)) return;
  if (isButtonLikeElement(field)) return;
  if (isCaptchaField(field)) return;
  if (field._hasFormStatusListeners) return;
  handleBlur(event);
}

function globalInputHandler(event) {
  if (!recordingState.isActive) return;
  const field = event.target;
  if (!isFormField(field)) return;
  if (isButtonLikeElement(field)) return;
  if (isCaptchaField(field)) return;
  if (field._hasFormStatusListeners) return;
  handleInput(event);
}

function globalChangeHandler(event) {
  if (!recordingState.isActive) return;
  const field = event.target;
  if (!isFormField(field)) return;
  if (isButtonLikeElement(field)) return;
  if (isCaptchaField(field)) return;
  if (field._hasFormStatusListeners) return;
  handleChange(event);
}

function globalClickHandler(event) {
  if (!recordingState.isActive) return;
  const el = event.target;

  const button = el.closest('button, input[type="submit"], input[type="button"]');
  if (button) {
    if (!button._hasFormStatusListeners) {
      handleButtonClick(event);
    }
    return;
  }

  if (isFormField(el) && !isButtonLikeElement(el) && !el._hasFormStatusListeners) {
    handleFieldClick(event);
  }
}

function startFormRescan() {
  if (rescanInterval) clearInterval(rescanInterval);

  let attempts = 0;
  rescanInterval = setInterval(() => {
    if (!recordingState.isActive || attempts >= 10) {
      clearInterval(rescanInterval);
      rescanInterval = null;
      return;
    }
    attempts++;

    const prevFormCount = recordedFormData ? recordedFormData.forms.length : 0;
    recordedFormData = scanForms();
    const newFormCount = recordedFormData ? recordedFormData.forms.length : 0;

    if (newFormCount > prevFormCount) {
      console.log(`FormStatus: Rescan found ${newFormCount} form(s), attaching listeners`);
      attachEventListenersToForms();
    }
  }, 1000);
}

function stopFormRescan() {
  if (rescanInterval) {
    clearInterval(rescanInterval);
    rescanInterval = null;
  }
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

    // Cleanup SPA transition detection
    cleanupSPATransitionDetection();

    // Cleanup dynamic button observer
    cleanupDynamicButtonObserver();

    cleanupGlobalRecordingListeners();
    stopFormRescan();

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
    totalFieldsFilled: recordingState.actions.filter(a => a.type === 'field_fill').length,
    totalTabs: recordingState.actions.filter(a => a.type === 'tab').length,
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
    startingUrl: recordingState.pages && recordingState.pages[0] ? recordingState.pages[0].url : window.location.href,
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
      totalFieldsFilled: 0,
      totalTabs: 0,
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
          if (lastButtonPurpose === 'next' || lastButtonPurpose === 'previous') {
            lastButtonPurpose = null;
            return;
          }
          lastButtonPurpose = null;
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

    // Setup SPA transition detection for resumed session
    setupSPATransitionDetection();

    // Setup dynamic button observer for resumed session
    setupDynamicButtonObserver();

    setupGlobalRecordingListeners();
    startFormRescan();

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