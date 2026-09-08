// pacienteFlow.js
// Orquestación del flujo del cliente (ver FLUJO_CONVERSACIONAL.md):
// filtro de contenido -> extractor (LLM) -> núcleo (determinista) -> DB.
// La sesión vive en SQLite (tabla `sessions`), sobrevive a reinicios/redeploys.

const db = require("./db");
const { formatoLegible, toISO } = require("./dateutils");
const { esMensajeInapropiado, pideHumano } = require("./iaChat");
const { extraer } = require("./extractor");
const { redactarRespuesta, explicarComoResponder } = require("./redactor");
const { enviarWhatsApp } = require("./whatsapp");
const nucleo = require("./nucleo");

const SESION_EXPIRA_MS = 24 * 60 * 60 * 1000; // 24h de silencio -> se reinicia
const TIMEZONE = "America/Mexico_City";

const SLOT_PEDIDO = {
  ASK_DATE: "la fecha de la cita",
  ASK_TIME: "la hora de la cita",
  ASK_NAME: "el nombre para la cita",
  CONFIRM: "confirmación (sí/no) de los datos que ya se le mostraron",
};

const DIAS_LARGOS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

// ---------- Info del negocio / preguntas frecuentes ----------

function formatearHorarios() {
  const abiertos = db.listarConfigHorario().filter(c => c.activo);
  if (abiertos.length === 0) return "Por ahora no tengo el horario a la mano.";
  return abiertos.map(c => `${DIAS_LARGOS[c.dia_semana]}: ${c.hora_inicio} a ${c.hora_fin}`).join("\n");
}

// Le da calidez a la respuesta usando Claude, pero solo con datos reales que
// ya tenemos (nunca inventa precios, promociones, etc. que no existen). Si
// la llamada a Claude falla, cae a una plantilla fija con el mismo dato real.
async function responderPreguntaComun(pregunta, tema) {
  const negocio = db.obtenerNegocio();

  // Los servicios/precios se incluyen SIEMPRE como contexto disponible —
  // muchas preguntas de "otro" (ej. "cuánto cuesta X") en realidad se
  // responden con este mismo dato, y clasificarlas como "servicios" vs.
  // "otro" es ambiguo incluso para el extractor. Horario/ubicación se
  // agregan encima solo si aplican a la pregunta.
  const partes = [`Servicios y precios: ${negocio.servicios}`];
  if (tema === "horarios") partes.push(`Horario:\n${formatearHorarios()}`);
  if (tema === "ubicacion" && negocio.direccion) partes.push(`Dirección: ${negocio.direccion}`);
  const datosReales = partes.join("\n");

  const redactada = await redactarRespuesta({ pregunta, datosReales, nombreNegocio: negocio.nombre });
  if (redactada) return redactada;

  if (tema === "horarios") return `¡Con gusto! *Nuestro horario:*\n${formatearHorarios()}`;
  if (tema === "servicios") return `¡Claro! Ofrecemos: *${negocio.servicios}*.`;
  if (tema === "ubicacion" && negocio.direccion) return `¡Con gusto! Estamos en *${negocio.direccion}*.`;
  return "No tengo ese dato a la mano ahorita, pero con gusto te puede ayudar alguien de nuestro equipo.";
}

// ---------- Construcción de ofertas (listas con ids) ----------

function construirOfertaFechas(desde, excluirCitaId = null) {
  const dias = db.proximosDiasConDisponibilidad(3, desde, excluirCitaId);
  const options = dias.map((d, i) => ({ id: i + 1, label: formatoLegible(d.fecha, ""), value: d.fecha }));
  return { kind: "dates", generated_at: new Date().toISOString(), options };
}

function construirOfertaHoras(fechaISO, excluirCitaId = null) {
  const { slots } = db.disponibilidad(fechaISO, excluirCitaId);
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
  const lineas = offered.options.map(o => `*${o.id})* ${o.label}`);
  return `¿Qué día te gustaría venir? Estas son las fechas más próximas con espacio:\n${lineas.join("\n")}`;
}

