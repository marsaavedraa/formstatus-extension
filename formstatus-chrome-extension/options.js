document.addEventListener('DOMContentLoaded', async () => {
  const envSelect = document.getElementById('envSelect');
  const statusDiv = document.getElementById('status');
  const currentUrlEl = document.getElementById('currentUrl');

  const response = await chrome.runtime.sendMessage({ type: 'GET_API_URL' });
  const currentUrl = response?.url || 'https://app.formstatus.co';

  currentUrlEl.textContent = currentUrl;
  envSelect.value = currentUrl;

  envSelect.addEventListener('change', async () => {
    const newUrl = envSelect.value;

    const result = await chrome.runtime.sendMessage({
      type: 'SET_API_URL',
      url: newUrl
    });

    if (result?.success) {
      currentUrlEl.textContent = newUrl;
      statusDiv.textContent = `Switched to ${newUrl}`;
      statusDiv.className = 'status success';
      setTimeout(() => { statusDiv.style.display = 'none'; }, 3000);
    }
  });
});
