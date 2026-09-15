// pacienteFlow.js
// Orquestación del flujo del cliente (ver FLUJO_CONVERSACIONAL.md):
// filtro de contenido -> extractor (LLM) -> núcleo (determinista) -> DB.
// La sesión vive en SQLite (tabla `sessions`), sobrevive a reinicios/redeploys.

const db = require("./db");
const { formatoLegible, toISO } = require("./dateutils");
const { esMensajeInapropiado, pideHumano, esTemaMedico, esQueja } = require("./iaChat");
const { extraer } = require("./extractor");
const { redactarRespuesta, explicarComoResponder } = require("./redactor");
const { enviarWhatsApp } = require("./whatsapp");
const nucleo = require("./nucleo");

// Cuánto silencio hace que una sesión se considere abandonada y se reinicie
// desde cero. Un agendado a medias (o una charla vieja) no debe seguir
// "atrapando" la conversación días después si la persona ya se olvidó y
// solo vuelve a saludar. HANDOFF es distinto pero NO indefinido: el dueño
// le contesta al cliente desde su propio número personal, no por este
// sistema, así que el bot no está "esperando" nada real — es solo un
// margen para no interrumpir mientras el dueño alcanza a escribirle. Si
// pasan 3h y el cliente vuelve a escribir por algo nuevo, mejor que el bot
// vuelva a ayudar en vez de dejarlo sin ninguna respuesta casi un día entero.
const SESION_EXPIRA_MS = {
  HANDOFF: 3 * 60 * 60 * 1000,  // 3h
  DEFAULT: 2 * 60 * 60 * 1000,  // 2h — agendado abandonado o charla vieja
};
const TIMEZONE = "America/Mexico_City";

const SLOT_PEDIDO = {
  ASK_DATE: "la fecha de la cita",
  ASK_TIME: "la hora de la cita",
  ASK_NAME: "el nombre para la cita",
  CONFIRM: "confirmación (sí/no) de los datos que ya se le mostraron",
};

const DIAS_LARGOS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

// ---------- Aviso al dueño/recepción cuando se necesita escalar ----------

// `telefono` sin el prefijo "whatsapp:". Siempre incluye el número Y un link
// de wa.me, para que el dueño pueda tocarlo y escribirle directo al cliente
// por WhatsApp sin tener que copiar el número a mano.
async function avisarEscalacion(telefono, motivo) {
  const receptor = process.env.NUMERO_RECEPCION;
  if (!receptor) return;
  const soloDigitos = telefono.replace(/[^\d]/g, "");
  const mensaje = `⚠️ ${motivo}\n📱 Cliente: *${telefono}*\nEscríbele directo: https://wa.me/${soloDigitos}`;
  await enviarWhatsApp(`whatsapp:${receptor}`, mensaje);
}

// ---------- Info del negocio / preguntas frecuentes ----------

function formatearHorarios() {
  const abiertos = db.listarConfigHorario().filter(c => c.activo);
  if (abiertos.length === 0) return "Por ahora no tengo el horario a la mano.";
  return abiertos.map(c => `${DIAS_LARGOS[c.dia_semana]}: ${c.hora_inicio} a ${c.hora_fin}`).join("\n");
}

// Único lugar que sabe si este cliente ya tiene una cita — se usa para que
// cualquier respuesta redactada por IA (FAQ, aclaraciones) pueda contestar
// con la verdad si preguntan "¿ya tenía una cita?" en vez de inventar una
// respuesta, ya que ni responderPreguntaComun ni explicarComoResponder
// tienen ese dato por su cuenta.
function infoCitaExistente(telefono) {
  const cita = telefono ? db.buscarCitaActivaPorTelefono(telefono) : null;
  return cita
    ? `este cliente SÍ tiene una cita activa: ${formatoLegible(cita.fecha, cita.hora)}.`
    : "este cliente NO tiene ninguna cita activa agendada actualmente.";
}

