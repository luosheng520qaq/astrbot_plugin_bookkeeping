/* ============================================================
 * liquidGlass.js — iOS 风格「真液体玻璃」WebGL 渲染引擎
 * ------------------------------------------------------------
 * 独立模块，与业务代码完全解耦。负责：
 *   1. WebGL 上下文 / GLSL 着色器 / FBO 渲染管线
 *   2. 动画循环 + 指针阻尼（Lerp）
 *   3. PC 鼠标微 3D 视差 + 镜面高光跟随；移动端触控压痕回弹
 *
 * 底层原理（学习并借鉴开源方案）：
 *   - ybouane/liquidglass（src/shaders.ts）：
 *       • 倒角高度场 bevelHeight(d, zR) 构造凸透镜横截面曲率，有限差分求法线
 *       • 双表面（双凸）折射：Snell 定律 refrPow = 1 - 1/ior
 *       • 9-tap 高斯模糊（H→V 两次分离）做毛玻璃底
 *       • 边缘加权色散 + 菲涅尔 pow(1-|N.z|,4) + 多光源 Blinn-Phong + 内描边
 *   - aliajafari/Liquid-Glass-with-WebGL（src/shaders/fragment.glsl）：
 *       • 圆角矩形 SDF + 透镜畸变 + 边缘色散 + 霜噪 + 边缘辉光
 *
 * 与本项目背景的适配：本应用的“背景”就是渐变 + 二次元壁纸，因此无需
 * html2canvas 抓取 DOM，直接在 WebGL 中把渐变/壁纸渲染到 FBO 即可。
 *
 * 用法：
 *   import { LiquidGlass } from "./liquidGlass.js";
 *   const lg = new LiquidGlass({ selector: ".bk-card, .bk-sidebar", ... });
 *   if (lg.mount(document.body)) document.documentElement.classList.add("lg-active");
 *   lg.setWallpaper("https://.../img.jpg"); // 可选（需 CORS）
 *   lg.destroy();
 * ============================================================ */

/* ---------------- GLSL 着色器源码 ---------------- */

const VERT_FULLSCREEN = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG_BACKGROUND = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_wallpaper;
uniform float u_has_wallpaper;
uniform vec3 u_c0;
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform vec3 u_c3;
uniform vec2 u_img_size;
uniform vec2 u_canvas_size;

