// main.js — 3D 垂直切片「在场感样片」主程序
// spec: 3d/specs/slice-spec.md §0-§10 · 纯 ES modules · 零 CDN · 零图片资产
import * as THREE from 'three';
import { GLTFLoader } from './GLTFLoader.js';
import {
  makePaperTexture, makeRainMaterial, makeSilhouetteTexture, makeSketchTexture,
} from './paper.js';

/* ═══════════ 状态与本地存储 ═══════════ */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};
const S = {
  audio: store.get('rg3d-audio', 'on') === 'on',
  calm: store.get('rg3d-calm', 'off') === 'on',
  song: parseInt(store.get('rg3d-song', '0'), 10) || 0,
  peek: false,      // 长按中
  peekT: 0,         // 前移插值 0→1
};
const SONGS = [
  { name: 'A 小调 · 行板', notes: [220.0, 261.63, 329.63, 392.0], step: 2.0, wave: 'triangle', bright: 1.0 },
  { name: 'C 大调 · 慢板', notes: [261.63, 329.63, 392.0, 523.25], step: 2.6, wave: 'sine', bright: 0.7 },
  { name: 'D 小调 · 夜行', notes: [293.66, 349.23, 440.0, 587.33], step: 1.55, wave: 'sawtooth', bright: 0.45 },
];

/* ═══════════ DOM ═══════════ */
const $ = (id) => document.getElementById(id);
const wrap = $('wrap'), cvs = $('gl'), loadEl = $('loading'), hintEl = $('hint');
const peekEl = $('peek'), songEl = $('song'), dbg = $('dbg');

/* ═══════════ 渲染器 / 场景 / 相机 ═══════════ */
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: cvs, antialias: true, powerPreference: 'low-power' });
} catch (e) {
  $('nogl').style.display = 'flex';
  loadEl.style.display = 'none';
  throw e;
}
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;
renderer.shadowMap.enabled = false;                       // 无阴影（spec §3/§9）
const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a1020);
scene.fog = new THREE.Fog(0x0a1020, 9, 16);

const V = new URLSearchParams(location.search).get('v') === 'B' ? 'B' : 'A';
const CAMS = {
  // three 惯例：yaw=π/2 时 forward=(-1,0,0)、screen-right=-z（+z 墙在画面左）。
  // A 坐近侧长凳(0.9,-0.82)：视线方程解得 yaw=π/2+0.435 → TA(-1.6,+0.9) 在画面左 9.4°，
  //   正对 window_L0 雨窗（TA 距玻璃 0.36m，剪影贴窗），右缘留端墙纵深
  A: { pos: [0.95, 1.23, -0.66], yaw: Math.PI / 2 + 0.69, fovP: 62 },  // 坐凳 POV：TA 正对雨窗（Lead 校准）
  // B 站走道中段(2.2,0)：yaw=π/2+0.10 → TA 在左 7.6°，雨窗部分入画，端墙纵深居中
  B: { pos: [2.2, 1.45, 0.0],   yaw: Math.PI / 2 + 0.10, fovP: 66 },
};
const CV = CAMS[V];
const camera = new THREE.PerspectiveCamera(CV.fovP, 1, 0.05, 40);
const CAM_BASE = new THREE.Vector3(...CV.pos);
const PEEK_DIST = 0.15;                                    // 倾身 15cm
camera.position.copy(CAM_BASE);
camera.rotation.set(0, CV.yaw, 0);
camera.rotation.order = 'YXZ';                             // yaw→pitch→roll，晃动叠加更稳

/* ═══════════ 灯光（不开实时阴影） ═══════════ */
const warmLight = new THREE.PointLight(0xffd9a0, 14, 9, 1.8);   // 2800K 感顶灯
warmLight.position.set(0, 2.15, 0);
scene.add(warmLight);
const coolA = new THREE.PointLight(0x4870a8, 3.2, 7, 1.6);      // 窗侧轮廓光 ×2
coolA.position.set(-1.85, 1.45, 1.05);   // 近窗侧
const coolB = new THREE.PointLight(0x4870a8, 2.6, 7, 1.6);
coolB.position.set(1.2, 1.45, -1.05);    // 远窗侧
scene.add(coolA, coolB);
scene.add(new THREE.AmbientLight(0x25324a, 1.5));               // 深蓝夜环境垫底

/* ═══════════ 车厢 GLB ═══════════ */
const sharedTime = { value: 0 };                                 // 雨窗共享 uTime
const paperTex = makePaperTexture();
paperTex.repeat.set(2, 2);
const lampMatRefs = [];                                          // 频闪要压的灯带材质
const coolWinMats = [];                                          // 频闪要亮的窗底材质

