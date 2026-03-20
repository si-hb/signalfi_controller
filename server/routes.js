'use strict';

const express    = require('express');
const fs         = require('fs');
const mqttModule = require('./mqtt');

/**
 * Factory function — returns an Express Router.
 *
 * @param {object}   config      - Full config object
 * @param {object}   state       - State module
 * @param {object}   persistence - Persistence module
 * @param {function} broadcast   - Broadcast function(message) → sends to all WS clients
 * @param {object}   [logStore]  - LogStore instance (optional)
 */
function createRouter(config, state, persistence, broadcast, logStore) {
  const router  = express.Router();
  const dataDir = config.paths.dataDir;
  const audioDir = config.paths.audioDir;

  // -------------------------------------------------------------------------
  // GET /api/state
  // -------------------------------------------------------------------------
  router.get('/state', (_req, res) => {
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

  router.get('/audio', (_req, res) => {
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
  router.post('/scouts/reset-nodes', (_req, res) => {
    const updatedNodes = state.resetNodes();
    persistence.saveNodes(dataDir, updatedNodes);
    broadcast({ type: 'nodeUpdate', nodes: updatedNodes });
    res.json({ nodes: updatedNodes });
  });

  // -------------------------------------------------------------------------
  // POST /api/scouts/flush-offline — remove offline scouts from state and
  // clear their retained messages from the MQTT broker
  // -------------------------------------------------------------------------
  router.post('/scouts/flush-offline', (_req, res) => {
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

  // -------------------------------------------------------------------------
  // GET /api/log — query the event log
  // Query params:
  //   mac        — MAC substring filter
  //   node       — node path substring filter
  //   direction  — comma-separated: rx,tx,sys
  //   category   — comma-separated: mqtt,server,client
  //   sort       — asc | desc (default desc)
  //   limit      — max rows (default 200, capped at 500)
  //   offset     — rows to skip (default 0)
  // -------------------------------------------------------------------------
  router.get('/log', (req, res) => {
    if (!logStore) return res.json({ entries: [] });

    const mac        = req.query.mac  || null;
    const node       = req.query.node || null;
    const directions = req.query.direction ? req.query.direction.split(',').filter(Boolean) : null;
    const categories = req.query.category  ? req.query.category.split(',').filter(Boolean)  : null;
    const sort       = req.query.sort === 'asc' ? 'asc' : 'desc';
    const limit      = req.query.limit  ? parseInt(req.query.limit,  10) : 200;
    const offset     = req.query.offset ? parseInt(req.query.offset, 10) : 0;
    const from       = req.query.from   ? parseInt(req.query.from,   10) : null;
    const to         = req.query.to     ? parseInt(req.query.to,     10) : null;

    try {
      res.set('Cache-Control', 'no-store');
      const entries = logStore.query({ mac, node, directions, categories, sort, limit, offset, from, to });
      res.json({ entries });
    } catch (err) {
      const ts = new Date().toISOString();
      console.error(`[${ts}] [ROUTES] Log query error:`, err.message);
      res.status(500).json({ error: 'Log query failed', entries: [] });
    }
  });


  return router;
}

module.exports = createRouter;
