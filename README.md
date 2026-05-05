# ⚡ Edge


<p >
<strong>Decentralized, encrypted peer-to-peer messaging + file transfer over LAN & Internet.</strong>
<br>When someone needs a file,
just <strong>edge it to them.</strong>
</p>

# 🚀 What is Edge?

Edge is a modern desktop file transfer/messaging application built with:

-   Electron
-   Node.js
-   WebTorrent(soon!)

The name was inspired by **edge routers** which are "located at the boundary of a network (the "edge") that connects an internal Local Area Network (LAN) to external networks". Also partly inspired by **edge computing**, the antithesis of our current cloud based infrastructure - where computing is done on **your** device. Edge combines both ideas, putting control and power directly into your hands - and those of your peers - across any network. 


### ✨ Features

-   ⚡ Extremely fast LAN transfers & chat
-   🌍 Direct WAN peer-to-peer transfers
-   📥 No file size cap
-   📁 Transfer folders super fast without compressing them (Leverages USTAR to stream folders, averaged 60MB/s for an ~8500 file folder)
-   🎨 Customizable themes
-   🔥 Edge Streak system


# 🧠 Core Philosophy

Edge is designed to be:

-   **Direct** -- No cloud middleman required, especially for LAN. 
-   **Efficient** -- No unnecessary hops, looking for usb drives or even compressing folders before sending.
-   **Simple to navigate & use**

If someone needs a file:

> **Just edge it to them.**


# 🌐 Transport Modes
## ⚡ LAN Mode

-   Automatic peer discovery
-   Zero configuration
-   Direct socket connection
-   Same-network optimized
-   Extremely fast (limited by LAN/disk bandwidth)



## 🌍 WAN Mode

-   Direct peer-to-peer transfers
-   At the moment requires one side to have UPnP or port 42069 forwarded
-   No persistent storage server
-   Elliptic Curve Diffie-Hellman key exchange + AES encryption


# 🔥 Edge Streak

An Edge Streak occurs when:

-   You send multiple files
-   The receiver sends nothing back
-   The streak counter increments

Is it useful?\
**Yes. To see how many files were sent in total.**

Is it slightly competitive?\
**Also yes.**



# 📦 Installation

## Option 1 --- Download Binary

Prebuilt binaries are available in the Releases section:

-   Windows `.exe`
-   Linux `.AppImage` (requires FUSE)

Download, run, **edge**.


## Option 2 --- Build From Source

``` bash
git clone https://github.com/foooooooooooooooooooooooooootw/Edge.git
cd Edge
npm install
npm run build
```

Start without building:
``` bash
npm start
```

Start in development mode:

``` bash
npm run dev
```


# 🔐 Privacy

-   No central file storage
-   No telemetry at all
-   No hidden cloud fallback
-   Encryption built in (ECDH-AES)

**Edge does not upload your files anywhere**

> **We don't know when you Edge**



# 🗺 Roadmap (Possible features)

-   NAT traversal improvements especially if both sides dont have UPnP
-   Resume interrupted transfers
-   Transfer throttling


# 💬 Final Words

Edge exists because sending files shouldn't require:

-   Uploading to a random cloud
-   Waiting for indexing
-   Sharing public links
-   Paying for bandwidth twice
-   Having to abide by file size limits
-   Hunting for a thumbdrive whenever you want to transfer files between two computers that are side by side

Sometimes you just want to say:

> **"Just edge it to me."**
