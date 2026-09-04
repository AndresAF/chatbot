// test/nucleo.test.js
// Pruebas del §11 de FLUJO_CONVERSACIONAL.md que se pueden correr sobre el
// núcleo puro, sin llamar al LLM ni a la base de datos (se mockea el
// extractor con objetos {option_id, raw_value, intent}).
//
// Correr con: node --test test/

const test = require("node:test");
const assert = require("node:assert/strict");
const nucleo = require("../nucleo");

const OFERTA_FECHAS = {
  kind: "dates",
  options: [
    { id: 1, label: "Viernes 4 de septiembre", value: "2026-09-04" },
    { id: 2, label: "Sabado 5 de septiembre", value: "2026-09-05" },
    { id: 3, label: "Lunes 7 de septiembre", value: "2026-09-07" },
  ],
};

const OFERTA_HORAS = {
  kind: "times",
  options: [
    { id: 1, label: "09:00", value: "09:00" },
    { id: 2, label: "10:30", value: "10:30" },
    { id: 3, label: "15:00", value: "15:00" },
  ],
};

// --- Caso 1: "Viernes 4" con hoy = viernes 4 -> debe dar el 4, nunca el 11 ---
test("caso 1: resuelve 'Viernes 4' a la fecha ofrecida exacta, no a 'próximo viernes'", () => {
  const extracted = { option_id: null, raw_value: "Viernes 4", intent: "provide_value" };
  const resultado = nucleo.resolveFromOffered(extracted, OFERTA_FECHAS);
  assert.equal(resultado, "2026-09-04");
});

// --- Caso 2: "Dije viernes 4" durante ASK_TIME es una corrección, no una hora ---
test("caso 2: 'Dije viernes 4' se detecta como corrección, no se confunde con una hora", () => {
  const esCorreccion = nucleo.esCorreccion({ intent: "correct" }, "Dije viernes 4");
  assert.equal(esCorreccion, true);

  // Y si se le pasara (por error) como respuesta de hora, no debe matchear ninguna
  const comoHora = nucleo.resolveFromOffered({ option_id: null, raw_value: "Dije viernes 4" }, OFERTA_HORAS);
  assert.equal(comoHora, null);
});

// --- Caso 3: "el 4" resuelve por número de día ---
test("caso 3: 'el 4' resuelve la fecha ofrecida cuyo día del mes es 4", () => {
  const extracted = { option_id: null, raw_value: "el 4" };
  assert.equal(nucleo.resolveFromOffered(extracted, OFERTA_FECHAS), "2026-09-04");
});

// --- Caso 5: fecha inválida (31 de febrero no existe en las opciones) -> no matchea nada ---
test("caso 5: una fecha que no está en las opciones no resuelve nada (CLARIFY, no invento)", () => {
  const extracted = { option_id: null, raw_value: "31 de febrero" };
  assert.equal(nucleo.resolveFromOffered(extracted, OFERTA_FECHAS), null);
});

// --- Caso 6: fecha pasada -> REJECT ---
test("caso 6: validarFecha rechaza una fecha anterior a hoy", () => {
  const disponibilidad = { abierto: true, slots: ["09:00"] };
  const r = nucleo.validarFecha("2026-09-01", disponibilidad, "2026-09-04");
  assert.equal(r.verdict, "REJECT");
  assert.equal(r.reason, "past");
});

// --- Caso 10: en CONFIRM, dar una fecha nueva vuelve a ASK_TIME con time null ---
// (la parte de "vuelve a ASK_TIME" vive en pacienteFlow.js/manejarCorreccion;
// aquí solo probamos que la fecha nueva sí resuelve distinto a la anterior)
test("caso 10: una fecha nueva mencionada en CONFIRM resuelve a un valor distinto al ya guardado", () => {
  const extracted = { option_id: null, raw_value: "mejor el sabado" };
  const resultado = nucleo.resolveFromOffered(extracted, OFERTA_FECHAS);
  assert.equal(resultado, "2026-09-05");
  assert.notEqual(resultado, "2026-09-04");
});

// --- Caso 11: extractor devuelve null (JSON roto / falla de API) -> no truena ---
test("caso 11: resolveFromOffered no truena si el extractor devolvió null", () => {
  assert.doesNotThrow(() => nucleo.resolveFromOffered(null, OFERTA_FECHAS));
  assert.equal(nucleo.resolveFromOffered(null, OFERTA_FECHAS), null);
});

// --- canEnter / firstMissingState: no se puede saltar a ASK_NAME sin hora ---
test("canEnter: ASK_NAME es inalcanzable si falta la hora", () => {
  const slots = { date: "2026-09-04", time: null, name: null };
  assert.equal(nucleo.canEnter("ASK_NAME", slots), false);
  assert.equal(nucleo.firstMissingState(slots), "ASK_TIME");
});

test("canEnter: CONFIRM solo se alcanza con los tres slots llenos", () => {
  assert.equal(nucleo.canEnter("CONFIRM", { date: "2026-09-04", time: "10:00", name: "Ana" }), true);
  assert.equal(nucleo.canEnter("CONFIRM", { date: "2026-09-04", time: "10:00", name: null }), false);
});

test("esConfirmacion / esRechazo reconocen las palabras del §8", () => {
  assert.equal(nucleo.esConfirmacion("si"), true);
  assert.equal(nucleo.esConfirmacion("Sí"), true);
  assert.equal(nucleo.esConfirmacion("confirmo"), true);
  assert.equal(nucleo.esConfirmacion("dale"), true);
  assert.equal(nucleo.esRechazo("no"), true);
  assert.equal(nucleo.esConfirmacion("no, mejor el sabado"), false);
});
