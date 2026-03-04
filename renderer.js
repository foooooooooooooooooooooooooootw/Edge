// State
let peers = [];
let selectedPeer = null;
let incomingFiles = new Map(); // transferId -> file data  
let sendingFiles = new Map(); // filename -> progress data
let chatHistory = [];
let isRendering = false; // Prevent render loops
let incomingSectionVisible = false; // Track if section is shown
let currentMode = 'lan'; // 'lan', 'wan', 'torrents'
let renderedMessageCount = 0;
const sentThumbnailCache = new Map(); // filename -> dataURL
const sentPathCache = new Map();      // filename -> local file path, for video lightbox

// Edge Streak — counts consecutive files sent
let edgeStreakCount = 0;
let edgeStreakTimer = null;
const STREAK_TIMEOUT_MS = 30000; // streak resets after 30s of inactivity

// DOM Elements
const peerList = document.getElementById('peer-list');
const peerCount = document.getElementById('peer-count');
const fileInput = document.getElementById('file-input');
const usernameInput = document.getElementById('username-input');
const usernameDisplay = document.getElementById('username-display');
const avatarContainer = document.getElementById('avatar-container');
const avatarInput = document.getElementById('avatar-input');
const avatarPreview = document.getElementById('avatar-preview');
const avatarPlaceholder = document.getElementById('avatar-placeholder');
const incomingList = document.getElementById('incoming-list');
const chatMessages = document.getElementById('chat-messages');
const messageInput = document.getElementById('message-input');
const chatHeader = document.getElementById('chat-header');
const messagesContainer = document.getElementById('messages-container');
const attachBtn = document.getElementById('attach-btn');
const incomingSection = document.getElementById('incoming-section');
const sendingSection = document.getElementById('sending-section');
const sendingList = document.getElementById('sending-list');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettings = document.getElementById('close-settings');

// Initialize
function init() {
  setupEventListeners();
  setupElectronListeners();
  loadPeers();
  loadUserInfo();
  loadSettings();
  initWAN();
  initTorrents();
}

function setupEventListeners() {
  // Custom title bar
  document.getElementById('tb-min')?.addEventListener('click', () => window.electronAPI.windowMinimize());
  document.getElementById('tb-max')?.addEventListener('click', async () => {
    await window.electronAPI.windowMaximize();
    // Update maximise icon
    const isMax = await window.electronAPI.windowIsMaximized();
    const btn = document.getElementById('tb-max');
    if (btn) btn.title = isMax ? 'Restore' : 'Maximise';
  });
  document.getElementById('tb-close')?.addEventListener('click', () => window.electronAPI.windowClose());

  // Username — click display to edit, Enter/blur to confirm
  function commitUsername() {
    const username = usernameInput.value.trim();
    usernameInput.style.display = 'none';
    if (username) {
      window.electronAPI.setUsername(username);
      usernameDisplay.textContent = username;
      showNotification(`Name set to: ${username}`, 'success');
    }
    usernameDisplay.style.display = '';
  }
  usernameDisplay.addEventListener('click', () => {
    usernameDisplay.style.display = 'none';
    usernameInput.value = usernameDisplay.textContent === 'User' ? '' : usernameDisplay.textContent;
    usernameInput.style.display = '';
    usernameInput.focus();
    usernameInput.select();
  });
  usernameInput.addEventListener('blur', commitUsername);
  usernameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { usernameInput.blur(); }
    if (e.key === 'Escape') { usernameInput.value = ''; usernameInput.blur(); }
  });

  // Avatar upload
  avatarContainer.addEventListener('click', () => {
    avatarInput.click();
  });

  avatarInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
      if (file.size > 500000) {
        showNotification('Image too large. Please use an image under 500KB.', 'error');
        return;
      }

      const reader = new FileReader();
      reader.onload = async (event) => {
        const base64 = event.target.result;
        const result = await window.electronAPI.setAvatar(base64);
        
        if (result.success) {
          avatarPreview.src = base64;
          avatarPreview.style.display = 'block';
          avatarPlaceholder.style.display = 'none';
          showNotification('Avatar updated!', 'success');
        } else {
          showNotification(result.error || 'Failed to set avatar', 'error');
        }
      };
      reader.readAsDataURL(file);
    }
  });

  // File attachment
  attachBtn.addEventListener('click', () => {
    if (!selectedPeer) {
      showNotification('Please select a peer first', 'error');
      return;
    }
    fileInput.click();
  });

  fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
    fileInput.value = ''; // Reset input
  });

  // Message input - send on Enter
  messageInput.addEventListener('keypress', async (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const msg = messageInput.value.trim();
      if (msg && selectedPeer) {
        messageInput.value = '';
        try {
          await window.electronAPI.sendMessage(selectedPeer.id, msg);
          const userInfo = await window.electronAPI.getUserInfo();
          appendMessage({ type: 'message', subtype: 'sent', message: msg, sender: userInfo.username, senderAvatar: userInfo.avatar, timestamp: new Date() });
        } catch (err) { showNotification('Failed to send message', 'error'); }
      }
    }
  });

  // Settings modal
  settingsBtn.addEventListener('click', () => {
    settingsModal.style.display = 'flex';
  });

  closeSettings.addEventListener('click', () => {
    settingsModal.style.display = 'none';
  });

  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
      settingsModal.style.display = 'none';
    }
  });

  // Mode tabs
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.mode;
      switchMode(mode);
    });
  });

  // Save receive mode when radio changes
  document.querySelectorAll('input[name="receive-mode"]').forEach(radio => {
    radio.addEventListener('change', async () => {
      if (radio.checked) {
        await window.electronAPI.setReceiveMode(radio.value);
        showNotification('Settings saved', 'success');
      }
    });
  });

  // Drag and drop on messages container
  messagesContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (selectedPeer) {
      messagesContainer.style.background = '#252525';
    }
  });

  messagesContainer.addEventListener('dragleave', () => {
    messagesContainer.style.background = '#1a1a1a';
  });

  messagesContainer.addEventListener('drop', (e) => {
    e.preventDefault();
    messagesContainer.style.background = '#1a1a1a';
    
    if (!selectedPeer) {
      showNotification('Please select a peer first', 'error');
      return;
    }

    handleFiles(e.dataTransfer.files);
  });
}

