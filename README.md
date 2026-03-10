# File Share App - Local Network P2P Transfer

A modern Electron app for peer-to-peer file sharing on your local network.

## Features

✨ **Current Features (Phase 1 - LAN)**
- Automatic peer discovery via UDP broadcast
- Real-time peer list updates
- Direct TCP file transfers
- Progress tracking
- Modern, responsive UI
- Drag & drop file support
- Multiple file transfers

🚀 **Coming Soon (Phase 2)**
- Internet transfers via BitTorrent protocol
- Private torrent support (no public trackers)
- Resume capability
- Chunked transfers

## Building Standalone Executables

To create an executable that doesn't require Node.js:

1. **First time only - install electron-builder**
   ```bash
   npm install --save-dev electron-builder
   ```

2. **Build for your platform**
   ```bash
   npm run build
   ```

This creates executables in the `dist` folder:
- **Windows**: `FileShare-Setup-1.0.0.exe` (installer) or `FileShare-1.0.0.exe` (portable)
- **Mac**: `FileShare-1.0.0.dmg`
- **Linux**: `FileShare-1.0.0.AppImage` or `.deb` package

The executables can be copied to other computers and run without installing Node.js!

**Note**: You can only build for your current OS. To build for Windows, you need to be on Windows, etc.

### Build Speed Optimizations

The app is configured with these optimizations:
- `compression: "store"` - No compression (much faster, slightly larger file)
- `asar: false` - Skip ASAR packaging (faster builds)

**To make builds even faster:**
- Close other programs (browser, IDE)
- Exclude `dist` and `node_modules` from antivirus scans
- Use an SSD if available

**First build**: 2-5 minutes (downloads Electron binaries)
**Subsequent builds**: 30-60 seconds

## Installation

1. **Install Node.js** (if you don't have it)
   - Download from https://nodejs.org/
   - Version 16 or higher recommended

2. **Install dependencies**
   ```bash
   cd file-share-app
   npm install
   ```

3. **Run the app**
   ```bash
   npm start
   ```

## How to Use

### Setting Your Name
1. Enter your name in the header
2. Click "Set Name" or press Enter
3. This name will appear to other peers on the network

### Sending Files
1. Wait for peers to appear in the left sidebar
2. Click on a peer to select them
3. Either:
   - Drag and drop files onto the drop zone
   - Click the drop zone to browse for files
4. Watch the transfer progress in the "Active Transfers" section

### Receiving Files
- Files are automatically saved to your Downloads folder
- You'll see a notification when a file is received

## How It Works

### Peer Discovery
- Each instance broadcasts a UDP packet every 3 seconds on port 45454
- Other instances receive these broadcasts and add peers to their list
- Peers are removed if they haven't been seen for 10 seconds

### File Transfer
- Direct TCP connection between peers on port 45455
- File metadata (name, size) is sent first
- File is streamed in chunks
- Progress updates in real-time

## Network Requirements

- All devices must be on the same local network (WiFi/Ethernet)
- Firewall may need to allow:
  - UDP port 45454 (broadcast)
  - TCP port 45455 (file transfer)

## Development

Run with developer tools:
```bash
npm run dev
```

## File Structure

```
file-share-app/
├── main.js              # Electron main process
├── preload.js           # Secure IPC bridge
├── network-manager.js   # Network logic (broadcast, TCP)
├── index.html           # UI structure
├── styles.css           # Modern styling
├── renderer.js          # UI logic
└── package.json         # Dependencies
```

## Next Steps (Phase 2)

When you're ready, we'll add:
1. WebTorrent integration for internet transfers
2. Private peer discovery (no public trackers)
3. Magnet link generation
4. Resume capability
5. Chunked verification

## Troubleshooting

**No peers showing up?**
- Make sure all devices are on the same network
- Check firewall settings
- Try running as administrator (Windows) or with sudo (macOS/Linux)

**Transfer failing?**
- Check if antivirus is blocking the connection
- Ensure port 45455 is not in use by another app

**Slow transfers?**
- This is normal for large files on WiFi
- For best speed, use wired ethernet connection

## License

MIT
