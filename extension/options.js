const list = document.getElementById('relays');
const template = document.getElementById('relay');
let statuses = {};

async function render() {
  const relays = await loadRelays();
  ({ relayStatus: statuses = {} } = await chrome.storage.session.get('relayStatus'));
  list.replaceChildren(...relays.map(row));
}

// Saved tokens are never shown again; leaving the field blank keeps the saved one.
function row(relay = null) {
  const fieldset = template.content.firstElementChild.cloneNode(true);
  const field = (name) => fieldset.querySelector(`[name="${name}"]`);
  const message = fieldset.querySelector('.message');
  fieldset.dataset.id = relay?.id ?? '';
  fieldset.querySelector('.title').textContent = relay?.name ?? 'New relay';
  field('name').value = relay?.name ?? '';
  field('url').value = relay?.url ?? '';
  field('token').placeholder = relay?.token ? 'Saved. Leave blank to keep it' : 'Paste the token from browser-relay token';
  showStatus(fieldset);

  fieldset.querySelector('.save').addEventListener('click', async () => {
    const current = await loadRelays();
    const saved = current.find((r) => r.id === relay?.id);
    const edited = {
      id: relay?.id, name: field('name').value, url: field('url').value,
      token: field('token').value.trim() || saved?.token || '',
    };
    try {
      const relays = validateRelays(saved ? current.map((r) => (r === saved ? edited : r)) : [...current, edited]);
      await chrome.storage.local.set({ relays });
    } catch (err) {
      message.className = 'message error';
      message.textContent = err.message;
    }
  });
  fieldset.querySelector('.remove').addEventListener('click', async () => {
    if (!relay) return fieldset.remove();
    // The extension releases the tabs this relay's sessions owned.
    const current = await loadRelays();
    await chrome.storage.local.set({ relays: current.filter((r) => r.id !== relay.id) });
  });
  return fieldset;
}

function showStatus(fieldset) {
  const status = fieldset.querySelector('.status');
  const text = fieldset.dataset.id ? statuses[fieldset.dataset.id] ?? 'offline' : 'not saved';
  status.textContent = `· ${text}`;
  status.className = text === 'connected' ? 'status connected' : 'status';
}

document.getElementById('add').addEventListener('click', () => list.append(row()));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.relays) render();
  if (area === 'session' && changes.relayStatus) {
    statuses = changes.relayStatus.newValue ?? {};
    list.querySelectorAll('fieldset').forEach(showStatus);
  }
});
render();
