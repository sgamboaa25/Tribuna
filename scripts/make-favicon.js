// Empaqueta los PNG de public/ en un .ico con varias resoluciones.
// Formato ICO clasico: cabecera, un directorio de 16 bytes por imagen y los
// PNG concatenados. Los PNG embebidos en un .ico los entiende todo navegador
// moderno y Google, asi que no hace falta escribir BMP a mano.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'public');
const sources = [
  { file: 'favicon-16x16.png', size: 16 },
  { file: 'favicon-32x32.png', size: 32 },
  { file: 'favicon-48x48.png', size: 48 }
];

const images = sources.map((s) => ({
  ...s,
  data: fs.readFileSync(path.join(DIR, s.file))
}));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reservado
header.writeUInt16LE(1, 2); // tipo 1 = icono
header.writeUInt16LE(images.length, 4);

const directory = Buffer.alloc(16 * images.length);
let offset = header.length + directory.length;

images.forEach((img, i) => {
  const at = i * 16;
  directory.writeUInt8(img.size, at + 0);       // 0 significa 256
  directory.writeUInt8(img.size, at + 1);
  directory.writeUInt8(0, at + 2);             // paleta: 0 = truecolor
  directory.writeUInt8(0, at + 3);             // reservado
  directory.writeUInt16LE(1, at + 4);          // planos
  directory.writeUInt16LE(32, at + 6);         // bits por pixel
  directory.writeUInt32LE(img.data.length, at + 8);
  directory.writeUInt32LE(offset, at + 12);
  offset += img.data.length;
});

const out = Buffer.concat([header, directory, ...images.map((i) => i.data)]);
const target = path.join(DIR, 'favicon.ico');
fs.writeFileSync(target, out);

console.log(
  'favicon.ico generado: ' +
    images.map((i) => `${i.size}x${i.size}`).join(', ') +
    ` -> ${out.length} bytes`
);
