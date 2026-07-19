#!/usr/bin/env node
/**
 * Oura to BigQuery Daily Sync Script
 * Runs daily via Antigravity scheduler.
 */
import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Access token configuration
const TOKEN = process.env.OURA_ACCESS_TOKEN || "RV2L6ES37QSANF7GUR5HARTJ7NQZSZL2";
const PROJECT = "oura-502819";
const DATASET = "oura";
const LOCATION = "europe-north1";

// Sync range: last 3 days to capture final sleep/readiness revisions
const getPastDate = (daysAgo) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
};

const START_DATE = getPastDate(3);
const END_DATE = getPastDate(-1); // Sync up to tomorrow to capture current day's ongoing data

const TMP_DIR = path.join(__dirname, 'bq_sync_tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

const ENDPOINTS = [
  { name: 'sleep', path: 'sleep', type: 'date' },
  { name: 'daily_sleep', path: 'daily_sleep', type: 'date' },
  { name: 'readiness', path: 'daily_readiness', type: 'date' },
  { name: 'activity', path: 'daily_activity', type: 'date' },
  { name: 'stress', path: 'daily_stress', type: 'date' },
  { name: 'spo2', path: 'daily_spo2', type: 'date' },
  { name: 'workouts', path: 'workout', type: 'date' },
  { name: 'resilience', path: 'daily_resilience', type: 'date' },
  { name: 'cardiovascular_age', path: 'daily_cardiovascular_age', type: 'date' },
  { name: 'vo2_max', path: 'vo2_max', type: 'date' },
  { name: 'tags', path: 'tag', type: 'date' },
  { name: 'enhanced_tags', path: 'enhanced_tag', type: 'date' },
  { name: 'sessions', path: 'session', type: 'date' },
  { name: 'heart_rate', path: 'heartrate', type: 'datetime' }
];

function cleanNulls(obj) {
  if (Array.isArray(obj)) {
    return obj.map(cleanNulls).filter(v => v !== null && v !== undefined);
  } else if (obj !== null && typeof obj === 'object') {
    const entries = Object.entries(obj).map(([k, v]) => {
      if (k === 'items' && (v === null || v === undefined)) {
        return [k, []];
      }
      return [k, cleanNulls(v)];
    });
    return Object.fromEntries(entries.filter(([_, v]) => v !== null));
  }
  return obj;
}

async function fetchAll(endpointObj) {
  const all = [];
  let nextToken = null;
  const isDateTime = endpointObj.type === 'datetime';
  
  do {
    const url = new URL(`https://api.ouraring.com/v2/usercollection/${endpointObj.path}`);
    if (nextToken) {
      url.searchParams.set("next_token", nextToken);
    } else {
      if (isDateTime) {
        url.searchParams.set("start_datetime", `${START_DATE}T00:00:00`);
        url.searchParams.set("end_datetime", `${END_DATE}T23:59:59`);
      } else {
        url.searchParams.set("start_date", START_DATE);
        url.searchParams.set("end_date", END_DATE);
      }
    }

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${endpointObj.path}: ${await res.text()}`);
    const json = await res.json();
    if (json.data) all.push(...json.data);
    nextToken = json.next_token || null;
  } while (nextToken);

  return all;
}

function getExistingKeys(tableName, keyField) {
  try {
    const query = `SELECT DISTINCT ${keyField} FROM \\\`${PROJECT}.${DATASET}.${tableName}\\\` WHERE day >= '${START_DATE}'`;
    const hrQuery = `SELECT DISTINCT ${keyField} FROM \\\`${PROJECT}.${DATASET}.${tableName}\\\` WHERE timestamp >= '${START_DATE} 00:00:00'`;
    const finalQuery = tableName === 'heart_rate' ? hrQuery : query;

    const cmd = `bq query --use_legacy_sql=false --format=json "${finalQuery}"`;
    const out = execSync(cmd, { encoding: 'utf-8' });
    const rows = JSON.parse(out);
    return new Set(rows.map(r => r[keyField]));
  } catch (e) {
    return new Set();
  }
}

async function main() {
  console.log(`Starting sync for range: ${START_DATE} to ${END_DATE}`);
  for (const ep of ENDPOINTS) {
    try {
      const records = await fetchAll(ep);
      if (!records.length) continue;

      const keyField = ep.name === 'heart_rate' ? 'timestamp' : 'id';
      const existingKeys = getExistingKeys(ep.name, keyField);
      
      const newRecords = records.filter(r => !existingKeys.has(r[keyField]));
      if (!newRecords.length) continue;

      const cleaned = cleanNulls(newRecords);
      const ndjsonPath = path.join(TMP_DIR, `${ep.name}.ndjson`);
      fs.writeFileSync(ndjsonPath, cleaned.map(r => JSON.stringify(r)).join('\n') + '\n');

      const bqCmd = `bq load --location=${LOCATION} --source_format=NEWLINE_DELIMITED_JSON ${PROJECT}:${DATASET}.${ep.name} ${ndjsonPath}`;
      execSync(bqCmd);
      console.log(`  ✓ Loaded ${newRecords.length} new records into ${ep.name}`);
    } catch (e) {
      if (e.message.includes('404')) {
        // Skip endpoint if not supported/found (like vo2_max)
        continue;
      }
      console.error(`Error processing ${ep.name}:`, e.message);
    }
  }

  // Cleanup
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) {}
  console.log("Sync complete!");
}

main();
