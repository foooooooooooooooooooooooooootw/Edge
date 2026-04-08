'use strict';

// ═══════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════
const S = {
  myInfo:        null,
  peers:         new Map(),
  active:        null,
  upnp:          null,
  fileProgress:  new Map(),
  mediaCache:    new Map(),
  reactions:     new Map(),
  streaks:       new Map(),
  replyingTo:    null,   // { id, text, from } | null
  settings:      { displayName: '', profilePic: null, theme: 'ocean', fileMode: 'ask' },
  settingsTab:   'profile',
  settingsDraft: {},
  unread:        new Map(), // peerId → count of unread messages
  nicSpeed:      null,      // { speedMbps, iface } | null
};

// ═══════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);

function esc(s = '') {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function initials(name = '?') {
  return name.trim().split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase() || '?';
}

function peerColor(id = '') {
  const p = ['#3b82f6','#8b5cf6','#06b6d4','#10b981','#f59e0b','#ec4899','#ef4444','#6366f1'];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h) + id.charCodeAt(i) | 0;
  return p[Math.abs(h) % p.length];
}

function ftime(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

function fsize(b) {
  if (b < 1024)    return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

function avatarHtml(name, id, pic, size = 40, cls = 'peer-avatar') {
  const col = peerColor(id);
  if (pic) {
    return `<div class="${cls}" style="background:${col}">
      <img src="${esc(pic)}" alt="${esc(initials(name))}"/>
    </div>`;
  }
  return `<div class="${cls}" style="background:${col}">${esc(initials(name))}</div>`;
}

function showToast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.innerHTML = `<span class="toast-dot"></span>${esc(msg)}`;
  t.classList.add('show');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), 2500);
}

// ═══════════════════════════════════════════════════════════════════
// Markdown renderer
// ═══════════════════════════════════════════════════════════════════
function renderMarkdown(text) {
  // Escape HTML first, then apply markdown
  let s = String(text)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  // Code blocks (``` ... ```)
  s = s.replace(/```([\s\S]*?)```/g, (_, c) =>
    `<pre class="md-code-block"><code>${c.trim()}</code></pre>`);

  // Inline code
  s = s.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');

  // Blockquote (lines starting with >)
  s = s.replace(/^&gt;\s?(.+)$/gm, '<div class="md-quote">$1</div>');

  // Bold **text** or __text__
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(.+?)__/g,     '<strong>$1</strong>');

  // Italic *text* or _text_
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/_([^_]+)_/g,   '<em>$1</em>');

  // Strikethrough ~~text~~
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Newlines → <br> (but not inside pre blocks)
  s = s.replace(/\n/g, '<br>');

  return s;
}

// ═══════════════════════════════════════════════════════════════════
// Emoji picker
// ═══════════════════════════════════════════════════════════════════
// Twemoji: convert emoji char to <img> using CDN
// Strips U+FE0F variation selectors from codepoint paths (not used in filenames)
function twimg(emoji) {
  const codepoints = [...emoji]
    .map(c => c.codePointAt(0))
    .filter(cp => cp !== 0xFE0F)   // strip variation selector-16
    .map(cp => cp.toString(16).padStart(4, '0'));
  const codepoint = codepoints.join('-');
  const url = `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/${codepoint}.svg`;
  return `<img src="${url}" class="tw-emoji" alt="${emoji}" draggable="false" onerror="this.style.display='none';this.parentNode.insertBefore(document.createTextNode('${emoji.replace(/'/g, "\\'")}'),this)"/>`;
}

const EMOJI_GROUPS = [
  { label:'😀', emojis:['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','🥰','😘','🥹','😐','😑','😶','😏','😒','🙄','😬','🤐','😴','🤤','😷','🤒','🤧','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','🤫','🤭','🧐','🤓','😈','💀','👻','🤡','💩','🫠','🫡'] },
  { label:'👍', emojis:['👍','👎','👏','🙌','🤝','🫶','🤜','🤛','✊','👊','🤚','🖐','✋','🖖','🫰','🤞','✌','🤟','🤘','👌','🤌','🤏','👈','👉','👆','👇','☝','👋','🤙','💪','🦾','🫳','🫴','🙏','🫵'] },
  { label:'❤️', emojis:['❤','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','💕','💞','💓','💗','💖','💘','💝','💟','☮','✝','☯','🕊','🔥','💯','✨','⭐','🌟','💫','⚡','🌈','☀','🌙','🌺','🌸'] },
  { label:'🐶', emojis:['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐔','🐧','🐦','🐤','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🪱','🐛','🦋','🐌','🐞','🐜','🦟','🦗','🕷️','🦂','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🦍','🦧','🦣','🐘','🦛','🦏','🐪','🦒','🦘','🦬','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🦮','🐈','🐈‍⬛','🐓','🦃','🦤','🦚','🦜','🦢','🦩','🕊️','🐇','🦝','🦨','🦡','🦫','🦦','🦥','🐁','🐀','🐿️','🦔'] },
  { label:'🍕', emojis:['🍕','🍔','🌮','🌯','🥙','🧆','🥚','🍳','🧇','🥞','🧈','🥓','🥩','🍗','🍖','🌭','🍟','🧀','🥗','🥘','🫕','🥫','🍱','🍘','🍙','🍚','🍛','🍜','🍝','🍠','🍢','🍣','🍤','🍥','🥮','🍡','🥟','🥠','🥡','🦪','🍦','🍧','🍨','🍩','🍪','🎂','🍰','🧁','🥧','🍫','🍬','🍭','🍮','🍯','🍼','🥛','☕','🫖','🍵','🧃','🥤','🧋','🍶','🍺','🍻','🥂','🍷','🫗','🥃','🍸','🍹','🧉','🍾'] },
  { label:'⚽', emojis:['⚽','🏀','🏈','⚾','🥎','🎾','🏐','🏉','🥏','🎱','🏓','🏸','🏒','🥍','🏑','🏏','🪃','🥅','⛳','🏹','🎣','🤿','🥊','🥋','🎽','🛹','🛼','🛷','⛸️','🥌','🎿','⛷️','🏂','🏋️','🤼','🤸','⛹️','🤺','🏊','🚴','🏇','🧘','🏄','🚣','🧗','🤾','🏌️','🏆','🥇','🥈','🥉','🎖️','🏅','🎗️','🎫','🎟️','🎪','🎭','🎨','🎬','🎤','🎧','🎼','🎵','🎶','🎹','🥁','🪘','🎷','🎺','🎸','🪕','🎻','🎲','♟️','🎯','🎳','🎮','🕹️'] },
  { label:'🚀', emojis:['🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🏍️','🛵','🛺','🚲','🛴','🛹','🛼','🚏','🛣️','🛤️','⛽','🚧','🚦','🚥','🛞','⚓','🛟','⛵','🚤','🛥️','🛳️','⛴️','🚢','✈️','🛩️','🛫','🛬','🛳️','💺','🚁','🚟','🚠','🚡','🛰️','🚀','🛸','🪂','⛱️','🌍','🌎','🌏','🪐','🌙','⭐','☀️','🌤️','⛅','🌥️','☁️','🌦️','🌧️','⛈️','🌩️','🌨️','❄️','☃️','⛄','🌬️','💨','🌀','🌊','🌈','☔','⚡','❄️','🌵','🎄','🌲','🌳','🌴','🪵','🌿','☘️','🍀','🎍','🪴','🌾','🌺','🌻','🌹','🪷','🌷','🌸','🌼','💐'] },
  { label:'💼', emojis:['💼','📱','💻','🖥️','🖨️','⌨️','🖱️','🖲️','💽','💾','💿','📀','📷','📸','📹','🎥','📽️','🎞️','📞','☎️','📟','📠','📺','📻','🎙️','🎚️','🎛️','🧭','⏱️','⏰','⏲️','⌚','⏳','📡','🔋','🔌','💡','🔦','🕯️','💴','💵','💸','💳','🧾','🔧','🔨','⚒️','🛠️','⛏️','🔩','🪛','🔑','🗝️','🔒','🔓','🔐','🪝','🧲','⚙️','🗜️','🧪','🧫','🧬','🔬','🔭','📐','📏','🪜','📌','📍','📎','🖇️','✂️','🗃️','🗄️','🗑️','📦','📫','📬','📭','📮','🏷️','📝','📓','📔','📒','📕','📗','📘','📙','📚','📖','🔖','📜','📄','📊','📈','📉','📋','🗒️','🗓️','📅','📆','🗑️'] },
  { label:'🏠', emojis:['🏠','🏡','🏢','🏣','🏤','🏥','🏦','🏨','🏩','🏪','🏫','🏬','🏭','🏯','🏰','💒','🗼','🗽','⛪','🕌','🛕','🕍','⛩️','🕌','🗺️','🏔️','⛰️','🌋','🗻','🏕️','🏖️','🏜️','🏝️','🏞️','🏟️','🛤️','🛣️','🗾','🌁','🌃','🏙️','🌄','🌅','🌆','🌇','🌉','🌌','🌠','🎆','🎇','🎑','💮','🎃','🎄','🎋','🎍','🎎','🎏','🎐','🎑','🧧','🎀','🎁','🎊','🎉','🎈','🎟️','🎫','🎖️','🏆','🥇','🥈','🥉','🏅','🎗️','🎪'] },
  { label:'🔣', emojis:['✅','❌','❓','❗','💯','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤','🔶','🔷','🔸','🔹','🔺','🔻','💠','🔘','🔲','🔳','▶️','⏩','⏭️','⏯️','◀️','⏪','⏮️','🔼','⏫','🔽','⏬','⏸️','⏹️','⏺️','🎦','🔅','🔆','📶','📳','📴','📵','📳','🔇','🔈','🔉','🔊','📢','📣','🔔','🔕','💬','💭','🗯️','♻️','🔱','📛','🔰','⭕','✅','☑️','✔️','❎','🌐','💱','💲','➕','➖','➗','✖️','♾️','❕','‼️','⁉️','🔃','🔄','🔙','🔚','🔛','🔜','🔝'] },
];

// Render emoji as Twemoji image (fallback to char if loading fails)
function renderEmoji(emoji) {
  return twimg(emoji);
}

function renderEmojiText(text) {
  // Replace standalone emoji chars with Twemoji images in a string
  return text.replace(/(\p{Emoji_Presentation}|\p{Extended_Pictographic})/gu, m => twimg(m));
}

let emojiPickerVisible = false;

function buildEmojiPicker(onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'emoji-picker';
  wrap.innerHTML = `
    <div class="ep-tabs">${EMOJI_GROUPS.map((g,i) =>
      `<button class="ep-tab${i===0?' active':''}" data-gi="${i}" title="${g.emojis[0]}">${twimg(g.label)}</button>`
    ).join('')}</div>
    <div class="ep-grid">${EMOJI_GROUPS[0].emojis.map(e =>
      `<button class="ep-emoji" data-e="${e}" title="${e}">${twimg(e)}</button>`
    ).join('')}</div>`;

  wrap.querySelectorAll('.ep-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      wrap.querySelectorAll('.ep-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const gi = parseInt(tab.dataset.gi);
      wrap.querySelector('.ep-grid').innerHTML =
        EMOJI_GROUPS[gi].emojis.map(e => `<button class="ep-emoji" data-e="${e}" title="${e}">${twimg(e)}</button>`).join('');
      wrap.querySelectorAll('.ep-emoji').forEach(b =>
        b.addEventListener('click', () => onPick(b.dataset.e)));
    });
  });

  wrap.querySelectorAll('.ep-emoji').forEach(b =>
    b.addEventListener('click', () => onPick(b.dataset.e)));

  return wrap;
}

function toggleEmojiPicker() {
  const existing = document.querySelector('.emoji-picker:not(.inline-emoji-picker)');
  if (existing) { existing.remove(); emojiPickerVisible = false; return; }

  const input  = $('msg-input');
  const picker = buildEmojiPicker(emoji => {
    const pos = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, pos) + emoji + input.value.slice(pos);
    input.focus();
    input.selectionStart = input.selectionEnd = pos + emoji.length;
    autoGrow(input);
  });

  // Append inside #input-row so `position:absolute; bottom:100%` works
  const inputRow = $('input-row');
  inputRow.appendChild(picker);
  emojiPickerVisible = true;

  // Smart position: flip down if too close to top edge
  requestAnimationFrame(() => {
    const rect = picker.getBoundingClientRect();
    if (rect.top < 8) {
      picker.style.bottom = 'auto';
      picker.style.top    = 'calc(100% + 6px)';
    }
    // Clamp horizontal
    if (rect.right > window.innerWidth - 8) {
      picker.style.right = '0';
      picker.style.left  = 'auto';
    }
  });

  setTimeout(() => {
    document.addEventListener('click', function closeP(e) {
      if (!picker.contains(e.target) && e.target.id !== 'emoji-btn') {
        picker.remove(); emojiPickerVisible = false;
        document.removeEventListener('click', closeP);
      }
    });
  }, 0);
}

