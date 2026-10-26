const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(`${__dirname}/../dist/nose.js`, 'utf8');

// Load the actual app with browser/MediaPipe doubles; no camera or network access.
async function app({ gpuFails = false, cpuFails = false, cameraFails = false, secure = true } = {}) {
  const calls = [];
  const events = {};
  const context2d = Object.fromEntries(
    ['setTransform', 'beginPath', 'arc', 'fill', 'moveTo', 'lineTo', 'stroke']
      .map(name => [name, (...args) => calls.push([name, ...args])]),
  );
  const canvas = { getContext: () => context2d };
  const video = {
    videoWidth: 640, videoHeight: 480, readyState: 2, currentTime: 0,
    paused: false, ended: false, play: async () => {},
    addEventListener: (name, callback) => { events[name] = callback; },
  };
  const stage = { style: {} };
  const status = {};
  const document = {
    hidden: false,
    querySelector: selector => ({ '#camera': video, '#stage': stage, '#status': status, '#drawing': canvas })[selector],
    addEventListener: (name, callback) => { events[name] = callback; },
  };
  let constraints;
  let trackStopped = false;
  let closed = false;
  let detections = 0;
  let result = face();
  let detectionFails = false;
  const options = [];
  const track = { stop: () => { trackStopped = true; }, addEventListener: (name, callback) => { events["track:" + name] = callback; } };
  const landmarker = {
    detectForVideo(input, time) {
      assert.equal(input, video);
      assert.ok(Number.isFinite(time));
      detections++;
      if (detectionFails) throw new Error('inference failed');
      return result;
    },
    close: () => { closed = true; },
  };
  const globals = vm.createContext({
    document, devicePixelRatio: 2, innerWidth: 1000, innerHeight: 600,
    isSecureContext: secure,
    navigator: { mediaDevices: { getUserMedia: async value => {
      if (cameraFails) throw Object.assign(new Error(), { name: "NotAllowedError" });
      constraints = value;
      return { getTracks: () => [track], getVideoTracks: () => [track] };
    } } },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    addEventListener: (name, callback) => { events[name] = callback; },
  });
  const vision = new vm.SyntheticModule(['FilesetResolver', 'FaceLandmarker'], function () {
    this.setExport('FilesetResolver', { forVisionTasks: async url => {
      assert.equal(url, "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
      return {};
    } });
    this.setExport('FaceLandmarker', { createFromOptions: async (_, value) => {
      options.push(value);
      if (value.baseOptions.delegate === 'GPU' ? gpuFails : cpuFails) throw new Error('delegate unavailable');
      return landmarker;
    } });
  }, { context: globals });
  await vision.link(() => {});
  await vision.evaluate();
  // Expose existing declarations and suppress only automatic startup for isolation.
  const module = new vm.SourceTextModule(source.replace(/\nstart\(\);\s*$/,
    '\nexport { Drawing, start, tick, fit, stop, drawing };'), {
    context: globals,
    importModuleDynamically: async specifier => {
      assert.equal(specifier, 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
      return vision;
    },
  });
  await module.link(() => {});
  await module.evaluate();
  return {
    ...module.namespace, canvas, context2d, calls, video, stage, status, document, events, options,
    get constraints() { return constraints; },
    get detections() { return detections; },
    get trackStopped() { return trackStopped; },
    get stopped() { return trackStopped && closed; },
    setResult(value) { result = value; },
    failDetection(value = true) { detectionFails = value; },
  };
}

function face(x = .2, y = .3) {
  return { faceLandmarks: [[{ x: .99, y: .99 }, { x, y }, { x: .01, y: .01 }]] };
}

test('nose landmark 1 draws raw coordinates in a red 5px trace, including fast movements', async () => {
  const a = await app();
  a.drawing.resize(800, 600, 2);
  a.drawing.update(face(), 0);
  a.drawing.update(face(.9, .8), 16);
  assert.equal(a.drawing.strokes.length, 1);
  assert.deepEqual(a.calls.filter(c => c[0] === 'arc')[0].slice(1, 4), [160, 180, 2.5]);
  assert.deepEqual(a.calls.filter(c => c[0] === 'moveTo'), [['moveTo', 160, 180]]);
  assert.deepEqual(a.calls.filter(c => c[0] === 'lineTo'), [['lineTo', 720, 480]]);
  assert.equal(a.context2d.strokeStyle, '#EA4756');
  assert.equal(a.context2d.fillStyle, '#EA4756');
  assert.equal(a.context2d.lineWidth, 5);
  assert.equal(a.context2d.lineCap, 'round');
});

test('face loss, malformed or out-of-range tips and >250ms gaps start separate strokes', async () => {
  for (const interruption of [{}, { faceLandmarks: [] }, { faceLandmarks: [[]] }, face(NaN), face(-.1), face(.5, 1.1)]) {
    const a = await app();
    a.drawing.resize(800, 600, 1);
    a.drawing.update(face(), 0);
    a.drawing.update(interruption, 16);
    a.drawing.update(face(.8), 32);
    assert.equal(a.drawing.strokes.length, 2);
    assert.equal(a.calls.filter(c => c[0] === 'lineTo').length, 0);
  }
  const a = await app();
  a.drawing.resize(800, 600, 1);
  a.drawing.update(face(), 0);
  a.drawing.update(face(.8), 250);
  assert.equal(a.drawing.strokes.length, 1);
  a.drawing.update(face(.1), 501);
  assert.equal(a.drawing.strokes.length, 2);
});

test('resize retains normalized strokes, redraws at correct size/DPR and separates the next stroke; reload clears', async () => {
  const a = await app();
  a.drawing.resize(800, 600, 1);
  a.drawing.update(face(), 0);
  a.drawing.update(face(.8, .7), 16);
  for (const ratio of [1, 2, 3]) {
    a.drawing.resize(400, 300, ratio);
    assert.equal(a.canvas.width, 400 * ratio);
    assert.equal(a.canvas.height, 300 * ratio);
    assert.equal(a.context2d.lineWidth, 5);
    assert.deepEqual(a.calls.filter(c => c[0] === 'setTransform').at(-1), ['setTransform', ratio, 0, 0, ratio, 0, 0]);
    assert.deepEqual(a.calls.filter(c => c[0] === 'lineTo').at(-1), ['lineTo', 320, 210]);
    assert.equal(a.drawing.strokes.length, 1);
    assert.equal(a.drawing.current, null);
  }
  a.drawing.update(face(), 32);
  assert.equal(a.drawing.strokes.length, 2);
  assert.equal((await app()).drawing.strokes.length, 0);
});

test('startup uses existing capture constraints, one face, VIDEO and GPU with CPU fallback', async () => {
  for (const gpuFails of [false, true]) {
    const a = await app({ gpuFails });
    await a.start();
    assert.deepEqual(JSON.parse(JSON.stringify(a.constraints)), {
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } }, audio: false,
    });
    assert.deepEqual(a.options.map(o => o.baseOptions.delegate), gpuFails ? ['GPU', 'CPU'] : ['GPU']);
    for (const o of a.options) {
      assert.equal(o.runningMode, 'VIDEO');
      assert.equal(o.numFaces, 1);
      assert.equal(o.outputFaceBlendshapes, false);
      assert.equal(o.outputFacialTransformationMatrixes, false);
      assert.equal(o.baseOptions.modelAssetPath, 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task');
    }
    assert.equal(a.stage.style.width, '800px');
    assert.equal(a.stage.style.height, '600px');
    a.tick(0);
    assert.equal(a.drawing.strokes.length, 1);
  }
});

test('duplicate frames are skipped and stalled capture separates resumed strokes', async () => {
  const a = await app();
  await a.start();
  a.tick(0);
  a.tick(10);
  assert.equal(a.detections, 1);
  a.tick(251);
  assert.equal(a.drawing.current, null);
  a.video.currentTime++;
  a.tick(267);
  assert.equal(a.drawing.strokes.length, 2);
});

test('inference failure recovers without bridging strokes', async () => {
  const a = await app();
  await a.start();
  a.tick(0);
  a.failDetection();
  a.video.currentTime++;
  a.tick(16);
  assert.equal(a.drawing.current, null);
  assert.equal(a.status.hidden, false);
  a.failDetection(false);
  a.video.currentTime++;
  a.tick(32);
  assert.equal(a.status.hidden, true);
  assert.equal(a.drawing.strokes.length, 2);
  assert.equal(a.calls.filter(c => c[0] === 'lineTo').length, 0);
});

test('visibility and video interruptions separate resumed traces; hidden page never infers', async () => {
  for (const event of ['visibilitychange', 'waiting', 'stalled', 'pause', 'emptied']) {
    const a = await app();
    await a.start();
    a.tick(0);
    a.events[event]();
    assert.equal(a.drawing.current, null, event);
    a.video.currentTime++;
    a.tick(16);
    assert.equal(a.drawing.strokes.length, 2, event);
  }
  const a = await app();
  await a.start();
  a.tick(0);
  a.document.hidden = true;
  a.events.visibilitychange();
  a.video.currentTime++;
  a.tick(16);
  assert.equal(a.detections, 1);
  a.document.hidden = false;
  a.tick(32);
  assert.equal(a.drawing.strokes.length, 2);
});

test('model/camera errors are visible and release resources; pagehide and disconnect stop inference', async () => {
  for (const config of [{ gpuFails: true, cpuFails: true }, { cameraFails: true }, { secure: false }]) {
    const a = await app(config);
    await a.start();
    assert.equal(a.status.hidden, false);
    assert.match(a.status.textContent, config.cameraFails ? /許可/ : config.secure === false ? /HTTPS/ : /モデルを読み込めません/);
    if (config.gpuFails) assert.equal(a.trackStopped, true);
    assert.equal(a.drawing.current, null);
    if (config.secure !== false) { a.tick(16); assert.equal(a.detections, 0); }
  }
  for (const event of ['pagehide', 'track:ended', 'error']) {
    const a = await app();
    await a.start();
    a.tick(0);
    a.events[event]();
    a.video.currentTime++;
    a.tick(16);
    assert.equal(a.stopped, true);
    assert.equal(a.drawing.current, null);
    assert.equal(a.detections, 1);
  }
});
