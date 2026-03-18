/**
 * WebSocket client for SignalFi Control
 * Uses a registered message handler to avoid circular imports with app.js
 */

let ws = null;
let retryDelay = 1000;
let commandQueue = [];
let isConnected = false;
let messageHandler = null;

export function registerMessageHandler(handler) {
  messageHandler = handler;
}

function getReconnectBanner() {
  return document.getElementById('reconnect-banner');
}

function showReconnectBanner() {
  const banner = getReconnectBanner();
  if (banner) banner.hidden = false;
  document.body.classList.add('ws-disconnected');
}

function hideReconnectBanner() {
  const banner = getReconnectBanner();
  if (banner) banner.hidden = true;
  document.body.classList.remove('ws-disconnected');
}

function flushQueue() {
  while (commandQueue.length > 0 && isConnected && ws && ws.readyState === WebSocket.OPEN) {
    const cmd = commandQueue.shift();
    try {
      ws.send(JSON.stringify(cmd));
    } catch (err) {
      console.error('WS send error:', err);
    }
  }
}

export function sendCommand(cmdObj) {
  if (isConnected && ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(cmdObj));
    } catch (err) {
      console.error('WS send error:', err);
      commandQueue.push(cmdObj);
    }
  } else {
    commandQueue.push(cmdObj);
  }
}

function dispatchMessage(msg) {
  if (messageHandler) {
    messageHandler(msg);
  }
}

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    isConnected = true;
    retryDelay = 1000;
    hideReconnectBanner();
    flushQueue();
    dispatchMessage({ type: 'mqttStatus', status: 'connected' });
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      dispatchMessage(msg);
    } catch (err) {
      console.error('WS message parse error:', err);
    }
  };

  ws.onclose = () => {
    isConnected = false;
    showReconnectBanner();
    dispatchMessage({ type: 'mqttStatus', status: 'reconnecting' });
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  };

  ws.onerror = (err) => {
    console.error('WS error:', err);
    // onclose will be called after onerror
  };
}

export function initWS() {
  connect();
}