function setupElectronListeners() {
  // Incoming text messages
  window.electronAPI.onMessageReceived((data) => {
    appendMessage({ type: 'message', subtype: 'received', message: data.message, sender: data.sender || 'Unknown', senderAvatar: data.senderAvatar || null, timestamp: new Date() });
    showNotification(`Message from ${data.sender}`, 'success');
  });

  // Peer discovered
  window.electronAPI.onPeerDiscovered((peer) => {
    const existingIndex = peers.findIndex(p => p.id === peer.id);
    if (existingIndex === -1) {
      peers.push(peer);
      renderPeers();
      showNotification(`${peer.username} joined`, 'success');
    }
  });

  // Peer left
  window.electronAPI.onPeerLeft((peerId) => {
    const peerIndex = peers.findIndex(p => p.id === peerId);
    if (peerIndex !== -1) {
      const peer = peers[peerIndex];
      showNotification(`${peer.username} left`, 'error');
      peers.splice(peerIndex, 1);
      
      if (selectedPeer && selectedPeer.id === peerId) {
        selectedPeer = null;
        updateChatHeader();
      }
      
      renderPeers();
    }
  });

  // Transfer progress
  window.electronAPI.onTransferProgress((data) => {
    // Check if it's an incoming transfer
    if (data.transferId && incomingFiles.has(data.transferId)) {
      const incoming = incomingFiles.get(data.transferId);
      incoming.progress = data.progress;
      incoming.speed = data.speed;
      incoming.receivedBytes = data.receivedBytes;
      
      // Only update the progress bar DOM element, don't re-render everything
      const progressFill = document.querySelector(`[data-transfer-id="${data.transferId}"] .progress-fill`);
      const progressText = document.querySelector(`[data-transfer-id="${data.transferId}"] .progress-text`);
      const speedValue = document.querySelector(`[data-transfer-id="${data.transferId}"] .speed-value`);
      
      if (progressFill) {
        progressFill.style.width = `${Math.round(data.progress)}%`;
      }
      if (progressText) {
        progressText.textContent = `${Math.round(data.progress)}%`;
      }
      if (speedValue) {
        speedValue.textContent = formatSpeed(data.speed);
      }
    } else if (data.filename) {
      // Outgoing transfer
      const existing = sendingFiles.get(data.filename);
      if (!existing) {
        // First time seeing this file - add it
        sendingFiles.set(data.filename, {
          filename: data.filename,
          progress: data.progress,
          sentBytes: data.sentBytes,
          totalBytes: data.totalBytes
        });
        renderSendingProgress();
      } else {
        // Update existing - just update the progress bar
        existing.progress = data.progress;
        existing.sentBytes = data.sentBytes;
        
        const progressFill = document.querySelector(`[data-sending-file="${escapeAttr(data.filename)}"] .progress-fill`);
        const progressText = document.querySelector(`[data-sending-file="${escapeAttr(data.filename)}"] .progress-text`);
        
        if (progressFill) {
          progressFill.style.width = `${Math.round(data.progress)}%`;
        }
        if (progressText) {
          progressText.textContent = `${Math.round(data.progress)}%`;
        }
      }
    }
  });

  // Transfer complete
  window.electronAPI.onTransferComplete(async (data) => {
    // Update sending item to show "waiting for receiver"
    const sendingItem = document.querySelector(`[data-sending-file="${escapeAttr(data.filename)}"]`);
    if (sendingItem) {
      const progressText = sendingItem.querySelector('.progress-text');
      if (progressText) {
        progressText.textContent = 'Delivered ✓';
        progressText.style.color = '#4ade80';
      }
    }
    
    // Remove from sending after a short delay
    setTimeout(() => {
      sendingFiles.delete(data.filename);
      renderSendingProgress();
    }, 1000);
    
    showNotification(`Sent ${data.filename}`, 'success');
    const userInfo = await window.electronAPI.getUserInfo();
    const cachedThumb = sentThumbnailCache.get(data.filename);
    sentThumbnailCache.delete(data.filename);
    const cachedPath = sentPathCache.get(data.filename);
    sentPathCache.delete(data.filename);
    appendMessage({ type: 'sent', filename: data.filename, size: data.size, message: data.message, thumbnail: cachedThumb || data.thumbnail, path: cachedPath || null, sender: userInfo.username, senderAvatar: userInfo.avatar, timestamp: new Date() });
  });

  // File received
  window.electronAPI.onFileReceived((data) => {
    showNotification(`Saved ${data.filename}`, 'success');
    
    // Find and remove from incoming files
    let incoming = null;
    for (const [transferId, file] of incomingFiles.entries()) {
      if (file.filename === data.filename) {
        incoming = file;
        incomingFiles.delete(transferId);
        break;
      }
    }
    
    renderIncomingFiles();
    
    appendMessage({ type: 'received', filename: data.filename, size: data.size, message: incoming?.message || '', thumbnail: incoming?.thumbnail || null, sender: incoming?.sender || 'Unknown', senderAvatar: incoming?.senderAvatar || null, timestamp: new Date(), path: data.path });
  });

  // File incoming
  window.electronAPI.onFileIncoming((data) => {
    // File is starting to arrive - dialog is being shown by main process
    console.log('File incoming:', data.filename);
  });

  // File accepted (user clicked Accept in dialog)
  window.electronAPI.onFileIncomingAccepted((data) => {
    // Find peer by IP
    const peer = peers.find(p => p.ip === data.peerIp.replace('::ffff:', ''));
    const peerName = peer ? (peer.nickname || peer.username) : data.sender;
    
    incomingFiles.set(data.transferId, {
      ...data,
      from: peerName,
      progress: 0,
      speed: 0,
      completed: false
    });
    
    // Show incoming section only if not already visible
    if (!incomingSectionVisible) {
      incomingSection.style.display = 'block';
      incomingSectionVisible = true;
    }
    
    renderIncomingFiles();
  });

  // Transfer complete (incoming) - no longer needed, file is already saved
  window.electronAPI.onTransferCompleteIncoming((data) => {
    const incoming = incomingFiles.get(data.transferId);
    if (incoming) {
      incoming.completed = true;
      incoming.hash = data.hash;
      incoming.progress = 100;
    }
  });
}

async function loadPeers() {
  peers = await window.electronAPI.getPeers();
  renderPeers();
}

async function loadUserInfo() {
  const userInfo = await window.electronAPI.getUserInfo();
  if (userInfo.username) usernameDisplay.textContent = userInfo.username;
  if (userInfo.avatar) {
    avatarPreview.src = userInfo.avatar;
    avatarPreview.style.display = 'block';
    avatarPlaceholder.style.display = 'none';
  }
}

async function loadSettings() {
  const receiveMode = await window.electronAPI.getReceiveMode();
  const radio = document.querySelector(`input[name="receive-mode"][value="${receiveMode}"]`);
  if (radio) radio.checked = true;
  initTheme();
  initThemeUI();
  initTrackerSettings();
}

function switchMode(mode) {
  currentMode = mode;
  
  // Update active tab
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.mode === mode);
  });
  
  // Hide all mode containers
  document.querySelectorAll('.mode-container').forEach(container => {
    container.style.display = 'none';
  });
  
  // Show selected mode
  const selectedContainer = document.getElementById(`${mode}-container`);
  if (selectedContainer) {
    selectedContainer.style.display = 'flex';
  }
  
}

