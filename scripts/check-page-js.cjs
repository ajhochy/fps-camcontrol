// Extract the served page's inline <script> and syntax-check it.
//
// The whole page is emitted from a TS template literal, so a backtick, ${...},
// \' or \n written inside the client JS collapses when the literal is evaluated
// and silently breaks the ENTIRE script (has happened twice: 0b3d07d and again
// since). Checking the raw .ts text is not enough — the escapes have to be
// resolved the way the template literal resolves them first.
//
// Usage:
//   node scripts/check-page-js.cjs                 # check src/ui/statusServer.ts
//   node scripts/check-page-js.cjs page.html       # check a page fetched from the server
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const htmlArg = process.argv[2];

// EVERY <script> block, not just the first. The page grew a second one when the
// Sony dashboard landed, and checking only the first meant validating a 5-line
// stub while the real 1179-line script went unchecked — false confidence on
// exactly the footgun this script exists to catch.
function allScripts(text) {
  return [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

let blocks;

if (htmlArg) {
  blocks = allScripts(fs.readFileSync(htmlArg, 'utf8'));
  if (!blocks.length) { console.error('no <script> block in ' + htmlArg); process.exit(1); }
} else {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/ui/statusServer.ts'), 'utf8');
  const raws = allScripts(src);
  if (!raws.length) { console.error('could not find a <script> block'); process.exit(1); }

  blocks = raws.map((raw, i) => {
    const interp = raw.match(/\$\{/g);
    if (interp) {
      console.error('FAIL: script block ' + i + ' contains ' + interp.length +
        ' template interpolation(s) ${...}; pass dynamic values via data-* attributes instead');
      process.exit(1);
    }
    if (raw.includes('`')) {
      console.error('FAIL: script block ' + i + ' contains a backtick');
      process.exit(1);
    }
    // Resolve the escapes exactly as the surrounding template literal would.
    // Safe: we just proved there is no interpolation and no backtick to close it.
    return new Function('return `' + raw + '`')();
  });
}

let total = 0;
blocks.forEach((js, i) => {
  const out = path.join(os.tmpdir(), 'fps-page-script-' + i + '.js');
  fs.writeFileSync(out, js, 'utf8');
  try {
    execFileSync(process.execPath, ['--check', out], { stdio: 'inherit' });
  } catch (e) {
    console.error('FAIL: script block ' + i + ' does not parse as emitted');
    process.exit(1);
  }
  total += js.split('\n').length;
});
// Standalone UI scripts (ui/**/*.js) are plain files, so a plain syntax check is enough.
function uiFiles(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? uiFiles(full) : entry.name.endsWith('.js') ? [full] : [];
  }) : [];
}
const standalone = uiFiles(path.join(__dirname, '..', 'ui'));
standalone.forEach((file) => {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  } catch (e) {
    console.error('FAIL: ' + path.relative(path.join(__dirname, '..'), file) + ' does not parse');
    process.exit(1);
  }
});
console.log('OK: all ' + blocks.length + ' page script block(s) parse as emitted (' + total + ' lines)' +
  (standalone.length ? ' and ' + standalone.length + ' standalone ui file(s) parse' : ''));
