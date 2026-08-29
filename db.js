// db.js
// Base de datos persistente (SQLite) + lógica de horarios/disponibilidad.
// Reemplaza al citas.js en memoria del prototipo anterior.

const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(process.env.DB_PATH || path.join(__dirname, "consultorio.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS citas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paciente TEXT NOT NULL,
    telefono TEXT NOT NULL,
    fecha TEXT NOT NULL,        -- YYYY-MM-DD
    hora TEXT NOT NULL,         -- HH:MM (24h)
    estado TEXT NOT NULL DEFAULT 'confirmada', -- confirmada | cancelada
    recordatorio_enviado INTEGER NOT NULL DEFAULT 0,
    creada_en TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS horario_config (
    dia_semana INTEGER PRIMARY KEY, -- 0=domingo ... 6=sabado
    activo INTEGER NOT NULL DEFAULT 0,
    hora_inicio TEXT,   -- HH:MM
    hora_fin TEXT,      -- HH:MM
    duracion_slot INTEGER NOT NULL DEFAULT 30 -- minutos
  );
`);

// Configuración default: Lunes a Viernes 9:00-18:00, sábado 9:00-14:00, slots de 30 min.
// El consultorio la puede cambiar después (endpoint /api/horario).
const config = db.prepare("SELECT COUNT(*) as n FROM horario_config").get();
if (config.n === 0) {
  const insert = db.prepare(`INSERT INTO horario_config
    (dia_semana, activo, hora_inicio, hora_fin, duracion_slot) VALUES (?, ?, ?, ?, ?)`);
  const defaults = [
    [0, 0, null, null, 30],       // domingo cerrado
    [1, 1, "09:00", "18:00", 30], // lunes
    [2, 1, "09:00", "18:00", 30],
    [3, 1, "09:00", "18:00", 30],
    [4, 1, "09:00", "18:00", 30],
    [5, 1, "09:00", "18:00", 30], // viernes
    [6, 1, "09:00", "14:00", 30], // sabado
  ];
  const tx = db.transaction(rows => rows.forEach(r => insert.run(...r)));
  tx(defaults);
}

// ---------- Citas ----------

function listarCitas() {
  return db.prepare("SELECT * FROM citas ORDER BY fecha, hora").all();
}

function listarActivas() {
  return db.prepare("SELECT * FROM citas WHERE estado = 'confirmada' ORDER BY fecha, hora").all();
}

function normalizar(s) {
  return s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function buscarPorNombre(nombreParcial) {
  const q = `%${normalizar(nombreParcial)}%`;
  return db.prepare(`
    SELECT * FROM citas
    WHERE lower(replace(replace(replace(replace(paciente,'é','e'),'á','a'),'í','i'),'ó','o')) LIKE ?
    ORDER BY fecha, hora
  `).all(q.replace(/é/g, "e").replace(/á/g, "a").replace(/í/g, "i").replace(/ó/g, "o"));
}

function obtenerCita(id) {
  return db.prepare("SELECT * FROM citas WHERE id = ?").get(id);
}

function cancelarCita(id) {
  db.prepare("UPDATE citas SET estado = 'cancelada' WHERE id = ?").run(id);
  return obtenerCita(id);
}

function reagendarCita(id, fecha, hora) {
  db.prepare("UPDATE citas SET fecha = ?, hora = ?, estado = 'confirmada', recordatorio_enviado = 0 WHERE id = ?")
    .run(fecha, hora, id);
  return obtenerCita(id);
}

function crearCita({ paciente, telefono, fecha, hora }) {
  const info = db.prepare(`
    INSERT INTO citas (paciente, telefono, fecha, hora) VALUES (?, ?, ?, ?)
  `).run(paciente, telefono, fecha, hora);
  return obtenerCita(info.lastInsertRowid);
}

function marcarRecordatorioEnviado(id) {
  db.prepare("UPDATE citas SET recordatorio_enviado = 1 WHERE id = ?").run(id);
}

// ---------- Horarios / disponibilidad ----------

function getConfigDia(diaSemana) {
  return db.prepare("SELECT * FROM horario_config WHERE dia_semana = ?").get(diaSemana);
}

function actualizarConfigDia(diaSemana, { activo, hora_inicio, hora_fin, duracion_slot }) {
  db.prepare(`
    UPDATE horario_config SET activo = ?, hora_inicio = ?, hora_fin = ?, duracion_slot = ?
    WHERE dia_semana = ?
  `).run(activo ? 1 : 0, hora_inicio, hora_fin, duracion_slot || 30, diaSemana);
  return getConfigDia(diaSemana);
}

function listarConfigHorario() {
  return db.prepare("SELECT * FROM horario_config ORDER BY dia_semana").all();
}

// Genera los slots teóricos de un día (HH:MM) según su configuración
function slotsDelDia(fechaISO) {
  const fecha = new Date(fechaISO + "T00:00:00");
  const diaSemana = fecha.getDay();
  const cfg = getConfigDia(diaSemana);
  if (!cfg || !cfg.activo) return [];

  const slots = [];
  let [h, m] = cfg.hora_inicio.split(":").map(Number);
  const [hf, mf] = cfg.hora_fin.split(":").map(Number);
  const finMin = hf * 60 + mf;
  let actualMin = h * 60 + m;

  while (actualMin < finMin) {
    const hh = String(Math.floor(actualMin / 60)).padStart(2, "0");
    const mm = String(actualMin % 60).padStart(2, "0");
    slots.push(`${hh}:${mm}`);
    actualMin += cfg.duracion_slot;
  }
  return slots;
}

// Slots disponibles = slots teóricos - slots ya ocupados (citas confirmadas)
// - ya pasados (si la fecha consultada es hoy)
function disponibilidad(fechaISO) {
  const todos = slotsDelDia(fechaISO);
  if (todos.length === 0) return { abierto: false, slots: [] };

  const ocupadas = db.prepare(`
    SELECT hora FROM citas WHERE fecha = ? AND estado = 'confirmada'
  `).all(fechaISO).map(r => r.hora);

  let libres = todos.filter(s => !ocupadas.includes(s));

  const ahora = new Date();
  const hoyISO = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, "0")}-${String(ahora.getDate()).padStart(2, "0")}`;
  if (fechaISO === hoyISO) {
    const minAhora = ahora.getHours() * 60 + ahora.getMinutes();
    libres = libres.filter(s => {
      const [h, m] = s.split(":").map(Number);
      return h * 60 + m > minAhora;
    });
  }

  return { abierto: true, slots: libres };
}

function horaEstaDisponible(fechaISO, hora) {
  const { abierto, slots } = disponibilidad(fechaISO);
  return abierto && slots.includes(hora);
}

// Próximos N días con al menos un slot libre (útil para sugerirle al paciente)
function proximosDiasConDisponibilidad(n = 5, desde = new Date()) {
  const resultado = [];
  let cursor = new Date(desde);
  let intentos = 0;
  while (resultado.length < n && intentos < 30) {
    const iso = cursor.toISOString().slice(0, 10);
    const { abierto, slots } = disponibilidad(iso);
    if (abierto && slots.length > 0) {
      resultado.push({ fecha: iso, slots });
    }
    cursor.setDate(cursor.getDate() + 1);
    intentos++;
  }
  return resultado;
}

// Citas que ya deben recibir recordatorio (ej. mañana, y aún no se les mandó)
function citasParaRecordatorio(horasAntes = 24) {
  const limite = new Date(Date.now() + horasAntes * 60 * 60 * 1000);
  return listarActivas().filter(c => {
    if (c.recordatorio_enviado) return false;
    const citaDT = new Date(`${c.fecha}T${c.hora}:00`);
    return citaDT <= limite && citaDT > new Date();
  });
}

module.exports = {
  listarCitas, listarActivas, buscarPorNombre, obtenerCita,
  cancelarCita, reagendarCita, crearCita, marcarRecordatorioEnviado,
  getConfigDia, actualizarConfigDia, listarConfigHorario,
  disponibilidad, horaEstaDisponible, proximosDiasConDisponibilidad,
  citasParaRecordatorio,
};