// Le da calidez a la respuesta usando Claude, pero solo con datos reales que
// ya tenemos (nunca inventa precios, promociones, etc. que no existen). Si
// la llamada a Claude falla, cae a una plantilla fija con el mismo dato real.
async function responderPreguntaComun(pregunta, tema, formal = false, telefono = null) {
  const negocio = db.obtenerNegocio();

  // Los servicios/precios se incluyen SIEMPRE como contexto disponible —
  // muchas preguntas de "otro" (ej. "cuánto cuesta X") en realidad se
  // responden con este mismo dato, y clasificarlas como "servicios" vs.
  // "otro" es ambiguo incluso para el extractor. Horario/ubicación/cita
  // existente se agregan encima solo si aplican a la pregunta.
  // Los servicios se listan uno por línea (en vez del string tal cual, todo
  // en una coma) para que sea trivial ubicar el precio exacto de un
  // servicio puntual — en una lista corrida el redactor a veces "no
  // encontraba" un precio que sí estaba ahí.
  const listaServicios = negocio.servicios.split(",").map(s => `- ${s.trim()}`).join("\n");
  const partes = [`Servicios y precios (cada uno ya tiene su precio definido):\n${listaServicios}`];
  if (tema === "horarios") partes.push(`Horario:\n${formatearHorarios()}`);
  if (tema === "ubicacion" && negocio.direccion) partes.push(`Dirección: ${negocio.direccion}`);
  partes.push(`Cita del cliente: ${infoCitaExistente(telefono)}`);
  const datosReales = partes.join("\n");

  const redactada = await redactarRespuesta({ pregunta, datosReales, nombreNegocio: negocio.nombre, formal });
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
  const { slots: todosLosSlots } = db.disponibilidad(fechaISO, excluirCitaId);
  // No se ofrece (ni se deja resolver) un horario a menos de 2h de
  // anticipación — ver nucleo.POLICY.minLeadMinutes.
  const slots = todosLosSlots.filter(s => nucleo.cumpleAntelacionMinima(fechaISO, s));
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
  return `¡Buena elección! Para *${formatoLegible(fechaISO, "")}* tengo estos horarios libres:\n${lineas.join("\n")}\n\n¿Cuál te acomoda? (o dime otra hora)`;
}

function mensajeNombre() {
  return "¡Ya casi terminamos! ¿Me podrías compartir el nombre para la cita, por favor?";
}

function mensajeConfirmacion(slots, esCambio) {
  const encabezado = esCambio
    ? "¡Perfecto! Déjame confirmar el cambio antes de actualizar tu cita:"
    : "¡Perfecto! Déjame confirmar los detalles antes de agendar:";
  return `${encabezado}\n📅 *${formatoLegible(slots.date, slots.time)}*\n👤 *${slots.name}*\n\n¿Todo correcto? Responde *SÍ* para confirmar, por favor.`;
}

function preguntaPendiente(state, session) {
  if (state === "ASK_DATE") return mensajeFechas(session.offered);
  if (state === "ASK_TIME") return mensajeHoras(session.slots.date, session.offered);
  if (state === "ASK_NAME") return mensajeNombre();
  if (state === "CONFIRM") return mensajeConfirmacion(session.slots, !!session.citaId);
  return "¿Seguimos con tu cita? Dime cuando quieras empezar.";
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
  const limite = SESION_EXPIRA_MS[s.state] || SESION_EXPIRA_MS.DEFAULT;
  const ultima = s.last_message_at ? new Date(s.last_message_at).getTime() : 0;
  if (Date.now() - ultima > limite) {
    // HANDOFF es la única excepción a "se borra y arranca de cero": en vez
    // de olvidar que este cliente fue escalado, se pasa a un estado de
    // seguimiento — así, cuando vuelva a escribir, el bot pregunta si ya
    // se resolvió en vez de fingir que nunca pasó nada (y puede volver a
    // avisarle al dueño si nunca se comunicó).
    if (s.state === "HANDOFF") {
      s.state = "HANDOFF_CHECKIN";
      s.last_message_at = new Date().toISOString(); // arranca de cero el reloj de este nuevo estado
      db.saveSession(s);
      return s;
    }
    db.eliminarSession(phone);
    return null;
  }
  return s;
}

