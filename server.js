require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const cron = require("node-cron");

const db = require("./db");
const { interpretar } = require("./parser");
const { parsearFecha, parsearHora, formatoLegible } = require("./dateutils");
const { manejarMensajePaciente } = require("./pacienteFlow");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const NUMERO_RECEPCION = process.env.NUMERO_RECEPCION || "";

const twilioClient = process.env.TWILIO_ACCOUNT_SID
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

async function enviarWhatsApp(to, body) {
  if (!twilioClient) {
    console.log(`[SIMULADO -> ${to}]: ${body}`);
    return { simulado: true, to, body };
  }
  return twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to,
    body,
  });
}

// ================= WEBHOOK: mensajes entrantes de WhatsApp =================
app.post("/webhook/whatsapp", async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || "").trim();
  const esRecepcion = NUMERO_RECEPCION && from === `whatsapp:${NUMERO_RECEPCION}`;

  const respuesta = esRecepcion
    ? await manejarRecepcion(from, body)
    : await manejarMensajePaciente(from, body);

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(respuesta);
  res.type("text/xml").send(twiml.toString());
});

// ================= Lógica: recepción (comandos internos) =================
const pendientes = {}; // { from: { intent, citaId, resumen, fecha?, hora? } }

async function manejarRecepcion(from, body) {
  if (pendientes[from]) {
    const accion = interpretar(body);
    if (accion.intent === "CONFIRMAR") {
      const p = pendientes[from];
      delete pendientes[from];
      return await ejecutarAccion(p);
    }
    if (accion.intent === "RECHAZAR") {
      delete pendientes[from];
      return "Ok, cancelado. No se hizo ningún cambio.";
    }
    return `Tienes una acción pendiente de confirmar:\n"${pendientes[from].resumen}"\n\nResponde SÍ o NO.`;
  }

  const accion = interpretar(body);

  if (accion.intent === "DESCONOCIDO") {
    return "No entendí el comando. Prueba con:\n• \"cancela la cita de [nombre]\"\n• \"cambia la cita de [nombre] al [día] [hora]\"\n• \"envía recordatorio a [nombre]\"";
  }
  if (!accion.nombre) {
    return "No identifiqué el nombre del paciente. ¿Puedes repetirlo incluyendo el nombre completo?";
  }

  const coincidencias = db.buscarPorNombre(accion.nombre).filter(c => c.estado !== "cancelada");

  if (coincidencias.length === 0) {
    return `No encontré ninguna cita activa a nombre de "${accion.nombre}".`;
  }
  if (coincidencias.length > 1) {
    const lista = coincidencias.map(c => `- ${c.paciente} (${formatoLegible(c.fecha, c.hora)})`).join("\n");
    return `Encontré varias coincidencias para "${accion.nombre}":\n${lista}\n\nEscribe el nombre completo para saber a cuál te refieres.`;
  }

  const cita = coincidencias[0];

  // Para REAGENDAR, validamos la nueva fecha/hora contra disponibilidad real
  if (accion.intent === "REAGENDAR") {
    const nuevaFecha = accion.dia ? parsearFecha(accion.dia) : cita.fecha;
    const nuevaHora = accion.hora ? parsearHora(accion.hora) : cita.hora;
    if (!nuevaFecha || !nuevaHora) {
      return "No pude identificar bien la nueva fecha/hora. Intenta de nuevo, ej: \"cambia la cita de Juan al viernes 5pm\".";
    }
    if (!db.horaEstaDisponible(nuevaFecha, nuevaHora) && !(nuevaFecha === cita.fecha && nuevaHora === cita.hora)) {
      const { slots } = db.disponibilidad(nuevaFecha);
      return `Ese horario no está disponible. Libres ese día: ${slots.join(", ") || "ninguno"}.`;
    }
    const resumen = `Cambiar cita de ${cita.paciente} a ${formatoLegible(nuevaFecha, nuevaHora)}`;
    pendientes[from] = { intent: "REAGENDAR", citaId: cita.id, fecha: nuevaFecha, hora: nuevaHora, resumen };
    return `¿Confirmas esto?\n"${resumen}"\n\nResponde SÍ o NO.`;
  }

  const resumen = accion.intent === "CANCELAR"
    ? `Cancelar cita de ${cita.paciente} (${formatoLegible(cita.fecha, cita.hora)})`
    : `Enviar recordatorio manual a ${cita.paciente} (${formatoLegible(cita.fecha, cita.hora)})`;

  pendientes[from] = { intent: accion.intent, citaId: cita.id, resumen };
  return `¿Confirmas esto?\n"${resumen}"\n\nResponde SÍ o NO.`;
}

