// Editor de figuras del croquis. Usa la API que expone app.js (window.App).
(() => {
  "use strict";
  const App = window.App;
  if (!App) return;

  const { svg, viewport, el, toMap, NODES } = App;
  const $ = (id) => document.getElementById(id);
  const BG_KEY = "mapa-facultad-bg";

  const TOOL_HINTS = {
    select: "Clic para editar; arrastra para mover. Shift+clic gira 15°. Ctrl+clic mueve el centro al punto. Alt+clic elimina. Ctrl+C copia, Ctrl+V pega, Ctrl+Y rehace.",
    poly: "Haz clic para colocar las esquinas. Cierra la figura haciendo clic en el primer punto, con doble clic o con Enter. Backspace borra el último punto; Esc cancela.",
    pin: "Haz clic en el mapa para colocar un pin.",
    wall: "Haz clic para trazar el muro. Termina con doble clic, Enter o el botón. Backspace borra el último punto; Esc cancela. El muro solo se ve: no sale en el buscador ni cambia las rutas.",
    door: "Haz clic en el borde de un aula, oficina o lugar de esta planta para marcar su puerta. La ruta sigue llegando a la entrada del edificio; la puerta indica por dónde se entra al lugar.",
    stair: "Haz clic para colocar una escalera. Queda en la Planta 1 y en la Planta 2. Acerca cada punta a la línea de ruta de esa planta: «Cómo llegar» usa la escalera para pasar de una planta a la otra. No se coloca en la vista aérea.",
    zone: "Haz clic para marcar el área por donde se puede caminar y ciérrala en el primer punto, con doble clic o Enter. «Cómo llegar» usa el camino más corto dentro de esas zonas y no atraviesa edificios ni muros. Si se tocan, quedan unidas. No sale en el buscador.",
    route: "Haz clic para trazar por dónde se camina. Termina con doble clic o Enter. En una planta, acerca la línea a la escalera: así se une con la ruta de la otra planta. También puedes acercarla a otra ruta o a la puerta del lugar.",
    delete: "Haz clic en una figura para borrarla (puedes deshacer con Ctrl+Z).",
    bg: "Arrastra para mover la imagen de fondo y usa el control de tamaño para ajustarla a los edificios. El fondo solo se ve en el editor.",
    calib: "Clic en el croquis para agregar un punto de control; arrastra un punto para moverlo. Los cambios se aplican para todos al pulsar «Aplicar y publicar»."
  };

  let tool = "select";
  let selId = null;
  let draft = null;   // puntos de la figura que se está dibujando
  let cursor = null;  // posición del puntero mientras se dibuja
  const undoStack = [];
  const redoStack = [];
  let clipboard = null;
  let swallowClick = false;
  let calibPts = [];  // puntos de control en edición: { x, y, lat, lon } (lat/lon null hasta capturarlos)

  // ---------- Capas del editor (encima del croquis) ----------
  const bgImg = el("image", { x: 0, y: 0, width: 1024, height: 580, preserveAspectRatio: "xMidYMid meet", opacity: 0.5, "pointer-events": "none" }, viewport);
  bgImg.style.display = "none";
  const editLayer = el("g", { class: "edit-layer" }, viewport);
  const draftLayer = el("g", { class: "draft-layer", "pointer-events": "none" }, viewport);
  const calibLayer = el("g", { class: "calib-layer" }, viewport);

  // Posición y tamaño de la imagen de apoyo (se guardan en el navegador)
  const BGT_KEY = "mapa-facultad-bg-t";
  let bgT = { x: 0, y: 0, s: 1 };
  function applyBg() {
    bgImg.setAttribute("x", bgT.x); bgImg.setAttribute("y", bgT.y);
    bgImg.setAttribute("width", 1024 * bgT.s); bgImg.setAttribute("height", 580 * bgT.s);
    $("ed-bg-scale").value = Math.round(bgT.s * 100);
  }
  function saveBgT() { try { localStorage.setItem(BGT_KEY, JSON.stringify(bgT)); } catch (err) { /* nada */ } }

  try {
    const savedBg = localStorage.getItem(BG_KEY);
    if (savedBg) bgImg.setAttribute("href", savedBg);
    const t = JSON.parse(localStorage.getItem(BGT_KEY));
    if (t && isFinite(t.x) && isFinite(t.y) && t.s > 0) bgT = t;
  } catch (err) { /* sin almacenamiento */ }

  // ---------- Utilidades ----------
  const k = () => App.getView().k;
  const place = (id) => PLACES.find((p) => p.id === id);
  const round = (n) => Math.round(n * 10) / 10;
  const parsePts = (s) => s.trim().split(/\s+/).map((q) => q.split(",").map(Number));
  const ptsStr = (a) => a.map((q) => `${round(q[0])},${round(q[1])}`).join(" ");
  const centroid = (a) => [round(a.reduce((s, q) => s + q[0], 0) / a.length), round(a.reduce((s, q) => s + q[1], 0) / a.length)];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const nearestNode = (pt) => Object.keys(NODES).reduce((a, b) => (dist(NODES[a], pt) <= dist(NODES[b], pt) ? a : b));
  const newId = () => "custom-" + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
  const isLine = (kind) => kind === "wall" || kind === "route";
  const isClosed = (kind) => kind === "poly" || kind === "zone";

  function wrapLabel(name, max = 16) {
    const lines = [];
    let cur = "";
    String(name).split(/\s+/).forEach((w) => {
      if (cur && (cur + " " + w).length > max) { lines.push(cur); cur = w; }
      else cur = cur ? cur + " " + w : w;
    });
    if (cur) lines.push(cur);
    return lines.join("\n");
  }

  // Recalcula etiqueta, puerta y nodo de ruta de una figura (para que "Cómo llegar" siga funcionando)
  function autoRoute(p) {
    if (p.kind === "zone") return;
    if (p.kind === "poly") {
      const pts = parsePts(p.points);
      const c = centroid(pts);
      p.labelPos = c;
      p.link = nearestNode(c);
      const n = NODES[p.link];
      p.door = pts.reduce((a, b) => (dist(a, n) <= dist(b, n) ? a : b)).map(round);
    } else {
      p.link = nearestNode(p.door);
    }
  }

  let noteTimer;
  function note(msg, ms = 3500) {
    const t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => (t.hidden = true), ms);
  }
  let savedTimer;
  function flash(msg) {
    const s = $("ed-saved");
    s.textContent = msg;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (s.textContent = ""), 1800);
  }

  // ---------- Guardado y deshacer ----------
  let saveTimer;
  function save() {
    try { localStorage.setItem(App.STORE_KEY, JSON.stringify(PLACES)); }
    catch (err) { flash("No se pudo guardar"); return; }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const ok = App.pushMap ? await App.pushMap(PLACES) : false;
      flash(ok ? "Publicado para todos ✓" : "Sin servidor: python server.py");
    }, 400);
  }
  const updateUndo = () => {
    $("ed-undo").disabled = undoStack.length === 0;
    $("ed-redo").disabled = redoStack.length === 0;
  };
  function snapshot() {
    undoStack.push(JSON.stringify(PLACES));
    if (undoStack.length > 80) undoStack.shift();
    redoStack.length = 0;
    updateUndo();
  }
  function restore(json) {
    PLACES.splice(0, PLACES.length, ...JSON.parse(json));
    if (selId && !place(selId)) selId = null;
    save(); refresh(); updateUndo();
  }
  function undo() {
    const s = undoStack.pop();
    if (!s) return;
    redoStack.push(JSON.stringify(PLACES));
    restore(s);
  }
  function redo() {
    const s = redoStack.pop();
    if (!s) return;
    undoStack.push(JSON.stringify(PLACES));
    if (undoStack.length > 80) undoStack.shift();
    restore(s);
  }

  // ---------- Dibujo de asas y borrador ----------
  function renderHandles() {
    editLayer.innerHTML = "";
    const p = App.editing && selId && place(selId);
    if (!p) return;
    const kk = k();
    if (p.kind === "stair") {
      const pt = p.spans && p.spans[App.getFloor()];
      if (pt) el("circle", { cx: pt[0], cy: pt[1], r: 8 / kk, class: "h-vertex", "data-h": "stair" }, editLayer);
      return;
    }
    if (p.entry && p.kind !== "zone" && !isLine(p.kind)) {
      el("circle", { cx: p.entry[0], cy: p.entry[1], r: 7 / kk, class: "h-door", "data-h": "entry" }, editLayer);
    }
    if (!isClosed(p.kind) && !isLine(p.kind)) return;
    const pts = parsePts(p.points);
    const last = isLine(p.kind) ? pts.length - 1 : pts.length;
    for (let i = 0; i < last; i++) {
      const n = pts[isLine(p.kind) ? i + 1 : (i + 1) % pts.length];
      el("circle", { cx: (pts[i][0] + n[0]) / 2, cy: (pts[i][1] + n[1]) / 2, r: 4.5 / kk, class: "h-mid", "data-h": "m", "data-i": i }, editLayer);
    }
    pts.forEach((q, i) => el("circle", { cx: q[0], cy: q[1], r: 7 / kk, class: "h-vertex", "data-h": "v", "data-i": i }, editLayer));
  }

  function renderDraft() {
    draftLayer.innerHTML = "";
    if (!draft || !draft.length) return;
    const kk = k();
    const pts = cursor ? [...draft, cursor] : [...draft];
    el("polyline", { points: pts.map((q) => q.join(",")).join(" "), class: "draft-line" }, draftLayer);
    draft.forEach((q, i) => el("circle", { cx: q[0], cy: q[1], r: (i === 0 ? 8 : 5) / kk, class: "draft-pt" + (i === 0 ? " first" : "") }, draftLayer));
  }
  App.hooks.onView = () => { renderHandles(); renderDraft(); renderCalibMarks(); };

  const updateFinish = () => {
    const line = (tool === "wall" || tool === "route") && draft && draft.length >= 2;
    const poly = (tool === "poly" || tool === "zone") && draft && draft.length >= 3;
    $("ed-finish").hidden = !(line || poly);
    $("ed-finish").textContent = tool === "zone" ? "✓ Terminar zona" : tool === "route" ? "✓ Terminar ruta" : tool === "wall" ? "✓ Terminar muro" : "✓ Terminar figura";
  };

  // ---------- Panel de propiedades ----------
  Object.entries(CATEGORIES).forEach(([key, c]) => {
    if (key === "muro" || key === "ruta" || key === "zona") return;
    const o = document.createElement("option");
    o.value = key; o.textContent = c.label;
    $("ed-cat").appendChild(o);
  });
  FLOORS.forEach((f) => {
    const o = document.createElement("option");
    o.value = f.id; o.textContent = f.label;
    $("ed-floor").appendChild(o);
  });

  const showField = (id, on) => { const label = $(id).closest("label"); if (label) label.hidden = !on; };

  function fillPanel() {
    const p = selId && place(selId);
    $("editor-panel").hidden = !(App.editing && p);
    if (!p) return;
    const wall = p.kind === "wall";
    const route = p.kind === "route";
    const zone = p.kind === "zone";
    const line = wall || route;
    const quiet = line || zone;
    const stair = p.kind === "stair";
    $("ed-kind").textContent = zone ? "Zona caminable" : route ? "Línea de ruta" : wall ? "Muro" : stair ? "Escalera (conecta plantas)" : p.kind === "poly" ? "Figura (edificio / área)" : "Pin";
    $("ed-name").value = p.name;
    if (!quiet && !stair && CATEGORIES[p.cat] && p.cat !== "muro" && p.cat !== "ruta" && p.cat !== "zona") $("ed-cat").value = p.cat;
    if (!stair) $("ed-floor").value = App.floorOf(p);
    $("ed-desc").value = p.desc || "";
    $("ed-hours").value = p.hours || "";
    $("ed-includes").value = p.includes || "";
    showField("ed-cat", !quiet && !stair);
    showField("ed-floor", !stair);
    showField("ed-desc", !quiet);
    showField("ed-hours", !quiet);
    showField("ed-includes", !quiet);
    $("ed-delete").textContent = zone ? "Eliminar esta zona" : route ? "Eliminar esta ruta" : wall ? "Eliminar este muro" : stair ? "Eliminar esta escalera" : "Eliminar este lugar";
    const doorBox = $("ed-door");
    doorBox.hidden = quiet || stair;
    if (!doorBox.hidden) {
      $("ed-door-status").textContent = p.entry
        ? "Puerta colocada. Arrastra el punto naranja para moverla."
        : "Sin puerta. Usa la herramienta Puerta y haz clic en el borde.";
      $("ed-door-clear").hidden = !p.entry;
    }
    const stairBox = $("ed-stair");
    stairBox.hidden = !stair;
    if (stair) {
      const names = App.placeFloors(p).map((id) => (FLOORS.find((f) => f.id === id) || {}).label || id);
      $("ed-stair-status").textContent = `Conecta ${names.join(" y ")}. Si en cada planta queda cerca de una línea de ruta, el camino pasa de una a la otra por aquí. Moverla en una planta no mueve la otra.`;
    }
    const photoBox = $("ed-photo");
    photoBox.hidden = quiet;
    if (!quiet) {
      const preview = $("ed-photo-preview");
      if (p.photo) { preview.src = p.photo; preview.hidden = false; }
      else { preview.hidden = true; preview.removeAttribute("src"); }
      $("ed-photo-clear").hidden = !p.photo;
    }
  }

  // Cada campo toma una captura (para deshacer) en su primer cambio tras enfocarlo
  function bind(id, apply) {
    const input = $(id);
    let armed = false;
    input.addEventListener("focus", () => { armed = true; });
    input.addEventListener("input", () => {
      const p = selId && place(selId);
      if (!p) return;
      if (armed) { snapshot(); armed = false; }
      apply(p, input.value);
      commit();
    });
  }
  bind("ed-name", (p, v) => { p.name = v.trim() || "Sin nombre"; p.label = wrapLabel(p.name); });
  bind("ed-cat", (p, v) => { p.cat = v; });
  bind("ed-floor", (p, v) => { p.floor = v; });
  // La vista sigue al lugar cuando se cambia de planta
  $("ed-floor").addEventListener("input", () => { App.setFloor($("ed-floor").value); renderHandles(); });
  bind("ed-desc", (p, v) => { p.desc = v; });
  bind("ed-hours", (p, v) => { p.hours = v; });
  bind("ed-includes", (p, v) => { p.includes = v; });

  // ---------- Refrescos ----------
  function commit() { save(); redrawLight(); }
  function redrawLight() { App.redraw(); App.highlight(selId); renderHandles(); }
  function refresh() { redrawLight(); fillPanel(); }

  function select(id) { selId = id; refresh(); }
  function deselect() { selId = null; refresh(); }

  function remove(id) {
    const i = PLACES.findIndex((p) => p.id === id);
    if (i < 0) return;
    snapshot();
    PLACES.splice(i, 1);
    if (selId === id) selId = null;
    save(); refresh();
  }

  // ---------- Herramientas ----------
  function setTool(t) {
    if (t !== tool) cancelDraft();
    if (t === "calib" && tool !== "calib") { if (selId) deselect(); openCalib(); }
    tool = t;
    showCalib(App.editing && t === "calib");
    svg.dataset.tool = App.editing ? t : "";
    document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
    updateHint();
    updateFinish();
  }

  function updateHint() {
    const f = FLOORS.find((x) => x.id === App.getFloor());
    const drawing = tool === "poly" || tool === "pin" || tool === "wall" || tool === "door" || tool === "stair" || tool === "route" || tool === "zone";
    const stairFloor = tool === "stair" && f.id === "ext";
    const where = stairFloor ? "Cambia a Planta 1 o Planta 2. " : drawing ? `Se creará en: ${f.label}. ` : "";
    $("ed-hint").textContent = where + TOOL_HINTS[tool];
  }

  App.hooks.onFloor = () => {
    cancelDraft();
    const p = selId && place(selId);
    if (selId && (!p || !App.onFloor(p, App.getFloor()))) deselect();
    else { renderHandles(); fillPanel(); }
    if (App.editing) updateHint();
  };
  document.querySelectorAll(".tool").forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));

  function cancelDraft() { draft = null; cursor = null; renderDraft(); updateFinish(); }

  function addDraftPoint(pt) {
    if (!draft) draft = [];
    const last = draft[draft.length - 1];
    if (last && dist(last, pt) < 2 / k()) return;
    if ((tool === "poly" || tool === "zone") && draft.length >= 3 && dist(pt, draft[0]) < 10 / k()) {
      if (tool === "zone") finishZone(); else finishDraft();
      return;
    }
    draft.push(pt.map(round));
    renderDraft(); updateFinish();
  }

  function finishDraft() {
    if (!draft || draft.length < 3) { cancelDraft(); note("Una figura necesita al menos 3 puntos."); return; }
    snapshot();
    const fl = App.getFloor(), name = fl === "ext" ? "Nuevo edificio" : "Nueva aula";
    const p = {
      id: newId(), name, label: name, cat: fl === "ext" ? "edificio" : "aula", kind: "poly", floor: fl,
      points: ptsStr(draft), labelPos: [0, 0], door: [0, 0], link: "",
      desc: "Describe este lugar.", hours: "Por definir", includes: "Por definir"
    };
    autoRoute(p);
    PLACES.push(p);
    cancelDraft();
    save();
    setTool("select");
    select(p.id);
    $("ed-name").focus(); $("ed-name").select();
  }

  function finishZone() {
    if (!draft || draft.length < 3) { cancelDraft(); note("Una zona necesita al menos 3 puntos."); return; }
    snapshot();
    const p = {
      id: newId(), name: "Zona caminable", label: "Zona", cat: "zona", kind: "zone", floor: App.getFloor(),
      points: ptsStr(draft)
    };
    PLACES.push(p);
    cancelDraft();
    save();
    setTool("select");
    select(p.id);
    note("Zona lista. «Cómo llegar» cruza por aquí, por el camino más corto, sin atravesar edificios ni muros.");
  }

  function finishOpen() {
    const route = tool === "route";
    if (!draft || draft.length < 2) {
      cancelDraft();
      note(route ? "Una ruta necesita al menos 2 puntos." : "Un muro necesita al menos 2 puntos.");
      return;
    }
    snapshot();
    const fl = App.getFloor();
    const p = route
      ? { id: newId(), name: "Ruta", label: "Ruta", cat: "ruta", kind: "route", floor: fl, points: ptsStr(draft) }
      : { id: newId(), name: "Muro", label: "Muro", cat: "muro", kind: "wall", floor: fl, points: ptsStr(draft) };
    PLACES.push(p);
    cancelDraft();
    save();
    setTool("select");
    select(p.id);
  }

  function insidePoly(pt, pts) {
    let hit = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  }
  function snapToEdge(pt, pts) {
    let best = null, bestD = Infinity, angle = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const abx = b[0] - a[0], aby = b[1] - a[1];
      const len2 = abx * abx + aby * aby || 1;
      let t = ((pt[0] - a[0]) * abx + (pt[1] - a[1]) * aby) / len2;
      t = Math.max(0, Math.min(1, t));
      const x = a[0] + abx * t, y = a[1] + aby * t;
      const d = Math.hypot(pt[0] - x, pt[1] - y);
      if (d < bestD) { bestD = d; best = [x, y]; angle = Math.atan2(aby, abx) * 180 / Math.PI; }
    }
    return { pt: best, d: bestD, angle };
  }
  function placeDoor(pt) {
    const fl = App.getFloor();
    const candidates = PLACES.filter((p) => App.onFloor(p, fl) && !isLine(p.kind) && p.kind !== "stair");
    let target = null, snap = null;
    candidates.forEach((p) => {
      if (p.kind !== "poly" || !p.points) return;
      const pts = parsePts(p.points);
      if (insidePoly(pt, pts)) { target = p; snap = snapToEdge(pt, pts); }
    });
    if (!target) {
      let bestD = 18 / k();
      candidates.forEach((p) => {
        if (p.kind === "poly" && p.points) {
          const s = snapToEdge(pt, parsePts(p.points));
          if (s.d < bestD) { bestD = s.d; target = p; snap = s; }
        } else if (Array.isArray(p.door)) {
          const d = dist(pt, p.door);
          if (d < bestD) { bestD = d; target = p; snap = { pt: pt.slice(), angle: 0 }; }
        }
      });
    }
    if (!target || !snap) { note("Haz clic sobre un aula, oficina o lugar de esta planta."); return; }
    snapshot();
    target.entry = snap.pt.map(round);
    target.entryAngle = Math.round(snap.angle);
    save();
    select(target.id);
    note(`Puerta de ${target.name}.`);
  }

  function createStair(pt) {
    const fl = App.getFloor();
    if (fl !== "p1" && fl !== "p2") { note("Las escaleras se colocan en Planta 1 o Planta 2."); return; }
    snapshot();
    const other = fl === "p1" ? "p2" : "p1";
    const pos = pt.map(round);
    const p = {
      id: newId(), name: "Escalera", label: "Escalera", cat: "escalera", kind: "stair",
      spans: { [fl]: pos, [other]: pos.slice() },
      desc: "Conecta la Planta 1 con la Planta 2.", hours: "Por definir", includes: "Por definir"
    };
    PLACES.push(p);
    save();
    setTool("select");
    select(p.id);
    $("ed-name").focus(); $("ed-name").select();
    note("Escalera colocada en las dos plantas. Cambia de planta para ajustar la otra punta.");
  }

  function createPin(pt) {
    snapshot();
    const p = {
      id: newId(), name: "Nuevo pin", label: "Nuevo pin", cat: "servicio", kind: "pin", floor: App.getFloor(),
      door: pt.map(round), link: "", labelOffset: [18, 4],
      desc: "Describe este lugar.", hours: "Por definir", includes: "Por definir"
    };
    autoRoute(p);
    PLACES.push(p);
    save();
    setTool("select");
    select(p.id);
    $("ed-name").focus(); $("ed-name").select();
  }

  App.hooks.onShapeClick = (id) => {
    if (tool === "select") select(id);
    else if (tool === "delete") remove(id);
  };

  // ---------- Interacción con el mapa ----------
  function setPoly(p, pts) { p.points = ptsStr(pts); if (p.kind === "poly") autoRoute(p); redrawLight(); }
  function setWall(p, pts) { p.points = ptsStr(pts); redrawLight(); }

  function beginDrag(e, kind, idx, alreadySnapped) {
    const p = selId && place(selId);
    if (!p) return;
    const start = toMap(e);
    const orig = JSON.parse(JSON.stringify(p));
    const origPts = (isClosed(p.kind) || isLine(p.kind)) ? parsePts(orig.points) : null;
    let started = alreadySnapped;

    const move = (ev) => {
      const cur = toMap(ev);
      const dx = cur[0] - start[0], dy = cur[1] - start[1];
      if (!started) {
        if (Math.hypot(dx, dy) * k() < 3) return; // evita mover por un simple clic
        snapshot(); started = true;
      }
      if (kind === "move") {
        if (isClosed(p.kind)) {
          if (p.kind === "poly" && orig.entry) p.entry = [round(orig.entry[0] + dx), round(orig.entry[1] + dy)];
          setPoly(p, origPts.map((q) => [q[0] + dx, q[1] + dy]));
        } else if (isLine(p.kind)) {
          setWall(p, origPts.map((q) => [q[0] + dx, q[1] + dy]));
        } else if (p.kind === "stair") {
          const fl = App.getFloor();
          const o = orig.spans[fl];
          p.spans[fl] = [round(o[0] + dx), round(o[1] + dy)];
          redrawLight();
        } else {
          p.door = [round(orig.door[0] + dx), round(orig.door[1] + dy)];
          if (orig.entry) p.entry = [round(orig.entry[0] + dx), round(orig.entry[1] + dy)];
          autoRoute(p);
          redrawLight();
        }
      } else if (kind === "entry") {
        let pos = [orig.entry[0] + dx, orig.entry[1] + dy];
        if (p.kind === "poly" && origPts) {
          const snap = snapToEdge(pos, origPts);
          pos = snap.pt;
          p.entryAngle = Math.round(snap.angle);
        }
        p.entry = [round(pos[0]), round(pos[1])];
        redrawLight();
      } else {
        const pts = origPts.map((q) => q.slice());
        pts[idx] = [origPts[idx][0] + dx, origPts[idx][1] + dy];
        if (isLine(p.kind)) setWall(p, pts);
        else setPoly(p, pts);
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (started) { save(); fillPanel(); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function centerOf(p) {
    if ((isClosed(p.kind) || isLine(p.kind)) && p.points) return centroid(parsePts(p.points));
    if (p.kind === "stair" && p.spans) return (p.spans[App.getFloor()] || p.spans.p1 || p.spans.p2).slice();
    return (p.door || p.entry || [0, 0]).slice();
  }
  function shiftObject(p, dx, dy) {
    const mv = (q) => [round(q[0] + dx), round(q[1] + dy)];
    if (p.points) {
      p.points = ptsStr(parsePts(p.points).map(mv));
      if (p.labelPos) p.labelPos = mv(p.labelPos);
      if (p.door) p.door = mv(p.door);
      if (p.entry) p.entry = mv(p.entry);
    } else if (p.kind === "stair" && p.spans) {
      Object.keys(p.spans).forEach((fl) => { if (Array.isArray(p.spans[fl])) p.spans[fl] = mv(p.spans[fl]); });
    } else if (p.door) {
      p.door = mv(p.door);
      if (p.entry) p.entry = mv(p.entry);
    }
  }
  function rotateBy(p, deg) {
    if (!p) return;
    if (p.kind === "pin" || p.kind === "stair" || !p.points) { note("Este objeto no se gira."); return; }
    snapshot();
    const c = centerOf(p);
    const rad = deg * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const rot = (q) => [round(c[0] + (q[0] - c[0]) * cos - (q[1] - c[1]) * sin), round(c[1] + (q[0] - c[0]) * sin + (q[1] - c[1]) * cos)];
    if (p.entry) { p.entry = rot(p.entry); p.entryAngle = Math.round((p.entryAngle || 0) + deg); }
    const pts = parsePts(p.points).map(rot);
    if (p.kind === "poly") setPoly(p, pts);
    else setWall(p, pts);
    save();
    note("Girado 15°.");
  }
  function moveSelectionTo(pt) {
    const p = selId && place(selId);
    if (!p) return;
    if (p.kind === "stair") {
      const fl = App.getFloor();
      if (!p.spans || !p.spans[fl]) { note("Esta escalera no está en la planta actual."); return; }
      snapshot();
      p.spans[fl] = pt.map(round);
      redrawLight(); save(); return;
    }
    snapshot();
    const c = centerOf(p);
    shiftObject(p, pt[0] - c[0], pt[1] - c[1]);
    if (p.kind === "poly" || p.kind === "pin") autoRoute(p);
    redrawLight(); save(); fillPanel();
  }
  function copySel() {
    const p = selId && place(selId);
    if (!p) { note("Selecciona un objeto para copiarlo."); return; }
    clipboard = JSON.parse(JSON.stringify(p));
    note("Copiado. Ctrl+V lo pega.");
  }
  function pasteSel() {
    if (!clipboard) { note("No hay nada copiado."); return; }
    snapshot();
    const p = JSON.parse(JSON.stringify(clipboard));
    p.id = newId();
    shiftObject(p, 16, 16);
    if (p.kind !== "stair") p.floor = App.getFloor();
    if (p.kind === "poly" || p.kind === "pin") autoRoute(p);
    PLACES.push(p);
    save();
    setTool("select");
    select(p.id);
    note("Pegado.");
  }

  // Captura el puntero antes que el pan del mapa
  svg.addEventListener("pointerdown", (e) => {
    if (!App.editing || e.button > 0) return;
    const under = e.target.closest(".building");
    if (e.altKey && under) {
      e.stopPropagation(); e.preventDefault();
      swallowClick = true;
      remove(under.dataset.id);
      return;
    }
    if (e.shiftKey && under && tool === "select") {
      e.stopPropagation(); e.preventDefault();
      swallowClick = true;
      rotateBy(place(under.dataset.id), 15);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && tool === "select" && selId) {
      e.stopPropagation(); e.preventDefault();
      swallowClick = true;
      moveSelectionTo(toMap(e));
      return;
    }
    if (tool !== "select") return;
    const handle = e.target.closest("[data-h]");
    const p = selId && place(selId);
    if (handle && p) {
      e.stopPropagation(); e.preventDefault();
      if (handle.dataset.h === "entry") { beginDrag(e, "entry", null, false); return; }
      if (handle.dataset.h === "stair") { beginDrag(e, "move", null, false); return; }
      const i = Number(handle.dataset.i);
      if (handle.dataset.h === "m") {
        snapshot();
        const pts = parsePts(p.points);
        const b = pts[isLine(p.kind) ? i + 1 : (i + 1) % pts.length];
        const a = pts[i];
        pts.splice(i + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        if (isLine(p.kind)) setWall(p, pts);
        else setPoly(p, pts);
        beginDrag(e, "vertex", i + 1, true);
      } else {
        beginDrag(e, "vertex", i, false);
      }
      return;
    }
    const b = e.target.closest(".building");
    if (b) {
      e.stopPropagation(); e.preventDefault();
      if (selId !== b.dataset.id) select(b.dataset.id);
      beginDrag(e, "move", null, false);
    }
  }, true);

  svg.addEventListener("click", (e) => {
    if (swallowClick) { swallowClick = false; e.stopPropagation(); return; }
    if (!App.editing || e._dragged) return;
    if (tool === "poly" || tool === "wall" || tool === "route" || tool === "zone") { e.stopPropagation(); addDraftPoint(toMap(e)); }
    else if (tool === "pin") { e.stopPropagation(); createPin(toMap(e)); }
    else if (tool === "door") { e.stopPropagation(); placeDoor(toMap(e)); }
    else if (tool === "stair") { e.stopPropagation(); createStair(toMap(e)); }
    else if (tool === "select" && !e.target.closest(".building, [data-h]") && selId) deselect();
  }, true);

  svg.addEventListener("dblclick", (e) => {
    if (!App.editing) return;
    if ((tool === "poly" || tool === "wall" || tool === "route" || tool === "zone") && draft) {
      e.stopPropagation();
      if (tool === "wall" || tool === "route") finishOpen();
      else if (tool === "zone") finishZone();
      else finishDraft();
      return;
    }
    const h = e.target.closest("[data-h='v']");
    const p = selId && place(selId);
    if (h && p && (isClosed(p.kind) || isLine(p.kind))) {
      const pts = parsePts(p.points);
      const min = isLine(p.kind) ? 2 : 3;
      if (pts.length <= min) { note(isLine(p.kind) ? "La línea necesita al menos 2 puntos." : "Una figura necesita al menos 3 puntos."); return; }
      snapshot();
      pts.splice(Number(h.dataset.i), 1);
      if (isLine(p.kind)) setWall(p, pts); else setPoly(p, pts);
      save();
    }
  }, true);

  svg.addEventListener("pointermove", (e) => {
    if (App.editing && draft) { cursor = toMap(e); renderDraft(); }
  });

  // ---------- Atajos de teclado ----------
  document.addEventListener("keydown", (e) => {
    if (!App.editing) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y" && !typing) { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && !typing) { e.preventDefault(); copySel(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && !typing) { e.preventDefault(); pasteSel(); return; }
    if (typing) { if (e.key === "Escape") e.target.blur(); return; }
    switch (e.key) {
      case "Escape": if (draft) cancelDraft(); else if (selId) deselect(); break;
      case "Enter": if (draft) { if (tool === "wall" || tool === "route") finishOpen(); else if (tool === "zone") finishZone(); else finishDraft(); } break;
      case "Backspace": if (draft && draft.length) { e.preventDefault(); draft.pop(); renderDraft(); updateFinish(); } break;
      case "Delete": if (selId) remove(selId); break;
      case "v": case "V": setTool("select"); break;
      case "b": case "B": setTool("poly"); break;
      case "p": case "P": setTool("pin"); break;
      case "m": case "M": setTool("wall"); break;
      case "u": case "U": setTool("door"); break;
      case "e": case "E": setTool("stair"); break;
      case "z": case "Z": setTool("zone"); break;
      case "r": case "R": setTool("route"); break;
      case "d": case "D": setTool("delete"); break;
      case "g": case "G": setTool("calib"); break;
    }
  });

  // ---------- Barra: botones ----------
  $("ed-undo").onclick = undo;
  $("ed-redo").onclick = redo;
  $("ed-finish").onclick = () => { if (tool === "wall" || tool === "route") finishOpen(); else if (tool === "zone") finishZone(); else finishDraft(); };
  $("ed-delete").onclick = () => selId && remove(selId);
  $("ed-door-clear").onclick = () => {
    const p = selId && place(selId);
    if (!p || !p.entry) return;
    snapshot();
    delete p.entry;
    delete p.entryAngle;
    save();
    refresh();
  };
  $("ed-stair-align").onclick = () => {
    const p = selId && place(selId);
    if (!p || p.kind !== "stair") return;
    const fl = App.getFloor();
    if ((fl !== "p1" && fl !== "p2") || !p.spans[fl]) { note("Cambia a la planta donde está la escalera."); return; }
    const other = fl === "p1" ? "p2" : "p1";
    snapshot();
    p.spans[other] = p.spans[fl].slice();
    save();
    refresh();
    note(`La ${(FLOORS.find((f) => f.id === other) || {}).label} quedó en la misma posición.`);
  };

  // Reduce la imagen (máx. 1920 px, JPEG) para que quepa en el almacenamiento del navegador
  function downscale(img, maxPx, quality) {
    const limit = maxPx || 1920;
    const q = quality == null ? 0.85 : quality;
    const r = Math.min(1, limit / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", q);
  }
  $("ed-photo-file").onchange = (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    const p = selId && place(selId);
    if (!file || !p || isLine(p.kind)) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        snapshot();
        p.photo = downscale(img, 640, 0.65);
        save(); fillPanel();
        note("Foto lista. Se verá en la ficha del lugar.");
      };
      img.onerror = () => note("No se pudo leer esa imagen.");
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };
  $("ed-photo-clear").onclick = () => {
    const p = selId && place(selId);
    if (!p || !p.photo) return;
    snapshot();
    delete p.photo;
    save(); fillPanel();
  };
  function setBg(url) {
    bgImg.setAttribute("href", url);
    bgImg.style.display = App.editing ? "" : "none";
    try { localStorage.setItem(BG_KEY, url); } catch (err) { note("La imagen es muy grande para guardarse; se verá solo en esta sesión."); }
  }
  $("ed-bg").onchange = (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        bgT = { x: 0, y: 0, s: 1 }; applyBg(); saveBgT();
        setBg(downscale(img));
        note("Imagen cargada. Usa «Mover fondo» para ajustarla y el deslizador para su opacidad.");
      };
      img.onerror = () => note("No se pudo leer esa imagen.");
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };
  $("ed-bg-opacity").oninput = (e) => bgImg.setAttribute("opacity", Number(e.target.value) / 100);
  $("ed-bg-scale").oninput = (e) => {
    // Escala manteniendo el centro de la imagen
    const s = Number(e.target.value) / 100;
    const cx = bgT.x + (1024 * bgT.s) / 2, cy = bgT.y + (580 * bgT.s) / 2;
    bgT.s = s; bgT.x = cx - (1024 * s) / 2; bgT.y = cy - (580 * s) / 2;
    applyBg(); saveBgT();
  };
  $("ed-bg-clear").onclick = () => {
    bgImg.removeAttribute("href"); bgImg.style.display = "none";
    bgT = { x: 0, y: 0, s: 1 }; applyBg();
    try { localStorage.removeItem(BG_KEY); localStorage.removeItem(BGT_KEY); } catch (err) { /* nada */ }
    note("Imagen de fondo quitada.");
  };

  // Herramienta «Mover fondo»: arrastrar la imagen de apoyo
  svg.addEventListener("pointerdown", (e) => {
    if (!App.editing || tool !== "bg" || e.button > 0 || !bgImg.getAttribute("href")) return;
    e.stopPropagation(); e.preventDefault();
    const start = toMap(e), o = { x: bgT.x, y: bgT.y };
    const move = (ev) => { const c = toMap(ev); bgT.x = o.x + (c[0] - start[0]); bgT.y = o.y + (c[1] - start[1]); applyBg(); };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      saveBgT();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, true);

  // ---------- Calibración GPS ----------
  const complete = (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon);

  // Acepta "23.7165553, -99.1503599" (formato que copia Google Maps) o separado por espacio
  function parseLatLon(text) {
    const m = String(text).match(/(-?\d+(?:\.\d+)?)\s*°?\s*[,;\s]\s*(-?\d+(?:\.\d+)?)/);
    if (!m) return null;
    let lat = Number(m[1]), lon = Number(m[2]);
    if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) [lat, lon] = [lon, lat];
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }

  function openCalib() {
    const c = App.getCalibration();
    calibPts = c ? c.points.map((p) => ({ ...p })) : [];
    renderCalib();
  }

  function showCalib(on) {
    $("calib-panel").hidden = !on;
    calibLayer.style.display = on ? "" : "none";
    if (on) renderCalib();
  }

  function renderCalibMarks() {
    calibLayer.innerHTML = "";
    if (!App.editing || tool !== "calib") return;
    const kk = k();
    calibPts.forEach((p, i) => {
      const g = el("g", { class: "calib-mark" + (complete(p) ? "" : " pending"), "data-c": i }, calibLayer);
      el("circle", { cx: p.x, cy: p.y, r: 11 / kk }, g);
      el("text", { x: p.x, y: p.y + 4 / kk, "font-size": 12 / kk }, g).textContent = i + 1;
    });
  }

  function renderCalibStatus() {
    const s = $("calib-status");
    const ready = calibPts.filter(complete);
    const pending = calibPts.length - ready.length;
    $("calib-apply").disabled = ready.length < 3;
    const current = App.getCalibration();
    if (ready.length < 3) {
      s.className = "calib-status";
      s.textContent = `${ready.length} de 3 puntos mínimos listos.` + (pending ? ` Faltan coordenadas en ${pending}.` : "") +
        (current ? " (Hay una calibración publicada activa.)" : "");
      return null;
    }
    const fit = App.fitCalibration(ready);
    if (!fit.ok) { s.className = "calib-status bad"; s.textContent = fit.error; return fit; }
    if (ready.length === 3) {
      s.className = "calib-status";
      s.textContent = "Listo para aplicar. Con 3 puntos el ajuste siempre es exacto; agrega un 4.º para medir el error.";
    } else {
      s.className = "calib-status " + (fit.rms <= 5 ? "ok" : fit.rms <= 12 ? "" : "bad");
      s.textContent = `Error promedio ≈ ${fit.rms.toFixed(1)} m` +
        (fit.rms > 12 ? ". Es alto: revisa el punto con más error o que esté bien emparejado." : ".");
    }
    if (pending) s.textContent += ` (${pending} sin coordenadas se ignoran.)`;
    return fit;
  }

  function renderCalib() {
    const list = $("calib-list");
    list.innerHTML = "";
    const fit = renderCalibStatus();
    const ready = calibPts.filter(complete);
    calibPts.forEach((p, i) => {
      const li = document.createElement("li");
      li.className = "calib-item";
      const errIdx = ready.indexOf(p);
      const err = fit && fit.ok && ready.length > 3 && errIdx >= 0 ? fit.residuals[errIdx] : null;
      li.innerHTML = `<span class="calib-num">${i + 1}</span>
        <input type="text" inputmode="decimal" placeholder="lat, lon (ej. 23.71655, -99.15036)" aria-label="Coordenadas del punto ${i + 1}" />
        <button type="button" class="calib-gps" title="Usar mi ubicación actual (debes estar parado en ese punto)">◎</button>
        <button type="button" class="calib-del" title="Quitar punto">✕</button>
        <small class="calib-err">${err === null ? "" : `error ${err.toFixed(1)} m`}</small>`;
      const input = li.querySelector("input");
      if (complete(p)) input.value = `${p.lat}, ${p.lon}`;
      input.addEventListener("change", () => {
        const v = input.value.trim();
        const ll = v ? parseLatLon(v) : { lat: null, lon: null };
        if (!ll) { input.classList.add("invalid"); note("No entendí esas coordenadas. Usa el formato «23.71655, -99.15036»."); return; }
        input.classList.remove("invalid");
        p.lat = ll.lat; p.lon = ll.lon;
        renderCalib(); renderCalibMarks();
      });
      li.querySelector(".calib-gps").onclick = () => useMyPosition(p);
      li.querySelector(".calib-del").onclick = () => { calibPts.splice(i, 1); renderCalib(); renderCalibMarks(); };
      list.appendChild(li);
    });
    renderCalibMarks();
  }

  function useMyPosition(p) {
    if (!window.isSecureContext) { note("El navegador solo da tu ubicación en https o en localhost. Pega las coordenadas de Google Maps.", 6000); return; }
    if (!navigator.geolocation) { note("Este navegador no tiene GPS."); return; }
    note("Leyendo GPS… quédate quieto en el punto.", 4000);
    navigator.geolocation.getCurrentPosition((pos) => {
      p.lat = Number(pos.coords.latitude.toFixed(7));
      p.lon = Number(pos.coords.longitude.toFixed(7));
      renderCalib();
      note(`Ubicación tomada (±${Math.round(pos.coords.accuracy)} m).` + (pos.coords.accuracy > 15 ? " Es poco precisa; mejor usa Google Maps." : ""), 5000);
    }, () => note("No se pudo leer el GPS."), { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  }

  function addCalibPoint(pt) {
    if (calibPts.length >= 50) { note("Máximo 50 puntos."); return; }
    calibPts.push({ x: round(pt[0]), y: round(pt[1]), lat: null, lon: null });
    renderCalib();
    const inputs = $("calib-list").querySelectorAll("input");
    inputs[inputs.length - 1].focus();
  }

  $("calib-apply").onclick = async () => {
    const ready = calibPts.filter(complete);
    const { fit, published } = await App.setCalibration(ready);
    if (!fit.ok) { note(fit.error, 6000); return; }
    renderCalib();
    note(published ? `Calibración publicada para todos (${ready.length} puntos).` : "Calibración aplicada solo en este dispositivo: no hay servidor (python server.py).", 5000);
  };

  $("calib-clear").onclick = async () => {
    if (!confirm("¿Quitar la calibración GPS para todos? Se volverá a la aproximación original.")) return;
    calibPts = [];
    await App.clearCalibration();
    renderCalib();
    note("Calibración quitada.");
  };

  // Arrastrar un punto de control
  svg.addEventListener("pointerdown", (e) => {
    if (!App.editing || tool !== "calib" || e.button > 0) return;
    const mark = e.target.closest("[data-c]");
    if (!mark) return;
    e.stopPropagation(); e.preventDefault();
    const p = calibPts[Number(mark.dataset.c)];
    const start = toMap(e), o = { x: p.x, y: p.y };
    const move = (ev) => { const c = toMap(ev); p.x = round(o.x + c[0] - start[0]); p.y = round(o.y + c[1] - start[1]); renderCalibMarks(); };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      renderCalib();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, true);

  svg.addEventListener("click", (e) => {
    if (!App.editing || tool !== "calib" || e._dragged) return;
    e.stopPropagation();
    if (!e.target.closest("[data-c]")) addCalibPoint(toMap(e));
  }, true);

  $("ed-export").onclick = () => {
    const blob = new Blob([JSON.stringify({ version: 1, places: PLACES }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mapa-facultad.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const validPlace = (p) => p && typeof p.id === "string" && CATEGORIES[p.cat] && typeof p.name === "string" &&
    ((p.kind === "poly" && typeof p.points === "string" && Array.isArray(p.labelPos) && Array.isArray(p.door)) ||
     (p.kind === "pin" && Array.isArray(p.door)) ||
     (p.kind === "zone" && typeof p.points === "string" && p.points.trim().split(/\s+/).length >= 3) ||
     (isLine(p.kind) && typeof p.points === "string" && p.points.trim().split(/\s+/).length >= 2) ||
     (p.kind === "stair" && p.spans && ["p1", "p2"].some((id) => Array.isArray(p.spans[id]) && p.spans[id].length === 2)));

  $("ed-import").onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const list = Array.isArray(data) ? data : data.places;
        if (!Array.isArray(list) || !list.length || !list.every(validPlace)) throw new Error("formato");
        snapshot();
        PLACES.splice(0, PLACES.length, ...list);
        selId = null;
        save(); refresh();
        note(`Mapa importado (${list.length} lugares).`);
      } catch (err) {
        note("El archivo no es un mapa válido.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  $("ed-reset").onclick = async () => {
    if (!confirm("¿Volver al mapa original? Se perderán los cambios para todos los que entren al sitio.")) return;
    if (App.resetMap) await App.resetMap();
    else {
      try { localStorage.removeItem(App.STORE_KEY); } catch (err) { /* nada */ }
    }
    location.reload();
  };

  // ---------- Entrar / salir del modo editor ----------
  function setEditing(on) {
    App.editing = on;
    document.body.classList.toggle("editing", on);
    $("editor-bar").hidden = !on;
    $("editor-toggle").textContent = on ? "✓ Salir del editor" : "✎ Modo editor";
    if (on) {
      if (App.stopHeading) App.stopHeading();
      App.hideInfo();
      undoStack.length = 0; redoStack.length = 0; updateUndo();
      setTool("select");
      App.redraw();
    } else {
      cancelDraft();
      selId = null;
      svg.dataset.tool = "";
      showCalib(false);
      App.redraw();
    }
    bgImg.style.display = on && bgImg.getAttribute("href") ? "" : "none";
    renderHandles();
    fillPanel();
  }
  $("editor-toggle").onclick = () => setEditing(!App.editing);

  applyBg();
  updateUndo();
})();