// ═══════════════════════════════════════════════════════════════════
// Reactions
// ═══════════════════════════════════════════════════════════════════
function getReactions(peerId) {
  if (!S.reactions.has(peerId)) S.reactions.set(peerId, new Map());
  return S.reactions.get(peerId);
}

function addReaction(peerId, msgId, emoji, fromMe) {
  const r = getReactions(peerId);
  if (!r.has(msgId)) r.set(msgId, new Map());
  const m = r.get(msgId);
  const key = fromMe ? `me:${emoji}` : `them:${emoji}`;
  // Toggle: if already reacted with this emoji, remove it
  if (fromMe && m.has(key)) {
    m.delete(key);
  } else {
    m.set(key, emoji);
  }
}

function reactionBarHtml(peerId, msgId) {
  const r = getReactions(peerId);
  if (!r.has(msgId)) return '';
  const m = r.get(msgId);
  if (!m.size) return '';

  // Group by emoji
  const counts = new Map();
  for (const [key, emoji] of m) {
    const fromMe = key.startsWith('me:');
    if (!counts.has(emoji)) counts.set(emoji, { count: 0, mine: false });
    counts.get(emoji).count++;
    if (fromMe) counts.get(emoji).mine = true;
  }

  const chips = [...counts.entries()].map(([emoji, { count, mine }]) =>
    `<button class="reaction-chip${mine ? ' mine' : ''}" data-mid="${esc(msgId)}" data-e="${esc(emoji)}">${emoji}${count > 1 ? ` <span>${count}</span>` : ''}</button>`
  ).join('');

  return `<div class="reaction-bar">${chips}</div>`;
}

// ═══════════════════════════════════════════════════════════════════
// Edge streak
// ═══════════════════════════════════════════════════════════════════
function streakColor(n) {
  if (n >= 20) return '#00eeff';
  if (n >= 10) return '#8d01df';
  if (n >= 5)  return '#ff2200';
  return '#ff6600';
}

function updateStreak(peerId, sender) {
  const s = S.streaks.get(peerId) || { count: 0, lastSender: null };
  if (sender === 'me') {
    // My file — extend if I was last, break if they were
    if (s.lastSender === 'them') {
      s.count = 1;
    } else {
      s.count++;
    }
    s.lastSender = 'me';
  } else {
    // Their file — always breaks my streak (theirs just started)
    s.count = 0;
    s.lastSender = 'them';
  }
  S.streaks.set(peerId, s);
}

function streakBadgeHtml(peerId) {
  const s = S.streaks.get(peerId);
  if (!s || s.count < 2) return '';
  const color = streakColor(s.count);
  return `<div class="streak-badge" style="--streak-color:${color}" title="${s.count} files in a row!">🔥 <span class="streak-count">${s.count}</span><span class="streak-label">Edge streak</span></div>`;
}

// ═══════════════════════════════════════════════════════════════════
// Media helpers
// ═══════════════════════════════════════════════════════════════════
function isImage(mime = '') { return mime.startsWith('image/'); }
function isVideo(mime = '') { return mime.startsWith('video/'); }
function isAudio(mime = '') { return mime.startsWith('audio/'); }
function isMedia(mime = '') { return isImage(mime) || isVideo(mime) || isAudio(mime); }

function fspeed(bps) {
  if (!bps || bps <= 0) return '';
  if (bps < 1024)    return bps.toFixed(0) + ' B/s';
  if (bps < 1048576) return (bps / 1024).toFixed(1) + ' KB/s';
  return (bps / 1048576).toFixed(1) + ' MB/s';
}

// Detect if a string is purely emoji characters (no text) — for big naked emoji display
const EMOJI_REGEX = /^(\p{Emoji_Presentation}|\p{Extended_Pictographic}|\uFE0F|\u200D|\s)+$/u;
function isEmojiOnly(text) {
  if (!text || text.trim().length === 0) return false;
  const t = text.trim();
  // Must be short (≤5 grapheme clusters) and match emoji pattern
  const graphemes = [...new Intl.Segmenter().segment(t)].map(s => s.segment);
  if (graphemes.length > 5) return false;
  return EMOJI_REGEX.test(t);
}

function formatNicSpeed(mbps) {
  if (!mbps || mbps <= 0) return null;
  if (mbps >= 1000) return (mbps / 1000 % 1 === 0 ? (mbps / 1000) : (mbps / 1000).toFixed(1)) + ' Gbps';
  return mbps + ' Mbps';
}

// Convert b64 → Blob URL — required for video (Electron can't play video data URLs)
function b64ToBlobUrl(b64, mime) {
  try {
    const bin   = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  } catch (_) { return null; }
}

// ── Lightbox ──────────────────────────────────────────────────────
function openLightbox(url, mime, name) {
  const content = $('lb-content');
  if (isVideo(mime)) {
    const vid    = document.createElement('video');
    vid.src      = url;
    vid.controls = true;
    vid.autoplay = true;
    vid.volume   = 0.5;
    content.innerHTML = '';
    content.appendChild(vid);
  } else {
    content.innerHTML = `<img src="${url}" alt="${esc(name)}"/>`;
  }
  $('lb-caption').textContent = name;
  $('lightbox').classList.add('open');
  document.addEventListener('keydown', lbKeyHandler);
}

function closeLightbox() {
  const lb  = $('lightbox');
  const vid = lb.querySelector('video');
  if (vid) { vid.pause(); vid.src = ''; }
  lb.classList.remove('open');
  $('lb-content').innerHTML = '';
  document.removeEventListener('keydown', lbKeyHandler);
}

function lbKeyHandler(e) { if (e.key === 'Escape') closeLightbox(); }

// ── Lazy media loader (for completed files not yet in cache) ──────────────────
async function loadPendingMedia(peer) {
  const toLoad = (peer.files || []).filter(f =>
    isMedia(f.mime) && !S.mediaCache.has(f.fileId)
  );
  if (!toLoad.length) return;

  let loaded = false;
  for (const f of toLoad) {
    if (S.mediaCache.has(f.fileId)) continue;
    const p = await window.edge.getMediaPreview(f.fileId);
    if (!p) continue;
    if (p.fileUrl) {
      S.mediaCache.set(f.fileId, p.fileUrl);
      loaded = true;
    } else if (p.b64) {
      if (isVideo(f.mime)) {
        const blob = b64ToBlobUrl(p.b64, f.mime);
        if (blob) { S.mediaCache.set(f.fileId, blob); loaded = true; }
      } else {
        S.mediaCache.set(f.fileId, 'data:' + f.mime + ';base64,' + p.b64);
        loaded = true;
      }
    }
  }
  if (loaded && S.active === peer.id) renderMessages(peer);
}

// ═══════════════════════════════════════════════════════════════════
// Theme
// ═══════════════════════════════════════════════════════════════════
const THEMES = [
  { id: 'ocean',   label: 'Ocean',   color: '#4d9fff', bg: '#070b16' },
  { id: 'forest',  label: 'Forest',  color: '#4ade80', bg: '#060d08' },
  { id: 'seafoam', label: 'Seafoam', color: '#2dd4bf', bg: '#050e0e' },
  { id: 'ember',   label: 'Ember',   color: '#fb923c', bg: '#0f0a06' },
  { id: 'violet',  label: 'Violet',  color: '#a78bfa', bg: '#080610' },
  { id: 'slate',   label: 'Slate',   color: '#38bdf8', bg: '#0a0c10' },
  { id: 'rose',    label: 'Rose',    color: '#fb7185', bg: '#100608' },
];

function applyTheme(id) {
  document.documentElement.setAttribute('data-theme', id || 'ocean');
}

// ═══════════════════════════════════════════════════════════════════
// My Info bar
// ═══════════════════════════════════════════════════════════════════
function renderMyInfo() {
  const el = $('my-info');
  if (!S.myInfo) { el.innerHTML = ''; return; }
  const name = S.settings.displayName || S.myInfo.name || 'Me';
  const pic  = S.settings.profilePic;
  const addr = (S.myInfo.localIps?.[0] || '0.0.0.0') + ':' + S.myInfo.port;

  el.innerHTML = `
    ${avatarHtml(name, S.myInfo.id, pic, 38, 'my-avatar')}
    <div class="my-details">
      <div class="my-name">${esc(name)}</div>
      <div class="my-addr">${esc(addr)}</div>
    </div>
    <button class="info-btn" id="my-info-btn" title="Connection info">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/>
        <circle cx="12" cy="8" r="0.5" fill="currentColor"/>
      </svg>
    </button>`;
  $('my-info-btn').addEventListener('click', openMyInfoModal);
}

// ═══════════════════════════════════════════════════════════════════
// UPnP pill
// ═══════════════════════════════════════════════════════════════════
function renderUpnpPill() {
  const pill  = $('upnp-pill');
  const label = $('upnp-label');
  if (!S.upnp) return;
  if (S.upnp.success) {
    pill.className     = 'upnp-pill success';
    label.textContent  = `UPnP :${S.upnp.port}`;
  } else {
    pill.className     = 'upnp-pill fail';
    label.textContent  = 'No UPnP';
  }
}

