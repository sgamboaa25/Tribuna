// Servidor local de TRIBUNA. Para producción, usa HTTPS, una base de datos y un
// proveedor de autenticación; este archivo conserva las notas en el servidor.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = __dirname;
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const notesPath = path.join(dataDir, 'notes.json');
const seedNotesPath = path.join(root, 'seed-notes.json');
const writerPassword = process.env.WRITER_PASSWORD || '250608$';
const sessions = new Set();
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const useSupabase = Boolean(supabaseUrl && supabaseKey);

function dbHeaders(extra={}) { return { apikey:supabaseKey, Authorization:`Bearer ${supabaseKey}`, 'Content-Type':'application/json', ...extra }; }
async function readNotes() { if (!useSupabase) return JSON.parse(fs.readFileSync(notesPath, 'utf8')); const response=await fetch(`${supabaseUrl}/rest/v1/notes?select=*&order=created_at.asc`,{headers:dbHeaders()}); if(!response.ok) throw new Error('No se pudo leer la base de datos'); return response.json(); }
async function createNote(note) { if (!useSupabase) { const notes=await readNotes(); note.id=crypto.randomUUID(); note.created_at=new Date().toISOString(); notes.push(note); fs.writeFileSync(notesPath,JSON.stringify(notes,null,2),'utf8'); return note; } const response=await fetch(`${supabaseUrl}/rest/v1/notes`,{method:'POST',headers:dbHeaders({Prefer:'return=representation'}),body:JSON.stringify(note)}); if(!response.ok) throw new Error('No se pudo guardar la nota'); return (await response.json())[0]; }
async function updateNote(id,note) { if (!useSupabase) { const notes=await readNotes(); const index=notes.findIndex(item=>item.id===id); if(index<0) return null; notes[index]={...notes[index],...note,id}; fs.writeFileSync(notesPath,JSON.stringify(notes,null,2),'utf8'); return notes[index]; } const response=await fetch(`${supabaseUrl}/rest/v1/notes?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:dbHeaders({Prefer:'return=representation'}),body:JSON.stringify(note)}); if(!response.ok) throw new Error('No se pudo actualizar la nota'); return (await response.json())[0] || null; }
function send(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
function isWriter(req) { const token = req.headers.authorization?.replace(/^Bearer\s+/i, ''); return Boolean(token && sessions.has(token)); }
function readBody(req) { return new Promise((resolve, reject) => { let body=''; req.on('data', part => { body += part; if (body.length > 1_000_000) reject(new Error('Solicitud demasiado grande')); }); req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('JSON inválido')); } }); }); }
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml' };

if (!useSupabase) { if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive:true }); if (!fs.existsSync(notesPath)) fs.copyFileSync(seedNotesPath, notesPath); }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/notes') return send(res, 200, await readNotes());
    if (req.method === 'POST' && url.pathname === '/api/auth') { const { password } = await readBody(req); if (password !== writerPassword) return send(res, 401, { ok:false }); const token=crypto.randomUUID(); sessions.add(token); return send(res, 200, { ok:true, token }); }
    if (req.method === 'POST' && url.pathname === '/api/notes') { if (!isWriter(req)) return send(res, 401, { error:'Acceso de redacción requerido' }); const note = await readBody(req); return send(res, 201, await createNote(note)); }
    const match = url.pathname.match(/^\/api\/notes\/([^/]+)$/);
    if (req.method === 'PUT' && match) { if (!isWriter(req)) return send(res, 401, { error:'Acceso de redacción requerido' }); const note = await readBody(req); const saved=await updateNote(match[1],note); if(!saved) return send(res,404,{error:'Nota no encontrada'}); return send(res,200,saved); }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error:'Método no permitido' });
    const fileName = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const filePath = path.resolve(root, fileName);
    if (!filePath.startsWith(root + path.sep) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { res.writeHead(404); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' }); fs.createReadStream(filePath).pipe(res);
  } catch (error) { send(res, 400, { error:error.message }); }
});
server.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('TRIBUNA disponible en http://localhost:3000'));
