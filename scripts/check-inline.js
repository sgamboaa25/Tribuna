// Utilidad de desarrollo: extrae el script inline de index.html y lo guarda
// aparte para poder pasarle `node --check`. ESLint solo cubre server.js, asi
// que esta es la forma de comprobar que el JS del cliente sigue parseando.
const fs = require('fs');
const path = require('path');

const file = process.argv[2] || 'index.html';
const out = process.argv[3] || path.join(require('os').tmpdir(), 'tribuna-inline.js');
const html = fs.readFileSync(file, 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .filter((s) => s.trim());

if (!scripts.length) {
  console.error('No se encontro ningun script inline en ' + file);
  process.exit(1);
}

fs.writeFileSync(out, scripts.join('\n;\n'));
console.log('script inline extraido (' + scripts.length + ' bloque(s)) -> ' + out);