function mensajeHoras(fechaISO, offered) {
  const lineas = offered.options.map(o => `*${o.id})* ${o.value}`);
  return `¡Buena elección! Para *${formatoLegible(fechaISO, "")}* tengo estos horarios libres:\n${lineas.join("\n")}\n\n¿Cuál te acomoda mejor? (si ninguno te late, dime otra hora y vemos)`;
}

function mensajeNombre() {
  return "¡Ya casi terminamos! ¿A nombre de quién agendamos la cita?";
}

function mensajeConfirmacion(slots, esCambio) {
  const encabezado = esCambio
    ? "¡Perfecto! Déjame confirmar el cambio antes de actualizar tu cita:"
    : "¡Perfecto! Déjame confirmar los detalles antes de agendar:";
  return `${encabezado}\n📅 *${formatoLegible(slots.date, slots.time)}*\n👤 *${slots.name}*\n\n¿Todo correcto? Responde *SÍ* para confirmar.`;
}

function preguntaPendiente(state, session) {
  if (state === "ASK_DATE") return mensajeFechas(session.offered);
  if (state === "ASK_TIME") return mensajeHoras(session.slots.date, session.offered);
  if (state === "ASK_NAME") return mensajeNombre();
  if (state === "CONFIRM") return mensajeConfirmacion(session.slots, !!session.citaId);
  return "¿Seguimos con tu cita? Escríbeme \"cita\" cuando quieras empezar.";
}

// ---------- Sesión ----------

function sesionFresca(phone) {
  return {
    phone,
    state: "ASK_DATE",
    slots: { date: null, time: null, name: null },
    offered: null,
    citaId: null, // si ya tenía una cita activa, esto la reagenda en vez de crear una nueva
    attempts: 0,
    last_message_at: new Date().toISOString(),
    locale: "es-MX",
    timezone: TIMEZONE,
  };
}

