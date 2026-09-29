// Comprueba si el autopost a X está listo SIN publicar nada y sin gastar un
// solo crédito. Útil para probar credenciales nuevas antes de poner
// X_AUTOPOST_ENABLED=true en producción.
//
//   node scripts/check-x-autopost.js
//
// Lee las variables de .env. Nunca imprime los valores secretos, solo si están
// presentes y cuánto miden.

require('dotenv').config();

const REQUIRED = [
  ['X_CONSUMER_KEY', 'Consumer key de la app'],
  ['X_CONSUMER_SECRET', 'Consumer secret'],
  ['X_ACCESS_TOKEN', 'Access token de la cuenta'],
  ['X_ACCESS_SECRET', 'Access token secret']
];

const ENABLED = process.env.X_AUTOPOST_ENABLED === 'true';
let faltan = 0;

console.log('--- Credenciales de la X API ---');
for (const [key, label] of REQUIRED) {
  const valor = process.env[key];
  if (valor && valor.trim()) {
    console.log(`  ok    ${key} (${label}, ${valor.length} car.)`);
  } else {
    console.log(`  FALTA ${key} (${label})`);
    faltan += 1;
  }
}

console.log('\n--- Interruptor ---');
console.log(`  X_AUTOPOST_ENABLED = ${process.env.X_AUTOPOST_ENABLED || '(sin definir)'}`);
if (!ENABLED) {
  console.log('  -> Desactivado: no se publicara nada aunque falten credenciales.');
} else if (faltan > 0) {
  console.log('  -> Activado pero INCOMPLETO: maybeAutopostNote() no posteara nada.');
} else {
  console.log('  -> Activado y completo: las notas publicadas+urgent se postean solas.');
}

console.log('\n--- Costo esperado ---');
console.log('  El autopost siempre incluye el enlace a la nota: US$0.20 por post.');
console.log('  US$0.015 es solo para posts sin link. Ver .env.example para el detalle.');

if (faltan > 0 || !ENABLED) {
  console.log('\n  Resultado: NO publicara nada todavia. Esto es lo esperado si');
  console.log('  recien estas configurando. Nada se publico en esta ejecucion.');
  process.exit(0);
}

console.log('\n  ATENCION: el autopost esta activo. Publicar una nota marcada');
console.log('  como urgente ahora mismo costaria US$0.20 real.');