// ═══════════════════════════════════════════════════════════════════
// Peer list
// ═══════════════════════════════════════════════════════════════════
function renderPeerList() {
  const el    = $('peer-list');
  const peers = Array.from(S.peers.values());

  if (!peers.length) {
    el.innerHTML = `
      <div class="no-peers">
        <div class="no-peers-icon">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
            <circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/>
            <circle cx="19" cy="7" r="2"/><path d="M21 21v-1a2 2 0 0 0-2-2h-1"/>
          </svg>
        </div>
        <p>No peers yet</p>
        <span>Scanning LAN…</span>
      </div>`;
    return;
  }

  el.innerHTML = peers.map(p => {
    const last    = p.messages?.[p.messages.length - 1];
    const files   = p.files || [];
    let preview   = '';
    if (last) {
      const prefix = last.from === 'me' ? '→ ' : '';
      // Show plain text preview (strip markdown-ish symbols for cleanliness)
      const txt = (last.text || '').replace(/\n/g, ' ').slice(0, 80);
      preview = prefix + esc(txt);
    } else if (files.length) {
      preview = '📎 ' + esc(files[files.length-1].name);
    } else {
      preview = esc(p.ip);
    }

    const avHtml = avatarHtml(p.name, p.id, p.profilePic || null, 40, 'peer-avatar');

    // ── Unread badge ──────────────────────────────────────────────
    const unreadCount = S.unread.get(p.id) || 0;
    const unreadBadge = (unreadCount > 0 && p.id !== S.active)
      ? `<span class="peer-unread">${unreadCount > 99 ? '99+' : unreadCount}</span>`
      : '';

    // ── Incoming file/folder indicator ───────────────────────────
    const hasPending = (p.pendingDecisions?.size > 0) || [...(p.folderTransfers?.values() || [])].some(t => t.status === 'pending');
    const hasIncoming = [...(p.inTransfers?.values() || [])].some(t => t.from === 'them' && t.status === 'receiving')
      || [...(p.folderTransfers?.values() || [])].some(t => t.from === 'them' && t.status === 'receiving');
    const fileIndicator = (hasPending || hasIncoming)
      ? `<span class="peer-file-indicator" title="${hasPending ? 'Incoming request' : 'Receiving'}">📥</span>`
      : '';

    // ── Activity row: show what's happening ──────────────────────
    let activityPreview = preview;
    if (hasPending) {
      const pendingFile   = p.pendingDecisions?.size > 0 ? [...p.pendingDecisions.values()][0] : null;
      const pendingFolder = [...(p.folderTransfers?.values() || [])].find(t => t.status === 'pending');
      const pendingItem   = pendingFile || pendingFolder;
      activityPreview = `<span class="peer-incoming-file">📁 Incoming ${pendingFolder ? 'folder' : 'file'}: ${esc(pendingItem?.name || '')}</span>`;
    } else if (hasIncoming) {
      const incoming       = [...(p.inTransfers?.values() || [])].find(t => t.from === 'them' && t.status === 'receiving');
      const incomingFolder = [...(p.folderTransfers?.values() || [])].find(t => t.from === 'them' && t.status === 'receiving');
      const active         = incoming || incomingFolder;
      activityPreview = `<span class="peer-incoming-file">📥 Receiving: ${esc(active?.name || '')}</span>`;
    }

    return `
    <div class="peer-item${p.id === S.active ? ' active' : ''}${!p.connected ? ' offline' : ''}" data-id="${esc(p.id)}">
      ${avHtml}
      <span class="status-dot ${p.connected ? 'online' : 'offline'}" style="position:absolute;left:38px;top:38px"></span>
      <div class="peer-info">
        <div class="peer-name-row">
          <span class="peer-name">${esc(p.name)}</span>
          ${fileIndicator}
          <span class="peer-badge ${p.lan ? 'lan' : 'wan'}">${p.lan ? 'LAN' : 'WAN'}</span>
          ${unreadBadge}
        </div>
        <div class="peer-last">${activityPreview}</div>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.peer-item').forEach(item =>
    item.addEventListener('click', () => selectPeer(item.dataset.id))
  );
}

function selectPeer(id) {
  S.active = id;
  S.unread.delete(id); // clear unread badge when opening chat
  renderPeerList();
  renderChatPanel();
}

// ═══════════════════════════════════════════════════════════════════
// Chat Panel
// ═══════════════════════════════════════════════════════════════════
function renderChatPanel() {
  const peer = S.peers.get(S.active);
  if (!peer) {
    $('chat').style.display        = 'none';
    $('empty-state').style.display = 'flex';
    return;
  }
  $('chat').style.display        = 'flex';
  $('empty-state').style.display = 'none';
  renderChatHeader(peer);
  renderMessages(peer);
  updateInputState(peer);
}

function renderChatHeader(peer) {
  const connStatus = peer.connected
    ? ('\u25cf ' + (peer.lan ? 'LAN' : 'WAN') + '\u00a0\u00a0' + esc(peer.ip))
    : '\u25cb Offline';
  const statusCls = peer.connected ? 'online' : 'offline';
  const disabled  = peer.connected ? '' : 'disabled';

  const fp  = peer.fingerprint || null;
  const fpReady = fp && fp.length >= 8;
  // Format fingerprint in groups of 4 for readability
  const fpLabel = fpReady ? fp.match(/.{1,4}/g).join(' ') : null;
  const fpDisplay = fpReady ? fpLabel : 'Establishing…';
  // Badge style changes when fingerprint is confirmed vs pending
  const badgePendingCls = fpReady ? '' : ' enc-badge-pending';

  // NIC speed display
  const nicInfo = S.nicSpeed?.speedMbps != null
    ? formatNicSpeed(S.nicSpeed.speedMbps)
    : null;
  const nicHtml = nicInfo
    ? `<span class="nic-speed-badge" title="NIC link speed on ${S.nicSpeed.iface || 'interface'}">\u26a1 ${esc(nicInfo)}</span>`
    : '';

  $('chat-header').innerHTML =
    '<div class="ch-left">' +
      avatarHtml(peer.name, peer.id, peer.profilePic||null, 36, 'chat-avatar') +
      '<div>' +
        '<div class="ch-name" style="display:flex;align-items:center;gap:7px;overflow:visible">' +
          esc(peer.name) +
          `<span class="enc-badge${badgePendingCls}" id="enc-badge-btn">` +
            '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">' +
              '<rect x="3" y="11" width="18" height="11" rx="2"/>' +
              '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>' +
            '</svg>' +
            (fpReady ? ' E2E' : ' E2E…') +
            '<div class="fp-tooltip" id="fp-tooltip">' +
              '<div class="fp-label">Session Key Fingerprint</div>' +
              (fpReady
                ? `<div class="fp-value" id="fp-value-text">${esc(fpLabel)}</div>` +
                  '<div class="fp-copy-row">' +
                    '<div class="fp-hint">Verify this matches on both devices for MITM protection</div>' +
                    '<button class="fp-copy-btn" id="fp-copy-btn" title="Copy fingerprint">Copy</button>' +
                  '</div>'
                : '<div class="fp-value fp-value-pending">Waiting for handshake…</div>' +
                  '<div class="fp-hint">Connect to the peer first to establish an encrypted session.</div>'
              ) +
            '</div>' +
          '</span>' +
          nicHtml +
        '</div>' +
        '<div class="ch-status ' + statusCls + '">' + connStatus + '</div>' +
      '</div>' +
    '</div>';

  // Wire fingerprint tooltip — click to toggle, click outside to dismiss
  const badge = document.getElementById('enc-badge-btn');
  const tooltip = document.getElementById('fp-tooltip');
  if (badge && tooltip) {
    badge.addEventListener('click', e => {
      e.stopPropagation();
      const isVisible = tooltip.classList.contains('visible');
      document.querySelectorAll('.fp-tooltip.visible').forEach(t => t.classList.remove('visible'));
      if (!isVisible) {
        // Position using fixed coords so it never gets clipped by overflow:hidden parents
        const r = badge.getBoundingClientRect();
        tooltip.style.top  = (r.bottom + 8) + 'px';
        tooltip.style.left = r.left + 'px';
        tooltip.classList.add('visible');
      }
    });
    document.addEventListener('click', function closeFp(e) {
      if (!badge.contains(e.target)) tooltip.classList.remove('visible');
    });
  }

  // Wire copy button
  const copyBtn = document.getElementById('fp-copy-btn');
  if (copyBtn && fpReady) {
    copyBtn.addEventListener('click', e => {
      e.stopPropagation();
      navigator.clipboard.writeText(fp).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      }).catch(() => {});
    });
  }
}


function updateInputState(peer) {
  const input = $('msg-input');
  const send  = $('send-btn');
  const att   = $('attach-btn');
  const fld   = $('folder-btn');
  const on    = peer?.connected;
  input.disabled    = !on;
  input.placeholder = on ? 'Message…' : 'Peer offline…';
  send.disabled     = !on;
  att.disabled      = !on;
  if (fld) fld.disabled = !on;
}

// ═══════════════════════════════════════════════════════════════════
// Messages
// ═══════════════════════════════════════════════════════════════════

// Build inline transfer bubble HTML
function folderBubbleHtml(t) {
  const prog       = S.fileProgress.get(t.folderId);
  const received   = prog?.received ?? 0;
  const total      = t.totalSize || 1;
  const pct        = Math.min(100, Math.round((received / total) * 100));
  const speed      = prog?.speed || 0;
  const isPending  = t.status === 'pending';
  const isWaiting  = t.status === 'waiting';
  const isRejected = t.status === 'rejected';
  const out        = t.from === 'me';
  const showBar    = !isPending && !isWaiting && !isRejected;
  const shortId    = t.folderId.slice(0, 6);

  const folderIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';

  const subParts = [fsize(t.totalSize || 0), t.fileCount ? t.fileCount + ' files' : ''];
  const subInfo  = subParts.filter(Boolean).join(' · ');

  let currentFileRow = '';
  if (showBar && t.currentFile) {
    currentFileRow = '<div class="tb-current-file" title="' + esc(t.currentFile) + '">' + esc(t.currentFile) + '</div>';
  }

  let statusRow = '';
  if (isRejected) {
    statusRow = '<div class="tb-status declined">✕ Declined by receiver</div>';
  } else if (isWaiting) {
    statusRow = '<div class="tb-status waiting">⋯ Waiting for receiver…</div>';
  } else if (isPending) {
    statusRow =
      '<div class="tb-actions">' +
        '<button class="tb-btn decline folder-decline" data-fid="' + esc(t.folderId) + '" data-pid="' + esc(t.peerId || '') + '">Decline</button>' +
        '<button class="tb-btn accept folder-accept" data-fid="' + esc(t.folderId) + '" data-pid="' + esc(t.peerId || '') + '">Accept</button>' +
      '</div>';
  }

  return '<div class="msg-wrap ' + (out ? 'out' : 'in') + '">' +
    '<div class="transfer-bubble ' + (out ? 'out' : 'in') + (isRejected ? ' declined' : '') + '" data-fid="' + esc(t.folderId) + '">' +
      '<div class="tb-header">' +
        '<div class="tb-icon" ' + (!out && !isPending && !isWaiting ? 'style="color:var(--online)"' : '') + '>' + folderIcon + '</div>' +
        '<div class="tb-meta">' +
          '<div class="tb-name">' + esc(t.name) + '</div>' +
          '<div class="tb-sub"><span>' + subInfo + '</span><span class="tb-id">#' + shortId + '</span>' +
            '<span class="tb-speed">' + (showBar && speed > 0 ? fspeed(speed) : '') + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      currentFileRow +
      (showBar ? '<div class="tb-progress-wrap"><div class="tb-bar-track"><div class="tb-bar" style="width:' + pct + '%"></div></div><span class="tb-pct">' + pct + '%</span></div>' : '') +
      statusRow +
    '</div>' +
  '</div>';
}

function folderReadyToSaveBubbleHtml(t) {
  const folderIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  const subInfo = fsize(t.totalSize || 0) + (t.fileCount ? ' · ' + t.fileCount + ' files' : '');

  return '<div class="msg-wrap in">' +
    '<div class="transfer-bubble in" data-fid="' + esc(t.folderId) + '">' +
      '<div class="tb-header">' +
        '<div class="tb-icon" style="color:var(--online)">' + folderIcon + '</div>' +
        '<div class="tb-meta">' +
          '<div class="tb-name">' + esc(t.name) + '</div>' +
          '<div class="tb-sub"><span>' + subInfo + '</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="tb-progress-wrap"><div class="tb-bar-track"><div class="tb-bar" style="width:100%;background:var(--online)"></div></div><span class="tb-pct">100%</span></div>' +
      '<div class="tb-actions"><button class="tb-btn accept folder-save-btn" data-fid="' + esc(t.folderId) + '" data-name="' + esc(t.name) + '">Save Folder</button></div>' +
    '</div>' +
  '</div>';
}

function transferBubbleHtml(t, direction) {
  const prog    = S.fileProgress.get(t.fileId);
  const received = prog?.received ?? 0;
  const size    = t.size || 1;
  const pct     = Math.min(100, Math.round((received / size) * 100));
  const speed   = prog?.speed || 0;
  const shortId = t.fileId.slice(0, 6);
  const isPending  = t.status === 'pending';
  const isWaiting  = t.status === 'waiting';
  const isRejected = t.status === 'rejected';

  const iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
  const showBar = !isPending && !isWaiting && !isRejected;

  let statusRow = '';
  if (isRejected) statusRow = '<div class="tb-status declined">✕ Declined by receiver</div>';
  else if (isWaiting) statusRow = '<div class="tb-status waiting">⋯ Waiting for receiver…</div>';
  else if (isPending) statusRow =
    '<div class="tb-actions">' +
      '<button class="tb-btn decline" data-fid="' + esc(t.fileId) + '" data-pid="' + esc(t.peerId||t.from==='them'?'':t.fileId) + '">Decline</button>' +
      '<button class="tb-btn accept" data-fid="' + esc(t.fileId) + '" data-pid="' + esc(t.peerId||'') + '">Accept</button>' +
    '</div>';

  return '<div class="msg-wrap ' + direction + '">' +
    '<div class="transfer-bubble ' + direction + (isRejected ? ' declined' : '') + '" data-fid="' + esc(t.fileId) + '">' +
      '<div class="tb-header">' +
        '<div class="tb-icon">' + iconSvg + '</div>' +
        '<div class="tb-meta">' +
          '<div class="tb-name">' + esc(t.name) + '</div>' +
          '<div class="tb-sub"><span>' + fsize(size) + '</span><span class="tb-id">#' + shortId + '</span>' +
          '<span class="tb-speed">' + (showBar && speed > 0 ? fspeed(speed) : '') + '</span></div>' +
        '</div>' +
      '</div>' +
      (showBar ? '<div class="tb-progress-wrap"><div class="tb-bar-track"><div class="tb-bar" style="width:' + pct + '%"></div></div><span class="tb-pct">' + pct + '%</span></div>' : '') +
      statusRow +
    '</div>' +
  '</div>';
}

function readyToSaveBubbleHtml(t) {
  const iconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
  const mime = t.mime || '';
  const PREVIEW_LIMIT = 300 * 1024 * 1024;
  const canPreview = isMedia(mime) && (t.size || 0) <= PREVIEW_LIMIT;
  const cachedUrl = canPreview ? S.mediaCache.get(t.fileId) : null;

  let previewHtml = '';
  if (cachedUrl && isImage(mime)) {
    const isGif = mime === 'image/gif';
    previewHtml = '<div class="rts-preview">' +
      '<div class="media-thumb-wrap ' + (isGif ? 'gif-thumb' : 'img-thumb') + '" data-url="' + esc(cachedUrl) + '" data-mime="' + esc(mime) + '" data-name="' + esc(t.name) + '">' +
        '<img src="' + esc(cachedUrl) + '" alt="' + esc(t.name) + '" style="max-height:200px;width:100%;object-fit:contain;border-radius:6px"/>' +
        (!isGif ? '<div class="media-overlay img-overlay"><div class="media-expand-btn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg></div></div>' : '') +
      '</div>' +
    '</div>';
  } else if (cachedUrl && isVideo(mime)) {
    previewHtml = '<div class="rts-preview">' +
      '<div class="media-thumb-wrap vid-thumb" data-url="' + esc(cachedUrl) + '" data-mime="' + esc(mime) + '" data-name="' + esc(t.name) + '">' +
        '<video muted preload="metadata" playsinline style="max-height:200px;width:100%;border-radius:6px"><source src="' + esc(cachedUrl) + '"/></video>' +
        '<div class="media-overlay vid-overlay"><div class="media-expand-btn"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3l14 9-14 9V3z"/></svg></div></div>' +
      '</div>' +
    '</div>';
  } else if (cachedUrl && isAudio(mime)) {
    previewHtml = '<div class="rts-preview"><audio controls src="' + esc(cachedUrl) + '" style="width:100%;margin:4px 0"></audio></div>';
  }

  return '<div class="msg-wrap in">' +
    '<div class="transfer-bubble in" data-fid="' + esc(t.fileId) + '">' +
      '<div class="tb-header">' +
        '<div class="tb-icon" style="color:var(--online)">' + iconSvg + '</div>' +
        '<div class="tb-meta">' +
          '<div class="tb-name">' + esc(t.name) + '</div>' +
          '<div class="tb-sub"><span>' + fsize(t.size) + '</span><span class="tb-id">#' + t.fileId.slice(0,6) + '</span></div>' +
        '</div>' +
      '</div>' +
      previewHtml +
      '<div class="tb-progress-wrap"><div class="tb-bar-track"><div class="tb-bar" style="width:100%;background:var(--online)"></div></div><span class="tb-pct">100%</span></div>' +
      '<div class="tb-actions"><button class="tb-btn accept save-btn" data-fid="' + esc(t.fileId) + '" data-name="' + esc(t.name) + '" data-mime="' + esc(mime) + '">Save File</button></div>' +
    '</div>' +
  '</div>';
}


function renderMessages(peer) {
  const el = $('messages');

  // Build unified timeline from messages, completed files, in-transit, and pending decisions
  const items = [
    ...(peer.messages        || []).map(m => ({ ...m, _k: 'msg' })),
    ...(peer.files           || []).map(f => ({ ...f, _k: f.isFolder ? 'folder-file' : 'file' })),
    ...[...(peer.inTransfers      || new Map()).values()].map(t => ({ ...t, _k: 'transfer' })),
    ...[...(peer.pendingDecisions || new Map()).values()].map(t => ({ ...t, _k: 'transfer' })),
    ...[...(peer.readyToSave      || new Map()).values()].map(t => ({ ...t, _k: 'ready' })),
    ...[...(peer.folderTransfers  || new Map()).values()].map(t => ({ ...t, _k: 'folder-transfer' })),
    ...[...(peer.folderReadyToSave|| new Map()).values()].map(t => ({ ...t, _k: 'folder-ready' })),
  ].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  if (!items.length) {
    el.innerHTML = `<div class="no-messages">Say hello to ${esc(peer.name)} ✦</div>`;
    return;
  }

  const html = [];
  let lastDate = '';

  for (const item of items) {
    const d = item.timestamp
      ? new Date(item.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' })
      : '';
    if (d && d !== lastDate) { html.push(`<div class="date-divider">${d}</div>`); lastDate = d; }

    // ── Text message ───────────────────────────────────────────────
    if (item._k === 'msg') {
      const out   = item.from === 'me';
      const rBar  = reactionBarHtml(S.active, item.id);
      const emojiOnly = isEmojiOnly(item.text);

      // Reply quote block
      let quoteHtml = '';
      if (item.replyTo) {
        const qwho = item.replyTo.from === 'me' ? 'You' : (peer.name || 'Them');
        const qprev = (item.replyTo.text || '').slice(0, 100);
        quoteHtml = `<div class="msg-quote" data-rto="${esc(item.replyTo.id)}">
          <span class="msg-quote-who">${esc(qwho)}</span>
          <span class="msg-quote-text">${esc(qprev)}</span>
        </div>`;
      }

      if (emojiOnly && !item.replyTo) {
        // Big naked emoji — no bubble wrapper
        html.push(`
          <div class="msg-wrap ${out ? 'out' : 'in'}" data-mid="${esc(item.id)}">
            <div class="emoji-only-msg ${out ? 'out' : 'in'}">
              <span class="emoji-only-text">${renderEmoji(item.text.trim())}</span>
              <span class="emoji-only-time">${ftime(item.timestamp)}</span>
              <div class="bubble-actions emoji-bubble-actions">
                <button class="bubble-btn react-btn" data-mid="${esc(item.id)}" title="React">😊</button>
                <button class="bubble-btn reply-btn" data-mid="${esc(item.id)}" data-text="${esc(item.text)}" data-from="${esc(item.from)}" title="Reply">↩</button>
              </div>
            </div>
            ${rBar}
          </div>`);
      } else {
        html.push(`
          <div class="msg-wrap ${out ? 'out' : 'in'}" data-mid="${esc(item.id)}">
            <div class="bubble ${out ? 'out' : 'in'}">
              ${quoteHtml}
              <div class="msg-text">${renderMarkdown(item.text)}</div>
              <div class="msg-meta"><span class="msg-time">${ftime(item.timestamp)}</span></div>
              <div class="bubble-actions">
                <button class="bubble-btn react-btn" data-mid="${esc(item.id)}" title="React">😊</button>
                <button class="bubble-btn reply-btn" data-mid="${esc(item.id)}" data-text="${esc(item.text)}" data-from="${esc(item.from)}" title="Reply">↩</button>
              </div>
            </div>
            ${rBar}
          </div>`);
      }
      continue;
    }

    // ── In-transit / pending / rejected transfer bubble ────────────
    if (item._k === 'transfer') {
      html.push(transferBubbleHtml(item, item.from === 'me' ? 'out' : 'in'));
      continue;
    }

    // ── Folder in-transit / pending / rejected ──────────────────────
    if (item._k === 'folder-transfer') {
      html.push(folderBubbleHtml(item));
      continue;
    }

    // ── Ready to save (ask mode: transfer done, awaiting user save) ─
    if (item._k === 'ready') {
      html.push(readyToSaveBubbleHtml(item));
      continue;
    }

    // ── Folder ready to save ────────────────────────────────────────
    if (item._k === 'folder-ready') {
      html.push(folderReadyToSaveBubbleHtml(item));
      continue;
    }

    // ── Completed folder (already saved) ───────────────────────────
    if (item._k === 'folder-file') {
      const out = item.from === 'me';
      const folderIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
      const subInfo = fsize(item.totalSize || 0) + (item.fileCount ? ' · ' + item.fileCount + ' files' : '');
      const mRBar = reactionBarHtml(S.active, item.folderId);
      const reactBtn = '<button class="bubble-btn react-btn" data-mid="' + esc(item.folderId) + '" title="React">😊</button>';
      html.push(
        '<div class="msg-wrap ' + (out ? 'out' : 'in') + '" data-mid="' + esc(item.folderId) + '">' +
          '<div class="bubble file-bubble ' + (out ? 'out' : 'in') + '">' +
            '<div class="file-meta-row">' +
              '<span class="file-icon">' + folderIcon + '</span>' +
              '<div class="file-info">' +
                '<span class="file-name' + (item.savedTo ? ' file-name-link' : '') + '"' +
                  (item.savedTo ? ' data-open-path="' + esc(item.savedTo) + '"' : '') + '>' +
                  esc(item.name) +
                '</span>' +
                '<span class="file-sub">' + subInfo + '</span>' +
              '</div>' +
              (item.savedTo
                ? '<button class="dl-btn" data-saved-to="' + esc(item.savedTo) + '" title="Show in folder">' +
                    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>' +
                  '</button>'
                : '') +
            '</div>' +
            '<div class="bubble-actions">' + reactBtn + '</div>' +
          '</div>' +
          mRBar +
        '</div>'
      );
      continue;
    }

    // ── Completed file ─────────────────────────────────────────────
    const out  = item.from === 'me';
    const mime = item.mime || 'application/octet-stream';

    // Receiver media with cached URL — show inline
    if (!out && isMedia(mime)) {
      const url = S.mediaCache.get(item.fileId);
      const mRBar = reactionBarHtml(S.active, item.fileId);
      const reactBtn = `<button class="bubble-btn react-btn" data-mid="${esc(item.fileId)}" title="React">😊</button>`;

      if (!url) {
        html.push(`
          <div class="msg-wrap in" data-mid="${esc(item.fileId)}">
            <div class="bubble media-bubble in">
              <div class="media-loading">Loading…</div>
              <div class="file-meta-row">
                <span class="file-name">${esc(item.name)}</span>
                <span class="file-size">${fsize(item.size)}</span>
              </div>
              <div class="bubble-actions">${reactBtn}</div>
            </div>
            ${mRBar}
          </div>`);
      } else if (isAudio(mime)) {
        html.push(`
          <div class="msg-wrap in" data-mid="${esc(item.fileId)}">
            <div class="bubble media-bubble in" style="min-width:260px">
              <div class="file-meta-row" style="margin-bottom:6px">
                <span class="file-name${item.savedTo ? ' file-name-link' : ''}" ${item.savedTo ? `data-open-path="${esc(item.savedTo)}"` : ''}>${esc(item.name)}</span>
                <button class="dl-btn" data-fid="${esc(item.fileId)}" data-name="${esc(item.name)}" ${item.savedTo ? `data-saved-to="${esc(item.savedTo)}"` : ''} title="${item.savedTo ? 'Show in folder' : 'Save'}">
                  ${item.savedTo
                    ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`
                    : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`}
                </button>
              </div>
              <audio controls style="width:100%;height:36px" src="${esc(url)}"></audio>
              <div class="bubble-actions">${reactBtn}</div>
            </div>
            ${mRBar}
          </div>`);
      } else if (isImage(mime)) {
        const isGif = mime === 'image/gif';
        html.push(`
          <div class="msg-wrap in" data-mid="${esc(item.fileId)}">
            <div class="bubble media-bubble in">
              <div class="media-thumb-wrap ${isGif ? 'gif-thumb' : 'img-thumb'}"
                   data-url="${esc(url)}" data-mime="${esc(mime)}" data-name="${esc(item.name)}">
                <img src="${url}" alt="${esc(item.name)}" loading="lazy"/>
                <div class="media-overlay img-overlay">
                  <div class="media-expand-btn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
                  </div>
                </div>
              </div>
              <div class="file-meta-row">
                <span class="file-name${item.savedTo ? ' file-name-link' : ''}" ${item.savedTo ? `data-open-path="${esc(item.savedTo)}"` : ''}>${esc(item.name)}</span>
                <button class="dl-btn" data-fid="${esc(item.fileId)}" data-name="${esc(item.name)}" ${item.savedTo ? `data-saved-to="${esc(item.savedTo)}"` : ''} title="${item.savedTo ? 'Show in folder' : 'Save'}">
                  ${item.savedTo
                    ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`
                    : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`}
                </button>
              </div>
              <div class="bubble-actions">${reactBtn}</div>
            </div>
            ${mRBar}
          </div>`);
      } else {
        // Video
        html.push(`
          <div class="msg-wrap in" data-mid="${esc(item.fileId)}">
            <div class="bubble media-bubble in">
              <div class="media-thumb-wrap vid-thumb"
                   data-url="${esc(url)}" data-mime="${esc(mime)}" data-name="${esc(item.name)}">
                <video muted preload="metadata" playsinline>
                  <source src="${url}"/>
                </video>
                <div class="media-overlay vid-overlay">
                  <div class="media-expand-btn">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3l14 9-14 9V3z"/></svg>
                  </div>
                </div>
              </div>
              <div class="file-meta-row">
                <span class="file-name${item.savedTo ? ' file-name-link' : ''}" ${item.savedTo ? `data-open-path="${esc(item.savedTo)}"` : ''}>${esc(item.name)}</span>
                <button class="dl-btn" data-fid="${esc(item.fileId)}" data-name="${esc(item.name)}" ${item.savedTo ? `data-saved-to="${esc(item.savedTo)}"` : ''} title="${item.savedTo ? 'Show in folder' : 'Save'}">
                  ${item.savedTo
                    ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`
                    : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`}
                </button>
              </div>
              <div class="bubble-actions">${reactBtn}</div>
            </div>
            ${mRBar}
          </div>`);
      }
      continue;
    }

    // Sender media with cached preview
    if (out && isMedia(mime) && S.mediaCache.has(item.fileId)) {
      const url = S.mediaCache.get(item.fileId);
      const mRBar = reactionBarHtml(S.active, item.fileId);
      const reactBtn = `<button class="bubble-btn react-btn" data-mid="${esc(item.fileId)}" title="React">😊</button>`;
      if (isAudio(mime)) {
        html.push(`
          <div class="msg-wrap out" data-mid="${esc(item.fileId)}">
            <div class="bubble media-bubble out" style="min-width:260px">
              <div class="file-meta-row" style="margin-bottom:6px">
                <span class="file-name${item.savedTo ? ' file-name-link' : ''}" ${item.savedTo ? `data-open-path="${esc(item.savedTo)}"` : ''}>${esc(item.name)}</span>
              </div>
              <audio controls style="width:100%;height:36px" src="${esc(url)}"></audio>
              <div class="bubble-actions">${reactBtn}</div>
            </div>
            ${mRBar}
          </div>`);
        continue;
      } else if (isImage(mime)) {
        const isGif = mime === 'image/gif';
        html.push(`
          <div class="msg-wrap out" data-mid="${esc(item.fileId)}">
            <div class="bubble media-bubble out">
              <div class="media-thumb-wrap ${isGif ? 'gif-thumb' : 'img-thumb'}"
                   data-url="${esc(url)}" data-mime="${esc(mime)}" data-name="${esc(item.name)}">
                <img src="${url}" alt="${esc(item.name)}" loading="lazy"/>
                <div class="media-overlay img-overlay">
                  <div class="media-expand-btn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
                  </div>
                </div>
              </div>
              <div class="file-meta-row">
                <span class="file-name${item.savedTo ? ' file-name-link' : ''}" ${item.savedTo ? `data-open-path="${esc(item.savedTo)}"` : ''}>${esc(item.name)}</span>
              </div>
              <div class="bubble-actions">${reactBtn}</div>
            </div>
            ${mRBar}
          </div>`);
        continue;
      } else if (isVideo(mime)) {
        html.push(`
          <div class="msg-wrap out" data-mid="${esc(item.fileId)}">
            <div class="bubble media-bubble out">
              <div class="media-thumb-wrap vid-thumb"
                   data-url="${esc(url)}" data-mime="${esc(mime)}" data-name="${esc(item.name)}">
                <video muted preload="metadata" playsinline>
                  <source src="${url}"/>
                </video>
                <div class="media-overlay vid-overlay">
                  <div class="media-expand-btn">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3l14 9-14 9V3z"/></svg>
                  </div>
                </div>
              </div>
              <div class="file-meta-row">
                <span class="file-name${item.savedTo ? ' file-name-link' : ''}" ${item.savedTo ? `data-open-path="${esc(item.savedTo)}"` : ''}>${esc(item.name)}</span>
              </div>
              <div class="bubble-actions">${reactBtn}</div>
            </div>
            ${mRBar}
          </div>`);
        continue;
      }
    }

    // Standard file bubble
    const fRBar = reactionBarHtml(S.active, item.fileId);
    html.push(`
      <div class="msg-wrap ${out ? 'out' : 'in'}\" data-mid="${esc(item.fileId)}">
        <div class="bubble file-bubble ${out ? 'out' : 'in'}">
          <div class="file-icon-wrap">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            </svg>
          </div>
          <div class="file-details">
            <div class="file-name${item.savedTo ? ' file-name-link' : ''}" ${item.savedTo ? `data-open-path="${esc(item.savedTo)}"` : ''}>${esc(item.name)}</div>
            <div class="file-size">${fsize(item.size)}</div>
            ${item.savedTo ? `<div class="file-saved">✓ Saved — click to open</div>` : ''}
          </div>
          ${!out ? `
            <button class="dl-btn" data-fid="${esc(item.fileId)}" data-name="${esc(item.name)}" ${item.savedTo ? `data-saved-to="${esc(item.savedTo)}"` : ''} title="${item.savedTo ? 'Show in folder' : 'Save'}">
              ${item.savedTo
                ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`
                : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`}
            </button>` : ''}
          <div class="bubble-actions">
            <button class="bubble-btn react-btn" data-mid="${esc(item.fileId)}" title="React">😊</button>
          </div>
        </div>
        ${fRBar}
      </div>`);
  }

  // Append streak badge if active
  const badge = streakBadgeHtml(S.active);
  if (badge) html.push(badge);

  el.innerHTML = html.join('');

  // Wire: save/open buttons
  el.querySelectorAll('.dl-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const savedTo = btn.dataset.savedTo;
      if (savedTo) {
        // File already saved — reveal it in Finder / Explorer
        window.edge.showItemInFolder(savedTo);
      } else {
        // Not yet saved — show save dialog
        window.edge.saveFile(btn.dataset.fid, btn.dataset.name);
      }
    });
  });

  // Wire: click filename to open already-saved files
  el.querySelectorAll('.file-name-link').forEach(span => {
    span.addEventListener('click', e => {
      e.stopPropagation();
      if (span.dataset.openPath) window.edge.openFile(span.dataset.openPath);
    });
  });

  // Wire: image lightbox (static images only — not GIFs)
  el.querySelectorAll('.img-thumb').forEach(wrap => {
    wrap.addEventListener('click', () => openLightbox(wrap.dataset.url, wrap.dataset.mime, wrap.dataset.name));
  });
  // Wire: GIF click → lightbox (so they can see it full size if desired)
  el.querySelectorAll('.gif-thumb').forEach(wrap => {
    wrap.addEventListener('click', () => openLightbox(wrap.dataset.url, wrap.dataset.mime, wrap.dataset.name));
  });

  // Wire: video hover-preview + click-to-lightbox
  el.querySelectorAll('.vid-thumb').forEach(wrap => {
    const vid = wrap.querySelector('video');

    // The thumbnail <video> uses a <source> child. If that <source> has a
    // type= attribute like "video/x-matroska" or "video/mp4" Chromium does a
    // capability pre-check and can reject the source before loading a single
    // byte — even for codecs it can actually decode (H.265, AV1, etc.). The
    // lightbox works because it sets vid.src directly with no type attribute.
    // Fix: remove the type attribute so Chromium sniffs the actual bitstream.
    if (vid) {
      const source = vid.querySelector('source');
      if (source) source.removeAttribute('type');
    }

    wrap.addEventListener('mouseenter', () => {
      if (!vid || vid.error) return;
      vid.volume = 0.5;
      vid.play().catch(() => {});
    });
    wrap.addEventListener('mouseleave', () => {
      if (!vid) return;
      vid.pause();
      vid.currentTime = 0;
    });
    wrap.addEventListener('click', () => openLightbox(wrap.dataset.url, wrap.dataset.mime, wrap.dataset.name));
  });

  // Wire: Accept button (ask mode — fires before transfer, sends accept to peer)
  el.querySelectorAll('.tb-btn.accept:not(.save-btn):not(.folder-accept):not(.folder-save-btn)').forEach(btn => {
    btn.addEventListener('click', () => {
      const fid = btn.dataset.fid;
      const pid = btn.dataset.pid;
      btn.textContent = 'Accepted…';
      btn.disabled = true;
      const decBtn = btn.closest('.tb-actions')?.querySelector('.decline');
      if (decBtn) decBtn.disabled = true;
      window.edge.respondToFile(fid, pid, true);
    });
  });

  // Wire: Decline button (files)
  el.querySelectorAll('.tb-btn.decline:not(.folder-decline)').forEach(btn => {
    btn.addEventListener('click', () => {
      const fid = btn.dataset.fid;
      const pid = btn.dataset.pid;
      window.edge.respondToFile(fid, pid, false);
    });
  });

  // Wire: Folder accept button
  el.querySelectorAll('.tb-btn.folder-accept').forEach(btn => {
    btn.addEventListener('click', () => {
      const fid = btn.dataset.fid;
      const pid = btn.dataset.pid;
      btn.textContent = 'Accepted…';
      btn.disabled = true;
      const decBtn = btn.closest('.tb-actions')?.querySelector('.folder-decline');
      if (decBtn) decBtn.disabled = true;
      window.edge.respondToFolder(fid, pid, true);
    });
  });

  // Wire: Folder decline button
  el.querySelectorAll('.tb-btn.folder-decline').forEach(btn => {
    btn.addEventListener('click', () => {
      const fid = btn.dataset.fid;
      const pid = btn.dataset.pid;
      window.edge.respondToFolder(fid, pid, false);
    });
  });

  // Wire: Save Folder button
  el.querySelectorAll('.tb-btn.folder-save-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const fid  = btn.dataset.fid;
      const name = btn.dataset.name;
      btn.textContent = 'Saving…';
      btn.disabled = true;
      const result = await window.edge.saveReceivedFolder(fid, name);
      if (result.success) {
        for (const peer of S.peers.values()) {
          if (!peer.folderReadyToSave?.has(fid)) continue;
          const entry = peer.folderReadyToSave.get(fid);
          peer.folderReadyToSave.delete(fid);
          if (!peer.files) peer.files = [];
          peer.files.push({ ...entry, savedTo: result.savedTo, isFolder: true });
          renderPeerList();
          if (S.active === peer.id) renderMessages(peer);
          break;
        }
      } else if (!result.canceled) {
        btn.textContent = 'Save Folder';
        btn.disabled = false;
      }
    });
  });

  // Wire: Save File button (ask mode — transfer done, file on disk)
  el.querySelectorAll('.tb-btn.save-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const fid  = btn.dataset.fid;
      const name = btn.dataset.name;
      const mime = btn.dataset.mime || '';
      btn.textContent = 'Saving…';
      btn.disabled = true;
      const result = await window.edge.saveReceivedFile(fid, name, mime);
      if (result.success) {
        // Update preview cache to point at the saved (permanent) file
        if (result.savedTo && (mime.startsWith('image/') || mime.startsWith('video/'))) {
          S.mediaCache.set(fid, 'file://' + result.savedTo);
        }
        for (const peer of S.peers.values()) {
          if (!peer.readyToSave?.has(fid)) continue;
          const entry = peer.readyToSave.get(fid);
          peer.readyToSave.delete(fid);
          if (!peer.files) peer.files = [];
          peer.files.push({ ...entry, savedTo: result.savedTo });
          renderPeerList();
          if (S.active === peer.id) renderMessages(peer);
          break;
        }
      } else if (!result.canceled) {
        btn.textContent = 'Save File';
        btn.disabled = false;
      }
    });
  });

  // Wire: reaction button on messages and files
  el.querySelectorAll('.react-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      document.querySelectorAll('.inline-emoji-picker').forEach(p => p.remove());
      const msgId = btn.dataset.mid;
      const picker = buildEmojiPicker(emoji => {
        picker.remove();
        const r = getReactions(S.active);
        const m = r.get(msgId);
        const alreadyReacted = m?.has(`me:${emoji}`);
        addReaction(S.active, msgId, emoji, true); // toggles local state
        window.edge.sendReaction(S.active, msgId, emoji, alreadyReacted); // true = remove
        const p = S.peers.get(S.active);
        if (p) renderMessages(p);
      });
      picker.className += ' inline-emoji-picker';
      // Works for regular bubbles, file bubbles, and emoji-only messages
      const parent = btn.closest('.bubble') || btn.closest('.emoji-only-msg') || btn.closest('.file-bubble');
      if (parent) parent.appendChild(picker);
      // Smart position: flip direction based on available space
      requestAnimationFrame(() => {
        const rect = picker.getBoundingClientRect();
        if (rect.top < 8) {
          picker.style.bottom = 'auto';
          picker.style.top    = 'calc(100% + 6px)';
        }
        if (rect.right > window.innerWidth - 8) {
          picker.style.right = '0';
          picker.style.left  = 'auto';
        }
        if (rect.left < 8) {
          picker.style.left  = '0';
          picker.style.right = 'auto';
        }
      });
      setTimeout(() => {
        document.addEventListener('click', function closeP(ev) {
          if (!picker.contains(ev.target) && ev.target !== btn) {
            picker.remove();
            document.removeEventListener('click', closeP);
          }
        });
      }, 0);
    });
  });

  // Wire: reply button
  el.querySelectorAll('.reply-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setReply({ id: btn.dataset.mid, text: btn.dataset.text, from: btn.dataset.from });
      $('msg-input').focus();
    });
  });

  // Wire: click on reply quote → scroll to original message
  el.querySelectorAll('.msg-quote').forEach(q => {
    q.addEventListener('click', () => {
      const target = el.querySelector(`[data-mid="${q.dataset.rto}"]`);
      if (target) { target.scrollIntoView({ behavior:'smooth', block:'center' }); target.classList.add('highlight'); setTimeout(() => target.classList.remove('highlight'), 1200); }
    });
  });

  // Wire: reaction chip toggle — click mine to remove, click theirs to add same
  el.querySelectorAll('.reaction-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const msgId = chip.dataset.mid;
      const emoji = chip.dataset.e;
      const isMine = chip.classList.contains('mine');
      addReaction(S.active, msgId, emoji, true); // toggles local state
      window.edge.sendReaction(S.active, msgId, emoji, isMine); // send remove=true if it was mine
      const p = S.peers.get(S.active);
      if (p) renderMessages(p);
    });
  });

  el.scrollTop = el.scrollHeight;
  loadPendingMedia(peer);
}


// ═══════════════════════════════════════════════════════════════════
// Send
// ═══════════════════════════════════════════════════════════════════
// ── Reply helpers ─────────────────────────────────────────────────
function setReply(msg) {
  S.replyingTo = msg;
  renderReplyBar();
}

function clearReply() {
  S.replyingTo = null;
  renderReplyBar();
}

function renderReplyBar() {
  const existing = $('reply-bar');
  if (existing) existing.remove();
  if (!S.replyingTo) return;

  const bar = document.createElement('div');
  bar.id = 'reply-bar';
  const preview = S.replyingTo.text.slice(0, 80) + (S.replyingTo.text.length > 80 ? '…' : '');
  const who = S.replyingTo.from === 'me' ? 'You' : (S.peers.get(S.active)?.name || 'Them');
  bar.innerHTML = `
    <div class="reply-bar-inner">
      <div class="reply-bar-line"></div>
      <div class="reply-bar-text">
        <span class="reply-bar-who">${esc(who)}</span>
        <span class="reply-bar-preview">${esc(preview)}</span>
      </div>
      <button class="reply-bar-close" id="reply-bar-close">✕</button>
    </div>`;
  $('input-row').before(bar);
  $('reply-bar-close').addEventListener('click', clearReply);
}

async function sendMessage() {
  const input = $('msg-input');
  const text  = input.value.trim();
  if (!text || !S.active) return;
  const peer = S.peers.get(S.active);
  if (!peer?.connected) return;
  const replyTo = S.replyingTo ? { id: S.replyingTo.id, text: S.replyingTo.text, from: S.replyingTo.from } : null;
  const result = await window.edge.sendMessage(S.active, text, replyTo);
  if (result.success) {
    peer.messages.push({ ...result.message, from: 'me' });
    input.value = '';
    autoGrow(input);
    clearReply();
    renderMessages(peer);
    renderPeerList();
  }
}

async function sendFile(peerId) {
  // file-send-start fires from main.js before bytes flow — bubble already visible
  await window.edge.pickAndSendFile(peerId);
}

async function sendFolder(peerId) {
  await window.edge.pickAndSendFolder(peerId);
}

// ═══════════════════════════════════════════════════════════════════
// Network Events
// ═══════════════════════════════════════════════════════════════════
function setupEvents() {
  window.edge.on('peer-profile-updated', ({ peerId, profilePic }) => {
    const peer = S.peers.get(peerId);
    if (!peer) return;
    peer.profilePic = profilePic;
    renderPeerList();
    if (S.active === peerId) renderChatHeader(peer);
  });

  window.edge.on('peer-connected', peer => {
    const ex = S.peers.get(peer.id);
    if (ex) {
      // Merge into existing peer to preserve messages/files/reactions
      ex.connected = true;
      ex.ip = peer.ip;
      ex.lan = peer.lan;
      if (peer.profilePic  !== undefined) ex.profilePic  = peer.profilePic;
      if (peer.fingerprint)               ex.fingerprint = peer.fingerprint; // only update if non-null
    } else {
      S.peers.set(peer.id, peer);
    }
    renderPeerList();
    if (S.active === peer.id) {
      renderChatPanel();
      // Ensure the chat header (which shows E2E fingerprint) is always
      // re-rendered when a connection completes — renderChatPanel calls
      // renderChatHeader internally, but call it explicitly here as well
      // so the fingerprint badge updates even if the panel was already open.
      const p = S.peers.get(peer.id);
      if (p) renderChatHeader(p);
    }
  });

  window.edge.on('peer-reconnected', peer => {
    const ex = S.peers.get(peer.id);
    if (ex) {
      ex.connected  = true;
      ex.ip         = peer.ip;
      if (peer.profilePic  !== undefined) ex.profilePic  = peer.profilePic;
      // Always overwrite fingerprint on reconnect — a new ECDH handshake
      // produces a new session key, so the old fingerprint is stale.
      // The original guard `if (peer.fingerprint)` was correct but we also
      // need to clear a stale fingerprint if the new handshake hasn't
      // resolved yet (peer.fingerprint may be null transiently — keep old).
      if (peer.fingerprint)               ex.fingerprint = peer.fingerprint;
    } else {
      S.peers.set(peer.id, peer);
    }
    renderPeerList();
    if (S.active === peer.id) {
      renderChatPanel();
      // Explicitly re-render the header so the E2E fingerprint badge
      // reflects the new session key from the fresh handshake.
      const p = S.peers.get(peer.id);
      if (p) renderChatHeader(p);
    }
  });

  window.edge.on('peer-disconnected', peerId => {
    const p = S.peers.get(peerId);
    if (p) p.connected = false;
    renderPeerList();
    if (S.active === peerId) renderChatPanel();
  });

  window.edge.on('message-received', ({ peerId, message }) => {
    const peer = S.peers.get(peerId);
    if (!peer) return;
    peer.messages.push(message);
    // Increment unread count if this peer isn't currently open
    if (S.active !== peerId) {
      S.unread.set(peerId, (S.unread.get(peerId) || 0) + 1);
    }
    renderPeerList();
    if (S.active === peerId) renderMessages(peer);
  });

  window.edge.on('reaction-received', ({ peerId, msgId, emoji, remove }) => {
    if (remove) {
      // Remove their reaction
      const r = getReactions(peerId);
      const m = r.get(msgId);
      if (m) m.delete(`them:${emoji}`);
    } else {
      addReaction(peerId, msgId, emoji, false);
    }
    if (S.active === peerId) {
      const peer = S.peers.get(peerId);
      if (peer) renderMessages(peer);
    }
  });

  // ── Sender: request sent, waiting for receiver to accept ──────────────────
  window.edge.on('file-send-start', ({ peerId, fileId, name, size, mime }) => {
    const peer = S.peers.get(peerId);
    if (!peer) return;
    if (!peer.inTransfers) peer.inTransfers = new Map();
    peer.inTransfers.set(fileId, {
      fileId, name, size, mime, status: 'waiting', timestamp: Date.now(), from: 'me',
    });
    renderPeerList();
    if (S.active === peerId) renderMessages(peer);
  });

  // ── Sender: receiver accepted + transfer finished ─────────────────────────
  window.edge.on('file-send-done', ({ fileId, file, error }) => {
    for (const peer of S.peers.values()) {
      if (!peer.inTransfers?.has(fileId)) continue;
      const inEntry = peer.inTransfers.get(fileId);

      if (error) {
        // Show declined/failed status for 4 seconds, then remove
        inEntry.status = error.includes('rejected') ? 'rejected' : 'rejected';
        S.fileProgress.delete(fileId);
        if (S.active === peer.id) renderMessages(peer);
        setTimeout(() => {
          peer.inTransfers?.delete(fileId);
          if (S.active === peer.id) renderMessages(S.peers.get(peer.id));
        }, 4000);
        break;
      }

      peer.inTransfers.delete(fileId);
      if (file) {
        if (!peer.files) peer.files = [];
        peer.files.push({ ...file, from: 'me', timestamp: inEntry.timestamp });
        updateStreak(peer.id, 'me');
        if (isMedia(file.mime)) {
          window.edge.getMediaPreview(fileId).then(p => {
            if (!p) return;
            const url = p.b64 ? (isVideo(file.mime) ? b64ToBlobUrl(p.b64, file.mime) : 'data:' + file.mime + ';base64,' + p.b64) : p.fileUrl;
            if (url) { S.mediaCache.set(fileId, url); if (S.active === peer.id) renderMessages(peer); }
          });
        }
      }
      S.fileProgress.delete(fileId);
      renderPeerList();
      if (S.active === peer.id) renderMessages(peer);
      break;
    }
  });

  // ── Sender: receiver declined ─────────────────────────────────────────────
  window.edge.on('file-send-rejected', ({ peerId, fileId }) => {
    const peer = S.peers.get(peerId);
    if (!peer) return;
    const entry = peer.inTransfers?.get(fileId);
    if (entry) { entry.status = 'rejected'; }
    S.fileProgress.delete(fileId);
    if (S.active === peerId) renderMessages(peer);
    setTimeout(() => {
      peer.inTransfers?.delete(fileId);
      if (S.active === peer.id) renderMessages(S.peers.get(peer.id));
    }, 4000);
  });

  // ── Receiver (auto modes): transfer complete, file saved ─────────────────
  window.edge.on('file-received', ({ peerId, file }) => {
    const peer = S.peers.get(peerId);
    if (!peer) return;
    peer.inTransfers?.delete(file.fileId);
    peer.pendingDecisions?.delete(file.fileId);
    const idx = (peer.files || []).findIndex(f => f.fileId === file.fileId);
    if (idx >= 0) peer.files[idx] = { ...peer.files[idx], ...file, from: 'them' };
    else { if (!peer.files) peer.files = []; peer.files.push({ ...file, from: 'them' }); }
    S.fileProgress.delete(file.fileId);
    // Their file breaks my streak
    updateStreak(peerId, 'them');
    if (isMedia(file.mime)) {
      window.edge.getMediaPreview(file.fileId).then(p => {
        if (!p || S.mediaCache.has(file.fileId)) return;
        const url = p.b64 ? (isVideo(file.mime) ? b64ToBlobUrl(p.b64, file.mime) : 'data:' + file.mime + ';base64,' + p.b64) : p.fileUrl;
        if (url) { S.mediaCache.set(file.fileId, url); if (S.active === peerId) renderMessages(peer); }
      });
    }
    renderPeerList();
    if (S.active === peerId) renderMessages(peer);
  });

  // ── Receiver (auto modes or post-accept): transfer starting ──────────────
  window.edge.on('file-transfer-start', ({ peerId, fileId, name, size, mime }) => {
    const peer = S.peers.get(peerId);
    if (!peer) return;

    // If there's a pending bubble for this fileId, switch it to receiving mode
    if (peer.pendingDecisions?.has(fileId)) {
      const entry = peer.pendingDecisions.get(fileId);
      peer.pendingDecisions.delete(fileId);
      if (!peer.inTransfers) peer.inTransfers = new Map();
      peer.inTransfers.set(fileId, {
        ...entry,
        status: 'receiving',
        // Keep original name/size/mime from the request, not the empty fallback
        name: entry.name || name,
        size: entry.size || size,
        mime: entry.mime || mime,
      });
    } else if (name) {
      // Auto mode: create fresh entry
      if (!peer.inTransfers) peer.inTransfers = new Map();
      peer.inTransfers.set(fileId, {
        fileId, name, size, mime, status: 'receiving', timestamp: Date.now(), from: 'them',
      });
    }
    if (S.active === peerId) renderMessages(peer);
  });

  // ── Receiver (ask mode): show accept/decline BEFORE transfer starts ───────
  window.edge.on('file-incoming-request', ({ peerId, file }) => {
    const peer = S.peers.get(peerId);
    if (!peer) return;
    if (!peer.pendingDecisions) peer.pendingDecisions = new Map();
    peer.pendingDecisions.set(file.fileId, {
      ...file, peerId, status: 'pending', from: 'them', timestamp: Date.now(),
    });
    renderPeerList();
    if (S.active === peerId) renderMessages(peer);
  });

  // ── Receiver (ask mode): transfer done, file on disk, show Save button ────
  window.edge.on('file-ready-to-save', ({ peerId, file }) => {
    const peer = S.peers.get(peerId);
    if (!peer) return;
    peer.pendingDecisions?.delete(file.fileId);
    peer.inTransfers?.delete(file.fileId);
    if (!peer.readyToSave) peer.readyToSave = new Map();
    peer.readyToSave.set(file.fileId, { ...file, from: 'them', timestamp: Date.now() });
    S.fileProgress.delete(file.fileId);

    // Load preview — getMediaPreview returns b64 for ≤300MB, fileUrl for larger
    if (isMedia(file.mime)) {
      window.edge.getMediaPreview(file.fileId).then(p => {
        if (!p || S.mediaCache.has(file.fileId)) { renderPeerList(); if (S.active === peerId) renderMessages(peer); return; }
        if (p.b64) {
          if (isVideo(file.mime)) {
            const u = b64ToBlobUrl(p.b64, file.mime);
            if (u) S.mediaCache.set(file.fileId, u);
          } else {
            S.mediaCache.set(file.fileId, 'data:' + file.mime + ';base64,' + p.b64);
          }
        } else if (p.fileUrl) {
          S.mediaCache.set(file.fileId, p.fileUrl);
        }
        renderPeerList();
        if (S.active === peerId) renderMessages(peer);
      });
    } else {
      renderPeerList();
      if (S.active === peerId) renderMessages(peer);
    }
  });

  // ── Progress ──────────────────────────────────────────────────────────────
  window.edge.on('file-progress', ({ peerId, fileId, received, size, speed = 0 }) => {
    S.fileProgress.set(fileId, { received, size, speed });

    const peer = S.peers.get(peerId);

    // If this is the sender's file and it's still in 'waiting' state, flip it to
    // 'receiving' (means receiver accepted and bytes are flowing)
    if (peer?.inTransfers?.has(fileId)) {
      const entry = peer.inTransfers.get(fileId);
      if (entry.status === 'waiting') {
        entry.status = 'receiving';
        if (S.active === peerId) renderMessages(peer);
        return; // renderMessages already does the full update
      }
    }

    // Also flip receiver pendingDecisions that have been accepted
    if (peer?.pendingDecisions?.has(fileId)) {
      const entry = peer.pendingDecisions.get(fileId);
      if (entry.status === 'accepted') {
        entry.status = 'receiving';
        if (S.active === peerId) renderMessages(peer);
        return;
      }
    }

    if (S.active !== peerId) return;
    const bubble = document.querySelector(`.transfer-bubble[data-fid="${fileId}"]`);
    if (!bubble) return;

    const pct     = size > 0 ? Math.round((received / size) * 100) : 0;
    const bar     = bubble.querySelector('.tb-bar');
    const pctEl   = bubble.querySelector('.tb-pct');
    const speedEl = bubble.querySelector('.tb-speed');
    if (bar)   bar.style.width   = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';
    if (speedEl) speedEl.textContent = speed > 0 ? fspeed(speed) : '';
  });

  // ── Rejected (either side) ────────────────────────────────────────────────
  window.edge.on('file-rejected', ({ fileId }) => {
    S.fileProgress.delete(fileId);
    for (const peer of S.peers.values()) {
      if (peer.pendingDecisions?.has(fileId)) {
        peer.pendingDecisions.delete(fileId);
        if (S.active === peer.id) renderMessages(peer);
        break;
      }
    }
  });

  window.edge.on('upnp-status', status => {
    S.upnp = status;
    renderUpnpPill();
    window.edge.getMyInfo().then(info => { S.myInfo = info; renderMyInfo(); });
  });

  // ── Folder transfer events ────────────────────────────────────────────────

  // Sender: folder dialog picked, waiting for receiver to accept
  window.edge.on('folder-send-start', ({ peerId, folderId, name, totalSize, fileCount }) => {
    const peer = S.peers.get(peerId);
    if (!peer) return;
    if (!peer.folderTransfers) peer.folderTransfers = new Map();
    peer.folderTransfers.set(folderId, {
      folderId, name, totalSize, fileCount, status: 'waiting', timestamp: Date.now(), from: 'me',
    });
    renderPeerList();
    if (S.active === peerId) renderMessages(peer);
  });

  // Sender: done (success or error)
  window.edge.on('folder-send-done', ({ folderId, folder, error }) => {
    for (const peer of S.peers.values()) {
      if (!peer.folderTransfers?.has(folderId)) continue;
      const entry = peer.folderTransfers.get(folderId);
      if (error) {
        entry.status = error.includes('rejected') ? 'rejected' : 'rejected';
        S.fileProgress.delete(folderId);
        if (S.active === peer.id) renderMessages(peer);
        setTimeout(() => {
          peer.folderTransfers?.delete(folderId);
          if (S.active === peer.id) renderMessages(S.peers.get(peer.id));
        }, 4000);
        break;
      }
      peer.folderTransfers.delete(folderId);
      if (folder) {
        if (!peer.files) peer.files = [];
        peer.files.push({ ...folder, from: 'me', timestamp: entry.timestamp, isFolder: true });
      }
      S.fileProgress.delete(folderId);
      renderPeerList();
      if (S.active === peer.id) renderMessages(peer);
      break;
    }
  });

  // Sender: receiver declined
  window.edge.on('folder-send-rejected', ({ peerId, folderId }) => {
    const peer = S.peers.get(peerId);
    if (!peer) return;
    const entry = peer.folderTransfers?.get(folderId);
    if (entry) entry.status = 'rejected';
    S.fileProgress.delete(folderId);
    if (S.active === peerId) renderMessages(peer);
    setTimeout(() => {
      peer.folderTransfers?.delete(folderId);
      if (S.active === peer.id) renderMessages(S.peers.get(peer.id));
    }, 4000);
  });

  // Receiver: incoming folder request (ask mode) — show accept/decline
  window.edge.on('folder-incoming-request', ({ peerId, folder }) => {
    const peer = S.peers.get(peerId);
    if (!peer) return;
    if (!peer.folderTransfers) peer.folderTransfers = new Map();
    peer.folderTransfers.set(folder.folderId, {
      ...folder, peerId, status: 'pending', from: 'them', timestamp: Date.now(),
    });
    renderPeerList();
    if (S.active === peerId) renderMessages(peer);
  });

  // Receiver: accepted, bytes now flowing
  window.edge.on('folder-transfer-start', ({ peerId, folderId, name, totalSize, fileCount }) => {
    const peer = S.peers.get(peerId);
    if (!peer) return;
    if (peer.folderTransfers?.has(folderId)) {
      // transition pending → receiving
      const entry = peer.folderTransfers.get(folderId);
      entry.status = 'receiving';
      if (name) { entry.name = name; entry.totalSize = totalSize; entry.fileCount = fileCount; }
    } else {
      // auto mode: create entry
      if (!peer.folderTransfers) peer.folderTransfers = new Map();
      peer.folderTransfers.set(folderId, {
        folderId, name, totalSize, fileCount, status: 'receiving', timestamp: Date.now(), from: 'them',
      });
    }
    if (S.active === peerId) renderMessages(peer);
  });

  // Both sides: progress tick
  window.edge.on('folder-progress', ({ peerId, folderId, sentBytes, totalSize, currentFile }) => {
    // Update the shared fileProgress map (keyed on folderId) so folderBubbleHtml can read it
    const prev = S.fileProgress.get(folderId) || {};
    S.fileProgress.set(folderId, { ...prev, received: sentBytes, size: totalSize });
    // Update currentFile on the transfer entry so the subtitle updates.
    // Also transition the sender side from 'waiting' → 'receiving' on first progress tick
    // (the sender never gets a folder-transfer-start event, only the receiver does).
    const peer = S.peers.get(peerId);
    if (peer?.folderTransfers?.has(folderId)) {
      const entry = peer.folderTransfers.get(folderId);
      if (entry.status === 'waiting') entry.status = 'receiving';
      entry.currentFile = currentFile;
    }
    if (S.active === peerId && peer) renderMessages(peer);
  });

  // Receiver: all bytes received — ask mode → show Save Folder button
  window.edge.on('folder-ready-to-save', ({ peerId, folder }) => {
    const peer = S.peers.get(peerId);
    if (!peer) return;
    peer.folderTransfers?.delete(folder.folderId);
    if (!peer.folderReadyToSave) peer.folderReadyToSave = new Map();
    peer.folderReadyToSave.set(folder.folderId, { ...folder, from: 'them', timestamp: Date.now() });
    S.fileProgress.delete(folder.folderId);
    renderPeerList();
    if (S.active === peerId) renderMessages(peer);
  });

  // Receiver: auto-save mode — folder already saved to disk
  window.edge.on('folder-received', ({ peerId, folder }) => {
    const peer = S.peers.get(peerId);
    if (!peer) return;
    peer.folderTransfers?.delete(folder.folderId);
    peer.folderReadyToSave?.delete(folder.folderId);
    if (!peer.files) peer.files = [];
    peer.files.push({ ...folder, from: 'them', isFolder: true });
    S.fileProgress.delete(folder.folderId);
    renderPeerList();
    if (S.active === peerId) renderMessages(peer);
  });
}

// ═══════════════════════════════════════════════════════════════════
// MODALS
// ═══════════════════════════════════════════════════════════════════
const overlay = () => $('modal-overlay');

function closeModal() {
  const o = overlay();
  o.style.display = 'none';
  o.innerHTML = '';
}

function openModal(html) {
  const o = overlay();
  o.innerHTML = html;
  o.style.display = 'flex';
  o.addEventListener('click', e => { if (e.target === o) closeModal(); }, { once: true });
  o.querySelector('.modal-close-btn')?.addEventListener('click', closeModal);
}

// ── Add Peer ──────────────────────────────────────────────────────
function openAddPeerModal() {
  const myIps   = S.myInfo?.localIps || [];
  const myPort  = S.myInfo?.port     || 42069;
  const extIp   = S.myInfo?.externalIp;
  const upnpPort = S.myInfo?.upnpPort;

  // Build "my addresses" block so the user can copy & share
  const myAddrs = [];
  if (extIp && upnpPort)
    myAddrs.push({ label: 'External (UPnP)', value: `${extIp}:${upnpPort}`, accent: true });
  myIps.forEach(ip =>
    myAddrs.push({ label: 'LAN', value: `${ip}:${myPort}`, accent: false })
  );

  const addrRows = myAddrs.map(a => `
    <div class="addr-copy-row${a.accent ? ' accent' : ''}" data-addr="${esc(a.value)}">
      <span class="addr-label">${esc(a.label)}</span>
      <span class="addr-value">${esc(a.value)}</span>
      <button class="copy-btn" title="Copy">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
      </button>
    </div>`).join('');

  openModal(`
    <div class="modal">
      <div class="modal-hdr">
        <h2>Add Peer</h2>
        <button class="modal-close-btn">✕</button>
      </div>
      <div class="modal-body">
        ${myAddrs.length ? `
        <div class="my-addrs-block">
          <div class="my-addrs-title">Your address (share with peer)</div>
          ${addrRows}
        </div>` : ''}
        <p class="modal-desc" style="margin-top:${myAddrs.length ? 14 : 0}px">
          Enter a peer's address as <code>ip:port</code> — port defaults to 42069 if omitted.
        </p>
        <div class="field">
          <label>Peer Address</label>
          <input type="text" id="m-addr" placeholder="1.2.3.4:42069 or 192.168.1.5"
                 autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="off"/>
        </div>
        <div id="m-err" class="error-msg" style="display:none"></div>
      </div>
      <div class="modal-ftr">
        <button class="btn-secondary" id="m-cancel">Cancel</button>
        <button class="btn-primary"   id="m-connect">Connect</button>
      </div>
    </div>`);

  // Wire copy buttons
  overlay().querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const addr = btn.closest('.addr-copy-row').dataset.addr;
      navigator.clipboard.writeText(addr).then(() => {
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`;
        setTimeout(() => {
          btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
        }, 1500);
      });
    });
  });

  $('m-cancel').addEventListener('click', closeModal);
  $('m-addr').focus();

  const go = async () => {
    const raw   = ($('m-addr').value || '').trim();
    const errEl = $('m-err');
    errEl.style.display = 'none';

    if (!raw) {
      errEl.textContent   = 'Please enter a peer address.';
      errEl.style.display = 'block';
      return;
    }

    // Parse  ip:port  or just  ip
    let ip, port;
    const lastColon = raw.lastIndexOf(':');
    if (lastColon > 0) {
      ip   = raw.slice(0, lastColon).trim();
      port = raw.slice(lastColon + 1).trim();
    } else {
      ip   = raw;
      port = '42069';
    }

    const portNum = parseInt(port, 10);
    if (!ip || isNaN(portNum) || portNum < 1 || portNum > 65535) {
      errEl.textContent   = 'Invalid address — use  ip:port  or just  ip.';
      errEl.style.display = 'block';
      return;
    }

    const btn = $('m-connect');
    btn.textContent = 'Connecting…';
    btn.disabled    = true;

    const res = await window.edge.addPeer(ip, portNum);
    if (res.success) {
      closeModal();
    } else {
      errEl.textContent   = 'Failed: ' + (res.error || 'Unknown error');
      errEl.style.display = 'block';
      btn.textContent = 'Connect';
      btn.disabled    = false;
    }
  };

  $('m-connect').addEventListener('click', go);
  $('m-addr').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

