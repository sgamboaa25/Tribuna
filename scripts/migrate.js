// Migración de base de datos para Render / arranques locales.
// Ejecuta supabase-schema.sql contra Supabase Postgres usando la connection
// string (DATABASE_URL). El schema es 100% idempotente (IF NOT EXISTS, drop
// policy + create, INSERT ... WHERE NOT EXISTS), así que re-ejecutarlo en cada
// deploy es seguro: solo aplica lo que faltaba.
//
// Si no hay connection string en el entorno, avisa y sale sin error para no
// romper el arranque local (npm start) ni el de Render si olvidas la variable.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DB_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.warn(
    'Migración omitida: define DATABASE_URL (connection string de Supabase) para aplicarla automáticamente.'
  );
  process.exit(0);
}

// Separa sentencias por ';' respetando literales entre comillas simples.
function splitStatements(sql) {
  const out = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    cur += ch;
    if (inStr) {
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          cur += "'";
          i++;
        } else {
          inStr = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inStr = true;
      continue;
    }
    if (ch === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

(async () => {
  const file = path.join(__dirname, '..', 'supabase-schema.sql');
  const sql = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  const statements = splitStatements(sql);
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();
    console.log(`Aplicando schema (${statements.length} sentencias) desde supabase-schema.sql…`);
    let ok = 0;
    for (const stmt of statements) {
      try {
        await client.query(stmt);
        ok++;
      } catch (err) {
        console.error('ERROR aplicando sentencia:', err.message);
        console.error('SENTENCIA:', stmt.slice(0, 160).replace(/\s+/g, ' '));
        throw err;
      }
    }
    console.log(`OK: ${ok}/${statements.length} sentencias aplicadas.`);
  } finally {
    await client.end().catch(() => {});
  }
})().catch((err) => {
  console.error('Migración fallida:', err.message);
  process.exit(1);
});