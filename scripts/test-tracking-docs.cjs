const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const read=file=>fs.readFileSync(file,'utf8');
test('issue-35-c1',()=>{const doc=read('docs/tracking.md');for(const term of ['Prerequisites','sidecar','tracking:','sonyCameraId','device:','0.35','secondary angle','Limits'])assert.ok(doc.includes(term),term);});
test('issue-35-c2',()=>{const doc=read('docs/ai/testing-guide.md');for(const term of ['test:tracking','tracker-sidecar/tests','trackingIntegrationTest','tracking-calibrate','30-minute'])assert.ok(doc.includes(term),term);});
test('issue-35-c3',()=>{for(const file of ['docs/ai/architecture.md','docs/ai/repo-map.md'])for(const term of ['tracker-sidecar/','src/tracking/','MotionLedger'])assert.ok(read(file).includes(term),file+':'+term);});
test('issue-35-c5',()=>{const doc=read('docs/ai/project-state.md');for(const term of ['codex/electron-tracking','MANUAL_PENDING','loopback','57'])assert.ok(doc.includes(term),term);});
test('issue-35-c6',()=>{const doc=read('docs/ai/issues/tracking-v1-exclusions.md');for(const term of ['#48','#54','multi-target','auto-zoom','Acceptance'])assert.ok(doc.includes(term),term);});
test('human drills stay explicitly unperformed without physical evidence',()=>{const doc=read('docs/ai/runs/2026-10-01-tracking-live-verification.md');assert.ok(doc.includes('MANUAL_PENDING'));assert.ok(doc.includes('30-minute idle'));assert.ok(doc.includes('30-minute active'));assert.ok(!/\|\s*PASS\s*\|/.test(doc));});