function renderPeers() {
  peerCount.textContent = `${peers.length} online`;
  
  if (peers.length === 0) {
    peerList.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
          <circle cx="9" cy="7" r="4"></circle>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
        </svg>
        <p>No peers found</p>
        <small>Waiting for others on your network...</small>
      </div>
    `;
    return;
  }

  peerList.innerHTML = peers.map(peer => {
    const displayName = peer.nickname || peer.username;
    const avatarHtml = peer.avatar 
      ? `<img src="${peer.avatar}" class="peer-avatar" alt="${escapeHtml(peer.username)}">`
      : `<div class="peer-avatar-placeholder">
           <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
             <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
             <circle cx="12" cy="7" r="4"></circle>
           </svg>
         </div>`;
    
    return `
      <div class="peer-item ${selectedPeer && selectedPeer.id === peer.id ? 'selected' : ''}" 
           data-peer-id="${peer.id}">
        ${avatarHtml}
        <div class="peer-info">
          <div class="peer-name">
            ${escapeHtml(displayName)}
            ${peer.nickname ? `<span class="peer-nickname">(${escapeHtml(peer.username)})</span>` : ''}
          </div>
          <div class="peer-ip">${peer.ip}</div>
        </div>
        <div class="peer-actions">
          <button class="nickname-btn" data-peer-id="${peer.id}" title="Set nickname">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
          </button>
        </div>
      </div>
    `;
  }).join('');

  // Add click handlers
  document.querySelectorAll('.peer-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.nickname-btn')) {
        return;
      }
      const peerId = item.dataset.peerId;
      selectedPeer = peers.find(p => p.id === peerId);
      chatHistory = [];
      renderedMessageCount = 0;
      chatMessages.innerHTML = '<p id="chat-empty-msg" style="color:#666;text-align:center;padding:2rem;">No messages yet. Say hello!</p>';
      renderPeers();
      updateChatHeader();
    });
  });

  // Nickname buttons
  document.querySelectorAll('.nickname-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const peerId = btn.dataset.peerId;
      const peer = peers.find(p => p.id === peerId);
      
      const nickname = prompt(
        `Set nickname for ${peer.username}:`,
        peer.nickname || ''
      );
      
      if (nickname !== null) {
        await window.electronAPI.setFavoriteNickname(peerId, nickname.trim());
        peer.nickname = nickname.trim() || null;
        renderPeers();
        showNotification(
          nickname.trim() 
            ? `Nickname set to "${nickname.trim()}"` 
            : 'Nickname removed',
          'success'
        );
      }
    });
  });
}

function updateChatHeader() {
  if (!selectedPeer) {
    chatHeader.innerHTML = '';
    // Show centered empty state in the messages area
    if (!document.getElementById('chat-empty-state')) {
      chatMessages.innerHTML = `
        <div id="chat-empty-state" class="chat-empty-state">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
          </svg>
          <h2>Select a peer to start chatting</h2>
          <p>People on your local network will appear in the sidebar</p>
        </div>
      `;
    }
    return;
  }
  // Clear empty state when a peer is selected
  const emptyState = document.getElementById('chat-empty-state');
  if (emptyState) emptyState.remove();

  const avatarHtml = selectedPeer.avatar
    ? `<img src="${selectedPeer.avatar}" class="chat-peer-avatar" alt="${escapeHtml(selectedPeer.username)}">`
    : `<div class="chat-peer-avatar-placeholder">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
           <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
           <circle cx="12" cy="7" r="4"></circle>
         </svg>
       </div>`;

  const displayName = selectedPeer.nickname || selectedPeer.username;

  chatHeader.innerHTML = `
    <div class="chat-header-active">
      ${avatarHtml}
      <div class="chat-peer-info">
        <h3>${escapeHtml(displayName)}</h3>
        <p>${selectedPeer.ip}</p>
      </div>
    </div>
  `;
}

async function handleFiles(files) {
  if (!selectedPeer) {
    showNotification('Please select a peer first', 'error');
    return;
  }

  const message = messageInput.value.trim();

  for (const file of files) {
    try {
      // Pre-extract thumbnail so it's ready when transfer-complete fires
      const ext = file.name.split('.').pop().toLowerCase();
      const imageExts = ['jpg','jpeg','png','gif','bmp','webp'];
      const videoExts = ['mp4','webm','mov','avi','mkv','m4v','wmv','flv'];
      // Thumbnail extraction — wrapped so any failure never blocks the send
      try {
        if (imageExts.includes(ext)) {
          const thumb = await readImageThumbnail(file);
          if (thumb) sentThumbnailCache.set(file.name, thumb);
        } else if (videoExts.includes(ext)) {
          const thumb = await extractFrameFromFile(file);
          if (thumb) sentThumbnailCache.set(file.name, thumb);
        }
      } catch { /* thumbnail failed — send anyway */ }

      sentPathCache.set(file.name, file.path);
      const cachedThumbnail = sentThumbnailCache.get(file.name) || null;
      if (!file.path) throw new Error(`file.path is undefined for "${file.name}" — try re-selecting the file`);
      await window.electronAPI.sendFile(selectedPeer.id, file.path, message, cachedThumbnail);
      bumpEdgeStreak();
    } catch (err) {
      console.error('Error sending file:', err);
      showNotification(`Failed to send ${file.name}: ${err.message}`, 'error');
    }
  }

  messageInput.value = '';
}

function readImageThumbnail(file) {
  return new Promise((resolve) => {
    // Safety timeout — never hang handleFiles
    const timeout = setTimeout(() => resolve(null), 5000);
    try {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const img = new Image();
          img.onload = () => {
            try {
              const scale = Math.min(1, 320 / (img.width || 1));
              const canvas = document.createElement('canvas');
              canvas.width  = Math.max(1, Math.round(img.width  * scale));
              canvas.height = Math.max(1, Math.round(img.height * scale));
              const ctx = canvas.getContext('2d');
              if (!ctx) { clearTimeout(timeout); resolve(null); return; }
              ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
              clearTimeout(timeout);
              resolve(canvas.toDataURL('image/jpeg', 0.8));
            } catch { clearTimeout(timeout); resolve(null); }
          };
          img.onerror = () => { clearTimeout(timeout); resolve(null); };
          img.src = e.target.result;
        } catch { clearTimeout(timeout); resolve(null); }
      };
      reader.onerror = () => { clearTimeout(timeout); resolve(null); };
      reader.readAsDataURL(file);
    } catch { clearTimeout(timeout); resolve(null); }
  });
}

function extractFrameFromFile(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    video.muted = true;
    video.preload = 'metadata';
    video.src = url;
    const cleanup = () => { URL.revokeObjectURL(url); video.src = ''; };
    video.addEventListener('loadedmetadata', () => { video.currentTime = Math.min(video.duration * 0.1, 2); }, { once: true });
    video.addEventListener('seeked', () => {
      try {
        const scale = Math.min(1, 320 / video.videoWidth);
        canvas.width  = Math.round(video.videoWidth  * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        cleanup();
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      } catch { cleanup(); resolve(null); }
    }, { once: true });
    video.addEventListener('error', () => { cleanup(); resolve(null); }, { once: true });
    setTimeout(() => { cleanup(); resolve(null); }, 8000);
  });
}

function renderSendingProgress() {
  if (sendingFiles.size === 0) {
    sendingSection.style.display = 'none';
    return;
  }

  sendingSection.style.display = 'block';

  sendingList.innerHTML = Array.from(sendingFiles.values()).map(file => {
    const fileIcon = getFileIcon(file.filename);
    const ext = file.filename.split('.').pop().toUpperCase();
    
    return `
      <div class="incoming-item" data-sending-file="${escapeAttr(file.filename)}">
        <div class="incoming-icon">
          ${fileIcon.icon}
          <div class="file-extension">${ext}</div>
        </div>
        <div class="incoming-details">
          <div class="incoming-filename">${escapeHtml(file.filename)}</div>
          <div class="incoming-info">
            <div class="info-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 16V8a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z"></path>
                <polyline points="7 10 12 14 17 10"></polyline>
              </svg>
              ${formatBytes(file.totalBytes)}
            </div>
            <div class="info-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="23 7 16 12 23 17 23 7"></polyline>
                <rect x="2" y="5" width="14" height="14" rx="2" ry="2"></rect>
              </svg>
              <span class="progress-text">${Math.round(file.progress)}%</span>
            </div>
          </div>
          <div class="incoming-progress">
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${file.progress}%"></div>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function getFileIcon(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'].includes(ext)) {
    return { type: 'image', icon: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
        <circle cx="8.5" cy="8.5" r="1.5"></circle>
        <polyline points="21 15 16 10 5 21"></polyline>
      </svg>
    `};
  }
  
  if (['mp4', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'webm'].includes(ext)) {
    return { type: 'video', icon: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="23 7 16 12 23 17 23 7"></polygon>
        <rect x="2" y="5" width="14" height="14" rx="2" ry="2"></rect>
      </svg>
    `};
  }
  
  if (['pdf', 'doc', 'docx', 'txt', 'rtf'].includes(ext)) {
    return { type: 'document', icon: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
        <line x1="16" y1="13" x2="8" y2="13"></line>
        <line x1="16" y1="17" x2="8" y2="17"></line>
        <polyline points="10 9 9 9 8 9"></polyline>
      </svg>
    `};
  }
  
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
    return { type: 'archive', icon: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="21 8 21 21 3 21 3 8"></polyline>
        <rect x="1" y="3" width="22" height="5"></rect>
        <line x1="10" y1="12" x2="14" y2="12"></line>
      </svg>
    `};
  }
  
  return { type: 'file', icon: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
      <polyline points="13 2 13 9 20 9"></polyline>
    </svg>
  `};
}

function formatSpeed(bytesPerSecond) {
  if (bytesPerSecond === 0) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
  return Math.round(bytesPerSecond / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function renderIncomingFiles() {
  if (incomingFiles.size === 0) {
    if (incomingSectionVisible) {
      incomingSection.style.display = 'none';
      incomingSectionVisible = false;
    }
    return;
  }

  // Don't set display here - it's already set when first file arrives
  incomingList.innerHTML = Array.from(incomingFiles.values()).map(file => {
    const fileIcon = getFileIcon(file.filename);
    const ext = file.filename.split('.').pop().toUpperCase();
    
    const thumbnailHtml = file.thumbnail 
      ? `<img src="${file.thumbnail}" class="incoming-thumbnail" alt="${escapeHtml(file.filename)}">`
      : `<div class="incoming-icon">${fileIcon.icon}<div class="file-extension">${ext}</div></div>`;
    
    return `
      <div class="incoming-item" data-transfer-id="${file.transferId}">
        ${thumbnailHtml}
        <div class="incoming-details">
          <div class="incoming-filename">${escapeHtml(file.filename)}</div>
          <div class="incoming-from">From: ${escapeHtml(file.from || file.sender)}</div>
          ${file.message ? `<div class="incoming-from" style="font-style: italic; color: #aaa;">"${escapeHtml(file.message)}"</div>` : ''}
          <div class="incoming-info">
            <div class="info-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 16V8a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z"></path>
                <polyline points="7 10 12 14 17 10"></polyline>
              </svg>
              ${formatBytes(file.size)}
            </div>
            <div class="info-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
              </svg>
              <span class="speed-value">${formatSpeed(file.speed || 0)}</span>
            </div>
            <div class="info-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              <span class="progress-text">${Math.round(file.progress)}%</span>
            </div>
          </div>
          <div class="incoming-progress">
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${file.progress}%"></div>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function formatTime(date) {
  const now = new Date();
  const diff = now - date;
  
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) {
    const mins = Math.floor(diff / 60000);
    return `${mins} min${mins > 1 ? 's' : ''} ago`;
  }
  if (now.toDateString() === date.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Append-only chat — never rebuilds the whole list
function appendMessage(item) {
  chatHistory.push(item);
  const emptyMsg = document.getElementById('chat-empty-msg');
  if (emptyMsg) emptyMsg.remove();
  const el = buildMessageElement(item);
  chatMessages.appendChild(el);
  renderedMessageCount = chatHistory.length;
  requestAnimationFrame(() => { chatMessages.scrollTop = chatMessages.scrollHeight; });
}

function renderChatHistory() {
  // Only append new items since last render
  const newItems = chatHistory.slice(renderedMessageCount);
  if (newItems.length === 0) return;
  const emptyMsg = document.getElementById('chat-empty-msg');
  if (emptyMsg && chatHistory.length > 0) emptyMsg.remove();
  newItems.forEach(item => chatMessages.appendChild(buildMessageElement(item)));
  renderedMessageCount = chatHistory.length;
  requestAnimationFrame(() => { chatMessages.scrollTop = chatMessages.scrollHeight; });
}

function buildMessageElement(item) {
  const div = document.createElement('div');
  div.innerHTML = buildMessageHTML(item).trim();
  return div.firstElementChild;
}

function buildMessageHTML(item) {
  const isSent = item.type === 'sent' || item.subtype === 'sent';
  const avatarHtml = item.senderAvatar
    ? `<img src="${item.senderAvatar}" class="message-avatar" alt="${escapeHtml(item.sender || '')}">`
    : `<div class="message-avatar-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg></div>`;

  if (item.type === 'message') {
    return `<div class="chat-message ${isSent ? 'sent' : 'received'}">
      ${avatarHtml}
      <div class="message-content">
        <div class="message-header"><span class="message-sender">${escapeHtml(item.sender || '')}</span><span class="message-time">${formatTime(item.timestamp)}</span></div>
        <div class="message-text message-text-only" data-text="${escapeAttr(item.message || '')}">${escapeHtml(item.message || '')}</div>
      </div></div>`;
  }

  // File message
  const fileIcon = getFileIcon(item.filename || '');
  let thumbHtml;
  if (item.thumbnail && item.thumbnail.startsWith('data:image')) {
    // Real thumbnail (image or extracted video frame)
    const isVideo = ['mp4','webm','mov','avi','mkv','m4v','wmv','flv'].includes((item.filename||'').split('.').pop().toLowerCase());
    if (isVideo) {
      thumbHtml = `<div class="video-thumb-wrapper" style="cursor:pointer" title="Click to play"${item.path ? ` data-filepath="${escapeAttr(item.path)}"` : ''}>
        <img src="${item.thumbnail}" alt="">
        <div class="play-overlay"><svg width="20" height="20" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>
      </div>`;
    } else {
      thumbHtml = `<img src="${item.thumbnail}" class="file-thumbnail" style="cursor:zoom-in" title="Click to expand" alt="">`;
    }
  } else if (item.thumbnail && item.thumbnail.startsWith('__video__:')) {
    // Fallback: no frame extracted, show generic video icon
    thumbHtml = `<div class="file-thumbnail-video"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="28" height="28"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="2" y="5" width="14" height="14" rx="2"></rect></svg><span>Video</span></div>`;
  } else {
    thumbHtml = `<div class="file-icon-small">${fileIcon.icon}</div>`;
  }

  const fileAttrs = item.path
    ? `class="message-file message-file-clickable" data-filepath="${escapeAttr(item.path)}" title="Click to open • Right-click for options"`
    : `class="message-file"`;

  return `<div class="chat-message ${isSent ? 'sent' : 'received'}">
    ${avatarHtml}
    <div class="message-content">
      <div class="message-header"><span class="message-sender">${escapeHtml(item.sender || '')}</span><span class="message-time">${formatTime(item.timestamp)}</span></div>
      ${item.message ? `<div class="message-text">${escapeHtml(item.message)}</div>` : ''}
      <div ${fileAttrs}>
        ${thumbHtml}
        <div class="file-details">
          <div class="file-name">${escapeHtml(item.filename || '')}</div>
          <div class="file-size">${formatBytes(item.size || 0)}</div>
          <div class="file-status">${isSent ? '✓ Sent' : '✓ Received' + (item.path ? ' — click to open' : '')}</div>
        </div>
      </div>
    </div></div>`;
}

// ============================================================
// CONTEXT MENU
// ============================================================
const ctxMenu = (() => {
  const el = document.createElement('div');
  el.id = 'ctx-menu';
  Object.assign(el.style, { position:'fixed', display:'none', zIndex:'9999', background:'#2a2a2a', border:'1px solid #444', borderRadius:'8px', padding:'0.35rem 0', minWidth:'160px', boxShadow:'0 4px 20px rgba(0,0,0,0.5)', fontSize:'0.88rem' });
  document.body.appendChild(el);
  return el;
})();

function showCtxMenu(x, y, items) {
  ctxMenu.innerHTML = items.map(it => it === '---'
    ? '<div style="height:1px;background:#444;margin:0.25rem 0;"></div>'
    : `<div class="ctx-item" data-action="${it.action}" ${it.data ? `data-payload='${JSON.stringify(it.data)}'` : ''} style="padding:0.45rem 1rem;cursor:pointer;color:#e0e0e0;display:flex;align-items:center;gap:0.6rem;white-space:nowrap;" onmouseenter="this.style.background='#383838'" onmouseleave="this.style.background=''">
        ${it.icon ? `<span style="width:1.2rem;text-align:center">${it.icon}</span>` : ''} ${it.label}
      </div>`
  ).join('');
  ctxMenu.style.display = 'block';
  const mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
  ctxMenu.style.left = (x + mw > window.innerWidth ? x - mw : x) + 'px';
  ctxMenu.style.top  = (y + mh > window.innerHeight ? y - mh : y) + 'px';
}
function hideCtxMenu() { ctxMenu.style.display = 'none'; }

ctxMenu.addEventListener('click', e => {
  const item = e.target.closest('.ctx-item');
  if (!item) return;
  const action = item.dataset.action;
  const payload = item.dataset.payload ? JSON.parse(item.dataset.payload) : {};
  hideCtxMenu();
  if (action === 'open-file')      window.electronAPI.openFile(payload.path);
  if (action === 'show-in-folder') window.electronAPI.showInFolder(payload.path);
  if (action === 'copy-text')      { navigator.clipboard.writeText(payload.text); showNotification('Copied!', 'success'); }
  if (action === 'copy-filename')  { navigator.clipboard.writeText(payload.text); showNotification('Copied!', 'success'); }
});

document.addEventListener('click', e => {
  if (!ctxMenu.contains(e.target)) hideCtxMenu();
  const fileEl = e.target.closest('.message-file-clickable');
  // Don't open file if user clicked a thumbnail (lightbox handles that)
  if (fileEl && !ctxMenu.contains(e.target) && !e.target.closest('.file-thumbnail') && !e.target.closest('.video-thumb-wrapper')) {
    window.electronAPI.openFile(fileEl.dataset.filepath);
  }
});

document.addEventListener('contextmenu', e => {
  const fileEl = e.target.closest('.message-file-clickable');
  if (fileEl) {
    e.preventDefault();
    const fp = fileEl.dataset.filepath;
    const fn = fileEl.querySelector('.file-name')?.textContent || '';
    showCtxMenu(e.clientX, e.clientY, [
      { icon:'📂', label:'Open file',      action:'open-file',      data:{ path: fp } },
      { icon:'🗂',  label:'Show in folder', action:'show-in-folder', data:{ path: fp } },
      '---',
      { icon:'📋', label:'Copy filename',  action:'copy-filename',  data:{ text: fn } },
    ]);
    return;
  }
  const msgEl = e.target.closest('.message-text-only');
  if (msgEl) {
    e.preventDefault();
    const sel = window.getSelection()?.toString() || msgEl.dataset.text || msgEl.textContent || '';
    showCtxMenu(e.clientX, e.clientY, [{ icon:'📋', label:'Copy text', action:'copy-text', data:{ text: sel } }]);
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideCtxMenu(); });
document.addEventListener('scroll', hideCtxMenu, true);

// ============================================================
// WAN UI
// ============================================================
let wanCurrentSendHash = null;
let wanCurrentReceiveHash = null;
let wanSelectedFile = null;

function initWAN() {
  const dropZone = document.getElementById('wan-drop-zone');
  const fileInput = document.getElementById('wan-file-input');

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('drag-over'); const f = e.dataTransfer.files[0]; if (f) setWanFile(f); });
  fileInput.addEventListener('change', e => { if (e.target.files[0]) setWanFile(e.target.files[0]); fileInput.value=''; });

  document.getElementById('btn-send-private').addEventListener('click', () => wanSend('private'));
  document.getElementById('btn-send-semi').addEventListener('click', () => wanSend('semi'));
  document.getElementById('btn-send-direct').addEventListener('click', wanShowDirect);
  document.getElementById('wan-cancel-send-btn').addEventListener('click', cancelWANSend);
  document.getElementById('wan-export-torrent-btn').addEventListener('click', async () => {
    if (!wanCurrentSendHash) return;
    const r = await window.electronAPI.wanExportTorrent(wanCurrentSendHash);
    if (r.success) showNotification('Torrent file saved!', 'success');
    else if (!r.canceled) showNotification('Failed: ' + r.error, 'error');
  });

  document.getElementById('wan-receive-btn').addEventListener('click', wanReceive);
  document.getElementById('wan-receive-input').addEventListener('keypress', e => { if (e.key === 'Enter') wanReceive(); });
  document.getElementById('wan-cancel-receive-btn').addEventListener('click', cancelWANReceive);

  document.getElementById('wan-open-torrent-btn').addEventListener('click', async () => {
    const r = await window.electronAPI.wanOpenTorrentFile();
    if (!r || r.canceled) return;
    if (!r.success) { showNotification('Failed: ' + r.error, 'error'); return; }
    document.getElementById('wan-receive-status').style.display = 'block';
    document.getElementById('wan-receive-filename').textContent = 'Opening torrent...';
    showNotification('Download started!', 'success');
  });

  // Drag .torrent file onto receive input
  const receiveInput = document.getElementById('wan-receive-input');
  receiveInput.addEventListener('dragover', e => e.preventDefault());
  receiveInput.addEventListener('drop', async e => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file || !file.name.endsWith('.torrent')) return;
    const r = await window.electronAPI.wanOpenTorrentFile(file.path);
    if (r.success) { document.getElementById('wan-receive-status').style.display = 'block'; document.getElementById('wan-receive-filename').textContent = 'Opening torrent...'; showNotification('Download started!', 'success'); }
  });

  // Copy buttons
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      if (target && target.value) { navigator.clipboard.writeText(target.value); showNotification('Copied!', 'success'); }
    });
  });

  // WAN Events
  window.electronAPI.onWanProgress(data => {
    if (data.type === 'upload') {
      document.getElementById('wan-send-progress-wrap').style.display = 'flex';
      document.getElementById('wan-send-progress-fill').style.width = Math.round(data.progress) + '%';
      document.getElementById('wan-send-progress-text').textContent = Math.round(data.progress) + '%';
      document.getElementById('wan-send-peers').textContent = data.peers + ' peer' + (data.peers !== 1 ? 's' : '');
      if (data.peers > 0) { document.getElementById('wan-send-status-text').textContent = 'Uploading...'; document.getElementById('wan-send-status').querySelector('.status-dot').style.background = '#4ade80'; }
    } else if (data.type === 'download') {
      document.getElementById('wan-receive-progress-fill').style.width = Math.round(data.progress) + '%';
      document.getElementById('wan-receive-progress-text').textContent = Math.round(data.progress) + '%';
      document.getElementById('wan-receive-peers').textContent = data.peers + ' peer' + (data.peers !== 1 ? 's' : '');
      if (data.peers > 0) document.getElementById('wan-receive-status-text').textContent = 'Downloading...';
    }
  });
  window.electronAPI.onWanMetadata(data => { document.getElementById('wan-receive-filename').textContent = data.filename + ' (' + formatBytes(data.size) + ')'; });
  window.electronAPI.onWanComplete(data => {
    showNotification('Transfer complete: ' + data.filename, 'success');
    document.getElementById('wan-receive-status').style.display = 'none';
    document.getElementById('wan-receive-input').value = '';
  });
  window.electronAPI.onWanError(data => { showNotification('WAN error: ' + data.error, 'error'); });
  window.electronAPI.onWanReceiveStarted(data => {
    document.getElementById('wan-receive-status').style.display = 'block';
    document.getElementById('wan-receive-filename').textContent = data.filename;
    wanCurrentReceiveHash = data.infoHash;
  });
}

