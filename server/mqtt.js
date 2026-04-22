'use strict';

const mqttLib = require('mqtt');
const fs      = require('fs');

let client    = null;
let _publish  = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Connect to MQTT broker.
 *
 * @param {object}   config            - MQTT config block from loadConfig()
 * @param {function} onMessage         - Called as onMessage(mac, topic, parsedPayload)
 * @param {function} onStatus          - Called as onStatus('connected'|'reconnecting'|'disconnected')
 * @param {function} [onServerCommand] - Optional. Called as onServerCommand(parsedPayload)
 *                                       when a message arrives on ${prefix}/$server/cmd —
 *                                       the bridge node-red (and other server-side
 *                                       publishers) use to inject commands that then flow
 *                                       through the same handleCommand() pipeline as the
 *                                       WebSocket UI. No MAC is passed because these
 *                                       messages aren't tied to a single device.
 */
function connect(config, onMessage, onStatus, onServerCommand) {
  const prefix = config.topicPrefix || 'scout';

  // Build connect options
  const opts = {
    clientId:         config.clientId,
    clean:            true,
    reconnectPeriod:  5000,
    connectTimeout:   30000,
    keepalive:        60,
  };

  if (config.username) opts.username = config.username;
  if (config.password) opts.password = config.password;

  if (config.tls) {
    opts.protocol = 'mqtts';
    if (config.caCert)     opts.ca   = fs.readFileSync(config.caCert);
    if (config.clientCert) opts.cert = fs.readFileSync(config.clientCert);
    if (config.clientKey)  opts.key  = fs.readFileSync(config.clientKey);
  } else {
    opts.protocol = 'mqtt';
  }

  const brokerUrl = `${opts.protocol}://${config.host}:${config.port}`;
  const ts = () => new Date().toISOString();

  console.log(`[${ts()}] [MQTT] Connecting to ${brokerUrl} as ${opts.clientId}`);

  client = mqttLib.connect(brokerUrl, opts);

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  client.on('connect', () => {
    console.log(`[${ts()}] [MQTT] Connected to ${brokerUrl}`);
    onStatus('connected');

    // Subscribe to state and message topics, plus the server-command topic
    // used by node-red (and any other in-stack publisher) to inject commands
    // into handleCommand().  $server is a reserved literal like $broadcast
    // and $group — MAC-based device topics can never collide with it.
    const stateTopic  = `${prefix}/+/$state`;
    const msgTopic    = `${prefix}/+/$msg`;
    const serverTopic = `${prefix}/$server/cmd`;

    client.subscribe([stateTopic, msgTopic, serverTopic], { qos: 0 }, (err) => {
      if (err) {
        console.error(`[${ts()}] [MQTT] Subscribe error:`, err.message);
      } else {
        console.log(`[${ts()}] [MQTT] Subscribed to ${stateTopic}, ${msgTopic}, ${serverTopic}`);
      }
    });

    // Request current state from all devices
    const getPayload = JSON.stringify({ act: 'get' });
    client.publish(`${prefix}/$broadcast/$action`, getPayload, { qos: 0 }, (err) => {
      if (err) {
        console.error(`[${ts()}] [MQTT] Failed to publish get broadcast:`, err.message);
      } else {
        console.log(`[${ts()}] [MQTT] Published {"act":"get"} to ${prefix}/$broadcast/$action`);
      }
    });
  });

  client.on('reconnect', () => {
    console.log(`[${ts()}] [MQTT] Reconnecting...`);
    onStatus('reconnecting');
  });

  client.on('offline', () => {
    console.log(`[${ts()}] [MQTT] Client offline`);
    onStatus('disconnected');
  });

  client.on('close', () => {
    console.log(`[${ts()}] [MQTT] Connection closed`);
    onStatus('disconnected');
  });

  client.on('error', (err) => {
    console.error(`[${ts()}] [MQTT] Error:`, err.message);
    // Do not crash — mqtt.js will attempt to reconnect
  });

  client.on('message', (topic, messageBuffer) => {
    // Ignore empty payloads — these are broker acknowledgements of retained
    // message clears (published with retain=true and empty body) bouncing back.
    if (!messageBuffer || messageBuffer.length === 0) return;

    let payload;
    try {
      payload = JSON.parse(messageBuffer.toString());
    } catch {
      // Non-JSON message; treat as raw string
      payload = messageBuffer.toString();
    }

    // Extract MAC from topic: scout/<MAC>/$state  or  scout/<MAC>/$msg
    const segments = topic.split('/');
    if (segments.length < 3) return;

    // Server-command topic: scout/$server/cmd — hand off to the dedicated
    // callback instead of the MAC-based onMessage path.  These messages
    // aren't tied to a single device; they carry a command intended for
    // handleCommand() (e.g. node-red triggering an announcePreset).
    if (segments[1] === '$server' && segments[2] === 'cmd') {
      if (typeof onServerCommand === 'function') onServerCommand(payload);
      return;
    }

    const mac = segments[1];
    onMessage(mac, topic, payload);
  });

  // Expose a bound publish helper
  _publish = (topic, payloadObj, opts = {}) => {
    if (!client || !client.connected) {
      console.warn(`[${ts()}] [MQTT] Cannot publish — not connected (topic: ${topic})`);
      return;
    }
    const raw = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
    const publishOpts = { qos: 0, retain: !!opts.retain };
    client.publish(topic, raw, publishOpts, (err) => {
      if (err) {
        console.error(`[${ts()}] [MQTT] Publish error on ${topic}:`, err.message);
      }
    });
  };
}

/**
 * Publish a message to the broker.
 *
 * @param {string}        topic
 * @param {object|string} payload
 * @param {object}        [opts]        - optional publish options
 * @param {boolean}       [opts.retain] - set retain flag on the broker
 */
function publish(topic, payload, opts) {
  if (!_publish) {
    const ts = new Date().toISOString();
    console.warn(`[${ts}] [MQTT] publish() called before connect()`);
    return;
  }
  _publish(topic, payload, opts);
}

/**
 * Clear a retained message on the broker by publishing an empty payload
 * with retain=true to the same topic.
 *
 * @param {string} topic
 */
function clearRetained(topic) {
  if (!client || !client.connected) {
    const ts = new Date().toISOString();
    console.warn(`[${ts}] [MQTT] clearRetained() called while not connected (topic: ${topic})`);
    return;
  }
  const ts = new Date().toISOString();
  console.log(`[${ts}] [MQTT] Clearing retained message on ${topic}`);
  client.publish(topic, '', { retain: true, qos: 0 });
}

module.exports = { connect, publish, clearRetained };
