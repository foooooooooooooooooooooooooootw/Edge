'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');

const { NetworkManager }  = require('./src/network');
const { SettingsManager } = require('./src/settings');

let win;
let net;
let settings;

// Safe send — guards against destroyed webContents (e.g. window closed mid-transfer)
function safeSend(channel, data) {
  try { win?.webContents.send(channel, data); } catch (_) {}
}
// Fires IPC at most 10/sec. Speed = true 1.5s rolling window average.
const progressState = new Map(); // fileId → { lastSent, samples[] }

function sendProgress(d) {
  const now  = Date.now();
  let   prev = progressState.get(d.fileId);
  if (!prev) {
    prev = { lastSent: 0, samples: [] };
    progressState.set(d.fileId, prev);
  }

  // Always add sample — regardless of whether we'll send this tick
  prev.samples.push([now, d.received]);

  // Trim samples older than 1.5 seconds, but keep at least one anchor
  const cutoff = now - 1500;
  while (prev.samples.length > 1 && prev.samples[0][0] < cutoff) prev.samples.shift();

  // Throttle IPC to ~1 update per 1.5s — matches the speed averaging window
  if (now - prev.lastSent < 1500) return;
  prev.lastSent = now;

  // Speed = delta-bytes over the full 1.5s window
  let speed = 0;
  if (prev.samples.length >= 2) {
    const [t0, b0] = prev.samples[0];
    const [t1, b1] = prev.samples[prev.samples.length - 1];
    const dt = (t1 - t0) / 1000;
    if (dt > 0) speed = Math.round((b1 - b0) / dt);
  }

  safeSend('file-progress', { ...d, speed });
}

function clearProgress(fileId) { progressState.delete(fileId); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function uniqueDest(dir, name) {
  let dest = path.join(dir, name);
  if (!fs.existsSync(dest)) return dest;
  const ext=path.extname(name), base=path.basename(name,ext);
  let n=1;
  while (fs.existsSync(dest)) dest = path.join(dir, `${base} (${n++})${ext}`);
  return dest;
}

function pubPeer(peer) {
  return { id:peer.id, name:peer.name, ip:peer.ip, port:peer.port,
           lan:peer.lan, connected:peer.connected, messages:peer.messages,
           files:(peer.files||[]).map(f=>({...f})) };
}

// Save a file: try rename first (instant, same-filesystem), fall back to async copy
async function saveFileTo(tempPath, destPath) {
  try {
    fs.renameSync(tempPath, destPath);
    return true;
  } catch (_) {
    // Cross-device or permission issue — fall back to async copy
    return new Promise(resolve => {
      const src = fs.createReadStream(tempPath);
      const dst = fs.createWriteStream(destPath);
      src.pipe(dst);
      dst.on('finish', () => resolve(true));
      dst.on('error', () => resolve(false));
      src.on('error', () => resolve(false));
    });
  }
}

// ── Incoming file handler ─────────────────────────────────────────────────────
async function handleIncomingFile({ peerId, file }) {
  const mode = (settings.get('fileMode') || 'ask').toLowerCase().trim();

  const isMedia = file.mime.startsWith('image/') || file.mime.startsWith('video/');

  if (mode === 'auto-downloads') {
    const stored = net._receivedFiles.get(file.fileId);
    const dest   = uniqueDest(app.getPath('downloads'), file.name);
    await saveFileTo(stored.tempPath, dest);
    net.cleanupFile(file.fileId);
    // Re-register dest path so get-media-preview still works after cleanup
    if (isMedia) senderFiles.set(file.fileId, { filePath: dest, mime: file.mime });
    safeSend('file-received', { peerId, file: { ...file, savedTo: dest } });
    return;
  }

  if (mode === 'auto-choose') {
    const stored = net._receivedFiles.get(file.fileId);
    const result = await dialog.showSaveDialog(win, { defaultPath: file.name });
    if (!result.canceled) {
      await saveFileTo(stored.tempPath, result.filePath);
      net.cleanupFile(file.fileId);
      if (isMedia) senderFiles.set(file.fileId, { filePath: result.filePath, mime: file.mime });
    }
    safeSend('file-received', {
      peerId, file: { ...file, savedTo: result.canceled ? null : result.filePath },
    });
    return;
  }

  // ask mode — temp file stays on disk; renderer calls get-media-preview
  safeSend('file-ready-to-save', { peerId, file });
}


// ── App lifecycle ─────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width:1100, height:720, minWidth:820, minHeight:560,
    frame:false, transparent:false, backgroundColor:'#070b16',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation:true, nodeIntegration:false, sandbox:false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode:'detach' });
}