function setWanFile(file) {
  wanSelectedFile = file;
  document.getElementById('wan-selected-file').style.display = 'block';
  document.getElementById('wan-selected-filename').textContent = file.name;
  document.getElementById('wan-selected-size').textContent = formatBytes(file.size);
  document.getElementById('wan-drop-zone').style.display = 'none';
}

async function wanSend(tier) {
  if (!wanSelectedFile) return;
  const btn = document.getElementById(tier === 'private' ? 'btn-send-private' : 'btn-send-semi');
  btn.textContent = 'Generating...';
  btn.disabled = true;
  try {
    const result = tier === 'private'
      ? await window.electronAPI.wanSendPrivate(wanSelectedFile.path)
      : await window.electronAPI.wanSendSemiPrivate(wanSelectedFile.path);
    if (!result.success) throw new Error(result.error);
    wanCurrentSendHash = result.infoHash;
    document.getElementById('wan-magnet-output').value = result.magnetURI;
    document.getElementById('wan-link-result').style.display = 'block';
    document.getElementById('wan-selected-file').style.display = 'none';
    if (tier === 'private') {
      const port = result.torrentPort;
      const peers = result.peers || [];
      document.getElementById('wan-link-mode-label').textContent = '🔒 Private Direct — your IP is embedded in the link';
      document.getElementById('wan-link-privacy-note').textContent = `✓ Zero third-party · Port ${port} · Peers: ${peers.join(', ')} · Same-network peers will use local IP automatically`;
    } else {
      document.getElementById('wan-link-mode-label').textContent = '🛡 DHT Fallback — no trackers, unguessable infohash';
      document.getElementById('wan-link-privacy-note').textContent = '✓ Works through NAT · No port forwarding needed · DHT only';
    }
  } catch (err) { showNotification('Failed: ' + err.message, 'error'); }
  finally { btn.textContent = tier === 'private' ? 'Generate Private Link' : 'Generate DHT Link'; btn.disabled = false; }
}

