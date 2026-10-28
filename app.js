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
  const END_W = 56; // ancho del bloque final

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
  function newChoreo(name) {
    const dancers = [];
    const pos = {};
    for (let i = 0; i < 6; i++) {
      const d = { id: uid(), label: labelFor(i), color: PALETTE[i % PALETTE.length], crewId: null };
      dancers.push(d);
      pos[d.id] = { x: 0.2 + 0.12 * i, y: 0.5 };
    }
    return {
      id: uid(), name, bpm: 120, curved: false, snap: true,
      dancers, crews: [],
      frames: [{ id: uid(), name: 'Inicio', notes: '', beats: 8, pos, routes: {} }],
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
  // Todo el tiempo interno va en "tiempos" (beats). Los segundos salen del BPM.
  let frameIdx = 0;
  let mode = 'edit';           // 'edit' | 'preview' | 'play'
  let tool = 'mover';          // 'mover' | 'ruta' | 'vuelta'
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

  // ---------- Línea de tiempo (en tiempos musicales) ----------
  function segmentsOf(c) {
    const segs = [];
    let t = 0;
    for (let i = 0; i < c.frames.length - 1; i++) {
      const dur = c.frames[i].beats;
      segs.push({ from: i, to: i + 1, start: t, dur });
      t += dur;
    }
    return segs;
  }
  function totalOf(c) {
    const s = segmentsOf(c);
    return s.length ? s[s.length - 1].start + s[s.length - 1].dur : 0;
  }
  function startOfFrame(c, i) {
    let t = 0;
    for (let j = 0; j < i; j++) t += c.frames[j].beats;
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
  function positionsAt(c, b) {
    const segs = segmentsOf(c);
    if (!segs.length || b <= 0) return clonePos(c.frames[0].pos);
    const total = totalOf(c);
    if (b >= total) return clonePos(c.frames[c.frames.length - 1].pos);
    const s = segs.find((x) => b >= x.start && b < x.start + x.dur) || segs[segs.length - 1];
    const p = ease(clamp01((b - s.start) / s.dur));
    const A = c.frames[s.from].pos, B = c.frames[s.to].pos;
    const f = c.frames[s.from];
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

  function drawScene(pos, opts) {
    const c = chor();
    const edit = mode === 'edit' && !opts.clean;
    const { dpr, w, h, sx, sy, sw, sh } = view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Escenario (claro, al estilo de la libreta)
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

    // Trayectorias hacia la siguiente formación (rutas suavizadas o línea punteada)
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
        const B = toPx(b.x, b.y);
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(B.x, B.y, rad * 0.8, 0, Math.PI * 2);
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
    const pos = mode === 'edit' ? c.frames[frameIdx].pos : positionsAt(c, playBeat);
    drawScene(pos, opts);
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

  // ---------- Rutas: puntos intermedios y vueltas ----------
  function guardRoutes() {
    const c = chor();
    if (mode !== 'edit') return false;
    if (frameIdx >= c.frames.length - 1) {
      toast('La última formación no tiene transición hacia otra');
      return false;
    }
    return true;
  }

  function addWaypointAt(pt) {
    if (!guardRoutes()) return;
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
    if (!guardRoutes()) return;
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
    if (c.frames.length < 2) return toast('Necesitas al menos 2 formaciones');
    if (mode === 'edit') playBeat = startOfFrame(c, frameIdx);
    if (playBeat >= totalOf(c)) playBeat = 0;
    mode = 'play';
    playing = true;
    selection = new Set();
    clockStart = performance.now() - beatToSec(playBeat, c.bpm) * 1000;
    if (audioLoaded) {
      audioEl.currentTime = beatToSec(playBeat, c.bpm);
      audioEl.play().catch(() => {});
    }
    updateTransport();
    rafId = requestAnimationFrame(tick);
  }

  function tick() {
    const c = chor();
    const total = totalOf(c);
    const useAudio = audioLoaded && !audioEl.error && audioEl.readyState >= 2;
    let sec;
    if (useAudio) {
      sec = audioEl.currentTime;
      clockStart = performance.now() - sec * 1000; // el reloj sigue al audio si este termina antes
    } else {
      sec = (performance.now() - clockStart) / 1000;
    }
    const b = secToBeat(sec, c.bpm);
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
    if (audioLoaded) audioEl.currentTime = beatToSec(b, c.bpm);
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

  // ---------- Línea de tiempo: bloques, regla y cabezal ----------
  function renderTimeline() {
    const c = chor();
    const total = totalOf(c);
    const n = c.frames.length;
    const scroll = tl.scrollLeft;

    const track = el('div', 'tl-track');
    track.style.width = (total * PPB + END_W + 40) + 'px';

    const ruler = el('div', 'tl-ruler');
    for (let b = 0; b <= total; b += 4) {
      const t = el('div', 'tl-tick');
      t.style.left = (b * PPB) + 'px';
      t.textContent = String(b + 1);
      ruler.appendChild(t);
    }
    track.appendChild(ruler);

    let start = 0;
    c.frames.forEach((f, i) => {
      const last = i === n - 1;
      const cls = 'tl-block' + (last ? ' end' : '') + (mode === 'edit' && i === frameIdx ? ' on' : '');
      const blk = el('div', cls);
      blk.dataset.frame = String(i);
      blk.style.left = (start * PPB) + 'px';
      blk.style.width = (last ? END_W : f.beats * PPB) + 'px';

      const lab = el('span', 'tl-label');
      lab.textContent = f.name;
      blk.appendChild(lab);

      if (!last) {
        const sub = el('span', 'tl-sub');
        sub.textContent = `${f.beats} tiempos · ${fmt(beatToSec(f.beats, c.bpm))}`;
        blk.appendChild(sub);
        const h = el('div', 'tl-handle');
        h.dataset.handle = '1';
        h.dataset.frame = String(i);
        blk.appendChild(h);
        start += f.beats;
      }
      track.appendChild(blk);
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
        drag = { kind: 'resize', frame: i, startX: e.clientX, startBeats: chor().frames[i].beats, changed: false };
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
        const nb = Math.max(1, Math.min(64, Math.round(drag.startBeats + dx / PPB)));
        const f = chor().frames[drag.frame];
        if (nb !== f.beats) {
          f.beats = nb;
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
  function addFrame(duplicate) {
    ensureEdit();
    const c = chor(), src = c.frames[frameIdx];
    const nf = {
      id: uid(),
      name: duplicate ? `${src.name} (copia)` : `Formación ${c.frames.length + 1}`,
      notes: duplicate ? src.notes : '',
      beats: 8,
      pos: clonePos(src.pos),
      routes: {}
    };
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
      list.innerHTML = '<p class="muted">Aún no hay crews. Selecciona bailarines en el escenario y crea uno.</p>';
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
    const c = chor();
    let text;
    if (mode !== 'edit') {
      text = `${fmt(beatToSec(playBeat, c.bpm))} / ${fmt(beatToSec(totalOf(c), c.bpm))}`;
    } else if (tool === 'ruta') {
      text = `Ruta: toca el escenario para añadir un punto a ${selection.size} bailarín(es)`;
    } else {
      text = `Formación ${frameIdx + 1}/${c.frames.length}: ${c.frames[frameIdx].name}`;
    }
    $('status').textContent = text;
  }

  function updateTransport() {
    const c = chor(), n = c.frames.length;
    const f = c.frames[frameIdx];
    const inEdit = mode === 'edit' && frameIdx < n - 1;
    if (!inEdit) tool = 'mover';
    $('btnPlay').textContent = playing ? '⏸' : '▶';
    $('btnPlay').disabled = exporting;
    $('btnExportVideo').disabled = exporting;
    $('bpm').value = c.bpm;
    $('curved').checked = c.curved;
    $('snap').checked = c.snap;
    $('transBeats').value = f.beats;
    $('transBeats').disabled = mode !== 'edit' || frameIdx >= n - 1;
    $('btnDelFrame').disabled = n <= 1;
    $('btnNotes').classList.toggle('dot', !!f.notes);
    for (const id of ['btnToolRoute', 'btnToolTurn', 'btnUndoWp', 'btnClearRoutes']) {
      $(id).disabled = !inEdit;
    }
    $('btnToolRoute').classList.toggle('on', tool === 'ruta');
    renderTimeline();
    updateStatus();
  }

  function loadAudio(file) {
    if (!file) return;
    stopPlay();
    if (audioEl.src.startsWith('blob:')) URL.revokeObjectURL(audioEl.src);
    audioEl.src = URL.createObjectURL(file);
    audioLoaded = true;
    $('audioName').textContent = file.name;
    $('audioFile').value = '';
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
    if (!total) return toast('Agrega al menos 2 formaciones');
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
    if (audioLoaded) { audioEl.currentTime = 0; audioEl.play().catch(() => {}); }

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
      data.updatedAt = Date.now();
      data.frames.forEach((fr) => {
        fr.beats = fr.beats || 8;
        fr.notes = fr.notes || '';
        fr.name = fr.name || 'Formación';
        fr.routes = fr.routes || {};
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

  function setToolToggle(name) {
    if (!guardRoutes()) return;
    tool = tool === name ? 'mover' : name;
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
      $('btnNotes').classList.toggle('dot', !!e.target.value);
    };
    $('transBeats').onchange = (e) => {
      const f = chor().frames[frameIdx];
      f.beats = Math.max(1, Math.min(64, parseInt(e.target.value, 10) || 8));
      touch();
      updateTransport();
    };
    $('bpm').onchange = (e) => {
      chor().bpm = Math.max(30, Math.min(300, parseInt(e.target.value, 10) || 120));
      touch();
      updateTransport();
    };
    $('curved').onchange = (e) => { chor().curved = e.target.checked; touch(); render(); };
    $('snap').onchange = (e) => { chor().snap = e.target.checked; touch(); render(); };

    $('btnToolRoute').onclick = () => setToolToggle('ruta');
    $('btnToolTurn').onclick = spinSelection;
    $('btnUndoWp').onclick = undoWaypoint;
    $('btnClearRoutes').onclick = clearRoutes;

    $('btnAddDancer').onclick = addDancer;
    $('btnRemoveDancer').onclick = removeSelected;
    $('btnCrews').onclick = () => { ensureEdit(); renderCrews(); $('dlgCrews').showModal(); };
    $('btnCrewFromSel').onclick = createCrewFromSelection;
    $('btnCrewClear').onclick = clearCrewFromSelection;

    $('btnMusic').onclick = () => $('audioFile').click();
    $('audioFile').onchange = (e) => loadAudio(e.target.files[0]);
    audioEl.onerror = () => {
      audioLoaded = false;
      $('audioName').textContent = 'No se pudo cargar esa música';
    };

    $('btnExportPng').onclick = exportPng;
    $('btnExportVideo').onclick = exportVideo;
    $('btnExportJson').onclick = () => {
      const c = chor();
      download(new Blob([JSON.stringify(c, null, 2)], { type: 'application/json' }), `${safeName(c.name)}.json`);
    };
    $('btnShare').onclick = shareChoreo;
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
