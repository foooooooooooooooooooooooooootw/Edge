const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const NetworkManager = require('./network-manager');
const WANManager = require('./wan-manager');
const { UPnPTransfer } = require('./upnp-transfer');

// ── WebRTC file I/O helpers ──────────────────────────────────
const rtcWrites = new Map(); // name → {stream, finalPath}


let mainWindow, networkManager, wanManager;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000, height: 700,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js'), webSecurity: false },
    autoHideMenuBar: true, backgroundColor: '#1e1e1e'
  });
  mainWindow.loadFile('index.html');
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  // --- LAN ---
  networkManager = new NetworkManager();
  networkManager.on('peer-discovered', d => mainWindow.webContents.send('peer-discovered', d));
  networkManager.on('peer-left', d => mainWindow.webContents.send('peer-left', d));
  networkManager.on('transfer-progress', d => mainWindow.webContents.send('transfer-progress', d));
  networkManager.on('transfer-complete', d => mainWindow.webContents.send('transfer-complete', d));
  networkManager.on('message-received', d => mainWindow.webContents.send('message-received', d));
  networkManager.on('typing-received',   d => mainWindow.webContents.send('typing-received', d));

  networkManager.on('file-incoming', async (data) => {
    // Guard: ignore malformed events with no filename (e.g. stray message-type packets)
    if (!data.filename || !data.size) return;
    const receiveMode = networkManager.getReceiveMode();
    if (receiveMode === 'ask-before') {
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'question', title: 'Incoming File',
        message: `${data.sender} wants to send you a file`,
        detail: `File: ${data.filename}\nSize: ${(data.size/1024/1024).toFixed(2)} MB${data.message ? `\nMessage: "${data.message}"` : ''}`,
        buttons: ['Accept', 'Decline'], defaultId: 0, cancelId: 1
      });
      if (result.response === 0) {
        const saveResult = await dialog.showSaveDialog(mainWindow, { title: 'Save File', defaultPath: path.join(app.getPath('downloads'), data.filename), buttonLabel: 'Save' });
        if (!saveResult.canceled && saveResult.filePath) {
          networkManager.setSavePathForTransfer(data.transferId, saveResult.filePath);
          mainWindow.webContents.send('file-incoming-accepted', { transferId: data.transferId, filename: data.filename, size: data.size, peerIp: data.peerIp, message: data.message, thumbnail: data.thumbnail, sender: data.sender, senderAvatar: data.senderAvatar, savePath: saveResult.filePath });
        } else { networkManager.discardReceivedFile(data.transferId); }
      } else { networkManager.discardReceivedFile(data.transferId); }
    } else if (receiveMode === 'auto-accept-ask-location') {
      const savePath = path.join(app.getPath('temp'), data.filename);
      networkManager.setSavePathForTransfer(data.transferId, savePath);
      mainWindow.webContents.send('file-incoming-accepted', { transferId: data.transferId, filename: data.filename, size: data.size, peerIp: data.peerIp, message: data.message, thumbnail: data.thumbnail, sender: data.sender, senderAvatar: data.senderAvatar, savePath, tempFile: true });
    } else {
      const savePath = path.join(app.getPath('downloads'), data.filename);
      networkManager.setSavePathForTransfer(data.transferId, savePath);
      mainWindow.webContents.send('file-incoming-accepted', { transferId: data.transferId, filename: data.filename, size: data.size, peerIp: data.peerIp, message: data.message, thumbnail: data.thumbnail, sender: data.sender, senderAvatar: data.senderAvatar, savePath });
    }
  });

  networkManager.on('file-received', async (data) => {
    if (data.path.includes(app.getPath('temp'))) {
      const result = await dialog.showSaveDialog(mainWindow, { title: 'Save Downloaded File', defaultPath: path.join(app.getPath('downloads'), data.filename), buttonLabel: 'Save' });
      if (!result.canceled && result.filePath) {
        try { fs.renameSync(data.path, result.filePath); mainWindow.webContents.send('file-received', { ...data, path: result.filePath }); }
        catch { mainWindow.webContents.send('file-received', data); }
      } else { try { fs.unlinkSync(data.path); } catch {} }
    } else { mainWindow.webContents.send('file-received', data); }
  });

  networkManager.start();

  // --- WAN ---
  wanManager = new WANManager();
  wanManager.startStreamServer();
  // Restore torrents from last session
  const torrentPersistPath = path.join(app.getPath('userData'), 'torrents.json');
  wanManager.loadPersistedTorrents(torrentPersistPath);
  wanManager.on('wan-progress', d => mainWindow.webContents.send('wan-progress', d));
  wanManager.on('wan-complete', d => mainWindow.webContents.send('wan-complete', d));
  wanManager.on('wan-error', d => mainWindow.webContents.send('wan-error', d));
  wanManager.on('wan-receive-started', d => mainWindow.webContents.send('wan-receive-started', d));
  wanManager.on('wan-metadata', d => mainWindow.webContents.send('wan-metadata', d));
  wanManager.on('wan-direct-incoming', d => mainWindow.webContents.send('wan-direct-incoming', d));
  wanManager.on('wan-direct-complete', d => mainWindow.webContents.send('wan-direct-complete', d));
  wanManager.on('torrent-added', d => mainWindow.webContents.send('torrent-added', d));
  wanManager.on('torrent-metadata', d => mainWindow.webContents.send('torrent-metadata', d));
  wanManager.on('torrent-progress', d => mainWindow.webContents.send('torrent-progress', d));
  wanManager.on('torrent-complete', d => mainWindow.webContents.send('torrent-complete', d));
  wanManager.on('torrent-error', d => mainWindow.webContents.send('torrent-error', d));

  wanManager.startDirectServer(async (connId, fileInfo, remoteIp) => {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question', title: 'Incoming File (Internet)',
      message: `Someone wants to send you a file`,
      detail: `File: ${fileInfo.filename}\nSize: ${(fileInfo.size/1024/1024).toFixed(2)} MB\nFrom: ${remoteIp}`,
      buttons: ['Accept', 'Decline'], defaultId: 0, cancelId: 1
    });
    if (result.response !== 0) return null;
    const saveResult = await dialog.showSaveDialog(mainWindow, { title: 'Save File', defaultPath: path.join(app.getPath('downloads'), fileInfo.filename), buttonLabel: 'Save' });
    return saveResult.canceled ? null : saveResult.filePath;
  }).catch(console.error);

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

