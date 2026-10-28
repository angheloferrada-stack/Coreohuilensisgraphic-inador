/* Escenario · planificador de formaciones de baile (PWA, sin dependencias) */
(() => {
  'use strict';

  // ---------- Constantes y utilidades ----------
  const STORE_KEY = 'escenario.v1';
  const PALETTE = ['#ff6b6b', '#1fb5b0', '#ffd166', '#5b7cfa', '#9b5de5', '#06d6a0',
                   '#f78c6b', '#ef476f', '#118ab2', '#ffa62b', '#8ac926', '#f15bb5'];
  const SNAP = 0.05;
  const ASPECT = 16 / 10;
  const CENTER = { x: 0.5, y: 0.5 };
  const PPB = 24;   // píxeles por tiempo musical en la línea de tiempo
  const MAX_T = 64; // tiempos máximos por parte

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

  function btn(label, fn) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    return b;
  }

  // ---------- Datos y almacenamiento ----------
  // Cada formación: "hold" = tiempos quieta, "beats" = tiempos para moverse a la siguiente
  function newFrame(name, pos, hold = 0, beats = 8) {
    return { id: uid(), name, notes: '', hold, beats, pos, routes: {}, spins: {}, turns: {} };
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
      frames: [newFrame('Inicio', pos, 0, 8)],
      updatedAt: Date.now()
    };
  }

  function loadDB() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (raw && Array.isArray(raw.choreos) && raw.choreos.length) {
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

  // ---------- Estado de la sesión ----------
  let frameIdx = 0;
  let mode = 'edit';           // 'edit' | 'preview' | 'play'
  let tool = 'mover';          // 'mover' | 'ruta'
  let playBeat = 0;
  let playing = false;
  let exporting = false;
  let rafId = 0;
  let clockStart = 0;
  let selection = new Set();
  let drag = null;
  let marquee = null;
  let view = { w: 0, h: 0, dpr: 1, sx: 0, sy: 0, sw: 1, sh: 1 };

  const canvas = $('stage');
  const ctx = canvas.getContext('2d');
  const tl = $('timeline');
  let playheadEl = null;
  const audioEl = new Audio();
  audioEl.preload = 'auto';
  let audioLoaded = false;
  let audioCtx = null, audioNode = null, audioOut = null;

  // ---------- Línea de tiempo: quietas y movimientos (en tiempos musicales) ----------
  // Orden: quieta de la formación 1, movimiento 1→2, quieta de la 2, movimiento 2→3, ...
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
  // Inicio de la quieta de una formación (donde el cabezal se coloca al seleccionarla)
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
  // Giro del grupo: el centro se traslada de A a B y cada bailarín gira a su alrededor
  // (en píxeles para que el giro no se deforme con la forma del escenario)
  function spinPoint(f, A, B, id, p) {
    const sp = f.spins && f.spins[id];
    if (!sp || !A[id] || !B[id]) return null;
    const ids = sp.ids.filter((i) => A[i] && B[i]);
    if (ids.length < 2) return null;
    const mA = centroid(ids, A), mB = centroid(ids, B);
    const sw = view.sw, sh = view.sh;
    const relX = (A[id].x - mA.x) * sw, relY = (A[id].y - mA.y) * sh;
    const th = (sp.deg * Math.PI / 180) * p;
    const ca = Math.cos(th), sa = Math.sin(th);
    const rX = relX * ca - relY * sa, rY = relX * sa + relY * ca;
    const tX = (B[id].x - mB.x) * sw, tY = (B[id].y - mB.y) * sh;
    const x = mA.x + (mB.x - mA.x) * p + (rX + (tX - rX) * p) / sw;
    const y = mA.y + (mB.y - mA.y) * p + (rY + (tY - rY) * p) / sh;
    return { x: clamp01(x), y: clamp01(y) };
  }

  // Posición de todos los bailarines en el tiempo b (en tiempos musicales)
  function positionsAt(c, b) {
    const segs = segmentsOf(c);
    if (!segs.length || b <= 0) return clonePos(c.frames[0].pos);
    const total = totalOf(c);
    if (b >= total) return clonePos(c.frames[c.frames.length - 1].pos);
    const s = segs.find((x) => b >= x.start && b < x.start + x.dur) || segs[segs.length - 1];
    if (s.kind === 'hold') return clonePos(c.frames[s.frame].pos);

    const p = ease(clamp01((b - s.start) / s.dur));
    const f = c.frames[s.from];
    const A = f.pos, B = c.frames[s.to].pos;
    const routes = f.routes || {};
    const out = {};
    for (const d of c.dancers) {
      const a = A[d.id] || B[d.id] || CENTER, bb = B[d.id] || A[d.id] || CENTER;
      const spun = spinPoint(f, A, B, d.id, p);
      if (spun) { out[d.id] = spun; continue; }
      const route = routes[d.id];
      out[d.id] = route && route.length
        ? routeAt(a, bb, route, p)
        : tween(a, bb, p, c.curved, d.id);
    }
    return out;
  }

  // ---------- Geometría y dibujo ----------
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

  function drawScene(pos, opts, turns) {
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

    // Trayectorias hacia la siguiente formación (solo en modo edición)
    if (edit && frameIdx < c.frames.length - 1) {
      const f = c.frames[frameIdx];
      const next = c.frames[frameIdx + 1].pos;
      for (const d of c.dancers) {
        const a = pos[d.id], b = next[d.id];
        if (!a || !b) continue;
        const route = f.routes && f.routes[d.id];
        const col = dancerColor(d);
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = col;
        const spin = f.spins && f.spins[d.id];
        if (spin) {
          ctx.setLineDash([]);
          ctx.lineWidth = 2;
          ctx.beginPath();
          for (let s = 0; s <= 30; s++) {
            const q0 = spinPoint(f, pos, next, d.id, ease(s / 30));
            if (!q0) break;
            const q = toPx(q0.x, q0.y);
            if (s === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
          }
          ctx.stroke();
        } else if (route && route.length) {
          ctx.setLineDash([]);
          ctx.lineWidth = 2;
          ctx.beginPath();
          for (let s = 0; s <= 30; s++) {
            const q = toPx(...Object.values(routeAt(a, b, route, s / 30)));
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
      // Vuelta propia: en edición se ve el arco que va a girar; al reproducir, una marca que gira
      const turn = turns[d.id];
      if (turn !== undefined) {
        if (edit) {
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = dancerColor(d);
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          const a0 = -Math.PI / 2;
          ctx.arc(q.x, q.y, rad * 1.45, a0, a0 + turn * Math.PI / 180, turn < 0);
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          const a = -Math.PI / 2 + turn * Math.PI / 180;
          ctx.strokeStyle = 'rgba(17,17,17,0.85)';
          ctx.lineWidth = 3;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(q.x + Math.cos(a) * rad * 0.3, q.y + Math.sin(a) * rad * 0.3);
          ctx.lineTo(q.x + Math.cos(a) * rad * 0.95, q.y + Math.sin(a) * rad * 0.95);
          ctx.stroke();
        }
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
    const turns = edit
      ? (frameIdx < c.frames.length - 1 ? (c.frames[frameIdx].turns || {}) : {})
      : selfAngles(c, playBeat);
    drawScene(pos, opts, turns);
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

  // ---------- Movimientos: rutas y vueltas ----------
  function guardMovement() {
    const c = chor();
    if (mode !== 'edit') return false;
    if (frameIdx >= c.frames.length - 1) {
      toast('La última formación no tiene movimiento hacia otra');
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
    updateStatus();
  }

  function spinSelection() {
    if (!guardMovement()) return;
    const c = chor(), f = c.frames[frameIdx];
    const ids = [...selection].filter((id) => f.pos[id]);
    if (ids.length < 2) return toast('Selecciona al menos 2 bailarines para hacer vueltas');
    const deg = parseFloat(prompt('Grados de giro mientras se mueven (360 = una vuelta, 720 = dos)', '360'));
    if (!deg) return;
    f.spins = f.spins || {};
    for (const id of ids) f.spins[id] = { deg, ids };
    touch();
    render();
    updateStatus();
  }

  // Vuelta propia: cada bailarín gira sobre sí mismo mientras se mueve (no cambia su camino)
  function spinSelfSelection() {
    if (!guardMovement()) return;
    const c = chor(), f = c.frames[frameIdx];
    const ids = [...selection].filter((id) => f.pos[id]);
    if (!ids.length) return toast('Selecciona bailarines primero');
    const deg = parseFloat(prompt('Grados que gira cada bailarín sobre sí mismo (360 = una vuelta)', '360'));
    if (!deg) return;
    f.turns = f.turns || {};
    for (const id of ids) f.turns[id] = deg;
    touch();
    render();
    updateStatus();
  }

  // Ángulo de la vuelta propia de cada bailarín en el tiempo b (durante el movimiento)
  function selfAngles(c, b) {
    const s = segmentsOf(c).find((x) => x.kind === 'move' && b >= x.start && b < x.start + x.dur);
    if (!s) return {};
    const p = ease(clamp01((b - s.start) / s.dur));
    const out = {};
    for (const [id, deg] of Object.entries(c.frames[s.from].turns || {})) out[id] = deg * p;
    return out;
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
    updateStatus();
  }

  function clearRoutes() {
    const f = chor().frames[frameIdx];
    let n = 0;
    for (const id of selection) {
      if (f.routes && f.routes[id]) { delete f.routes[id]; n++; }
      if (f.turns && f.turns[id]) { delete f.turns[id]; n++; }
      const sp = f.spins && f.spins[id];
      if (sp) {
        for (const other of sp.ids) delete f.spins[other];
        n++;
      }
    }
    if (!n) return toast('Esos bailarines no tienen ruta ni vuelta');
    touch();
    render();
    updateStatus();
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
      updateStatus();
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
    if (c.frames.length < 2 && !(c.frames[0].hold > 0)) return toast('Agrega una formación o una quieta para reproducir');
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

  function xInTrack(e) {
    const r = tl.querySelector('.tl-track').getBoundingClientRect();
    return e.clientX - r.left;
  }

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

  // ---------- Línea de tiempo: bloques de quieta y movimiento ----------
  function timelineBlock(kind, i, left, width, labelText, subText, on) {
    const blk = el('div', `tl-block tl-${kind}` + (on ? ' on' : ''));
    blk.dataset.frame = String(i);
    blk.style.left = (left * PPB) + 'px';
    blk.style.width = (width * PPB) + 'px';
    const lab = el('span', 'tl-label');
    lab.textContent = labelText;
    const sub = el('span', 'tl-sub');
    sub.textContent = subText;
    blk.append(lab, sub);
    return blk;
  }

  function addHandle(blk, kind, i) {
    const h = el('div', 'tl-handle');
    h.dataset.handle = kind;
    h.dataset.frame = String(i);
    blk.appendChild(h);
  }

  function renderTimeline() {
    const c = chor();
    const total = totalOf(c);
    const n = c.frames.length;
    const scroll = tl.scrollLeft;

    const track = el('div', 'tl-track');
    track.style.width = (total * PPB + 80) + 'px';

    const ruler = el('div', 'tl-ruler');
    for (let b = 0; b <= total; b += 4) {
      const t = el('div', 'tl-tick');
      t.style.left = (b * PPB) + 'px';
      t.textContent = String(b + 1);
      ruler.appendChild(t);
    }
    track.appendChild(ruler);

    let t = 0;
    c.frames.forEach((f, i) => {
      const hold = f.hold || 0;
      const isOn = mode === 'edit' && i === frameIdx;

      // Quieta: la formación se queda en su lugar
      const hb = timelineBlock('hold', i, t, hold, f.name, `quieta · ${hold} t`, isOn);
      addHandle(hb, 'hold', i);
      track.appendChild(hb);
      t += hold;

      // Movimiento: los bailarines caminan hacia la siguiente formación
      if (i < n - 1) {
        const mb = timelineBlock('move', i, t, f.beats, `→ ${c.frames[i + 1].name}`, `mover · ${f.beats} t`, false);
        addHandle(mb, 'move', i);
        track.appendChild(mb);
        t += f.beats;
      }
    });

    playheadEl = el('div', 'tl-playhead');
    track.appendChild(playheadEl);
    tl.replaceChildren(track);
    tl.scrollLeft = scroll;
    renderPlayhead();
  }

  function wireTimeline() {
    tl.addEventListener('pointerdown', (e) => {
      if (exporting) return;
      const handle = e.target.closest('[data-handle]');
      const ruler = e.target.closest('.tl-ruler');
      const blk = e.target.closest('.tl-block');
      if (handle) {
        const i = +handle.dataset.frame;
        const field = handle.dataset.handle === 'hold' ? 'hold' : 'beats';
        const f = chor().frames[i];
        drag = { kind: 'resize', frame: i, field, startX: e.clientX, startVal: f[field] || 0, changed: false };
      } else if (ruler) {
        drag = { kind: 'scrub' };
        scrubTo(xInTrack(e));
      } else if (blk) {
        drag = { kind: 'click', frame: +blk.dataset.frame, startX: e.clientX, moved: false };
      } else {
        return;
      }
      tl.setPointerCapture(e.pointerId);
    });

    tl.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (drag.kind === 'resize') {
        const dx = e.clientX - drag.startX;
        const min = drag.field === 'hold' ? 0 : 1;
        const nv = Math.max(min, Math.min(MAX_T, Math.round(drag.startVal + dx / PPB)));
        const f = chor().frames[drag.frame];
        if (nv !== (f[drag.field] || 0)) {
          f[drag.field] = nv;
          drag.changed = true;
          renderTimeline();
        }
      } else if (drag.kind === 'scrub') {
        scrubTo(xInTrack(e));
      } else if (drag.kind === 'click' && Math.abs(e.clientX - drag.startX) > 6) {
        drag.moved = true;
      }
    });

    const end = (cancelled) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (d.kind === 'resize') {
        if (d.changed) touch();
        updateTransport();
      } else if (d.kind === 'scrub') {
        updateTransport();
      } else if (d.kind === 'click' && !cancelled && !d.moved) {
        setFrame(d.frame);
      }
    };
    tl.addEventListener('pointerup', () => end(false));
    tl.addEventListener('pointercancel', () => end(true));
  }

  // ---------- Formaciones y bailarines ----------
  function bump(field, delta) {
    ensureEdit();
    const c = chor(), f = c.frames[frameIdx];
    if (field === 'hold') {
      f.hold = Math.max(0, Math.min(MAX_T, (f.hold || 0) + delta));
    } else {
      if (frameIdx >= c.frames.length - 1) return toast('La última formación no tiene movimiento');
      f.beats = Math.max(1, Math.min(MAX_T, f.beats + delta));
    }
    touch();
    updateTransport();
  }

  function addFrame(duplicate) {
    ensureEdit();
    const c = chor(), src = c.frames[frameIdx];
    const nf = newFrame(
      duplicate ? `${src.name} (copia)` : `Formación ${c.frames.length + 1}`,
      clonePos(src.pos),
      duplicate ? src.hold || 0 : 0,
      8
    );
    nf.notes = duplicate ? src.notes : '';
    c.frames.splice(frameIdx + 1, 0, nf);
    touch();
    setFrame(frameIdx + 1);
  }

  function delFrame() {
    const c = chor();
    if (c.frames.length <= 1) return toast('Debe quedar al menos una formación');
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
    c.frames.forEach((f) => selection.forEach((id) => {
      delete f.pos[id];
      if (f.routes) delete f.routes[id];
      if (f.spins) delete f.spins[id];
      if (f.turns) delete f.turns[id];
    }));
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

    for (const id of ['btnToolRoute', 'btnToolTurn', 'btnToolSelf', 'btnUndoWp', 'btnClearRoutes']) {
      $(id).disabled = !inEdit;
    }
    $('btnToolRoute').classList.toggle('on', tool === 'ruta');

    $('bpm').value = c.bpm;
    $('offset').value = (c.offset || 0).toFixed(2);
    $('curved').checked = c.curved;
    $('snap').checked = c.snap;

    renderTimeline();
    updateStatus();
  }

  let audioBlob = null;

  // ---------- Detección automática de BPM y del primer tiempo ----------
  // Busca el ritmo que mejor "calza" con los golpes de la música (pulso regular) y,
  // con la misma cuenta, en qué segundo cae cada golpe del pulso.
  function analyzeBuffer(buf) {
    const sr = buf.sampleRate;
    const chans = [];
    for (let i = 0; i < buf.numberOfChannels; i++) chans.push(buf.getChannelData(i));

    // 1) Mezcla a mono y baja la tasa a ~11 kHz (basta para encontrar golpes)
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
    // Nos quedamos con los graves (bombo y bajo): el hi-hat agudo confunde el pulso
    const alpha = 1 - Math.exp(-2 * Math.PI * 150 / (sr / D));
    let y = 0;
    for (let i = 0; i < M; i++) {
      y += alpha * (mono[i] - y);
      mono[i] = y;
    }

    // 2) Energía por cuadros de 128 muestras; un "golpe" es un aumento repentino
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

    // 3) Qué tan fuerte es un pulso a una velocidad dada (transformada en esa frecuencia)
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

    // 4) Busca entre 60 y 200 BPM: primero grueso, luego fino (0,01 BPM)
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
    // Evita el error "al doble": si el tiempo a la mitad también tiene fuerza, ese es el ritmo
    for (;;) {
      if (best.bpm / 2 < 60) break;
      const half = refine(best.bpm / 2);
      if (half.p < 0.5 * best.p) break;
      best = half;
    }

    // 5) Primer tiempo: la fase del pulso dentro de un tiempo
    const bpm = Math.round(best.bpm * 100) / 100;
    const q = probe(bpm);
    const period = 60 / bpm;
    const P = 2 * Math.PI / q.w;            // duración de un tiempo, en cuadros
    let i0 = -Math.atan2(q.im, q.re) / q.w;
    i0 = ((i0 % P) + P) % P;
    const offset = Math.round(((i0 / fps) % period) * 100) / 100;
    return { bpm, offset };
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

  // ---------- Exportar / compartir / importar ----------
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

    const tracks = [...canvas.captureStream(30).getVideoTracks()];
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
        audioEl.pause();
        rec.stop();
        return;
      }
      playBeat = secToBeat(sec, c.bpm);
      render({ clean: true });
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
      data.bpm = data.bpm || 120;
      data.crews = data.crews || [];
      data.offset = data.offset || 0;
      data.updatedAt = Date.now();
      data.frames.forEach((fr) => {
        fr.beats = fr.beats || 8;
        fr.hold = fr.hold || 0;
        fr.notes = fr.notes || '';
        fr.name = fr.name || 'Formación';
        fr.routes = fr.routes || {};
        fr.spins = fr.spins || {};
        fr.turns = fr.turns || {};
      });
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
      chor().frames[frameIdx].name = e.target.value.slice(0, 30) || 'Formación';
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
    $('btnToolTurn').onclick = spinSelection;
    $('btnToolSelf').onclick = spinSelfSelection;
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

    $('btnExportVideo').onclick = exportVideo;
    $('btnExportPng').onclick = exportPng;
    $('btnShare').onclick = shareChoreo;
    $('btnExportJson').onclick = () => {
      const c = chor();
      download(new Blob([JSON.stringify(c, null, 2)], { type: 'application/json' }), `${safeName(c.name)}.json`);
    };
    $('btnImport').onclick = () => $('importFile').click();
    $('importFile').onchange = importChoreo;

    document.querySelectorAll('[data-close]').forEach((b) => {
      b.onclick = () => b.closest('dialog').close();
    });
  }

  // ---------- Arranque ----------
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