async function wanShowDirect() {
  const addresses = await window.electronAPI.wanGetAddresses();
  document.getElementById('wan-direct-result').style.display = 'block';
  document.getElementById('wan-public-ip-display').value = (addresses.publicIp || 'Unknown') + ':' + addresses.directPort;
  document.getElementById('wan-local-ip-display').value = (addresses.localIp || 'Unknown') + ':' + addresses.directPort;
}

async function wanReceive() {
  const input = document.getElementById('wan-receive-input').value.trim();
  if (!input) return;
  const result = await window.electronAPI.wanReceiveMagnet(input);
  if (!result.success && !result.canceled) showNotification('Failed: ' + result.error, 'error');
}

function cancelWANSend() {
  if (wanCurrentSendHash) { window.electronAPI.wanCancelSend(wanCurrentSendHash); wanCurrentSendHash = null; }
  document.getElementById('wan-link-result').style.display = 'none';
  document.getElementById('wan-direct-result').style.display = 'none';
  document.getElementById('wan-drop-zone').style.display = 'flex';
  document.getElementById('wan-selected-file').style.display = 'none';
  wanSelectedFile = null;
}

function cancelWANReceive() {
  if (wanCurrentReceiveHash) { window.electronAPI.wanCancelReceive(wanCurrentReceiveHash); wanCurrentReceiveHash = null; }
  document.getElementById('wan-receive-status').style.display = 'none';
  document.getElementById('wan-receive-input').value = '';
}

// ============================================================
// THEME SYSTEM
// ============================================================
const THEMES = {
  default:  { accent: '#4a9eff', bg: '#1e1e1e', surface: '#252525', text: '#e0e0e0' },
  forest:   { accent: '#4ade80', bg: '#1a2318', surface: '#1f2c1d', text: '#e0ede0' },
  seafoam:  { accent: '#2dd4bf', bg: '#0d1f1e', surface: '#122625', text: '#d0ecea' },
  sunset:   { accent: '#fb923c', bg: '#1f1510', surface: '#281a12', text: '#ede0d0' },
  lavender: { accent: '#a78bfa', bg: '#1a1525', surface: '#211a2e', text: '#e0d8f0' },
  rose:     { accent: '#f472b6', bg: '#1f1318', surface: '#271520', text: '#f0d0e0' },
};

function applyTheme(vars) {
  const root = document.documentElement;
  root.style.setProperty('--accent', vars.accent);
  root.style.setProperty('--bg', vars.bg);
  root.style.setProperty('--surface', vars.surface);
  root.style.setProperty('--text', vars.text);
  // Derive secondary colours from accent
  root.style.setProperty('--accent-dim', vars.accent + '22');
  root.style.setProperty('--accent-border', vars.accent + '55');
}

function initTheme() {
  try {
    const saved = localStorage.getItem('theme');
    const savedCustom = localStorage.getItem('theme-custom');
    if (saved === 'custom' && savedCustom) {
      applyTheme(JSON.parse(savedCustom));
    } else if (saved && THEMES[saved]) {
      applyTheme(THEMES[saved]);
    } else {
      applyTheme(THEMES.default);
    }
  } catch { applyTheme(THEMES.default); }
}

function initThemeUI() {
  // Preset buttons
  document.querySelectorAll('.theme-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme;
      document.querySelectorAll('.theme-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (theme === 'custom') {
        document.getElementById('custom-color-panel').style.display = 'block';
        return;
      }
      document.getElementById('custom-color-panel').style.display = 'none';
      if (THEMES[theme]) { applyTheme(THEMES[theme]); try { localStorage.setItem('theme', theme); } catch {} }
    });
  });

  // Highlight saved theme
  try {
    const saved = localStorage.getItem('theme') || 'default';
    const activeBtn = document.querySelector(`.theme-preset[data-theme="${saved}"]`);
    if (activeBtn) { document.querySelectorAll('.theme-preset').forEach(b => b.classList.remove('active')); activeBtn.classList.add('active'); }
    if (saved === 'custom') document.getElementById('custom-color-panel').style.display = 'block';
  } catch {}

  // Color pickers
  ['accent','bg','surface','text'].forEach(key => {
    const input = document.getElementById('color-' + key);
    const hex = document.getElementById('color-' + key + '-hex');
    if (!input) return;
    // Restore saved custom values
    try { const custom = JSON.parse(localStorage.getItem('theme-custom') || '{}'); if (custom[key]) { input.value = custom[key]; if (hex) hex.textContent = custom[key]; } } catch {}
    input.addEventListener('input', () => { if (hex) hex.textContent = input.value; });
  });

  document.getElementById('apply-custom-theme').addEventListener('click', () => {
    const vars = { accent: document.getElementById('color-accent').value, bg: document.getElementById('color-bg').value, surface: document.getElementById('color-surface').value, text: document.getElementById('color-text').value };
    applyTheme(vars);
    try { localStorage.setItem('theme', 'custom'); localStorage.setItem('theme-custom', JSON.stringify(vars)); } catch {}
    document.querySelectorAll('.theme-preset').forEach(b => b.classList.remove('active'));
    document.querySelector('.theme-preset[data-theme="custom"]').classList.add('active');
    // Update custom swatch
    document.getElementById('custom-swatch').style.background = `linear-gradient(135deg, ${vars.bg}, ${vars.accent})`;
    showNotification('Theme applied!', 'success');
  });
}