function guardar(session) {
  session.last_message_at = new Date().toISOString();
  // El cliente acaba de escribir, así que cualquier recordatorio de abandono
  // pendiente ya no aplica — si vuelve a quedarse callado, se le manda uno nuevo.
  session.reminderSent = false;
  db.saveSession(session);
}

// Mensaje de "¿sigues ahí?" cuando el cliente deja de responder a la mitad
// del agendado (ver correrRecordatoriosDeAgenda en server.js). Nunca se usa
// fuera de los estados de agendado (nunca por solo saludar o preguntar algo).
function mensajeRecordatorioAgenda(session) {
  const { date, time, name } = session.slots;
  if (session.state === "CONFIRM") {
    return `¿Sigues ahí? 🙂 Nada más faltaba que confirmaras tu cita del *${formatoLegible(date, time)}* a nombre de *${name}*. ¿Quieres seguir con el agendado o prefieres dejarlo por ahora? Sin problema cualquiera de las dos, aquí sigo cuando quieras retomarlo.`;
  }
  if (session.state === "ASK_NAME") {
    return `¿Sigues ahí? 🙂 Ya casi terminábamos tu cita para el *${formatoLegible(date, time)}* — solo faltaba tu nombre. ¿Seguimos o prefieres dejarlo por ahora? Aquí sigo cuando quieras retomarlo.`;
  }
  if (session.state === "ASK_TIME") {
    return `¿Sigues ahí? 🙂 Íbamos agendando tu cita para el *${formatoLegible(date, "")}* — ¿qué hora te acomoda? Si prefieres dejarlo por ahora, sin problema, aquí sigo cuando quieras retomarlo.`;
  }
  return "¿Sigues ahí? 🙂 Íbamos a agendar tu cita — ¿qué día te gustaría? Si prefieres dejarlo por ahora, sin problema, aquí sigo cuando quieras retomarlo.";
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

// Wrapper: agrega un ❤️ a la respuesta cuando el mensaje del cliente fue de
// agradecimiento/entusiasmo (ver nucleo.esMensajePositivo). Envuelve toda la
// lógica real en vez de tocar cada punto de retorno por separado.
async function manejarMensajePaciente(from, textoOriginal, profileName) {
  const respuesta = await procesarMensajePaciente(from, textoOriginal, profileName);
  if (respuesta && nucleo.esMensajePositivo(textoOriginal)) {
    return `${respuesta} ❤️`;
  }
  return respuesta;
}

async function procesarMensajePaciente(from, textoOriginal, profileName) {
  const texto = (textoOriginal || "").trim();
  const primerNombre = primerNombreDePerfil(profileName);

  let session = cargarSesion(from);

  // Si en algún momento la persona habla de "usted", el bot se cambia a
  // usted y ya no regresa a tú en lo que resta de la conversación — se
  // guarda en slots.formal (mismo truco que faqTurnos: reusa el JSON de la
  // sesión, sin columna nueva) y se le pasa a las partes redactadas por IA.
  const formal = !!(session && session.slots && session.slots.formal) || /\busted\b/i.test(texto);
  if (session) session.slots.formal = formal;

  if (esMensajeInapropiado(texto)) {
    return "Por favor mantengamos la conversación enfocada en agendar tu cita. Dime cuando quieras continuar.";
  }

  // Temas de salud (embarazo, alergias, medicamentos, contraindicaciones,
  // reacciones en la piel): el bot nunca opina ni da tranquilidad médica —
  // eso es responsabilidad de la especialista. No es un handoff silencioso
  // como pideHumano: solo se redirige esta pregunta puntual y la
  // conversación sigue donde iba (si estaba a media agenda, sigue ahí).
  if (esTemaMedico(texto)) {
    // No es un handoff que calle al bot (la conversación sigue), pero el
    // dueño sí debe enterarse — es justo el tipo de tema que puede requerir
    // seguimiento humano aunque el cliente no lo pida explícitamente.
    await avisarEscalacion(
      from.replace("whatsapp:", ""),
      "Un cliente preguntó algo relacionado a salud/contraindicaciones y el bot lo redirigió sin opinar. Puede valer la pena que le hables."
    );
    return "Eso mejor que lo valore la especialista directamente, para cuidarte bien — por aquí no te puedo asesorar en ese tema. ¿Quieres que te agende una valoración, o prefieres que alguien del equipo te llame?";
  }

  // Queja o inconformidad: una disculpa breve (sin sobre-disculparse),
  // se pregunta qué pasó, y se escala a un humano — igual que pideHumano.
  if (esQueja(texto)) {
    const s = session || sesionFresca(from);
    s.slots.formal = formal;
    s.state = "HANDOFF";
    guardar(s);
    await avisarEscalacion(from.replace("whatsapp:", ""), "Un cliente parece tener una queja o inconformidad. Entra a la conversación para atenderlo directamente.");
    return "Lamento el inconveniente. ¿Me cuentas brevemente qué pasó? Ya le aviso a alguien del equipo para que te ayude directamente.";
  }

  // Pide hablar con una persona: el bot se calla de inmediato (sin esperar
  // a los 3 intentos fallidos de HANDOFF) y se le avisa a recepción para
  // que alguien entre a la conversación directamente desde WhatsApp/Meta
  // Business Suite — el bot deja de responder en este chat en cuanto entra
  // a HANDOFF, así que la persona puede tomar el control sin que se crucen.
  if (pideHumano(texto)) {
    const s = session || sesionFresca(from);
    s.slots.formal = formal;
    s.state = "HANDOFF";
    guardar(s);
    await avisarEscalacion(from.replace("whatsapp:", ""), "Un cliente pidió hablar con una persona. El bot ya no le va a responder en este chat.");
    return "¡Claro que sí! En un momento alguien de nuestro equipo te atiende directamente por aquí mismo.";
  }

  // --- Sin sesión, o ya se saludó pero aún no empieza a agendar ---
  // (CHATTING existe solo para no repetir "¡Hola! Bienvenido a X" cada vez
  // que alguien pregunta algo antes de decidirse a agendar — sin esto, cada
  // pregunta fuera de flujo hacía que la siguiente respuesta reiniciara la
  // conversación desde cero como si nunca hubiera saludado.)
  if (!session || session.state === "CHATTING") {
    const yaSaludado = !!session;
    const yaInvitadoAntes = !!(session && session.slots && session.slots.ultimaInvitacion);

    const extracted = await extraer({
      mensaje: texto,
      estado: "GREET",
      slotPedido: "si quiere agendar una cita",
      offered: null,
      ahora: new Date(),
      timezone: TIMEZONE,
      notas: yaInvitadoAntes ? "en el mensaje anterior el bot ya invitó a agendar una cita y el cliente no reaccionó a eso todavía." : undefined,
    });

    // No se exige ninguna palabra mágica ("cita") para empezar a agendar:
    // el bot siempre termina sus respuestas preguntando si quiere agendar, y
    // aquí se acepta una afirmación natural (sí/va/dale) a esa pregunta, o
    // que la persona lo pida explícitamente por su cuenta en cualquier
    // momento. Cualquier otra cosa (incluido nombrar solo un servicio, como
    // "Faciales") NO se toma como intención de agendar — se responde con
    // información real y se vuelve a preguntar, en vez de saltar de golpe
    // al flujo de agendado y perder el hilo de la conversación.
    //
    // Un mensaje como "Ok y cómo estás?" empieza con una palabra de
    // confirmación pero en realidad no lo es — por eso, cuando el extractor
    // sí respondió, se le da más peso a su clasificación de intención que a
    // la palabra suelta: solo cuenta como "dijo que sí" si el extractor
    // coincide en que es una confirmación real, y el regex de palabras
    // clave ("agendar", "cita"...) no cuenta si el extractor cree que en
    // realidad está preguntando algo o cancelando. El regex se usa solo tal
    // cual cuando la llamada a Claude falló (para no dejar al cliente sin
    // poder agendar si la API está caída).
    const pareceQuererAgendar = /\b(agendar|agenda|cita|reservar|reservaci[oó]n|apartar)\b/i.test(texto);
    const quiereAgendar = extracted
      ? extracted.intent === "confirm" || (pareceQuererAgendar && !["cancel", "ask_question"].includes(extracted.intent))
      : nucleo.esConfirmacion(texto) || pareceQuererAgendar;

    const negocio = db.obtenerNegocio();
    const telefono = from.replace("whatsapp:", "");
    const citaExistente = db.buscarCitaActivaPorTelefono(telefono);

    if (!quiereAgendar) {
      const chateando = session || sesionChateando(from);
      chateando.slots.formal = formal;

      // No se pregunta "¿quieres agendar?" en cada mensaje — la IA (el
      // extractor) decide si es un buen momento natural según cómo va la
      // charla, para no interrumpir a media conversación. En el primer
      // contacto siempre se invita; si la llamada a Claude falla, se cae a
      // un respaldo determinista (cada 3 turnos) para no dejar de invitar nunca.
      const turnoAnterior = chateando.slots.faqTurnos || 0;
      chateando.slots.faqTurnos = turnoAnterior + 1;
      const invitarAgendar = turnoAnterior === 0
        ? true
        : (extracted ? !!extracted.momento_para_invitar_cita : chateando.slots.faqTurnos % 3 === 0);
      chateando.slots.ultimaInvitacion = invitarAgendar;
      guardar(chateando);

      const recordatorioCita = citaExistente
        ? ` Por cierto, ya tienes tu cita para el *${formatoLegible(citaExistente.fecha, citaExistente.hora)}* — si tienes alguna duda sobre ella, dime.`
        : "";
      const bienvenida = !yaSaludado ? `¡Hola${primerNombre ? ", " + primerNombre : ""}! 👋 Bienvenido a *${negocio.nombre}*.${recordatorioCita} ` : "";

      // Si ya tiene una cita, no tiene sentido invitarlo a "agendar una
      // cita" (como si no tuviera ninguna) — en su lugar se le pregunta si
      // tiene dudas sobre la que ya tiene.
      const invitacionTexto = citaExistente ? "¿Tienes alguna duda sobre tu cita?" : "¿Te gustaría agendar una cita?";

      const dijoQueNo = nucleo.esRechazo(texto) || (extracted && extracted.intent === "cancel");
      if (dijoQueNo) {
        // Variantes para no repetir la misma frase tal cual si dice "no"
        // varias veces seguidas (se sentía como un bot atorado en loop).
        const vecesAnterior = chateando.slots.vecesDijoNo || 0;
        chateando.slots.vecesDijoNo = vecesAnterior + 1;
        guardar(chateando);
        const variantesNo = [
          "¡Sin problema! Aquí estoy cuando quieras.",
          "Va, sin compromiso — aquí ando si se te ofrece algo.",
          "Entendido, quedo por aquí para cuando gustes.",
        ];
        const variante = variantesNo[Math.min(vecesAnterior, variantesNo.length - 1)];
        return `${bienvenida}${variante}`;
      }

      if (extracted && extracted.intent === "greet") {
        // Si ya se había saludado antes, un simple "¿En qué te puedo
        // ayudar?" a secas se siente cortante — se re-saluda con calidez
        // en vez de ir directo a la pregunta.
        const pregunta = yaSaludado ? "¡Hola de nuevo! 😊 ¿En qué más te puedo ayudar?" : "¿En qué te puedo ayudar?";
        const invitacion = invitarAgendar ? ` ${invitacionTexto}` : "";
        return `${bienvenida}${pregunta}${invitacion}`;
      }

      const respuesta = await responderPreguntaComun(texto, (extracted && extracted.tema_pregunta) || "otro", formal, telefono);
      // Defensa extra: aunque se le pide al redactor que nunca mencione la
      // cita (eso se agrega aparte), a veces lo hace de todos modos — si su
      // respuesta ya toca el tema, no se duplica la pregunta.
      const yaMencionaCita = /\bcitas?\b/i.test(respuesta);
      const invitacion = invitarAgendar && !yaMencionaCita ? `\n\n${invitacionTexto}` : "";
      return `${bienvenida}${respuesta}${invitacion}`;
    }

    // Un mismo número no puede tener dos citas activas — si ya tiene una
    // (telefono/citaExistente ya se calcularon arriba), este flujo la
    // reagenda (nueva fecha/hora) en vez de crear una nueva.

    // Cambiar una cita que empieza en menos de 24h no se resuelve solo —
    // ver nucleo.POLICY.cancelWindowHours — se escala a un humano en vez de
    // dejar que el cliente la mueva automáticamente a última hora.
    if (citaExistente && nucleo.dentroVentanaCancelacion(citaExistente.fecha, citaExistente.hora)) {
      const s = sesionFresca(from);
      s.state = "HANDOFF";
      guardar(s);
      await avisarEscalacion(
        telefono,
        `Un cliente quiere cambiar su cita del *${formatoLegible(citaExistente.fecha, citaExistente.hora)}*, que ya es en menos de 24h. Contáctalo directamente para resolverlo.`
      );
      return `Tu cita es en menos de 24 horas, así que ese cambio lo tiene que ver directamente alguien del equipo — ya le avisé para que te contacte por aquí mismo.`;
    }

    const nueva = sesionFresca(from);
    nueva.slots.formal = formal;
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
    // El bot se queda callado (un humano sigue desde aquí, por su propio
    // número), pero si el cliente insiste antes de que pase la ventana de
    // espera, merece UNA respuesta de que no se le está ignorando — no
    // silencio total, pero tampoco repetir el mismo aviso cada vez que
    // escriba de nuevo. Esto es un template fijo a propósito (no IA): es
    // siempre el mismo mensaje, no hace falta gastar una llamada a Claude.
    if (!session.slots.avisoEsperaEnviado) {
      session.slots.avisoEsperaEnviado = true;
      // OJO: se guarda con db.saveSession directo, NO con guardar() — no
      // se debe correr el reloj de la ventana de espera solo porque el
      // cliente insistió; el conteo sigue desde que se escaló, no desde
      // el último mensaje.
      db.saveSession(session);
      return "Por favor espera un momento — el dueño se va a comunicar contigo directamente por WhatsApp. Si no te contacta en las próximas horas, escríbeme de nuevo, por favor.";
    }
    return null;
  }

  // Pasó la ventana de espera del HANDOFF y el cliente volvió a escribir:
  // en vez de fingir que nunca pasó nada, se le pregunta si ya se resolvió
  // — si no, se le vuelve a avisar al dueño (puede que nunca se haya
  // comunicado). Determinista a propósito, igual que el aviso de arriba.
  if (session.state === "HANDOFF_CHECKIN") {
    if (!session.slots.preguntoSiResuelto) {
      session.slots.preguntoSiResuelto = true;
      guardar(session);
      return "¡Hola de nuevo! ¿Ya pudiste resolver lo que necesitabas con el equipo, o seguimos esperando?";
    }
    db.eliminarSession(from);
    if (nucleo.esConfirmacion(texto)) {
      return "¡Qué bueno! Cualquier otra cosa que necesites, aquí ando.";
    }
    await avisarEscalacion(
      from.replace("whatsapp:", ""),
      "Un cliente que había escalado hace unas horas sigue sin resolver su tema (o nadie se comunicó con él todavía). Por favor contáctalo."
    );
    return "Disculpa la demora — ya le insistí de nuevo a alguien del equipo para que te contacte lo antes posible.";
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
    return "¡Con mucho gusto! Cancelé el proceso, gracias por avisarme. Aquí estoy cuando quieras intentarlo de nuevo.";
  }

  // Pregunta fuera de flujo: se responde y se repite lo pendiente, sin perder el estado
  if (extracted && extracted.intent === "ask_question" && session.state !== "CONFIRM") {
    guardar(session);
    const respuesta = await responderPreguntaComun(texto, extracted.tema_pregunta, session.slots.formal, session.phone.replace("whatsapp:", ""));
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
  return "Vamos a empezar de nuevo. Dime si quieres agendar una cita.";
}

function registrarIntento(session, verdict) {
  session.attempts = verdict === "ACCEPT" ? 0 : (session.attempts || 0) + 1;
}

async function manejarHandoffSiAplica(session) {
  if (session.attempts >= 3) {
    session.state = "HANDOFF";
    guardar(session);
    await avisarEscalacion(
      session.phone.replace("whatsapp:", ""),
      "El bot no logró entenderse con un cliente después de varios intentos. Contáctalo directamente para ayudarlo con su cita."
    );
    return "Disculpa, creo que no nos estamos entendiendo bien por aquí 😅 Ya le avisé a alguien del equipo para que te ayude directamente, muchas gracias por tu paciencia.";
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

  const handoff = await manejarHandoffSiAplica(session);
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
    opciones, nombreNegocio: negocio.nombre, formal: session.slots.formal,
    citaInfo: infoCitaExistente(session.phone.replace("whatsapp:", "")),
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

  const handoff = await manejarHandoffSiAplica(session);
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
    opciones, nombreNegocio: negocio.nombre, formal: session.slots.formal,
    citaInfo: infoCitaExistente(session.phone.replace("whatsapp:", "")),
  });
  return explicacion
    ? `${explicacion}\n\n${mensajeHoras(session.slots.date, session.offered)}`
    : `No logré identificar bien la hora 🤔 ${mensajeHoras(session.slots.date, session.offered)}`;
}

// Variantes para no repetir la misma frase tal cual si falla dos veces
// seguidas (con una sola frase fija, un segundo intento fallido se sentía
// como un bot descompuesto repitiendo lo mismo sin haber "escuchado").
const REINTENTOS_NOMBRE = [
  "¿Me compartes tu nombre completo, por favor?",
  "Disculpa, creo que no me llegó bien — ¿me compartes tu nombre completo una vez más, por favor?",
];

async function manejarAskName(session, extracted, texto) {
  const nombreCrudo = (extracted && extracted.name) || texto;
  const { verdict, value } = nucleo.validarNombre(nombreCrudo);

  registrarIntento(session, verdict);

  if (verdict === "ACCEPT") {
    session.slots.name = value;
    session.state = "CONFIRM";
    guardar(session);
    return mensajeConfirmacion(session.slots);
  }

  const handoff = await manejarHandoffSiAplica(session);
  if (handoff) return handoff;

  guardar(session);
  const variante = REINTENTOS_NOMBRE[Math.min(session.attempts - 1, REINTENTOS_NOMBRE.length - 1)];
  return variante;
}

async function manejarConfirm(session, extracted, texto) {
  // Mismo cuidado que en el saludo: "Ok, oigan y tienen estacionamiento?"
  // empieza con una palabra de confirmación pero no es un sí real. Este es
  // el candado final antes de escribir en la base de datos, así que ante la
  // duda (el extractor cree que en realidad está preguntando algo) NO se
  // confirma ni se cancela solo por la palabra suelta — se contesta la
  // pregunta primero y se le vuelve a mostrar el resumen para confirmar.
  const pareceOtraCosa = extracted && extracted.intent === "ask_question";

  if (pareceOtraCosa) {
    const respuesta = await responderPreguntaComun(texto, extracted.tema_pregunta, session.slots.formal, session.phone.replace("whatsapp:", ""));
    guardar(session);
    return `${respuesta}\n\n${mensajeConfirmacion(session.slots, !!session.citaId)}`;
  }

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
    return "¡Con mucho gusto! Cancelé el proceso, gracias por avisarme. Aquí estoy cuando quieras intentarlo de nuevo.";
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
  const handoff = await manejarHandoffSiAplica(session);
  if (handoff) return handoff;
  guardar(session);

  const negocio = db.obtenerNegocio();
  const opciones = session.offered && session.offered.options
    ? session.offered.options.map(o => `${o.id}) ${o.label || o.value}`).join("\n")
    : "(ninguna lista activa — se espera confirmación con sí/no, o corregir la fecha/hora)";
  const explicacion = await explicarComoResponder({
    textoUsuario: texto, loQueSeEspera: SLOT_PEDIDO[session.state] || "la información pendiente",
    opciones, nombreNegocio: negocio.nombre, formal: session.slots.formal,
    citaInfo: infoCitaExistente(session.phone.replace("whatsapp:", "")),
  });
  return explicacion
    ? `${explicacion}\n\n${preguntaPendiente(session.state, session)}`
    : `Disculpa, ¿me lo confirmas una vez más? ${preguntaPendiente(session.state, session)}`;
}

module.exports = { manejarMensajePaciente, mensajeRecordatorioAgenda };