async function ejecutarAccion(p) {
  const cita = db.obtenerCita(p.citaId);
  if (!cita) return "Esa cita ya no existe.";

  if (p.intent === "CANCELAR") {
    db.cancelarCita(cita.id);
    await enviarWhatsApp(`whatsapp:${cita.telefono}`, `Hola ${cita.paciente}, tu cita del ${formatoLegible(cita.fecha, cita.hora)} ha sido cancelada. Si fue un error, contáctanos.`);
    return `Listo, cancelé la cita de ${cita.paciente} y le avisé por WhatsApp.`;
  }

  if (p.intent === "REAGENDAR") {
    db.reagendarCita(cita.id, p.fecha, p.hora);
    await enviarWhatsApp(`whatsapp:${cita.telefono}`, `Hola ${cita.paciente}, tu cita fue reagendada para el ${formatoLegible(p.fecha, p.hora)}.`);
    return `Listo, moví la cita de ${cita.paciente} a ${formatoLegible(p.fecha, p.hora)} y le avisé por WhatsApp.`;
  }

  if (p.intent === "RECORDATORIO") {
    await enviarWhatsApp(`whatsapp:${cita.telefono}`, `Hola ${cita.paciente}, te recordamos tu cita el ${formatoLegible(cita.fecha, cita.hora)}. ¡Te esperamos!`);
    db.marcarRecordatorioEnviado(cita.id);
    return `Recordatorio enviado a ${cita.paciente}.`;
  }

  return "No supe qué hacer con eso.";
}

// ================= Recordatorios automáticos (cron) =================
// Corre cada 15 min: manda recordatorio a citas dentro de las próximas 24h
// que aún no lo han recibido.
async function correrRecordatorios() {
  const pendientesRecordatorio = db.citasParaRecordatorio(24);
  for (const c of pendientesRecordatorio) {
    await enviarWhatsApp(`whatsapp:${c.telefono}`, `Hola ${c.paciente}, te recordamos tu cita el ${formatoLegible(c.fecha, c.hora)}. ¡Te esperamos!`);
    db.marcarRecordatorioEnviado(c.id);
    console.log(`Recordatorio automático enviado a ${c.paciente}`);
  }
  return pendientesRecordatorio;
}

cron.schedule("*/15 * * * *", correrRecordatorios);

// ================= Rutas API (para el panel / pruebas) =================

app.get("/api/citas", (req, res) => res.json(db.listarCitas()));

app.get("/api/disponibilidad", (req, res) => {
  const fecha = req.query.fecha;
  if (!fecha) return res.status(400).json({ error: "falta ?fecha=YYYY-MM-DD" });
  res.json(db.disponibilidad(fecha));
});

app.get("/api/horario", (req, res) => res.json(db.listarConfigHorario()));

app.post("/api/horario", (req, res) => {
  const { dia_semana, activo, hora_inicio, hora_fin, duracion_slot } = req.body;
  const actualizado = db.actualizarConfigDia(dia_semana, { activo, hora_inicio, hora_fin, duracion_slot });
  res.json(actualizado);
});

// Simular chat de recepción (sin WhatsApp real)
app.post("/api/simular-recepcion", async (req, res) => {
  const { mensaje } = req.body;
  const from = "whatsapp:+SIMULADO_RECEPCION";
  const respuesta = await manejarRecepcion(from, mensaje);
  res.json({ respuesta });
});

// Simular chat de paciente (sin WhatsApp real) — mantiene su propia sesión
app.post("/api/simular-paciente", async (req, res) => {
  const { mensaje, telefono } = req.body;
  const from = `whatsapp:${telefono || "+525599999999"}`;
  const respuesta = await manejarMensajePaciente(from, mensaje);
  res.json({ respuesta });
});

// Disparar el barrido de recordatorios manualmente (para demo)
app.post("/api/enviar-recordatorios", async (req, res) => {
  const resultados = await correrRecordatorios();
  res.json({ resultados });
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  console.log(twilioClient ? "Twilio conectado (modo real)" : "Twilio NO configurado -> modo SIMULADO (revisa .env)");
  console.log("Recordatorios automáticos: corriendo cada 15 min (cron)");
});
