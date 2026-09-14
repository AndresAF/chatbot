// redactor.js
// Capa 3 de FLUJO_CONVERSACIONAL.md: convierte datos YA reales/decididos en
// una frase cálida y natural. Nunca inventa un dato que no se le dio (ver
// §9: "Puede: reformular, reconocer con naturalidad. No puede: inventar
// disponibilidad/precios/datos").

const Anthropic = require("@anthropic-ai/sdk");
const anthropic = new Anthropic();

// Guía de tono compartida por ambas funciones de este archivo — cálida y
// profesional como una persona real del mostrador, con una lista concreta de
// lo que nunca debe sonar (jerga, piropos, formulario, venta motivacional).
const VOZ_BASE = `VOZ: cálida, atenta y profesional — como una persona real del mostrador, no un bot. Frases completas y bien escritas, con acentos y puntuación. Amabilidad concreta, no adornada ("con gusto te lo reviso"), sin exagerar.
Nunca uses: jerga o coloquialismos ("qué onda", "va", "porfa", "sale", "chido"), apodos o piropos ("bella", "reina", "corazón", "amiga", "mi vida", comentarios sobre el físico de la persona), MAYÚSCULAS sostenidas o signos repetidos (!!!, ???), muletillas ("jeje"), frases de formulario ("Estimado cliente", "Su solicitud ha sido recibida", "Quedo a sus órdenes") ni frases de venta motivacional ("¡Date ese gusto!", "¡Tú te lo mereces!").`;

function tratoSegunFormalidad(formal) {
  return formal
    ? "El cliente te habla de usted — respóndele de usted (ej. \"¿le acomoda...?\", \"con gusto se lo reviso\"), nunca de tú."
    : "Usa tú, con respeto (ej. \"¿te acomoda...?\").";
}

// datosReales: string con lo único que puede usar para responder, o null si
// no hay dato específico para esa pregunta (el redactor debe decir con
// calidez que no lo tiene, sin inventar nada).
async function redactarRespuesta({ pregunta, datosReales, nombreNegocio, formal = false }) {
  try {
    const respuesta = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 120,
      messages: [{
        role: "user",
        content: `Eres el asistente de WhatsApp de "${nombreNegocio}", un negocio que agenda citas.

${VOZ_BASE}
${tratoSegunFormalidad(formal)}

Además, sé breve — 1-3 líneas, no un párrafo de marketing. Pero breve NO es lo mismo que seco: un mensaje de una frase pelona ("Ofrecemos manicure.") se siente cortante y frío, no profesional. Escribe como alguien que de verdad quiere ayudar: reconoce lo que preguntó en unas palabras y contesta con calidez ("Claro, el manicure...", "Con gusto — el corte..."). Sin relleno de más ("para tu información...", repetir la pregunta completa), pero sí con el calorcito de una persona real. Sin emojis salvo alguno muy natural y solo si de verdad aporta.

Un cliente preguntó: "${pregunta}"

Datos reales disponibles para responder (no existe más información que esta):
${datosReales || "(no hay un dato específico para esta pregunta)"}

Instrucciones:
- Antes de decir que no tienes un dato, REVISA la lista con cuidado — casi siempre el dato que preguntan (precio de un servicio puntual, por ejemplo) SÍ está ahí, solo hay que ubicarlo en la lista.
- Si los datos de arriba responden la pregunta (aunque sea aproximado, ej. un precio "desde $X"), contesta con ellos de forma natural y CON CONFIANZA — no lo diluyas ni lo remitas a "que alguien te lo confirme" si el dato ya está ahí arriba. Esto es una demo de venta: entre más autosuficiente se vea el asistente, mejor. NUNCA inventes ni agregues nada que no esté en los datos (una promoción, un precio exacto no listado, nombres de personal, marcas, etc.) — si el dato es "desde $X", dilo tal cual como aproximado, no como precio fijo. No listes TODOS los datos si el cliente preguntó por algo específico — responde solo lo que preguntó.
- Usa negritas de WhatsApp (*así*, con asteriscos) en los datos clave — nombres de servicios, horarios, precios si los hay.
- Solo si los datos arriba genuinamente NO cubren lo que preguntó (revisaste bien y de plano no está), dilo con calidez y sin sonar robótico — algo como que no tienes ese dato a la mano ahorita pero con gusto lo puede confirmar alguien del equipo. No uses esta salida si el dato SÍ está disponible arriba.
- NUNCA preguntes ni menciones si quiere agendar una cita — eso se agrega aparte, automáticamente, después de tu mensaje. Si tú también lo mencionas, la pregunta queda duplicada y se ve mal. Enfócate solo en contestar lo que preguntó, nada más.
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
async function explicarComoResponder({ textoUsuario, loQueSeEspera, opciones, nombreNegocio, formal = false, citaInfo }) {
  try {
    const respuesta = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: `Eres el asistente de WhatsApp de "${nombreNegocio}", agendando una cita. El cliente escribió: "${textoUsuario}" y no logramos identificar ${loQueSeEspera} a partir de eso.

${VOZ_BASE}
${tratoSegunFormalidad(formal)}

Opciones válidas ahora mismo (son las únicas reales, no inventes otras ni disponibilidad nueva):
${opciones}
${citaInfo ? `\nDato real sobre este cliente (úsalo si su mensaje en realidad pregunta o comenta sobre una cita que ya tenía, en vez de tratarlo como que no supiste identificar ${loQueSeEspera}): ${citaInfo}\n` : ""}
Escribe un mensaje MUY breve (1-2 líneas cortas, sin relleno) que le explique amablemente que no le entendiste bien y cómo puede responder correctamente — usando SOLO esas opciones (ej. el número de la opción, o el día/hora tal cual aparece arriba). No repitas la lista completa de opciones (eso se muestra aparte). No inventes datos que no estén arriba. No expliques lo que hiciste, escribe solo el mensaje.`
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
