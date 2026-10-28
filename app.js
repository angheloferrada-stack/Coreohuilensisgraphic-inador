/* Escenario · planificador de formaciones de baile (PWA, sin dependencias) */
(() => {
  'use strict';

  const APP_VERSION = 'v8';
  const CHANGELOG = [
    { v: 'v8', fecha: '28 oct 2026', items: [
      'Línea de tiempo tipo storyboard: cada escena tiene su dibujo y las transiciones van entre ellas',
      'Arrastra una escena para cambiarla de lugar',
      'La pista de la música se ve en la línea de tiempo; arrástrala para sincronizar el primer tiempo con el baile',
      'Zoom de la línea de tiempo (− y +)',
      'Vueltas propias o en grupo/pareja, en la quieta o al caminar, con inicio y fin en % del movimiento',
      'Las vueltas se combinan con las rutas',
      'Video de referencia que se exporta arriba del video del baile',
      'Número de versión y novedades'
    ] },
    { v: 'v7', items: ['Versión para PC (pc.html) con las 4 listas a la vista', 'Vuelta propia de cada bailarín', 'La vuelta de grupo pasó a llamarse "Vuelta en grupo"'] },
    { v: 'v6', items: ['Detección automática del BPM y del primer tiempo desde la música', 'Botones ÷2 y ×2 y campo Primer tiempo'] },
    { v: 'v5', items: ['Quieta y mover separadas en cada formación', 'Menú con pestañas y botones − y +'] },
    { v: 'v4', items: ['Vueltas del grupo mientras se mueven'] },
    { v: 'v3', items: ['Rutas por bailarín y por grupo'] },
    { v: 'v2', items: ['Línea de tiempo para ajustar la duración de cada transición'] },
    { v: 'v1', items: ['Versión inicial: escenario, bailarines, música, exportar y compartir'] }
  ];

  const STORE_KEY = 'escenario.v1';
  const PALETTE = ['#ff6b6b', '#1fb5b0', '#ffd166', '#5b7cfa', '#9b5de5', '#06d6a0',
                   '#f78c6b', '#ef476f', '#118ab2', '#ffa62b', '#8ac926', '#f15bb5'];
  const SNAP = 0.05;
  const ASPECT = 16 / 10;
  const CENTER = { x: 0.5, y: 0.5 };
  const ZOOMS = [12, 18, 24, 32, 44];
  const MAX_T = 64;     // tiempos máximos por parte
  const MAX_TO = 0.9;   // una vuelta termina como máximo al 90 % del movimiento o de la quieta
  const PEAK_RATE = 50; // muestras de la onda por segundo

  // ---------- Utilidades ----------
  const $ = (id) => document.getElementById(id);
  const uid = () => Math.random().toString(36).slice(2, 10);
  const labelFor = (i) => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const snapV = (v) => clamp01(Math.round(v / SNAP) * SNAP);
  const ease = (p) => p * p * (3 - 2 * p);
  const beatToSec = (b, bpm) => (b * 60) / bpm;
  const secToBeat = (s, bpm) => (s * bpm) / 60;
  const clonePos = (pos) => Object.fromEntries(Object.entries(pos).map(([k, v]) => [k, { x: v.x, y: v.y }]));
  const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  const safeName = (s) => (s || 'coreografia').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'coreografia';
  const el = (tag, cls) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  };
  const btn = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    return b;
  };

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ---------- Datos ----------
  // Escena = posición de los bailarines + "quieta" (hold) + "transición" hacia la siguiente (beats)
  // Vuelta = { type: 'self' | 'group', when: 'move' | 'hold', ids, deg, from, to } (from/to en fracción del tramo)
  function newFrame(name, pos, hold = 0, beats = 8) {
    return { id: uid(), name, notes: '', hold, beats, pos, routes: {}, turns: [] };
  }

  function newChoreo(name) {
    const dancers = [];
    const pos = {};
    for (let i = 0; i < 6; i++) {
      const d = { id: uid(), label: labelFor(i), color: PALETTE[i % PALETTE.length], crewId: null };
      dancers.push(d);
      pos[d.id] = { x: 0.2 + 0.12 * i, y: 0.5 };
    }
    return {
      id: uid(), name, bpm: 120, offset: 0, curved: false, snap: true,
      dancers, crews: [],
      frames: [newFrame('Inicio', pos, 4, 8)],
      updatedAt: Date.now()
    };
  }

  // Lleva datos guardados en versiones anteriores al formato actual
  function normFrame(fr) {
    fr.name = fr.name || 'Escena';
    fr.hold = fr.hold || 0;
    fr.beats = fr.beats || 8;
    fr.notes = fr.notes || '';
    fr.pos = fr.pos || {};
    fr.routes = fr.routes || {};
    if (!Array.isArray(fr.turns)) {
      const list = [];
      for (const [id, deg] of Object.entries(fr.turns || {})) {
        list.push({ id: uid(), type: 'self', when: 'move', ids: [id], deg, from: 0, to: MAX_TO });
      }
      for (const [id, deg] of Object.entries(fr.holdTurns || {})) {
        list.push({ id: uid(), type: 'self', when: 'hold', ids: [id], deg, from: 0, to: MAX_TO });
      }
      const seen = new Set();
      for (const sp of Object.values(fr.spins || {})) {
        const key = sp.ids.join('|') + sp.deg;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({ id: uid(), type: 'group', when: 'move', ids: [...sp.ids], deg: sp.deg, from: 0, to: MAX_TO });
      }
      fr.turns = list;
    }
    delete fr.holdTurns;
    delete fr.spins;
    return fr;
  }

  function normChoreo(c) {
    c.bpm = c.bpm || 120;
    c.offset = c.offset || 0;
    c.crews = c.crews || [];
    c.dancers = c.dancers || [];
    if (!c.frames || !c.frames.length) {
      const pos = Object.fromEntries(c.dancers.map((d) => [d.id, { x: 0.5, y: 0.5 }]));
      c.frames = [newFrame('Inicio', pos, 0, 8)];
    }
    c.frames.forEach(normFrame);
    return c;
  }

  function loadDB() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (raw && Array.isArray(raw.choreos) && raw.choreos.length) {
        raw.choreos.forEach(normChoreo);
        if (!raw.choreos.some((c) => c.id === raw.activeId)) raw.activeId = raw.choreos[0].id;
        return raw;
      }
    } catch (_) { /* datos corruptos: empezamos de cero */ }
    const first = newChoreo('Mi primera coreo');
    return { activeId: first.id, choreos: [first] };
  }

  let db = loadDB();
  let saveTimer = 0;
  function save(now = false) {
    const write = () => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }
      catch (_) { toast('No hay espacio para guardar'); }
    };
    clearTimeout(saveTimer);
    if (now) write(); else saveTimer = setTimeout(write, 250);
  }
  const chor = () => db.choreos.find((c) => c.id === db.activeId) || db.choreos[0];
  function touch() { chor().updatedAt = Date.now(); save(); }
  const dancerOf = (id) => chor().dancers.find((d) => d.id === id);

  // ---------- Estado de la sesión ----------
  let frameIdx = 0;
  let mode = 'edit';   // 'edit' | 'preview' | 'play'
  let tool = 'mover';  // 'mover' | 'ruta'
  let playBeat = 0;
  let playing = false;
  let exporting = false;
  let rafId = 0;
  let clockStart = 0;
  let selection = new Set();
  let drag = null;
  let marquee = null;
  let view = { w: 0, h: 0, dpr: 1, sx: 0, sy: 0, sw: 1, sh: 1 };
  let zoomIdx = 2;
  let PPB = ZOOMS[zoomIdx];   // píxeles por tiempo en la línea de tiempo

  const canvas = $('stage');
  const ctx = canvas.getContext('2d');
  const tl = $('timeline');
  let playheadEl = null;

  const audioEl = new Audio();
  audioEl.preload = 'auto';
  let audioBlob = null, audioPeaks = null, audioLoaded = false;
  let audioCtx = null, audioNode = null, audioOut = null;

  const refEl = document.createElement('video');
  refEl.muted = true;
  refEl.playsInline = true;
  let refLoaded = false;

  // ---------- Tiempos: escena (quieta) y transición (mover) ----------
  function segmentsOf(c) {
    const segs = [];
    let t = 0;
    c.frames.forEach((f, i) => {
      const hold = f.hold || 0;
      if (hold > 0) { segs.push({ kind: 'hold', frame: i, start: t, dur: hold }); t += hold; }
      if (i < c.frames.length - 1) {
        segs.push({ kind: 'move', from: i, to: i + 1, start: t, dur: f.beats });
        t += f.beats;
      }
    });
    return segs;
  }
  function totalOf(c) {
    let t = 0;
    c.frames.forEach((f, i) => {
      t += f.hold || 0;
      if (i < c.frames.length - 1) t += f.beats;
    });
    return t;
  }
  // Inicio de la escena i (donde cae el cabezal al seleccionarla)
  function startOfFrame(c, i) {
    let t = 0;
    for (let j = 0; j < i; j++) t += (c.frames[j].hold || 0) + c.frames[j].beats;
    return t;
  }

  // ---------- Trayectorias ----------
  function ctrlPoint(a, b, id) {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const side = (id.charCodeAt(0) % 2 ? 1 : -1) * 0.3 * len;
    return { x: mx + (-dy / len) * side, y: my + (dx / len) * side };
  }
  function tween(a, b, p, curved, id) {
    if (!curved) return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p };
    const c = ctrlPoint(a, b, id), q = 1 - p;
    return {
      x: q * q * a.x + 2 * q * p * c.x + p * p * b.x,
      y: q * q * a.y + 2 * q * p * c.y + p * p * b.y
    };
  }
  // Ruta: spline Catmull-Rom que pasa por A, los puntos intermedios y B
  function routeAt(a, b, route, p) {
    const P = [a, ...route, b];
    const N = P.length;
    const u = p * (N - 1);
    const k = Math.min(Math.floor(u), N - 2);
    const t = u - k;
    const p0 = P[Math.max(0, k - 1)], p1 = P[k], p2 = P[k + 1], p3 = P[Math.min(N - 1, k + 2)];
    const cr = (v0, v1, v2, v3) => 0.5 * ((2 * v1) + (-v0 + v2) * t
      + (2 * v0 - 5 * v1 + 4 * v2 - v3) * t * t
      + (-v0 + 3 * v1 - 3 * v2 + v3) * t * t * t);
    return { x: clamp01(cr(p0.x, p1.x, p2.x, p3.x)), y: clamp01(cr(p0.y, p1.y, p2.y, p3.y)) };
  }
  const centroid = (ids, pos) => {
    const ps = ids.map((id) => pos[id]).filter(Boolean);
    const n = ps.length || 1;
    return { x: ps.reduce((s, p) => s + p.x, 0) / n, y: ps.reduce((s, p) => s + p.y, 0) / n };
  };

  // Posición base de cada bailarín en la transición (ruta o trayectoria) con progreso p
  function basePositions(c, f, B, p) {
    const out = {};
    const routes = f.routes || {};
    for (const d of c.dancers) {
      const a = f.pos[d.id] || B[d.id] || CENTER;
      const bb = B[d.id] || a;
      const route = routes[d.id];
      out[d.id] = route && route.length
        ? routeAt(a, bb, route, p)
        : tween(a, bb, p, c.curved, d.id);
    }
    return out;
  }

  // Vueltas en grupo: el grupo gira alrededor de su centro (en píxeles para no deformar el giro).
  // La parte del giro que desplaza a los bailarines se deshace antes de llegar al final del tramo,
  // así la siguiente formación empieza donde debe.
  function applyTurns(f, when, local, pos) {
    for (const t of f.turns || []) {
      if (t.when !== when || t.type !== 'group') continue;
      const ids = t.ids.filter((id) => pos[id]);
      if (ids.length < 2) continue;
      const w1 = Math.max(t.to, t.from + 0.01);
      const u = clamp01((local - t.from) / (w1 - t.from));
      if (u <= 0) continue;
      const th = (t.deg * Math.PI / 180) * ease(u);
      const m = local <= w1 ? 1 : 1 - ease(clamp01((local - w1) / (1 - w1)));
      const C = centroid(ids, pos);
      const ca = Math.cos(th), sa = Math.sin(th);
      for (const id of ids) {
        const dx = (pos[id].x - C.x) * view.sw, dy = (pos[id].y - C.y) * view.sh;
        const rx = dx * ca - dy * sa, ry = dx * sa + dy * ca;
        pos[id] = {
          x: clamp01(pos[id].x + m * (rx - dx) / view.sw),
          y: clamp01(pos[id].y + m * (ry - dy) / view.sh)
        };
      }
    }
  }

  // Ángulo de las vueltas propias de cada bailarín en el tiempo b (para dibujar la marca que gira)
  function selfAngles(c, b) {
    const s = segmentsOf(c).find((x) => b >= x.start && b < x.start + x.dur);
    if (!s) return {};
    const hold = s.kind === 'hold';
    const f = c.frames[hold ? s.frame : s.from];
    const local = (b - s.start) / s.dur;
    const out = {};
    for (const t of f.turns || []) {
      if (t.type !== 'self' || (t.when === 'hold') !== hold) continue;
      if (local < t.from) continue;
      const w1 = Math.max(t.to, t.from + 0.01);
      const u = clamp01((local - t.from) / (w1 - t.from));
      for (const id of t.ids) out[id] = (out[id] || 0) + t.deg * ease(u);
    }
    return out;
  }

  // Posición de todos los bailarines en el tiempo b (en tiempos musicales)
  function positionsAt(c, b) {
    const segs = segmentsOf(c);
    if (!segs.length || b <= 0) return clonePos(c.frames[0].pos);
    if (b >= totalOf(c)) return clonePos(c.frames[c.frames.length - 1].pos);
    const s = segs.find((x) => b >= x.start && b < x.start + x.dur) || segs[segs.length - 1];
    const local = clamp01((b - s.start) / s.dur);
    let pos;
    if (s.kind === 'hold') {
      const f = c.frames[s.frame];
      pos = clonePos(f.pos);
      applyTurns(f, 'hold', local, pos);
    } else {
      const f = c.frames[s.from];
      pos = basePositions(c, f, c.frames[s.to].pos, ease(local));
      applyTurns(f, 'move', local, pos);
    }
    return pos;
  }

  // ---------- Dibujo del escenario ----------
  const toPx = (x, y) => ({ x: view.sx + x * view.sw, y: view.sy + y * view.sh });
  const toNorm = (px, py) => ({ x: (px - view.sx) / view.sw, y: (py - view.sy) / view.sh });
  const dancerRadius = () => Math.max(13, Math.min(view.sw, view.sh) * 0.045);
  const localPt = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  function dancerColor(d) {
    const crew = chor().crews.find((cr) => cr.id === d.crewId);
    return crew ? crew.color : d.color;
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    const pad = 14, labelBand = 26;
    const availW = r.width - pad * 2, availH = r.height - pad * 2 - labelBand;
    let sw = availW, sh = sw / ASPECT;
    if (sh > availH) { sh = availH; sw = sh * ASPECT; }
    view = {
      w: r.width, h: r.height, dpr,
      sw: Math.max(1, sw), sh: Math.max(1, sh),
      sx: (r.width - sw) / 2, sy: pad + (availH - sh) / 2
    };
    render();
  }

  // Arco de una vuelta: punteado = al caminar, continuo = en la quieta
  function turnArc(color, q, r, deg, dashed) {
    ctx.save();
    ctx.setLineDash(dashed ? [4, 4] : []);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = dashed ? 1 : 0.6;
    ctx.beginPath();
    const a0 = -Math.PI / 2;
    ctx.arc(q.x, q.y, r, a0, a0 + deg * Math.PI / 180, deg < 0);
    ctx.stroke();
    ctx.restore();
  }

  function drawScene(pos, opts, notches, pf) {
    const c = chor();
    const edit = mode === 'edit' && !opts.clean;
    const { dpr, w, h, sx, sy, sw, sh } = view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Escenario
    const grad = ctx.createLinearGradient(0, sy, 0, sy + sh);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, '#eeeaf4');
    ctx.fillStyle = grad;
    roundRect(sx, sy, sw, sh, 16);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.1)';
    ctx.lineWidth = 1.5;
    roundRect(sx, sy, sw, sh, 16);
    ctx.stroke();

    // Grilla
    if (edit && c.snap) {
      ctx.strokeStyle = 'rgba(0,0,0,0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i < 1 / SNAP; i++) {
        const x = sx + i * SNAP * sw, y = sy + i * SNAP * sh;
        ctx.moveTo(x, sy); ctx.lineTo(x, sy + sh);
        ctx.moveTo(sx, y); ctx.lineTo(sx + sw, y);
      }
      ctx.stroke();
    }

    // Orientación
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.font = '11px "DM Sans", system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('FONDO', sx + sw / 2, sy - 4);
    ctx.fillText('PÚBLICO', sx + sw / 2, sy + sh + 16);

    const rad = dancerRadius();

    // Vista previa de la escena: trayectoria hacia la siguiente y vueltas
    if (edit && pf) {
      const fi = c.frames.indexOf(pf);
      if (fi >= 0 && fi < c.frames.length - 1) {
        const next = c.frames[fi + 1].pos;
        for (const d of c.dancers) {
          const a = pos[d.id], b = next[d.id];
          if (!a || !b) continue;
          const route = pf.routes && pf.routes[d.id];
          const col = dancerColor(d);
          ctx.globalAlpha = 0.7;
          ctx.strokeStyle = col;
          ctx.lineWidth = 2;
          if (route && route.length) {
            ctx.setLineDash([]);
            ctx.beginPath();
            for (let s = 0; s <= 30; s++) {
              const r = routeAt(a, b, route, s / 30);
              const q = toPx(r.x, r.y);
              if (s === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
            }
            ctx.stroke();
            for (const wp of route) {
              const q = toPx(wp.x, wp.y);
              ctx.beginPath();
              ctx.arc(q.x, q.y, 4, 0, Math.PI * 2);
              ctx.fillStyle = col;
              ctx.fill();
            }
          } else {
            const A = toPx(a.x, a.y), B = toPx(b.x, b.y);
            ctx.setLineDash([5, 5]);
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(A.x, A.y);
            if (c.curved) {
              const k = ctrlPoint(a, b, d.id);
              const K = toPx(k.x, k.y);
              ctx.quadraticCurveTo(K.x, K.y, B.x, B.y);
            } else {
              ctx.lineTo(B.x, B.y);
            }
            ctx.stroke();
          }
          const T = toPx(b.x, b.y);
          ctx.setLineDash([3, 3]);
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(T.x, T.y, rad * 0.8, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
      }
      for (const t of pf.turns || []) {
        const ids = t.ids.filter((id) => pos[id]);
        if (!ids.length) continue;
        const dashed = t.when === 'move';
        if (t.type === 'self') {
          for (const id of ids) {
            const d = dancerOf(id);
            if (!d) continue;
            turnArc(dancerColor(d), toPx(pos[id].x, pos[id].y), rad * (dashed ? 1.45 : 1.85), t.deg, dashed);
          }
        } else if (ids.length >= 2) {
          const C = centroid(ids, pos);
          const Cp = toPx(C.x, C.y);
          let R = 0;
          for (const id of ids) {
            const q = toPx(pos[id].x, pos[id].y);
            R = Math.max(R, Math.hypot(q.x - Cp.x, q.y - Cp.y));
          }
          turnArc('#111111', Cp, R + rad * 1.4, t.deg, dashed);
        }
      }
    }

    // Bailarines
    for (const d of c.dancers) {
      const p = pos[d.id];
      if (!p) continue;
      const q = toPx(p.x, p.y);
      const isSel = edit && selection.has(d.id);
      ctx.beginPath();
      ctx.arc(q.x, q.y, rad, 0, Math.PI * 2);
      ctx.fillStyle = dancerColor(d);
      ctx.fill();
      ctx.lineWidth = isSel ? 3 : 1.5;
      ctx.strokeStyle = isSel ? '#111111' : 'rgba(0,0,0,0.25)';
      ctx.stroke();
      // Marca de vuelta propia durante la reproducción
      if (!edit && notches[d.id] !== undefined) {
        const a = -Math.PI / 2 + notches[d.id] * Math.PI / 180;
        ctx.strokeStyle = 'rgba(17,17,17,0.85)';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(q.x + Math.cos(a) * rad * 0.3, q.y + Math.sin(a) * rad * 0.3);
        ctx.lineTo(q.x + Math.cos(a) * rad * 0.95, q.y + Math.sin(a) * rad * 0.95);
        ctx.stroke();
      }
      ctx.fillStyle = '#111';
      ctx.font = `700 ${Math.round(rad * 0.85)}px "DM Sans", system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(d.label, q.x, q.y + 1);
    }

    // Selección por rectángulo
    if (edit && marquee) {
      const x = Math.min(marquee.x0, marquee.x1), y = Math.min(marquee.y0, marquee.y1);
      const ww = Math.abs(marquee.x1 - marquee.x0), hh = Math.abs(marquee.y1 - marquee.y0);
      ctx.fillStyle = 'rgba(31,181,176,0.12)';
      ctx.strokeStyle = 'rgba(31,181,176,0.8)';
      ctx.lineWidth = 1.5;
      ctx.fillRect(x, y, ww, hh);
      ctx.strokeRect(x, y, ww, hh);
    }
  }

  function render(opts = {}) {
    if (!view.w) return;
    const c = chor();
    const edit = mode === 'edit';
    const pos = edit ? c.frames[frameIdx].pos : positionsAt(c, playBeat);
    const notches = edit ? {} : selfAngles(c, playBeat);
    drawScene(pos, opts, notches, edit ? c.frames[frameIdx] : null);
  }

  // Miniatura de una escena para la línea de tiempo
  function drawThumb(cv, f, w, h) {
    const c = chor();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#f4f2f8';
    g.fillRect(0, 0, w, h);
    const r = Math.max(2, Math.min(w, h) * 0.07);
    for (const d of c.dancers) {
      const p = f.pos[d.id];
      if (!p) continue;
      g.beginPath();
      g.fillStyle = dancerColor(d);
      g.arc(4 + p.x * (w - 8), 4 + p.y * (h - 8), r, 0, Math.PI * 2);
      g.fill();
    }
  }

  // ---------- Interacción con el escenario ----------
  function hitDancer(pt, pos) {
    const r = dancerRadius() + 6;
    const dancers = chor().dancers;
    for (let i = dancers.length - 1; i >= 0; i--) {
      const d = dancers[i];
      const p = pos[d.id];
      if (!p) continue;
      const q = toPx(p.x, p.y);
      if (Math.hypot(q.x - pt.x, q.y - pt.y) <= r) return d;
    }
    return null;
  }

  function dancersInRect(m) {
    const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1);
    const y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
    const pos = chor().frames[frameIdx].pos;
    const out = new Set();
    for (const d of chor().dancers) {
      const p = pos[d.id];
      if (!p) continue;
      const q = toPx(p.x, p.y);
      if (q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1) out.add(d.id);
    }
    return out;
  }

  function guardMovement() {
    const c = chor();
    if (mode !== 'edit') return false;
    if (frameIdx >= c.frames.length - 1) {
      toast('La última escena no tiene transición hacia otra');
      return false;
    }
    return true;
  }

  function addWaypointAt(pt) {
    if (!guardMovement()) return;
    if (!selection.size) return toast('Selecciona bailarines primero');
    const c = chor(), f = c.frames[frameIdx];
    f.routes = f.routes || {};
    const ids = [...selection].filter((id) => f.pos[id]);
    const cen = centroid(ids, f.pos);
    for (const id of ids) {
      const p = f.pos[id];
      // El grupo mantiene su forma: cada bailarín guarda su distancia al centro del grupo
      let x = clamp01(pt.x + (p.x - cen.x)), y = clamp01(pt.y + (p.y - cen.y));
      if (c.snap) { x = snapV(x); y = snapV(y); }
      f.routes[id] = [...(f.routes[id] || []), { x, y }];
    }
    touch();
    render();
    updateTransport();
  }

  function undoWaypoint() {
    const f = chor().frames[frameIdx];
    let n = 0;
    for (const id of selection) {
      const r = f.routes && f.routes[id];
      if (r && r.length) {
        r.pop();
        n++;
        if (!r.length) delete f.routes[id];
      }
    }
    if (!n) return toast('Esos bailarines no tienen puntos de ruta');
    touch();
    render();
    updateTransport();
  }

  function clearRoutes() {
    const f = chor().frames[frameIdx];
    let n = 0;
    for (const id of selection) {
      if (f.routes && f.routes[id]) { delete f.routes[id]; n++; }
    }
    const before = (f.turns || []).length;
    f.turns = (f.turns || []).filter((t) => !t.ids.some((id) => selection.has(id)));
    n += before - f.turns.length;
    if (!n) return toast('Esos bailarines no tienen movimientos');
    touch();
    render();
    updateTransport();
  }

  // ---------- Vueltas (creadas desde un cuadro) ----------
  function openTurnDialog(type) {
    if (mode !== 'edit') return;
    if (!selection.size) return toast('Selecciona bailarines primero');
    $('turnType').value = type;
    $('turnTitle').textContent = type === 'self' ? 'Vuelta propia' : 'Vuelta en grupo o pareja';
    $('dlgTurn').showModal();
  }

  function createTurn() {
    const c = chor(), f = c.frames[frameIdx];
    const type = $('turnType').value, when = $('turnWhen').value;
    const deg = parseFloat($('turnDeg').value) || 0;
    const fromPct = clamp01((parseFloat($('turnFrom').value) || 0) / 100);
    const toPct = Math.min(MAX_TO, Math.max(0.05, (parseFloat($('turnTo').value) || 90) / 100));
    const from = Math.min(fromPct, MAX_TO - 0.05);
    if (toPct <= from + 0.04) return toast('El final debe ser después del inicio');
    if (!deg) return toast('Pon los grados de la vuelta');
    const ids = [...selection].filter((id) => f.pos[id]);
    if (!ids.length) return toast('Selecciona bailarines primero');
    if (type === 'group' && ids.length < 2) return toast('En grupo o pareja selecciona al menos 2 bailarines');
    if (when === 'move' && !guardMovement()) return;
    if (when === 'hold' && !(f.hold > 0)) return toast('Primero sube la quieta de esta escena');
    f.turns = f.turns || [];
    f.turns.push({ id: uid(), type, when, ids, deg, from, to: toPct });
    $('dlgTurn').close();
    touch();
    render();
    updateTransport();
  }

  function renderTurnList() {
    const list = $('turnList');
    list.innerHTML = '';
    const c = chor(), f = c.frames[frameIdx];
    const turns = mode === 'edit' ? (f.turns || []) : [];
    if (!turns.length) {
      list.innerHTML = '<p class="help">Aún no hay vueltas en esta escena.</p>';
      return;
    }
    for (const t of turns) {
      const row = el('div', 'turn-row');
      const names = t.ids.map((id) => (dancerOf(id) || {}).label).filter(Boolean).join(', ');
      const txt = el('span');
      txt.textContent = `${t.type === 'self' ? 'Propia' : 'En grupo'} · ${t.deg}° · ${t.when === 'hold' ? 'quieta' : 'caminando'} · ${Math.round(t.from * 100)}–${Math.round(t.to * 100)}% · ${names}`;
      const x = btn('×', () => {
        f.turns = f.turns.filter((u) => u.id !== t.id);
        touch();
        render();
        updateTransport();
      });
      x.className = 'turn-x';
      x.setAttribute('aria-label', 'Quitar vuelta');
      row.append(txt, x);
      list.appendChild(row);
    }
  }

  function wireStage() {
    canvas.addEventListener('pointerdown', (e) => {
      if (mode !== 'edit') return;
      const pt = localPt(e);
      if (tool === 'ruta') { addWaypointAt(toNorm(pt.x, pt.y)); return; }
      canvas.setPointerCapture(e.pointerId);
      const pos = chor().frames[frameIdx].pos;
      const hit = hitDancer(pt, pos);
      if (hit) {
        const wasMulti = selection.size > 1;
        if (!selection.has(hit.id)) selection = new Set([hit.id]);
        const starts = {};
        for (const id of selection) if (pos[id]) starts[id] = { ...pos[id] };
        drag = { kind: 'move', startX: pt.x, startY: pt.y, moved: false, hitId: hit.id, wasMulti, starts };
      } else {
        selection = new Set();
        marquee = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
        drag = { kind: 'marquee' };
      }
      render();
      updateTransport();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const pt = localPt(e);
      if (drag.kind === 'move') {
        const dxPx = pt.x - drag.startX, dyPx = pt.y - drag.startY;
        if (!drag.moved && Math.hypot(dxPx, dyPx) < 4) return;
        drag.moved = true;
        const dx = dxPx / view.sw, dy = dyPx / view.sh;
        const c = chor();
        const pos = c.frames[frameIdx].pos;
        for (const id of Object.keys(drag.starts)) {
          const s = drag.starts[id];
          let x = clamp01(s.x + dx), y = clamp01(s.y + dy);
          if (c.snap) { x = snapV(x); y = snapV(y); }
          pos[id] = { x, y };
        }
        render();
      } else if (drag.kind === 'marquee') {
        marquee.x1 = pt.x; marquee.y1 = pt.y;
        selection = dancersInRect(marquee);
        render();
      }
    });

    const endDrag = () => {
      if (!drag) return;
      if (drag.kind === 'move') {
        if (!drag.moved && drag.wasMulti) selection = new Set([drag.hitId]);
        if (drag.moved) touch();
      } else {
        marquee = null;
      }
      drag = null;
      render();
      updateTransport();
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    canvas.addEventListener('dblclick', (e) => {
      if (mode !== 'edit' || tool !== 'mover') return;
      const hit = hitDancer(localPt(e), chor().frames[frameIdx].pos);
      if (!hit) return;
      const name = prompt('Nombre del bailarín (máx. 4 letras)', hit.label);
      if (!name || !name.trim()) return;
      hit.label = name.trim().slice(0, 4);
      touch();
      render();
    });
  }

  // ---------- Reproducción y cabezal ----------
  function ensureEdit() { if (mode !== 'edit') setFrame(frameIdx); }

  function setFrame(i) {
    const c = chor();
    stopPlay();
    frameIdx = Math.max(0, Math.min(c.frames.length - 1, i));
    mode = 'edit';
    playBeat = startOfFrame(c, frameIdx);
    selection = new Set();
    render();
    updateTransport();
  }

  function play() {
    const c = chor();
    if (totalOf(c) <= 0) return toast('Agrega tiempos de quieta o movimiento para reproducir');
    if (mode === 'edit') playBeat = startOfFrame(c, frameIdx);
    if (playBeat >= totalOf(c)) playBeat = 0;
    mode = 'play';
    playing = true;
    selection = new Set();
    clockStart = performance.now() - beatToSec(playBeat, c.bpm) * 1000;
    if (audioLoaded) {
      audioEl.currentTime = beatToSec(playBeat, c.bpm) + (c.offset || 0);
      audioEl.play().catch(() => {});
    }
    updateTransport();
    rafId = requestAnimationFrame(tick);
  }

  function tick() {
    const c = chor();
    const total = totalOf(c);
    const useAudio = audioLoaded && !audioEl.error && audioEl.readyState >= 2;
    const off = c.offset || 0;
    let sec;
    if (useAudio) {
      sec = audioEl.currentTime - off; // el tiempo 1 cae en el segundo "offset" de la música
      clockStart = performance.now() - sec * 1000;
    } else {
      sec = (performance.now() - clockStart) / 1000;
    }
    const b = Math.max(0, secToBeat(sec, c.bpm));
    if (b >= total) {
      playBeat = total;
      stopPlay();
      return;
    }
    playBeat = b;
    render();
    renderPlayhead();
    updateStatus();
    keepPlayheadVisible();
    rafId = requestAnimationFrame(tick);
  }

  function stopPlay() {
    if (!playing) return;
    playing = false;
    cancelAnimationFrame(rafId);
    audioEl.pause();
    mode = 'preview';
    render();
    updateTransport();
  }

  const xInTrack = (e) => e.clientX - tl.querySelector('.tl-track').getBoundingClientRect().left;

  function scrubTo(x) {
    const c = chor();
    const total = totalOf(c);
    const b = Math.max(0, Math.min(total, x / PPB));
    if (playing) stopPlay();
    mode = 'preview';
    playBeat = b;
    if (audioLoaded) audioEl.currentTime = beatToSec(b, c.bpm) + (c.offset || 0);
    render();
    renderPlayhead();
    updateStatus();
  }

  function renderPlayhead() {
    if (playheadEl) playheadEl.style.left = (playBeat * PPB) + 'px';
  }

  function keepPlayheadVisible() {
    const x = playBeat * PPB, w = tl.clientWidth, left = tl.scrollLeft;
    if (x < left + 30 || x > left + w - 60) tl.scrollLeft = Math.max(0, x - w / 3);
  }

  // ---------- Línea de tiempo tipo storyboard ----------
  function addHandle(parent, kind, i) {
    const h = el('div', 'tl-handle');
    h.dataset.handle = kind;
    h.dataset.frame = String(i);
    parent.appendChild(h);
  }

  function renderTimeline() {
    const c = chor(), n = c.frames.length, total = totalOf(c);
    const scroll = tl.scrollLeft;
    const W = total * PPB + 200;

    const track = el('div', 'tl-track');
    track.style.width = W + 'px';
    track.style.backgroundSize = `${PPB}px 100%`; // una línea por tiempo

    const ruler = el('div', 'tl-ruler');
    for (let b = 0; b <= total; b += 4) {
      const t = el('div', 'tl-tick');
      t.style.left = (b * PPB) + 'px';
      t.textContent = String(b + 1);
      ruler.appendChild(t);
    }
    track.appendChild(ruler);

    // Escenas (quieta) y transiciones (mover), en orden
    let t = 0;
    c.frames.forEach((f, i) => {
      const hold = f.hold || 0;
      const on = mode === 'edit' && i === frameIdx;
      const sw = Math.max(hold * PPB, 14);

      const sc = el('div', 'tl-scene' + (on ? ' on' : ''));
      sc.dataset.frame = String(i);
      sc.dataset.kind = 'scene';
      sc.style.left = (t * PPB) + 'px';
      sc.style.width = sw + 'px';
      const cv = el('canvas', 'tl-thumb');
      sc.appendChild(cv);
      const lab = el('span', 'tl-label');
      lab.textContent = `${f.name} · ${hold} t`;
      sc.appendChild(lab);
      addHandle(sc, 'hold', i);
      track.appendChild(sc);
      drawThumb(cv, f, sw, 52);
      t += hold;

      if (i < n - 1) {
        const mb = el('div', 'tl-move');
        mb.dataset.frame = String(i);
        mb.dataset.kind = 'move';
        mb.style.left = (t * PPB) + 'px';
        mb.style.width = (f.beats * PPB) + 'px';
        const l1 = el('span', 'tl-label');
        l1.textContent = `→ ${c.frames[i + 1].name}`;
        const l2 = el('span', 'tl-sub');
        l2.textContent = `caminan · ${f.beats} t`;
        mb.append(l1, l2);
        addHandle(mb, 'move', i);
        track.appendChild(mb);
        t += f.beats;
      }
    });

    const add = el('button', 'tl-add');
    add.textContent = '+ Escena';
    add.style.left = (total * PPB + 14) + 'px';
    add.title = 'Agregar una escena al final';
    add.onclick = () => {
      ensureEdit();
      frameIdx = chor().frames.length - 1;
      addFrame(false);
    };
    track.appendChild(add);

    // Pista de la música: la onda queda alineada con los tiempos
    const au = el('div', 'tl-audio');
    au.dataset.kind = 'audio';
    const wave = el('canvas');
    au.appendChild(wave);
    if (!audioPeaks) {
      const empty = el('span', 'tl-empty');
      empty.textContent = 'Sin música · elígela en la pestaña Más';
      au.appendChild(empty);
    }
    track.appendChild(au);

    playheadEl = el('div', 'tl-playhead');
    track.appendChild(playheadEl);
    tl.replaceChildren(track);
    tl.scrollLeft = scroll;
    drawWave(wave, W, 36);
    renderPlayhead();
  }

  function drawWave(cv, W, H) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px';
    cv.style.height = H + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!audioPeaks) return;
    const c = chor(), period = 60 / c.bpm, off = c.offset || 0;
    const { data, rate } = audioPeaks;
    g.fillStyle = 'rgba(155, 93, 229, 0.6)';
    const mid = H / 2;
    for (let x = 0; x < W; x++) {
      const i0 = Math.floor((off + (x / PPB) * period) * rate);
      if (i0 >= data.length) break;
      const i1 = Math.max(i0 + 1, Math.floor((off + ((x + 1) / PPB) * period) * rate));
      let mx = 0;
      for (let k = Math.max(0, i0); k < i1 && k < data.length; k++) if (data[k] > mx) mx = data[k];
      const hgt = Math.max(1, mx * (H - 8));
      g.fillRect(x, mid - hgt / 2, 1, hgt);
    }
  }

  // Al soltar una escena arrastrada: calcula su nuevo lugar según dónde quedó
  function reorderFrame(i, dx) {
    const c = chor(), n = c.frames.length;
    const centers = [];
    let s = 0;
    c.frames.forEach((f, j) => {
      const w = ((f.hold || 0) + (j < n - 1 ? f.beats : 0)) * PPB;
      centers.push(s + w / 2);
      s += w;
    });
    const mine = centers[i] + dx;
    let target = 0;
    for (let j = 0; j < n; j++) if (j !== i && centers[j] < mine) target++;
    if (target === i) return false;
    const [fr] = c.frames.splice(i, 1);
    c.frames.splice(target, 0, fr);
    touch();
    return target;
  }

  function setZoom(delta) {
    zoomIdx = Math.max(0, Math.min(ZOOMS.length - 1, zoomIdx + delta));
    PPB = ZOOMS[zoomIdx];
    renderTimeline();
    keepPlayheadVisible();
    $('btnZoomIn').disabled = zoomIdx >= ZOOMS.length - 1;
    $('btnZoomOut').disabled = zoomIdx <= 0;
  }

  function wireTimeline() {
    tl.addEventListener('pointerdown', (e) => {
      if (exporting || e.button > 0) return;
      if (e.target.closest('.tl-add')) return;
      const h = e.target.closest('[data-handle]');
      const blk = e.target.closest('.tl-scene, .tl-move');
      const au = e.target.closest('.tl-audio');
      if (h) {
        const i = +h.dataset.frame;
        const field = h.dataset.handle === 'hold' ? 'hold' : 'beats';
        drag = { kind: 'resize', frame: i, field, startX: e.clientX, startVal: chor().frames[i][field] || 0, changed: false };
      } else if (blk) {
        drag = { kind: 'scene', frame: +blk.dataset.frame, startX: e.clientX, moved: false, el: blk };
      } else if (au) {
        drag = { kind: 'audio', startX: e.clientX, startOffset: chor().offset || 0, moved: false, x0: xInTrack(e) };
      } else {
        drag = { kind: 'scrub' };
        scrubTo(xInTrack(e));
      }
      tl.setPointerCapture(e.pointerId);
    });

    tl.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      if (drag.kind === 'resize') {
        const min = drag.field === 'hold' ? 0 : 1;
        const nv = Math.max(min, Math.min(MAX_T, Math.round(drag.startVal + dx / PPB)));
        const f = chor().frames[drag.frame];
        if (nv !== (f[drag.field] || 0)) {
          f[drag.field] = nv;
          drag.changed = true;
          renderTimeline();
        }
      } else if (drag.kind === 'scene') {
        if (Math.abs(dx) > 6) drag.moved = true;
        if (drag.moved) {
          drag.el.style.transform = `translateX(${dx}px)`;
          drag.el.style.zIndex = '5';
        }
      } else if (drag.kind === 'audio') {
        if (Math.abs(dx) > 4) drag.moved = true;
        if (drag.moved) {
          const c = chor();
          c.offset = Math.max(0, Math.round((drag.startOffset - (dx / PPB) * (60 / c.bpm)) * 100) / 100);
          renderTimeline();
        }
      } else if (drag.kind === 'scrub') {
        scrubTo(xInTrack(e));
      }
    });

    const end = (e, cancelled) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (d.kind === 'resize') {
        if (d.changed) touch();
        updateTransport();
      } else if (d.kind === 'scene') {
        if (cancelled) { renderTimeline(); return; }
        if (!d.moved) { setFrame(d.frame); return; }
        const target = reorderFrame(d.frame, e.clientX - d.startX);
        if (target === false) renderTimeline();
        else setFrame(target);
      } else if (d.kind === 'audio') {
        if (d.moved) { touch(); updateTransport(); }
        else if (!cancelled) scrubTo(d.x0);
      } else if (d.kind === 'scrub') {
        updateTransport();
      }
    };
    tl.addEventListener('pointerup', (e) => end(e, false));
    tl.addEventListener('pointercancel', (e) => end(e, true));
  }

  // ---------- Escenas y bailarines ----------
  function bump(field, delta) {
    ensureEdit();
    const c = chor(), f = c.frames[frameIdx];
    if (field === 'hold') {
      f.hold = Math.max(0, Math.min(MAX_T, (f.hold || 0) + delta));
    } else {
      if (frameIdx >= c.frames.length - 1) return toast('La última escena no tiene transición');
      f.beats = Math.max(1, Math.min(MAX_T, f.beats + delta));
    }
    touch();
    updateTransport();
  }

  function addFrame(duplicate) {
    ensureEdit();
    const c = chor(), src = c.frames[frameIdx];
    const nf = newFrame(
      duplicate ? `${src.name} (copia)` : `Escena ${c.frames.length + 1}`,
      clonePos(src.pos),
      duplicate ? src.hold || 0 : 4,
      8
    );
    nf.notes = duplicate ? src.notes : '';
    c.frames.splice(frameIdx + 1, 0, nf);
    touch();
    setFrame(frameIdx + 1);
  }

  function delFrame() {
    const c = chor();
    if (c.frames.length <= 1) return toast('Debe quedar al menos una escena');
    if (!confirm(`¿Borrar "${c.frames[frameIdx].name}"?`)) return;
    c.frames.splice(frameIdx, 1);
    touch();
    setFrame(Math.min(frameIdx, c.frames.length - 1));
  }

  function addDancer() {
    ensureEdit();
    const c = chor(), i = c.dancers.length;
    const d = { id: uid(), label: labelFor(i), color: PALETTE[i % PALETTE.length], crewId: null };
    c.dancers.push(d);
    c.frames.forEach((f) => { f.pos[d.id] = { x: 0.5, y: 0.5 }; });
    selection = new Set([d.id]);
    touch();
    render();
    updateTransport();
  }

  function removeSelected() {
    const c = chor();
    if (!selection.size) return toast('Selecciona bailarines primero');
    if (!confirm(`¿Quitar ${selection.size} bailarín(es) de toda la coreografía?`)) return;
    c.dancers = c.dancers.filter((d) => !selection.has(d.id));
    c.frames.forEach((f) => {
      selection.forEach((id) => {
        delete f.pos[id];
        if (f.routes) delete f.routes[id];
      });
      f.turns = (f.turns || [])
        .map((t) => ({ ...t, ids: t.ids.filter((id) => !selection.has(id)) }))
        .filter((t) => t.ids.length);
    });
    selection = new Set();
    touch();
    render();
    updateTransport();
  }

  // ---------- Crews ----------
  function renderCrews() {
    const c = chor();
    const list = $('crewList');
    list.innerHTML = '';
    if (!c.crews.length) {
      list.innerHTML = '<p class="help">Aún no hay crews. Selecciona bailarines en el escenario y crea uno.</p>';
      return;
    }
    for (const cr of c.crews) {
      const members = c.dancers.filter((d) => d.crewId === cr.id).length;
      const row = el('div', 'crew');
      const sw = el('span', 'swatch');
      sw.style.background = cr.color;
      const name = el('strong');
      name.textContent = cr.name;
      const count = el('span', 'muted');
      count.textContent = `${members} bailarín(es)`;
      row.append(sw, name, count);
      row.append(
        btn('Seleccionar', () => {
          ensureEdit();
          selection = new Set(c.dancers.filter((d) => d.crewId === cr.id).map((d) => d.id));
          $('dlgCrews').close();
          render();
          updateTransport();
        }),
        btn('Eliminar', () => {
          if (!confirm(`¿Eliminar el crew "${cr.name}"? Los bailarines conservan su nombre.`)) return;
          c.dancers.forEach((d) => { if (d.crewId === cr.id) d.crewId = null; });
          c.crews = c.crews.filter((x) => x.id !== cr.id);
          touch();
          renderCrews();
          render();
        })
      );
      list.appendChild(row);
    }
  }

  function createCrewFromSelection() {
    const c = chor();
    if (!selection.size) return toast('Selecciona bailarines primero');
    const name = prompt('Nombre del crew', `Crew ${c.crews.length + 1}`);
    if (!name || !name.trim()) return;
    const crew = { id: uid(), name: name.trim().slice(0, 30), color: PALETTE[(c.crews.length + 2) % PALETTE.length] };
    c.crews.push(crew);
    c.dancers.forEach((d) => { if (selection.has(d.id)) d.crewId = crew.id; });
    touch();
    renderCrews();
    render();
  }

  function clearCrewFromSelection() {
    const c = chor();
    if (!selection.size) return toast('Selecciona bailarines primero');
    c.dancers.forEach((d) => { if (selection.has(d.id)) d.crewId = null; });
    touch();
    renderCrews();
    render();
  }

  // ---------- Controles ----------
  function renderChoreoSelect() {
    const sel = $('choreoSelect');
    sel.innerHTML = '';
    for (const c of db.choreos) {
      const o = el('option');
      o.value = c.id;
      o.textContent = c.name;
      sel.appendChild(o);
    }
    sel.value = db.activeId;
  }

  function switchTo(id) {
    stopPlay();
    db.activeId = id;
    frameIdx = 0;
    mode = 'edit';
    tool = 'mover';
    playBeat = 0;
    selection = new Set();
    audioEl.pause();
    renderChoreoSelect();
    save(true);
    resize();
    updateTransport();
  }

  function updateStatus() {
    const c = chor(), n = c.frames.length, f = c.frames[frameIdx];
    let text;
    if (mode !== 'edit') {
      text = `${fmt(beatToSec(playBeat, c.bpm))} / ${fmt(beatToSec(totalOf(c), c.bpm))}`;
    } else if (tool === 'ruta') {
      text = `Ruta: toca el escenario para poner un punto a ${selection.size} bailarín(es)`;
    } else {
      text = `${frameIdx + 1}/${n} · ${f.name}` +
        (frameIdx < n - 1 ? ` · quieta ${f.hold || 0} · mover ${f.beats}` : ' · última');
    }
    $('status').textContent = text;
  }

  function showTab(name) {
    document.querySelectorAll('.tab-panel').forEach((s) => { s.hidden = s.dataset.tab !== name; });
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.go === name));
  }

  function updateTransport() {
    const c = chor(), n = c.frames.length, f = c.frames[frameIdx];
    const last = frameIdx >= n - 1;
    const inEdit = mode === 'edit' && !last;
    if (!inEdit) tool = 'mover';

    $('btnPlay').textContent = playing ? '❚❚' : '▶';
    $('btnPlay').disabled = exporting;
    $('btnExportVideo').disabled = exporting;

    $('holdVal').textContent = f.hold || 0;
    $('beatVal').textContent = last ? '—' : f.beats;
    $('beatMinus').disabled = last;
    $('beatPlus').disabled = last;
    $('btnDelFrame').disabled = n <= 1;

    $('btnToolRoute').disabled = !inEdit;
    $('btnUndoWp').disabled = !inEdit;
    $('btnTurnSelf').disabled = mode !== 'edit';
    $('btnTurnGroup').disabled = mode !== 'edit';
    $('btnClearRoutes').disabled = mode !== 'edit';
    $('btnToolRoute').classList.toggle('on', tool === 'ruta');

    $('bpm').value = c.bpm;
    $('offset').value = (c.offset || 0).toFixed(2);
    $('curved').checked = c.curved;
    $('snap').checked = c.snap;
    $('btnZoomIn').disabled = zoomIdx >= ZOOMS.length - 1;
    $('btnZoomOut').disabled = zoomIdx <= 0;

    renderTimeline();
    renderTurnList();
    updateStatus();
  }

  // ---------- Detección automática de BPM y del primer tiempo ----------
  // Busca el pulso que mejor "calza" con los golpes de la música y en qué segundo cae el primer tiempo.
  function analyzeBuffer(buf) {
    const sr = buf.sampleRate;
    const chans = [];
    for (let i = 0; i < buf.numberOfChannels; i++) chans.push(buf.getChannelData(i));

    // 1) Mezcla a mono y baja la tasa a ~11 kHz
    const D = Math.max(1, Math.round(sr / 11025));
    const M = Math.floor(buf.length / D);
    const mono = new Float32Array(M);
    for (let i = 0; i < M; i++) {
      let s = 0;
      for (let k = 0; k < D; k++) {
        for (const ch of chans) s += ch[i * D + k];
      }
      mono[i] = s / (D * chans.length);
    }

    // 2) Onda para la línea de tiempo (antes de filtrar)
    const blk = Math.max(1, Math.round((sr / D) / PEAK_RATE));
    const np = Math.floor(M / blk);
    const pk = new Float32Array(np);
    let pmax = 0;
    for (let k = 0; k < np; k++) {
      let mx = 0;
      for (let j = k * blk; j < (k + 1) * blk; j++) {
        const v = Math.abs(mono[j]);
        if (v > mx) mx = v;
      }
      pk[k] = mx;
      if (mx > pmax) pmax = mx;
    }
    if (pmax > 0) for (let k = 0; k < np; k++) pk[k] /= pmax;
    const peaks = { data: pk, rate: (sr / D) / blk };

    // 3) Nos quedamos con los graves (bombo y bajo): el hi-hat agudo confunde el pulso
    const alpha = 1 - Math.exp(-2 * Math.PI * 150 / (sr / D));
    let y = 0;
    for (let i = 0; i < M; i++) {
      y += alpha * (mono[i] - y);
      mono[i] = y;
    }

    // 4) Energía por cuadros de 128 muestras; un "golpe" es un aumento de la amplitud
    const H = 128;
    const F = Math.floor(M / H);
    const fps = (sr / D) / H;
    const amp = new Float64Array(F);
    for (let j = 0; j < F; j++) {
      let e = 0;
      for (let k = 0; k < H; k++) { const v = mono[j * H + k]; e += v * v; }
      amp[j] = Math.sqrt(e / H);
    }
    const onset = new Float64Array(F);
    let mean = 0;
    for (let j = 1; j < F; j++) {
      onset[j] = Math.max(0, amp[j] - amp[j - 1]);
      mean += onset[j];
    }
    mean /= Math.max(1, F - 1);
    for (let j = 0; j < F; j++) onset[j] -= mean;

    // 5) Qué tan fuerte es un pulso a una velocidad dada
    const probe = (bpm) => {
      const w = 2 * Math.PI * (bpm / 60) / fps;
      const cw = Math.cos(w), sw = Math.sin(w);
      let zr = 1, zi = 0, re = 0, im = 0;
      for (let j = 0; j < F; j++) {
        const x = onset[j];
        re += x * zr;
        im += x * zi;
        const nr = zr * cw + zi * sw;
        zi = zi * cw - zr * sw;
        zr = nr;
      }
      return { re, im, w, p: re * re + im * im };
    };

    // 6) Busca entre 60 y 200 BPM: primero grueso, luego fino (0,01 BPM)
    const refine = (center) => {
      let r = { bpm: center, p: probe(center).p };
      for (let k = -50; k <= 50; k++) {
        const b = center + k * 0.01;
        const p = probe(b).p;
        if (p > r.p) r = { bpm: b, p };
      }
      return r;
    };
    let coarse = { bpm: 120, p: -1 };
    for (let b = 60; b <= 200; b += 0.5) {
      const p = probe(b).p;
      if (p > coarse.p) coarse = { bpm: b, p };
    }
    let best = refine(coarse.bpm);
    // Evita el error "al doble": si el tiempo a la mitad tiene la mitad de fuerza o más, ese es el ritmo
    for (;;) {
      if (best.bpm / 2 < 60) break;
      const half = refine(best.bpm / 2);
      if (half.p < 0.5 * best.p) break;
      best = half;
    }

    // 7) Primer tiempo: la fase del pulso dentro de un tiempo
    const bpm = Math.round(best.bpm * 100) / 100;
    const q = probe(bpm);
    const period = 60 / bpm;
    const P = 2 * Math.PI / q.w;
    let i0 = -Math.atan2(q.im, q.re) / q.w;
    i0 = ((i0 % P) + P) % P;
    const offset = Math.round(((i0 / fps) % period) * 100) / 100;
    return { bpm, offset, peaks };
  }

  async function detectTempo(file) {
    const c = chor();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    try {
      const buf = await ac.decodeAudioData(await file.arrayBuffer());
      const res = analyzeBuffer(buf);
      c.bpm = res.bpm;
      c.offset = res.offset;
      audioPeaks = res.peaks;
      c.updatedAt = Date.now();
      save();
      if (chor() === c) updateTransport();
      toast(`Ritmo: ${res.bpm} BPM · primer tiempo a ${res.offset.toFixed(2)} s`);
      return true;
    } catch (_) {
      toast('No pude leer el ritmo de esa música');
      return false;
    } finally {
      ac.close();
    }
  }

  function loadAudio(file) {
    if (!file) return;
    stopPlay();
    if (audioEl.src.startsWith('blob:')) URL.revokeObjectURL(audioEl.src);
    audioEl.src = URL.createObjectURL(file);
    audioLoaded = true;
    audioBlob = file;
    $('audioFile').value = '';
    $('audioName').textContent = `${file.name} · analizando ritmo…`;
    detectTempo(file).then(() => { $('audioName').textContent = file.name; });
  }

  // ---------- Video de referencia ----------
  function loadRef(file) {
    if (!file) return;
    if (refEl.src.startsWith('blob:')) URL.revokeObjectURL(refEl.src);
    refEl.src = URL.createObjectURL(file);
    refLoaded = true;
    $('refName').textContent = file.name;
    $('refFile').value = '';
  }

  function clearRef() {
    refLoaded = false;
    refEl.pause();
    refEl.removeAttribute('src');
    refEl.load();
    $('refName').textContent = '';
  }

  // ---------- Exportar / compartir / importar ----------
  function ensureAudioGraph() {
    if (audioNode) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
    audioNode = audioCtx.createMediaElementSource(audioEl);
    audioOut = audioCtx.createMediaStreamDestination();
    audioNode.connect(audioOut);
    audioNode.connect(audioCtx.destination);
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }

  function exportPng() {
    const c = chor();
    render({ clean: true });
    canvas.toBlob((blob) => {
      render();
      if (blob) download(blob, `${safeName(c.name)}_${safeName(c.frames[frameIdx].name)}.png`);
    }, 'image/png');
  }

  function exportVideo() {
    if (exporting) return;
    const c = chor(), total = totalOf(c);
    if (!total) return toast('Agrega tiempos de quieta o movimiento para exportar');
    if (!window.MediaRecorder) return toast('Tu navegador no puede grabar video');
    stopPlay();

    // Con video de referencia: arriba el video de referencia, abajo el escenario
    let out = canvas, cg = null;
    if (refLoaded) {
      const comp = document.createElement('canvas');
      comp.width = canvas.width;
      comp.height = canvas.height * 2;
      cg = comp.getContext('2d');
      out = comp;
      refEl.currentTime = Math.max(0, parseFloat($('refStart').value) || 0);
      refEl.play().catch(() => {});
    }
    const compose = () => {
      const W = canvas.width, H = canvas.height;
      cg.fillStyle = '#111';
      cg.fillRect(0, 0, W, H * 2);
      if (refEl.videoWidth) {
        const s = Math.min(W / refEl.videoWidth, H / refEl.videoHeight);
        const vw = refEl.videoWidth * s, vh = refEl.videoHeight * s;
        cg.drawImage(refEl, (W - vw) / 2, (H - vh) / 2, vw, vh);
      }
      cg.drawImage(canvas, 0, H);
    };

    const tracks = [...out.captureStream(30).getVideoTracks()];
    if (audioLoaded) {
      try { ensureAudioGraph(); tracks.push(...audioOut.stream.getAudioTracks()); }
      catch (_) { /* seguimos sin audio */ }
    }
    const type = ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']
      .find((t) => MediaRecorder.isTypeSupported(t)) || '';
    let rec;
    try {
      rec = new MediaRecorder(new MediaStream(tracks), type ? { mimeType: type } : undefined);
    } catch (_) {
      return toast('No pude iniciar la grabación');
    }

    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const mime = rec.mimeType || 'video/webm';
      download(new Blob(chunks, { type: mime }), `${safeName(c.name)}.${mime.includes('mp4') ? 'mp4' : 'webm'}`);
      exporting = false;
      refEl.pause();
      mode = 'preview';
      playBeat = total;
      render();
      updateTransport();
      toast('Video listo');
    };

    exporting = true;
    mode = 'play';
    playBeat = 0;
    selection = new Set();
    updateTransport();
    rec.start(250);
    if (audioLoaded) { audioEl.currentTime = c.offset || 0; audioEl.play().catch(() => {}); }

    const totalSec = beatToSec(total, c.bpm);
    const t0 = performance.now();
    const step = () => {
      const sec = (performance.now() - t0) / 1000;
      if (sec >= totalSec) {
        playBeat = total;
        render({ clean: true });
        if (cg) compose();
        audioEl.pause();
        rec.stop();
        return;
      }
      playBeat = secToBeat(sec, c.bpm);
      render({ clean: true });
      if (cg) compose();
      renderPlayhead();
      updateStatus();
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
  }

  async function shareChoreo() {
    const c = chor();
    const file = new File([JSON.stringify(c)], `${safeName(c.name)}.json`, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: c.name, text: 'Mira mi coreografía' }); }
      catch (e) { if (e.name !== 'AbortError') toast('No se pudo compartir'); }
    } else {
      download(file, file.name);
      toast('Tu navegador no comparte archivos: lo descargué');
    }
  }

  async function importChoreo(e) {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || !Array.isArray(data.frames) || !data.frames.length || !Array.isArray(data.dancers)) {
        throw new Error('formato');
      }
      data.id = uid();
      data.name = (data.name || 'Importada').slice(0, 40);
      data.updatedAt = Date.now();
      normChoreo(data);
      db.choreos.push(data);
      switchTo(data.id);
      toast('Coreografía importada');
    } catch (_) {
      toast('Ese archivo no es una coreografía válida');
    }
  }

  function openNotes() {
    const f = chor().frames[frameIdx];
    $('frameName').value = f.name;
    $('notesText').value = f.notes;
    $('dlgNotes').showModal();
  }

  function openNews() {
    const list = $('newsList');
    list.innerHTML = '';
    for (const v of CHANGELOG) {
      const box = el('div', 'news-item');
      const h = el('strong');
      h.textContent = v.fecha ? `${v.v} · ${v.fecha}` : v.v;
      const ul = el('ul');
      for (const it of v.items) {
        const li = el('li');
        li.textContent = it;
        ul.appendChild(li);
      }
      box.append(h, ul);
      list.appendChild(box);
    }
    $('dlgNews').showModal();
  }

  function setToolRuta() {
    if (!guardMovement()) return;
    tool = tool === 'ruta' ? 'mover' : 'ruta';
    updateTransport();
  }

  function wireControls() {
    $('choreoSelect').onchange = (e) => switchTo(e.target.value);
    $('btnNewChoreo').onclick = () => {
      const n = prompt('Nombre de la coreografía', 'Nueva coreo');
      if (!n || !n.trim()) return;
      const c = newChoreo(n.trim().slice(0, 40));
      db.choreos.push(c);
      switchTo(c.id);
    };
    $('btnRenameChoreo').onclick = () => {
      const c = chor();
      const n = prompt('Nuevo nombre', c.name);
      if (!n || !n.trim()) return;
      c.name = n.trim().slice(0, 40);
      touch();
      renderChoreoSelect();
    };
    $('btnDeleteChoreo').onclick = () => {
      const c = chor();
      if (!confirm(`¿Eliminar "${c.name}"?`)) return;
      db.choreos = db.choreos.filter((x) => x.id !== c.id);
      if (!db.choreos.length) db.choreos.push(newChoreo('Nueva coreo'));
      switchTo(db.choreos[0].id);
    };

    $('btnPlay').onclick = () => (playing ? stopPlay() : play());
    $('btnPrev').onclick = () => setFrame(frameIdx - 1);
    $('btnNext').onclick = () => setFrame(frameIdx + 1);
    $('btnZoomIn').onclick = () => setZoom(1);
    $('btnZoomOut').onclick = () => setZoom(-1);

    document.querySelectorAll('.tab').forEach((b) => {
      b.onclick = () => showTab(b.dataset.go);
    });

    $('holdMinus').onclick = () => bump('hold', -1);
    $('holdPlus').onclick = () => bump('hold', 1);
    $('beatMinus').onclick = () => bump('beats', -1);
    $('beatPlus').onclick = () => bump('beats', 1);

    $('btnAddFrame').onclick = () => addFrame(false);
    $('btnDupFrame').onclick = () => addFrame(true);
    $('btnDelFrame').onclick = delFrame;
    $('btnNotes').onclick = openNotes;
    $('frameName').oninput = (e) => {
      chor().frames[frameIdx].name = e.target.value.slice(0, 30) || 'Escena';
      touch();
      updateTransport();
    };
    $('notesText').oninput = (e) => {
      chor().frames[frameIdx].notes = e.target.value;
      touch();
    };

    $('btnAddDancer').onclick = addDancer;
    $('btnRemoveDancer').onclick = removeSelected;
    $('btnCrews').onclick = () => { ensureEdit(); renderCrews(); $('dlgCrews').showModal(); };
    $('btnCrewFromSel').onclick = createCrewFromSelection;
    $('btnCrewClear').onclick = clearCrewFromSelection;

    $('btnToolRoute').onclick = setToolRuta;
    $('btnTurnSelf').onclick = () => openTurnDialog('self');
    $('btnTurnGroup').onclick = () => openTurnDialog('group');
    $('btnTurnOk').onclick = createTurn;
    $('btnUndoWp').onclick = undoWaypoint;
    $('btnClearRoutes').onclick = clearRoutes;
    $('curved').onchange = (e) => { chor().curved = e.target.checked; touch(); render(); };
    $('snap').onchange = (e) => { chor().snap = e.target.checked; touch(); render(); };

    const setBpm = (v) => {
      chor().bpm = Math.max(30, Math.min(300, Math.round(v * 100) / 100));
      touch();
      updateTransport();
    };
    $('bpm').onchange = (e) => setBpm(parseFloat(e.target.value) || 120);
    $('btnHalf').onclick = () => setBpm(chor().bpm / 2);
    $('btnDouble').onclick = () => setBpm(chor().bpm * 2);
    $('offset').onchange = (e) => {
      chor().offset = Math.max(0, parseFloat(e.target.value) || 0);
      touch();
      updateTransport();
    };
    $('btnDetect').onclick = () => {
      if (!audioBlob) return toast('Primero elige una música');
      detectTempo(audioBlob).then(() => updateTransport());
    };
    $('btnMusic').onclick = () => $('audioFile').click();
    $('audioFile').onchange = (e) => loadAudio(e.target.files[0]);
    audioEl.onerror = () => {
      audioLoaded = false;
      $('audioName').textContent = 'No se pudo cargar esa música';
    };

    $('btnRefVideo').onclick = () => $('refFile').click();
    $('refFile').onchange = (e) => loadRef(e.target.files[0]);
    $('btnRefClear').onclick = clearRef;

    $('btnExportVideo').onclick = exportVideo;
    $('btnExportPng').onclick = exportPng;
    $('btnShare').onclick = shareChoreo;
    $('btnExportJson').onclick = () => {
      const c = chor();
      download(new Blob([JSON.stringify(c, null, 2)], { type: 'application/json' }), `${safeName(c.name)}.json`);
    };
    $('btnImport').onclick = () => $('importFile').click();
    $('importFile').onchange = importChoreo;
    $('btnNews').onclick = openNews;

    document.querySelectorAll('[data-close]').forEach((b) => {
      b.onclick = () => b.closest('dialog').close();
    });
  }

  // ---------- Arranque ----------
  $('verBadge').textContent = APP_VERSION;
  $('verLabel').textContent = APP_VERSION;
  wireStage();
  wireTimeline();
  wireControls();
  renderChoreoSelect();
  new ResizeObserver(resize).observe(canvas.parentElement);
  window.addEventListener('resize', resize);
  resize();
  updateTransport();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
