// Native tab-strip markers. Only debugger-attached tabs are moved into our groups.
// Keep the previous grouping in session storage so detaching can put tabs back.
class RelayTabMarkers {
  placements = new Map();
  groups = new Map(); // groupId -> owner ID, or null for unclaimed tabs
  restoredGroups = new Map();
  queue = Promise.resolve();

  run(task) {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }

  restore(tabIds, owners = new Map()) {
    return this.run(async () => {
      const { tabMarkers = {} } = await chrome.storage.session.get('tabMarkers');
      this.placements = new Map(tabMarkers.placements ?? []);
      this.groups = new Map((tabMarkers.groups ?? []).map((entry) => Array.isArray(entry) ? entry : [entry, null]));
      this.restoredGroups = new Map(tabMarkers.restoredGroups ?? []);
      for (const tabId of this.placements.keys()) {
        if (!tabIds.includes(tabId)) await this.unmarkTab(tabId);
      }
      for (const tabId of tabIds) await this.markTab(tabId, owners.get(tabId));
    });
  }

  mark(tabId, owner) {
    return this.run(() => this.markTab(tabId, owner));
  }

  unmark(tabId) {
    return this.run(() => this.unmarkTab(tabId));
  }

  groupRemoved(groupId) {
    return this.run(async () => {
      this.groups.delete(groupId);
      for (const [original, restored] of this.restoredGroups) {
        if (restored === groupId) this.restoredGroups.delete(original);
      }
      await this.persist();
    });
  }

  async markTab(tabId, owner = null) {
    const ownerId = owner?.id ?? null;
    const tab = await chrome.tabs.get(tabId);
    if (!this.placements.has(tabId)) {
      const originalGroup = tab.groupId === -1 ? null : await chrome.tabGroups.get(tab.groupId);
      this.placements.set(tabId, { windowId: tab.windowId, pinned: tab.pinned, originalGroup });
      await this.persist();
    }
    if (this.groups.has(tab.groupId) && this.groups.get(tab.groupId) === ownerId) return;
    const candidates = await chrome.tabGroups.query({ windowId: tab.windowId });
    const existing = candidates.find((group) => this.groups.has(group.id) && this.groups.get(group.id) === ownerId);
    if (tab.pinned) await chrome.tabs.update(tabId, { pinned: false });
    const groupId = await chrome.tabs.group({ tabIds: [tabId], ...(existing ? { groupId: existing.id } : {}) });
    this.groups.set(groupId, ownerId);
    await chrome.tabGroups.update(groupId, { title: owner ? `Browser Relay · ${owner.name}` : 'Browser Relay', color: 'orange', collapsed: false });
    await this.persist();
  }

  async unmarkTab(tabId) {
    const previous = this.placements.get(tabId);
    if (!previous) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && this.groups.has(tab.groupId)) {
      const original = previous.originalGroup;
      if (original && previous.windowId === tab.windowId) {
        const oldId = this.restoredGroups.get(original.id) ?? original.id;
        const oldGroup = await chrome.tabGroups.get(oldId).catch(() => null);
        if (oldGroup?.windowId === tab.windowId) {
          await chrome.tabs.group({ tabIds: [tabId], groupId: oldId });
        } else {
          // Chrome destroys empty groups, so recreate the original if needed.
          const groupId = await chrome.tabs.group({ tabIds: [tabId] });
          await chrome.tabGroups.update(groupId, {
            title: original.title ?? '', color: original.color, collapsed: original.collapsed,
          });
          this.restoredGroups.set(original.id, groupId);
        }
      } else {
        await chrome.tabs.ungroup([tabId]);
      }
    }
    if (tab && previous.pinned) await chrome.tabs.update(tabId, { pinned: true });
    this.placements.delete(tabId);
    await this.persist();
  }

  persist() {
    return chrome.storage.session.set({ tabMarkers: {
      placements: [...this.placements], groups: [...this.groups], restoredGroups: [...this.restoredGroups],
    } });
  }
}