// Notification container — single fixed container, toasts stack inside it
let _notifContainer = null;
function getNotifContainer() {
  if (!_notifContainer) {
    _notifContainer = document.createElement('div');
    _notifContainer.id = 'notif-container';
    _notifContainer.style.cssText = 'position:fixed;bottom:1.5rem;right:1.5rem;z-index:9999;display:flex;flex-direction:column;gap:0.5rem;align-items:flex-end;pointer-events:none;';
    document.body.appendChild(_notifContainer);
  }
  return _notifContainer;
}

function showNotification(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `notification notification-${type}`;
  el.textContent = message;
  el.style.position = 'relative'; // override fixed — container handles position
  el.style.bottom = '';
  el.style.right  = '';
  getNotifContainer().appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
  }, 2700);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text) {
  return text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============================================================
// EDGE STREAK
// ============================================================
function bumpEdgeStreak() {
  edgeStreakCount++;
  if (edgeStreakTimer) clearTimeout(edgeStreakTimer);
  // Only show streak badge at 2+
  if (edgeStreakCount >= 2) renderEdgeStreak();
  // Reset after inactivity
  edgeStreakTimer = setTimeout(() => {
    edgeStreakCount = 0;
    renderEdgeStreak();
  }, STREAK_TIMEOUT_MS);
}

function renderEdgeStreak() {
  let badge = document.getElementById('edge-streak-badge');
  if (edgeStreakCount < 2) {
    if (badge) badge.style.opacity = '0';
    setTimeout(() => { const b = document.getElementById('edge-streak-badge'); if (b && edgeStreakCount < 2) b.remove(); }, 300);
    return;
  }
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'edge-streak-badge';
    // Attach to body so it survives tab switches — positioned above the input bar
    document.body.appendChild(badge);
  }

  let label, color;
  if (edgeStreakCount >= 20)      { label = 'INFERNO';  color = '#ff2200'; }
  else if (edgeStreakCount >= 10) { label = 'BLAZING';  color = '#ff6600'; }
  else if (edgeStreakCount >= 5)  { label = 'HOT';      color = '#fb923c'; }
  else                            { label = 'STREAK';   color = '#fbbf24'; }

  badge.className = 'edge-streak-badge';
  badge.style.opacity = '1';
  badge.innerHTML = `🔥 <span class="streak-count">${edgeStreakCount}</span> <span class="streak-label">${label} EDGE STREAK</span>`;
  badge.style.setProperty('--streak-color', color);
  badge.classList.remove('streak-pulse');
  void badge.offsetWidth;
  badge.classList.add('streak-pulse');
}

// ============================================================
// TRACKER SETTINGS
// ============================================================
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:80/announce',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.webtorrent.dev',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
].join('\n');

function getSavedTrackers() {
  try {
    const saved = localStorage.getItem('custom-trackers');
    return saved ? saved.split('\n').map(s => s.trim()).filter(Boolean) : DEFAULT_TRACKERS.split('\n').map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

function initTrackerSettings() {
  const input = document.getElementById('tracker-list-input');
  const btn   = document.getElementById('save-trackers-btn');
  if (!input || !btn) return;
  // Load saved trackers
  input.value = localStorage.getItem('custom-trackers') || DEFAULT_TRACKERS;
  btn.addEventListener('click', () => {
    const val = input.value.trim();
    localStorage.setItem('custom-trackers', val);
    window.electronAPI.setTorrentTrackers(val.split('\n').map(s => s.trim()).filter(Boolean));
    showNotification('Trackers saved!', 'success');
  });
}

// ============================================================
// TORRENT CLIENT UI
// ============================================================
let torrentRefreshInterval = null;
let torrentList = [];
// Smoothing: keep rolling window of speed samples per torrent
const torrentSpeedHistory = new Map(); // infoHash -> { dl: [], ul: [], eta: [] }
const SPEED_WINDOW = 5; // average over last 5 samples

function initTorrents() {
  // Torrent add modal
  const torrentModal = document.getElementById('torrent-add-modal');
  document.getElementById('add-torrent-btn').addEventListener('click', () => {
    document.getElementById('torrent-magnet-input').value = '';
    torrentModal.style.display = 'flex';
    setTimeout(() => document.getElementById('torrent-magnet-input').focus(), 50);
  });
  document.getElementById('torrent-modal-close').addEventListener('click', () => torrentModal.style.display = 'none');
  document.getElementById('torrent-modal-cancel').addEventListener('click', () => torrentModal.style.display = 'none');
  torrentModal.addEventListener('click', e => { if (e.target === torrentModal) torrentModal.style.display = 'none'; });

  document.getElementById('torrent-pick-file-btn').addEventListener('click', async () => {
    torrentModal.style.display = 'none';
    const picked = await window.electronAPI.torrentPickFile();
    if (!picked.success || picked.canceled) return;
    const result = await window.electronAPI.torrentAdd(null, picked.filePath);
    if (!result.success && !result.canceled) showNotification('Failed: ' + result.error, 'error');
    else if (result.success) showNotification('Torrent added!', 'success');
  });

  document.getElementById('torrent-modal-add').addEventListener('click', async () => {
    const magnet = document.getElementById('torrent-magnet-input').value.trim();
    if (!magnet) { showNotification('Enter a magnet link first', 'error'); return; }
    torrentModal.style.display = 'none';
    const result = await window.electronAPI.torrentAdd(magnet);
    if (!result.success && !result.canceled) showNotification('Failed: ' + result.error, 'error');
    else if (result.success) showNotification('Torrent added!', 'success');
  });

  document.getElementById('torrent-magnet-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) document.getElementById('torrent-modal-add').click();
  });

  // Listen for torrent events
  window.electronAPI.onTorrentAdded(data => {
    updateTorrentInList(data);
    renderTorrentList();
  });
  window.electronAPI.onTorrentMetadata(data => {
    updateTorrentInList(data);
    renderTorrentList();
  });
  let torrentRenderPending = false;
  window.electronAPI.onTorrentProgress(data => {
    updateTorrentInList(data);
    // Debounce renders — at most once per 750ms from IPC events
    if (!torrentRenderPending) {
      torrentRenderPending = true;
      setTimeout(() => { torrentRenderPending = false; renderTorrentList(); }, 750);
    }
  });
  window.electronAPI.onTorrentComplete(data => {
    const t = torrentList.find(t => t.infoHash === data.infoHash);
    if (t) t.status = 'seeding';
    showNotification('Download complete: ' + data.name, 'success');
    renderTorrentList();
  });
  window.electronAPI.onTorrentError(data => {
    showNotification('Torrent error: ' + data.error, 'error');
  });

  // Refresh when switching to torrents tab
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.dataset.mode === 'torrents') {
        refreshTorrentList();
        if (!torrentRefreshInterval) torrentRefreshInterval = setInterval(refreshTorrentList, 750);
      } else {
        if (torrentRefreshInterval) { clearInterval(torrentRefreshInterval); torrentRefreshInterval = null; }
      }
    });
  });
}

function updateTorrentInList(data) {
  const existing = torrentList.find(t => t.infoHash === data.infoHash);
  if (existing) {
    // Smooth speed & ETA with rolling average
    if (data.downloadSpeed !== undefined || data.uploadSpeed !== undefined) {
      if (!torrentSpeedHistory.has(data.infoHash)) {
        torrentSpeedHistory.set(data.infoHash, { dl: [], ul: [], eta: [] });
      }
      const hist = torrentSpeedHistory.get(data.infoHash);
      if (data.downloadSpeed !== undefined) { hist.dl.push(data.downloadSpeed); if (hist.dl.length > SPEED_WINDOW) hist.dl.shift(); }
      if (data.uploadSpeed   !== undefined) { hist.ul.push(data.uploadSpeed);   if (hist.ul.length > SPEED_WINDOW) hist.ul.shift(); }
      if (data.timeRemaining !== undefined && data.timeRemaining < Infinity) { hist.eta.push(data.timeRemaining); if (hist.eta.length > SPEED_WINDOW) hist.eta.shift(); }
      data = { ...data };
      if (hist.dl.length)  data.downloadSpeed  = hist.dl.reduce((a,b) => a+b, 0) / hist.dl.length;
      if (hist.ul.length)  data.uploadSpeed    = hist.ul.reduce((a,b) => a+b, 0) / hist.ul.length;
      if (hist.eta.length) data.timeRemaining  = hist.eta.reduce((a,b) => a+b, 0) / hist.eta.length;
    }
    Object.assign(existing, data);
  } else {
    torrentList.push(data);
  }
}

