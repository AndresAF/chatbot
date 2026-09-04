// pacienteFlow.js
// Orquestación del flujo del cliente (ver FLUJO_CONVERSACIONAL.md):
// filtro de contenido -> extractor (LLM) -> núcleo (determinista) -> DB.
// La sesión vive en SQLite (tabla `sessions`), sobrevive a reinicios/redeploys.

const db = require("./db");
const { formatoLegible, toISO } = require("./dateutils");
const { esMensajeInapropiado } = require("./iaChat");
const { extraer } = require("./extractor");
const nucleo = require("./nucleo");

const SESION_EXPIRA_MS = 24 * 60 * 60 * 1000; // 24h de silencio -> se reinicia
const TIMEZONE = "America/Mexico_City";

const SLOT_PEDIDO = {
  ASK_DATE: "la fecha de la cita",
  ASK_TIME: "la hora de la cita",
  ASK_NAME: "el nombre para la cita",
  CONFIRM: "confirmación (sí/no) de los datos que ya se le mostraron",
};

// ---------- Construcción de ofertas (listas con ids) ----------

function construirOfertaFechas(desde) {
  const dias = db.proximosDiasConDisponibilidad(3, desde);
  const options = dias.map((d, i) => ({ id: i + 1, label: formatoLegible(d.fecha, ""), value: d.fecha }));
  return { kind: "dates", generated_at: new Date().toISOString(), options };
}

function construirOfertaHoras(fechaISO) {
  const { slots } = db.disponibilidad(fechaISO);
  const manana = slots.filter(s => parseInt(s.split(":")[0], 10) < 13);
  const tarde = slots.filter(s => parseInt(s.split(":")[0], 10) >= 13);
  const muestrear = (arr, n) => {
    if (arr.length <= n) return arr;
    const paso = arr.length / n;
    return Array.from({ length: n }, (_, i) => arr[Math.floor(i * paso)]);
  };
  const elegidos = [...muestrear(manana, 3), ...muestrear(tarde, 3)];
  const finalSlots = elegidos.length ? elegidos : slots.slice(0, 6);
  const options = finalSlots.map((s, i) => ({ id: i + 1, label: s, value: s }));
  return { kind: "times", generated_at: new Date().toISOString(), options, todos: slots };
}

// ---------- Mensajes (plantilla — nunca los redacta el LLM) ----------

function mensajeFechas(offered) {
  const lineas = offered.options.map(o => `${o.id}) ${o.label}`);
  return `¿Qué día te gustaría venir?\n${lineas.join("\n")}`;
}

function mensajeHoras(fechaISO, offered) {
  const lineas = offered.options.map(o => `${o.id}) ${o.value}`);
  return `Para ${formatoLegible(fechaISO, "")} tengo:\n${lineas.join("  ")}\n\n¿Cuál te acomoda? (o dime otra hora si prefieres)`;
}

function mensajeNombre() {
  return "¿A nombre de quién agendamos la cita?";
}

function mensajeConfirmacion(slots) {
  return `Te confirmo:\n📅 ${formatoLegible(slots.date, slots.time)}\n👤 ${slots.name}\n\n¿Está bien? Responde SÍ para confirmar.`;
}

function preguntaPendiente(state, session) {
  if (state === "ASK_DATE") return mensajeFechas(session.offered);
  if (state === "ASK_TIME") return mensajeHoras(session.slots.date, session.offered);
  if (state === "ASK_NAME") return mensajeNombre();
  if (state === "CONFIRM") return mensajeConfirmacion(session.slots);
  return "¿Seguimos con tu cita? Escribe \"cita\" si quieres empezar.";
}

// ---------- Sesión ----------

function sesionFresca(phone) {
  return {
    phone,
    state: "ASK_DATE",
    slots: { date: null, time: null, name: null },
    offered: null,
    attempts: 0,
    last_message_at: new Date().toISOString(),
    locale: "es-MX",
    timezone: TIMEZONE,
  };
}

function cargarSesion(phone) {
  const s = db.getSession(phone);
  if (!s) return null;
  const ultima = s.last_message_at ? new Date(s.last_message_at).getTime() : 0;
  if (Date.now() - ultima > SESION_EXPIRA_MS) {
    db.eliminarSession(phone);
    return null;
  }
  return s;
}

function guardar(session) {
  session.last_message_at = new Date().toISOString();
  db.saveSession(session);
}

// ---------- Orquestación principal ----------