void main() {
  vec3 g = u_c0;
  g = mix(g, u_c1, smoothstep(0.0, 0.5, v_uv.y));
  g = mix(g, u_c2, smoothstep(0.3, 0.8, v_uv.y));
  g = mix(g, u_c3, smoothstep(0.55, 1.0, v_uv.y));
  vec3 col = g;
  if (u_has_wallpaper > 0.5) {
    // cover 等比裁切，避免拉伸变形
    vec2 img = max(u_img_size, vec2(1.0));
    vec2 s = u_canvas_size / img;
    float sc = max(s.x, s.y);
    vec2 ns = img * sc;
    vec2 off = (u_canvas_size - ns) * 0.5;
    vec2 p = v_uv * u_canvas_size - off;
    vec2 uv = clamp(p / ns, 0.0, 1.0);
    col = texture2D(u_wallpaper, uv).rgb;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

const FRAG_COPY = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
void main() {
  gl_FragColor = texture2D(u_tex, v_uv);
}
`;

/* 9-tap 单方向高斯模糊（借鉴 ybouane/liquidglass） */
const FRAG_BLUR = `
precision mediump float;
uniform sampler2D u_tex;
uniform vec2 u_dir;
varying vec2 v_uv;
void main() {
  vec4 s  = texture2D(u_tex, v_uv) * 0.227027;
  s += texture2D(u_tex, v_uv + u_dir * 1.0) * 0.194594;
  s += texture2D(u_tex, v_uv - u_dir * 1.0) * 0.194594;
  s += texture2D(u_tex, v_uv + u_dir * 2.0) * 0.121622;
  s += texture2D(u_tex, v_uv - u_dir * 2.0) * 0.121622;
  s += texture2D(u_tex, v_uv + u_dir * 3.0) * 0.054054;
  s += texture2D(u_tex, v_uv - u_dir * 3.0) * 0.054054;
  s += texture2D(u_tex, v_uv + u_dir * 4.0) * 0.016216;
  s += texture2D(u_tex, v_uv - u_dir * 4.0) * 0.016216;
  gl_FragColor = s;
}
`;

/* 玻璃面板顶点着色器：把局部 [0,1] 四边形定位到面板 NDC 区域 */
const VERT_GLASS = `
attribute vec2 a_local;
uniform vec2 u_center;
uniform vec2 u_half;
void main() {
  gl_Position = vec4(u_center + (a_local - 0.5) * 2.0 * u_half, 0.0, 1.0);
}
`;

/* 玻璃面板片元着色器 — 核心液体玻璃合成 */
const FRAG_GLASS = `
precision highp float;
uniform sampler2D u_bgTex;
uniform sampler2D u_blurTex;
uniform vec2 u_size;          // 面板尺寸 px
uniform float u_radius;       // 圆角半径 px
uniform vec2 u_res;           // canvas 绘制缓冲 px
uniform vec2 u_origin;        // 面板左下角原点 px（y 向上）
uniform float u_refract;
uniform float u_chroma;
uniform float u_edgeHL;
uniform float u_hover;
uniform float u_fresnel;
uniform float u_distort;
uniform float u_zRadius;
uniform float u_alpha;
uniform float u_sat;
uniform float u_tint;
uniform float u_brightness;
uniform vec2 u_pointer;       // 面板局部 [0,1]，y 向上
uniform float u_pointer_active;
uniform float u_pointer_radius;
uniform vec2 u_tilt;          // 全局 [-1,1]，y 向上

float rrSDF(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + vec2(r);
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - r;
}
// 倒角高度场：半圆横截面（中心平滑凸起、边缘陡峭）
float bevelHeight(float d, float zR) {
  if (d <= 0.0) return 0.0;
  if (d >= zR) return zR;
  return sqrt(d * (2.0 * zR - d));
}
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 frag = gl_FragCoord.xy;              // 设备像素，y 向上
  vec2 local = frag - u_origin;             // 面板局部像素 [0,size]
  vec2 cp = local - u_size * 0.5;           // 居中坐标
  vec2 half_ = u_size * 0.5;
  float r = min(u_radius, min(half_.x, half_.y));

  float sdf = rrSDF(cp, half_, r);
  float mask = 1.0 - smoothstep(-1.5, 0.5, sdf);
  if (mask < 0.004) discard;

  float inside = -sdf;
  float maxD = min(half_.x, half_.y);
  float edge = smoothstep(maxD * 0.35, 0.0, inside);

  // 倒角法线（有限差分）
  float zR = max(u_zRadius, 1.0);
  vec2 l01 = local / u_size;                 // [0,1]，y 向上
  vec2 dp = l01 - u_pointer;
  float dist = length(dp);
  float dip = u_pointer_active * exp(-(dist * dist) / (u_pointer_radius * u_pointer_radius));

  float e = 2.0;
  float dC = inside;
  float dR = -rrSDF(cp + vec2(e, 0.0), half_, r);
  float dL = -rrSDF(cp - vec2(e, 0.0), half_, r);
  float dU = -rrSDF(cp + vec2(0.0, e), half_, r);
  float dD = -rrSDF(cp - vec2(0.0, e), half_, r);
  float hC = bevelHeight(dC, zR);
  float hR = bevelHeight(dR, zR);
  float hL = bevelHeight(dL, zR);
  float hU = bevelHeight(dU, zR);
  float hD = bevelHeight(dD, zR);
  vec2 hGrad = vec2(hR - hL, hU - hD) / (2.0 * e);

  // 触控压痕：法线被吸向指针；抬起后 active 衰减自然回弹
  hGrad += (dp / max(dist, 0.0001)) * dip * zR * 0.15;
  // 微 3D 视差倾斜
  hGrad += u_tilt * 0.12;

  vec3 N = normalize(vec3(-hGrad, 1.0));
  float depth = smoothstep(0.0, zR, inside);

  // 双凸折射（Snell 定律）
  vec2 pxToUV = vec2(1.0, -1.0) / u_res;
  float ior = 1.5;
  float refrPow = 1.0 - 1.0 / ior;
  vec2 refrPx = hGrad * refrPow * 2.0 * u_refract * 30.0;
  vec2 centerDir = -cp / max(half_, vec2(1.0));
  refrPx += centerDir * u_refract * 4.0 * depth;
  vec2 refr = refrPx * pxToUV;

  // 微畸变噪声
  vec2 ns = cp * 0.08;
  vec2 absPxToUV = vec2(1.0) / u_res;
  vec2 micro = (vec2(hash(ns), hash(ns + vec2(37.0))) - 0.5) * u_distort * 4.0 * absPxToUV;

  // 边缘加权色散（R/B 分离）
  float caS = u_chroma * 18.0 * (edge * 0.7 + 0.3) * 2.0;
  vec2 caD = N.xy * caS * pxToUV;

  vec2 base = frag / u_res + refr + micro;
  vec3 sharp = vec3(
    texture2D(u_bgTex, base + caD).r,
    texture2D(u_bgTex, base).g,
    texture2D(u_bgTex, base - caD).b
  );
  vec3 blur = vec3(
    texture2D(u_blurTex, base + caD).r,
    texture2D(u_blurTex, base).g,
    texture2D(u_blurTex, base - caD).b
  );

  // 中心用模糊（毛玻璃），边缘混合向清晰以保持折射锐利
  float edgeMix = 1.0 - edge * 0.15;
  vec3 col = mix(sharp, blur, edgeMix);

  // 亮度 / 饱和度 / 冷色玻璃底 / 深度增亮
  col *= 1.0 + u_brightness;
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, 1.0 + u_sat);
  col = mix(col, col * vec3(0.92, 0.95, 1.05), u_tint);
  col *= 1.0 + 0.06 * depth;

  // 菲涅尔（弱化，仅边缘）
  float fres = pow(1.0 - abs(N.z), 4.0) * u_fresnel;

  // 内描边（顶部更亮，弱化）
  float borderWidth = 1.5;
  float innerStroke = smoothstep(-borderWidth - 1.0, -borderWidth, sdf)
                    * (1.0 - smoothstep(-1.0, 0.0, sdf));
  float topBias = 0.5 + 0.5 * (-cp.y / half_.y);
  innerStroke *= 0.4 + 0.6 * topBias;

  // 边缘高光：紧贴圆角边缘的柔和光（沿 SDF，随圆角走）
  float edgeLight = smoothstep(6.0, 0.0, -sdf) * u_edgeHL;

  // 悬停：整卡均匀提亮（含圆角），避免矩形热点
  vec3 fin = col * (1.0 + u_hover * 0.12) + vec3(u_hover * 0.04);
  fin += vec3(edgeLight);
  fin += vec3(innerStroke * 0.4);
  fin = mix(fin, vec3(1.0), fres * 0.12);

  gl_FragColor = vec4(fin, mask * u_alpha);
}
`;

/* ---------------- 工具 ---------------- */

function hexToRgb(hex) {
  const h = String(hex || "").replace("#", "").trim();
  const v = parseInt(h.length === 3 ? h.split("").map(c => c + c).join("") : h, 16);
  if (Number.isNaN(v)) return [0.36, 0.51, 0.72];
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/* ---------------- 引擎 ---------------- */

export class LiquidGlass {
  constructor(options = {}) {
    this.selector = options.selector || ".bk-sidebar, .bk-topbar, .bk-card";
    this.gradient = (options.gradient && options.gradient.length)
      ? options.gradient
      : ["#5b83b8", "#9db4d8", "#ffd4ea"];

    // 光学参数（默认值参考 ybouane/liquidglass 并针对仪表盘做了弱化）
    this.refract = options.refract ?? 0.35;
    this.chroma = options.chroma ?? 0.04;
    this.edgeHL = options.edgeHL ?? 0.03;
    this.fresnel = options.fresnel ?? 0.5;
    this.distort = options.distort ?? 0.2;
    this.zRadius = options.zRadius ?? 34;
    this.alpha = options.alpha ?? 1.0;
    this.sat = options.sat ?? 0.0;
    this.tint = options.tint ?? 0.0;
    this.brightness = options.brightness ?? 0.0;
    this.blurScale = options.blurScale ?? 2.5;
    this.pointerRadius = options.pointerRadius ?? 0.32;

    this.dpr = Math.min(options.dpr || window.devicePixelRatio || 1, 2);
    this.onWallpaperError = options.onWallpaperError || null;
    this.onWallpaperLoad = options.onWallpaperLoad || null;

    this.gl = null;
    this.canvas = null;
    this.container = null;
    this.programs = {};
    this.locs = {};
    this.bgFbo = null;
    this.bgFboTexture = null;
    this.blurXFbo = null;
    this.blurXTexture = null;
    this.blurYFbo = null;
    this.blurYTexture = null;
    this.wallpaperTexture = null;
    this.dummyTexture = null;
    this.fullscreenBuffer = null;
    this.unitQuadBuffer = null;
    this.hasWallpaper = false;
    this.imgSize = [1, 1];
    this.regions = [];
    this._needsBlur = false;

    this.width = 0;
    this.height = 0;
    this.cssW = 0;
    this.cssH = 0;

    this._raf = 0;
    this._last = 0;
    this._measureAcc = 0;
    this._destroyed = false;
    this._bound = {};

    this.pointer = {
      x: (typeof window !== "undefined" ? window.innerWidth : 0) / 2,
      y: (typeof window !== "undefined" ? window.innerHeight : 0) / 2,
      tx: (typeof window !== "undefined" ? window.innerWidth : 0) / 2,
      ty: (typeof window !== "undefined" ? window.innerHeight : 0) / 2,
      active: 0, targetActive: 0,
    };
  }

  /* ---------------- 生命周期 ---------------- */

  mount(container = document.body) {
    if (this._destroyed || typeof document === "undefined") return false;
    this.container = container;

    const canvas = document.createElement("canvas");
    canvas.className = "lg-canvas";
    this.canvas = canvas;
    this._resize();

    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) return false;
    this.gl = gl;

    this._initPrograms();
    this._initBuffers();
    this._initFbo();
    this._initDummyTexture();
    this._renderBackgroundToFbo();

    container.appendChild(canvas);
    this._bindEvents();
    this._measureRegions();

    this._last = performance.now();
    this._raf = requestAnimationFrame(this._loop);
    return true;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    cancelAnimationFrame(this._raf);
    this._unbindEvents();

    if (this.gl) {
      const gl = this.gl;
      this._disposeFbos();
      if (this.wallpaperTexture) gl.deleteTexture(this.wallpaperTexture);
      if (this.dummyTexture) gl.deleteTexture(this.dummyTexture);
      if (this.fullscreenBuffer) gl.deleteBuffer(this.fullscreenBuffer);
      if (this.unitQuadBuffer) gl.deleteBuffer(this.unitQuadBuffer);
    }
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
    this.gl = null;
    this.canvas = null;
  }

  /* ---------------- 公开 API ---------------- */

  setWallpaper(url) {
    if (!this.gl) return;
    if (!url) {
      this.hasWallpaper = false;
      this._renderBackgroundToFbo();
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (this._destroyed || !this.gl) return;
      this.imgSize = [img.naturalWidth || 1, img.naturalHeight || 1];
      this._uploadWallpaper(img);
      this.hasWallpaper = true;
      this._renderBackgroundToFbo();
      if (typeof this.onWallpaperLoad === "function") this.onWallpaperLoad(url);
    };
    img.onerror = () => {
      if (this._destroyed || !this.gl) return;
      this.hasWallpaper = false;
      this._renderBackgroundToFbo();
      if (typeof this.onWallpaperError === "function") this.onWallpaperError(url);
    };
    img.src = url;
  }

  setGradient(colors) {
    if (colors && colors.length) this.gradient = colors;
    if (this.gl) this._renderBackgroundToFbo();
  }

  refresh() {
    this._measureRegions();
  }

  /* ---------------- 内部：初始化 ---------------- */

  _initPrograms() {
    const gl = this.gl;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error("Shader compile error: " + gl.getShaderInfoLog(sh));
      }
      return sh;
    };
    const link = (vsSrc, fsSrc) => {
      const vs = compile(gl.VERTEX_SHADER, vsSrc);
      const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
      const p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error("Program link error: " + gl.getProgramInfoLog(p));
      }
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return p;
    };
    const gather = (p) => {
      const loc = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i);
        loc[info.name] = gl.getUniformLocation(p, info.name);
      }
      const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
      for (let i = 0; i < na; i++) {
        const info = gl.getActiveAttrib(p, i);
        loc[info.name] = gl.getAttribLocation(p, info.name);
      }
      return loc;
    };

    this.programs.bg = link(VERT_FULLSCREEN, FRAG_BACKGROUND);
    this.programs.copy = link(VERT_FULLSCREEN, FRAG_COPY);
    this.programs.blur = link(VERT_FULLSCREEN, FRAG_BLUR);
    this.programs.glass = link(VERT_GLASS, FRAG_GLASS);

    this.locs.bg = gather(this.programs.bg);
    this.locs.copy = gather(this.programs.copy);
    this.locs.blur = gather(this.programs.blur);
    this.locs.glass = gather(this.programs.glass);
  }

  _initBuffers() {
    const gl = this.gl;
    this.fullscreenBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fullscreenBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1, 1, 1,
    ]), gl.STATIC_DRAW);

    this.unitQuadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 0, 1, 0, 0, 1, 1, 1,
    ]), gl.STATIC_DRAW);
  }

  _makeFbo() {
    const gl = this.gl;
    const fbo = gl.createFramebuffer();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex };
  }

  _initFbo() {
    const bg = this._makeFbo();
    this.bgFbo = bg.fbo;
    this.bgFboTexture = bg.tex;
    const bx = this._makeFbo();
    this.blurXFbo = bx.fbo;
    this.blurXTexture = bx.tex;
    const by = this._makeFbo();
    this.blurYFbo = by.fbo;
    this.blurYTexture = by.tex;
  }

  _disposeFbos() {
    const gl = this.gl;
    if (this.bgFboTexture) gl.deleteTexture(this.bgFboTexture);
    if (this.blurXTexture) gl.deleteTexture(this.blurXTexture);
    if (this.blurYTexture) gl.deleteTexture(this.blurYTexture);
    if (this.bgFbo) gl.deleteFramebuffer(this.bgFbo);
    if (this.blurXFbo) gl.deleteFramebuffer(this.blurXFbo);
    if (this.blurYFbo) gl.deleteFramebuffer(this.blurYFbo);
    this.bgFbo = this.bgFboTexture = null;
    this.blurXFbo = this.blurXTexture = null;
    this.blurYFbo = this.blurYTexture = null;
  }

  _initDummyTexture() {
    const gl = this.gl;
    this.dummyTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  _uploadWallpaper(img) {
    const gl = this.gl;
    if (!this.wallpaperTexture) this.wallpaperTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.wallpaperTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  /* ---------------- 内部：渲染 ---------------- */

  _resize() {
    this.cssW = window.innerWidth;
    this.cssH = window.innerHeight;
    this.width = Math.max(1, Math.round(this.cssW * this.dpr));
    this.height = Math.max(1, Math.round(this.cssH * this.dpr));
    if (this.canvas) {
      this.canvas.style.width = this.cssW + "px";
      this.canvas.style.height = this.cssH + "px";
      this.canvas.width = this.width;
      this.canvas.height = this.height;
    }
    if (this.gl && this.bgFboTexture) {
      this._disposeFbos();
      this._initFbo();
      this._renderBackgroundToFbo();
    }
  }

  _renderBackgroundToFbo() {
    const gl = this.gl;
    if (!gl || !this.bgFbo) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bgFbo);
    gl.viewport(0, 0, this.width, this.height);

    const p = this.programs.bg;
    const L = this.locs.bg;
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.wallpaperTexture || this.dummyTexture);
    gl.uniform1i(L.u_wallpaper, 0);
    gl.uniform1f(L.u_has_wallpaper, this.hasWallpaper ? 1.0 : 0.0);

    const c = this.gradient;
    gl.uniform3fv(L.u_c0, hexToRgb(c[0]));
    gl.uniform3fv(L.u_c1, hexToRgb(c[1] || c[0]));
    gl.uniform3fv(L.u_c2, hexToRgb(c[2] || c[1] || c[0]));
    gl.uniform3fv(L.u_c3, hexToRgb(c[3] || c[2] || c[1] || c[0]));
    gl.uniform2f(L.u_img_size, this.imgSize[0], this.imgSize[1]);
    gl.uniform2f(L.u_canvas_size, this.width, this.height);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.fullscreenBuffer);
    gl.enableVertexAttribArray(L.a_pos);
    gl.vertexAttribPointer(L.a_pos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._needsBlur = true;
  }

  _renderBlur() {
    const gl = this.gl;
    const p = this.programs.blur;
    const L = this.locs.blur;
    const px = 1 / this.width;
    const py = 1 / this.height;

    gl.disable(gl.BLEND);
    gl.useProgram(p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fullscreenBuffer);
    gl.enableVertexAttribArray(L.a_pos);
    gl.vertexAttribPointer(L.a_pos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(L.u_tex, 0);

    // 水平
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurXFbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.bindTexture(gl.TEXTURE_2D, this.bgFboTexture);
    gl.uniform2f(L.u_dir, px * this.blurScale, 0.0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 垂直
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurYFbo);
    gl.bindTexture(gl.TEXTURE_2D, this.blurXTexture);
    gl.uniform2f(L.u_dir, 0.0, py * this.blurScale);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _loop = (now) => {
    if (this._destroyed) return;
    this._raf = requestAnimationFrame(this._loop);

    const dt = Math.min((now - this._last) / 1000, 0.1);
    this._last = now;
    this._dt = dt;

    // 指针阻尼（指数 Lerp，帧率无关）
    const k = 1 - Math.exp(-dt * 8);
    this.pointer.x += (this.pointer.tx - this.pointer.x) * k;
    this.pointer.y += (this.pointer.ty - this.pointer.y) * k;
    this.pointer.active += (this.pointer.targetActive - this.pointer.active) * (1 - Math.exp(-dt * 6));

    this._measureAcc += dt;
    if (this._measureAcc > 0.25) {
      this._measureAcc = 0;
      this._measureRegions();
    }

    this._draw();
  };

  _draw() {
    const gl = this.gl;
    if (!gl) return;

    if (this._needsBlur) {
      this._renderBlur();
      this._needsBlur = false;
    }

    gl.viewport(0, 0, this.width, this.height);

    // 1) 背景 FBO → 屏幕
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(this.programs.copy);
    const CL = this.locs.copy;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.bgFboTexture);
    gl.uniform1i(CL.u_tex, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fullscreenBuffer);
    gl.enableVertexAttribArray(CL.a_pos);
    gl.vertexAttribPointer(CL.a_pos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 2) 玻璃区域
    if (!this.regions.length) return;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const p = this.programs.glass;
    const L = this.locs.glass;
    gl.useProgram(p);

    // 纹理：0 = 清晰背景，1 = 模糊背景
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.bgFboTexture);
    gl.uniform1i(L.u_bgTex, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.blurYTexture);
    gl.uniform1i(L.u_blurTex, 1);

    gl.uniform2f(L.u_res, this.width, this.height);
    gl.uniform1f(L.u_refract, this.refract);
    gl.uniform1f(L.u_chroma, this.chroma);
    gl.uniform1f(L.u_edgeHL, this.edgeHL);
    gl.uniform1f(L.u_fresnel, this.fresnel);
    gl.uniform1f(L.u_distort, this.distort);
    gl.uniform1f(L.u_zRadius, this.zRadius);
    gl.uniform1f(L.u_alpha, this.alpha);
    gl.uniform1f(L.u_sat, this.sat);
    gl.uniform1f(L.u_tint, this.tint);
    gl.uniform1f(L.u_brightness, this.brightness);
    gl.uniform1f(L.u_pointer_radius, this.pointerRadius);

    const clamp1 = (v) => Math.max(-1, Math.min(1, v));
    const tiltX = clamp1((this.pointer.x / Math.max(this.cssW, 1)) * 2 - 1);
    const tiltY = clamp1(-((this.pointer.y / Math.max(this.cssH, 1)) * 2 - 1));
    gl.uniform2f(L.u_tilt, tiltX, tiltY);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuadBuffer);
    gl.enableVertexAttribArray(L.a_local);
    gl.vertexAttribPointer(L.a_local, 2, gl.FLOAT, false, 0, 0);

    for (const r of this.regions) {
      gl.uniform2f(L.u_center, r.cx, r.cy);
      gl.uniform2f(L.u_half, r.hx, r.hy);
      gl.uniform2f(L.u_origin, r.ox, r.oy);
      gl.uniform2f(L.u_size, r.w, r.h);
      gl.uniform1f(L.u_radius, r.corner);

      const lx = (this.pointer.x - r.cssLeft) / r.cssW;
      const ly = 1 - (this.pointer.y - r.cssTop) / r.cssH;
      const inside = lx >= 0 && lx <= 1 && ly >= 0 && ly <= 1;

      // 悬停强度平滑插值（整卡均匀提亮）
      const hoverK = 1 - Math.exp(-(this._dt || 0.016) * 8);
      r.hover += ((inside ? 1 : 0) - r.hover) * hoverK;
      r.el.__lgHover = r.hover;

      gl.uniform2f(L.u_pointer, lx, ly);
      gl.uniform1f(L.u_pointer_active, inside ? this.pointer.active : 0.0);
      gl.uniform1f(L.u_hover, r.hover);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    gl.disable(gl.BLEND);
  }

  /* ---------------- 内部：区域测量 ---------------- */

  _measureRegions() {
    if (this._destroyed || !this.gl) return;
    const els = document.querySelectorAll(this.selector);
    const regions = [];
    const dpr = this.dpr;
    const canvasH = this.height;

    for (const el of els) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;

      const css = getComputedStyle(el);
      if (css.display === "none" || css.visibility === "hidden") continue;

      let corner = parseFloat(css.borderTopLeftRadius) || 0;
      if (!isFinite(corner)) corner = 0;

      const px = rect.left * dpr;
      const pyTop = rect.top * dpr;
      const pyBottom = canvasH - (rect.top + rect.height) * dpr;
      const w = rect.width * dpr;
      const h = rect.height * dpr;

      regions.push({
        el,
        cssLeft: rect.left,
        cssTop: rect.top,
        cssW: rect.width,
        cssH: rect.height,
        cx: ((px + w / 2) / this.width) * 2 - 1,
        cy: ((pyBottom + h / 2) / this.height) * 2 - 1,
        hx: w / this.width,
        hy: h / this.height,
        ox: px,
        oy: pyBottom,
        w,
        h,
        corner: corner * dpr,
        hover: (el.__lgHover || 0),
      });
    }
    this.regions = regions;
  }

  /* ---------------- 内部：事件 ---------------- */

  _setPointer(clientX, clientY) {
    this.pointer.tx = clientX;
    this.pointer.ty = clientY;
  }

  _onMove = (e) => this._setPointer(e.clientX, e.clientY);
  _onDown = (e) => {
    this._setPointer(e.clientX, e.clientY);
    this.pointer.targetActive = 1;
  };
  _onUp = () => { this.pointer.targetActive = 0; };
  _onLeave = () => { this.pointer.targetActive = 0; };
  _onResize = () => { this._resize(); this._measureRegions(); };
  _onScroll = () => { this._measureAcc = 0.26; };

  _bindEvents() {
    const b = this._bound;
    b.move = this._onMove;
    b.down = this._onDown;
    b.up = this._onUp;
    b.leave = this._onLeave;
    b.resize = this._onResize;
    b.scroll = this._onScroll;

    window.addEventListener("pointermove", b.move, { passive: true });
    window.addEventListener("pointerdown", b.down, { passive: true });
    window.addEventListener("pointerup", b.up, { passive: true });
    window.addEventListener("pointercancel", b.up, { passive: true });
    document.addEventListener("pointerleave", b.leave);
    window.addEventListener("resize", b.resize);
    window.addEventListener("scroll", b.scroll, { capture: true, passive: true });
  }

  _unbindEvents() {
    const b = this._bound;
    if (!b.move) return;
    window.removeEventListener("pointermove", b.move);
    window.removeEventListener("pointerdown", b.down);
    window.removeEventListener("pointerup", b.up);
    window.removeEventListener("pointercancel", b.up);
    document.removeEventListener("pointerleave", b.leave);
    window.removeEventListener("resize", b.resize);
    window.removeEventListener("scroll", b.scroll, { capture: true });
    this._bound = {};
  }
}

export default LiquidGlass;
