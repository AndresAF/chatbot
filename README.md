# Asistente de citas — MVP vendible

Sistema para consultorios: **agendado real por WhatsApp** (el paciente elige
día/hora contra la disponibilidad de verdad del consultorio), **recordatorios
automáticos** (corren solos cada 15 min, sin que nadie los dispare), y un
**chat interno** donde la recepcionista escribe comandos en lenguaje natural
("cancela la cita de Juan Pérez") con confirmación antes de ejecutar.

Los datos se guardan en una base de datos real (SQLite) que persiste aunque
reinicies el servidor — ya no es una simulación en memoria.

## Qué puedes probar HOY sin Twilio configurado

El sistema corre en **modo simulado** de fábrica — no necesitas cuenta de
Twilio para ver la lógica funcionando.

```bash
npm install
npm start
```

Abre `http://localhost:3000` en el navegador. Ahí puedes:
- **Simular ser un paciente nuevo** (columna central): escribe "cita" y
  sigue el flujo real — el sistema te pregunta día, te muestra los horarios
  que de verdad están libres (calculados contra el horario del consultorio
  y las citas ya tomadas), pide tu nombre, y confirma. La cita se guarda
  de verdad y aparece en la agenda.
- Ver la agenda de citas, ya persistente.
- Escribir comandos en el chat de "Recepción" y ver cómo el sistema
  interpreta, valida disponibilidad, pide confirmación, y ejecuta el cambio.
- Disparar el barrido de recordatorios manualmente (botón), o dejar que
  el cron interno lo haga solo cada 15 minutos.

Esto ya es un sistema completo para demo y para uso real en modo simulado —
solo falta conectar Twilio para que los mensajes salgan de verdad.

## Cuando quieras conectarlo a WhatsApp real (sandbox de Twilio)

1. Crea una cuenta gratis en [twilio.com](https://www.twilio.com/try-twilio).
2. En la consola, ve a **Messaging → Try it out → Send a WhatsApp message**
   para activar el sandbox. Te dará un número (normalmente
   `+1 415 523 8886`) y un código tipo `join palabra-clave`.
3. Desde tu celular, manda ese código por WhatsApp al número del sandbox.
   Repite esto con cualquier otro número que quieras usar de prueba
   (ej. el número que hará de "recepcionista").
4. Copia `.env.example` a `.env` y llena:
   - `TWILIO_ACCOUNT_SID` y `TWILIO_AUTH_TOKEN` (están en el dashboard
     principal de Twilio Console).
   - `TWILIO_WHATSAPP_FROM=whatsapp:+14155238886` (o el número que te
     hayan dado).
   - `NUMERO_RECEPCION` con el número que se unió al sandbox y que va a
     mandar los comandos internos.
5. Para que Twilio pueda mandarte los mensajes entrantes a tu servidor
   local, necesitas exponerlo a internet temporalmente. La forma más
   simple es [ngrok](https://ngrok.com/):
   ```bash
   npx ngrok http 3000
   ```
   Te dará una URL pública tipo `https://algo.ngrok-free.app`.
6. En Twilio Console, en la configuración del sandbox de WhatsApp, pega
   esa URL + `/webhook/whatsapp` en el campo **"When a message comes in"**.
7. Reinicia el servidor (`npm start`) y ¡ya puedes mandar y recibir
   WhatsApp real dentro del sandbox!

## Estructura del proyecto

```
server.js       -> Express + webhook de Twilio + rutas API + cron de recordatorios
db.js           -> SQLite: citas, horario del consultorio, cálculo de disponibilidad
dateutils.js    -> interpreta fechas/horas en español ("mañana", "5pm") <-> ISO/24h
pacienteFlow.js -> máquina de estados: la conversación del paciente para agendar solo
parser.js       -> interpreta los comandos de la recepcionista
public/         -> interfaz visual (agenda + chat paciente + chat recepción)
consultorio.db  -> se crea solo al arrancar (SQLite, no se sube al repo)
```

## Horario del consultorio

Por default: Lunes a Viernes 9:00-18:00, Sábado 9:00-14:00, citas de 30 min.
Se puede consultar/cambiar vía API:
```bash
GET  /api/horario
POST /api/horario   { "dia_semana": 1, "activo": true, "hora_inicio": "09:00", "hora_fin": "19:00", "duracion_slot": 30 }
```
(0=domingo … 6=sábado). Más adelante esto se puede exponer en la UI para que
el propio consultorio lo edite sin tocar código.

## Nota importante sobre el parser de comandos

A propósito, el intérprete de comandos de la recepcionista NO ejecuta nada
directo — reconoce la intención (cancelar / reagendar / recordatorio), busca
la cita, valida disponibilidad si aplica, y **siempre pide confirmación
(sí/no)** antes de tocar la agenda real. Mismo criterio para el paciente:
la cita solo se guarda tras un "sí" explícito. Esto evita que un error de
interpretación cancele o mueva la cita equivocada.

## Recordatorios automáticos

Un cron interno (`node-cron`) corre cada 15 minutos y manda recordatorio a
toda cita confirmada dentro de las próximas 24 horas que no lo haya recibido
todavía. No requiere que nadie lo dispare — así se comportaría en producción.

## Limitación conocida (aceptable para MVP)

El estado de la conversación del paciente (en qué paso va: pidiendo día,
pidiendo hora, etc.) vive en memoria, no en la base de datos. Si el servidor
se reinicia a la mitad de una conversación, esa persona tendría que volver
a escribir "cita" desde cero. Las citas YA CONFIRMADAS no se pierden (esas
sí están en SQLite) — solo se perdería una conversación a medias.

## Siguiente paso natural (cuando haya cliente pagando)

1. Conectar Twilio real (ver sección de arriba) en vez de modo simulado.
2. Decidir si el número de WhatsApp queda bajo tu cuenta de Meta Business
   (tú administras, cobras mensualidad) o se migra a la cuenta del cliente.
3. Reemplazar SQLite por MySQL/Prisma si el negocio crece a multi-sucursal
   o necesitas correr en un servidor con más de una instancia.
4. La especialización dental (triage/cotización por IA) se agrega después,
   como upsell, sin tocar la base de agendado/recordatorios que ya funciona.
