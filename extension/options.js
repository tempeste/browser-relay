const tokenInput = document.getElementById('token');
const portInput = document.getElementById('port');
const status = document.getElementById('status');

chrome.storage.local.get(['token', 'port']).then(({ token, port }) => {
  tokenInput.value = token ?? '';
  portInput.value = port ?? '';
});

document.getElementById('save').addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  const port = Number(portInput.value) || undefined;
  await chrome.storage.local.set({ token, port });
  status.textContent = ' Saved.';
});
