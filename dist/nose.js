class Drawing {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.strokes = [];
    this.breakStroke();
  }

  breakStroke() { this.current = null; this.lastTime = null; }

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
    // Use raw video coordinates: the shared stage mirrors camera and canvas once.
    const tip = result?.faceLandmarks?.[0]?.[1];
    if (!tip || !Number.isFinite(time)
      || !Number.isFinite(tip.x) || !Number.isFinite(tip.y)
      || tip.x < 0 || tip.x > 1 || tip.y < 0 || tip.y > 1) {
      this.breakStroke();
      return;
    }
    if (this.lastTime !== null && time - this.lastTime > 250) this.breakStroke();
    const point = { x: tip.x, y: tip.y };
    if (!this.current) {
      this.current = [point];
      this.strokes.push(this.current);
      this.dot(point);
    } else {
      this.line(this.current.at(-1), point);
      this.current.push(point);
    }
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
      message('顔を認識できません。再認識を試みています。');
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
    if (stopped) return;
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
  message('顔の認識モデルを読み込んでいます…');
  try {
    // Only static library/model downloads use the network. No frames or landmarks leave the browser.
    const { FilesetResolver, FaceLandmarker } = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
    const fileset = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
    const options = {
      baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    };
    // Accelerate inference when available, retaining CPU support without changing
    // nose coordinates or adding application-level smoothing.
    try {
      landmarker = await FaceLandmarker.createFromOptions(fileset, {
        ...options, baseOptions: { ...options.baseOptions, delegate: 'GPU' },
      });
    } catch {
      if (stopped) return;
      landmarker = await FaceLandmarker.createFromOptions(fileset, {
        ...options, baseOptions: { ...options.baseOptions, delegate: 'CPU' },
      });
    }
    if (stopped) { landmarker.close(); return; }
    status.hidden = true;
    frame = requestAnimationFrame(tick);
  } catch {
    stop();
    message('顔の認識モデルを読み込めません。通信を確認して再読み込みしてください。');
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
