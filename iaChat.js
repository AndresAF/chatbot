// iaChat.js
// Interpretación conversacional del mensaje con el que arranca (o se
// desvía) la conversación del cliente, antes/fuera del flujo estructurado
// de agendado. Decide si hay intención de agendar una cita, y si no,
// genera una respuesta natural y profesional (saludo, pregunta que no
// podemos responder con datos reales, comentario fuera de tema, grosería).

const Anthropic = require("@anthropic-ai/sdk");
const anthropic = new Anthropic();

// Filtro determinista (sin costo de API) para contenido claramente fuera de
// lugar: insultos, violencia, contenido sexual explícito. Se revisa ANTES
// de llamar a Claude para no gastar tokens en estos casos, y para que la
// respuesta sea siempre la misma, predecible, sin depender de que el
// modelo la redacte bien cada vez.
const PATRONES_INAPROPIADOS = [
  /\b(imbecil|imbécil|estupid|idiota|pendej|hijo\s*de\s*puta|maldit|cabron|cabrón|put[oa]|marica|verga|chingu?[aeo]|jod[ae]|mierda|culer[oa]|carajo|gilipollas|zorra|perra)\w*/i,
  /\b(matar|asesinat|asesin[oa]|violenci|golpe[ae]r|disparar|bomba|terroris|suicid)\w*/i,
  /\b(porno|pornograf|sexo\s*explicit|desnud|xxx|nude[s]?)\w*/i,
];

function esMensajeInapropiado(texto) {
  return PATRONES_INAPROPIADOS.some(p => p.test(texto));
}

// Devuelve { quiereAgendar, respuesta } o null si la llamada a Claude falla
// (el caller debe usar su propio respaldo por reglas en ese caso).
async function interpretarMensajeInicial(textoOriginal) {
  try {
    const respuesta = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 512,
      tools: [{
        name: "reportar_intencion",
        description: "Reporta si el cliente quiere agendar una cita, y si no, una respuesta natural para dársela.",
        input_schema: {
          type: "object",
          properties: {
            quiere_agendar: {
              type: "boolean",
              description: "true si el mensaje expresa, de cualquier forma, la intención de querer agendar/reservar una cita."
            },
            respuesta: {
              type: ["string", "null"],
              description: "SOLO si quiere_agendar es false: una respuesta breve, cálida y profesional en español para este mensaje. Si es un saludo, salúdalo y pregunta en qué ayudar. Si es una pregunta que no se puede responder con datos reales (ej. qué hora es 'menos concurrida'), NO inventes datos — invítalo a escribir 'cita' para ver los horarios realmente disponibles. Si el mensaje es grosero, ofensivo o fuera de tema, responde con calma y profesionalismo, sin regañarlo, redirigiendo hacia cómo puedes ayudarle. Nunca confirmes ni prometas una cita en esta respuesta. Si quiere_agendar es true, esto debe ser null."
            }
          },
          required: ["quiere_agendar", "respuesta"],
          additionalProperties: false
        },
        strict: true
      }],
      tool_choice: { type: "tool", name: "reportar_intencion" },
      messages: [{
        role: "user",
        content: `Eres el asistente de WhatsApp de un negocio que agenda citas (puede ser un consultorio, salón, taller, etc.). Un cliente te escribió: "${textoOriginal}"`
      }]
    });

    const bloque = respuesta.content.find(b => b.type === "tool_use");
    if (!bloque) return null;
    return {
      quiereAgendar: !!bloque.input.quiere_agendar,
      respuesta: bloque.input.respuesta || null
    };
  } catch (err) {
    console.error("Error interpretando mensaje inicial con Claude, usando respaldo:", err.message);
    return null;
  }
}

module.exports = { interpretarMensajeInicial, esMensajeInapropiado };