function cleanupAndQuit() {
  if (networkManager) { try { networkManager.stop(); } catch {} }
  if (wanManager) { try { wanManager.destroy(); } catch {} }
  setTimeout(() => process.exit(0), 500);
}

app.on('window-all-closed', cleanupAndQuit);
app.on('before-quit', () => {
  if (networkManager) { try { networkManager.stop(); } catch {} }
  if (wanManager) { try { wanManager.destroy(); } catch {} }
});

// ==================== WINDOW CONTROLS ====================
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => { if (mainWindow?.isMaximized()) mainWindow.unmaximize(); else mainWindow?.maximize(); });
ipcMain.on('window-close',    () => mainWindow?.close());
ipcMain.handle('window-is-maximized', () => mainWindow?.isMaximized() ?? false);

// ==================== LAN IPC ====================
ipcMain.handle('get-peers', () => networkManager.getPeers());
ipcMain.handle('send-file', async (e, { peerId, filePath, thumbnail, message }) => {
  // Renderer pre-extracts thumbnails and passes them here
  if (thumbnail) networkManager.setPendingThumbnail(filePath, thumbnail);
  return networkManager.sendFile(peerId, filePath, message);
});
ipcMain.handle('send-typing', async (e, { peerId, isTyping }) => {
  try { await networkManager.sendTyping(peerId, isTyping); } catch {}
  return true;
});
ipcMain.handle('send-message', async (e, { peerId, message, reply }) => {
  try { await networkManager.sendMessage(peerId, message, reply || null); return { success: true }; }
  catch (err) { return { success: false, error: err.message }; }
});
ipcMain.handle('set-username', async (e, username) => { networkManager.setUsername(username); return true; });
ipcMain.handle('set-avatar', async (e, base64Image) => {
  try { networkManager.setAvatar(base64Image); return { success: true }; }
  catch (err) { return { success: false, error: err.message }; }
});
ipcMain.handle('get-user-info', async () => ({ username: networkManager.username, peerId: networkManager.peerId, avatar: networkManager.avatar }));
ipcMain.handle('set-favorite-nickname', async (e, { peerId, nickname }) => { networkManager.setFavoriteNickname(peerId, nickname); return true; });
ipcMain.handle('accept-file', async (e, { transferId }) => {
  const transfer = networkManager.activeTransfers.get(transferId);
  if (!transfer) return { success: false, error: 'Transfer not found' };
  const result = await dialog.showSaveDialog(mainWindow, { title: 'Save File', defaultPath: path.join(app.getPath('downloads'), transfer.fileInfo.filename), buttonLabel: 'Save', properties: ['createDirectory'] });
  if (!result.canceled && result.filePath) {
    try { await networkManager.saveReceivedFile(transferId, result.filePath); return { success: true, path: result.filePath, filename: transfer.fileInfo.filename, size: transfer.fileInfo.size }; }
    catch (err) { return { success: false, error: err.message }; }
  } else { networkManager.discardReceivedFile(transferId); return { success: false, canceled: true }; }
});
ipcMain.handle('decline-file', async (e, { transferId }) => { networkManager.discardReceivedFile(transferId); return { success: true }; });
ipcMain.handle('get-receive-mode', async () => networkManager.getReceiveMode());
ipcMain.handle('set-receive-mode', async (e, mode) => { networkManager.setReceiveMode(mode); return { success: true }; });
ipcMain.handle('open-file', async (e, { filePath }) => {
  const { shell } = require('electron');
  try { await shell.openPath(filePath); return { success: true }; }
  catch (err) { return { success: false, error: err.message }; }
});
ipcMain.handle('show-in-folder', async (e, { filePath }) => { const { shell } = require('electron'); shell.showItemInFolder(filePath); return { success: true }; });

