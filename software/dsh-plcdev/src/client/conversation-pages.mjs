export const RECORDS_VIEW = 'plcdev-records';

// Reuse the host's public registered store handle. A separate store would
// select a second, disconnected page instead of the native conversation tab.
export function conversationStore(slots) {
  // Registered entries lift runtime fields (including store) out of options.
  // Reading options.store returns undefined and leaves an unregistered factory
  // in the renderer, which blanks all affected session slots on the desktop.
  const store=slots.entries('conversation.session').find(entry => entry.store)?.store;
  if(!store)throw new Error('DSH 会话页状态接口尚未就绪。');
  return store;
}

export function createConversationPages({sessions, uiConversation}) {
  const owners = new Map();
  return {
    bind(sessionId, actions) {
      const binding = sessions()?.binding(sessionId);
      if (binding && typeof actions?.openView === 'function') owners.set(sessionId, {binding, actions});
    },
    open(sessionId, view, focus) {
      if (!['chat', RECORDS_VIEW].includes(view)) return false;
      const owner = owners.get(sessionId), binding = sessions()?.binding(sessionId);
      if (!owner || !binding || owner.binding !== binding || !uiConversation()) return false;
      uiConversation().binding(binding).activate(view);
      owner.actions.openView(view, focus);
      return true;
    },
    dispose() { owners.clear(); },
  };
}
