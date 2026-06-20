#!/usr/bin/env node
/**
 * NoobClaw Native Messaging Host
 * Bridge between Chrome extension (stdin/stdout) and Electron app (TCP localhost)
 */
const net = require('net');

const ELECTRON_PORT = 12581; // TCP port for Electron bridge (NOT the old WebSocket 12580)

let tcpSocket = null;
let connected = false;

// --- Native Messaging Protocol (stdin/stdout, length-prefixed JSON) ---

function readNativeMessage(callback) {
  let buf = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const msgBuf = buf.slice(4, 4 + len);
      buf = buf.slice(4 + len);
      try {
        callback(JSON.parse(msgBuf.toString('utf8')));
      } catch (e) {
        // ignore parse errors
      }
    }
  });
}

function writeNativeMessage(msg) {
  const json = JSON.stringify(msg);
  const buf = Buffer.from(json, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(header);
  process.stdout.write(buf);
}

// --- TCP connection to Electron app ---

function connectToElectron() {
  tcpSocket = net.createConnection({ port: ELECTRON_PORT, host: '127.0.0.1' }, () => {
    connected = true;
    writeNativeMessage({ type: 'bridge_status', connected: true });
  });

  let recvBuf = '';
  tcpSocket.on('data', (data) => {
    recvBuf += data.toString('utf8');
    // Messages are newline-delimited JSON
    let newlineIdx;
    while ((newlineIdx = recvBuf.indexOf('\n')) >= 0) {
      const line = recvBuf.slice(0, newlineIdx);
      recvBuf = recvBuf.slice(newlineIdx + 1);
      if (line.trim()) {
        try {
          const msg = JSON.parse(line);
          writeNativeMessage(msg);
        } catch (e) {
          // ignore
        }
      }
    }
  });

  tcpSocket.on('close', () => {
    connected = false;
    writeNativeMessage({ type: 'bridge_status', connected: false });
    // Retry after 2s
    setTimeout(connectToElectron, 2000);
  });

  tcpSocket.on('error', () => {
    // Will trigger close
  });
}

// --- Forward messages from extension to Electron ---

readNativeMessage((msg) => {
  if (msg.type === 'ping') {
    writeNativeMessage({ type: 'pong' });
    return;
  }
  if (tcpSocket && connected) {
    tcpSocket.write(JSON.stringify(msg) + '\n');
  } else {
    // Not connected to Electron
    if (msg.id) {
      writeNativeMessage({ id: msg.id, success: false, error: 'NoobClaw desktop client is not running' });
    }
  }
});

// Start
connectToElectron();
