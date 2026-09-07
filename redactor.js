// redactor.js
// Capa 3 de FLUJO_CONVERSACIONAL.md: convierte datos YA reales/decididos en
// una frase cálida y natural. Nunca inventa un dato que no se le dio (ver
// §9: "Puede: reformular, reconocer con naturalidad. No puede: inventar
// disponibilidad/precios/datos").

const Anthropic = require("@anthropic-ai/sdk");
const anthropic = new Anthropic();

// datosReales: string con lo único que puede usar para responder, o null si
// no hay dato específico para esa pregunta (el redactor debe decir con
// calidez que no lo tiene, sin inventar nada).
async function redactarRespuesta({ pregunta, datosReales, nombreNegocio }) {
  try {
    const respuesta = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 200,
      messages: [{
        role: "user",
        content: `Eres el asistente de WhatsApp de "${nombreNegocio}", un negocio que agenda citas. Tono cálido, amigable y profesional (español de México), cercano pero sin exagerar. Máximo 3 líneas, sin emojis salvo alguno muy natural.

Un cliente preguntó: "${pregunta}"

Datos reales disponibles para responder (no existe más información que esta):
${datosReales || "(no hay un dato específico para esta pregunta)"}

Instrucciones:
- Si los datos de arriba responden la pregunta, contesta con ellos de forma natural. NUNCA inventes ni agregues nada que no esté ahí (precios, promociones, nombres de personal, marcas, etc.).
- Usa negritas de WhatsApp (*así*, con asteriscos) en los datos clave — nombres de servicios, horarios, precios si los hay — para que se vea profesional y fácil de leer, como un catálogo bien presentado.
- Si los datos NO cubren lo que preguntó, dilo con calidez y sin sonar robótico — algo como que no tienes ese dato a la mano ahorita pero con gusto lo puede confirmar alguien del equipo, o que pregunte al llegar.
- No invites tú a agendar una cita al final — eso se agrega aparte, después de tu respuesta. Enfócate solo en contestar la pregunta.
- Escribe SOLO el mensaje de respuesta, nada más (sin comillas, sin explicar lo que hiciste).`
      }]
    });
    const bloque = respuesta.content.find(b => b.type === "text");
    return bloque && bloque.text.trim() ? bloque.text.trim() : null;
  } catch (err) {
    console.error("Error en el redactor (Claude):", err.message);
    return null;
  }
}

module.exports = { redactarRespuesta };
