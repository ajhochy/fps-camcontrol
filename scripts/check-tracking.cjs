// Actual pinned runtime required: a skipped host-Python model test is not a pass.
const {spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const python=path.join(root,'dist/tracking-runtime/python/bin/python3');
const model=path.join(root,'dist/tracking-runtime/models/object_detection_yolox_2022nov.onnx');
if(!fs.existsSync(python)||!fs.existsSync(model))throw new Error('Stage the pinned tracking runtime first; see docs/tracking.md');
const env={...process.env,CAMCONTROL_NO_CONTROLLER:'1',TRACKER_TEST_MODEL:model};
for(const key of ['CAMCONTROL_HOME','CAMCONTROL_RESOURCES','CAMCONTROL_EMBEDDED','CAMCONTROL_SESSION','TRACKING_ENABLED','TRACKING_SIDECAR_URL','TRACKER_WS_TOKEN','TRACKER_FRAME_TOKEN','DEVICES_CONFIG','MAPPINGS_FILE','SPEEDS_FILE','PRESETS_FILE','SONY_STATE_FILE','SONY_SERVER_EXECUTABLE'])delete env[key];
function run(command,args){console.log(`$ ${command} ${args.join(' ')}`);const r=spawnSync(command,args,{cwd:root,env,stdio:'inherit'});if(r.error||r.status!==0)process.exit(r.status||1);}
run(python,['-I','-B','-m','unittest','discover','-s','tracker-sidecar/tests','-v']);
run(process.execPath,['dist/testing/trackingSim.js']);
run(process.execPath,['dist/testing/trackingIntegrationTest.js']);
run(process.execPath,['--test','scripts/test-tracking-docs.cjs','scripts/test-tracking-runtime-staging.cjs','scripts/test-tracking-runtime-fixtures.cjs']);
run(process.execPath,['scripts/test-tracking-ui.cjs']);
console.log('PASS tracking runtime/model/integration/UI/docs gates; physical and final DMG gates are separate.');