app.whenReady().then(async () => {
  settings = new SettingsManager(app.getPath('userData'));
  createWindow();
  net = new NetworkManager(settings.get('displayName'), settings.get('nodeId'));
  net.myProfilePic = settings.get('profilePic') || null;

  net.on('peer-connected',     p  => safeSend('peer-connected',    pubPeer(p)));
  net.on('peer-reconnected',   p  => safeSend('peer-reconnected',  pubPeer(p)));
  net.on('peer-disconnected',  id => safeSend('peer-disconnected', id));
  net.on('message-received',   d  => safeSend('message-received',  d));
  net.on('upnp-status',        s  => safeSend('upnp-status',       s));

  net.on('file-progress', d => sendProgress(d));

  // File request received — ask user or auto-accept based on mode
  net.on('file-request', ({ peerId, fileId, name, size, mime }) => {
    const mode = (settings.get('fileMode') || 'ask').toLowerCase().trim();
    if (mode === 'auto-downloads' || mode === 'auto-choose') {
      // Auto-accept — bytes will flow immediately
      net.acceptFileRequest(peerId, fileId);
      safeSend('file-transfer-start', { peerId, fileId, name, size, mime });
    } else {
      // Ask mode — show UI prompt; user decides; no bytes flow yet
      safeSend('file-incoming-request', { peerId, file: { fileId, name, size, mime } });
    }
  });

  net.on('reaction-received', d => safeSend('reaction-received', d));
  net.on('peer-profile-updated', d => safeSend('peer-profile-updated', d));

  net.on('file-rejected-by-peer', ({ peerId, fileId }) => {
    clearProgress(fileId);
    safeSend('file-send-rejected', { peerId, fileId });
  });

  net.on('file-received', d => {
    // Flush a final 100% progress event
    safeSend('file-progress', {
      peerId: d.peerId, fileId: d.file.fileId,
      received: d.file.size, size: d.file.size, speed: 0,
    });
    clearProgress(d.file.fileId);
    handleIncomingFile(d);
  });

  await net.start().catch(e => console.error('[Edge] Network start error:', e));
});

