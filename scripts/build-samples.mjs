// Genera samples.json a partir de TU instalación local de Moho (opcional).
// Los archivos de Moho no se distribuyen con Astrix Studio; este índice solo apunta a ellos.
// Uso: node scripts/build-samples.mjs /ruta/a/Moho   (por defecto: la carpeta padre)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moho = path.resolve(process.argv[2] || path.join(app, '..'));
const support = path.join(moho, 'Resources', 'Support');
if (!fs.existsSync(support)) { console.error(`No se encontró ${support}`); process.exit(1); }

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const files = walk(support).filter((f) => f.endsWith('.moho') && !path.basename(f).startsWith('._'));
const pick = [...files.filter((f) => f.includes(`${path.sep}Pro${path.sep}Startup${path.sep}`)), ...files.filter((f) => f.includes(`${path.sep}Library${path.sep}Characters${path.sep}`)).slice(0, 40)];
const out = pick.map((f) => ({ name: path.basename(f, '.moho'), path: '/' + path.relative(moho, f).split(path.sep).map(encodeURIComponent).join('/') }));
fs.writeFileSync(path.join(app, 'samples.json'), JSON.stringify(out, null, 1));
console.log(`samples.json: ${out.length} ejemplos (servidos desde ${moho}/Resources con MOHO_DIR)`);