async function refreshTorrentList() {
  try {
    const fresh = await window.electronAPI.torrentGetAll();
    fresh.forEach(t => updateTorrentInList(t));
    // Remove stale entries
    torrentList = torrentList.filter(t => fresh.some(f => f.infoHash === t.infoHash));
    renderTorrentList();
  } catch {}
}

function renderTorrentList() {
  const listEl = document.getElementById('torrents-list');
  if (torrentList.length === 0) {
    listEl.innerHTML = `<div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="12" r="10"></circle><polygon points="10 8 16 12 10 16 10 8"></polygon>
      </svg>
      <p>No active torrents</p>
      <small>Click "Add Torrent" and paste a magnet link or open a .torrent file</small>
    </div>`;
    return;
  }

  listEl.innerHTML = torrentList.map(t => {
    const progress = Math.min(100, Math.round(t.progress || 0));
    const isSeeding = t.status === 'seeding';
    const isPaused  = t.status === 'paused';
    const statusColor = isSeeding ? '#4ade80' : isPaused ? '#888' : 'var(--accent)';
    const statusIcon  = isSeeding ? '⬆' : isPaused ? '⏸' : '⬇';

    const dlSpeed = t.downloadSpeed > 0 ? `↓ ${formatSpeed(t.downloadSpeed)}` : '';
    const ulSpeed = t.uploadSpeed  > 0 ? `↑ ${formatSpeed(t.uploadSpeed)}`  : '';
    const eta = (!isSeeding && t.timeRemaining && t.timeRemaining < Infinity)
      ? `ETA ${formatETA(t.timeRemaining)}` : '';

    const size       = t.size > 0 ? formatBytes(t.size) : '—';
    const downloaded = t.downloaded > 0 ? formatBytes(t.downloaded) : '0 B';
    const ratio      = t.ratio > 0 ? t.ratio.toFixed(2) : '—';

    // Blocks / pieces
    const pieces = t.pieces > 0
      ? `${t.piecesComplete || 0} / ${t.pieces}`
      : '—';

    // Seeders / leechers from trackers
    const seeders  = t.seeders  > 0 ? t.seeders  : (isSeeding ? '—' : '0');
    const leechers = t.leechers > 0 ? t.leechers : '0';

    // Files section with selective download + media preview
    const filesHtml = (t.files && t.files.length > 0) ? `
      <div class="torrent-section">
        <div class="torrent-section-title" style="display:flex;justify-content:space-between;align-items:center;">
          <span>📄 Files (${t.files.length})</span>
          ${t.files.length > 1 ? `<button class="torrent-select-all-btn" data-hash="${t.infoHash}" style="font-size:0.7rem;padding:0.15rem 0.5rem;background:#2a2a2a;border:1px solid #444;color:#888;border-radius:4px;cursor:pointer;">Select all</button>` : ''}
        </div>
        <div class="torrent-files">
          ${t.files.map((f, fi) => {
            const ext = f.name.split('.').pop().toLowerCase();
            const isImage = ['jpg','jpeg','png','gif','webp','bmp'].includes(ext);
            const isVideo = ['mp4','webm','mov','mkv','avi','m4v'].includes(ext);
            const isAudio = ['mp3','flac','ogg','wav','m4a','aac'].includes(ext);
            const canPreview = isImage || isVideo || isAudio;
            const isSelected = !(window._torrentDeselected?.get(t.infoHash)?.has(fi));
            return `
            <div class="torrent-file-row">
              <input type="checkbox" class="torrent-file-check" data-hash="${t.infoHash}" data-fi="${fi}" ${isSelected ? 'checked' : ''} title="${isSelected ? 'Click to skip this file' : 'Click to download this file'}">
              <span class="torrent-file-name" title="${escapeHtml(f.path || f.name)}">${escapeHtml(f.name)}</span>
              <span class="torrent-file-size">${formatBytes(f.size)}</span>
              ${canPreview ? `<button class="torrent-preview-btn" data-hash="${t.infoHash}" data-fi="${fi}" data-type="${isVideo?'video':isAudio?'audio':'image'}" data-name="${escapeAttr(f.name)}" title="${isVideo||isAudio?'Watch / Download':'View / Download'}">${isVideo||isAudio?'▶':'👁'}</button>` : ''}
              <div class="torrent-file-bar"><div style="width:${Math.round(f.progress)}%;background:${isSelected ? statusColor : '#444'};height:100%;border-radius:2px;transition:width 0.4s;"></div></div>
              <span class="torrent-file-pct" style="color:${isSelected?'#888':'#555'}">${Math.round(f.progress)}%</span>
            </div>`
          }).join('')}
        </div>
      </div>` : '';

    // Trackers section
    const trackersHtml = (t.trackers && t.trackers.length > 0) ? `
      <div class="torrent-section">
        <div class="torrent-section-title">📡 Trackers (${t.trackers.length})</div>
        <div class="torrent-trackers">
          ${t.trackers.map(tr => `
            <div class="torrent-tracker-row">
              <span class="torrent-tracker-url" title="${escapeHtml(tr.url)}">${escapeHtml(tr.url.replace(/^wss?:\/\/|^udp:\/\//, '').split('/')[0])}</span>
              <span class="torrent-tracker-stat">🌱 ${tr.seeders}</span>
              <span class="torrent-tracker-stat">📥 ${tr.leechers}</span>
            </div>
          `).join('')}
        </div>
      </div>` : '';

    // Expanded state
    const isExpanded = (window._torrentExpanded || new Set()).has(t.infoHash);

    return `<div class="torrent-item" data-hash="${t.infoHash}">
      <div class="torrent-top">
        <div class="torrent-name" title="${escapeHtml(t.name || 'Loading...')}">${escapeHtml(t.name || 'Loading...')}</div>
        <div class="torrent-actions">
          <button class="torrent-btn expand-toggle" data-hash="${t.infoHash}" title="${isExpanded ? 'Collapse' : 'Details'}" style="font-size:0.65rem;">${isExpanded ? '▲' : '▼'}</button>
          ${isPaused
            ? `<button class="torrent-btn resume" data-hash="${t.infoHash}" title="Resume">▶</button>`
            : `<button class="torrent-btn pause"  data-hash="${t.infoHash}" title="Pause">⏸</button>`}
          <button class="torrent-btn remove" data-hash="${t.infoHash}" title="Remove">✕</button>
        </div>
      </div>

      <div class="torrent-progress-bar">
        <div class="torrent-progress-fill" style="width:${progress}%;background:${statusColor}"></div>
      </div>

      <div class="torrent-stats">
        <span class="torrent-status-badge" style="color:${statusColor}">${statusIcon} ${t.status || 'connecting'}</span>
        <span class="torrent-stat-pill">${progress}%</span>
        <span class="torrent-stat-pill">${downloaded} / ${size}</span>
        ${dlSpeed ? `<span class="torrent-stat-pill speed-dl">${dlSpeed}</span>` : ''}
        ${ulSpeed ? `<span class="torrent-stat-pill speed-ul">${ulSpeed}</span>` : ''}
        ${eta    ? `<span class="torrent-stat-pill">${eta}</span>` : ''}
      </div>

      <div class="torrent-meta-row">
        <span title="Connected peers">👥 ${t.peers || 0} connected</span>
        <span title="Seeders from trackers">🌱 ${seeders} seeders</span>
        <span title="Leechers from trackers">📥 ${leechers} leechers</span>
        <span title="Share ratio">⚖ ratio ${ratio}</span>
        <span title="Pieces downloaded">🧩 ${pieces} blocks</span>
      </div>

      ${isExpanded ? `<div class="torrent-expanded">${filesHtml}${trackersHtml}</div>` : ''}
    </div>`;
  }).join('');

  // Wire buttons
  if (!window._torrentExpanded) window._torrentExpanded = new Set();

  listEl.querySelectorAll('.expand-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const h = btn.dataset.hash;
      if (window._torrentExpanded.has(h)) window._torrentExpanded.delete(h);
      else window._torrentExpanded.add(h);
      renderTorrentList(); // immediate — not debounced
    });
  });
  listEl.querySelectorAll('.torrent-btn.pause').forEach(btn => {
    btn.addEventListener('click', async () => {
      await window.electronAPI.torrentPause(btn.dataset.hash);
      const t = torrentList.find(t => t.infoHash === btn.dataset.hash);
      if (t) t.status = 'paused';
      renderTorrentList();
    });
  });
  listEl.querySelectorAll('.torrent-btn.resume').forEach(btn => {
    btn.addEventListener('click', async () => {
      await window.electronAPI.torrentResume(btn.dataset.hash);
      const t = torrentList.find(t => t.infoHash === btn.dataset.hash);
      if (t) t.status = 'downloading';
      renderTorrentList();
    });
  });
  listEl.querySelectorAll('.torrent-btn.remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const deleteFiles = confirm('Delete downloaded files too?');
      await window.electronAPI.torrentRemove(btn.dataset.hash, deleteFiles);
      torrentList = torrentList.filter(t => t.infoHash !== btn.dataset.hash);
      window._torrentExpanded?.delete(btn.dataset.hash);
      window._torrentDeselected?.delete(btn.dataset.hash);
      renderTorrentList();
    });
  });

  // Selective download checkboxes
  if (!window._torrentDeselected) window._torrentDeselected = new Map();
  listEl.querySelectorAll('.torrent-file-check').forEach(cb => {
    cb.addEventListener('change', async () => {
      const hash = cb.dataset.hash; const fi = parseInt(cb.dataset.fi);
      if (!window._torrentDeselected.has(hash)) window._torrentDeselected.set(hash, new Set());
      const desel = window._torrentDeselected.get(hash);
      if (cb.checked) desel.delete(fi); else desel.add(fi);
      // 0 = normal priority, -1 = skip
      await window.electronAPI.torrentSetFilePriority(hash, fi, cb.checked ? 0 : -1);
      renderTorrentList();
    });
  });

  listEl.querySelectorAll('.torrent-select-all-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const hash = btn.dataset.hash;
      const t = torrentList.find(t => t.infoHash === hash);
      if (!t) return;
      const desel = window._torrentDeselected.get(hash) || new Set();
      const allSelected = desel.size === 0;
      if (allSelected) {
        // deselect all
        t.files.forEach((_, fi) => { desel.add(fi); window.electronAPI.torrentSetFilePriority(hash, fi, -1); });
        window._torrentDeselected.set(hash, desel);
        btn.textContent = 'Select all';
      } else {
        // select all
        window._torrentDeselected.delete(hash);
        t.files.forEach((_, fi) => window.electronAPI.torrentSetFilePriority(hash, fi, 0));
        btn.textContent = 'Deselect all';
      }
      renderTorrentList();
    });
  });

  // Preview buttons — stream directly into lightbox
  listEl.querySelectorAll('.torrent-preview-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const hash = btn.dataset.hash;
      const fi   = parseInt(btn.dataset.fi);
      const type = btn.dataset.type;
      const name = btn.dataset.name || '';
      openTorrentPreview(hash, fi, type, name);
    });
  });
}

