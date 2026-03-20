'use strict';

const MAX_MEMORY_ENTRIES = 5000;

/**
 * LogStore — SQLite-backed (with in-memory fallback) event log.
 *
 * Entry shape:
 *   { id, ts, direction, category, mac, topic, payload, node }
 *
 *   direction : 'rx'     — MQTT message received from a device
 *               'tx'     — MQTT message published by the server
 *               'sys'    — system / infrastructure event
 *
 *   category  : 'mqtt'   — MQTT data plane (rx/tx)
 *               'server' — server lifecycle or MQTT broker connection events
 *               'client' — browser/WS client connect/disconnect events
 */
class LogStore {
  constructor(dataDir) {
    this._entries  = [];   // in-memory fallback buffer
    this._nextId   = 1;
    this._db       = null;
    this._addStmt  = null;

    try {
      const Database = require('better-sqlite3');
      const path = require('path');
      const fs   = require('fs');

      fs.mkdirSync(dataDir, { recursive: true });
      this._db = new Database(path.join(dataDir, 'log.db'));

      this._db.exec(`
        CREATE TABLE IF NOT EXISTS log (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          ts        INTEGER NOT NULL,
          direction TEXT    NOT NULL,
          category  TEXT    NOT NULL,
          mac       TEXT,
          topic     TEXT,
          payload   TEXT    NOT NULL,
          node      TEXT
        );
        CREATE INDEX IF NOT EXISTS log_ts  ON log(ts);
        CREATE INDEX IF NOT EXISTS log_mac ON log(mac) WHERE mac IS NOT NULL;
      `);

      this._addStmt = this._db.prepare(
        'INSERT INTO log (ts, direction, category, mac, topic, payload, node) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );

      console.log('[LOGGER] SQLite log store ready');
    } catch (err) {
      this._db = null;
      console.warn(`[LOGGER] better-sqlite3 unavailable — using in-memory log (${err.message})`);
    }
  }

  /**
   * Add a log entry. Returns the stored row.
   */
  add(entry) {
    const ts        = entry.ts        || Date.now();
    const direction = entry.direction || 'sys';
    const category  = entry.category  || 'server';
    const mac       = entry.mac       || null;
    const topic     = entry.topic     || null;
    const node      = entry.node      || null;
    const payload   = typeof entry.payload === 'string'
      ? entry.payload
      : JSON.stringify(entry.payload);

    let id = this._nextId++;

    if (this._db && this._addStmt) {
      try {
        const info = this._addStmt.run(ts, direction, category, mac, topic, payload, node);
        id = Number(info.lastInsertRowid);
      } catch (err) {
        console.error('[LOGGER] DB insert error:', err.message);
        this._db = null; // fall back to memory
      }
    }

    const row = { id, ts, direction, category, mac, topic, payload, node };

    if (!this._db) {
      this._entries.push(row);
      if (this._entries.length > MAX_MEMORY_ENTRIES) {
        this._entries.splice(0, this._entries.length - MAX_MEMORY_ENTRIES);
      }
    }

    return row;
  }

  /**
   * Query log entries.
   *
   * @param {object}   opts
   * @param {string}   [opts.mac]        — MAC address substring filter
   * @param {string}   [opts.node]       — Node path substring filter
   * @param {string[]} [opts.directions] — subset of ['rx','tx','sys']; null = all
   * @param {string[]} [opts.categories] — subset of ['mqtt','server','client']; null = all
   * @param {string}   [opts.sort]       — 'asc' | 'desc' (default 'desc')
   * @param {number}   [opts.limit]      — max rows to return (capped at 500)
   * @param {number}   [opts.offset]     — rows to skip
   */
  query({ mac, node, directions, categories, sort = 'desc', limit = 200, offset = 0 } = {}) {
    const lim = Math.min(Number(limit) || 200, 500);
    const off = Number(offset) || 0;

    if (this._db) {
      return this._queryDb({ mac, node, directions, categories, sort, limit: lim, offset: off });
    }
    return this._queryMemory({ mac, node, directions, categories, sort, limit: lim, offset: off });
  }

  _queryDb({ mac, node, directions, categories, sort, limit, offset }) {
    const where  = [];
    const params = [];

    if (mac)  { where.push('mac LIKE ?');  params.push(`%${mac}%`); }
    if (node) { where.push('node LIKE ?'); params.push(`%${node}%`); }

    if (directions && directions.length) {
      where.push(`direction IN (${directions.map(() => '?').join(',')})`);
      params.push(...directions);
    }
    if (categories && categories.length) {
      where.push(`category IN (${categories.map(() => '?').join(',')})`);
      params.push(...categories);
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const order = sort === 'asc' ? 'ASC' : 'DESC';
    const sql = `SELECT * FROM log ${whereClause} ORDER BY id ${order} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    return this._db.prepare(sql).all(...params);
  }

  _queryMemory({ mac, node, directions, categories, sort, limit, offset }) {
    let entries = this._entries.filter(e => {
      if (mac  && !(e.mac  && e.mac.includes(mac)))   return false;
      if (node && !(e.node && e.node.includes(node)))  return false;
      if (directions && directions.length && !directions.includes(e.direction)) return false;
      if (categories && categories.length && !categories.includes(e.category))  return false;
      return true;
    });

    if (sort !== 'asc') entries = [...entries].reverse();
    return entries.slice(offset, offset + limit);
  }

  close() {
    if (this._db) {
      try { this._db.close(); } catch {}
      this._db = null;
    }
  }
}

module.exports = LogStore;