// ── My Info ───────────────────────────────────────────────────────
function openMyInfoModal() {
  if (!S.myInfo) return;
  const { id, port, upnpPort, externalIp, localIps } = S.myInfo;
  const name = S.settings.displayName || S.myInfo.name;

  const connectAddr = upnpPort
    ? `<span class="info-value mono accent">${esc(externalIp || '?')}:${upnpPort}</span>`
    : `<span class="info-value mono">${esc(localIps?.[0] || '?')}:${port} (LAN only)</span>`;

  openModal(`
    <div class="modal">
      <div class="modal-hdr"><h2>My Connection Info</h2><button class="modal-close-btn">✕</button></div>
      <div class="modal-body">
        <div class="info-grid">
          <div class="info-row"><span class="info-label">Name</span><span class="info-value">${esc(name)}</span></div>
          <div class="info-row"><span class="info-label">Node ID</span><span class="info-value mono">${esc(id)}</span></div>
          <div class="info-row"><span class="info-label">Local IPs</span><span class="info-value mono">${esc((localIps||[]).join(', ')||'none')}</span></div>
          <div class="info-row"><span class="info-label">Port</span><span class="info-value mono">${port}</span></div>
          <div class="info-row"><span class="info-label">UPnP</span>
            ${upnpPort ? `<span class="info-value mono accent">Active — port ${upnpPort}</span>` : `<span class="info-value" style="color:var(--text-3)">Not available</span>`}
          </div>
          ${externalIp ? `<div class="info-row"><span class="info-label">External IP</span><span class="info-value mono accent">${esc(externalIp)}</span></div>` : ''}
        </div>
        <div class="share-hint">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><circle cx="12" cy="8" r="0.5" fill="currentColor"/>
          </svg>
          Share your address with peers:&nbsp;${connectAddr}
        </div>
      </div>
      <div class="modal-ftr"><button class="btn-primary" id="m-done">Done</button></div>
    </div>`);
  $('m-done').addEventListener('click', closeModal);
}


