# Especificación del flujo conversacional — Agendado de citas por WhatsApp

> Documento de referencia para el repo. Cualquier cambio en el flujo del bot debe respetar
> lo que está aquí. Si algo del código contradice este documento, el documento gana
> (o se actualiza el documento primero, y luego el código).
>
> **Adaptación a este repo**: el estado `ASK_SERVICE` de la spec original se omite en la
> implementación actual — este negocio todavía no tiene un catálogo de servicios en `db.js`
> (es un solo tipo de cita genérica). Se agrega si algún día existe ese catálogo. Todo lo
> demás de este documento se implementó tal cual.

---

## 0. Principio rector

**La IA entiende y redacta. El código decide.**

El modelo nunca elige el siguiente estado, nunca resuelve una fecha, nunca confirma una cita.
Solo hace dos cosas:

1. **Extraer** intención + datos de un mensaje libre → JSON estricto.
2. **Redactar** el texto final a partir de datos que ya validó el código.

Todo lo demás (transiciones, disponibilidad, fechas, escritura en DB) es código determinista.

Este patrón híbrido es el estándar en asistentes de agendado: la máquina de estados aporta
confiabilidad y límites, mientras el LLM aporta comprensión de lenguaje natural y tono.

---

## 1. Arquitectura en tres capas

```
Mensaje de WhatsApp
        │
        ▼
┌───────────────────────┐
│ 1. EXTRACTOR (LLM)    │  → JSON: { intent, entities, confidence }
│    sin memoria libre  │     No responde al usuario. No decide nada.
└───────────────────────┘
        │
        ▼
┌───────────────────────┐
│ 2. NÚCLEO (código)    │  → Valida contra la agenda real.
│    máquina de estados │     Decide: ACCEPT / CLARIFY / REJECT.
│    + validador        │     Calcula el siguiente estado y los datos a decir.
└───────────────────────┘
        │
        ▼
┌───────────────────────┐
│ 3. REDACTOR (LLM)     │  → Convierte datos ya decididos en una frase natural.
│    o plantilla        │     Si falla o hay timeout → plantilla fija.
└───────────────────────┘
        │
        ▼
Respuesta al usuario
```

La capa 3 es opcional por estado. En estados críticos (mostrar horarios, confirmar cita)
se usa **plantilla pura** y el LLM solo puede agregar una línea de tono, nunca datos.

---

## 2. Estado de sesión

Una fila por conversación (`sessions`), en SQLite. Este objeto es la única fuente de verdad.

```js
{
  phone: "5215512345678",
  state: "ASK_TIME",              // ver §3
  slots: {
    service_id: 3 | null,
    date: "2026-09-04" | null,    // SIEMPRE ISO. Nunca "viernes 4".
    time: "10:30" | null,         // SIEMPRE HH:mm 24h.
    name: "Andrés" | null,
    notes: null
  },
  offered: {                      // lo último que el bot puso sobre la mesa
    kind: "dates" | "times" | "services" | null,
    generated_at: "2026-09-04T01:12:00-06:00",
    options: [
      { id: 1, label: "Viernes 4 de septiembre", value: "2026-09-04" },
      { id: 2, label: "Sábado 5 de septiembre",  value: "2026-09-05" },
      { id: 3, label: "Lunes 7 de septiembre",   value: "2026-09-07" }
    ]
  },
  attempts: 0,                    // reintentos en el estado actual
  last_message_at: "...",
  locale: "es-MX",
  timezone: "America/Mexico_City"
}
```

Reglas duras:

- `slots.date` y `slots.time` **solo** se escriben desde una opción validada. Nunca desde texto libre.
- `offered.options` se regenera cada vez que el bot lista algo, y **caduca** al cambiar de estado.
- Nada avanza de estado si el slot correspondiente sigue en `null`.

---

## 3. Máquina de estados

| Estado | Slot que busca | Sale a | Condición de salida |
|---|---|---|---|
| `GREET` | — | `ASK_SERVICE` | siempre |
| `ASK_SERVICE` | `service_id` | `ASK_DATE` | servicio válido en catálogo |
| `ASK_DATE` | `date` | `ASK_TIME` | fecha existe en `offered.options` y tiene cupo |
| `ASK_TIME` | `time` | `ASK_NAME` | hora existe en `offered.options` de ese día |
| `ASK_NAME` | `name` | `CONFIRM` | string 2–60 chars, no vacío |
| `CONFIRM` | — | `BOOKED` / `ASK_DATE` | usuario dice sí / usuario corrige |
| `BOOKED` | — | `IDLE` | se escribió en DB y se mandó comprobante |
| `HANDOFF` | — | — | se avisa a un humano y el bot calla |

**Prohibido saltar estados.** `ASK_NAME` es inalcanzable si `slots.date` o `slots.time` son `null`.
Esta regla, sola, elimina la mitad de las fallas.

