const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // LAN
  getPeers: () => ipcRenderer.invoke('get-peers'),
  windowMinimize:    () => ipcRenderer.send('window-minimize'),
  windowMaximize:    () => ipcRenderer.send('window-maximize'),
  windowClose:       () => ipcRenderer.send('window-close'),
  windowIsMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  sendFile: (peerId, filePath, message, thumbnail) => ipcRenderer.invoke('send-file', { peerId, filePath, message, thumbnail }),
  sendMessage: (peerId, message) => ipcRenderer.invoke('send-message', { peerId, message }),
  setUsername: (username) => ipcRenderer.invoke('set-username', username),
  setAvatar: (base64Image) => ipcRenderer.invoke('set-avatar', base64Image),
  getUserInfo: () => ipcRenderer.invoke('get-user-info'),
  setFavoriteNickname: (peerId, nickname) => ipcRenderer.invoke('set-favorite-nickname', { peerId, nickname }),
  acceptFile: (transferId) => ipcRenderer.invoke('accept-file', { transferId }),
  declineFile: (transferId) => ipcRenderer.invoke('decline-file', { transferId }),
  getReceiveMode: () => ipcRenderer.invoke('get-receive-mode'),
  setReceiveMode: (mode) => ipcRenderer.invoke('set-receive-mode', mode),
  openFile: (filePath) => ipcRenderer.invoke('open-file', { filePath }),
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', { filePath }),

  // WAN
  wanSendPrivate: (filePath) => ipcRenderer.invoke('wan-send-private', { filePath }),
  wanSendSemiPrivate: (filePath) => ipcRenderer.invoke('wan-send-semi-private', { filePath }),
  wanReceiveMagnet: (magnetURI) => ipcRenderer.invoke('wan-receive-magnet', { magnetURI }),
  wanOpenTorrentFile: (filePath) => ipcRenderer.invoke('wan-open-torrent-file', filePath),
  wanSendDirect: (ip, port, filePath) => ipcRenderer.invoke('wan-send-direct', { ip, port, filePath }),
  wanGetAddresses: () => ipcRenderer.invoke('wan-get-addresses'),
  wanCancelSend: (infoHash) => ipcRenderer.invoke('wan-cancel-send', { infoHash }),
  wanCancelReceive: (infoHash) => ipcRenderer.invoke('wan-cancel-receive', { infoHash }),
  wanGetTransfers: () => ipcRenderer.invoke('wan-get-transfers'),
  wanExportTorrent: (infoHash) => ipcRenderer.invoke('wan-export-torrent', { infoHash }),

  // Torrents
  torrentAdd: (magnet, torrentFilePath) => ipcRenderer.invoke('torrent-add', { magnet, torrentFilePath }),
  torrentPickFile: () => ipcRenderer.invoke('torrent-pick-file'),
  torrentGetAll: () => ipcRenderer.invoke('torrent-get-all'),
  setTorrentTrackers: (trackers) => ipcRenderer.invoke('set-torrent-trackers', { trackers }),
  torrentSetFilePriority: (infoHash, fileIndex, priority) => ipcRenderer.invoke('torrent-set-file-priority', { infoHash, fileIndex, priority }),
  torrentGetFilePath: (infoHash, fileIndex) => ipcRenderer.invoke('torrent-get-file-path', { infoHash, fileIndex }),
  torrentGetStreamUrl: (infoHash, fileIndex) => ipcRenderer.invoke('torrent-get-stream-url', { infoHash, fileIndex }),
  torrentPause: (infoHash) => ipcRenderer.invoke('torrent-pause', { infoHash }),
  torrentResume: (infoHash) => ipcRenderer.invoke('torrent-resume', { infoHash }),
  torrentRemove: (infoHash, deleteFiles) => ipcRenderer.invoke('torrent-remove', { infoHash, deleteFiles }),

  // LAN Events
  onPeerDiscovered: (cb) => ipcRenderer.on('peer-discovered', (e, d) => cb(d)),
  onPeerLeft: (cb) => ipcRenderer.on('peer-left', (e, d) => cb(d)),
  onTransferProgress: (cb) => ipcRenderer.on('transfer-progress', (e, d) => cb(d)),
  onTransferComplete: (cb) => ipcRenderer.on('transfer-complete', (e, d) => cb(d)),
  onFileReceived: (cb) => ipcRenderer.on('file-received', (e, d) => cb(d)),
  onFileReceiveError: (cb) => ipcRenderer.on('file-receive-error', (e, d) => cb(d)),
  onFileReceiveCanceled: (cb) => ipcRenderer.on('file-receive-canceled', (e, d) => cb(d)),
  onFileIncoming: (cb) => ipcRenderer.on('file-incoming', (e, d) => cb(d)),
  onFileIncomingAccepted: (cb) => ipcRenderer.on('file-incoming-accepted', (e, d) => cb(d)),
  onTransferCompleteIncoming: (cb) => ipcRenderer.on('transfer-complete-incoming', (e, d) => cb(d)),
  onMessageReceived: (cb) => ipcRenderer.on('message-received', (e, d) => cb(d)),

  // WAN Events
  onWanProgress: (cb) => ipcRenderer.on('wan-progress', (e, d) => cb(d)),
  onWanComplete: (cb) => ipcRenderer.on('wan-complete', (e, d) => cb(d)),
  onWanError: (cb) => ipcRenderer.on('wan-error', (e, d) => cb(d)),
  onWanReceiveStarted: (cb) => ipcRenderer.on('wan-receive-started', (e, d) => cb(d)),
  onWanMetadata: (cb) => ipcRenderer.on('wan-metadata', (e, d) => cb(d)),
  onWanDirectIncoming: (cb) => ipcRenderer.on('wan-direct-incoming', (e, d) => cb(d)),
  onWanDirectComplete: (cb) => ipcRenderer.on('wan-direct-complete', (e, d) => cb(d)),

  // Torrent Events
  onTorrentAdded: (cb) => ipcRenderer.on('torrent-added', (e, d) => cb(d)),
  onTorrentMetadata: (cb) => ipcRenderer.on('torrent-metadata', (e, d) => cb(d)),
  onTorrentProgress: (cb) => ipcRenderer.on('torrent-progress', (e, d) => cb(d)),
  onTorrentComplete: (cb) => ipcRenderer.on('torrent-complete', (e, d) => cb(d)),
  onTorrentError: (cb) => ipcRenderer.on('torrent-error', (e, d) => cb(d)),
});