// ═══════════════════════════════════════════════════════════════════
// SETTINGS PANEL
// ═══════════════════════════════════════════════════════════════════
function openSettings() {
  S.settingsDraft = { ...S.settings };
  renderSettingsPanel();
  $('settings-panel').classList.add('open');
  $('settings-backdrop').classList.add('open');
}

function closeSettings() {
  $('settings-panel').classList.remove('open');
  $('settings-backdrop').classList.remove('open');
}

function renderSettingsPanel() {
  const panel = $('settings-inner');
  panel.innerHTML = `
    <div class="sp-hdr">
      <h2>Settings</h2>
      <button class="sp-close" id="sp-close-btn">✕</button>
    </div>
    <div class="sp-tabs">
      <button class="sp-tab${S.settingsTab==='profile'  ? ' active':''}" data-tab="profile">Profile</button>
      <button class="sp-tab${S.settingsTab==='files'    ? ' active':''}" data-tab="files">Files</button>
      <button class="sp-tab${S.settingsTab==='themes'   ? ' active':''}" data-tab="themes">Themes</button>
    </div>
    <div class="sp-body" id="sp-body">
      ${renderSettingsTab()}
    </div>
    <div class="sp-footer">
      <button class="btn-primary" id="sp-save-btn">Save Changes</button>
    </div>`;

  $('sp-close-btn').addEventListener('click', closeSettings);

  panel.querySelectorAll('.sp-tab').forEach(tab =>
    tab.addEventListener('click', () => {
      S.settingsTab = tab.dataset.tab;
      renderSettingsPanel();
    })
  );

  $('sp-save-btn').addEventListener('click', saveSettings);

  // Tab-specific wiring
  if (S.settingsTab === 'profile') wireProfileTab();
  if (S.settingsTab === 'files')   wireFilesTab();
  if (S.settingsTab === 'themes')  wireThemesTab();
}