new GLTFLoader().load('assets/carriage.glb', (gltf) => {
  const root = gltf.scene;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const old = o.material;
    // 纸板材质统一加纸纹微扰；灯带/玻璃按名接管
    const n = o.name || '';
    if (n.includes('lamp') || n.includes('lightstrip')) {
      old.emissive = new THREE.Color(0xffcc7a);
      old.emissiveIntensity = 2.4;
      lampMatRefs.push(old);
    } else if (n.includes('window')) {
      old.color.setHex(0x071120);
      coolWinMats.push(old);
    } else {
      old.map = paperTex;
      old.color.setHex(0xffffff);
      old.roughness = 0.9;
    }
    o.material = old;
  });
  scene.add(root);
  // 每扇窗内侧贴雨窗 shader 平面（6 扇，与 car_window_* 对位）
  const winX = [-1.85, 0, 1.85], winH = 1.0, winY = 1.45, wy = 1.205;
  winX.forEach((x) => {
    [1, -1].forEach((sy) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1.28, winH),
        makeRainMaterial(sharedTime),
      );
      m.position.set(x, winY, sy * wy);
      m.rotation.y = sy > 0 ? Math.PI : 0;   // 面向车厢内侧
      scene.add(m);
    });
  });
  buildDressing();
  buildCharacter();
  hideLoading();
}, undefined, (err) => { console.error(err); fail('车厢加载失败'); });

/* ═══════════ 车内陈设（three 程序化：速写本 / 翻页） ═══════════ */
let book, bookPageA, bookPageB, bookPivot;
function buildDressing() {
  bookPivot = new THREE.Group();
  // TA 坐在斜前方隔两座：靠窗排，x≈-0.2 附近，面向车内
  bookPivot.position.set(-1.55, 0.66, 0.62);
  bookPivot.rotation.set(-0.35, 0.25, 0.06);
  const cover = new THREE.Mesh(
    new THREE.BoxGeometry(0.24, 0.012, 0.32),
    new THREE.MeshStandardMaterial({ color: 0x4a4238, roughness: 0.85 }),
  );
  bookPivot.add(cover);
  const pageGeo = new THREE.PlaneGeometry(0.22, 0.30);
  bookPageA = new THREE.Mesh(pageGeo, new THREE.MeshBasicMaterial({
    map: makeSketchTexture(false), side: THREE.DoubleSide,
  }));
  bookPageA.rotation.x = -Math.PI / 2;
  bookPageA.position.y = 0.008;
  bookPageB = new THREE.Mesh(pageGeo, new THREE.MeshBasicMaterial({
    map: makeSketchTexture(true), side: THREE.DoubleSide,
  }));
  bookPageB.rotation.x = -Math.PI / 2;
  bookPageB.position.y = 0.010;
  bookPageB.visible = false;
  bookPivot.add(bookPageA, bookPageB);
  // 笔
  const pen = new THREE.Mesh(
    new THREE.CylinderGeometry(0.006, 0.006, 0.14, 10),
    new THREE.MeshStandardMaterial({ color: 0x1c1a18, roughness: 0.5 }),
  );
  pen.position.set(0.05, 0.012, -0.06);
  pen.rotation.z = 0.9;
  bookPivot.add(pen);
  scene.add(bookPivot);
}

/* ═══════════ TA：剪影 billboard（无五官） ═══════════ */
let figure;
function buildCharacter() {
  const tex = makeSilhouetteTexture();
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false,
  });
  figure = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 1.06), mat);
  // 坐在斜前方隔两座的靠窗位（与速写本同位：x≈-0.2，靠窗 z≈0.75）
  figure.position.set(-1.6, 0.95, 0.9);    // 对侧长凳坐位（背后=雨窗）
  figure.rotation.y = 2.1;                  // 面向镜头方向，微侧身
  scene.add(figure);
}

/* ═══════════ 隧道频闪（每 18-22s 一次，0.35s） ═══════════ */
let flashAt = 6 + Math.random() * 4;   // 首次 6-10s 后，之后 18-22s 周期
let flashT = -1;
function tickFlash(dt, t) {
  if (flashT < 0 && t >= flashAt) { flashT = 0; flashAt = t + 18 + Math.random() * 4; }
  if (flashT < 0) return;
  flashT += dt;
  const D = 0.35;
  let k;
  if (flashT < D) k = Math.sin((flashT / D) * Math.PI);   // 起一落一
  else { k = 0; flashT = -1; }
  const flick = 0.12 * Math.random();
  const kk = Math.min(1, k + flick * k);
  // 顶灯带压暗 60%、窗外冷光变亮
  const lampK = 1 - 0.60 * kk;
  lampMatRefs.forEach((m) => { m.emissiveIntensity = 2.4 * lampK; });
  warmLight.intensity = 14 * (0.55 + 0.45 * lampK);
  const coolK = 1 + 1.9 * kk;
  coolA.intensity = 3.2 * coolK;
  coolB.intensity = 2.6 * coolK;
  coolWinMats.forEach((m) => { m.color.setRGB(0.03 + 0.16 * kk, 0.05 + 0.22 * kk, 0.09 + 0.36 * kk); });
}

