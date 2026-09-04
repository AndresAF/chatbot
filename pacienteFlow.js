// pacienteFlow.js
// Conversación paso a paso para que el PACIENTE agende solo, contra la
// disponibilidad real del consultorio. Estado en memoria por número de
// teléfono (se resetea si el servidor se reinicia -> aceptable para MVP).

const db = require("./db");
const { parsearFecha, parsearHora, formatoLegible } = require("./dateutils");
const { interpretarMensajeInicial } = require("./iaChat");

const estados = {}; // { "whatsapp:+52...": { paso, fecha, hora, nombre } }

function reset(from) { delete estados[from]; }

function listaDisponibilidad(dias) {
  return dias.map(d => `📅 ${formatoLegible(d.fecha, "")}: ${d.slots.slice(0, 6).join(", ")}${d.slots.length > 6 ? "…" : ""}`).join("\n");
}

async function manejarMensajePaciente(from, textoOriginal) {
  const texto = textoOriginal.trim();
  const estado = estados[from];

  // --- Inicio de conversación (o cualquier mensaje fuera del flujo de agendado) ---
  if (!estado) {
    const iniciarAgendado = () => {
      estados[from] = { paso: "PIDIENDO_DIA" };
      const sugerencias = db.proximosDiasConDisponibilidad(3);
      if (sugerencias.length === 0) {
        return "Por ahora no tenemos horarios disponibles próximamente. En breve nos pondremos en contacto contigo.";
      }
      return `¡Hola! Con gusto te agendamos. ¿Qué día te gustaría venir? (ej. "mañana", "jueves", "15 de septiembre")\n\nAlgunos días con espacio:\n${listaDisponibilidad(sugerencias)}`;
    };

    const resultado = await interpretarMensajeInicial(texto);
    if (resultado) {
      return resultado.quiereAgendar
        ? iniciarAgendado()
        : (resultado.respuesta || "Gracias por tu mensaje. Escribe \"cita\" si quieres agendar una consulta.");
    }

    // Respaldo por reglas si la llamada a Claude falla
    if (/cita|agendar|agénda|reservar|consulta|quiero/i.test(texto)) {
      return iniciarAgendado();
    }
    return "Gracias por tu mensaje. Escribe \"cita\" si quieres agendar una consulta.";
  }

  // --- Esperando el día ---
  if (estado.paso === "PIDIENDO_DIA") {
    const { valor: fecha, mensaje: aclaracion } = await parsearFecha(texto);
    if (!fecha) {
      return aclaracion;
    }
    const { abierto, slots } = db.disponibilidad(fecha);
    if (!abierto) {
      return "Ese día no tenemos servicio. ¿Qué otro día te acomoda?";
    }
    if (slots.length === 0) {
      const alt = db.proximosDiasConDisponibilidad(3, new Date(fecha + "T00:00:00"));
      return `Ese día ya no hay horarios libres. Estas son las próximas fechas con espacio:\n${listaDisponibilidad(alt)}\n\n¿Cuál prefieres?`;
    }
    estados[from] = { ...estado, paso: "PIDIENDO_HORA", fecha };
    return `Para ${formatoLegible(fecha, "")} tenemos estos horarios libres:\n${slots.join(", ")}\n\n¿Cuál te acomoda?`;
  }

  // --- Esperando la hora ---
  if (estado.paso === "PIDIENDO_HORA") {
    const { valor: hora, mensaje: aclaracion } = await parsearHora(texto);
    if (!hora) {
      return aclaracion;
    }
    if (!db.horaEstaDisponible(estado.fecha, hora)) {
      const { slots } = db.disponibilidad(estado.fecha);
      return `Esa hora no está disponible. Los horarios libres ese día son: ${slots.join(", ")}. ¿Cuál eliges?`;
    }
    estados[from] = { ...estado, paso: "PIDIENDO_NOMBRE", hora };
    return "¡Perfecto! ¿A nombre de quién agendamos la cita?";
  }

  // --- Esperando el nombre ---
  if (estado.paso === "PIDIENDO_NOMBRE") {
    if (texto.length < 2) {
      return "¿Puedes escribir tu nombre completo, por favor?";
    }
    estados[from] = { ...estado, paso: "CONFIRMANDO", nombre: texto };
    return `Confirmo: cita para ${texto} el ${formatoLegible(estado.fecha, estado.hora)}.\n\n¿Es correcto? (SÍ / NO)`;
  }

  // --- Confirmación final ---
  if (estado.paso === "CONFIRMANDO") {
    if (/^si|^sí|correcto|confirmo/i.test(texto)) {
      // Doble check de disponibilidad (por si alguien más la tomó mientras tanto)
      if (!db.horaEstaDisponible(estado.fecha, estado.hora)) {
        reset(from);
        return "Justo se ocupó ese horario mientras confirmábamos. Escribe \"cita\" para ver los horarios disponibles de nuevo.";
      }
      const telefono = from.replace("whatsapp:", "");
      db.crearCita({ paciente: estado.nombre, telefono, fecha: estado.fecha, hora: estado.hora });
      const resumen = `¡Listo! Tu cita quedó agendada para el ${formatoLegible(estado.fecha, estado.hora)}. Te mandaremos un recordatorio antes. Si necesitas cambiarla, escríbenos.`;
      reset(from);
      return resumen;
    }
    if (/^no/i.test(texto)) {
      reset(from);
      return "Sin problema, cancelé el proceso. Escribe \"cita\" cuando quieras intentarlo de nuevo.";
    }
    return "Responde SÍ para confirmar o NO para cancelar el proceso.";
  }

  reset(from);
  return "Vamos a empezar de nuevo. Escribe \"cita\" si quieres agendar.";
}

module.exports = { manejarMensajePaciente };