// ── Torrent preview: stream directly into lightbox ──────────
async function openTorrentPreview(infoHash, fileIndex, type, filename) {
  try {
    const url = await window.electronAPI.torrentGetStreamUrl(infoHash, fileIndex);
    openLightbox(type, url, filename);
  } catch(err) {
    showNotification('Could not open preview: ' + err.message, 'error');
  }
}

function formatETA(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}

// ============================================================
// MEDIA LIGHTBOX — click image/video thumbnail to expand
// ============================================================
const lightbox = (() => {
  const el = document.createElement('div');
  el.id = 'media-lightbox';
  el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:10000;display:none;align-items:center;justify-content:center;flex-direction:column;gap:0.75rem;';
  el.innerHTML = `
    <div id="lightbox-inner" style="position:relative;max-width:92vw;max-height:88vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:0;">
      <img id="lightbox-img" style="display:none;max-width:100%;max-height:88vh;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.7);" />
      <video id="lightbox-video" controls style="display:none;max-width:100%;max-height:84vh;border-radius:8px 8px 0 0;box-shadow:0 8px 40px rgba(0,0,0,0.7);"></video>
      <canvas id="lightbox-bufbar" width="800" height="4" style="display:none;width:100%;height:4px;border-radius:0 0 8px 8px;background:#222;"></canvas>
    </div>
    <div id="lightbox-caption" style="color:#ccc;font-size:0.82rem;max-width:80vw;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></div>
    <button id="lightbox-close" style="position:fixed;top:1.25rem;right:1.5rem;background:rgba(255,255,255,0.12);border:none;color:#fff;font-size:1.4rem;width:38px;height:38px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;" title="Close (Esc)">✕</button>
  `;
  document.body.appendChild(el);
  return el;
})();

const lightboxImg     = document.getElementById('lightbox-img');
const lightboxVideo   = document.getElementById('lightbox-video');
const lightboxCaption = document.getElementById('lightbox-caption');
const lightboxBufBar  = document.getElementById('lightbox-bufbar');

// Draw YouTube-style buffered ranges on the canvas bar
function drawBufferBar() {
  if (!lightboxBufBar || lightboxBufBar.style.display === 'none') return;
  const ctx = lightboxBufBar.getContext('2d');
  const W = lightboxBufBar.width, H = lightboxBufBar.height;
  const dur = lightboxVideo.duration;
  ctx.clearRect(0, 0, W, H);
  // Track background
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(0, 0, W, H);
  // Buffered ranges — grey
  if (dur && dur > 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    const buf = lightboxVideo.buffered;
    for (let i = 0; i < buf.length; i++) {
      const x1 = (buf.start(i) / dur) * W;
      const x2 = (buf.end(i)   / dur) * W;
      ctx.fillRect(x1, 0, x2 - x1, H);
    }
    // Playback position — accent colour
    ctx.fillStyle = 'var(--accent, #4a9eff)';
    ctx.fillRect(0, 0, (lightboxVideo.currentTime / dur) * W, H);
  }
}

let _bufBarTimer = null;
lightboxVideo.addEventListener('progress',     drawBufferBar);
lightboxVideo.addEventListener('timeupdate',   drawBufferBar);
lightboxVideo.addEventListener('play', () => {
  clearInterval(_bufBarTimer);
  _bufBarTimer = setInterval(drawBufferBar, 500);
});
lightboxVideo.addEventListener('pause',  () => clearInterval(_bufBarTimer));
lightboxVideo.addEventListener('ended',  () => clearInterval(_bufBarTimer));

function openLightbox(type, src, caption) {
  lightbox.style.display = 'flex';
  if (type === 'image') {
    lightboxImg.src = src;
    lightboxImg.style.display = 'block';
    lightboxVideo.style.display = 'none';
    lightboxVideo.pause?.();
    lightboxVideo.src = '';
  } else {
    // video or audio — <video> element handles audio too
    lightboxVideo.src = src;
    lightboxVideo.style.display = 'block';
    lightboxImg.style.display = 'none';
    lightboxImg.src = '';
    if (type !== 'audio' && lightboxBufBar) {
      lightboxBufBar.style.display = 'block';
      lightboxBufBar.width = lightboxVideo.offsetWidth || 800;
    }
    if (type === 'audio') {
      lightboxVideo.style.height = '60px';
      lightboxVideo.style.width = '420px';
    } else {
      lightboxVideo.style.height = '';
      lightboxVideo.style.width = '';
    }
  }
  lightboxCaption.textContent = caption || '';
}

function closeLightbox() {
  lightbox.style.display = 'none';
  lightboxVideo.pause?.();
  lightboxVideo.src = '';
  if (lightboxBufBar) lightboxBufBar.style.display = 'none';
  lightboxImg.src = '';
}

document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
lightbox.addEventListener('click', e => { if (e.target === lightbox) closeLightbox(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && lightbox.style.display !== 'none') closeLightbox(); });

// Delegate click on thumbnails in chat
// IMPORTANT: check video-thumb-wrapper FIRST — it contains an <img> which would
// otherwise match .file-thumbnail and open the image lightbox instead of video player.
document.addEventListener('click', e => {
  // Video thumbnail — must check before image thumbnail
  const videoThumb = e.target.closest('.video-thumb-wrapper');
  if (videoThumb) {
    e.stopPropagation();
    // Look for filepath: first on the wrapper itself, then on the parent message-file div
    const filepath = videoThumb.dataset.filepath
      || videoThumb.closest('[data-filepath]')?.dataset.filepath;
    const filename = videoThumb.closest('.message-file, .message-file-clickable')
      ?.querySelector('.file-name')?.textContent || 'Video';
    if (filepath) {
      // Normalise Windows backslashes
      const src = 'file:///' + filepath.replace(/\\/g, '/').replace(/^\//, '');
      openLightbox('video', src, filename);
    } else {
      // No saved path yet — show the frame thumbnail as a still image with a note
      const img = videoThumb.querySelector('img');
      if (img) openLightbox('image', img.src, filename + ' · full video available after transfer');
    }
    return;
  }

  // Image thumbnail
  const imgThumb = e.target.closest('.file-thumbnail');
  if (imgThumb) {
    e.stopPropagation();
    const filename = imgThumb.closest('.message-file, .message-file-clickable')?.querySelector('.file-name')?.textContent || '';
    openLightbox('image', imgThumb.src, filename);
    return;
  }
});

// Start the app
init();

// Refresh peers periodically
setInterval(loadPeers, 5000);