async function manejarMensajePaciente(from, textoOriginal) {
  const texto = (textoOriginal || "").trim();

  if (esMensajeInapropiado(texto)) {
    return "Por favor mantengamos la conversación enfocada en agendar tu cita. Escribe \"cita\" cuando quieras continuar.";
  }

  let session = cargarSesion(from);

  // --- Sin sesión: arranque de conversación ---
  if (!session) {
    const extracted = await extraer({
      mensaje: texto,
      estado: "GREET",
      slotPedido: "si quiere agendar una cita",
      offered: null,
      ahora: new Date(),
      timezone: TIMEZONE,
    });

    const quiereAgendar = extracted
      ? !["greet", "cancel", "ask_question"].includes(extracted.intent)
      : /cita|agendar|agénda|reservar|consulta|quiero/i.test(texto);

    if (!quiereAgendar) {
      if (extracted && extracted.intent === "ask_question") {
        return "No tengo esa información a la mano ahorita, pero con gusto te ayudo a ver los horarios disponibles — escribe \"cita\" cuando quieras.";
      }
      if (extracted && extracted.intent === "cancel") {
        return "Sin problema. Escribe \"cita\" cuando quieras agendar.";
      }
      return "¡Hola! ¿En qué te puedo ayudar? Si quieres agendar una cita, dime \"cita\" y con gusto te ayudo a encontrar un horario.";
    }

    const nueva = sesionFresca(from);
    const offered = construirOfertaFechas(new Date());
    if (offered.options.length === 0) {
      return "Por ahora no tenemos horarios disponibles próximamente. En breve nos pondremos en contacto contigo.";
    }
    nueva.offered = offered;
    guardar(nueva);
    return `¡Hola! Con gusto te agendamos.\n\n${mensajeFechas(offered)}`;
  }

  // --- Con sesión activa ---
  if (session.state === "HANDOFF") {
    return null; // el bot ya avisó y calla; un humano sigue desde aquí
  }

  const extracted = await extraer({
    mensaje: texto,
    estado: session.state,
    slotPedido: SLOT_PEDIDO[session.state] || session.state,
    offered: session.offered,
    ahora: new Date(),
    timezone: session.timezone,
  });

  // Cancelación en cualquier estado
  const quiereCancelar = extracted ? extracted.intent === "cancel" : /^(cancelar|ya no|olv[ií]dalo|d[eé]jalo)\b/i.test(texto);
  if (quiereCancelar) {
    db.eliminarSession(from);
    return "Sin problema, cancelé el proceso. Escribe \"cita\" cuando quieras intentarlo de nuevo.";
  }

  // Pregunta fuera de flujo: se responde y se repite lo pendiente, sin perder el estado
  if (extracted && extracted.intent === "ask_question" && session.state !== "CONFIRM") {
    guardar(session);
    return `No tengo esa información a la mano ahorita.\n\n${preguntaPendiente(session.state, session)}`;
  }

  // Corrección: solo tiene sentido en estados donde ya hay una fecha/hora
  // previa que se pudiera estar corrigiendo. En ASK_DATE no hay nada previo
  // que corregir, y en ASK_NAME el texto siempre se toma tal cual como
  // nombre (si alguien se llama o escribe algo con "corrección" en medio,
  // no queremos que se confunda con el detector).
  if ((session.state === "ASK_TIME" || session.state === "CONFIRM") && nucleo.esCorreccion(extracted, texto)) {
    return manejarCorreccion(session, extracted, texto);
  }

  if (session.state === "ASK_DATE") return manejarAskDate(session, extracted, texto);
  if (session.state === "ASK_TIME") return manejarAskTime(session, extracted, texto);
  if (session.state === "ASK_NAME") return manejarAskName(session, extracted, texto);
  if (session.state === "CONFIRM") return manejarConfirm(session, extracted, texto);

  // Estado desconocido: reinicia con seguridad
  db.eliminarSession(from);
  return "Vamos a empezar de nuevo. Escribe \"cita\" si quieres agendar.";
}

function registrarIntento(session, verdict) {
  session.attempts = verdict === "ACCEPT" ? 0 : (session.attempts || 0) + 1;
}

function manejarHandoffSiAplica(session) {
  if (session.attempts >= 3) {
    session.state = "HANDOFF";
    guardar(session);
    return "Creo que no nos estamos entendiendo bien por aquí 😅 Ya le avisé a alguien del equipo para que te ayude directamente.";
  }
  return null;
}

function manejarAskDate(session, extracted, texto) {
  const raw = extracted || { option_id: null, raw_value: texto };
  const fechaISO = nucleo.resolveFromOffered(raw, session.offered);
  const hoyISO = toISO(new Date());
  const disponibilidad = fechaISO ? db.disponibilidad(fechaISO) : { abierto: false, slots: [] };
  const { verdict, reason } = nucleo.validarFecha(fechaISO, disponibilidad, hoyISO);

  registrarIntento(session, verdict);

  if (verdict === "ACCEPT") {
    session.slots.date = fechaISO;
    session.state = "ASK_TIME";
    session.offered = construirOfertaHoras(fechaISO);
    guardar(session);
    return mensajeHoras(fechaISO, session.offered);
  }

  const handoff = manejarHandoffSiAplica(session);
  if (handoff) return handoff;

  guardar(session);
  if (verdict === "REJECT" && reason === "past") {
    return `Esa fecha ya pasó. ${mensajeFechas(session.offered)}`;
  }
  if (reason === "closed" || reason === "full") {
    session.offered = construirOfertaFechas(new Date());
    guardar(session);
    return `Ese día no tenemos espacio. ${mensajeFechas(session.offered)}`;
  }
  return `No logré identificar el día. ${mensajeFechas(session.offered)}`;
}

