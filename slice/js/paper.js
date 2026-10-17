// paper.js — 程序化纹理与着色器（零图片资产）
// 依 spec §4/§8：雨窗 ShaderMaterial、纸纹噪波、无五官剪影贴图、速写本线稿。
// 全部由 canvas / GLSL 生成，分辨率无关，uTime 驱动。

import * as THREE from 'three';

/* ── 纸纹：canvas 噪波，供材质颜色微扰 / roughnessMap ───────── */
export function makePaperTexture(size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#b8b0a2';
  g.fillRect(0, 0, size, size);
  // 纸纤维：细密短划
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < size * 3; i++) {
    const x = rnd() * size, y = rnd() * size;
    const l = 2 + rnd() * 7, a = rnd() * Math.PI;
    g.strokeStyle = rnd() > 0.5 ? 'rgba(255,252,244,0.05)' : 'rgba(70,60,48,0.045)';
    g.lineWidth = 0.6;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
  // 斑点噪波
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 22;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ── 雨窗 ShaderMaterial：两层斜向雨痕 + 挂水珠 + 深蓝底 + 窗外暖灯斑 ── */
const RAIN_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RAIN_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uSeed;
  uniform vec3 uBase;
  uniform vec3 uGlow;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  /* 一层斜向雨痕：按列 hash 相位，竖线向下滚动，头亮尾淡 */
  float streak(vec2 uv, float scale, float slant, float speed, float t) {
    float x = uv.x * scale + uv.y * slant + uSeed * 3.1;
    float col = floor(x);
    float fx = fract(x);
    float phase = hash(vec2(col, 7.3));
    float on = step(0.30, hash(vec2(col, 2.9)));
    float y = fract(uv.y * 0.92 + phase - t * speed);
    float line = 1.0 - smoothstep(0.008, 0.045, fx);
    float tail = pow(1.0 - y, 2.4);
    return line * tail * on;
  }

  /* 挂水珠：网格 hash + 拉长的滴形（缓慢下滑）+ 细尾迹 */
  float on2(float h) { return step(0.25, h); }
  float drops(vec2 uv, float t) {
    vec2 grid = vec2(13.0, 17.0);
    vec2 f = fract(uv * grid);
    vec2 cell = floor(uv * grid);
    float h = hash(cell + uSeed);
    float cx = 0.30 + 0.40 * hash(cell + 1.7);
    float cy = 0.30 + 0.40 * hash(cell + 9.1);
    float sp = 0.010 + 0.028 * hash(cell + 3.3);
    float y = fract(cy - t * sp);
    vec2 dvec = f - vec2(cx, y);
    dvec.y *= 1.7;                       /* 拉长成挂滴 */
    float drop = 1.0 - smoothstep(0.03, 0.11, length(dvec));
    float trail = (1.0 - smoothstep(0.0, 0.055, abs(f.x - cx))) *
                  (1.0 - smoothstep(y + 0.06, y + 0.42, f.y)) * on2(h);
    float vis = step(0.68, h);
    return (drop + trail * 0.35) * vis;
  }

  void main() {
    vec2 uv = vUv;
    /* 深蓝夜底：上亮下暗 */
    vec3 col = mix(uBase * 0.55, uBase, uv.y);
    /* 窗外暖灯斑（呼吸） */
    float glow = exp(-length((uv - vec2(0.70, 0.60)) * vec2(1.7, 1.05)) * 3.0);
    col += uGlow * glow * (0.42 + 0.14 * sin(uTime * 0.8 + uSeed));
    /* 远景城市灯点（冷色微闪） */
    vec2 gp = floor(uv * vec2(38.0, 22.0));
    float gh = hash(gp + uSeed);
    float city = step(0.94, gh) * (0.20 + 0.22 * sin(uTime * 1.6 + gh * 40.0) + 0.3);
    col += vec3(0.30, 0.42, 0.62) * city * 0.28;
    /* 两层雨痕（不同速度/透明度/斜向） */
    float s1 = streak(uv, 8.0, 2.6, 0.10, uTime);
    float s2 = streak(uv, 15.0, -1.9, 0.17, uTime);
    col += vec3(0.58, 0.68, 0.85) * (s1 * 0.22 + s2 * 0.13);
    /* 挂水珠 */
    col += vec3(0.66, 0.74, 0.90) * drops(uv, uTime) * 0.55;
    /* 轻暗角，低亮度收尾 */
    float vig = 1.0 - smoothstep(0.35, 1.25, length(uv - 0.5));
    col *= mix(0.72, 1.0, vig);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function makeRainMaterial(sharedTime) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: sharedTime,          // 共享同一 uniform 对象 → 一次更新全体窗口
      uSeed: { value: Math.random() * 10 },
      uBase: { value: new THREE.Color(0.028, 0.045, 0.085) },
      uGlow: { value: new THREE.Color(1.0, 0.78, 0.45) },
    },
    vertexShader: RAIN_VERT,
    fragmentShader: RAIN_FRAG,
    side: THREE.DoubleSide,
  });
}

