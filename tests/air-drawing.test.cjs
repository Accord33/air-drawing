const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(`${__dirname}/../dist/app.js`, 'utf8');

// Load the actual app with browser/MediaPipe doubles; no camera or network access.
async function app({ gpuFails = false, cpuFails = false } = {}) {
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
  let result = hand();
  let detectionFails = false;
  const options = [];
  const track = { stop: () => { trackStopped = true; }, addEventListener() {} };
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
    isSecureContext: true,
    navigator: { mediaDevices: { getUserMedia: async value => {
      constraints = value;
      return { getTracks: () => [track], getVideoTracks: () => [track] };
    } } },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    addEventListener: (name, callback) => { events[name] = callback; },
  });
  const vision = new vm.SyntheticModule(['FilesetResolver', 'HandLandmarker'], function () {
    this.setExport('FilesetResolver', { forVisionTasks: async () => ({}) });
    this.setExport('HandLandmarker', { createFromOptions: async (_, value) => {
      options.push(value);
      if (value.baseOptions.delegate === 'GPU' ? gpuFails : cpuFails) throw new Error('delegate unavailable');
      return landmarker;
    } });
  }, { context: globals });
  await vision.link(() => {});
  await vision.evaluate();
  // Expose existing declarations and suppress only automatic startup for isolation.
  const module = new vm.SourceTextModule(source.replace(/\nstart\(\);\s*$/,
    '\nexport { Drawing, isDrawingGesture, start, tick, fit, stop, drawing };'), {
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
    failDetection() { detectionFails = true; },
  };
}

function gesture() {
  const points = Array.from({ length: 21 }, () => ({ x: .5, y: .8, z: 0 }));
  [5, 6, 7, 8].forEach((index, i) => { points[index] = { x: .4, y: .65 - i * .12, z: 0 }; });
  for (const base of [9, 13, 17]) {
    const x = .5 + (base - 9) * .02;
    [[x, .65], [x, .5], [x + .04, .6], [x, .72]].forEach(([x, y], i) => {
      points[base + i] = { x, y, z: 0 };
    });
  }
  return points;
}

function hand(x = .2, y = .3, side = 'Left') {
  const landmarks = gesture();
  landmarks[8] = { x, y, z: 0 };
  return { landmarks: [landmarks], worldLandmarks: [gesture()], handedness: [[{ categoryName: side }]] };
}

test('gesture works for mirrored and rotated hands, ignores the thumb, and rejects other poses', async () => {
  const { isDrawingGesture } = await app();
  const points = gesture();
  assert.equal(isDrawingGesture(points), true);
  assert.equal(isDrawingGesture(points.map(p => ({ ...p, x: 1 - p.x }))), true);
  assert.equal(isDrawingGesture(points.map(p => ({ x: p.y, y: 1 - p.x, z: p.z }))), true);
  for (let i = 1; i <= 4; i++) points[i] = { x: .1 * i, y: .1, z: .3 };
  assert.equal(isDrawingGesture(points), true);
  for (const base of [5, 9, 13, 17]) {
    const otherPose = gesture();
    otherPose[base + 2] = { ...otherPose[base + 1], y: otherPose[base + 1].y + (base === 5 ? .1 : -.1) };
    assert.equal(isDrawingGesture(otherPose), false);
  }
  assert.equal(isDrawingGesture([]), false);
  points[8].x = NaN;
  assert.equal(isDrawingGesture(points), false);
});

test('fast large movements connect raw fingertip positions without lag or a distance cutoff', async () => {
  const a = await app();
  a.drawing.resize(800, 600, 2);
  a.drawing.update(hand(.1, .2), 0);
  a.drawing.update(hand(.9, .8), 16);
  a.drawing.update(hand(.15, .25), 32);
  assert.equal(a.drawing.strokes.length, 1);
  assert.equal(a.drawing.current.length, 3);
  assert.deepEqual(a.calls.filter(([name]) => name === 'lineTo'), [['lineTo', 720, 480], ['lineTo', 120, 150]]);
  // The parent CSS transform maps x and the camera to the same (1 - x) position.
  assert.equal(a.drawing.current.at(-1).x, .15);
});