// Sesión "liviana": ya se saludó, pero todavía no decide agendar (solo
// preguntó algo). No forma parte de la máquina de estados de agendado.
function sesionChateando(phone) {
  return { ...sesionFresca(phone), state: "CHATTING", slots: { date: null, time: null, name: null } };
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

// profileName: nombre del perfil de WhatsApp del remitente (Twilio lo manda
// como "ProfileName" en cada mensaje) — se usa solo para saludar por su
// nombre, nunca para nada que afecte la lógica de agendado.
function primerNombreDePerfil(profileName) {
  const limpio = (profileName || "").trim();
  if (!limpio || limpio.length > 30) return null;
  if (!/^[a-zA-ZÀ-ÿ\s'.-]+$/.test(limpio)) return null; // evita emojis/nombres de negocio raros
  return limpio.split(/\s+/)[0];
}

async function manejarMensajePaciente(from, textoOriginal, profileName) {
  const texto = (textoOriginal || "").trim();
  const primerNombre = primerNombreDePerfil(profileName);

  if (esMensajeInapropiado(texto)) {
    return "Por favor mantengamos la conversación enfocada en agendar tu cita. Escribe \"cita\" cuando quieras continuar.";
  }

  // Pide hablar con una persona: el bot se calla de inmediato (sin esperar
  // a los 3 intentos fallidos de HANDOFF) y se le avisa a recepción para
  // que alguien entre a la conversación directamente desde WhatsApp/Meta
  // Business Suite — el bot deja de responder en este chat en cuanto entra
  // a HANDOFF, así que la persona puede tomar el control sin que se crucen.
  if (pideHumano(texto)) {
    const s = cargarSesion(from) || sesionFresca(from);
    s.state = "HANDOFF";
    guardar(s);
    const receptor = process.env.NUMERO_RECEPCION;
    if (receptor) {
      await enviarWhatsApp(
        `whatsapp:${receptor}`,
        `⚠️ Un cliente (${from.replace("whatsapp:", "")}) pidió hablar con una persona. Entra a la conversación de WhatsApp para atenderlo directamente — el bot ya no le va a responder en este chat.`
      );
    }
    return "¡Claro que sí! En un momento alguien de nuestro equipo te atiende directamente por aquí mismo.";
  }

  let session = cargarSesion(from);

  // --- Sin sesión, o ya se saludó pero aún no empieza a agendar ---
  // (CHATTING existe solo para no repetir "¡Hola! Bienvenido a X" cada vez
  // que alguien pregunta algo antes de decidirse a agendar — sin esto, cada
  // pregunta fuera de flujo hacía que la siguiente respuesta reiniciara la
  // conversación desde cero como si nunca hubiera saludado.)
  if (!session || session.state === "CHATTING") {
    const yaSaludado = !!session;

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

    const negocio = db.obtenerNegocio();

    if (!quiereAgendar) {
      const chateando = session || sesionChateando(from);
      guardar(chateando);

      if (extracted && extracted.intent === "ask_question") {
        const respuesta = await responderPreguntaComun(texto, extracted.tema_pregunta);
        return `${respuesta}\n\n¿Te gustaría agendar una cita? Escribe "cita".`;
      }
      if (extracted && extracted.intent === "cancel") {
        return "¡Sin problema! Aquí estoy cuando quieras agendar, solo escríbeme \"cita\".";
      }
      return yaSaludado
        ? "¿En qué más te puedo ayudar? Si quieres agendar una cita, dime \"cita\"."
        : `¡Hola${primerNombre ? ", " + primerNombre : ""}! 👋 Bienvenido a *${negocio.nombre}*. ¿En qué te puedo ayudar? Si quieres agendar una cita, dime "cita" y con gusto te ayudo a encontrar un horario.`;
    }

    // Un mismo número no puede tener dos citas activas — si ya tiene una,
    // este flujo la reagenda (nueva fecha/hora) en vez de crear una nueva.
    const telefono = from.replace("whatsapp:", "");
    const citaExistente = db.buscarCitaActivaPorTelefono(telefono);

    const nueva = sesionFresca(from);
    if (citaExistente) {
      nueva.citaId = citaExistente.id;
      nueva.slots.name = citaExistente.paciente;
    }
    const offered = construirOfertaFechas(new Date(), nueva.citaId);
    if (offered.options.length === 0) {
      return "¡Gracias por escribirnos! Por ahora no tenemos horarios disponibles próximamente, pero en breve nos pondremos en contacto contigo.";
    }
    nueva.offered = offered;
    guardar(nueva);
    const saludo = yaSaludado ? "¡Perfecto!" : `¡Hola${primerNombre ? ", " + primerNombre : ""}! 👋 Bienvenido a *${negocio.nombre}*.`;
    const intro = citaExistente
      ? `Veo que ya tienes una cita para el *${formatoLegible(citaExistente.fecha, citaExistente.hora)}*. Vamos a cambiarla — dime la nueva fecha que te acomode.`
      : "Con gusto te agendamos.";
    return `${saludo} ${intro}\n\n${mensajeFechas(offered)}`;
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
    return "¡Sin problema! Cancelé el proceso. Escríbeme \"cita\" cuando quieras intentarlo de nuevo.";
  }

  // Pregunta fuera de flujo: se responde y se repite lo pendiente, sin perder el estado
  if (extracted && extracted.intent === "ask_question" && session.state !== "CONFIRM") {
    guardar(session);
    const respuesta = await responderPreguntaComun(texto, extracted.tema_pregunta);
    return `${respuesta}\n\n${preguntaPendiente(session.state, session)}`;
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

async function manejarAskDate(session, extracted, texto) {
  const raw = extracted || { option_id: null, raw_value: texto };
  const fechaISO = nucleo.resolveFromOffered(raw, session.offered);
  const hoyISO = toISO(new Date());
  const disponibilidad = fechaISO ? db.disponibilidad(fechaISO, session.citaId) : { abierto: false, slots: [] };
  const { verdict, reason } = nucleo.validarFecha(fechaISO, disponibilidad, hoyISO);

  registrarIntento(session, verdict);

  if (verdict === "ACCEPT") {
    session.slots.date = fechaISO;
    session.state = "ASK_TIME";
    session.offered = construirOfertaHoras(fechaISO, session.citaId);
    guardar(session);
    return mensajeHoras(fechaISO, session.offered);
  }

  const handoff = manejarHandoffSiAplica(session);
  if (handoff) return handoff;

  guardar(session);
  if (verdict === "REJECT" && reason === "past") {
    return `Esa fecha ya pasó, pero no hay problema — ${mensajeFechas(session.offered)}`;
  }
  if (reason === "closed" || reason === "full") {
    session.offered = construirOfertaFechas(new Date(), session.citaId);
    guardar(session);
    return `Uy, ese día ya no tengo espacio. ${mensajeFechas(session.offered)}`;
  }

  // No se logró identificar ningún día en el texto: en vez de un mensaje
  // fijo, se le pide a Claude que interprete lo que escribió y explique con
  // calidez cómo responder — usando solo las fechas reales ya ofrecidas.
  const negocio = db.obtenerNegocio();
  const opciones = session.offered.options.map(o => `${o.id}) ${o.label}`).join("\n");
  const explicacion = await explicarComoResponder({
    textoUsuario: texto, loQueSeEspera: "qué día quiere para su cita",
    opciones, nombreNegocio: negocio.nombre,
  });
  return explicacion
    ? `${explicacion}\n\n${mensajeFechas(session.offered)}`
    : `No logré identificar bien el día 🤔 ${mensajeFechas(session.offered)}`;
}

async function manejarAskTime(session, extracted, texto) {
  const raw = extracted || { option_id: null, raw_value: texto };
  const horaResuelta = nucleo.resolveFromOffered(raw, session.offered);
  const disponible = horaResuelta ? db.horaEstaDisponible(session.slots.date, horaResuelta, session.citaId) : false;
  const { verdict, reason } = nucleo.validarHora(horaResuelta, disponible);

  registrarIntento(session, verdict);

  if (verdict === "ACCEPT") {
    session.slots.time = horaResuelta;
    // Si ya veníamos reagendando una cita existente, ya tenemos el nombre —
    // no hace falta volver a pedirlo, se salta directo a confirmar.
    if (session.citaId && session.slots.name) {
      session.state = "CONFIRM";
      session.offered = null;
      guardar(session);
      return mensajeConfirmacion(session.slots, true);
    }
    session.state = "ASK_NAME";
    session.offered = null;
    guardar(session);
    return mensajeNombre();
  }

  const handoff = manejarHandoffSiAplica(session);
  if (handoff) return handoff;

  guardar(session);

  if (reason === "full") {
    const { slots } = db.disponibilidad(session.slots.date, session.citaId);
    return `Esa hora ya no está disponible, pero tengo estas libres ese día: ${slots.join(", ") || "ninguno"}. ¿Cuál te acomoda?`;
  }

  // No se logró identificar ninguna hora en el texto: se le pide a Claude
  // que interprete y guíe, usando solo las horas reales ya ofrecidas.
  const negocio = db.obtenerNegocio();
  const opciones = session.offered.options.map(o => `${o.id}) ${o.value}`).join("\n");
  const explicacion = await explicarComoResponder({
    textoUsuario: texto, loQueSeEspera: "qué hora quiere para su cita",
    opciones, nombreNegocio: negocio.nombre,
  });
  return explicacion
    ? `${explicacion}\n\n${mensajeHoras(session.slots.date, session.offered)}`
    : `No logré identificar bien la hora 🤔 ${mensajeHoras(session.slots.date, session.offered)}`;
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
  return "¿Me compartes tu nombre completo, por favor?";
}

function manejarConfirm(session, extracted, texto) {
  if (nucleo.esConfirmacion(texto)) {
    // Re-chequeo real de disponibilidad justo antes de escribir (pudo ocuparse mientras tanto)
    if (!db.horaEstaDisponible(session.slots.date, session.slots.time, session.citaId)) {
      session.state = "ASK_TIME";
      session.offered = construirOfertaHoras(session.slots.date, session.citaId);
      session.attempts = 0;
      guardar(session);
      return `¡Uy! Justo se ocupó ese horario mientras confirmábamos. ${mensajeHoras(session.slots.date, session.offered)}`;
    }
    let resumen;
    if (session.citaId) {
      db.reagendarCita(session.citaId, session.slots.date, session.slots.time);
      resumen = `✅ ¡Listo! Tu cita quedó actualizada para el ${formatoLegible(session.slots.date, session.slots.time)}. ¡Nos vemos pronto!`;
    } else {
      const telefono = session.phone.replace("whatsapp:", "");
      db.crearCita({ paciente: session.slots.name, telefono, fecha: session.slots.date, hora: session.slots.time });
      resumen = `✅ ¡Listo! Tu cita quedó agendada para el ${formatoLegible(session.slots.date, session.slots.time)}. Te mandaremos un recordatorio antes de que llegue el día. ¡Nos vemos pronto!`;
    }
    db.eliminarSession(session.phone);
    return resumen;
  }

  if (nucleo.esRechazo(texto)) {
    db.eliminarSession(session.phone);
    return "¡Sin problema! Cancelé el proceso. Escríbeme \"cita\" cuando quieras intentarlo de nuevo.";
  }

  // Cualquier otra cosa en CONFIRM se trata como corrección (§8 del spec)
  return manejarCorreccion(session, extracted, texto);
}

// Intenta reinterpretar la corrección como una fecha nueva primero, luego
// como una hora nueva para la fecha actual; si no resuelve nada, solo
// re-pregunta lo pendiente sin avanzar ni inventar un cambio.
async function manejarCorreccion(session, extracted, texto) {
  const raw = extracted || { option_id: null, raw_value: texto };

  const ofertaFechas = construirOfertaFechas(new Date(), session.citaId);
  const fechaNueva = nucleo.resolveFromOffered(raw, ofertaFechas);
  if (fechaNueva) {
    const disponibilidad = db.disponibilidad(fechaNueva, session.citaId);
    if (disponibilidad.abierto && disponibilidad.slots.length > 0) {
      const cambioFecha = fechaNueva !== session.slots.date;
      session.slots.date = fechaNueva;
      session.slots.time = null;
      session.state = "ASK_TIME";
      session.offered = construirOfertaHoras(fechaNueva, session.citaId);
      session.attempts = 0;
      guardar(session);
      const prefijo = cambioFecha ? "¡Va, anoto el cambio!" : "¡Entendido, seguimos con esa fecha!";
      return `${prefijo} ${mensajeHoras(fechaNueva, session.offered)}`;
    }
  }

  if (session.slots.date) {
    const ofertaHoras = construirOfertaHoras(session.slots.date, session.citaId);
    const horaNueva = nucleo.resolveFromOffered(raw, ofertaHoras);
    if (horaNueva && db.horaEstaDisponible(session.slots.date, horaNueva, session.citaId)) {
      const cambioHora = horaNueva !== session.slots.time;
      session.slots.time = horaNueva;
      session.attempts = 0;
      const prefijo = cambioHora ? "¡Va, anoto el cambio!" : "¡Entendido, seguimos con esa hora!";
      if (session.citaId && session.slots.name) {
        session.state = "CONFIRM";
        session.offered = null;
        guardar(session);
        return `${prefijo} ${mensajeConfirmacion(session.slots, true)}`;
      }
      session.state = "ASK_NAME";
      session.offered = null;
      guardar(session);
      return `${prefijo} ${mensajeNombre()}`;
    }
  }

  // No se pudo resolver nada nuevo: no avanza. En vez de un mensaje fijo, se
  // le pide a Claude que interprete el texto y explique con calidez qué tipo
  // de respuesta se espera, usando solo los datos reales ya decididos.
  registrarIntento(session, "CLARIFY");
  const handoff = manejarHandoffSiAplica(session);
  if (handoff) return handoff;
  guardar(session);

  const negocio = db.obtenerNegocio();
  const opciones = session.offered && session.offered.options
    ? session.offered.options.map(o => `${o.id}) ${o.label || o.value}`).join("\n")
    : "(ninguna lista activa — se espera confirmación con sí/no, o corregir la fecha/hora)";
  const explicacion = await explicarComoResponder({
    textoUsuario: texto, loQueSeEspera: SLOT_PEDIDO[session.state] || "la información pendiente",
    opciones, nombreNegocio: negocio.nombre,
  });
  return explicacion
    ? `${explicacion}\n\n${preguntaPendiente(session.state, session)}`
    : `Disculpa, ¿me lo confirmas una vez más? ${preguntaPendiente(session.state, session)}`;
}

module.exports = { manejarMensajePaciente };
