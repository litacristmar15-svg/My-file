'use strict';
// Vercel entry point (serverless). DEMO MODE ONLY — see README "Vercel".
// Vercel functions have no permanent disk: only /tmp is writable, and it is wiped whenever
// the function restarts or scales. So each fresh instance starts with the demo data,
// and anything typed in can disappear. Do not use this for real client records.
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const { open } = require('../src/db');
const { seed } = require('../src/seed');
const { createApp } = require('../src/app');

const DIR = process.env.DATA_DIR || '/tmp/l2c';
const DB_PATH = path.join(DIR, 'l2c.db');
fs.mkdirSync(DIR, { recursive: true });
const fresh = !fs.existsSync(DB_PATH);
const db = open(DB_PATH);
if (fresh || !db.prepare('SELECT 1 FROM users LIMIT 1').get()) seed(db);

module.exports = createApp(db, { uploadDir: path.join(DIR, 'uploads') });