test('strokes stay red and 5 CSS pixels wide at different sizes and pixel ratios', async () => {
  const a = await app();
  for (const ratio of [1, 2, 3]) {
    a.drawing.resize(800, 600, ratio);
    assert.equal(a.canvas.width, 800 * ratio);
    assert.equal(a.context2d.lineWidth, 5);
    assert.equal(a.context2d.strokeStyle, '#FF0000');
    assert.equal(a.context2d.fillStyle, '#FF0000');
    assert.equal(a.context2d.lineCap, 'round');
    assert.equal(a.context2d.lineJoin, 'round');
    assert.deepEqual(a.calls.filter(([name]) => name === 'setTransform').at(-1), ['setTransform', ratio, 0, 0, ratio, 0, 0]);
    a.drawing.update(hand(), ratio * 20);
    assert.equal(a.calls.filter(([name]) => name === 'arc').at(-1)[3], 2.5);
  }
  a.drawing.resize(400, 300, 2);
  assert.deepEqual(a.calls.filter(([name]) => name === 'arc').at(-1).slice(1, 4), [80, 90, 2.5]);
  assert.equal(a.drawing.strokes.length, 3);
  assert.equal(a.drawing.current, null);
});

test('gesture release, hand loss, invalid tip and long gaps separate strokes', async () => {
  for (const interruption of [
    {},
    { landmarks: [] },
    { ...hand(), worldLandmarks: [[]] },
    hand(NaN), hand(-.1), hand(.5, 1.1),
  ]) {
    const { drawing } = await app();
    drawing.resize(800, 600, 1);
    drawing.update(hand(), 0);
    drawing.update(interruption, 16);
    drawing.update(hand(.8), 32);
    assert.equal(drawing.strokes.length, 2);
    assert.equal(drawing.current.length, 1);
  }
  const { drawing } = await app();
  drawing.resize(800, 600, 1);
  drawing.update(hand(), 0);
  drawing.update(hand(.8), 251);
  drawing.update(hand(.2, .3, 'Right'), 267);
  assert.equal(drawing.strokes.length, 3);
});

test('GPU startup requests ideal 60fps moderate-size capture and retains recognition options', async () => {
  const a = await app();
  await a.start();
  assert.deepEqual(JSON.parse(JSON.stringify(a.constraints)), {
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } }, audio: false,
  });
  assert.equal(a.options.length, 1);
  assert.equal(a.options[0].baseOptions.delegate, 'GPU');
  assert.equal(a.options[0].runningMode, 'VIDEO');
  assert.equal(a.options[0].numHands, 1);
  for (const option of ['minHandDetectionConfidence', 'minHandPresenceConfidence', 'minTrackingConfidence']) {
    assert.equal(a.options[0][option], .5);
  }
  assert.equal(a.stage.style.width, '800px');
  assert.equal(a.stage.style.height, '600px');
  assert.equal(a.status.hidden, true);
});

test('GPU initialization failure falls back to CPU and drawing still works', async () => {
  const a = await app({ gpuFails: true });
  await a.start();
  assert.deepEqual(a.options.map(o => o.baseOptions.delegate), ['GPU', 'CPU']);
  assert.equal(a.options[0].baseOptions.modelAssetPath, a.options[1].baseOptions.modelAssetPath);
  a.tick(0);
  assert.equal(a.drawing.strokes.length, 1);
  assert.equal(a.status.hidden, true);
});

test('both delegate failures report the error and stop the camera', async () => {
  const a = await app({ gpuFails: true, cpuFails: true });
  await a.start();
  assert.equal(a.status.hidden, false);
  assert.match(a.status.textContent, /手の認識モデルを読み込めません/);
  assert.equal(a.trackStopped, true);
  assert.equal(a.drawing.current, null);
  // No inference is attempted after startup has stopped.
  a.tick(16);
  assert.equal(a.detections, 0);
});

test('frame loop skips duplicate frames but processes each new frame without throttling', async () => {
  const a = await app();
  await a.start();
  a.tick(0);
  a.tick(8);
  assert.equal(a.detections, 1);
  a.video.currentTime = 1 / 60;
  a.setResult(hand(.9));
  a.tick(16);
  assert.equal(a.detections, 2);
  assert.equal(a.drawing.current.length, 2);
  a.tick(267);
  assert.equal(a.drawing.current, null);
});

test('inference errors, visibility changes and video interruptions break active strokes', async () => {
  const a = await app();
  await a.start();
  a.tick(0);
  a.failDetection();
  a.video.currentTime = 1 / 60;
  a.tick(16);
  assert.equal(a.drawing.current, null);
  assert.equal(a.status.hidden, false);
  for (const event of ['visibilitychange', 'waiting', 'stalled', 'pause', 'emptied']) {
    a.drawing.update(hand(), 32);
    a.events[event]();
    assert.equal(a.drawing.current, null, event);
  }
  a.stop();
  assert.equal(a.stopped, true);
});
