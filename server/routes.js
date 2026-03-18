'use strict';

const express    = require('express');
const fs         = require('fs');
const path       = require('path');
const mqttModule = require('./mqtt');

/**
 * Factory function — returns an Express Router.
 *
 * @param {object}   config      - Full config object
 * @param {object}   state       - State module
 * @param {object}   persistence - Persistence module
 * @param {function} broadcast   - Broadcast function(message) → sends to all WS clients
 */
function createRouter(config, state, persistence, broadcast) {
  const router  = express.Router();
  const dataDir = config.paths.dataDir;
  const audioDir = config.paths.audioDir;

  // -------------------------------------------------------------------------
  // GET /api/state
  // -------------------------------------------------------------------------
  router.get('/state', (req, res) => {
    res.json(state.getState());
  });

  // -------------------------------------------------------------------------
  // GET /api/audio — list .wav files in audioDir, fall back to known list
  // -------------------------------------------------------------------------
  const FALLBACK_AUDIO = [
    'chime01.wav','chime02.wav','chime03.wav','clock.wav','doorbell.wav',
    'dtr.wav','farfrom.wav','oc-bil.wav','ocean.wav','oc-eng.wav',
    'oc-fra.wav','oc-orc.wav','royal.wav','royer.wav','startme.wav','stereo.wav',
  ];

  router.get('/audio', (req, res) => {
    try {
      let files = [];
      if (fs.existsSync(audioDir)) {
        files = fs.readdirSync(audioDir)
          .filter(f => f.toLowerCase().endsWith('.wav'))
          .sort();
      }
      if (files.length === 0) files = FALLBACK_AUDIO;
      res.json({ files });
    } catch (err) {
      const ts = new Date().toISOString();
      console.error(`[${ts}] [ROUTES] Failed to list audio files:`, err.message);
      res.json({ files: FALLBACK_AUDIO });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/presets — add or replace a preset
  // -------------------------------------------------------------------------
  router.post('/presets', express.json(), (req, res) => {
    const { name, aud, vol, rpt, clr, pat, dur, brt } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const preset = {
      name: name.trim(),
      aud:  aud  ?? '',
      vol:  vol  ?? 0.5,
      rpt:  rpt  ?? 0,
      clr:  clr  ?? 'ffffff',
      pat:  pat  ?? 1,
      dur:  dur  ?? 10,
      brt:  brt  ?? 200,
    };
    const updated = state.addPreset(preset);
    persistence.savePresets(dataDir, updated);
    broadcast({ type: 'state', ...state.getState(), mqttOnline: true });
    res.json({ presets: updated });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/presets/:name
  // -------------------------------------------------------------------------
  router.delete('/presets/:name', (req, res) => {
    const name    = decodeURIComponent(req.params.name);
    const updated = state.deletePreset(name);
    persistence.savePresets(dataDir, updated);
    broadcast({ type: 'state', ...state.getState(), mqttOnline: true });
    res.json({ presets: updated });
  });

  // -------------------------------------------------------------------------
  // POST /api/scouts/reset-nodes — clears nodes, rebuilds from current scouts
  // -------------------------------------------------------------------------
  router.post('/scouts/reset-nodes', (req, res) => {
    const updatedNodes = state.resetNodes();
    persistence.saveNodes(dataDir, updatedNodes);
    broadcast({ type: 'nodeUpdate', nodes: updatedNodes });
    res.json({ nodes: updatedNodes });
  });

  // -------------------------------------------------------------------------
  // POST /api/scouts/flush-offline — remove offline scouts from state and
  // clear their retained messages from the MQTT broker
  // -------------------------------------------------------------------------
  router.post('/scouts/flush-offline', (req, res) => {
    const prefix      = config.mqtt.topicPrefix;
    const removedMacs = state.flushOfflineScouts();

    // Clear retained message on broker for each removed device
    removedMacs.forEach(mac => {
      mqttModule.clearRetained(`${prefix}/${mac}/$state`);
    });

    persistence.saveScouts(dataDir, state.getScouts());
    persistence.saveNodes(dataDir, state.getNodes());
    broadcast({ type: 'state', ...state.getState() });

    res.json({ removed: removedMacs });
  });

  return router;
}

module.exports = createRouter;
