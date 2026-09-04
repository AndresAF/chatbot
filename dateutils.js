// dateutils.js
// Convierte expresiones en español ("mañana", "lunes", "15 de septiembre")
// a fecha ISO (YYYY-MM-DD), y horas ("5pm", "17:00", "5 de la tarde") a HH:MM 24h.
//
// La interpretación real la hace Claude (para manejar frases variadas y
// correcciones del usuario sin reglas rígidas). Las funciones *Regex de
// abajo quedan como respaldo determinista si la llamada a la API falla.

const Anthropic = require("@anthropic-ai/sdk");
const anthropic = new Anthropic();

const DIAS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
  "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function quitarAcentos(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function pad(n) { return String(n).padStart(2, "0"); }

function toISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ==================== Respaldo determinista (regex) ====================
// Se usa SOLO si la llamada a Claude falla (red caída, error de API, etc.)

function parsearFechaRegex(textoOriginal, desde = new Date()) {
  const texto = quitarAcentos(textoOriginal.toLowerCase());

  if (/\bhoy\b/.test(texto)) return toISO(desde);

  if (/\bmanana\b/.test(texto)) {
    const d = new Date(desde);
    d.setDate(d.getDate() + 1);
    return toISO(d);
  }

  const matchNum = texto.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (matchNum) {
    const dia = parseInt(matchNum[1], 10);
    const mes = parseInt(matchNum[2], 10);
    let anio = matchNum[3] ? parseInt(matchNum[3], 10) : desde.getFullYear();
    if (anio < 100) anio += 2000;
    let d = new Date(anio, mes - 1, dia);
    if (d < desde && !matchNum[3]) d.setFullYear(d.getFullYear() + 1);
    return toISO(d);
  }

  const matchMes = texto.match(/(\d{1,2})\s*(?:de)?\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/);
  if (matchMes) {
    const dia = parseInt(matchMes[1], 10);
    const mesIdx = MESES.indexOf(matchMes[2]);
    let anio = desde.getFullYear();
    let d = new Date(anio, mesIdx, dia);
    if (d < desde) d.setFullYear(d.getFullYear() + 1);
    return toISO(d);
  }

  for (let i = 0; i < DIAS.length; i++) {
    if (texto.includes(DIAS[i])) {
      const d = new Date(desde);
      const hoyDia = d.getDay();
      let diff = (i - hoyDia + 7) % 7;
      if (diff === 0) diff = 7;
      d.setDate(d.getDate() + diff);
      return toISO(d);
    }
  }

  return null;
}

function parsearHoraRegex(textoOriginal) {
  const texto = quitarAcentos(textoOriginal.toLowerCase());
  const match = texto.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/);
  if (!match) return null;

  let h = parseInt(match[1], 10);
  const m = match[2] ? parseInt(match[2], 10) : 0;
  const sufijo = match[3] ? match[3].replace(/\./g, "") : null;

  if (sufijo === "pm" && h < 12) h += 12;
  if (sufijo === "am" && h === 12) h = 0;
  if (!sufijo && h >= 1 && h <= 7) h += 12;

  if (h > 23 || m > 59) return null;
  return `${pad(h)}:${pad(m)}`;
}

// ==================== Interpretación con Claude ====================