app.on('window-all-closed', () => { net?.stop(); if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.handle('get-my-info', () => ({
  ...net.getMyInfo(),
  displayName: settings.get('displayName'),
  profilePic:  settings.get('profilePic'),
}));

ipcMain.handle('send-reaction', (_, { peerId, msgId, emoji }) => {
  try { net.sendReaction(peerId, msgId, emoji); return { success:true }; }
  catch (err) { return { success:false, error:err.message }; }
});

ipcMain.handle('get-peers', () => net.getPeers());

ipcMain.handle('add-peer', async (_, { ip, port }) => {
  try { return { success:true, peer:pubPeer(await net.connectToPeer(ip, port, false)) }; }
  catch (err) { return { success:false, error:err.message }; }
});

ipcMain.handle('send-message', async (_, { peerId, text, replyTo }) => {
  try { return { success:true, message:net.sendMessage(peerId, text, replyTo||null) }; }
  catch (err) { return { success:false, error:err.message }; }
});

// fileId → filePath for sender-side media preview (original file, never deleted)
const senderFiles = new Map();

ipcMain.handle('pick-and-send-file', async (_, { peerId }) => {
  const result = await dialog.showOpenDialog(win, { properties:['openFile'] });
  if (result.canceled) return { success:false, canceled:true };

  const filePath = result.filePaths[0];
  const { detectMime } = require('./src/network');
  const name   = path.basename(filePath);
  const size   = fs.statSync(filePath).size;
  const mime   = detectMime(name);
  const fileId = require('crypto').randomBytes(4).toString('hex');

  // Store path for preview — no base64 over IPC (avoids timing race + IPC bloat)
  senderFiles.set(fileId, { filePath, mime });

  // Notify renderer before bytes flow so it shows a "waiting" bubble
  safeSend('file-send-start', { peerId, fileId, name, size, mime });

  try {
    const file = await net.sendFile(peerId, filePath, fileId);
    clearProgress(fileId);
    safeSend('file-send-done', { fileId, file });
    return { success:true, file };
  } catch (err) {
    clearProgress(fileId);
    senderFiles.delete(fileId);
    safeSend('file-send-done', { fileId, error:err.message });
    return { success:false, error:err.message };
  }
});

// Receiver: respond to file request (ask mode — fires BEFORE transfer starts)
ipcMain.handle('respond-to-file', (_, { fileId, peerId, accepted }) => {
  if (accepted) {
    net.acceptFileRequest(peerId, fileId);
    // Don't fire file-transfer-start here — network.js will emit file_start when
    // bytes actually begin, which triggers file-progress events.
    // Just tell renderer to show a progress-mode bubble.
    safeSend('file-transfer-start', { peerId, fileId, name:'', size:0, mime:'' });
  } else {
    net.rejectFileRequest(peerId, fileId);
    safeSend('file-rejected', { fileId });
  }
});

// Receiver: save a completed file (ask mode)
// Drag-and-drop: send a specific file path without showing a dialog
ipcMain.handle('pick-and-send-file-path', async (_, { peerId, filePath }) => {
  if (!fs.existsSync(filePath)) return { success:false, error:'File not found' };
  const { detectMime } = require('./src/network');
  const name   = path.basename(filePath);
  const size   = fs.statSync(filePath).size;
  const mime   = detectMime(name);
  const fileId = require('crypto').randomBytes(4).toString('hex');
  senderFiles.set(fileId, { filePath, mime });
  safeSend('file-send-start', { peerId, fileId, name, size, mime });
  try {
    const file = await net.sendFile(peerId, filePath, fileId);
    clearProgress(fileId);
    safeSend('file-send-done', { fileId, file });
    return { success:true, file };
  } catch (err) {
    clearProgress(fileId);
    senderFiles.delete(fileId);
    safeSend('file-send-done', { fileId, error:err.message });
    return { success:false, error:err.message };
  }
});

ipcMain.handle('save-received-file', async (_, { fileId, name, mime }) => {
  const stored = net._receivedFiles.get(fileId);
  if (!stored?.tempPath) return { success:false, error:'File not found — may have expired' };

  const result = await dialog.showSaveDialog(win, { defaultPath: name });
  if (result.canceled) return { success:false, canceled:true };

  const ok = await saveFileTo(stored.tempPath, result.filePath);
  if (ok) {
    net.cleanupFile(fileId);
    // Register saved path so get-media-preview works after temp cleanup
    const mimeStr = mime || stored.mime || '';
    if (mimeStr.startsWith('image/') || mimeStr.startsWith('video/')) {
      senderFiles.set(fileId, { filePath: result.filePath, mime: mimeStr });
    }
  }
  return ok ? { success:true, savedTo:result.filePath } : { success:false, error:'Save failed' };
});

// Returns a file:// URL for media preview — no large data over IPC.
// Works for both sender (original file) and receiver (temp file, then saved file).
const PREVIEW_RAM_LIMIT = 300 * 1024 * 1024; // 300 MB in RAM

ipcMain.handle('get-media-preview', (_, fileId) => {
  // Sender side: original file path
  const sent = senderFiles.get(fileId);
  if (sent) {
    try {
      const size = fs.statSync(sent.filePath).size;
      if (size <= PREVIEW_RAM_LIMIT) {
        return { b64: fs.readFileSync(sent.filePath).toString('base64'), mime: sent.mime };
      }
      return { fileUrl: 'file://' + sent.filePath, mime: sent.mime };
    } catch (_) { return null; }
  }

  // Receiver side: temp file on disk
  const stored = net._receivedFiles.get(fileId);
  if (stored?.tempPath) {
    try {
      if (stored.size <= PREVIEW_RAM_LIMIT) {
        return { b64: fs.readFileSync(stored.tempPath).toString('base64'), mime: stored.mime };
      }
      return { fileUrl: 'file://' + stored.tempPath, mime: stored.mime };
    } catch (_) { return null; }
  }

  return null;
});

ipcMain.handle('get-file-data', (_, fileId) => {
  const stored = net._receivedFiles.get(fileId);
  if (!stored?.tempPath) return null;
  try {
    if (stored.size > 50 * 1024 * 1024)
      return { fileUrl:'file://' + stored.tempPath, mime:stored.mime };
    return { b64:fs.readFileSync(stored.tempPath).toString('base64'), mime:stored.mime };
  } catch (_) { return null; }
});

ipcMain.handle('get-settings',  ()     => settings.getAll());
ipcMain.handle('save-settings', (_, p) => {
  settings.update(p);
  if (p.displayName) net.myName = p.displayName;
  if ('profilePic' in p) net.broadcastProfilePic(p.profilePic);
  return { success:true };
});

ipcMain.handle('pick-profile-pic', async () => {
  const r = await dialog.showOpenDialog(win, {
    title:'Choose Profile Picture', properties:['openFile'],
    filters:[{ name:'Images', extensions:['jpg','jpeg','png','gif','webp'] }],
  });
  if (r.canceled) return { success:false, canceled:true };
  const buf  = fs.readFileSync(r.filePaths[0]);
  const ext  = path.extname(r.filePaths[0]).slice(1).toLowerCase();
  const mime = { png:'image/png', gif:'image/gif', webp:'image/webp' }[ext] || 'image/jpeg';
  const b64  = `data:${mime};base64,${buf.toString('base64')}`;
  settings.set('profilePic', b64);
  net.broadcastProfilePic(b64);
  return { success:true, dataUrl:b64 };
});

ipcMain.handle('clear-profile-pic', () => { settings.set('profilePic', null); net.broadcastProfilePic(null); return { success:true }; });
ipcMain.handle('win-minimize', () => win?.minimize());
ipcMain.handle('win-maximize', () => win?.isMaximized() ? win.unmaximize() : win.maximize());
ipcMain.handle('win-close',    () => win?.close());
