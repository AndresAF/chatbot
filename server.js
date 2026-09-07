require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const cron = require("node-cron");

const db = require("./db");
const { interpretar } = require("./parser");
const { parsearFecha, parsearHora, formatoLegible } = require("./dateutils");
const { manejarMensajePaciente } = require("./pacienteFlow");

// Red de seguridad: un error inesperado en cualquier parte (una llamada a
// la API de Claude que falla en un lugar no previsto, un bug futuro, etc.)
// se registra en el log, pero nunca tumba el proceso completo. Para un
// negocio vendiendo esto en vivo, es mejor un log con un error que un
// servidor caído hasta que Railway lo reinicie solo.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const NUMERO_RECEPCION = process.env.NUMERO_RECEPCION || "";

const twilioClient = process.env.TWILIO_ACCOUNT_SID
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// Nunca lanza: un envío fallido (límite de Twilio, red, número inválido...)
// no debe tumbar el proceso ni interrumpir el resto del flujo. Devuelve
// { ok, error? } para que el caller decida si vale la pena avisar algo.
async function enviarWhatsApp(to, body) {
  if (!twilioClient) {
    console.log(`[SIMULADO -> ${to}]: ${body}`);
    return { ok: true, simulado: true };
  }
  try {
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to,
      body,
    });
    return { ok: true };
  } catch (err) {
    console.error(`Error enviando WhatsApp a ${to}:`, err.message);
    return { ok: false, error: err.message };
  }
}

// ================= WEBHOOK: mensajes entrantes de WhatsApp =================
app.post("/webhook/whatsapp", async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || "").trim();
  const esRecepcion = NUMERO_RECEPCION && from === `whatsapp:${NUMERO_RECEPCION}`;

  let respuesta;
  try {
    respuesta = esRecepcion
      ? await manejarRecepcion(from, body)
      : await manejarMensajePaciente(from, body);
  } catch (err) {
    console.error("Error procesando mensaje entrante:", err);
    respuesta = "Tuvimos un problema técnico procesando tu mensaje. Por favor intenta de nuevo en un momento.";
  }

  const twiml = new twilio.twiml.MessagingResponse();
  if (respuesta) twiml.message(respuesta);
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
    const r = await enviarWhatsApp(`whatsapp:${cita.telefono}`, `Hola ${cita.paciente}, tu cita del ${formatoLegible(cita.fecha, cita.hora)} ha sido cancelada. Si fue un error, contáctanos.`);
    return r.ok
      ? `Listo, cancelé la cita de ${cita.paciente} y le avisé por WhatsApp.`
      : `Cancelé la cita de ${cita.paciente} en el sistema, pero no le pude avisar por WhatsApp (falló el envío) — avísale tú por otro medio.`;
  }

  if (p.intent === "REAGENDAR") {
    db.reagendarCita(cita.id, p.fecha, p.hora);
    const r = await enviarWhatsApp(`whatsapp:${cita.telefono}`, `Hola ${cita.paciente}, tu cita fue reagendada para el ${formatoLegible(p.fecha, p.hora)}.`);
    return r.ok
      ? `Listo, moví la cita de ${cita.paciente} a ${formatoLegible(p.fecha, p.hora)} y le avisé por WhatsApp.`
      : `Moví la cita de ${cita.paciente} a ${formatoLegible(p.fecha, p.hora)} en el sistema, pero no le pude avisar por WhatsApp (falló el envío) — avísale tú por otro medio.`;
  }

  if (p.intent === "RECORDATORIO") {
    const r = await enviarWhatsApp(`whatsapp:${cita.telefono}`, `Hola ${cita.paciente}, te recordamos tu cita el ${formatoLegible(cita.fecha, cita.hora)}. ¡Te esperamos!`);
    if (r.ok) db.marcarRecordatorioEnviado(cita.id);
    return r.ok
      ? `Recordatorio enviado a ${cita.paciente}.`
      : `No pude enviar el recordatorio a ${cita.paciente} (falló el envío) — intenta de nuevo en un momento.`;
  }

  return "No supe qué hacer con eso.";
}

// ================= Recordatorios automáticos (cron) =================
// Corre cada 15 min: manda recordatorio a citas dentro de las próximas 24h
// que aún no lo han recibido.
async function correrRecordatorios() {
  const pendientesRecordatorio = db.citasParaRecordatorio(24);
  const enviados = [];
  for (const c of pendientesRecordatorio) {
    const resultado = await enviarWhatsApp(`whatsapp:${c.telefono}`, `Hola ${c.paciente}, te recordamos tu cita el ${formatoLegible(c.fecha, c.hora)}. ¡Te esperamos!`);
    if (resultado.ok) {
      db.marcarRecordatorioEnviado(c.id);
      console.log(`Recordatorio automático enviado a ${c.paciente}`);
      enviados.push(c);
    } else {
      console.error(`No se pudo enviar recordatorio a ${c.paciente}, se reintentará en la próxima corrida`);
    }
  }
  return enviados;
}

cron.schedule("*/15 * * * *", async () => {
  try {
    await correrRecordatorios();
  } catch (err) {
    console.error("Error en la corrida de recordatorios automáticos:", err);
  }
});

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

// Nombre/servicios/dirección del negocio — ver el bot los usa para
// contestar preguntas comunes (ver pacienteFlow.js). Trae datos dummy por
// defecto; actualízalos aquí cuando haya un cliente real, ej:
// curl -X POST .../api/negocio -H "Content-Type: application/json" \
//   -d '{"nombre":"...", "servicios":"...", "direccion":"..."}'
app.get("/api/negocio", (req, res) => res.json(db.obtenerNegocio()));

app.post("/api/negocio", (req, res) => {
  const { nombre, servicios, direccion } = req.body;
  const actualizado = db.actualizarNegocio({ nombre, servicios, direccion });
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

// Descarga un respaldo consistente de la base de datos (protegido por token).
// Uso: GET /api/backup?token=TU_BACKUP_TOKEN
app.get("/api/backup", async (req, res) => {
  const BACKUP_TOKEN = process.env.BACKUP_TOKEN;
  if (!BACKUP_TOKEN || req.query.token !== BACKUP_TOKEN) {
    return res.status(401).json({ error: "No autorizado" });
  }

  const os = require("os");
  const path = require("path");
  const fs = require("fs");
  const destino = path.join(os.tmpdir(), `respaldo-${Date.now()}.db`);

  try {
    await db.backup(destino);
    res.download(destino, "consultorio-respaldo.db", () => {
      fs.unlink(destino, () => {});
    });
  } catch (err) {
    console.error("Error generando respaldo:", err);
    res.status(500).json({ error: "No se pudo generar el respaldo" });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  console.log(twilioClient ? "Twilio conectado (modo real)" : "Twilio NO configurado -> modo SIMULADO (revisa .env)");
  console.log("Recordatorios automáticos: corriendo cada 15 min (cron)");
});