/* ═══════════ 轨道晃动（正弦双频；减晃可关） ═══════════ */
function tickSway(t) {
  const g = S.calm ? 0 : 1;
  const pitch = THREE.MathUtils.degToRad(0.6) * Math.sin(t * (Math.PI * 2 / 3.8)) * g;
  const roll = THREE.MathUtils.degToRad(0.4) * Math.sin(t * (Math.PI * 2 / 0.9) + 1.3) * g;
  const heave = 0.008 * Math.sin(t * (Math.PI * 2 / 3.8) * 2 + 0.6) * g;
  // 倾身前移：沿视线（-x）前移 15cm，ease-out
  const target = S.peek ? 1 : 0;
  S.peekT += (target - S.peekT) * (S.peek ? 1 - Math.pow(0.0005, 0.016) : 1 - Math.pow(0.002, 0.016));
  const e = 1 - Math.pow(1 - S.peekT, 3);   // ease-out cubic
  camera.position.set(
    CAM_BASE.x - PEEK_DIST * e,
    CAM_BASE.y + heave,
    CAM_BASE.z,
  );
  camera.rotation.x = pitch;
  camera.rotation.z = roll;
}

/* ═══════════ 音频（Web Audio 程序化） ═══════════ */
const AU = {
  ac: null, master: null, started: false, songI: 0,
  rainG: null, rainPan: null, trackG: null, nextNote: 0, noteI: 0, bar0: 0,
  init() {
    if (this.started) return;
    this.started = true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ac = new AC();
      this.master = this.ac.createGain();
      this.master.gain.value = S.audio ? 0.4 : 0;   // ≈-18dB 不刺耳
      this.master.connect(this.ac.destination);
      // 雨声：白噪 → 带通 600-4000 → StereoPanner 偏窗外侧（右侧）
      const len = this.ac.sampleRate * 2;
      const buf = this.ac.createBuffer(1, len, this.ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = this.ac.createBufferSource(); src.buffer = buf; src.loop = true;
      const bp = this.ac.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = 1800; bp.Q.value = 0.5;   // 宽带 600-4000
      this.rainG = this.ac.createGain(); this.rainG.gain.value = 0.05;
      this.rainPan = this.ac.createStereoPanner(); this.rainPan.pan.value = 0.55;
      src.connect(bp); bp.connect(this.rainG); this.rainG.connect(this.rainPan);
      this.rainPan.connect(this.master); src.start();
      // 轨道低频：由节拍器触发 40-60Hz 脉冲（周期与晃动 3.8s 呼应）
      this.trackG = this.ac.createGain(); this.trackG.gain.value = 0.5;
      this.trackG.connect(this.master);
      this.nextNote = this.ac.currentTime + 0.2;
      this.bar0 = this.ac.currentTime;
      setInterval(() => this.schedule(), 120);
      // 琶音从第 8 秒后淡入：用一个 slow gain
      this.pianoG = this.ac.createGain(); this.pianoG.gain.value = 0;
      this.pianoG.connect(this.master);
      this.pianoG.gain.setTargetAtTime(0.5, this.ac.currentTime + 8, 3);
    } catch (e) {}
  },
  schedule() {
    if (!this.ac) return;
    const t = this.ac.currentTime;
    while (this.nextNote < t + 0.3) {
      const tt = Math.max(this.nextNote, t);
      // 轨道脉冲：每 1.9s 一对（与 3.8s 晃动同周期）
      if (this.stepN % 14 === 0) this.pulse(tt, 52, 0.30);
      if (this.stepN % 14 === 7) this.pulse(tt, 44, 0.22);
      // 琶音：4 秒一循环（4 音 × 1s）
      const song = SONGS[this.songI];
      if ((this.stepN % 4) === 0) {
        this.pluck(tt, song.notes[(this.stepN / 4) % 4], song);
      }
      this.stepN = (this.stepN || 0) + 1;
      this.nextNote += 0.25;
    }
  },
  pulse(t, f, dur) {
    const o = this.ac.createOscillator(), g = this.ac.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.trackG);
    o.start(t); o.stop(t + dur + 0.05);
  },
  pluck(t, f, song) {
    const o = this.ac.createOscillator(), g = this.ac.createGain();
    o.type = song.wave;
    o.frequency.value = f;
    const lp = this.ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 900 + 1400 * song.bright;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.085, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + song.step);
    o.connect(lp); lp.connect(g); g.connect(this.pianoG);
    o.start(t); o.stop(t + song.step + 0.1);
  },
  setSong(i) {
    this.songI = i; S.song = i; store.set('rg3d-song', String(i));
    SONGS.forEach((s, k) => $('song' + k).classList.toggle('on', k === i));
  },
  toggle() {
    S.audio = !S.audio;
    store.set('rg3d-audio', S.audio ? 'on' : 'off');
    $('audioBtn').classList.toggle('off', !S.audio);
    if (this.master) this.master.gain.setTargetAtTime(S.audio ? 0.4 : 0, this.ac.currentTime, 0.05);
  },
};
document.addEventListener('pointerdown', () => AU.init(), { once: false });
$('audioBtn').addEventListener('click', (e) => { e.stopPropagation(); AU.init(); AU.toggle(); });

