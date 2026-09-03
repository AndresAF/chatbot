// parser.js
// Interpreta lo que escribe la recepcionista. A propósito NO usamos un modelo
// de lenguaje libre para ejecutar acciones directo -> el riesgo de que
// cancele/mueva la cita equivocada es alto y cuesta caro en confianza.
// En vez de eso: reconocemos intenciones con patrones flexibles y SIEMPRE
// pedimos confirmación (sí/no) antes de tocar la agenda real.

function limpiar(texto) {
  return texto
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // quita acentos
}

function extraerNombre(texto) {
  // busca lo que sigue a "de" o "a" hasta encontrar una palabra de tiempo/día o el final
  const match = texto.match(/\b(?:de|a)\s+([a-zA-Z0-9\s]+?)(\s+(al|a las|el|para|hoy|manana|mañana|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b|$)/i);
  return match ? match[1].trim() : null;
}

function extraerHora(texto) {
  const match = texto.match(/(\d{1,2})(:\d{2})?\s*(am|pm|hrs|horas)?/i);
  if (!match) return null;
  let hora = match[1];
  const min = match[2] ? match[2] : ":00";
  const suf = match[3] && /pm/i.test(match[3]) ? "pm" : (match[3] && /am/i.test(match[3]) ? "am" : "");
  return `${hora}${min}${suf ? " " + suf : ""}`.trim();
}

function extraerDia(texto) {
  const dias = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo", "hoy", "manana"];
  for (const d of dias) {
    if (texto.includes(d)) return d === "manana" ? "mañana" : d;
  }
  return null;
}

function interpretar(mensajeOriginal) {
  const texto = limpiar(mensajeOriginal);

  if (/cancela|cancelar/.test(texto)) {
    const nombre = extraerNombre(texto);
    return { intent: "CANCELAR", nombre, raw: mensajeOriginal };
  }

  if (/cambia|reagenda|mueve|mover/.test(texto)) {
    const nombre = extraerNombre(texto);
    const dia = extraerDia(texto);
    const hora = extraerHora(texto);
    return { intent: "REAGENDAR", nombre, dia, hora, raw: mensajeOriginal };
  }

  if (/agenda|nueva cita|agendar/.test(texto)) {
    const nombre = extraerNombre(texto);
    const dia = extraerDia(texto);
    const hora = extraerHora(texto);
    return { intent: "AGENDAR", nombre, dia, hora, raw: mensajeOriginal };
  }

  if (/recordatorio|recuerdale|avisa/.test(texto)) {
    const nombre = extraerNombre(texto);
    return { intent: "RECORDATORIO", nombre, raw: mensajeOriginal };
  }

  if (/^si$|^sí$|confirmo|confirmar/.test(texto)) {
    return { intent: "CONFIRMAR", raw: mensajeOriginal };
  }

  if (/^no$|cancela eso|cancelar eso/.test(texto)) {
    return { intent: "RECHAZAR", raw: mensajeOriginal };
  }

  return { intent: "DESCONOCIDO", raw: mensajeOriginal };
}

module.exports = { interpretar };
