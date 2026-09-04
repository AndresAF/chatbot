// extractor.js
// Capa 1 de FLUJO_CONVERSACIONAL.md: el LLM extrae intención + datos de un
// mensaje libre a JSON estricto. No conversa, no responde al usuario, no
// decide nada — eso lo hace nucleo.js (capa 2).

const Anthropic = require("@anthropic-ai/sdk");
const anthropic = new Anthropic();

const DIAS_ES = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];

// { mensaje, estado, slotPedido, offered, ahora, timezone } -> objeto extraído, o null si falla.
async function extraer({ mensaje, estado, slotPedido, offered, ahora, timezone }) {
  const diaSemana = DIAS_ES[ahora.getDay()];
  const opcionesTexto = offered && offered.options && offered.options.length
    ? offered.options.map(o => `- id ${o.id}: "${o.label}" (valor interno ${o.value})`).join("\n")
    : "(ninguna — todavía no se le ha mostrado una lista)";

  try {
    const respuesta = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 512,
      temperature: 0,
      tools: [{
        name: "reportar_extraccion",
        description: "Extrae la intención y los datos del mensaje de un cliente que está agendando una cita. No conversa, no responde al usuario.",
        input_schema: {
          type: "object",
          properties: {
            intent: {
              type: "string",
              enum: ["select_option", "provide_value", "correct", "confirm", "cancel", "ask_question", "greet", "other"],
              description: "select_option/provide_value: está respondiendo lo que se le pidió. correct: está corrigiendo algo que dijo antes ('dije...', 'no, ...', 'más bien...'). confirm: confirma algo (solo aplica si el estado es CONFIRM). cancel: quiere dejar de agendar. ask_question: pregunta algo que no es la respuesta pedida (precio, dirección, disponibilidad general). greet: es solo un saludo sin más contenido. other: cualquier otra cosa."
            },
            option_id: {
              type: ["integer", "null"],
              description: "El id exacto de la lista de opciones que el mensaje elige, o null si no elige ninguna con certeza."
            },
            raw_value: {
              type: ["string", "null"],
              description: "Si el usuario da un dato que NO estaba en la lista de opciones (fecha, hora, o nombre en texto libre), cópialo aquí tal cual lo dijo. Nunca lo resuelvas tú (nunca conviertas 'mañana' o 'el viernes' a una fecha) — eso lo hace el código."
            },
            name: {
              type: ["string", "null"],
              description: "Si el mensaje da el nombre de la persona para la cita, ponlo aquí."
            },
            confidence: {
              type: "number",
              description: "Qué tan seguro estás de option_id/raw_value, de 0 a 1. Si es ambiguo, usa un número bajo (<0.5) y option_id null."
            }
          },
          required: ["intent", "option_id", "raw_value", "name", "confidence"],
          additionalProperties: false
        },
        strict: true
      }],
      tool_choice: { type: "tool", name: "reportar_extraccion" },
      messages: [{
        role: "user",
        content: `Fecha y hora actual: ${ahora.toISOString()} (${diaSemana}), zona ${timezone}.
Estado actual de la conversación: ${estado}.
Dato que se está pidiendo: ${slotPedido}.

Opciones que el sistema ya le mostró al usuario:
${opcionesTexto}

Reglas:
- Si el mensaje corresponde a una de esas opciones, devuelve su id exacto en option_id.
- Nunca inventes ni calcules fechas/horas — si no está en la lista, copia lo que dijo en raw_value tal cual.
- Un número de día mencionado junto a un nombre de día de la semana (ej. "viernes 4") manda sobre la palabra: pásalo íntegro en raw_value, el código lo resuelve.

Mensaje del cliente: "${mensaje}"`
      }]
    });

    const bloque = respuesta.content.find(b => b.type === "tool_use");
    return bloque ? bloque.input : null;
  } catch (err) {
    console.error("Error en el extractor (Claude):", err.message);
    return null;
  }
}

module.exports = { extraer };