/* ═══════════ 交互 1：长按倾身 ═══════════ */
function peekStart(e) {
  if (e.target.closest && e.target.closest('#audioBtn,#song,.ui')) return;
  AU.init();
  S.peek = true;
  document.body.classList.add('peeking');
  setTimeout(() => { if (S.peek) { bookPageB.visible = true; bookPageA.visible = false; } }, 380);
}
function peekEnd() {
  if (!S.peek) return;
  S.peek = false;
  document.body.classList.remove('peeking');
  setTimeout(() => { if (!S.peek) { bookPageA.visible = true; bookPageB.visible = false; } }, 320);
}
wrap.addEventListener('pointerdown', peekStart);
document.addEventListener('pointerup', peekEnd);
document.addEventListener('pointercancel', peekEnd);
document.addEventListener('contextmenu', (e) => { if (!e.target.closest || !e.target.closest('.ui')) e.preventDefault(); });

/* ═══════════ 交互 2：耳机三选一 ═══════════ */
[0, 1, 2].forEach((i) => {
  const el = $('song' + i);
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    AU.init();
    AU.setSong(i);
  });
});
AU.setSong(S.song);   // 恢复选中态（不初始化 AC）

/* 减晃开关 */
$('calmBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  S.calm = !S.calm;
  store.set('rg3d-calm', S.calm ? 'on' : 'off');
  $('calmBtn').classList.toggle('on', S.calm);
});
$('calmBtn').classList.toggle('on', S.calm);
$('audioBtn').classList.toggle('off', !S.audio);

/* ═══════════ 加载遮罩 ═══════════ */
let loadHidden = false;
function hideLoading() {
  if (loadHidden) return;
  loadHidden = true;
  loadEl.classList.add('off');
  setTimeout(() => { loadEl.style.display = 'none'; }, 650);
}
function fail(msg) {
  document.querySelector('#nogl .ng-t').textContent = msg || '需要 WebGL';
  $('nogl').style.display = 'flex';
  loadEl.style.display = 'none';
}

/* ═══════════ 自适应画布 ═══════════ */
function resize() {
  const r = wrap.getBoundingClientRect();
  const w = r.width, h = r.height;
  renderer.setSize(w, h, false);
  const portrait = h >= w;
  camera.fov = portrait ? CV.fovP : 65;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 120));
resize();

/* ═══════════ 主循环 ═══════════ */
const clock = new THREE.Clock();
const fps = { ema: 0, pt: 0, t0: 0 };
function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;
  sharedTime.value = t;
  tickSway(t);
  tickFlash(dt, t);
  // 速写本轻微漂浮（呼吸感）
  if (bookPivot) {
    bookPivot.position.y = 0.66 + Math.sin(t * 1.1) * 0.006;
    bookPivot.rotation.z = 0.08 + Math.sin(t * 0.7) * 0.02;
  }
  // 暗角（长按时加深）
  document.documentElement.style.setProperty('--vig', S.peek ? 0.55 : 0);
  renderer.render(scene, camera);
  // FPS：帧时 EMA 滑动平均（1s 更新一次显示）
  const now = performance.now();
  if (fps.pt) {
    const inst = 1000 / Math.max(1, now - fps.pt);
    fps.ema = fps.ema ? fps.ema * 0.92 + inst * 0.08 : inst;
  }
  fps.pt = now;
  if (!fps.t0) fps.t0 = now;
  if (now - fps.t0 >= 1000) {
    fps.t0 = now;
    if (dbg) dbg.textContent = 'fps ' + Math.round(fps.ema);
  }
}
loop();
