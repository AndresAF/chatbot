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
      max_tokens: 120,
      messages: [{
        role: "user",
        content: `Eres el asistente de WhatsApp de "${nombreNegocio}", un negocio que agenda citas. Tono cálido y profesional (español de México), pero CONCISO — como escribiría una persona real por WhatsApp, no un párrafo de marketing. Máximo 1-2 líneas cortas. Sin relleno ("con gusto te comento que...", "para tu información..."), sin repetir la pregunta del cliente, ve directo al dato. Sin emojis salvo alguno muy natural y solo si de verdad aporta.

Un cliente preguntó: "${pregunta}"

Datos reales disponibles para responder (no existe más información que esta):
${datosReales || "(no hay un dato específico para esta pregunta)"}

Instrucciones:
- Si los datos de arriba responden la pregunta (aunque sea aproximado, ej. un precio "desde $X"), contesta con ellos de forma natural y CON CONFIANZA — no lo diluyas ni lo remitas a "que alguien te lo confirme" si el dato ya está ahí arriba. Esto es una demo de venta: entre más autosuficiente se vea el asistente, mejor. NUNCA inventes ni agregues nada que no esté en los datos (una promoción, un precio exacto no listado, nombres de personal, marcas, etc.) — si el dato es "desde $X", dilo tal cual como aproximado, no como precio fijo. No listes TODOS los datos si el cliente preguntó por algo específico — responde solo lo que preguntó.
- Usa negritas de WhatsApp (*así*, con asteriscos) en los datos clave — nombres de servicios, horarios, precios si los hay.
- Solo si los datos arriba genuinamente NO cubren lo que preguntó, dilo con calidez y sin sonar robótico — algo como que no tienes ese dato a la mano ahorita pero con gusto lo puede confirmar alguien del equipo. No uses esta salida si el dato SÍ está disponible arriba.
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

// Cuando el núcleo no logra resolver la respuesta del cliente contra las
// opciones YA ofrecidas (ver nucleo.resolveFromOffered), en vez de repetir
// un mensaje genérico de "no entendí" se le pide a Claude que interprete el
// texto libre y explique con calidez cómo responder — usando SOLO las
// opciones reales que se le pasan (nunca inventa disponibilidad nueva).
async function explicarComoResponder({ textoUsuario, loQueSeEspera, opciones, nombreNegocio }) {
  try {
    const respuesta = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: `Eres el asistente de WhatsApp de "${nombreNegocio}", agendando una cita. El cliente escribió: "${textoUsuario}" y no logramos identificar ${loQueSeEspera} a partir de eso.

Opciones válidas ahora mismo (son las únicas reales, no inventes otras ni disponibilidad nueva):
${opciones}

Escribe un mensaje MUY breve (1-2 líneas cortas, sin relleno), cálido y claro, en español de México, que le explique amablemente que no le entendiste bien y cómo puede responder correctamente — usando SOLO esas opciones (ej. el número de la opción, o el día/hora tal cual aparece arriba). No repitas la lista completa de opciones (eso se muestra aparte). No expliques lo que hiciste, escribe solo el mensaje.`
      }]
    });
    const bloque = respuesta.content.find(b => b.type === "text");
    return bloque && bloque.text.trim() ? bloque.text.trim() : null;
  } catch (err) {
    console.error("Error en explicarComoResponder (Claude):", err.message);
    return null;
  }
}

module.exports = { redactarRespuesta, explicarComoResponder };
