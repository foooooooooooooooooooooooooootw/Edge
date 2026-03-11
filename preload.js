const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // LAN
  getPeers: () => ipcRenderer.invoke('get-peers'),
  // UPnP transfer
  upnpSendInit:    (filePath) => ipcRenderer.invoke('upnp-send-init', { filePath }),
  upnpSendCancel:  ()         => ipcRenderer.invoke('upnp-send-cancel'),
  upnpReceiveInit: (code)     => ipcRenderer.invoke('upnp-receive-init', { code }),
  onUpnpProgress:     (cb) => ipcRenderer.on('upnp-progress',       (_e, d) => cb(d)),
  onUpnpConnected:    (cb) => ipcRenderer.on('upnp-connected',       ()      => cb()),
  onUpnpReceiveStart: (cb) => ipcRenderer.on('upnp-receive-start',   (_e, d) => cb(d)),
  onUpnpDone:         (cb) => ipcRenderer.on('upnp-done',            (_e, d) => cb(d)),
  onUpnpError:        (cb) => ipcRenderer.on('upnp-error',           (_e, d) => cb(d)),
  // WebRTC file I/O
  rtcReadChunk:   (filePath, offset, size) => ipcRenderer.invoke('rtc-read-chunk', { filePath, offset, size }),
  rtcWriteChunk:  (fileName, chunk) => ipcRenderer.invoke('rtc-write-chunk', { fileName, chunk }),
  rtcFileComplete:(fileName) => ipcRenderer.invoke('rtc-file-complete', { fileName }),
  onRtcFileSaved: (cb) => ipcRenderer.on('rtc-file-saved', (e, d) => cb(d)),
  // WebRTC file I/O
  rtcReadChunk:    (filePath, offset, size) => ipcRenderer.invoke('rtc-read-chunk', { filePath, offset, size }),
  rtcWriteChunk:   (name, chunk)            => ipcRenderer.invoke('rtc-write-chunk', { name, chunk }),
  rtcFileComplete: (name)                   => ipcRenderer.invoke('rtc-file-complete', { name }),
  onRtcSaved:      (cb) => ipcRenderer.on('rtc-saved', (_e, d) => cb(d)),
  windowMinimize:    () => ipcRenderer.send('window-minimize'),
  windowMaximize:    () => ipcRenderer.send('window-maximize'),
  windowClose:       () => ipcRenderer.send('window-close'),
  windowIsMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  sendTyping: (peerId, isTyping) => ipcRenderer.invoke('send-typing', { peerId, isTyping }),
  sendFile: (peerId, filePath, message, thumbnail) => ipcRenderer.invoke('send-file', { peerId, filePath, message, thumbnail }),
  sendMessage: (peerId, message, reply) => ipcRenderer.invoke('send-message', { peerId, message, reply }),
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
  onTypingReceived: (cb) => ipcRenderer.on('typing-received', (e, d) => cb(d)),
  onMessageReceived: (cb) => ipcRenderer.on('message-received', (e, d) => cb(d)),

  // WAN Direct
  wanDirectGetMyAddress: () => ipcRenderer.invoke('wan-direct-get-my-address'),
  wanDirectAddPeer: (id, ip, port, label) => ipcRenderer.invoke('wan-direct-add-peer', { id, ip, port, label }),
  wanDirectRemovePeer: (id) => ipcRenderer.invoke('wan-direct-remove-peer', { id }),

  // Encryption
  getEncryptLAN: () => ipcRenderer.invoke('get-encrypt-lan'),
  setEncryptLAN: (enabled) => ipcRenderer.invoke('set-encrypt-lan', enabled),

  // Reactions & read receipts
  sendReaction: (peerId, messageId, emoji) => ipcRenderer.invoke('send-reaction', { peerId, messageId, emoji }),
  sendReadReceipt: (peerId, messageId) => ipcRenderer.invoke('send-read-receipt', { peerId, messageId }),
  onReactionReceived: (cb) => ipcRenderer.on('reaction-received', (e, d) => cb(d)),
  onReadReceipt: (cb) => ipcRenderer.on('read-receipt', (e, d) => cb(d)),

  // Clipboard image paste
  saveClipboardImage: (dataUrl, filename) => ipcRenderer.invoke('save-clipboard-image', { dataUrl, filename }),

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