```js
const REQUIRED = {
  ASK_SERVICE: [],
  ASK_DATE: ["service_id"],
  ASK_TIME: ["service_id", "date"],
  ASK_NAME: ["service_id", "date", "time"],
  CONFIRM:   ["service_id", "date", "time", "name"]
};

function canEnter(state, slots) {
  return REQUIRED[state].every(k => slots[k] !== null && slots[k] !== undefined);
}
// Antes de cualquier transición:
if (!canEnter(next, session.slots)) next = firstMissingState(session.slots);
```

---

## 4. Contrato del extractor (LLM #1)

### Salida obligatoria

```json
{
  "intent": "select_option | provide_value | correct | confirm | cancel | ask_question | greet | other",
  "option_id": 1,
  "raw_value": "viernes 4",
  "name": null,
  "confidence": 0.0
}
```

- Devuelve **solo JSON**, sin backticks, sin texto antes ni después.
- Si no está seguro: `confidence` bajo y `option_id: null`. Nunca inventa.
- `option_id` debe ser uno de los ids que el código le pasó. Cualquier otro valor se descarta.

### System prompt (plantilla)

```
Eres un extractor de datos. NO conversas. NO respondes al usuario.
Devuelves únicamente un objeto JSON válido.

Fecha y hora actual: {{now_iso}} ({{weekday_es}}), zona {{timezone}}.
Estado actual de la conversación: {{state}}.
Dato que se está pidiendo: {{slot_name}}.

Opciones que el sistema ya le mostró al usuario:
{{#each offered.options}}
- id {{id}}: "{{label}}" (valor interno {{value}})
{{/each}}

Tarea: mapear el mensaje del usuario a UNA de esas opciones, o clasificar su intención.

Reglas:
- Si el mensaje corresponde a una opción de la lista, devuelve su id exacto.
- Si menciona algo parecido pero ambiguo, option_id = null y confidence < 0.5.
- Si el usuario está corrigiendo algo dicho antes ("dije...", "no, ...", "más bien..."),
  intent = "correct".
- Nunca inventes fechas, horas ni ids que no estén en la lista.
- Nunca resuelvas relativos tú mismo ("mañana", "el viernes"): pásalos en raw_value.

Mensaje del usuario: {{message}}
```

Con `temperature: 0` y `max_tokens` corto. Si el JSON no parsea, se reintenta **una** vez;
al segundo fallo se cae al camino de plantilla (§10).

---

## 5. Resolución de fechas — la regla de oro

> **Nunca parsees una fecha en texto libre si ya mostraste una lista.**

El bug del screenshot es exactamente esto. Se ofreció "Viernes 4 de septiembre" y el usuario
respondió "Viernes 4". El parser ignoró el número `4`, resolvió solo la palabra `viernes` con
lógica de "próximo viernes", y como *hoy ya era viernes*, saltó al 11.

La corrección no es mejorar el regex. Es **no volver a parsear**: la respuesta se resuelve
contra `offered.options`, que ya tiene fechas ISO exactas.

```js
function resolveFromOffered(extracted, offered) {
  if (!offered || !offered.options.length) return null;

  // 1. id explícito devuelto por el extractor
  if (extracted.option_id != null) {
    const hit = offered.options.find(o => o.id === extracted.option_id);
    if (hit) return hit.value;
  }

  // 2. respaldo determinista: normalizar y comparar contra las etiquetas
  const norm = s => s.toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")  // quita acentos
    .replace(/\s+/g, " ").trim();

  const msg = norm(extracted.raw_value || "");

  // coincidencia por número de día ("viernes 4", "el 4", "4")
  const dayNum = msg.match(/\b(\d{1,2})\b/)?.[1];
  if (dayNum) {
    const hit = offered.options.find(o => {
      const d = new Date(o.value + "T12:00:00");
      return String(d.getDate()) === dayNum;
    });
    if (hit) return hit.value;
  }

  // coincidencia por etiqueta contenida
  const hit = offered.options.find(o => norm(o.label).includes(msg) || msg.includes(norm(o.label)));
  return hit ? hit.value : null;
}
```

### Cuándo sí hay texto libre

Solo cuando el usuario escribe una fecha que **no** estaba en la lista ("¿tienen el 15?",
"la próxima semana"). Ahí:

1. Normaliza con anclaje explícito a `now` en `America/Mexico_City`.
2. Consulta disponibilidad real de esa fecha.
3. Vuelve a ofrecer opciones y **regresa al flujo de lista**.

Nota sobre librerías: `chrono-node` es la opción estándar en JS para fechas en lenguaje natural,
pero el español está solo **parcialmente** soportado (los idiomas con soporte completo son
en, ja, fr, nl, ru, uk; es, de, pt y zh van parciales). Sirve como apoyo, no como única fuente
de verdad. Si lo usas:

- Pasa siempre la referencia: `chrono.es.parseDate(txt, refDate, { forwardDate: true })`.
- **Valida el resultado contra la disponibilidad** antes de aceptarlo. Si cae fuera del rango
  de la agenda o en el pasado → `CLARIFY`, no `ACCEPT`.
- Ojo con `forwardDate` cuando hoy es el mismo día de la semana mencionado: es la causa exacta
  del salto de 7 días. Si el usuario menciona un número de día, ese número manda sobre la palabra.

### Formato de las listas que envías

- Numera siempre: `1) Viernes 4 · 2) Sábado 5 · 3) Lunes 7`. Un número es inconfundible.
- Máximo 3–4 opciones por mensaje. La lista de 18 horarios del screenshot es ilegible en móvil.
- Agrupa las horas: `Mañana: 9:00, 10:00, 11:00 · Tarde: 13:00, 15:00, 17:00 · ¿o prefieres otra?`
- Nunca muestres una hora que no vayas a poder reservar 30 segundos después.

---

## 6. Validador — ACCEPT / CLARIFY / REJECT

Entre el extractor y la transición hay un validador determinista. Un JSON con esquema correcto
puede seguir siendo semánticamente inválido ("31 de febrero", "a las 3" cuando cierran a las 2),
así que el esquema no basta: hace falta una capa que decida si se ejecuta.

```js
function validate(state, value, session) {
  if (value == null)                  return { verdict: "CLARIFY", reason: "no_match" };
  if (isPast(value, session.timezone))return { verdict: "REJECT",  reason: "past" };
  if (!isBusinessDay(value))          return { verdict: "CLARIFY", reason: "closed" };
  if (!hasCapacity(value))            return { verdict: "CLARIFY", reason: "full" };
  return { verdict: "ACCEPT", value };
}
```

- `ACCEPT` → escribe el slot, avanza, `attempts = 0`.
- `CLARIFY` → **no avanza**, repite la pregunta reformulada, `attempts++`.
- `REJECT` → no avanza, explica por qué no se puede y ofrece alternativas.

A los 3 `CLARIFY` seguidos en el mismo estado → `HANDOFF` ("te paso con alguien del equipo").
Un bot que da vueltas es peor que un bot que se rinde a tiempo.

---

## 7. Reglas de reparación

El segundo bug del screenshot: el usuario escribió "Dije viernes 4" (una **corrección**) y el bot
lo trató como un dato nuevo y avanzó a pedir el nombre, sin hora seleccionada.

```js
const CORRECTION_MARKERS = /\b(dije|ya dije|no,|más bien|mas bien|era|no es|te dije|repito)\b/i;
```

Cuando `intent === "correct"` o el mensaje matchea el marcador:

1. **No avances de estado, pase lo que pase.**
2. Limpia los slots posteriores al que se está corrigiendo
   (si corrige la fecha → `time = null`).
3. Regenera `offered` para ese slot.
4. Responde reconociendo el error, sin excusas largas:
   *"Perdón — viernes 4 de septiembre. ¿A qué hora te queda mejor?"*

Otras reparaciones:

| Situación | Regla |
|---|---|
| Usuario pregunta algo fuera de flujo (precio, dirección) | Responde la duda, luego **repite la pregunta pendiente** en el mismo mensaje. No pierdas el estado. |
| Usuario manda dos datos juntos ("viernes a las 10") | Extrae ambos, valida ambos, avanza dos estados de golpe. Está permitido. |
| Silencio > 24 h | Sesión expira, `offered` se invalida, se saluda de nuevo. |
| Usuario dice "cancelar" / "ya no" | `IDLE` inmediato, sin insistir. |

---

## 8. Confirmación antes de escribir

Nunca escribas en la DB sin un eco explícito. El mensaje de confirmación es plantilla pura:

```
Te confirmo:
📅 Viernes 4 de septiembre, 10:30
👤 Andrés
📍 [dirección]

¿Está bien? Responde SÍ para confirmar.
```

- Solo `sí / si / confirmo / correcto / va / dale / 👍` cuentan como confirmación.
- Cualquier otra cosa se trata como corrección → §7.
- La escritura en DB es transaccional con re-chequeo de disponibilidad
  (alguien pudo tomar ese horario mientras conversaban). Si se ocupó: disculpa + nuevas opciones.

---

## 9. Dónde puede improvisar la IA

| Puede | No puede |
|---|---|
| Saludar, variar el fraseo, ajustar el tono | Decir una fecha, hora o precio |
| Reformular una pregunta que ya se hizo 2 veces | Confirmar una cita |
| Responder dudas del FAQ (desde texto fijo) | Decidir el siguiente paso |
| Reconocer un error con naturalidad | Inventar disponibilidad |

Prompt del redactor:

```
Redacta en español mexicano, tono cálido y breve (máx. 2 líneas), sin emojis salvo los que se
te den. Escribe SOLO el mensaje.

Datos ya verificados por el sistema (no los cambies, no agregues otros):
{{data_json}}

Objetivo del mensaje: {{goal}}
```

Si el redactor devuelve algo con una fecha u hora que no está en `data_json`, se descarta y se
usa la plantilla. Vale la pena un check simple con regex de dígitos.

---

## 10. Fallbacks

Cada estado tiene una plantilla fija. Si el LLM falla, tarda más de ~3 s, o devuelve algo
inválido, se manda la plantilla. Un mensaje algo robótico es infinitamente mejor que un
mensaje incorrecto o que un silencio.

```js
const FALLBACK = {
  ASK_DATE: "¿Qué día te acomoda? Tengo:\n1) {{d1}}\n2) {{d2}}\n3) {{d3}}",
  ASK_TIME: "Para el {{fecha}} tengo:\n1) {{t1}}  2) {{t2}}  3) {{t3}}\n¿Cuál te late?",
  ASK_NAME: "¿A nombre de quién la agendo?",
  ERROR:    "Se me cruzaron los cables 😅 ¿Me repites eso último?"
};
```

---

## 11. Casos de prueba obligatorios

Estos van como tests automatizados sobre el núcleo, sin llamar al LLM (mockeando el extractor).
Los tres primeros son los del bug reportado.

| # | Contexto | Entrada | Esperado |
|---|---|---|---|
| 1 | Se ofrecieron viernes 4 / sábado 5 / lunes 7, y hoy es viernes 4 | "Viernes 4" | `date = 2026-09-04`. **Nunca** el 11. |
| 2 | Estado `ASK_TIME`, sin hora elegida | "Dije viernes 4" | Sigue en `ASK_TIME`, no pide nombre |
| 3 | Estado `ASK_DATE` | "el 4" | `date = 2026-09-04` |
| 4 | Estado `ASK_DATE` | "mañana" | Resuelve contra `now` en CDMX, valida cupo |
| 5 | Estado `ASK_DATE` | "el 31 de febrero" | `REJECT`, no avanza |
| 6 | Estado `ASK_DATE`, hoy 4 sep | "el 1 de septiembre" | `REJECT` por pasado |
| 7 | Estado `ASK_TIME` | "a las 3" | Desambigua 15:00 vs cerrado, no asume |
| 8 | Estado `ASK_DATE` | "viernes a las 10" | Llena `date` y `time`, salta a `ASK_NAME` |
| 9 | Estado `ASK_NAME` | "¿cuánto cuesta?" | Responde precio **y** vuelve a pedir el nombre |
| 10 | Estado `CONFIRM` | "no, mejor el sábado" | Vuelve a `ASK_TIME` con `date` nueva, `time = null` |
| 11 | Cualquiera | extractor devuelve JSON roto | Usa plantilla, no truena |
| 12 | `CONFIRM` | horario tomado por otro usuario | Disculpa + nuevas opciones |

---

## 12. Checklist de implementación

Orden sugerido. Cada punto es un commit.

- [ ] Tabla `sessions` con `state`, `slots`, `offered` (JSON), `attempts`.
- [ ] Constante `REQUIRED` + guarda `canEnter()` antes de toda transición.
- [ ] Guardar `offered.options` con ids cada vez que el bot lista algo.
- [ ] `resolveFromOffered()` + eliminar todo parseo suelto de fechas en el flujo de lista.
- [ ] Validador `ACCEPT / CLARIFY / REJECT` con re-chequeo de disponibilidad.
- [ ] Detector de corrección (`intent: correct` + regex) que bloquea el avance.
- [ ] Contador `attempts` → `HANDOFF` a los 3.
- [ ] Extractor con `temperature: 0`, JSON estricto, 1 reintento.
- [ ] Plantillas de fallback por estado.
- [ ] Recortar listas a 3–4 opciones numeradas, horas agrupadas.
- [ ] Eco de confirmación + escritura transaccional.
- [ ] Los 12 tests de §11 corriendo sin LLM.
- [ ] Log por turno: `{state_in, message, extracted, verdict, state_out}` — sin esto no se
      puede depurar nada.

---

## 13. Errores que ya se cometieron (no repetir)

1. **Resolver "viernes" con lógica de próximo día de la semana cuando hoy es viernes.**
   Si el usuario dice un número de día, ese número manda.
2. **Avanzar de estado sin que el slot esté lleno.** Pedir el nombre sin hora confirmada.
3. **Listar 18 horarios en un solo mensaje.** Ilegible y sube la ambigüedad.
4. **Tratar una corrección como dato nuevo.** "Dije X" nunca debe avanzar el flujo.
5. **Dejar que el LLM redacte fechas.** Las fechas se imprimen desde el objeto validado.