async function parsearFecha(textoOriginal, desde = new Date()) {
  const hoyISO = toISO(desde);
  const diaSemanaHoy = DIAS[desde.getDay()];

  try {
    const respuesta = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 512,
      tools: [{
        name: "reportar_fecha",
        description: "Reporta la fecha exacta que el usuario quiso decir para agendar una cita.",
        input_schema: {
          type: "object",
          properties: {
            es_una_fecha: {
              type: "boolean",
              description: "true SOLO si el mensaje completo es el cliente indicando la fecha que quiere para su cita. Si es una pregunta, una corrección ('dije...', 'no, me refería a...'), una queja, o menciona cualquier otra cosa en vez de (o además de) responder con una fecha, esto debe ser false — aunque el mensaje contenga números o nombres de días."
            },
            fecha_iso: {
              type: ["string", "null"],
              description: "Fecha en formato YYYY-MM-DD. Solo se llena si es_una_fecha es true Y la fecha se pudo determinar sin ambigüedad. Si es_una_fecha es false, o hay una contradicción (ej. el día de la semana mencionado no corresponde al número de día mencionado), esto debe ser null."
            }
          },
          required: ["es_una_fecha", "fecha_iso"],
          additionalProperties: false
        },
        strict: true
      }],
      tool_choice: { type: "tool", name: "reportar_fecha" },
      messages: [{
        role: "user",
        content: `Hoy es ${diaSemanaHoy} ${hoyISO}. Le preguntamos a un cliente en qué día quiere una cita, y respondió: "${textoOriginal}".

Primero decide si ese mensaje es realmente el cliente dándote una fecha (es_una_fecha), o si es otra cosa (una pregunta, una corrección tipo "dije...", una queja, texto no relacionado) — en ese segundo caso es_una_fecha es false y fecha_iso null, sin importar si el mensaje contiene números o nombres de días sueltos.

Si sí es una fecha, determina fecha_iso (YYYY-MM-DD):
- Si menciona un día de la semana Y un número de día del mes juntos (ej. "viernes 4"), ambos deben coincidir con la misma fecha real; si no coinciden, o es ambiguo, fecha_iso debe ser null.
- Si solo da un día de la semana, usa la próxima ocurrencia de ese día a partir de hoy (si hoy mismo es ese día, usa el de la próxima semana).`
      }]
    });

    const bloque = respuesta.content.find(b => b.type === "tool_use");
    if (bloque && bloque.input.es_una_fecha && bloque.input.fecha_iso) {
      return bloque.input.fecha_iso;
    }
    return null;
  } catch (err) {
    console.error("Error interpretando fecha con Claude, usando respaldo:", err.message);
    return parsearFechaRegex(textoOriginal, desde);
  }
}

async function parsearHora(textoOriginal) {
  try {
    const respuesta = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 512,
      tools: [{
        name: "reportar_hora",
        description: "Reporta la hora exacta que el usuario quiso decir para su cita.",
        input_schema: {
          type: "object",
          properties: {
            es_una_hora: {
              type: "boolean",
              description: "true SOLO si el mensaje completo es el cliente indicando la hora que quiere para su cita. Si es una pregunta, una corrección ('dije...', 'no, me refería a...'), una queja, o menciona cualquier otra cosa en vez de (o además de) responder con una hora, esto debe ser false — aunque el mensaje contenga números."
            },
            hora_24h: {
              type: ["string", "null"],
              description: "Hora en formato HH:MM de 24 horas. Solo se llena si es_una_hora es true. Si es_una_hora es false, esto debe ser null."
            }
          },
          required: ["es_una_hora", "hora_24h"],
          additionalProperties: false
        },
        strict: true
      }],
      tool_choice: { type: "tool", name: "reportar_hora" },
      messages: [{
        role: "user",
        content: `Le preguntamos a un cliente a qué hora quiere su cita, y respondió: "${textoOriginal}".

Primero decide si ese mensaje es realmente el cliente dándote una hora (es_una_hora), o si es otra cosa (una pregunta, una corrección tipo "dije...", una queja, texto no relacionado) — en ese segundo caso es_una_hora es false y hora_24h null, sin importar si el mensaje contiene números sueltos.

Si sí es una hora, determina hora_24h (HH:MM). Si no dio am/pm y es ambigua entre mañana/tarde, asume horario de negocio (tarde, ej. "4" -> "16:00").`
      }]
    });

    const bloque = respuesta.content.find(b => b.type === "tool_use");
    if (bloque && bloque.input.es_una_hora && bloque.input.hora_24h) {
      return bloque.input.hora_24h;
    }
    return null;
  } catch (err) {
    console.error("Error interpretando hora con Claude, usando respaldo:", err.message);
    return parsearHoraRegex(textoOriginal);
  }
}

function formatoLegible(fechaISO, hora) {
  const d = new Date(fechaISO + "T00:00:00");
  const diaNombre = DIAS[d.getDay()];
  const diaCap = diaNombre.charAt(0).toUpperCase() + diaNombre.slice(1);
  const base = `${diaCap} ${d.getDate()} de ${MESES[d.getMonth()]}`;
  return hora ? `${base}, ${hora}` : base;
}

module.exports = { parsearFecha, parsearHora, formatoLegible, toISO };
