// nucleo.js
// Capa 2 de FLUJO_CONVERSACIONAL.md: máquina de estados + validador +
// resolución de fecha/hora contra lo que ya se ofreció. Puramente
// determinista — sin llamadas a Claude ni a la base de datos — para poder
// probarse sola (ver test/nucleo.test.js).
//
// Nota de adaptación: se omite `service_id` de REQUIRED — este negocio no
// tiene catálogo de servicios (ver FLUJO_CONVERSACIONAL.md).

const REQUIRED = {
  ASK_DATE: [],
  ASK_TIME: ["date"],
  ASK_NAME: ["date", "time"],
  CONFIRM: ["date", "time", "name"],
};

function canEnter(state, slots) {
  const req = REQUIRED[state];
  if (!req) return true;
  return req.every(k => slots[k] !== null && slots[k] !== undefined);
}

function firstMissingState(slots) {
  if (slots.date == null) return "ASK_DATE";
  if (slots.time == null) return "ASK_TIME";
  if (slots.name == null) return "ASK_NAME";
  return "CONFIRM";
}

const CORRECTION_MARKERS = /\b(dije|ya dije|no,|m[aá]s bien|mas bien|era|no es|te dije|repito)\b/i;

function esCorreccion(extracted, textoOriginal) {
  if (extracted && extracted.intent === "correct") return true;
  return CORRECTION_MARKERS.test(textoOriginal || "");
}

function normalizar(s) {
  return s.toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Nota: se normaliza (quita acentos/mayúsculas) ANTES de comparar en vez de
// incluir tildes en el propio patrón — un acento escrito literal en el
// código puede quedar en una forma Unicode (compuesta vs. combinante) que
// no calza byte a byte con lo que escribe el usuario.
function esConfirmacion(textoOriginal) {
  return /^(si|confirmo|correcto|va|dale|ok|okay|de acuerdo|👍)\b/.test(normalizar(textoOriginal || ""));
}

function esRechazo(textoOriginal) {
  return /^no\b/.test(normalizar(textoOriginal || ""));
}

// Resuelve la respuesta del cliente contra las opciones YA ofrecidas — nunca
// vuelve a interpretar una fecha/hora libremente si hay una lista sobre la
// mesa. Devuelve el `value` (fecha ISO u hora 24h) o null si no coincide.
function resolveFromOffered(extracted, offered) {
  if (!offered || !offered.options || !offered.options.length) return null;

  if (extracted && extracted.option_id != null) {
    const hit = offered.options.find(o => o.id === extracted.option_id);
    if (hit) return hit.value;
  }

  const raw = (extracted && extracted.raw_value) || "";
  const msg = normalizar(raw);
  if (!msg) return null;

  // Coincidencia por número de día del mes (fechas: "viernes 4", "el 4", "4")
  const dayNum = msg.match(/\b(\d{1,2})\b/)?.[1];
  if (dayNum) {
    const hit = offered.options.find(o => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(o.value)) return false;
      const d = new Date(o.value + "T12:00:00");
      return String(d.getDate()) === dayNum;
    });
    if (hit) return hit.value;
  }

  // Coincidencia por hora exacta (horas: "10:30", "1030", "10.30")
  const horaNum = msg.match(/\b(\d{1,2})[:.]?(\d{2})\b/);
  if (horaNum) {
    const candidato = `${horaNum[1].padStart(2, "0")}:${horaNum[2]}`;
    const hit = offered.options.find(o => o.value === candidato);
    if (hit) return hit.value;
  }

  // Coincidencia por etiqueta contenida en el mensaje (o viceversa)
  const hitLabel = offered.options.find(o => {
    const label = normalizar(o.label);
    return label && (label.includes(msg) || msg.includes(label));
  });
  if (hitLabel) return hitLabel.value;

  // Coincidencia por nombre de día de la semana suelto ("mejor el sábado")
  const DIAS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
  const diaIdx = DIAS.findIndex(d => new RegExp(`\\b${d}\\b`).test(msg));
  if (diaIdx !== -1) {
    const hitDia = offered.options.find(o => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(o.value)) return false;
      const d = new Date(o.value + "T12:00:00");
      return d.getDay() === diaIdx;
    });
    if (hitDia) return hitDia.value;
  }

  return null;
}

// disponibilidad = { abierto, slots } ya obtenido de db.disponibilidad(fechaISO)
function validarFecha(fechaISO, disponibilidad, hoyISO) {
  if (fechaISO == null) return { verdict: "CLARIFY", reason: "no_match" };
  if (fechaISO < hoyISO) return { verdict: "REJECT", reason: "past" };
  if (!disponibilidad.abierto) return { verdict: "CLARIFY", reason: "closed" };
  if (disponibilidad.slots.length === 0) return { verdict: "CLARIFY", reason: "full" };
  return { verdict: "ACCEPT", value: fechaISO };
}

// disponible = boolean ya obtenido de db.horaEstaDisponible(fechaISO, hora)
function validarHora(hora, disponible) {
  if (hora == null) return { verdict: "CLARIFY", reason: "no_match" };
  if (!disponible) return { verdict: "CLARIFY", reason: "full" };
  return { verdict: "ACCEPT", value: hora };
}

function validarNombre(nombre) {
  const limpio = (nombre || "").trim();
  if (limpio.length < 2 || limpio.length > 60) return { verdict: "CLARIFY", reason: "invalid_length" };
  return { verdict: "ACCEPT", value: limpio };
}

module.exports = {
  REQUIRED, canEnter, firstMissingState,
  esCorreccion, esConfirmacion, esRechazo,
  resolveFromOffered, validarFecha, validarHora, validarNombre,
  normalizar,
};