function renderSettingsTab() {
  if (S.settingsTab === 'profile') return renderProfileTab();
  if (S.settingsTab === 'files')   return renderFilesTab();
  if (S.settingsTab === 'themes')  return renderThemesTab();
  return '';
}

// ── Profile Tab ───────────────────────────────────────────────────
function renderProfileTab() {
  const name = S.settingsDraft.displayName || '';
  const pic  = S.settingsDraft.profilePic;
  const id   = S.myInfo?.id || 'unknown';
  const col  = peerColor(id);

  const avatarInner = pic
    ? `<img src="${esc(pic)}" alt="Profile"/>
       <div class="profile-avatar-overlay">
         <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
       </div>`
    : `<span>${esc(initials(name || 'Me'))}</span>
       <div class="profile-avatar-overlay">
         <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
       </div>`;

  return `
    <div class="sp-section">
      <div class="sp-section-title">Profile Picture</div>
      <div class="profile-avatar-row">
        <div class="profile-avatar-large" id="sp-avatar-click" style="background:${col}">${avatarInner}</div>
        <div class="profile-avatar-actions">
          <button class="btn-outline-sm" id="sp-pick-pic">Choose Photo</button>
          ${pic ? `<button class="btn-outline-sm danger" id="sp-clear-pic">Remove</button>` : ''}
        </div>
      </div>
    </div>
    <div class="sp-section">
      <div class="sp-section-title">Display Name</div>
      <label class="sp-input-label" for="sp-name">Name shown to peers</label>
      <input class="sp-input" type="text" id="sp-name" value="${esc(name)}" placeholder="${esc(S.myInfo?.name || 'Your Name')}" maxlength="32"/>
    </div>
    <div class="sp-section">
      <div class="sp-section-title">Node Identity</div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-3);word-break:break-all;padding:10px;background:var(--bg-input);border-radius:8px;border:1px solid var(--border)">${esc(id)}</div>
    </div>`;
}

