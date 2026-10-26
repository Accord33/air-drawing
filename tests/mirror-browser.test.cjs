const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { test } = require('node:test');

// Use the real HTML/CSS/app and browser layout without camera, CDN or model access.
const setup = `<script>
Object.defineProperty(navigator, 'mediaDevices', { value: {
  getUserMedia: async () => { throw new DOMException('Test camera disabled', 'NotAllowedError'); }
} });
addEventListener('load', () => {
  const output = document.createElement('pre');
  output.id = 'browser-result';
  document.body.append(output);
  try {
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    const near = (a, b) => Math.abs(a - b) < .1;
    const stage = document.querySelector('#stage');
    const video = document.querySelector('video');
    const canvas = document.querySelector('canvas');
    const nav = document.querySelector('nav');
    const link = nav.querySelector('a');
    const nosePage = location.pathname === '/nose.html';
    check(link.getAttribute('href') === (nosePage ? './index.html' : './nose.html'), 'page link target');
    check(link.textContent.includes(nosePage ? '指' : '鼻'), 'page link label');
    check(!stage.contains(nav) && !stage.contains(document.querySelector('#status')), 'UI outside mirrored stage');
    check(new DOMMatrix(getComputedStyle(nav).transform).a === 1, 'navigation stays readable');
    const ctxBefore = canvas.getContext('2d');
    check(ctxBefore.getImageData(0, 0, 1, 1).data[3] === 0, 'transparent canvas on load');
    check(video.getAttribute('aria-label').includes('左右反転した'), 'camera label');
    const marker = document.createElement('i');
    marker.style.cssText = 'position:absolute;left:20%;top:30%;width:0;height:0';
    stage.append(marker);
    for (const [width, height] of [[1280, 720], [480, 640]]) {
      Object.defineProperty(video, 'videoWidth', { configurable: true, value: width });
      Object.defineProperty(video, 'videoHeight', { configurable: true, value: height });
      video.dispatchEvent(new Event('resize'));
      const stageRect = stage.getBoundingClientRect();
      const videoRect = video.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const point = marker.getBoundingClientRect();
      const scale = Math.min(innerWidth / width, innerHeight / height);
      check(near(stageRect.width, width * scale) && near(stageRect.height, height * scale), 'aspect fit');
      for (const key of ['left', 'top', 'width', 'height']) {
        check(near(videoRect[key], canvasRect[key]), 'overlay bounds: ' + key);
      }
      check(near(point.left, stageRect.right - stageRect.width * .2), 'mirrored x coordinate');
      check(near(point.top, stageRect.top + stageRect.height * .3), 'unchanged y coordinate');
      const stageTransform = new DOMMatrix(getComputedStyle(stage).transform);
      const videoTransform = new DOMMatrix(getComputedStyle(video).transform);
      const canvasTransform = new DOMMatrix(getComputedStyle(canvas).transform);
      check(stageTransform.a * videoTransform.a === -1, 'video mirrored exactly once');
      check(stageTransform.a * canvasTransform.a === -1, 'canvas mirrored exactly once');
      check(canvas.width === Math.round(stageRect.width * devicePixelRatio), 'canvas pixel density');
      const ctx = canvas.getContext('2d');
      check(ctx.lineWidth === 5 && ctx.strokeStyle === '#ff0000', 'fixed red 5px stroke');
    }
    check(getComputedStyle(document.querySelector('#status')).transform !== getComputedStyle(stage).transform,
      'status stays readable');
    output.textContent = 'PASS: mirrored overlay, coordinates, aspect fit, resize, DPR and red 5px styling';
  } catch (error) { output.textContent = 'FAIL: ' + error.message; }
});
</script>`;

for (const page of ['/', '/nose.html']) test(`Chromium renders ${page} with aligned mirrored overlay and readable page links`, { timeout: 20000 }, async () => {
  assert.ok(process.env.CHROMIUM_BIN, 'Set CHROMIUM_BIN to a local Chromium executable');
  const server = http.createServer((req, res) => {
    const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/nose.html': ['nose.html', 'text/html'], '/nose.js': ['nose.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'] };
    const file = files[req.url];
    if (!file) { res.writeHead(404).end(); return; }
    let content = readFileSync(`${__dirname}/../dist/${file[0]}`, 'utf8');
    if (file[1] === 'text/html') content = content.replace('</head>', setup + '</head>');
    res.writeHead(200, { 'Content-Type': file[1], 'Content-Security-Policy': "connect-src 'self'" });
    res.end(content);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = spawn(process.env.CHROMIUM_BIN, [
      '--headless', '--no-sandbox', '--disable-gpu', '--no-proxy-server', '--disable-background-networking',
      '--disable-extensions', '--no-first-run', '--no-default-browser-check',
      '--force-device-scale-factor=2', '--window-size=1000,700', '--dump-dom', '--timeout=10000',
      `http://127.0.0.1:${server.address().port}${page}`,
    ], { timeout: 15000 });
    let stdout = '';
    let stderr = '';
    browser.stdout.on('data', data => { stdout += data; });
    browser.stderr.on('data', data => { stderr += data; });
    const code = await new Promise((resolve, reject) => { browser.on('close', resolve); browser.on('error', reject); });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /<pre id="browser-result">PASS:/, stdout);
  } finally {
    browser?.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
