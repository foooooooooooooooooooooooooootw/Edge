'use strict';

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

// ── Defaults ─────────────────────────────────────────────────────────────────
const DEFAULTS = {
  nodeId:      null,   // generated once on first run, never changes
  displayName: os.hostname(),
  profilePic:  null,
  theme:       'ocean',
  fileMode:    'ask',  // 'ask' | 'auto-downloads' | 'auto-choose'
};

class SettingsManager {
  constructor(userDataPath) {
    this._file = path.join(userDataPath, 'edge-settings.json');
    this._data = { ...DEFAULTS };
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this._file)) {
        const raw = JSON.parse(fs.readFileSync(this._file, 'utf8'));
        this._data = { ...DEFAULTS, ...raw };
      }
    } catch (_) {
      this._data = { ...DEFAULTS };
    }
    // Generate and persist nodeId on very first run
    if (!this._data.nodeId) {
      this._data.nodeId = crypto.randomBytes(6).toString('hex');
      this._save();
    }
  }

  _save() {
    try {
      fs.writeFileSync(this._file, JSON.stringify(this._data, null, 2), 'utf8');
    } catch (e) {
      console.error('[Settings] Save failed:', e.message);
    }
  }

  get(key)        { return key ? this._data[key] : { ...this._data }; }
  getAll()        { return { ...this._data }; }

  set(key, value) {
    this._data[key] = value;
    this._save();
  }

  update(patch) {
    Object.assign(this._data, patch);
    this._save();
  }
}

module.exports = { SettingsManager };
