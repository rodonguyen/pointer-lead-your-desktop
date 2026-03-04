const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pointer', {
  // Renderer → Main (invoke)
  askQuestion: (question) => ipcRenderer.invoke('ask-question', question),
  nextStep: () => ipcRenderer.invoke('next-step'),
  prevStep: () => ipcRenderer.invoke('prev-step'),
  markStuck: () => ipcRenderer.invoke('mark-stuck'),
  resetSession: () => ipcRenderer.invoke('reset-session'),

  // Main → Renderer (listen)
  on: (channel, callback) => {
    const allowed = ['steps-ready', 'step-changed', 'loading', 'error', 'show-pointer', 'hide-pointer'];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    }
  },
  off: (channel, callback) => {
    ipcRenderer.removeListener(channel, callback);
  },
});