function manejarAskTime(session, extracted, texto) {
  const raw = extracted || { option_id: null, raw_value: texto };
  const horaResuelta = nucleo.resolveFromOffered(raw, session.offered);
  const disponible = horaResuelta ? db.horaEstaDisponible(session.slots.date, horaResuelta) : false;
  const { verdict } = nucleo.validarHora(horaResuelta, disponible);

  registrarIntento(session, verdict);

  if (verdict === "ACCEPT") {
    session.slots.time = horaResuelta;
    session.state = "ASK_NAME";
    session.offered = null;
    guardar(session);
    return mensajeNombre();
  }

  const handoff = manejarHandoffSiAplica(session);
  if (handoff) return handoff;

  guardar(session);
  const { slots } = db.disponibilidad(session.slots.date);
  return `Esa hora no está disponible. Libres ese día: ${slots.join(", ") || "ninguno"}. ¿Cuál eliges?`;
}

function manejarAskName(session, extracted, texto) {
  const nombreCrudo = (extracted && extracted.name) || texto;
  const { verdict, value } = nucleo.validarNombre(nombreCrudo);

  registrarIntento(session, verdict);

  if (verdict === "ACCEPT") {
    session.slots.name = value;
    session.state = "CONFIRM";
    guardar(session);
    return mensajeConfirmacion(session.slots);
  }

  const handoff = manejarHandoffSiAplica(session);
  if (handoff) return handoff;

  guardar(session);
  return "¿Puedes escribir tu nombre completo, por favor?";
}

function manejarConfirm(session, extracted, texto) {
  if (nucleo.esConfirmacion(texto)) {
    // Re-chequeo real de disponibilidad justo antes de escribir (pudo ocuparse mientras tanto)
    if (!db.horaEstaDisponible(session.slots.date, session.slots.time)) {
      session.state = "ASK_TIME";
      session.offered = construirOfertaHoras(session.slots.date);
      session.attempts = 0;
      guardar(session);
      return `Justo se ocupó ese horario mientras confirmábamos. ${mensajeHoras(session.slots.date, session.offered)}`;
    }
    const telefono = session.phone.replace("whatsapp:", "");
    db.crearCita({ paciente: session.slots.name, telefono, fecha: session.slots.date, hora: session.slots.time });
    const resumen = `¡Listo! Tu cita quedó agendada para el ${formatoLegible(session.slots.date, session.slots.time)}. Te mandaremos un recordatorio antes. Si necesitas cambiarla, escríbenos.`;
    db.eliminarSession(session.phone);
    return resumen;
  }

  if (nucleo.esRechazo(texto)) {
    db.eliminarSession(session.phone);
    return "Sin problema, cancelé el proceso. Escribe \"cita\" cuando quieras intentarlo de nuevo.";
  }

  // Cualquier otra cosa en CONFIRM se trata como corrección (§8 del spec)
  return manejarCorreccion(session, extracted, texto);
}

// Intenta reinterpretar la corrección como una fecha nueva primero, luego
// como una hora nueva para la fecha actual; si no resuelve nada, solo
// re-pregunta lo pendiente sin avanzar ni inventar un cambio.
function manejarCorreccion(session, extracted, texto) {
  const raw = extracted || { option_id: null, raw_value: texto };

  const ofertaFechas = construirOfertaFechas(new Date());
  const fechaNueva = nucleo.resolveFromOffered(raw, ofertaFechas);
  if (fechaNueva) {
    const disponibilidad = db.disponibilidad(fechaNueva);
    if (disponibilidad.abierto && disponibilidad.slots.length > 0) {
      const cambioFecha = fechaNueva !== session.slots.date;
      session.slots.date = fechaNueva;
      session.slots.time = null;
      session.state = "ASK_TIME";
      session.offered = construirOfertaHoras(fechaNueva);
      session.attempts = 0;
      guardar(session);
      const prefijo = cambioFecha ? "Perdón, anoto el cambio." : "Perdón, sigo con esa fecha.";
      return `${prefijo} ${mensajeHoras(fechaNueva, session.offered)}`;
    }
  }

  if (session.slots.date) {
    const ofertaHoras = construirOfertaHoras(session.slots.date);
    const horaNueva = nucleo.resolveFromOffered(raw, ofertaHoras);
    if (horaNueva && db.horaEstaDisponible(session.slots.date, horaNueva)) {
      const cambioHora = horaNueva !== session.slots.time;
      session.slots.time = horaNueva;
      session.state = "ASK_NAME";
      session.offered = null;
      session.attempts = 0;
      guardar(session);
      const prefijo = cambioHora ? "Perdón, anoto el cambio." : "Perdón, sigo con esa hora.";
      return `${prefijo} ${mensajeNombre()}`;
    }
  }

  // No se pudo resolver nada nuevo: no avanza, solo re-pregunta
  registrarIntento(session, "CLARIFY");
  const handoff = manejarHandoffSiAplica(session);
  if (handoff) return handoff;
  guardar(session);
  return `Perdón, ¿me confirmas de nuevo? ${preguntaPendiente(session.state, session)}`;
}

module.exports = { manejarMensajePaciente };
