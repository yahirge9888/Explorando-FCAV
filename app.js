(() => {
  const NS = "http://www.w3.org/2000/svg";
  const $ = (id) => document.getElementById(id);
  const svg = $("map");
  const el = (tag, attrs = {}, parent) => {
    const n = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
    if (parent) parent.appendChild(n);
    return n;
  };

  let activeCat = "all";
  let selected = null;
  let floor = "ext";
  let activeRoute = null;
  // Ruta en dos pasos: primero hasta la escalera; al confirmar, el tramo de la otra planta.
  let routePlan = null;

  const floorLabel = (id) => (FLOORS.find((f) => f.id === id) || FLOORS[0]).label;
  const listed = (p) => CATEGORIES[p.cat].listed !== false;
  const floorOfRaw = (p) => (FLOORS.some((f) => f.id === p.floor) ? p.floor : "ext");
  // Edificio dibujado en la vista aérea. También es un destino de «Cómo llegar» desde una planta.
  const isOutdoorBuilding = (p) => floorOfRaw(p) === "ext" && p.kind === "poly" && p.cat === "edificio";
  // Una escalera vive en varias plantas a la vez (spans); el resto, en una sola.
  function placeFloors(p) {
    if (p.kind === "stair" && p.spans) {
      return FLOORS.map((f) => f.id).filter((id) => Array.isArray(p.spans[id]) && p.spans[id].length === 2);
    }
    return [floorOfRaw(p)];
  }
  function onFloor(p, id) {
    return placeFloors(p).includes(id);
  }
  // Para una escalera, la planta "actual" es la que se está viendo si ella está ahí.
  const floorOf = (p) => {
    if (p.kind === "stair") {
      const ids = placeFloors(p);
      if (ids.includes(floor)) return floor;
      return ids[0] || "p1";
    }
    return floorOfRaw(p);
  };
  function anchorOf(p, floorId) {
    if (p.kind === "stair") return (p.spans && p.spans[floorId]) || null;
    if ((p.kind === "wall" || p.kind === "zone") && p.points) {
      const pts = p.points.trim().split(/\s+/).map((q) => q.split(",").map(Number));
      return pts[Math.floor((pts.length - 1) / 2)] || null;
    }
    if (p.kind === "poly") return p.labelPos;
    return p.door;
  }

  // API compartida con el editor (editor.js)
  const App = (window.App = { editing: false, routeMode: false, hooks: {} });
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Fuente de verdad: /api/map (server.py). localStorage es caché / respaldo sin servidor.
  const STORE_KEY = "mapa-facultad-v1";
  App.STORE_KEY = STORE_KEY;
  App.syncMode = "local"; // "server" | "local"

  const validSaved = (saved) =>
    Array.isArray(saved) && saved.length && saved.every((p) => p && p.id && CATEGORIES[p.cat]);

  function readLocalCache() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY));
      return validSaved(saved) ? saved : null;
    } catch (err) {
      return null;
    }
  }

  function slimPlace(p) {
    if (p && typeof p.photo === "string" && p.photo.startsWith("data:")) {
      const copy = Object.assign({}, p);
      copy.photo = true;
      return copy;
    }
    return p;
  }
  App.slimPlaces = (list) => list.map(slimPlace);

  // La imagen no viene en el mapa. photo: true significa que hay un archivo aparte.
  App.photoSrc = (p) => {
    if (!p || !p.photo) return "";
    if (p.photo === true) return "/api/foto/" + encodeURIComponent(p.id) + (p.photoRev ? "?v=" + p.photoRev : "");
    if (typeof p.photo === "string" && (p.photo.startsWith("data:") || p.photo.startsWith("/api/foto/"))) return p.photo;
    return "";
  };

  function writeLocalCache(list) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(App.slimPlaces(list))); } catch (err) { /* cuota */ }
  }

  function applyPlaces(list, persistLocal) {
    if (!validSaved(list)) return false;
    PLACES.splice(0, PLACES.length, ...list);
    if (persistLocal) writeLocalCache(PLACES);
    return true;
  }

  // Sin servidor (file://) sí usamos la caché local para no perder el trabajo
  if (location.protocol === "file:") {
    const cached = readLocalCache();
    if (cached) applyPlaces(cached, false);
  }

  // ---------- Dibujo del croquis ----------
  const VB = { w: 1024, h: 580 };
  const viewport = el("g", { id: "viewport" }, svg);

  // Patrón rayado para estacionamientos
  const defs = el("defs", {}, svg);
  const pat = el("pattern", { id: "hatch", width: 8, height: 8, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
  el("line", { x1: 0, y1: 0, x2: 0, y2: 8, class: "hatch-line" }, pat);

  el("rect", { x: -400, y: -300, width: VB.w + 800, height: VB.h + 600, class: "ground" }, viewport);

  // Zonas de estacionamiento (rayadas)
  ["0,130 118,130 112,360 0,360", "752,128 884,160 884,205 752,170"].forEach((pts) =>
    el("polygon", { points: pts, fill: "url(#hatch)", class: "parking-zone" }, viewport));

  // Calles (trazos gruesos)
  const road = (d, w, cls = "road") => el("path", { d, class: cls, "stroke-width": w }, viewport);
  road("M -40,62 L 230,68 C 450,72 650,95 760,150 C 850,195 905,240 912,320 L 918,560", 26);
  road("M -40,542 C 200,534 500,540 940,528", 22);
  road("M 152,60 L 95,540", 22);
  road("M 235,60 L 190,540", 22);
  road("M 300,345 L 287,532", 9);
  road("M 690,100 L 745,150", 10);

  // Nombres de calles
  [[128, 300], [213, 300]].forEach(([x, y]) => {
    const t = el("text", { x, y, class: "road-name", transform: `rotate(-84 ${x} ${y})` }, viewport);
    t.textContent = "Universidad";
  });

  // Edificios de contexto
  BG_BUILDINGS.forEach((pts) => el("polygon", { points: pts, class: "bg-building" }, viewport));

  const routeLayer = el("g", {}, viewport);
  const placesLayer = el("g", {}, viewport);
  let buildingEls = {};

  const addLabel = (parent, text, x, y, cls, anchor = "middle", size = 0) => {
    const lines = String(text).split("\n");
    const dy = size ? size * 1.15 : 15;
    const y0 = size && lines.length > 1 ? y - ((lines.length - 1) * dy) / 2 : y;
    const t = el("text", { x, y: y0, class: cls, "text-anchor": anchor }, parent);
    if (size) {
      t.style.fontSize = size + "px";
      t.style.strokeWidth = Math.max(1.25, size * 0.22) + "px";
    }
    lines.forEach((line, i) => {
      const s = el("tspan", { x, dy: i === 0 ? 0 : dy }, t);
      s.textContent = line;
    });
  };

  // En figuras chicas (salones pegados) la letra de 14 no cabe y se monta con la vecina.
  function labelSize(p) {
    if (p.kind !== "poly" || !p.points || !p.label) return 0;
    const pts = p.points.trim().split(/\s+/).map((q) => q.split(",").map(Number)).filter((q) => q.length === 2 && q.every((n) => n === n));
    if (pts.length < 3) return 0;
    let minY = Infinity, maxY = -Infinity;
    const across = [];
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i];
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      const [x2, y2] = pts[(i + 1) % pts.length];
      const dx = Math.abs(x2 - x), dy = Math.abs(y2 - y);
      if (dx >= dy) across.push(dx);
    }
    const w = across.length ? Math.min(...across) : 0;
    const h = maxY - minY;
    if (!(w > 0) || !(h > 0)) return 0;
    const lines = String(p.label).split("\n");
    const longest = lines.reduce((m, line) => Math.max(m, line.length), 1);
    const size = Math.min(14, (w * 0.92) / (longest * 0.56), (h * 0.7) / (lines.length * 1.2));
    if (size >= 13) return 0;
    return Math.max(7, Math.round(size * 10) / 10);
  }

  // Hacia qué lado abre la puerta: +1 si el eje local +Y cae dentro del lugar.
  function doorSwing(p) {
    if (p.kind !== "poly" || !Array.isArray(p.entry) || !p.points) return 1;
    const a = (p.entryAngle || 0) * Math.PI / 180;
    const test = [p.entry[0] - Math.sin(a) * 8, p.entry[1] + Math.cos(a) * 8];
    const pts = p.points.trim().split(/\s+/).map((q) => q.split(",").map(Number));
    return inside(test, pts) ? 1 : -1;
  }
  function drawDoor(parent, p, color) {
    if (!Array.isArray(p.entry)) return;
    const [x, y] = p.entry;
    const sign = doorSwing(p);
    const w = 7;
    const g = el("g", { class: "door", transform: `translate(${x} ${y}) rotate(${p.entryAngle || 0})` }, parent);
    el("line", { x1: -w, y1: 0, x2: w, y2: 0, class: "door-gap" }, g);
    el("line", { x1: -w, y1: -2.5, x2: -w, y2: 2.5, class: "door-jamb", stroke: color }, g);
    el("line", { x1: w, y1: -2.5, x2: w, y2: 2.5, class: "door-jamb", stroke: color }, g);
    const sy = sign * w * 2;
    el("path", { d: `M ${-w} 0 A ${w * 2} ${w * 2} 0 0 ${sign > 0 ? 1 : 0} 0 ${sy}`, class: "door-swing", stroke: color }, g);
  }
  function drawOne(p) {
    const color = CATEGORIES[p.cat].color;
    const attrs = { class: "building cat-" + p.cat, "data-id": p.id, style: `--c:${color}` };
    if (p.kind !== "wall" && p.kind !== "route") {
      attrs.tabindex = 0;
      attrs.role = "button";
      attrs["aria-label"] = p.name;
    }
    const g = el("g", attrs, placesLayer);
    if (p.kind === "zone") {
      el("polygon", { points: p.points, class: "shape walk-zone", fill: color, stroke: color }, g);
    } else if (p.kind === "wall" || p.kind === "route") {
      const net = p.kind === "route";
      el("polyline", { points: p.points, class: net ? "route-hit" : "wall-hit" }, g);
      el("polyline", { points: p.points, class: net ? "route-net" : "wall-line", stroke: color }, g);
    } else if (p.kind === "stair") {
      const [x, y] = p.spans[floor];
      const body = el("g", { class: "stair", transform: `translate(${x} ${y})` }, g);
      el("rect", { x: -12, y: -16, width: 24, height: 32, rx: 3, class: "shape stair-body", fill: color, stroke: color }, body);
      for (let i = 0; i < 5; i++) el("line", { x1: -9, y1: -10 + i * 5, x2: 9, y2: -10 + i * 5, class: "stair-step" }, body);
      const other = floor === "p1" ? "p2" : floor === "p2" ? "p1" : null;
      if (other && p.spans[other]) {
        const t = el("text", { y: -22, class: "stair-link" }, body);
        t.textContent = other === "p2" ? "↔ P2" : "↔ P1";
      }
      addLabel(g, p.label, x, y + 36, "lbl stair-lbl", "middle");
    } else if (p.kind === "poly") {
      el("polygon", { points: p.points, class: "shape", fill: color, stroke: color }, g);
      addLabel(g, p.label, p.labelPos[0], p.labelPos[1], "lbl", "middle", labelSize(p));
      drawDoor(g, p, color);
    } else {
      const [x, y] = p.door;
      el("circle", { cx: x, cy: y, r: 11, class: "shape pin", fill: color, stroke: color }, g);
      el("text", { x, y: y + 4, class: "pin-icon" }, g).textContent =
        p.cat === "estacionamiento" ? "P" : p.cat === "escalera" ? "⇅" : p.id === "biblioteca" ? "B" : "★";
      const off = p.labelOffset || [18, 4];
      addLabel(g, p.label, x + off[0], y + off[1], "lbl pin-lbl", p.anchor || "start");
      drawDoor(g, p, color);
    }
    const open = () => {
      if (App.editing) { if (App.hooks.onShapeClick) App.hooks.onShapeClick(p.id); return; }
      if (p.kind === "wall" || p.kind === "route" || p.kind === "zone") return;
      select(p.id);
    };
    g.addEventListener("click", (e) => { e.stopPropagation(); open(); });
    g.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
    buildingEls[p.id] = g;
  }
  function drawPlaces() {
    placesLayer.innerHTML = "";
    buildingEls = {};
    svg.dataset.floor = floor;
    // En una planta, los edificios del exterior quedan como contorno de referencia
    if (floor !== "ext") {
      // El nombre del edificio solo se muestra si aún no tiene nada dibujado en esta planta
      const occupied = new Set(PLACES.filter((p) => onFloor(p, floor)).map((p) => (containerOf(p) || {}).id));
      PLACES.forEach((p) => {
        if (floorOfRaw(p) !== "ext" || p.kind !== "poly" || p.cat !== "edificio") return;
        const g = el("g", { class: "floor-plate" + (selected === p.id ? " active" : ""), "data-id": p.id }, placesLayer);
        el("polygon", { points: p.points }, g);
        if (!occupied.has(p.id)) addLabel(g, p.label, p.labelPos[0], p.labelPos[1], "plate-lbl");
      });
    }
    const here = PLACES.filter((p) => onFloor(p, floor));
    if (App.editing) here.filter((p) => p.kind === "zone").forEach(drawOne);
    here.filter((p) => p.kind === "wall").forEach(drawOne);
    here.filter((p) => p.kind !== "wall" && p.kind !== "route" && p.kind !== "zone").forEach(drawOne);
    if (App.routeMode) here.filter((p) => p.kind === "route").forEach(drawOne);
  }
  drawPlaces();

  const [ex, ey] = NODES[ENTRANCE.link];
  const ent = el("g", { class: "entrance" }, viewport);
  el("circle", { cx: ex, cy: ey, r: 8 }, ent);
  el("circle", { cx: ex, cy: ey, r: 8, class: "pulse" }, ent);
  el("text", { x: ex + 14, y: ey + 4, "text-anchor": "start" }, ent).textContent = "Entrada";

  // ---------- Pan y zoom ----------
  // rot gira el croquis alrededor del centro de la pantalla (modo brújula).
  // follow mantiene a la persona en ese centro mientras el mapa gira.
  const CX = 512, CY = 290;
  let view = { x: 0, y: 0, k: 1, rot: 0, follow: false };
  // Deshace el giro para volver al plano del translate/scale (y abajo, ángulo horario).
  function unrotate(x, y) {
    const rot = view.rot || 0;
    if (!rot) return [x, y];
    const rad = (rot * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const dx = x - CX, dy = y - CY;
    return [CX + dx * cos + dy * sin, CY - dx * sin + dy * cos];
  }
  const applyView = (notify = true) => {
    const rot = view.rot || 0;
    const base = `translate(${view.x} ${view.y}) scale(${view.k})`;
    viewport.setAttribute(
      "transform",
      rot ? `translate(${CX} ${CY}) rotate(${rot}) translate(${-CX} ${-CY}) ${base}` : base
    );
    updateCompass();
    if (notify && App.hooks.onView) App.hooks.onView();
  };
  const zoomAt = (factor, cx = CX, cy = CY) => {
    if (view.follow && userPos) { cx = CX; cy = CY; }
    const [ux, uy] = unrotate(cx, cy);
    const k = Math.min(3, Math.max(0.6, view.k * factor));
    view.x = ux - ((ux - view.x) / view.k) * k;
    view.y = uy - ((uy - view.y) / view.k) * k;
    view.k = k;
    applyView();
  };
  $("zoom-in").onclick = () => zoomAt(1.25);
  $("zoom-out").onclick = () => zoomAt(0.8);
  $("zoom-reset").onclick = () => {
    view.x = 0; view.y = 0; view.k = 1;
    if (!headingOn) { view.rot = 0; shownRot = 0; }
    else if (userPos) view.follow = true;
    applyView();
  };

  const toSvg = (e) => {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  };
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = toSvg(e);
    zoomAt(e.deltaY < 0 ? 1.12 : 0.89, p.x, p.y);
  }, { passive: false });

  // Punteros activos (mouse o dedos) para arrastrar con 1 y pellizcar con 2
  const pointers = new Map();
  let drag = null, pinch = null, moved = false;
  const pinchInfo = () => {
    const [a, b] = [...pointers.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  };
  svg.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pointers.size === 1) {
      drag = { p: toSvg(e), x: view.x, y: view.y, sx: e.clientX, sy: e.clientY };
      svg.classList.add("dragging");
    } else if (pointers.size === 2) {
      drag = null;
      const i = pinchInfo();
      pinch = { d: i.d, k: view.k };
    }
  });
  window.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const i = pinchInfo();
      const c = toSvg({ clientX: i.cx, clientY: i.cy });
      const target = Math.min(3, Math.max(0.6, pinch.k * (i.d / pinch.d)));
      zoomAt(target / view.k, c.x, c.y);
      moved = true;
      return;
    }
    if (!drag) return;
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) moved = true;
    if (!moved) return;
    view.follow = false;
    const p = toSvg(e);
    const dx = p.x - drag.p.x, dy = p.y - drag.p.y;
    const rad = ((view.rot || 0) * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    view.x = drag.x + dx * cos + dy * sin;
    view.y = drag.y - dx * sin + dy * cos;
    applyView();
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) { drag = null; svg.classList.remove("dragging"); }
    else if (pointers.size === 1) {
      const [only] = pointers.values();
      drag = { p: toSvg({ clientX: only.x, clientY: only.y }), x: view.x, y: view.y, sx: only.x, sy: only.y };
    }
  };
  window.addEventListener("pointerup", endPointer);
  window.addEventListener("pointercancel", endPointer);
  // Si hubo arrastre, no abrir el lugar sobre el que terminó el gesto
  svg.addEventListener("click", (e) => { if (moved) { e._dragged = true; e.stopPropagation(); moved = false; } }, true);
  // Coordenadas del puntero en el sistema del croquis (descontando pan y zoom)
  const toMap = (e) => {
    const p = toSvg(e);
    const [x, y] = unrotate(p.x, p.y);
    return [(x - view.x) / view.k, (y - view.y) / view.k];
  };

  // ---------- Filtros y lista ----------
  const filters = $("filters");
  const addChip = (key, label, color) => {
    const b = document.createElement("button");
    b.className = "chip" + (key === activeCat ? " active" : "");
    b.innerHTML = (color ? `<i style="background:${color}"></i>` : "") + label;
    b.onclick = () => { activeCat = key; render(); };
    b.dataset.key = key;
    filters.appendChild(b);
  };
  addChip("all", "Todos");
  Object.entries(CATEGORIES).forEach(([k, c]) => { if (c.listed !== false) addChip(k, c.label, c.color); });

  function render() {
    // En una planta, los edificios del campus también se pueden elegir como destino.
    const present = new Set(PLACES.filter((p) => onFloor(p, floor)).map((p) => p.cat));
    if (floor !== "ext" && PLACES.some(isOutdoorBuilding)) present.add("edificio");
    if (activeCat !== "all" && !present.has(activeCat)) activeCat = "all";
    filters.querySelectorAll(".chip").forEach((c) => {
      c.classList.toggle("active", c.dataset.key === activeCat);
      c.hidden = c.dataset.key !== "all" && !present.has(c.dataset.key);
    });
    const list = $("place-list");
    list.innerHTML = "";
    const rows = [];
    PLACES.forEach((p, index) => {
      const here = onFloor(p, floor);
      const asBuilding = !here && floor !== "ext" && isOutdoorBuilding(p);
      if (!here && !asBuilding) return;
      const g = buildingEls[p.id];
      const visible = p.kind === "wall" || p.kind === "route" || p.kind === "zone" || activeCat === "all" || p.cat === activeCat || (App.photoOnly && p.cat === "aula");
      if (g) {
        g.classList.toggle("dim", !visible);
        g.classList.toggle("active", selected === p.id);
      }
      if (!visible || !listed(p)) return;
      rows.push({ p, asBuilding, index });
    });
    // Primero lo de esta planta, en el orden de siempre; después los edificios del campus.
    rows.sort((a, b) => Number(a.asBuilding) - Number(b.asBuilding) || a.index - b.index);
    rows.forEach(({ p, asBuilding }) => {
      const li = document.createElement("li");
      li.className = "place-item" + (selected === p.id ? " active" : "");
      const detail = asBuilding ? "Edificios · entrada" : `${CATEGORIES[p.cat].label} · ${esc(p.hours)}`;
      li.innerHTML = `<i class="place-dot" style="background:${CATEGORIES[p.cat].color}"></i>
        <div><strong>${esc(p.name)}</strong><span>${detail}</span></div>`;
      li.onclick = () => select(p.id);
      list.appendChild(li);
    });
    if (!list.children.length) {
      const li = document.createElement("li");
      li.className = "place-empty";
      li.textContent = floor === "ext"
        ? "No hay lugares con este filtro."
        : `Aún no hay aulas ni lugares en la ${floorLabel(floor)}. Dibújalos desde el modo editor con esta planta seleccionada.`;
      list.appendChild(li);
    }
  }

  // ---------- Plantas ----------
  const floorSwitch = $("floor-switch");
  FLOORS.forEach((f) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = f.label;
    b.dataset.floor = f.id;
    b.setAttribute("role", "tab");
    b.onclick = () => setFloor(f.id);
    floorSwitch.appendChild(b);
  });

  function drawActiveRoute() {
    routeLayer.innerHTML = "";
    if (!activeRoute) return;
    userLayer.before(routeLayer);
    const indoorHere = activeRoute.segments.some((s) => s.floor === floor && !s.stair);
    activeRoute.segments.forEach((seg) => {
      const show = seg.floor === floor || (floor !== "ext" && seg.floor === "ext");
      if (!show) return;
      if (seg.stair) {
        el("circle", { cx: seg.a[0], cy: seg.a[1], r: 6, class: "route-mark" }, routeLayer);
        return;
      }
      const primary = seg.floor === floor || !indoorHere;
      el("polyline", { points: seg.a.join(",") + " " + seg.b.join(","), class: primary ? "route" : "route route-faint" }, routeLayer);
    });
  }

  function setFloor(id) {
    if (!FLOORS.some((f) => f.id === id)) id = "ext";
    floorSwitch.querySelectorAll("button").forEach((b) => {
      const on = b.dataset.floor === id;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    });
    if (id === floor) return;
    floor = id;
    const sel = selected && PLACES.find((p) => p.id === selected);
    // Con una ruta activa la ficha sigue abierta aunque el lugar esté en otra planta.
    if (sel && !onFloor(sel, floor) && !activeRoute) { selected = null; $("info-card").hidden = true; }
    drawPlaces();
    drawActiveRoute();
    render();
    if (App.hooks.onFloor) App.hooks.onFloor(floor);
  }
  setFloor("ext");

  // ---------- Selección e info ----------
  // Punto dentro de polígono (ray casting)
  function inside(pt, poly) {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  }
  function buildingAt(pt) {
    if (!pt) return null;
    return PLACES.find((b) => floorOfRaw(b) === "ext" && b.kind === "poly" && b.cat === "edificio" &&
      inside(pt, b.points.trim().split(/\s+/).map((q) => q.split(",").map(Number)))) || null;
  }
  // Edificio del exterior que contiene un lugar de alguna planta (para la ruta y la ficha)
  function containerOf(p) {
    if (p.kind !== "stair" && floorOfRaw(p) === "ext") return null;
    const pt = anchorOf(p, p.kind === "stair" ? floor : floorOfRaw(p));
    return buildingAt(pt);
  }
  function whereText(p) {
    if (p.kind === "stair") return placeFloors(p).map(floorLabel).join(" · ");
    const f = floorOfRaw(p);
    if (f !== "ext") return floorLabel(f);
    return isOutdoorBuilding(p) ? "Campus" : "";
  }

  function detailsAreOpen() {
    const more = $("info-more");
    if (!more || getComputedStyle(more).display === "none") return true;
    return $("info-card").classList.contains("expanded");
  }
  function showPlacePhoto(p) {
    const photo = $("info-photo");
    const src = detailsAreOpen() ? App.photoSrc(p) : "";
    if (!src) { photo.hidden = true; photo.removeAttribute("src"); return; }
    photo.alt = "Foto de " + (p && p.name || "lugar");
    if (photo.getAttribute("src") !== src) photo.src = src;
    photo.hidden = false;
  }
  function collapseInfoSheet() {
    const card = $("info-card");
    const more = $("info-more");
    card.classList.remove("expanded");
    if (!more) return;
    more.textContent = "Ver detalles";
    more.setAttribute("aria-expanded", "false");
  }
  $("info-more").onclick = () => {
    const card = $("info-card");
    const open = card.classList.toggle("expanded");
    $("info-more").textContent = open ? "Ocultar detalles" : "Ver detalles";
    $("info-more").setAttribute("aria-expanded", String(open));
    const p = selected && PLACES.find((x) => x.id === selected);
    if (p) showPlacePhoto(p);
  };

  function maps360Url(raw) {
    const text = String(raw || "").trim();
    if (!text) return "";
    let url;
    try { url = new URL(text); } catch (err) { return null; }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase();
    if (host === "maps.app.goo.gl") return url.href;
    if ((host === "goo.gl" || host.endsWith(".goo.gl")) && url.pathname.startsWith("/maps")) return url.href;
    const google = /(^|\.)google\.[a-z.]+$/.test(host);
    if (!google) return null;
    if (host.startsWith("maps.") || url.pathname.includes("/maps")) return url.href;
    return null;
  }

  function select(id) {
    closeDrawer();
    collapseInfoSheet();
    const p = PLACES.find((x) => x.id === id);
    if (!p || p.kind === "wall" || p.kind === "route" || p.kind === "zone") return;
    if (App.photoOnly) {
      if (p.cat !== "aula") {
        showToast("En el celular solo puedes cargar fotos de las aulas.");
        return;
      }
      if (!onFloor(p, floor)) setFloor(floorOf(p));
      if (App.hooks.onShapeClick) App.hooks.onShapeClick(p.id);
      return;
    }
    activeRoute = null;
    // En planta 1 o 2 el edificio se queda en esa vista: desde ahí se pide la ruta a su entrada.
    const stayForRoute = isOutdoorBuilding(p) && (floor === "p1" || floor === "p2");
    if (stayForRoute) selected = id;
    if (!onFloor(p, floor) && !stayForRoute) setFloor(floorOf(p));
    else if (stayForRoute) drawPlaces();
    selected = id;
    const cat = CATEGORIES[p.cat];
    $("info-tag").textContent = cat.label;
    $("info-tag").style.background = cat.color;
    $("info-name").textContent = p.name;
    $("info-desc").textContent = p.desc;
    showPlacePhoto(p);
    $("info-hours").textContent = p.hours;
    $("info-includes").textContent = p.includes;
    const view360 = $("info-360");
    const mapsUrl = maps360Url(p.maps360);
    if (mapsUrl) { view360.href = mapsUrl; view360.hidden = false; }
    else { view360.hidden = true; view360.removeAttribute("href"); }
    const box = containerOf(p);
    if (p.kind === "stair") {
      const names = placeFloors(p).map(floorLabel);
      $("info-floor-row").hidden = false;
      $("info-floor").textContent = `Conecta ${names.join(" y ")}` + (box ? ` · ${box.name}` : "");
    } else if (isOutdoorBuilding(p)) {
      $("info-floor-row").hidden = false;
      $("info-floor").textContent = "Campus · la ruta llega a la entrada";
    } else {
      const f = floorOfRaw(p);
      $("info-floor-row").hidden = f === "ext";
      $("info-floor").textContent = f === "ext" ? "" : floorLabel(f) + (box ? ` · ${box.name}` : "");
    }
    resetRouteAsk();
    closeMapsLeave();
    $("info-card").hidden = false;
    activeRoute = null;
    routeLayer.innerHTML = "";
    render();
  }
  function hideInfo() {
    selected = null;
    activeRoute = null;
    routePlan = null;
    collapseInfoSheet();
    $("info-card").hidden = true;
    routeLayer.innerHTML = "";
    resetRouteAsk();
    closeMapsLeave();
    if (floor !== "ext") drawPlaces();
    render();
  }
  $("info-close").onclick = hideInfo;

  const mapsLeave = $("maps-leave");
  function closeMapsLeave() { mapsLeave.hidden = true; }
  $("info-360").addEventListener("click", (e) => {
    if (!$("info-360").getAttribute("href")) return;
    e.preventDefault();
    mapsLeave.hidden = false;
    $("maps-leave-go").focus();
  });
  $("maps-leave-cancel").onclick = closeMapsLeave;
  mapsLeave.addEventListener("click", (e) => { if (e.target === mapsLeave) closeMapsLeave(); });
  $("maps-leave-go").onclick = () => {
    const href = $("info-360").getAttribute("href");
    closeMapsLeave();
    if (href) window.open(href, "_blank", "noopener,noreferrer");
  };
  document.addEventListener("keydown", (e) => {
    if (mapsLeave.hidden || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    closeMapsLeave();
  }, true);

  // ---------- Ruta ----------
  const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const linePts = (s) => (s || "").trim().split(/\s+/).filter(Boolean).map((q) => q.split(",").map(Number));

  function stairInBuilding(box, floorId, near) {
    if (!box) return null;
    const hits = PLACES.filter((s) => s.kind === "stair" && s.spans && s.spans[floorId] && (buildingAt(s.spans[floorId]) || {}).id === box.id);
    if (!hits.length) return null;
    const pt = near || box.door;
    return hits.reduce((a, b) => (dist2(a.spans[floorId], pt) <= dist2(b.spans[floorId], pt) ? a : b));
  }

  function graphPath(nodes, edges, from, to) {
    const adj = {};
    Object.keys(nodes).forEach((id) => (adj[id] = []));
    edges.forEach(([a, b, penalty]) => {
      if (!nodes[a] || !nodes[b] || a === b) return;
      const d = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y) + (penalty || 0);
      adj[a].push([b, d]);
      adj[b].push([a, d]);
    });
    const D = {}, prev = {}, todo = new Set(Object.keys(nodes));
    Object.keys(nodes).forEach((id) => (D[id] = Infinity));
    if (!(from in D) || !(to in D)) return null;
    D[from] = 0;
    while (todo.size) {
      let u = null;
      todo.forEach((n) => { if (u === null || D[n] < D[u]) u = n; });
      if (D[u] === Infinity || u === to) break;
      todo.delete(u);
      adj[u].forEach(([v, d]) => { if (D[u] + d < D[v]) { D[v] = D[u] + d; prev[v] = u; } });
    }
    if (D[to] === Infinity) return null;
    const path = [];
    for (let n = to; n; n = prev[n]) path.unshift(n);
    return path[0] === from ? path : null;
  }

  function nearestGraph(nodes, pt, floorId, maxDist, skip) {
    let best = null, bestD = maxDist;
    Object.entries(nodes).forEach(([id, n]) => {
      if (skip && skip.has(id)) return;
      if (n.floor !== floorId) return;
      const d = Math.hypot(n.x - pt[0], n.y - pt[1]);
      if (d < bestD) { bestD = d; best = id; }
    });
    return best;
  }

  // Camino más corto dentro de las zonas caminables. Rodea edificios y muros.
  // Devuelve null si no hay zonas que unan el origen con el destino.
  function routeOnZones(p, origin, allowedFloors) {
    const zoneList = PLACES.filter((z) => z.kind === "zone" && z.points && linePts(z.points).length >= 3);
    if (!zoneList.length) return null;

    const CELL = 6;
    const SNAP = 72;
    const PAD = 4;
    let floorsWanted = [...new Set(zoneList.map((z) => floorOfRaw(z)))];
    if (allowedFloors) floorsWanted = floorsWanted.filter((fl) => allowedFloors.has(fl));

    const distSeg = (px, py, a, b) => {
      const abx = b[0] - a[0], aby = b[1] - a[1];
      const len2 = abx * abx + aby * aby || 1;
      let t = ((px - a[0]) * abx + (py - a[1]) * aby) / len2;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (a[0] + abx * t), py - (a[1] + aby * t));
    };
    const hitsPoly = (pt, polys) => polys.some((poly) => inside(pt, poly));
    const hitsWall = (x, y, walls) => walls.some((pts) => {
      for (let i = 0; i < pts.length - 1; i++) if (distSeg(x, y, pts[i], pts[i + 1]) <= 5) return true;
      return false;
    });

    function makeGrid(floorId) {
      const zones = zoneList.filter((z) => floorOfRaw(z) === floorId).map((z) => linePts(z.points));
      if (!zones.length) return null;
      const blocks = PLACES.filter((b) => b.kind === "poly" && b.cat !== "pasillo" && floorOfRaw(b) === floorId && b.points)
        .map((b) => linePts(b.points)).filter((pts) => pts.length >= 3);
      const walls = PLACES.filter((w) => w.kind === "wall" && floorOfRaw(w) === floorId && w.points)
        .map((w) => linePts(w.points)).filter((pts) => pts.length >= 2);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      zones.forEach((poly) => poly.forEach(([x, y]) => {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }));
      const x0 = Math.floor(minX / CELL) * CELL;
      const y0 = Math.floor(minY / CELL) * CELL;
      const cols = Math.ceil((maxX - x0) / CELL) + 1;
      const rows = Math.ceil((maxY - y0) / CELL) + 1;
      if (cols < 1 || rows < 1 || cols * rows > 80000) return null;
      const walk = new Uint8Array(cols * rows);
      const at = (c, r) => r * cols + c;
      const blockedCell = (x, y) => {
        if (hitsPoly([x, y], blocks)) return true;
        if ([[PAD, 0], [-PAD, 0], [0, PAD], [0, -PAD]].some(([dx, dy]) => hitsPoly([x + dx, y + dy], blocks))) return true;
        return hitsWall(x, y, walls);
      };
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = x0 + (c + 0.5) * CELL, y = y0 + (r + 0.5) * CELL;
          if (hitsPoly([x, y], zones) && !blockedCell(x, y)) walk[at(c, r)] = 1;
        }
      }
      const ok = (c, r) => c >= 0 && r >= 0 && c < cols && r < rows && walk[at(c, r)] === 1;
      const center = (c, r) => [x0 + (c + 0.5) * CELL, y0 + (r + 0.5) * CELL];
      const approachClear = (a, b) => {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.max(1, Math.ceil(len / 4));
        for (let k = 1; k < n; k++) {
          const t = k / n;
          const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
          if (hitsPoly([x, y], blocks) || hitsWall(x, y, walls)) return false;
        }
        return true;
      };
      function snap(pt, maxDist) {
        const limit = maxDist == null ? SNAP : maxDist;
        const buried = hitsPoly(pt, blocks);
        let best = null, bestD = limit;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            if (!ok(c, r)) continue;
            const q = center(c, r);
            const d = Math.hypot(q[0] - pt[0], q[1] - pt[1]);
            if (d < bestD && (buried || d < 1 || approachClear(pt, q))) { bestD = d; best = { c, r, d, x: q[0], y: q[1] }; }
          }
        }
        return best;
      }
      const walkablePoint = (x, y) => ok(Math.floor((x - x0) / CELL), Math.floor((y - y0) / CELL));
      return { ok, center, snap, walkablePoint };
    }

    const grids = {};
    floorsWanted.forEach((fl) => { const g = makeGrid(fl); if (g) grids[fl] = g; });
    if (!Object.keys(grids).length) return null;

    const extra = {};
    const portal = {};
    const link = (a, b, cost, meta) => {
      if (!a || !b || a === b) return;
      (extra[a] || (extra[a] = [])).push([b, cost]);
      (extra[b] || (extra[b] = [])).push([a, cost]);
      if (meta) { portal[a + ">" + b] = meta; portal[b + ">" + a] = meta; }
    };
    PLACES.forEach((s) => {
      if (s.kind !== "stair" || !s.spans) return;
      const ends = ["p1", "p2"].map((fl) => (grids[fl] && Array.isArray(s.spans[fl]) ? grids[fl].snap(s.spans[fl], 72) : null));
      if (!ends[0] || !ends[1]) return;
      link(`c:p1:${ends[0].c}:${ends[0].r}`, `c:p2:${ends[1].c}:${ends[1].r}`,
        Math.hypot(ends[0].x - ends[1].x, ends[0].y - ends[1].y) + 16, { stair: s.id });
    });
    if (grids.ext && grids.p1) {
      PLACES.forEach((b) => {
        if (floorOfRaw(b) !== "ext" || b.kind !== "poly" || b.cat !== "edificio" || !Array.isArray(b.door)) return;
        const o = grids.ext.snap(b.door, 72), i = grids.p1.snap(b.door, 72);
        if (!o || !i) return;
        link(`c:ext:${o.c}:${o.r}`, `c:p1:${i.c}:${i.r}`, Math.hypot(o.x - i.x, o.y - i.y) + 8, { via: b.door });
      });
    }

    function neighbors(key) {
      const list = extra[key] ? extra[key].slice() : [];
      if (!key.startsWith("c:")) return list;
      const parts = key.split(":");
      const fl = parts[1], c = +parts[2], r = +parts[3];
      const g = grids[fl];
      if (!g) return list;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || !g.ok(c + dx, r + dy)) continue;
          if (dx && dy && (!g.ok(c + dx, r) || !g.ok(c, r + dy))) continue;
          list.push([`c:${fl}:${c + dx}:${r + dy}`, Math.hypot(dx, dy) * CELL]);
        }
      }
      return list;
    }

    function search(fromFloor, fromPt, toFloor, toPt) {
      const gs = grids[fromFloor], gt = grids[toFloor];
      if (!gs || !gt) return null;
      const a = gs.snap(fromPt), b = gt.snap(toPt);
      if (!a || !b) return null;
      const startCell = `c:${fromFloor}:${a.c}:${a.r}`;
      const goalCell = `c:${toFloor}:${b.c}:${b.r}`;
      const neigh = (key) => {
        if (key === "start") return [[startCell, a.d]];
        const list = neighbors(key);
        if (key === goalCell) list.push(["goal", b.d]);
        return list;
      };
      const point = (key) => {
        if (key === "start") return { pt: fromPt, floor: fromFloor };
        if (key === "goal") return { pt: toPt, floor: toFloor };
        const parts = key.split(":");
        return { pt: grids[parts[1]].center(+parts[2], +parts[3]), floor: parts[1] };
      };
      const best = new Map([["start", 0]]);
      const prev = new Map();
      const seen = new Set();
      const heap = [[0, "start"]];
      const push = (item) => {
        heap.push(item);
        let i = heap.length - 1;
        while (i > 0) {
          const parent = (i - 1) >> 1;
          if (heap[parent][0] <= heap[i][0]) break;
          const tmp = heap[parent]; heap[parent] = heap[i]; heap[i] = tmp;
          i = parent;
        }
      };
      const pop = () => {
        const top = heap[0];
        const last = heap.pop();
        if (heap.length) {
          heap[0] = last;
          let i = 0;
          for (;;) {
            const l = i * 2 + 1, r = l + 1;
            let s = i;
            if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
            if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
            if (s === i) break;
            const tmp = heap[s]; heap[s] = heap[i]; heap[i] = tmp;
            i = s;
          }
        }
        return top;
      };
      let keys = null;
      while (heap.length) {
        const [g, key] = pop();
        if (seen.has(key) || g > best.get(key) + 1e-6) continue;
        seen.add(key);
        if (key === "goal") {
          keys = [];
          for (let n = "goal"; n; n = prev.get(n)) keys.unshift(n);
          break;
        }
        neigh(key).forEach(([nk, cost]) => {
          if (seen.has(nk)) return;
          const ng = g + cost;
          if (ng + 1e-6 < (best.has(nk) ? best.get(nk) : Infinity)) {
            best.set(nk, ng);
            prev.set(nk, key);
            push([ng, nk]);
          }
        });
      }
      if (!keys || keys[0] !== "start") return null;
      return { keys, point };
    }

    function smoothPts(pts, floorId) {
      const g = grids[floorId];
      if (!g || pts.length < 3) return pts;
      const clear = (a, b) => {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.max(1, Math.ceil(len / (CELL / 2)));
        for (let k = 1; k < n; k++) {
          const t = k / n;
          const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
          if (Math.hypot(x - a[0], y - a[1]) < 12 || Math.hypot(x - b[0], y - b[1]) < 12) continue;
          if (!g.walkablePoint(x, y)) return false;
        }
        return true;
      };
      const out = [pts[0]];
      let i = 0;
      while (i < pts.length - 1) {
        let j = pts.length - 1;
        while (j > i + 1 && !clear(pts[i], pts[j])) j--;
        out.push(pts[j]);
        i = j;
      }
      return out;
    }

    function pack(found, reachedInside) {
      if (!found) return null;
      const segments = [];
      const climbs = [];
      let pending = [];
      let pendingFloor = null;
      function flush() {
        if (pendingFloor == null || pending.length < 2) { pending = []; return; }
        const pts = smoothPts(pending, pendingFloor);
        for (let i = 1; i < pts.length; i++) {
          if (Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) < 0.4) continue;
          segments.push({ a: pts[i - 1], b: pts[i], floor: pendingFloor });
        }
        pending = [];
      }
      found.keys.forEach((key, i) => {
        const loc = found.point(key);
        const meta = i > 0 ? portal[found.keys[i - 1] + ">" + key] : null;
        if (meta && meta.stair) {
          flush();
          const prevLoc = found.point(found.keys[i - 1]);
          const up = prevLoc.floor === "p1" && loc.floor === "p2";
          climbs.push({ id: meta.stair, up });
          segments.push({ a: prevLoc.pt, b: prevLoc.pt, floor: prevLoc.floor, stair: true, stairId: meta.stair, up });
          segments.push({ a: loc.pt, b: loc.pt, floor: loc.floor, stair: true, stairId: meta.stair, up });
          pendingFloor = loc.floor;
          pending = [loc.pt];
          return;
        }
        if (meta && meta.via) {
          if (pendingFloor != null) pending.push(meta.via);
          flush();
          pendingFloor = loc.floor;
          pending = [meta.via, loc.pt];
          return;
        }
        if (pendingFloor !== loc.floor) {
          flush();
          pendingFloor = loc.floor;
          pending = [loc.pt];
        } else pending.push(loc.pt);
      });
      flush();
      if (!segments.length) return null;
      return { segments, climbs, reachedInside };
    }

    let destFloor = p.kind === "stair" ? floorOf(p) : floorOfRaw(p);
    if (origin && p.kind === "stair" && placeFloors(p).includes(origin.floor)) destFloor = origin.floor;
    const destPt = p.kind === "stair" ? anchorOf(p, destFloor) : (p.entry || p.door || anchorOf(p, destFloor));
    if (!destPt) return null;
    const startFloor = origin ? origin.floor : "ext";
    const startPt = origin ? origin.pt.slice() : (userPos ? userPos.slice() : NODES[ENTRANCE.link].slice());

    function describe(segments, climbs, reachedInside) {
      const px = segments.reduce((s, seg) => s + (seg.stair ? 0 : Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1])), 0);
      const meters = Math.round(px * mPerPx() + climbs.length * 4);
      let text = `≈ ${meters} m · ${Math.max(1, Math.round(meters / 80))} min caminando (estimado)`;
      const box = containerOf(p);
      if (p.kind === "stair") return text + `. ${p.name} conecta ${placeFloors(p).map(floorLabel).join(" y ")}.`;
      if (destFloor === "ext") {
        if (startFloor === "p1" || startFloor === "p2") {
          return text + (p.cat === "edificio" ? `. Llegas a la entrada de ${p.name}.` : `. Llegas a ${p.name}.`);
        }
        return text;
      }
      if (!reachedInside) {
        const stair = stairInBuilding(box, destFloor, anchorOf(p, destFloor));
        const via = stair ? ` por ${stair.name}` : "";
        const step = destFloor === FLOORS[1].id
          ? `está en la ${floorLabel(destFloor)}` + (stair ? `; usa ${stair.name}` : "")
          : `sube${via} a la ${floorLabel(destFloor)}`;
        text += box ? `. Entra a ${box.name} y ${step}.` : `. El lugar ${step}.`;
        if (p.entry) text += " La puerta del lugar está marcada en el plano.";
        return text;
      }
      const bits = [];
      if (box) bits.push(`entra a ${box.name}`);
      bits.push("sigue por donde se puede caminar");
      climbs.forEach((c) => {
        const name = (PLACES.find((s) => s.id === c.id) || {}).name || "la escalera";
        bits.push((c.up ? "sube por " : "baja por ") + name);
      });
      if (p.entry) bits.push("llega a la puerta marcada");
      return text + ". " + bits[0].charAt(0).toUpperCase() + bits[0].slice(1) + (bits.length > 1 ? ", " + bits.slice(1).join(", ") : "") + ".";
    }

    function emit(packed) {
      if (!packed) return null;
      return { segments: packed.segments, text: describe(packed.segments, packed.climbs, packed.reachedInside) };
    }

    const full = pack(search(startFloor, startPt, destFloor, destPt), destFloor !== "ext");
    if (full) return emit(full);
    // Desde una planta, un edificio (u otro lugar de afuera) se alcanza por la zona de esa planta,
    // hasta su entrada. La planta 2 baja a la 1 si la entrada cae en la zona de abajo.
    if (startFloor !== "ext") {
      if (destFloor === "ext") {
        const targets = [];
        if (startFloor === "p1" || startFloor === "p2") targets.push("p1");
        if (startFloor === "p2") targets.push("p2");
        for (let i = 0; i < targets.length; i++) {
          const fl = targets[i];
          if (allowedFloors && !allowedFloors.has(fl)) continue;
          const landed = pack(search(startFloor, startPt, fl, destPt), false);
          if (landed) return emit(landed);
        }
      }
      return null;
    }

    const box = containerOf(p);
    if (destFloor !== "ext" && box && Array.isArray(box.door) && grids.ext) {
      const outdoor = pack(search("ext", startPt, "ext", box.door), false);
      const indoor = grids[destFloor] ? pack(search(destFloor, box.door, destFloor, destPt), true) : null;
      if (outdoor && indoor) {
        return emit({
          segments: outdoor.segments.concat(indoor.segments),
          climbs: outdoor.climbs.concat(indoor.climbs),
          reachedInside: true
        });
      }
      if (outdoor) {
        const net = routeOnNetwork(p, { pt: box.door, floor: "p1" }, new Set(destFloor === "p2" ? ["p1", "p2"] : ["p1"]));
        const inner = net ? net.segments.filter((s) => s.floor === "p1" || s.floor === "p2") : [];
        if (inner.length) {
          return emit({
            segments: outdoor.segments.concat(inner),
            climbs: outdoor.climbs.concat(net.climbs || []),
            reachedInside: true
          });
        }
        return emit(outdoor);
      }
    }
    return null;
  }

  // Líneas de ruta del editor. Una escalera une la línea de la Planta 1 con la de la Planta 2.
  // origin, si viene, es el punto de partida ({ pt, floor }); si no, es la entrada o el GPS.
  function routeOnNetwork(p, origin, allowedFloors) {
    const allow = (fl) => !allowedFloors || allowedFloors.has(fl);
    const nodes = {}, edges = [];
    const add = (id, x, y, floorId) => { nodes[id] = { x, y, floor: floorId }; };
    const join = (a, b, penalty) => { if (a && b && a !== b) edges.push([a, b, penalty || 0]); };
    // Engancha un punto (entrada, puerta, destino) al tramo de ruta más cercano.
    function attach(id, pt, floorId, maxDist, skipLine) {
      let best = null, bestD = maxDist;
      PLACES.forEach((line) => {
        if (line.kind !== "route" || floorOfRaw(line) !== floorId || !line.points) return;
        if (skipLine && line.id === skipLine) return;
        const pts = linePts(line.points);
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i], b = pts[i + 1];
          const abx = b[0] - a[0], aby = b[1] - a[1];
          const len2 = abx * abx + aby * aby || 1;
          let t = ((pt[0] - a[0]) * abx + (pt[1] - a[1]) * aby) / len2;
          t = Math.max(0, Math.min(1, t));
          const x = a[0] + abx * t, y = a[1] + aby * t;
          const d = Math.hypot(pt[0] - x, pt[1] - y);
          if (d < bestD) bestD = d, best = { i, line: line.id, x, y };
        }
      });
      if (!best) return false;
      const nid = `j:${id}:${best.line}:${best.i}`;
      const va = `l:${best.line}:${best.i}`, vb = `l:${best.line}:${best.i + 1}`;
      if (!nodes[va] || !nodes[vb]) return false;
      add(nid, best.x, best.y, floorId);
      join(id, nid);
      join(nid, va);
      join(nid, vb);
      return true;
    }

    PLACES.forEach((line) => {
      if (line.kind !== "route" || !line.points) return;
      const fl = floorOfRaw(line);
      if (!allow(fl)) return;
      const pts = linePts(line.points);
      pts.forEach((q, i) => add(`l:${line.id}:${i}`, q[0], q[1], fl));
      for (let i = 0; i < pts.length - 1; i++) join(`l:${line.id}:${i}`, `l:${line.id}:${i + 1}`);
      const ends = [0, pts.length - 1];
      ends.forEach((i) => {
        const id = `l:${line.id}:${i}`;
        Object.keys(nodes).forEach((oid) => {
          if (oid === id || oid.startsWith("l:" + line.id + ":") || nodes[oid].floor !== fl) return;
          if (Math.hypot(nodes[oid].x - pts[i][0], nodes[oid].y - pts[i][1]) <= 40) join(id, oid);
        });
      });
    });
    // Una punta que cae a mitad de otra ruta de la misma planta también se une.
    PLACES.forEach((line) => {
      if (line.kind !== "route" || !line.points) return;
      const fl = floorOfRaw(line);
      if (!allow(fl)) return;
      const pts = linePts(line.points);
      [0, pts.length - 1].forEach((i) => attach(`l:${line.id}:${i}`, pts[i], fl, 40, line.id));
    });

    PLACES.forEach((s) => {
      if (s.kind !== "stair" || !s.spans) return;
      ["p1", "p2"].forEach((fl) => {
        if (Array.isArray(s.spans[fl])) add(`t:${s.id}:${fl}`, s.spans[fl][0], s.spans[fl][1], fl);
      });
      if (nodes[`t:${s.id}:p1`] && nodes[`t:${s.id}:p2`]) join(`t:${s.id}:p1`, `t:${s.id}:p2`, 24);
      ["p1", "p2"].forEach((fl) => {
        const id = `t:${s.id}:${fl}`;
        if (!nodes[id]) return;
        // La escalera se pega al tramo de ruta más cercano de esa planta, no solo a una esquina.
        if (!attach(id, s.spans[fl], fl, 72)) {
          const near = nearestGraph(nodes, s.spans[fl], fl, 72, new Set([id]));
          if (near) join(id, near);
        }
      });
    });

    const box = containerOf(p);
    let destFloor = p.kind === "stair" ? floorOf(p) : floorOfRaw(p);
    if (origin && p.kind === "stair" && placeFloors(p).includes(origin.floor)) destFloor = origin.floor;
    let destPt = p.kind === "stair" ? anchorOf(p, destFloor) : (p.entry || anchorOf(p, destFloor) || p.door);
    if (!destPt) return null;
    add("dest", destPt[0], destPt[1], destFloor);

    if (box && Array.isArray(box.door) && allow("ext") && allow("p1")) {
      add("gate:" + box.id, box.door[0], box.door[1], "ext");
      attach("gate:" + box.id, box.door, "ext", 72);
      if (!attach("gate:" + box.id, box.door, "p1", 72)) {
        const into = nearestGraph(nodes, box.door, "p1", 72, new Set(["gate:" + box.id]));
        if (into) join("gate:" + box.id, into);
      }
    }
    // Engancha el destino a la línea de ruta más cercana de una planta.
    function hookDest(floorId, maxDist) {
      if (!allow(floorId)) return false;
      if (attach("dest", destPt, floorId, maxDist)) return true;
      const near = nearestGraph(nodes, destPt, floorId, maxDist, new Set(["dest"]));
      if (!near) return false;
      join("dest", near);
      return true;
    }
    if (destFloor === "ext") {
      hookDest("ext", 80);
      // La entrada del edificio no tiene líneas en la vista aérea: se une a la Planta 1.
      const fromIndoor = origin && (origin.floor === "p1" || origin.floor === "p2");
      if (fromIndoor) hookDest("p1", 160);
    } else {
      if (!attach("dest", destPt, destFloor, 80)) {
        const near = nearestGraph(nodes, destPt, destFloor, 80, new Set(["dest"]));
        if (near) join("dest", near);
      }
      if (p.kind === "stair" && nodes[`t:${p.id}:${destFloor}`]) join("dest", `t:${p.id}:${destFloor}`);
    }

    const entrance = NODES[ENTRANCE.link];
    const startFloor = origin ? origin.floor : "ext";
    const startPt = origin ? origin.pt : (userPos || entrance);
    add("start", startPt[0], startPt[1], startFloor);
    // Sin ubicación el origen es la entrada del campus. En la Planta 2 esa entrada
    // queda más lejos de los pasillos, así que el enganche admite un poco más.
    const reach = userPos ? 80 : 180;
    let hooked = attach("start", startPt, startFloor, reach);
    // Desde la vista aérea no se salta a las líneas de una planta: cada capa usa las suyas.
    if (!hooked) {
      const near = nearestGraph(nodes, startPt, startFloor, reach, new Set(["start"]));
      if (!near) return null;
      join("start", near);
    }
    const path = graphPath(nodes, edges, "start", "dest");
    if (!path) return null;
    const usedLine = path.some((id) => id.startsWith("l:") || id.startsWith("t:") || id.startsWith("gate:"));
    if (!usedLine) return null;

    const segments = [];
    const climbs = [];
    let px = 0;
    for (let i = 1; i < path.length; i++) {
      const a = nodes[path[i - 1]], b = nodes[path[i]];
      const sa = path[i - 1].startsWith("t:") ? path[i - 1].split(":")[1] : null;
      const sb = path[i].startsWith("t:") ? path[i].split(":")[1] : null;
      if (sa && sa === sb) {
        const up = a.floor === "p1" && b.floor === "p2";
        climbs.push({ id: sa, up });
        segments.push({ a: [a.x, a.y], b: [a.x, a.y], floor: a.floor, stair: true, stairId: sa, up });
        segments.push({ a: [b.x, b.y], b: [b.x, b.y], floor: b.floor, stair: true, stairId: sa, up });
        continue;
      }
      if (a.floor !== b.floor) {
        const crossing = (a.floor === "ext" && b.floor === "p1") || (a.floor === "p1" && b.floor === "ext");
        if (!crossing) continue;
      }
      const len = Math.hypot(a.x - b.x, a.y - b.y);
      if (len < 0.4) continue;
      px += len;
      segments.push({ a: [a.x, a.y], b: [b.x, b.y], floor: a.floor });
    }
    if (!segments.length) return null;
    const meters = Math.round(px * mPerPx() + climbs.length * 4);
    let text = `≈ ${meters} m · ${Math.max(1, Math.round(meters / 80))} min caminando (estimado)`;
    if (destFloor !== "ext") {
      const bits = [];
      if (box) bits.push(`entra a ${box.name}`);
      if (path.some((id) => id.startsWith("l:") && nodes[id].floor !== "ext")) bits.push("sigue el pasillo");
      climbs.forEach((c) => {
        const name = (PLACES.find((s) => s.id === c.id) || {}).name || "la escalera";
        bits.push((c.up ? "sube por " : "baja por ") + name);
      });
      if (p.kind !== "stair" && p.entry) bits.push("llega a la puerta marcada");
      if (bits.length) text += ". " + bits[0].charAt(0).toUpperCase() + bits[0].slice(1) + (bits.length > 1 ? ", " + bits.slice(1).join(", ") : "") + ".";
    } else if (origin && (origin.floor === "p1" || origin.floor === "p2")) {
      text += p.cat === "edificio" ? `. Llegas a la entrada de ${p.name}.` : `. Llegas a ${p.name}.`;
    }
    return { segments, text, climbs };
  }

  function resetRouteAsk() {
    routePlan = null;
    $("route-ask").hidden = true;
    $("route-next").hidden = true;
    $("route-back").hidden = true;
    $("route-note").hidden = true;
    $("route-btn").hidden = false;
  }

  function showRouteNote(text) {
    const note = $("route-note");
    note.hidden = false;
    note.textContent = text;
  }

  function failRoute(text) {
    activeRoute = null;
    routePlan = null;
    routeLayer.innerHTML = "";
    $("route-ask").hidden = true;
    $("route-next").hidden = true;
    $("route-back").hidden = true;
    $("route-btn").hidden = false;
    showRouteNote(text);
  }

  function legSummary(segments) {
    const px = segments.reduce((s, seg) => s + (seg.stair ? 0 : Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1])), 0);
    const meters = Math.round(px * mPerPx());
    if (meters < 1) return "";
    return `≈ ${meters} m · ${Math.max(1, Math.round(meters / 80))} min. `;
  }

  // Sin ubicación, el camino sale de la entrada del campus, sobre las líneas de la planta elegida.
  // También si el destino es un edificio: la planta elegida es el punto de partida.
  function originFor(p, userFloor) {
    if (userPos) return { pt: userPos.slice(), floor: userFloor };
    return { pt: NODES[ENTRANCE.link].slice(), floor: userFloor };
  }

  // Corta el camino en la primera escalera que sale de la planta del usuario.
  function splitAtStair(segments, fromFloor) {
    const now = [];
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (s.stair && s.floor === fromFloor) {
        now.push(s);
        const next = segments[i + 1];
        const lands = next && next.stair && next.floor !== fromFloor;
        const toFloor = lands ? next.floor : (s.up ? "p2" : "p1");
        return { now, later: segments.slice(i + 1), stairId: s.stairId, up: toFloor === "p2", toFloor };
      }
      now.push(s);
    }
    return { now, later: null, stairId: null, up: false, toFloor: null };
  }

  function showLeg(segments, floorId) {
    activeRoute = { segments };
    if (floorId && floorId !== floor) setFloor(floorId);
    else drawActiveRoute();
  }

  function stairName(id) {
    return (PLACES.find((s) => s.id === id) || {}).name || "la escalera";
  }

  function beginRouteAsk() {
    const p = PLACES.find((x) => x.id === selected);
    if (!p) return;
    activeRoute = null;
    routePlan = null;
    routeLayer.innerHTML = "";
    $("route-btn").hidden = true;
    $("route-next").hidden = true;
    $("route-back").hidden = true;
    $("route-note").hidden = true;
    const indoor = p.kind === "stair" || floorOfRaw(p) !== "ext";
    const toBuilding = isOutdoorBuilding(p);
    $("route-ask-hint").textContent = userPos
      ? (simMode
        ? "La ruta sale del punto de prueba, en la planta que elijas."
        : "La ruta sale de tu ubicación, en la planta que elijas.")
      : toBuilding
        ? "Sin ubicación activa, el camino sale de la entrada del campus y sigue las rutas de la planta que elijas hasta el edificio."
        : indoor
          ? "Sin ubicación activa, el camino sigue las rutas de esa planta desde la entrada del campus."
          : "Sin ubicación activa, el camino empieza en la entrada del campus.";
    $("route-ask").hidden = false;
  }

  function startRouteFromFloor(userFloor) {
    const p = PLACES.find((x) => x.id === selected);
    if (!p) return;
    $("route-ask").hidden = true;
    const origin = originFor(p, userFloor);
    const destFloor = p.kind === "stair"
      ? (placeFloors(p).includes(userFloor) ? userFloor : placeFloors(p)[0])
      : floorOfRaw(p);
    const fromFloor = origin ? origin.floor : "ext";
    // En una planta se usan las líneas de esa planta. Las de la vista aérea no entran al camino interior.
    // Hacia un edificio, la Planta 1 también entra: la entrada se engancha a sus rutas y la Planta 2 baja por la escalera.
    const allowed = new Set([fromFloor, destFloor]);
    if (fromFloor !== "ext" && destFloor !== "ext") allowed.delete("ext");
    if (destFloor === "ext" && (fromFloor === "p1" || fromFloor === "p2")) allowed.add("p1");
    const built = routeOnZones(p, origin, allowed) || routeOnNetwork(p, origin, allowed);
    if (!built) {
      failRoute("No hay un camino trazado hasta aquí. Marca una zona caminable o una línea de ruta en el editor.");
      return;
    }
    const crossIndoor = (userFloor === "p1" || userFloor === "p2") && (destFloor === "p1" || destFloor === "p2") && userFloor !== destFloor;
    const downToExit = userFloor === "p2" && destFloor === "ext" && origin && origin.floor === "p2";
    if (crossIndoor || downToExit) {
      const split = splitAtStair(built.segments, userFloor);
      if (!split.stairId || !split.toFloor) {
        failRoute("No hay una escalera que una las dos plantas. En el editor, acerca la escalera a la zona o a la línea de ruta de cada planta.");
        return;
      }
      const name = stairName(split.stairId);
      const verb = split.up ? "Sube" : "Baja";
      const where = split.up ? "arriba" : "abajo";
      const lead = userPos ? "Desde tu ubicación, sigue" : "Desde la entrada, sigue";
      showRouteNote(`${legSummary(split.now)}${lead} el camino hasta «${name}». ${verb} a la ${floorLabel(split.toFloor)} por la escalera. Cuando ya estés ${where}, confirma para continuar.`);
      routePlan = { later: split.later || [], toFloor: split.toFloor, placeId: p.id };
      $("route-next").textContent = `Ya estoy en la ${floorLabel(split.toFloor)}`;
      $("route-next").hidden = false;
      $("route-back").hidden = false;
      $("route-btn").hidden = true;
      showLeg(split.now, userFloor);
      return;
    }
    routePlan = null;
    $("route-next").hidden = true;
    $("route-back").hidden = true;
    $("route-btn").hidden = false;
    showRouteNote(built.text);
    let view = destFloor;
    if (view === "ext" && origin && (origin.floor === "p1" || origin.floor === "p2")) view = origin.floor;
    showLeg(built.segments, view);
  }

  $("route-btn").onclick = beginRouteAsk;
  $("route-ask-cancel").onclick = resetRouteAsk;
  $("route-ask").onclick = (ev) => {
    const choice = ev.target.closest("[data-from-floor]");
    if (!choice) return;
    startRouteFromFloor(choice.dataset.fromFloor);
  };
  $("route-back").onclick = beginRouteAsk;
  $("route-next").onclick = () => {
    if (!routePlan) return;
    const plan = routePlan;
    routePlan = null;
    const p = PLACES.find((x) => x.id === plan.placeId);
    const segs = plan.later || [];
    $("route-next").hidden = true;
    $("route-back").hidden = true;
    $("route-btn").hidden = false;
    const name = p ? (isOutdoorBuilding(p) ? `la entrada de ${p.name}` : p.name) : "el lugar";
    const where = floorLabel(plan.toFloor);
    let text = segs.some((s) => !s.stair)
      ? `${legSummary(segs)}Ya estás en la ${where}. Sigue el camino hasta ${name}.`
      : `Ya estás en la ${where}. ${name} queda junto a la escalera.`;
    if (p && p.entry && segs.some((s) => !s.stair)) text += " La puerta del lugar está marcada en el plano.";
    showRouteNote(text);
    showLeg(segs, plan.toFloor);
  };

  // ---------- Panel de lugares en móvil (cajón inferior) ----------
  const sidebar = $("sidebar"), listToggle = $("list-toggle");
  function closeDrawer() { sidebar.classList.remove("open"); listToggle.setAttribute("aria-expanded", "false"); }
  listToggle.onclick = () => {
    const open = sidebar.classList.toggle("open");
    listToggle.setAttribute("aria-expanded", String(open));
  };
  $("drawer-close").onclick = closeDrawer;
  svg.addEventListener("click", () => closeDrawer());

  // ---------- Mi ubicación (Geolocation API) ----------
  let userPos = null, watchId = null, centered = false, lastCoords = null;
  let simMode = false, simPicking = false, simSwallow = false;
  const userLayer = el("g", { class: "user-layer" }, viewport);
  const locateBtn = $("locate-btn"), simBtn = $("sim-btn"), toast = $("toast");
  const simParam = new URLSearchParams(location.search).get("sim"); // ?sim=lat,lon para pruebas

  function showToast(msg, ms = 4000) {
    toast.textContent = msg; toast.hidden = false;
    clearTimeout(showToast.t);
    showToast.t = setTimeout(() => (toast.hidden = true), ms);
  }
  // ---------- Calibración GPS → croquis ----------
  // Con 3+ puntos de control (posición en el croquis + lat/lon reales) se ajusta una
  // transformación afín por mínimos cuadrados: corrige desplazamiento, escala, rotación e inclinación.
  const M_PER_DEG = 111320;
  const CALIB_KEY = "mapa-facultad-calib";
  let calib = null;

  const toMeters = (lat, lon, ref) => [(lon - ref.lon0) * M_PER_DEG * ref.cos0, (lat - ref.lat0) * M_PER_DEG];
  const det3 = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  function solve3(m, v) {
    const d = det3(m);
    if (!d) return null;
    return [0, 1, 2].map((i) => det3(m.map((row, r) => row.map((x, c) => (c === i ? v[r] : x)))) / d);
  }

  function fitCalibration(points) {
    if (!Array.isArray(points) || points.length < 3) return { ok: false, error: "Se necesitan al menos 3 puntos." };
    const n = points.length;
    const lat0 = points.reduce((s, p) => s + p.lat, 0) / n;
    const lon0 = points.reduce((s, p) => s + p.lon, 0) / n;
    const ref = { lat0, lon0, cos0: Math.cos((lat0 * Math.PI) / 180) };
    const rows = points.map((p) => toMeters(p.lat, p.lon, ref));

    // Puntos casi alineados o muy juntos no fijan la rotación
    let see = 0, snn = 0, sen = 0;
    rows.forEach(([e, nn]) => { see += e * e; snn += nn * nn; sen += e * nn; });
    const spread = Math.sqrt((see + snn) / n);
    if (spread < 15) return { ok: false, error: "Los puntos están muy juntos en el GPS (o se repitieron coordenadas). Sepáralos al menos unas decenas de metros." };
    if ((see * snn - sen * sen) / ((see + snn) ** 2) < 0.01) return { ok: false, error: "Los puntos están casi en línea recta. Usa puntos que formen un triángulo amplio." };

    const N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
    rows.forEach((r, i) => {
      const v = [r[0], r[1], 1];
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) N[a][b] += v[a] * v[b];
        bx[a] += v[a] * points[i].x;
        by[a] += v[a] * points[i].y;
      }
    });
    const ax = solve3(N, bx), ay = solve3(N, by);
    if (!ax || !ay) return { ok: false, error: "No se pudo calcular la calibración con esos puntos." };

    const lin = ax[0] * ay[1] - ax[1] * ay[0];
    if (lin > 0) return { ok: false, error: "La calibración sale volteada (espejo). Revisa que no hayas invertido latitud y longitud o emparejado mal algún punto." };
    const mPerPx = 1 / Math.sqrt(Math.abs(lin));
    const residuals = rows.map((r, i) => {
      const x = ax[0] * r[0] + ax[1] * r[1] + ax[2], y = ay[0] * r[0] + ay[1] * r[1] + ay[2];
      return Math.hypot(x - points[i].x, y - points[i].y) * mPerPx;
    });
    const rms = Math.sqrt(residuals.reduce((s, e) => s + e * e, 0) / n);
    return { ok: true, points, ref, ax, ay, mPerPx, residuals, rms };
  }

  const mPerPx = () => (calib ? calib.mPerPx : GEO.mPerPx);

  function geoToMap(lat, lon) {
    if (calib) {
      const [e, n] = toMeters(lat, lon, calib.ref);
      return [calib.ax[0] * e + calib.ax[1] * n + calib.ax[2], calib.ay[0] * e + calib.ay[1] * n + calib.ay[2]];
    }
    const mLat = (lat - GEO.lat0) * M_PER_DEG;
    const mLon = (lon - GEO.lon0) * M_PER_DEG * Math.cos((GEO.lat0 * Math.PI) / 180);
    return [GEO.x0 + mLon / GEO.mPerPx, GEO.y0 - mLat / GEO.mPerPx];
  }

  // Devuelve true si la calibración cambió
  function applyCalibration(points) {
    const prev = calib ? JSON.stringify(calib.points) : null;
    if (!points) {
      calib = null;
    } else {
      const fit = fitCalibration(points);
      if (!fit.ok) return false;
      calib = fit;
    }
    const changed = prev !== (calib ? JSON.stringify(calib.points) : null);
    if (changed && lastCoords) onPosition(lastCoords);
    updateCompass();
    return changed;
  }

  try {
    const cached = JSON.parse(localStorage.getItem(CALIB_KEY));
    if (cached && Array.isArray(cached.points)) applyCalibration(cached.points);
  } catch (err) { /* sin caché */ }
  function updateRouteLabel() {
    $("route-btn").textContent = "Cómo llegar";
  }
  function onPosition(pos) {
    lastCoords = { coords: { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy } };
    const [x, y] = geoToMap(pos.coords.latitude, pos.coords.longitude);
    const acc = pos.coords.accuracy || 0;
    const inside = x > -150 && x < VB.w + 150 && y > -100 && y < VB.h + 100;
    if (!inside) {
      userPos = null;
      updateRouteLabel();
      showToast("Parece que estás fuera del campus: no se puede mostrar tu ubicación en el croquis.");
      return;
    }
    paintUser(x, y, acc, false);
    if (!centered) {
      centered = true;
      view.k = Math.max(view.k, headingOn ? 1.5 : 1.4);
      view.x = CX - x * view.k; view.y = CY - y * view.k; applyView();
      showToast(acc > 30
        ? `Ubicación poco precisa (±${Math.round(acc)} m). Este dispositivo la calcula por Wi‑Fi; en un celular con GPS será mucho más exacta.`
        : `Ubicación encontrada (±${Math.round(acc)} m)`, acc > 30 ? 7000 : 4000);
    }
  }
  function onGeoError(err) {
    const msgs = {
      1: "Permiso de ubicación denegado. Actívalo en tu navegador para usar esta función.",
      2: "No se pudo determinar tu ubicación.",
      3: "Se agotó el tiempo esperando tu ubicación."
    };
    stopLocating();
    showToast(msgs[err.code] || "Error al obtener la ubicación.", 5000);
  }
  function paintUser(x, y, acc, simulated) {
    userLayer.innerHTML = "";
    userPos = [x, y];
    updateRouteLabel();
    if (acc > 0) el("circle", { cx: x, cy: y, r: Math.max(acc / mPerPx(), 8), class: "user-acc" }, userLayer);
    const head = el("g", { class: "user-heading", visibility: "hidden" }, userLayer);
    el("path", { d: "", stroke: "#fff", "stroke-width": "2", "stroke-linejoin": "round", "vector-effect": "non-scaling-stroke" }, head);
    el("circle", { cx: x, cy: y, r: 9, class: "user-halo" }, userLayer);
    el("circle", { cx: x, cy: y, r: 6, class: "user-dot" }, userLayer);
    if (simulated) el("text", { x, y: y - 16, "text-anchor": "middle", class: "user-sim-label" }, userLayer).textContent = "Prueba";
    updateCone();
  }
  function syncSimButton() {
    simBtn.classList.toggle("active", simMode);
    simBtn.classList.toggle("picking", simPicking);
    simBtn.setAttribute("aria-pressed", String(simMode || simPicking));
    document.body.classList.toggle("sim-picking", simPicking);
  }
  function stopLocating() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null; userPos = null; centered = false; lastCoords = null;
    simMode = false; simPicking = false;
    view.follow = false;
    userLayer.innerHTML = "";
    locateBtn.classList.remove("active");
    syncSimButton();
    updateRouteLabel();
  }
  function beginLocating() {
    simMode = false; simPicking = false;
    syncSimButton();
    locateBtn.classList.add("active");
    if (simParam) {
      const [lat, lon] = simParam.split(",").map(Number);
      onPosition({ coords: { latitude: lat, longitude: lon, accuracy: 12 } });
      return;
    }
    if (!navigator.geolocation) { stopLocating(); showToast("Tu navegador no soporta geolocalización."); return; }
    showToast("Buscando tu ubicación…", 2500);
    watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }
  locateBtn.onclick = () => {
    if (locateBtn.classList.contains("active")) { stopLocating(); showToast("Ubicación desactivada", 2000); return; }
    beginLocating();
  };

  function placeSim(x, y) {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    lastCoords = null;
    locateBtn.classList.remove("active");
    simMode = true;
    simPicking = false;
    centered = true;
    view.follow = false;
    paintUser(x, y, 0, true);
    syncSimButton();
    showToast("Punto de prueba listo. «Cómo llegar» sale de aquí. Pulsa el botón para moverlo; púlsalo otra vez para quitarlo.", 6000);
  }
  simBtn.onclick = () => {
    if (simPicking) {
      stopLocating();
      showToast("Ubicación de prueba quitada.", 2000);
      return;
    }
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
      locateBtn.classList.remove("active");
    }
    simPicking = true;
    syncSimButton();
    showToast(simMode
      ? "Haz clic en el mapa para mover el punto. Escape lo deja donde está; el botón lo quita."
      : "Haz clic en el mapa: ese punto será tu ubicación para probar las rutas.", 5000);
  };
  svg.addEventListener("pointerdown", (e) => {
    if (!simPicking || e.button > 0) return;
    e.stopPropagation();
    const [x, y] = toMap(e);
    placeSim(x, y);
    simSwallow = true;
  }, true);
  svg.addEventListener("click", (e) => {
    if (!simSwallow) return;
    simSwallow = false;
    e.stopPropagation();
  }, true);
  window.addEventListener("pointerup", () => {
    if (!simSwallow) return;
    setTimeout(() => { simSwallow = false; }, 0);
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !simPicking) return;
    e.preventDefault();
    e.stopPropagation();
    simPicking = false;
    syncSimButton();
    showToast(simMode ? "Se mantiene el punto de prueba." : "Simulación cancelada.", 2000);
  }, true);

  // ---------- Brújula: el mapa y la ruta giran con el celular ----------
  // El rumbo 0 es el norte real. El croquis gira para que ese rumbo quede hacia arriba.
  // ?giro=90 fija un rumbo de prueba; ?giro sin número lo hace dar vueltas.
  const headingBtn = $("heading-btn");
  const giroRaw = new URLSearchParams(location.search).get("giro");
  const giroFixed = giroRaw !== null && giroRaw !== "" && !Number.isNaN(Number(giroRaw))
    ? ((Number(giroRaw) % 360) + 360) % 360
    : null;
  let headingOn = false, headingTarget = null, shownRot = 0, headingTimer = 0, settleTimer = 0, orientBound = false, sawAbsolute = false;
  let lastOrientEvent = null, headingMissTimer = 0, giroT0 = 0;

  function northDeg() {
    if (calib && calib.ax && calib.ay) {
      const nx = calib.ax[1], ny = calib.ay[1];
      if (Math.hypot(nx, ny) > 1e-8) return (Math.atan2(ny, nx) * 180) / Math.PI;
    }
    return -90;
  }
  function updateCompass() {
    const node = $("compass");
    if (!node) return;
    node.style.transform = `rotate(${northDeg() + (view.rot || 0) + 90}deg)`;
  }
  function screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === "number") return screen.orientation.angle;
    const o = typeof window.orientation === "number" ? window.orientation : 0;
    return o < 0 ? o + 360 : o;
  }
  // Rumbo de la parte de arriba de la pantalla, en grados horarios desde el norte.
  function headingFromEvent(e) {
    if (typeof e.webkitCompassHeading === "number" && !Number.isNaN(e.webkitCompassHeading)) return e.webkitCompassHeading;
    if (e.alpha == null || e.beta == null || e.gamma == null) return null;
    const rad = Math.PI / 180;
    const x = e.beta * rad, y = e.gamma * rad, z = e.alpha * rad;
    const cX = Math.cos(x), cY = Math.cos(y), cZ = Math.cos(z);
    const sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
    let h = Math.atan2(-cZ * sY - sZ * sX * cY, -sZ * sY + cZ * sX * cY) / rad;
    if (h < 0) h += 360;
    return h;
  }
  function takeOrient(e) {
    const absolute = e.absolute === true || e.type === "deviceorientationabsolute" || typeof e.webkitCompassHeading === "number";
    if (e.type === "deviceorientationabsolute") sawAbsolute = true;
    if (!absolute) return;
    if (e.type === "deviceorientation" && sawAbsolute && typeof e.webkitCompassHeading !== "number") return;
    const raw = headingFromEvent(e);
    if (raw == null) return;
    headingTarget = (raw - screenAngle() + 360) % 360;
  }
  function onDeviceOrient(e) {
    if (!headingOn || giroRaw !== null) return;
    lastOrientEvent = e;
    takeOrient(e);
  }
  function onScreenTurn() {
    if (headingOn && lastOrientEvent) takeOrient(lastOrientEvent);
  }
  function bindOrient() {
    if (orientBound) return;
    orientBound = true;
    sawAbsolute = false;
    window.addEventListener("deviceorientationabsolute", onDeviceOrient, true);
    window.addEventListener("deviceorientation", onDeviceOrient, true);
    window.addEventListener("orientationchange", onScreenTurn);
    if (screen.orientation) screen.orientation.addEventListener("change", onScreenTurn);
  }
  function unbindOrient() {
    if (!orientBound) return;
    orientBound = false;
    window.removeEventListener("deviceorientationabsolute", onDeviceOrient, true);
    window.removeEventListener("deviceorientation", onDeviceOrient, true);
    window.removeEventListener("orientationchange", onScreenTurn);
    if (screen.orientation) screen.orientation.removeEventListener("change", onScreenTurn);
  }
  function rotFor(heading) {
    let d = -90 - (northDeg() + heading);
    d = ((d % 360) + 360) % 360;
    if (d > 180) d -= 360;
    return d;
  }
  function updateCone() {
    const g = userLayer.querySelector(".user-heading");
    if (!g) return;
    if (!headingOn || headingTarget == null || !userPos) { g.setAttribute("visibility", "hidden"); return; }
    const len = 78 / view.k, half = 26 / view.k;
    const facing = northDeg() + headingTarget;
    g.removeAttribute("visibility");
    g.setAttribute("transform", `translate(${userPos[0]} ${userPos[1]}) rotate(${facing})`);
    g.querySelector("path").setAttribute("d", `M0 0 L${len} ${-half} L${len * 0.62} 0 L${len} ${half} Z`);
  }
  function tickHeading() {
    if (!headingOn) return;
    if (giroRaw !== null) {
      headingTarget = giroFixed !== null ? giroFixed : ((performance.now() - giroT0) / 80) % 360;
    }
    if (headingTarget != null) {
      const want = rotFor(headingTarget);
      let d = want - shownRot;
      d = ((d + 540) % 360) - 180;
      shownRot += d * 0.18;
      view.rot = shownRot;
    }
    if (view.follow && userPos && !drag) {
      view.x = CX - userPos[0] * view.k;
      view.y = CY - userPos[1] * view.k;
    }
    updateCone();
    applyView(false);
    headingTimer = requestAnimationFrame(tickHeading);
  }
  function settleBack() {
    if (headingOn) return;
    let d = -shownRot;
    d = ((d + 540) % 360) - 180;
    if (Math.abs(d) < 0.4) { shownRot = 0; view.rot = 0; applyView(false); return; }
    shownRot += d * 0.28;
    view.rot = shownRot;
    applyView(false);
    settleTimer = requestAnimationFrame(settleBack);
  }
  function endHeading(msg, snap) {
    const was = headingOn || Math.abs(view.rot || 0) > 0.01;
    headingOn = false;
    headingTarget = null;
    view.follow = false;
    cancelAnimationFrame(headingTimer);
    cancelAnimationFrame(settleTimer);
    clearTimeout(headingMissTimer);
    unbindOrient();
    headingBtn.classList.remove("active");
    headingBtn.setAttribute("aria-pressed", "false");
    document.body.classList.remove("orienting");
    const cone = userLayer.querySelector(".user-heading");
    if (cone) cone.setAttribute("visibility", "hidden");
    if (!was) return;
    if (snap) { shownRot = 0; view.rot = 0; applyView(); }
    else settleTimer = requestAnimationFrame(settleBack);
    if (msg) showToast(msg, 2500);
  }
  async function startHeading() {
    if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === "function") {
      let res = "denied";
      try { res = await DeviceOrientationEvent.requestPermission(); } catch (err) { res = "denied"; }
      if (res !== "granted" && giroRaw === null) {
        showToast("Sin permiso de movimiento no se puede girar el mapa.", 5000);
        return;
      }
    }
    headingOn = true;
    view.follow = true;
    cancelAnimationFrame(settleTimer);
    shownRot = view.rot || 0;
    giroT0 = performance.now();
    headingBtn.classList.add("active");
    headingBtn.setAttribute("aria-pressed", "true");
    document.body.classList.add("orienting");
    if (view.k < 1.5) view.k = 1.5;
    if (!locateBtn.classList.contains("active")) beginLocating();
    if (giroRaw === null) bindOrient();
    tickHeading();
    showToast("El mapa gira contigo: lo de adelante queda arriba y la ruta sigue ese rumbo.", 5000);
    clearTimeout(headingMissTimer);
    headingMissTimer = setTimeout(() => {
      if (headingOn && headingTarget == null) {
        showToast("No llega la brújula. Ábrelo en el celular con el enlace https y acepta el movimiento.", 6500);
      }
    }, 2500);
  }
  headingBtn.onclick = () => {
    if (App.editing) { showToast("Sal del editor para girar el mapa."); return; }
    if (headingOn) {
      if (!view.follow && userPos) { view.follow = true; showToast("Otra vez centrado en tu ubicación.", 2000); return; }
      endHeading("El mapa volvió al croquis.");
      return;
    }
    startHeading();
  };

  // ---------- Buscador ----------
  const input = $("search-input"), results = $("search-results");
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    results.innerHTML = "";
    if (!q) { results.hidden = true; return; }
    const hits = PLACES.filter((p) => listed(p) && (p.name + " " + p.includes).toLowerCase().includes(q));
    hits.forEach((p) => {
      const li = document.createElement("li");
      const where = whereText(p);
      li.innerHTML = `${esc(p.name)}<small>${CATEGORIES[p.cat].label}${where ? " · " + esc(where) : ""}</small>`;
      li.onclick = () => { select(p.id); input.value = ""; results.hidden = true; };
      results.appendChild(li);
    });
    if (!hits.length) results.innerHTML = "<li><small>Sin resultados</small></li>";
    results.hidden = false;
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".search")) results.hidden = true; });

  // ---------- Mapa compartido (server.py → /api/map) ----------
  const NO_SERVER_MSG = "Sin servidor. Ejecuta python server.py y abre http://localhost:8000";

  function setSyncStatus(mode, text) {
    App.syncMode = mode;
    const n = $("sync-status");
    if (!n) return;
    n.textContent = text;
    n.classList.toggle("ok", mode === "server");
    n.classList.toggle("bad", mode === "local");
  }

  const localHost = (h) => h === "localhost" || h === "127.0.0.1";

  function apiCandidates() {
    const urls = [];
    const add = (u) => { if (u && !urls.includes(u)) urls.push(u); };
    // Por el dominio solo vale la misma dirección. Probar :8000 o 127.0.0.1
    // hace que la PC guarde cambios en local y el celular se quede con el HTML.
    if (location.protocol !== "file:") add(new URL("/api/map", location.href).href);
    if (location.protocol === "file:" || localHost(location.hostname)) {
      ["127.0.0.1", "localhost"].forEach((h) => {
        [8000, 8080].forEach((p) => add(`http://${h}:${p}/api/map`));
      });
    }
    return urls;
  }

  function parseApiBody(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.places)) return data.places;
    return null;
  }

  async function probeApi(url) {
    // Solo confirma que el servidor responde. El mapa, con fotos, pesa más de 1 MB
    // y no cabe en una espera corta; la descarga completa ocurre después.
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 404) {
      let data = null;
      try { data = await res.json(); } catch (err) { return false; }
      return !!(data && data.error === "sin datos guardados");
    }
    const json = res.ok && (res.headers.get("content-type") || "").includes("json");
    try { if (res.body) await res.body.cancel(); } catch (err) { /* nada */ }
    return json;
  }

  async function findApi() {
    if (App.apiUrl) return App.apiUrl;
    for (const url of apiCandidates()) {
      try {
        const ok = await Promise.race([
          probeApi(url),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 12000))
        ]);
        if (ok) {
          App.apiUrl = url;
          return url;
        }
      } catch (err) { /* siguiente candidato */ }
    }
    return null;
  }

  async function fetchServerMap() {
    const url = App.apiUrl || await findApi();
    if (!url) throw new Error("no-api");
    const res = await fetch(url, { cache: "no-store" });
    let data = null;
    try { data = await res.json(); } catch (err) { throw new Error("no-api"); }
    if (res.status === 404 && data && data.error === "sin datos guardados") {
      setSyncStatus("server", "Mapa compartido");
      return { ok: true, places: null };
    }
    const places = parseApiBody(data);
    if (!res.ok || !validSaved(places)) throw new Error("no-api");
    setSyncStatus("server", "Mapa compartido");
    return { ok: true, places };
  }

  async function pushMap(list) {
    try {
      const url = App.apiUrl || await findApi();
      if (!url) {
        setSyncStatus("local", "Solo este dispositivo");
        return false;
      }
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(list)
      });
      if (!res.ok) {
        setSyncStatus("local", "Solo este dispositivo");
        return false;
      }
      list.forEach((p) => {
        if (p && typeof p.photo === "string" && p.photo.startsWith("data:")) p.photo = true;
      });
      setSyncStatus("server", "Mapa compartido");
      writeLocalCache(list);
      if (App.hooks.onPhotosStored) App.hooks.onPhotosStored();
      return true;
    } catch (err) {
      setSyncStatus("local", "Solo este dispositivo");
      return false;
    }
  }

  async function resetMap() {
    try { localStorage.removeItem(STORE_KEY); } catch (err) { /* nada */ }
    try {
      const url = App.apiUrl || await findApi();
      if (!url) return false;
      const res = await fetch(url, { method: "DELETE" });
      return res.ok;
    } catch (err) {
      return false;
    }
  }

  const calibUrl = () => (App.apiUrl ? App.apiUrl.replace(/\/api\/map$/, "/api/calib") : null);

  async function syncCalibration() {
    const url = calibUrl();
    if (!url) return false;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.status === 404) {
        // Una calibración que no se pudo publicar se sube en cuanto hay servidor; si no, se descarta
        let cached = null;
        try { cached = JSON.parse(localStorage.getItem(CALIB_KEY)); } catch (err) { /* nada */ }
        if (cached && cached.pending && Array.isArray(cached.points)) {
          const put = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ points: cached.points }) });
          if (put.ok) {
            try { localStorage.setItem(CALIB_KEY, JSON.stringify({ points: cached.points })); } catch (err) { /* nada */ }
            showToast("Se publicó la calibración GPS que estaba solo en este dispositivo.", 5000);
          }
          return false;
        }
        try { localStorage.removeItem(CALIB_KEY); } catch (err) { /* nada */ }
        return applyCalibration(null);
      }
      if (!res.ok) return false;
      const data = await res.json();
      if (!data || !Array.isArray(data.points)) return false;
      try { localStorage.setItem(CALIB_KEY, JSON.stringify(data)); } catch (err) { /* nada */ }
      return applyCalibration(data.points);
    } catch (err) {
      return false;
    }
  }

  // Ajusta, aplica y publica. Devuelve el ajuste ({ ok, rms, residuals, ... }) y si quedó publicado.
  async function setCalibration(points) {
    const fit = fitCalibration(points);
    if (!fit.ok) return { fit, published: false };
    const body = { points: points.map((p) => ({ x: p.x, y: p.y, lat: p.lat, lon: p.lon })) };
    try { localStorage.setItem(CALIB_KEY, JSON.stringify(body)); } catch (err) { /* nada */ }
    applyCalibration(body.points);
    let published = false;
    try {
      const url = calibUrl() || (await findApi(), calibUrl());
      if (url) {
        const res = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        published = res.ok;
      }
    } catch (err) { /* sin servidor */ }
    if (!published) {
      try { localStorage.setItem(CALIB_KEY, JSON.stringify({ ...body, pending: true })); } catch (err) { /* nada */ }
    }
    return { fit, published };
  }

  async function clearCalibration() {
    try { localStorage.removeItem(CALIB_KEY); } catch (err) { /* nada */ }
    applyCalibration(null);
    try {
      const url = calibUrl() || (await findApi(), calibUrl());
      if (url) return (await fetch(url, { method: "DELETE" })).ok;
    } catch (err) { /* sin servidor */ }
    return false;
  }

  function paintMap() {
    drawPlaces();
    routeLayer.innerHTML = "";
    if (selected && !PLACES.find((p) => p.id === selected)) hideInfo();
    else render();
  }

  async function syncFromServer() {
    if (App.editing) return;
    if (await syncCalibration()) showToast("Calibración GPS actualizada", 2000);
    try {
      const result = await fetchServerMap();
      if (!result.places) return;
      if (JSON.stringify(result.places) === JSON.stringify(PLACES)) return;
      applyPlaces(result.places, true);
      paintMap();
      if (selected) {
        const current = PLACES.find((p) => p.id === selected);
        if (current) showPlacePhoto(current);
      }
      showToast("Mapa actualizado", 2000);
    } catch (err) { /* sin servidor: se conserva lo actual */ }
  }

  async function initSync() {
    const url = await findApi();
    if (!url) {
      const cached = readLocalCache();
      if (cached) {
        applyPlaces(cached, false);
        paintMap();
      }
      setSyncStatus("local", "Solo este dispositivo");
      showToast(NO_SERVER_MSG, 8000);
      return;
    }
    await syncCalibration();
    try {
      const result = await fetchServerMap();
      if (result.places) {
        applyPlaces(result.places, true);
        paintMap();
        return;
      }
      const cached = readLocalCache();
      if (cached) {
        const ok = await pushMap(cached);
        if (ok) {
          applyPlaces(cached, true);
          paintMap();
          showToast("Se publicaron los cambios que estaban solo en este dispositivo.", 5000);
        }
      }
    } catch (err) {
      const cached = readLocalCache();
      if (cached) {
        applyPlaces(cached, false);
        paintMap();
      }
      setSyncStatus("local", "Solo este dispositivo");
      showToast(NO_SERVER_MSG, 8000);
    }
  }

  initSync();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncFromServer();
  });
  setInterval(syncFromServer, 8000);

  // API para el editor
  Object.assign(App, {
    svg, viewport, el, toMap, NODES, esc,
    getView: () => view,
    redraw() { activeRoute = null; drawPlaces(); routeLayer.innerHTML = ""; render(); },
    highlight(id) { selected = id; render(); },
    hideInfo,
    stopHeading: () => endHeading(null, true),
    pushMap,
    resetMap,
    fitCalibration,
    setCalibration,
    clearCalibration,
    getCalibration: () => calib,
    showToast,
    cancelSimPick() {
      if (!simPicking) return;
      simPicking = false;
      syncSimButton();
    },
    getFloor: () => floor,
    setFloor,
    floorOf,
    onFloor,
    placeFloors,
    maps360Url
  });

  render();
})();