// ==================== WebRTC I/O IPC ====================
ipcMain.handle('rtc-read-chunk', async (_e, { filePath, offset, size }) => {
  const fh  = await fs.promises.open(filePath, 'r');
  const buf = Buffer.alloc(size);
  await fh.read(buf, 0, size, offset);
  await fh.close();
  return buf; // Electron serialises Buffers over IPC fine
});

ipcMain.handle('rtc-write-chunk', async (_e, { name, chunk }) => {
  if (!rtcWrites.has(name)) {
    const base  = path.join(app.getPath('downloads'), name);
    const final = fs.existsSync(base)
      ? path.join(app.getPath('downloads'), `${Date.now()}_${name}`)
      : base;
    rtcWrites.set(name, { stream: fs.createWriteStream(final), finalPath: final });
  }
  const { stream } = rtcWrites.get(name);
  await new Promise((ok, fail) => stream.write(Buffer.from(chunk), e => e ? fail(e) : ok()));
  return { ok: true };
});

ipcMain.handle('rtc-file-complete', async (_e, { name }) => {
  const entry = rtcWrites.get(name);
  if (entry) {
    await new Promise(ok => entry.stream.end(ok));
    rtcWrites.delete(name);
    mainWindow?.webContents.send('rtc-saved', { name, filePath: entry.finalPath });
  }
  return { ok: true };
});

// ==================== UPnP Transfer IPC ====================
let upnpTransfer = null;

