// Datos provisionales basados en la captura de Google Maps (FCAV - UAT, Cd. Victoria).
// Coordenadas en el sistema del croquis (viewBox 1024 x 580). Se irán detallando.
const CATEGORIES = {
  edificio:       { label: "Edificios",       color: "#f7801e" },
  servicio:       { label: "Servicios",       color: "#1f6fe0" },
  estacionamiento:{ label: "Estacionamientos", color: "#2aa876" },
  aula:           { label: "Aulas y salones", color: "#8e44ad" },
  escalera:       { label: "Escaleras",       color: "#0f9d9a" },
  // Los pasillos se dibujan en el mapa pero no aparecen en la lista ni en el buscador
  pasillo:        { label: "Pasillos",        color: "#8a96ab", listed: false },
  // Los muros solo separan espacios: no son un lugar al que se pueda ir
  muro:           { label: "Muros",           color: "#4a5568", listed: false },
  // Las líneas de ruta arman el camino; no son un lugar de la lista
  ruta:           { label: "Rutas",           color: "#1f6fe0", listed: false },
  // El área por donde se puede caminar. «Cómo llegar» busca el camino más corto dentro de ella.
  zona:           { label: "Zonas caminables", color: "#1f6fe0", listed: false }
};

// Capas del mapa. "ext" es la vista aérea (exterior); las demás son plantas de los edificios.
// Un lugar sin campo "floor" pertenece a la vista aérea.
const FLOORS = [
  { id: "ext", label: "Vista aérea" },
  { id: "p1",  label: "Planta 1" },
  { id: "p2",  label: "Planta 2" }
];

// Calibración GPS -> croquis. Tomada de la captura de Google Maps (@23.7165553,-99.1503599, escala 20 m ≈ 55 px).
// El punto (x0, y0) del croquis corresponde a (lat0, lon0). Se puede afinar con coordenadas reales de la facultad.
const GEO = { lat0: 23.7165553, lon0: -99.1503599, x0: 512, y0: 292, mPerPx: 0.36 };

// Puntos de referencia del croquis. Ya no forman un camino: «Cómo llegar»
// solo usa las zonas y las líneas de ruta trazadas en el editor.
// Uin es la entrada que se muestra en el mapa.
const NODES = {
  Uin:  [212, 330],  // Calle Universidad (interior) a la altura de la facultad
  Utop: [232, 70],
  Ubot: [190, 530],
  Lt:   [152, 70],
  L1:   [124, 330],
  Lb:   [92, 532],
  Bl:   [125, 536],
  Bc:   [290, 532],
  Bm:   [640, 532],
  BR:   [918, 528],
  Re:   [917, 470],
  R1:   [908, 300],
  RR:   [850, 200],
  T1:   [700, 118],
  Tb:   [650, 105],
  T2:   [400, 76],
  Cz:   [300, 345]
};

// Entrada que se muestra en el croquis (se ajustará cuando sepamos el acceso real)
const ENTRANCE = { name: "Entrada (provisional)", link: "Uin" };

const PLACES = [
  { id: "facultad", name: "Facultad de Comercio y Administración Victoria", label: "Facultad de Comercio\ny Administración Victoria",
    cat: "edificio", kind: "poly",
    points: "335,210 370,195 550,210 550,285 600,310 605,440 520,432 340,415 315,352 282,335 292,262 335,262",
    labelPos: [440, 300], door: [286, 318], link: "Uin",
    desc: "Edificio principal de la facultad. Aquí se detallarán sus alas, aulas y oficinas.",
    hours: "Por definir", includes: "Por definir" },
  { id: "edificio-b", name: "Edificio B", label: "B", cat: "edificio", kind: "poly",
    points: "600,203 700,210 695,335 590,305", labelPos: [645, 265], door: [648, 205], link: "Tb",
    desc: "Edificio al noreste de la facultad (nombre real por confirmar).", hours: "Por definir", includes: "Por definir" },
  { id: "edificio-c", name: "Edificio C", label: "C", cat: "edificio", kind: "poly",
    points: "738,222 827,235 848,318 815,320 805,400 720,390", labelPos: [780, 300], door: [833, 232], link: "RR",
    desc: "Edificio al este (nombre real por confirmar).", hours: "Por definir", includes: "Por definir" },
  { id: "edificio-d", name: "Edificio D", label: "D", cat: "edificio", kind: "poly",
    points: "560,440 725,455 715,505 562,480", labelPos: [640, 470], door: [640, 506], link: "Bm",
    desc: "Edificio al sur (nombre real por confirmar).", hours: "Por definir", includes: "Por definir" },
  { id: "edificio-e", name: "Edificio E", label: "E", cat: "edificio", kind: "poly",
    points: "790,415 845,425 848,500 795,490", labelPos: [820, 460], door: [848, 465], link: "Re",
    desc: "Edificios pequeños al sureste (por confirmar).", hours: "Por definir", includes: "Por definir" },
  { id: "banco", name: "Banco Santander Universidades", label: "Banco Santander\nUniversidades", cat: "servicio", kind: "poly",
    points: "265,95 495,120 495,168 265,125", labelPos: [380, 128], door: [380, 106], link: "T2",
    desc: "Sucursal bancaria universitaria.", hours: "Por definir", includes: "Cajero, Atención a estudiantes" },
  { id: "cachito", name: "Corazón Un Cachito de Luz FCAV", label: "Corazón Un\nCachito de Luz", cat: "servicio", kind: "pin",
    door: [313, 347], link: "Cz", labelOffset: [18, 4],
    desc: "Punto de apoyo ubicado junto a la facultad.", hours: "Por definir", includes: "Por definir" },
  { id: "biblioteca", name: "Biblioteca Central", label: "Biblioteca Central", cat: "servicio", kind: "pin",
    door: [125, 558], link: "Bl", labelOffset: [18, -2],
    desc: "Biblioteca Central, al sur de Calle Universidad.", hours: "Por definir", includes: "Por definir" },
  { id: "est-oeste", name: "Estacionamiento Oeste", label: "Estacionamiento\nOeste", cat: "estacionamiento", kind: "pin",
    door: [45, 215], link: "L1", labelOffset: [18, 4],
    desc: "Estacionamiento sobre la calle Universidad.", hours: "Por definir", includes: "Por definir" },
  { id: "est-este", name: "Estacionamiento Este", label: "Estacionamiento\nEste", cat: "estacionamiento", kind: "pin",
    door: [848, 163], link: "RR", labelOffset: [-18, -14], anchor: "end",
    desc: "Estacionamiento en la zona noreste.", hours: "Por definir", includes: "Por definir" }
];

// Edificios de contexto (decorativos, no interactivos)
const BG_BUILDINGS = [
  "522,115 625,148 625,178 522,170",
  "630,150 660,155 658,180 630,178",
  "770,88 880,115 880,132 770,105",
  "885,120 935,130 935,148 885,140",
  "875,175 930,185 925,200 875,195",
  "960,90 1024,100 1024,150 960,140"
];
