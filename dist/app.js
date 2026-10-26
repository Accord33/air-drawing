const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function angle(a, b, c) {
  const u = [a.x - b.x, a.y - b.y, a.z - b.z];
  const v = [c.x - b.x, c.y - b.y, c.z - b.z];
  const length = Math.hypot(...u) * Math.hypot(...v);
  if (!length) return 0;
  return Math.acos(Math.max(-1, Math.min(1, u.reduce((sum, n, i) => sum + n * v[i], 0) / length))) * 180 / Math.PI;
}

// Joint angles and distances work for either hand, including a rotated hand.
// Thumb landmarks (1–4) deliberately do not participate in the gesture.
function isDrawingGesture(points) {
  if (!points || points.length !== 21 || points.some(p => !p || ![p.x, p.y, p.z].every(Number.isFinite))) return false;
  const extended = angle(points[5], points[6], points[7]) > 160
    && angle(points[6], points[7], points[8]) > 150
    && distance(points[8], points[5]) > distance(points[6], points[5]) * 1.5;
  const curled = [9, 13, 17].every(base =>
    angle(points[base], points[base + 1], points[base + 2]) < 135
    && distance(points[base + 3], points[0]) < distance(points[base + 1], points[0]) * 1.1);
  return extended && curled;
}

class Drawing {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.strokes = [];
    this.breakStroke();
  }

  breakStroke() { this.current = null; this.hand = null; this.lastTime = null; }

  resize(width, height, ratio = devicePixelRatio || 1) {
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.context.strokeStyle = '#EA4756';
    this.context.fillStyle = '#EA4756';
    this.context.lineWidth = 5;
    this.context.lineCap = 'round';
    this.context.lineJoin = 'round';
    for (const stroke of this.strokes) {
      this.dot(stroke[0]);
      for (let i = 1; i < stroke.length; i++) this.line(stroke[i - 1], stroke[i]);
    }
    this.breakStroke();
  }

  dot(point) {
    this.context.beginPath();
    this.context.arc(point.x * this.width, point.y * this.height, 2.5, 0, Math.PI * 2);
    this.context.fill();
  }

  line(from, to) {
    this.context.beginPath();
    this.context.moveTo(from.x * this.width, from.y * this.height);
    this.context.lineTo(to.x * this.width, to.y * this.height);
    this.context.stroke();
  }

  update(result, time) {
    const landmarks = result?.landmarks?.[0];
    const geometry = result?.worldLandmarks?.[0] || landmarks;
    const tip = landmarks?.[8];
    if (!tip || !Number.isFinite(time) || !isDrawingGesture(geometry)
      || !Number.isFinite(tip.x) || !Number.isFinite(tip.y)
      || tip.x < 0 || tip.x > 1 || tip.y < 0 || tip.y > 1) {
      this.breakStroke();
      return;
    }
    const hand = result.handedness?.[0]?.[0]?.categoryName || null;
    if (hand !== this.hand || (this.lastTime !== null && time - this.lastTime > 250)) this.breakStroke();
    const point = { x: tip.x, y: tip.y };
    if (!this.current) {
      this.current = [point];
      this.strokes.push(this.current);
      this.dot(point);
    } else {
      this.line(this.current.at(-1), point);
      this.current.push(point);
    }
    this.hand = hand;
    this.lastTime = time;
  }
}


const video = document.querySelector('#camera');
const stage = document.querySelector('#stage');
const status = document.querySelector('#status');
const drawing = new Drawing(document.querySelector('#drawing'));
let landmarker;
let stream;
let frame;
let lastVideoTime = -1;
let stopped = false;

function message(text) { status.textContent = text; status.hidden = false; }

function fit() {
  if (!video.videoWidth || !video.videoHeight) return;
  const scale = Math.min(innerWidth / video.videoWidth, innerHeight / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;
  drawing.resize(width, height);
}

function stop() {
  stopped = true;
  cancelAnimationFrame(frame);
  drawing.breakStroke();
  stream?.getTracks().forEach(track => track.stop());
  landmarker?.close();
}

function tick(time) {
  if (stopped) return;
  if (document.hidden || video.readyState < 2 || video.paused || video.ended) {
    drawing.breakStroke();
  } else if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    try {
      drawing.update(landmarker.detectForVideo(video, time), time);
      status.hidden = true;
    } catch {
      drawing.breakStroke();
      message('手を認識できません。再認識を試みています。');
    }
  } else if (drawing.lastTime !== null && time - drawing.lastTime > 250) {
    drawing.breakStroke();
  }
  frame = requestAnimationFrame(tick);
}

async function start() {
  if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    message('HTTPS または localhost で、カメラ対応の Chrome を使用してください。');
    return;
  }
  try {
    // Prefer frequent, modest-size frames to reduce capture and inference latency.
    // Ideals allow cameras with lower frame rates or other sizes to keep working.
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } },
      audio: false,
    });
    if (stopped) { stream.getTracks().forEach(track => track.stop()); return; }
    video.srcObject = stream;
    await video.play();
    fit();
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      stop();
      message('カメラが切断されました。接続を確認して再読み込みしてください。');
    });
  } catch (error) {
    stop();
    message(error.name === 'NotAllowedError'
      ? 'カメラが許可されていません。ブラウザで許可して再読み込みしてください。'
      : 'カメラを開始できません。接続や他のアプリの使用を確認して再読み込みしてください。');
    return;
  }
  message('手の認識モデルを読み込んでいます…');
  try {
    // Only static library/model downloads use the network. No frames or landmarks leave the browser.
    const { FilesetResolver, HandLandmarker } = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
    const fileset = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
    const options = {
      baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task' },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    };
    // Accelerate inference when available, retaining CPU support without changing
    // gesture thresholds or adding smoothing that would delay fast movements.
    try {
      landmarker = await HandLandmarker.createFromOptions(fileset, {
        ...options, baseOptions: { ...options.baseOptions, delegate: 'GPU' },
      });
    } catch {
      if (stopped) return;
      landmarker = await HandLandmarker.createFromOptions(fileset, {
        ...options, baseOptions: { ...options.baseOptions, delegate: 'CPU' },
      });
    }
    if (stopped) { landmarker.close(); return; }
    status.hidden = true;
    frame = requestAnimationFrame(tick);
  } catch {
    stop();
    message('手の認識モデルを読み込めません。通信を確認して再読み込みしてください。');
  }
}

addEventListener('resize', fit);
video.addEventListener('resize', fit);
for (const event of ['waiting', 'stalled', 'pause', 'emptied']) video.addEventListener(event, () => drawing.breakStroke());
video.addEventListener('error', () => { stop(); message('カメラ映像を表示できません。再読み込みしてください。'); });
document.addEventListener('visibilitychange', () => drawing.breakStroke());
addEventListener('pagehide', stop);
addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
start();
