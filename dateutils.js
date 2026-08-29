// dateutils.js
// Convierte expresiones en español ("mañana", "lunes", "15 de septiembre")
// a fecha ISO (YYYY-MM-DD), y horas ("5pm", "17:00", "5 de la tarde") a HH:MM 24h.

const DIAS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
  "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function quitarAcentos(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function pad(n) { return String(n).padStart(2, "0"); }

function toISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Interpreta texto en español y devuelve fecha ISO, o null si no reconoce nada.
function parsearFecha(textoOriginal, desde = new Date()) {
  const texto = quitarAcentos(textoOriginal.toLowerCase());

  if (/\bhoy\b/.test(texto)) return toISO(desde);

  if (/\bmanana\b/.test(texto)) {
    const d = new Date(desde);
    d.setDate(d.getDate() + 1);
    return toISO(d);
  }

  // DD/MM o DD-MM (asume año actual, o siguiente si ya pasó)
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

  // "15 de septiembre"
  const matchMes = texto.match(/(\d{1,2})\s*(?:de)?\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/);
  if (matchMes) {
    const dia = parseInt(matchMes[1], 10);
    const mesIdx = MESES.indexOf(matchMes[2]);
    let anio = desde.getFullYear();
    let d = new Date(anio, mesIdx, dia);
    if (d < desde) d.setFullYear(d.getFullYear() + 1);
    return toISO(d);
  }

  // Día de la semana ("lunes", "el viernes", "próximo jueves")
  for (let i = 0; i < DIAS.length; i++) {
    if (texto.includes(DIAS[i])) {
      const d = new Date(desde);
      const hoyDia = d.getDay();
      let diff = (i - hoyDia + 7) % 7;
      if (diff === 0) diff = 7; // si dice "lunes" y hoy es lunes, asume el siguiente
      d.setDate(d.getDate() + diff);
      return toISO(d);
    }
  }

  return null;
}

// Interpreta hora en español/números y devuelve HH:MM (24h), o null.
function parsearHora(textoOriginal) {
  const texto = quitarAcentos(textoOriginal.toLowerCase());
  const match = texto.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/);
  if (!match) return null;

  let h = parseInt(match[1], 10);
  const m = match[2] ? parseInt(match[2], 10) : 0;
  const sufijo = match[3] ? match[3].replace(/\./g, "") : null;

  if (sufijo === "pm" && h < 12) h += 12;
  if (sufijo === "am" && h === 12) h = 0;

  // Heurística: si no dieron am/pm y la hora es entre 1-7, asume tarde (consultorio)
  if (!sufijo && h >= 1 && h <= 7) h += 12;

  if (h > 23 || m > 59) return null;
  return `${pad(h)}:${pad(m)}`;
}

function formatoLegible(fechaISO, hora) {
  const d = new Date(fechaISO + "T00:00:00");
  const diaNombre = DIAS[d.getDay()];
  const diaCap = diaNombre.charAt(0).toUpperCase() + diaNombre.slice(1);
  const base = `${diaCap} ${d.getDate()} de ${MESES[d.getMonth()]}`;
  return hora ? `${base}, ${hora}` : base;
}

module.exports = { parsearFecha, parsearHora, formatoLegible, toISO };