function wireProfileTab() {
  $('sp-avatar-click')?.addEventListener('click', async () => {
    const result = await window.edge.pickProfilePic();
    if (result.success) {
      S.settingsDraft.profilePic = result.dataUrl;
      renderSettingsPanel();
    }
  });

  $('sp-pick-pic')?.addEventListener('click', async () => {
    const result = await window.edge.pickProfilePic();
    if (result.success) {
      S.settingsDraft.profilePic = result.dataUrl;
      renderSettingsPanel();
    }
  });

  $('sp-clear-pic')?.addEventListener('click', async () => {
    await window.edge.clearProfilePic();
    S.settingsDraft.profilePic = null;
    renderSettingsPanel();
  });

  $('sp-name')?.addEventListener('input', e => {
    S.settingsDraft.displayName = e.target.value;
  });
}

// ── Files Tab ─────────────────────────────────────────────────────
const FILE_MODES = [
  { id: 'ask',             label: 'Ask every time',      desc: 'A dialog will appear for each incoming file — accept or decline.' },
  { id: 'auto-downloads',  label: 'Auto-save to Downloads', desc: 'Incoming files are saved automatically to your Downloads folder.' },
  { id: 'auto-choose',     label: 'Auto-accept, choose location', desc: 'Files are accepted automatically and you pick where to save them.' },
];