/* ── 剪影贴图：TA 的背影轮廓（头/颈/肩身/马尾/帆布包）——绝无五官 ── */
export function makeSilhouetteTexture(w = 512, h = 896) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  const ink = '#15161c';
  g.fillStyle = ink;
  g.shadowColor = 'rgba(21,22,28,0.9)';
  g.shadowBlur = 10;
  const cx = w * 0.5;
  // 肩与上身（梯形圆角，坐姿）
  g.beginPath();
  g.moveTo(cx - w * 0.34, h);
  g.quadraticCurveTo(cx - w * 0.36, h * 0.52, cx - w * 0.20, h * 0.42);
  g.quadraticCurveTo(cx - w * 0.06, h * 0.345, cx, h * 0.34);
  g.quadraticCurveTo(cx + w * 0.06, h * 0.345, cx + w * 0.20, h * 0.42);
  g.quadraticCurveTo(cx + w * 0.36, h * 0.52, cx + w * 0.34, h);
  g.closePath();
  g.fill();
  // 头（微低）
  g.beginPath();
  g.ellipse(cx, h * 0.235, w * 0.145, h * 0.125, -0.06, 0, Math.PI * 2);
  g.fill();
  // 颈
  g.fillRect(cx - w * 0.075, h * 0.30, w * 0.15, h * 0.07);
  // 马尾（头后侧一条弯垂）
  g.beginPath();
  g.moveTo(cx - w * 0.10, h * 0.20);
  g.quadraticCurveTo(cx - w * 0.26, h * 0.30, cx - w * 0.20, h * 0.46);
  g.quadraticCurveTo(cx - w * 0.16, h * 0.56, cx - w * 0.10, h * 0.58);
  g.quadraticCurveTo(cx - w * 0.15, h * 0.44, cx - w * 0.02, h * 0.27);
  g.closePath();
  g.fill();
  // 帆布包（身侧）+ 背带
  g.fillRect(cx - w * 0.40, h * 0.70, w * 0.20, h * 0.155);
  g.beginPath();
  g.moveTo(cx - w * 0.22, h * 0.44);
  g.lineTo(cx - w * 0.34, h * 0.70);
  g.lineWidth = w * 0.035;
  g.strokeStyle = ink;
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ── 速写本纸页线稿：page=false 空白页 / true 车厢线稿（手绘抖动线） ── */
export function makeSketchTexture(withDrawing = true, w = 512, h = 680) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#FFFDF6';
  g.fillRect(0, 0, w, h);
  // 纸边轻微阴影
  g.strokeStyle = 'rgba(90,80,64,0.16)';
  g.lineWidth = 3;
  g.strokeRect(6, 6, w - 12, h - 12);
  let seed = 42;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const wobble = (x1, y1, x2, y2, amp) => {
    g.beginPath();
    g.moveTo(x1 + (rnd() - 0.5) * amp, y1 + (rnd() - 0.5) * amp);
    const n = 4;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      g.lineTo(x1 + (x2 - x1) * t + (rnd() - 0.5) * amp, y1 + (y2 - y1) * t + (rnd() - 0.5) * amp);
    }
    g.stroke();
  };
  g.strokeStyle = '#4a4438';
  g.lineWidth = 2.2;
  g.lineCap = 'round';
  if (!withDrawing) {
    // 空白页：两三行极淡底线
    g.strokeStyle = 'rgba(74,68,56,0.35)';
    wobble(w * 0.14, h * 0.80, w * 0.42, h * 0.79, 2);
    wobble(w * 0.14, h * 0.86, w * 0.30, h * 0.86, 2);
  } else {
    // 车厢内轮廓（透视）+ 窗 + 座位线 + 窗外灯
    wobble(w * 0.10, h * 0.24, w * 0.90, h * 0.20, 5);   // 顶线
    wobble(w * 0.10, h * 0.72, w * 0.90, h * 0.76, 5);   // 地线
    wobble(w * 0.10, h * 0.24, w * 0.10, h * 0.72, 4);   // 左缘
    wobble(w * 0.90, h * 0.20, w * 0.90, h * 0.76, 4);   // 右缘
    wobble(w * 0.20, h * 0.36, w * 0.55, h * 0.33, 4);   // 窗上沿
    wobble(w * 0.20, h * 0.58, w * 0.55, h * 0.56, 4);   // 窗下沿
    wobble(w * 0.20, h * 0.36, w * 0.20, h * 0.58, 4);
    wobble(w * 0.55, h * 0.33, w * 0.55, h * 0.56, 4);
    // 窗外那盏灯（唯一暖点，与雨窗 shader 的灯斑呼应）
    g.strokeStyle = '#8a6a3a';
    g.lineWidth = 2.6;
    g.beginPath();
    g.arc(w * 0.38, h * 0.45, w * 0.055, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = 'rgba(138,106,58,0.5)';
    for (let i = 1; i <= 3; i++) {
      g.beginPath();
      g.arc(w * 0.38, h * 0.45, w * 0.055 + i * w * 0.03, 0, Math.PI * 2);
      g.stroke();
    }
    g.strokeStyle = '#4a4438';
    g.lineWidth = 2.2;
    // 座位与扶杆短线
    wobble(w * 0.62, h * 0.62, w * 0.84, h * 0.64, 4);
    wobble(w * 0.68, h * 0.34, w * 0.68, h * 0.62, 4);
    wobble(w * 0.30, h * 0.80, w * 0.52, h * 0.795, 2); // 签名横线
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
