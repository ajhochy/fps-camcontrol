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
let js;

if (htmlArg) {
  const html = fs.readFileSync(htmlArg, 'utf8');
  const s = html.indexOf('<script>');
  const e = html.indexOf('</script>');
  if (s < 0 || e < 0) { console.error('no <script> block in ' + htmlArg); process.exit(1); }
  js = html.slice(s + 8, e);
} else {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/ui/statusServer.ts'), 'utf8');
  const s = src.indexOf('<script>');
  const e = src.indexOf('</script>');
  if (s < 0 || e < 0) { console.error('could not find <script> block'); process.exit(1); }
  const raw = src.slice(s + 8, e);

  const interp = raw.match(/\$\{/g);
  if (interp) {
    console.error('FAIL: client JS contains ' + interp.length + ' template interpolation(s) ${...}; ' +
      'pass dynamic values via data-* attributes instead');
    process.exit(1);
  }
  if (raw.includes('`')) { console.error('FAIL: client JS contains a backtick'); process.exit(1); }

  // Resolve the escapes exactly as the surrounding template literal would.
  // Safe: we just proved there is no interpolation and no backtick to close it.
  js = new Function('return `' + raw + '`')();
}

const out = path.join(os.tmpdir(), 'fps-page-script.js');
fs.writeFileSync(out, js, 'utf8');
execFileSync(process.execPath, ['--check', out], { stdio: 'inherit' });
console.log('OK: page script parses as emitted (' + js.split('\n').length + ' lines)');
