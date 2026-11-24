const fs = require('fs'), path = require('path');
const source = path.join(__dirname, '..', '..', 'royal-dam-erp-updated.html');
const target1 = path.join(__dirname, '..', 'renderer', 'index.html');
const target2 = path.join(__dirname, '..', 'index.html');

fs.mkdirSync(path.dirname(target1), { recursive: true });
fs.copyFileSync(source, target1);
fs.copyFileSync(source, target2);
console.log('Renderer copied to:', target1, 'and', target2);