ipcMain.handle('upnp-send-init', async (_e, { filePath }) => {
  try {
    upnpTransfer = new UPnPTransfer();

    upnpTransfer.on('progress', d => mainWindow?.webContents.send('upnp-progress', d));
    upnpTransfer.on('connected', () => mainWindow?.webContents.send('upnp-connected'));
    upnpTransfer.on('done',      d => mainWindow?.webContents.send('upnp-done', d));
    upnpTransfer.on('error',     e => mainWindow?.webContents.send('upnp-error', { message: e.message }));
    upnpTransfer.on('declined',  () => mainWindow?.webContents.send('upnp-error', { message: 'Transfer declined by receiver' }));

    const code = await upnpTransfer.initSend(filePath);
    return { success: true, code };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('upnp-send-cancel', async () => {
  try { await upnpTransfer?.cleanup(); } catch {}
  upnpTransfer = null;
  return { success: true };
});

ipcMain.handle('upnp-receive-init', async (_e, { code }) => {
  try {
    const saveResult = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Download Folder', properties: ['openDirectory'], buttonLabel: 'Save Here'
    });
    if (saveResult.canceled) return { success: false, canceled: true };
    const savePath = saveResult.filePaths[0];

    upnpTransfer = new UPnPTransfer();
    upnpTransfer.on('progress',     d => mainWindow?.webContents.send('upnp-progress', d));
    upnpTransfer.on('connected',    () => mainWindow?.webContents.send('upnp-connected'));
    upnpTransfer.on('receiveStart', d => mainWindow?.webContents.send('upnp-receive-start', d));
    upnpTransfer.on('done',         d => mainWindow?.webContents.send('upnp-done', d));
    upnpTransfer.on('error',        e => mainWindow?.webContents.send('upnp-error', { message: e.message }));

    // Kick off async — main resolves immediately with savePath
    upnpTransfer.initReceive(code, savePath).catch(err =>
      mainWindow?.webContents.send('upnp-error', { message: err.message })
    );
    return { success: true, savePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ==================== WAN IPC ====================
ipcMain.handle('wan-send-private', async (e, { filePath }) => {
  try { return { success: true, ...await wanManager.createPrivateSend(filePath) }; }
  catch (err) { return { success: false, error: err.message }; }
});
ipcMain.handle('wan-send-semi-private', async (e, { filePath }) => {
  try { return { success: true, ...await wanManager.createSemiPrivateSend(filePath) }; }
  catch (err) { return { success: false, error: err.message }; }
});
ipcMain.handle('wan-receive-magnet', async (e, { magnetURI }) => {
  try {
    const saveResult = await dialog.showOpenDialog(mainWindow, { title: 'Choose Download Folder', properties: ['openDirectory'], buttonLabel: 'Save Here' });
    if (saveResult.canceled) return { success: false, canceled: true };
    wanManager.receiveFromMagnet(magnetURI, saveResult.filePaths[0]).catch(err => mainWindow.webContents.send('wan-error', { error: err.message }));
    return { success: true, savePath: saveResult.filePaths[0] };
  } catch (err) { return { success: false, error: err.message }; }
});
ipcMain.handle('wan-open-torrent-file', async (e, filePath) => {
  try {
    let torrentPath = filePath;
    if (!torrentPath) {
      const picked = await dialog.showOpenDialog(mainWindow, { title: 'Open Torrent File', filters: [{ name: 'Torrent Files', extensions: ['torrent'] }], properties: ['openFile'] });
      if (picked.canceled) return { success: false, canceled: true };
      torrentPath = picked.filePaths[0];
    }
    const saveResult = await dialog.showOpenDialog(mainWindow, { title: 'Choose Download Folder', properties: ['openDirectory'], buttonLabel: 'Download Here' });
    if (saveResult.canceled) return { success: false, canceled: true };
    const torrentData = fs.readFileSync(torrentPath);
    wanManager.receiveFromMagnet(torrentData, saveResult.filePaths[0])
      .then(r => mainWindow.webContents.send('wan-complete', r))
      .catch(e => mainWindow.webContents.send('wan-error', { error: e.message }));
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});
ipcMain.handle('wan-send-direct', async (e, { ip, port, filePath }) => {
  try { return { success: true, ...await wanManager.sendViaDirect(ip, port, filePath) }; }
  catch (err) { return { success: false, error: err.message }; }
});
ipcMain.handle('wan-get-addresses', async () => ({ localIp: wanManager.getLocalIP(), publicIp: await wanManager.getPublicIP(), directPort: wanManager.directPort }));
ipcMain.handle('wan-cancel-send', async (e, { infoHash }) => { wanManager.cancelWanSend(infoHash); return { success: true }; });
ipcMain.handle('wan-cancel-receive', async (e, { infoHash }) => { wanManager.cancelWanReceive(infoHash); return { success: true }; });
ipcMain.handle('wan-get-transfers', async () => ({ sends: wanManager.getActiveSends(), receives: wanManager.getActiveReceives() }));
ipcMain.handle('wan-export-torrent', async (e, { infoHash }) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, { title: 'Save Torrent File', defaultPath: path.join(app.getPath('downloads'), 'transfer.torrent'), filters: [{ name: 'Torrent Files', extensions: ['torrent'] }], buttonLabel: 'Save' });
    if (result.canceled) return { success: false, canceled: true };
    await wanManager.exportTorrentFile(infoHash, result.filePath);
    return { success: true, path: result.filePath };
  } catch (err) { return { success: false, error: err.message }; }
});

// ==================== TORRENT IPC ====================
ipcMain.handle('torrent-add', async (e, { magnet, torrentFilePath }) => {
  try {
    const saveResult = await dialog.showOpenDialog(mainWindow, { title: 'Choose Download Folder', properties: ['openDirectory'], buttonLabel: 'Download Here' });
    if (saveResult.canceled) return { success: false, canceled: true };
    // Accept either a magnet string or a .torrent file path
    let source = magnet;
    if (torrentFilePath) {
      source = require('fs').readFileSync(torrentFilePath);
    }
    const result = await wanManager.addTorrent(source, saveResult.filePaths[0]);
    return { success: true, ...result, savePath: saveResult.filePaths[0] };
  } catch (err) { return { success: false, error: err.message }; }
});
ipcMain.handle('torrent-pick-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Torrent File',
    filters: [{ name: 'Torrent Files', extensions: ['torrent'] }],
    properties: ['openFile']
  });
  if (result.canceled) return { success: false, canceled: true };
  return { success: true, filePath: result.filePaths[0] };
});
ipcMain.handle('torrent-get-all', async () => wanManager.getTorrents());
ipcMain.handle('set-torrent-trackers', async (e, { trackers }) => { wanManager.setUserTrackers(trackers); return true; });
ipcMain.handle('torrent-set-file-priority', async (e, { infoHash, fileIndex, priority }) => {
  return wanManager.setFilePriority(infoHash, fileIndex, priority);
});
ipcMain.handle('torrent-get-file-path', async (e, { infoHash, fileIndex }) => {
  return wanManager.getFilePath(infoHash, fileIndex);
});
ipcMain.handle('torrent-get-stream-url', async (e, { infoHash, fileIndex }) => {
  return wanManager.getStreamUrl(infoHash, fileIndex);
});
ipcMain.handle('torrent-pause', async (e, { infoHash }) => { wanManager.pauseTorrent(infoHash); return { success: true }; });
ipcMain.handle('torrent-resume', async (e, { infoHash }) => { wanManager.resumeTorrent(infoHash); return { success: true }; });
ipcMain.handle('torrent-remove', async (e, { infoHash, deleteFiles }) => { wanManager.removeTorrent(infoHash, deleteFiles); return { success: true }; });
