import fs from 'node:fs/promises';
import path from 'node:path';

const dist = path.resolve('dist');
const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
const files = await fs.readdir(dist, { withFileTypes: true });
const oldInstallers = files
  .filter(file => file.isFile() && /^منظومة-السد-المل.*-Setup-\d+\.\d+\.\d+\.exe(?:\.blockmap)?$/.test(file.name) && !file.name.includes(`Setup-${version}.exe`))
  .map(file => path.join(dist, file.name));

await Promise.all(oldInstallers.map(file => fs.unlink(file)));
console.log(`Removed ${oldInstallers.length} old installer artifacts.`);
