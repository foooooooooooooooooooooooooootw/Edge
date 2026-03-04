# WAN Mode Architecture - No Mandatory Third Party!

## Connection Methods (in priority order)

### 1. Magnet Links (RECOMMENDED) ✅ No third party
**How it works:**
- File → Create torrent → Generate magnet link
- Share magnet link with recipient
- Recipient adds magnet → Connects via DHT
- Direct P2P transfer via BitTorrent protocol

**Pros:**
- No central server needed
- DHT is distributed (thousands of servers worldwide)
- Very resilient
- Works through most NATs
- Resume support built-in

**Cons:**
- Slower initial connection (DHT discovery ~10-30 seconds)
- Requires both parties to have ports open OR use DHT hole-punching

**Implementation:**
```javascript
// Sender
const { magnetLink } = await wanManager.createMagnetLink(filePath);
// Share magnetLink

// Receiver
await wanManager.downloadFromMagnet(magnetLink, savePath);
```

### 2. Direct IP Connection ✅ No third party
**How it works:**
- Sender starts TCP server on port 45456
- Sender shares their public IP + port
- Receiver connects directly

**Pros:**
- Fastest method
- No third party at all
- Full control

**Cons:**
- Requires port forwarding OR VPN
- Sender must know their public IP
- Only works if NAT allows incoming connections

**Workaround:**
- Use Tailscale/Zerotier (free VPN - easy setup)
- Or use UPnP for automatic port forwarding

**Implementation:**
```javascript
// Sender
await wanManager.startDirectServer();
const ip = await wanManager.getPublicIP();
// Share `${ip}:45456`

// Receiver  
await wanManager.connectToDirectIP(ip, port, savePath);
```

### 3. Room Code + WebRTC ⚠️ Needs signaling server (fallback only)
**How it works:**
- Generate 6-character room code
- Both parties connect to signaling server
- Exchange WebRTC connection info
- Direct P2P transfer via WebRTC

**Pros:**
- Works through most NATs (STUN/TURN)
- User-friendly (short code)

**Cons:**
- Requires signaling server for initial handshake
- If our server is down, method fails
- Could use PeerJS (free) but still third-party dependency

**When to use:**
- Last resort if magnet links and direct IP both fail
- Good UX for non-technical users

## Recommended User Flow

```
User drops file → App tries to generate:

1. Magnet Link (always works, show first)
2. Direct IP (show if port is open)
3. Room Code (show as backup option)

User shares whatever method works best for their situation
```

## Network Requirements

| Method | Sender Needs | Receiver Needs | Third Party |
|--------|--------------|----------------|-------------|
| Magnet | Outgoing connections | Outgoing connections | DHT only (distributed) |
| Direct IP | Port forwarded OR VPN | Just internet | None |
| Room Code | Just internet | Just internet | Signaling server |

## Security

**Magnet Links:**
- Torrent is temporary (not indexed publicly)
- Magnet link is the only way to find it
- Use infohash as verification

**Direct IP:**
- Sender's IP is exposed
- No encryption by default (could add TLS)
- Port must be open (security risk if misconfigured)

**Room Code:**
- WebRTC has built-in encryption (DTLS)
- Signaling server only sees metadata
- Most secure option

## File Size Limits

- **Magnet Links:** No limit (BitTorrent protocol)
- **Direct IP:** No limit (TCP socket)
- **Room Code:** Depends on browser (WebRTC data channels have limits)

## Implementation Status

✅ Magnet link generation
✅ Direct IP server
✅ Multi-method UI
🔄 Magnet download (in progress)
🔄 Direct IP client (in progress)
⏳ Room code/WebRTC (optional fallback)

## Next Steps

1. Wire up WAN manager to IPC
2. Implement file receiving logic
3. Add progress tracking to UI
4. Test on real internet connections
5. Add WebRTC signaling as fallback (optional)

## Alternative: Make Everything Torrent-Based

We could simplify to ONLY use magnet links:
- One code path instead of three
- Very reliable (DHT is proven)
- No IP exposure
- Works for both WAN and Torrents mode

Thoughts?