function renderFilesTab() {
  const current = S.settingsDraft.fileMode || 'ask';
  const opts = FILE_MODES.map(m => `
    <label class="radio-option${current === m.id ? ' selected' : ''}" data-mode="${m.id}">
      <input type="radio" name="filemode" value="${m.id}" ${current === m.id ? 'checked' : ''}/>
      <div class="radio-dot"></div>
      <div class="radio-text">
        <div class="radio-label">${esc(m.label)}</div>
        <div class="radio-desc">${esc(m.desc)}</div>
      </div>
    </label>`).join('');

  return `
    <div class="sp-section">
      <div class="sp-section-title">Incoming Files</div>
      <div class="radio-group">${opts}</div>
    </div>`;
}

function wireFilesTab() {
  document.querySelectorAll('.radio-option').forEach(opt => {
    opt.addEventListener('click', () => {
      S.settingsDraft.fileMode = opt.dataset.mode;
      document.querySelectorAll('.radio-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
    });
  });
}

// ── Themes Tab ────────────────────────────────────────────────────
function renderThemesTab() {
  const current = S.settingsDraft.theme || 'ocean';
  const cards = THEMES.map(t => `
    <div class="theme-card${current === t.id ? ' active' : ''}" data-theme="${t.id}">
      <div class="theme-swatch" style="background:linear-gradient(135deg, ${t.bg} 0%, ${t.color} 100%)"></div>
      <div class="theme-name">${esc(t.label)}</div>
    </div>`).join('');

  return `
    <div class="sp-section">
      <div class="sp-section-title">Color Theme</div>
      <div class="theme-grid">${cards}</div>
    </div>`;
}

function wireThemesTab() {
  document.querySelectorAll('.theme-card').forEach(card => {
    card.addEventListener('click', () => {
      S.settingsDraft.theme = card.dataset.theme;
      applyTheme(card.dataset.theme); // live preview
      document.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
    });
  });
}

// ── Save settings ─────────────────────────────────────────────────
async function saveSettings() {
  S.settings = { ...S.settingsDraft };
  await window.edge.saveSettings(S.settings);
  applyTheme(S.settings.theme);
  renderMyInfo();
  showToast('Settings saved');
  closeSettings();
}

// ═══════════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════════
async function init() {
  // Window controls
  $('btn-minimize').addEventListener('click', () => window.edge.minimize());
  $('btn-maximize').addEventListener('click', () => window.edge.maximize());
  $('btn-close').addEventListener('click',    () => window.edge.close());

  // Lightbox
  $('lb-close').addEventListener('click', closeLightbox);
  $('lightbox').addEventListener('click', e => { if (e.target === $('lightbox')) closeLightbox(); });

  // Sidebar actions
  $('add-peer-btn').addEventListener('click', openAddPeerModal);
  $('settings-btn').addEventListener('click', openSettings);
  $('settings-backdrop').addEventListener('click', closeSettings);

  // Input
  const input = $('msg-input');
  input.addEventListener('input',   () => autoGrow(input));
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
  $('send-btn').addEventListener('click', sendMessage);
  $('attach-btn').addEventListener('click', () => { if (S.active) sendFile(S.active); });
  $('folder-btn')?.addEventListener('click', () => { if (S.active) sendFolder(S.active); });
  $('emoji-btn').addEventListener('click',  e => { e.stopPropagation(); toggleEmojiPicker(); });

  // Drag and drop onto the chat panel
  const chatEl = $('chat');
  let dragCounter = 0;

  // Track drag at document level so entering any child still counts
  document.addEventListener('dragenter', e => {
    e.preventDefault();
    dragCounter++;
    if (S.active && chatEl.contains(e.target)) {
      chatEl.classList.add('drag-over');
    }
  });
  document.addEventListener('dragleave', e => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      chatEl.classList.remove('drag-over');
    }
  });
  document.addEventListener('dragover', e => {
    // Must preventDefault to allow drop
    if (chatEl.contains(e.target)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = S.active ? 'copy' : 'none';
    }
  });
  document.addEventListener('drop', e => {
    dragCounter = 0;
    chatEl.classList.remove('drag-over');
    if (!chatEl.contains(e.target) || !S.active) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      (async () => {
        for (const f of files) {
          const filePath = f.path || f.webkitRelativePath || null;
          if (!filePath) continue;
          // Ask main process whether this path is a directory
          const isDir = await window.edge.isDirectory(filePath);
          if (isDir) {
            await window.edge.pickAndSendFolderPath(S.active, filePath);
          } else {
            await window.edge.pickAndSendFilePath(S.active, filePath);
          }
        }
      })();
    }
  });

  setupEvents();

  // Load settings first so theme applies before other renders
  try {
    const s = await window.edge.getSettings();
    S.settings = { ...S.settings, ...s };
    applyTheme(S.settings.theme);
  } catch (e) { console.error('getSettings failed:', e); }

  try {
    S.myInfo = await window.edge.getMyInfo();
    if (S.myInfo.displayName) S.settings.displayName = S.myInfo.displayName;
    if (S.myInfo.profilePic)  S.settings.profilePic  = S.myInfo.profilePic;
    renderMyInfo();
    // UPnP race fix: getMyInfo already contains upnpPort/externalIp once
    // UPnP has completed. If upnp-status fired before our listener was
    // registered (S.upnp is still null), synthesise the state from myInfo
    // so the pill doesn't stay gray indefinitely.
    if (!S.upnp && S.myInfo.upnpPort) {
      S.upnp = { success: true, port: S.myInfo.upnpPort, ip: S.myInfo.externalIp };
    } else if (!S.upnp && S.myInfo.upnpPort === null && S.myInfo.upnpAttempted) {
      // UPnP was tried but failed — show the failure state
      S.upnp = { success: false, reason: 'UPnP not available' };
    }
  } catch (e) { console.error('getMyInfo failed:', e); }

  try {
    const peers = await window.edge.getPeers();
    peers.forEach(p => {
      const ex = S.peers.get(p.id);
      if (ex) {
        // Merge — preserve fingerprint if the existing one is better
        ex.connected = p.connected;
        ex.ip = p.ip;
        ex.lan = p.lan;
        if (p.profilePic !== undefined) ex.profilePic = p.profilePic;
        if (p.fingerprint) ex.fingerprint = p.fingerprint;
        // Sync messages/files from network layer (source of truth)
        ex.messages = p.messages;
        ex.files = p.files;
      } else {
        S.peers.set(p.id, p);
      }
    });
  } catch (e) { console.error('getPeers failed:', e); }

  renderUpnpPill();
  renderPeerList();
  renderChatPanel();

  // Short delay re-render to catch any fingerprint that arrived mid-init
  setTimeout(() => {
    const peer = S.peers.get(S.active);
    if (peer) renderChatHeader(peer);
  }, 800);

  // Fetch NIC speed and re-check every 10s (catches link speed changes like 1Gbps → 100Mbps)
  async function refreshNicSpeed() {
    try {
      const result = await window.edge.getNicSpeed();
      S.nicSpeed = result;
      // Re-render header if a peer is active so the NIC badge updates
      const peer = S.peers.get(S.active);
      if (peer) renderChatHeader(peer);
    } catch (_) {}
  }
  refreshNicSpeed();
  setInterval(refreshNicSpeed, 10_000);
}

document.addEventListener('DOMContentLoaded', init);
