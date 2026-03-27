'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('edge', {
  getMyInfo:            ()                    => ipcRenderer.invoke('get-my-info'),
  getPeers:             ()                    => ipcRenderer.invoke('get-peers'),
  addPeer:              (ip, port)            => ipcRenderer.invoke('add-peer', { ip, port }),
  sendMessage:          (peerId, text, replyTo) => ipcRenderer.invoke('send-message', { peerId, text, replyTo: replyTo||null }),
  sendReaction:         (peerId, msgId, emoji) => ipcRenderer.invoke('send-reaction', { peerId, msgId, emoji }),
  pickAndSendFile:      (peerId)              => ipcRenderer.invoke('pick-and-send-file', { peerId }),
  pickAndSendFilePath:  (peerId, fp)          => ipcRenderer.invoke('pick-and-send-file-path', { peerId, filePath: fp }),
  saveFile:             (fileId, name)        => ipcRenderer.invoke('save-file', { fileId, name }),
  openFile:             (filePath)            => ipcRenderer.invoke('open-file', filePath),
  saveReceivedFile:     (fileId, name, mime)  => ipcRenderer.invoke('save-received-file', { fileId, name, mime }),
  respondToFile:        (fileId, peerId, ok)  => ipcRenderer.invoke('respond-to-file', { fileId, peerId, accepted: ok }),
  getFileData:          (fileId)              => ipcRenderer.invoke('get-file-data', fileId),
  getMediaPreview:      (fileId)              => ipcRenderer.invoke('get-media-preview', fileId),
  getSettings:          ()                    => ipcRenderer.invoke('get-settings'),
  saveSettings:         (patch)               => ipcRenderer.invoke('save-settings', patch),
  pickProfilePic:       ()                    => ipcRenderer.invoke('pick-profile-pic'),
  clearProfilePic:      ()                    => ipcRenderer.invoke('clear-profile-pic'),
  minimize:             ()                    => ipcRenderer.invoke('win-minimize'),
  maximize:             ()                    => ipcRenderer.invoke('win-maximize'),
  close:                ()                    => ipcRenderer.invoke('win-close'),
  getNicSpeed:          ()                    => ipcRenderer.invoke('get-nic-speed'),
  on: (channel, cb) => {
    const allowed = [
      'peer-connected','peer-reconnected','peer-disconnected',
      'peer-profile-updated',
      'message-received','reaction-received',
      'file-progress','file-transfer-start','file-incoming-request',
      'file-rejected','file-ready-to-save','file-received',
      'file-send-start','file-send-done','file-send-rejected','upnp-status',
    ];
    if (!allowed.includes(channel)) return () => {};
    const fn = (_, ...a) => cb(...a);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
});
