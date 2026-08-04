# Sofía WhatsApp Endpoint v1

Endpoint oficial para que el runtime de WhatsApp consulte a Sofía Tapia como primera línea de Rioble Inmobiliaria.

```http
POST /decide-whatsapp
```

## Implementación MVP Con OpenClaw

Para este MVP, `/decide-whatsapp` se atiende con un bridge local:

```text
integraciones/sofia_openclaw_bridge.py
```

El bridge recibe el JSON de n8n, valida la allowlist de prueba y ejecuta a Sofía mediante OpenClaw:

```bash
openclaw agent --agent realestate-sales --session-key agent:realestate-sales:whatsapp-<telefono> --message-file <payload.md> --json
```

Esto aprovecha la conexión existente de OpenClaw y carga los core files reales del agente inmobiliario (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`). No requiere usar el endpoint público de Workspace Agents ni un token admin de ChatGPT.

Para n8n, el valor recomendado durante pruebas es:

```text
AGENT_DECISION_URL=http://host.docker.internal:8787
AGENT_DECISION_TOKEN=<token-local-del-bridge>
RIOBLE_TEST_ALLOWLIST_PHONE=+5218445283282
```

El nodo `Call Agent Decision` construye la URL final como:

```text
$AGENT_DECISION_URL/decide-whatsapp
```

También acepta que `AGENT_DECISION_URL` ya venga con `/decide-whatsapp`; en ese caso lo normaliza para no duplicar el path.

El canal de conversación es siempre WhatsApp. Si el lead viene de base histórica, formulario, dashboard o carga manual, eso se expresa en `lead_origin`, no como otro canal.

## Autenticación

El caller debe enviar token bearer:

```http
Authorization: Bearer <AGENT_DECISION_TOKEN>
Content-Type: application/json
X-RealEstate-Bridge-Source: real-estate-whatsapp-agent-runtime
```

Si falta el token o no coincide, el servicio debe responder `401` y no generar respuesta.

No mezclar este token con `META_WHATSAPP_TOKEN`: `AGENT_DECISION_TOKEN` protege la consulta al agente, mientras `META_WHATSAPP_TOKEN` solo sirve para enviar mensajes por WhatsApp Cloud API.

## Request

Campos obligatorios:

- `event.type`
- `event.message_id`
- `lead.phone`
- `message.text`
- `context.lead_origin`
- `permissions`
- `mode`

```json
{
  "event": {
    "type": "incoming_message",
    "timestamp": "2026-08-04T18:30:00.000Z",
    "message_id": "wamid.xxx"
  },
  "lead": {
    "lead_id": "wa:5213312345678",
    "name": "Carlos",
    "phone": "5213312345678"
  },
  "message": {
    "text": "Sí, sigo buscando departamento en Zapopan"
  },
  "context": {
    "lead_origin": "base_historica_rioble",
    "conversation_key": "whatsapp:5213312345678",
    "interest_history": "departamentos",
    "property_type": "departamento",
    "zone": "Zapopan",
    "budget": "",
    "intent": "compra",
    "last_contact_at": "2026-06-09T15:49:54.000Z",
    "notes": "Lead importado desde Drive; respondió a reactivación."
  },
  "status": {
    "stage": "detect_interest",
    "traffic_light": "unknown",
    "do_not_contact": false,
    "followup_count": 0
  },
  "permissions": {
    "can_send_whatsapp": false,
    "can_register_handoff": true,
    "can_notify_owner": true
  },
  "mode": "draft"
}
```

## Valores Permitidos

`event.type`:

```text
incoming_message
outbound_request
followup_request
handoff_request
do_not_contact
```

`context.lead_origin`:

```text
base_historica_rioble
formulario_rioble
dashboard_rioble
google_sheet
crm
manual
unknown
```

`mode`:

```text
draft
execute
classify
```

Para el MVP, usar `mode=draft`. El endpoint puede decidir qué se debería hacer, pero no debe enviar WhatsApp directamente salvo que `mode=execute` y `permissions.can_send_whatsapp=true`.

## Response

El endpoint debe devolver JSON estricto, sin Markdown ni texto fuera del objeto.

```json
{
  "ok": true,
  "decision": {
    "action": "ask_next_question",
    "intent": "qualify_buyer",
    "lead_status": "necesidad_detectada",
    "currentStage": "qualify_buyer",
    "nextStep": "Pedir presupuesto aproximado",
    "awaitingField": "budgetMax",
    "traffic_light": "yellow"
  },
  "reply": {
    "should_send": true,
    "text": "Va, Carlos. Para ubicarte bien y no mandarte cosas fuera de rango, ¿más o menos en qué presupuesto te gustaría moverte?"
  },
  "handoff": {
    "required": false,
    "ready": false,
    "reason": "",
    "assigned_seller": "Dueño Rioble",
    "assigned_seller_phone": "+5213316994400"
  },
  "qualification": {
    "level": "warm",
    "score": 55,
    "reasons": ["Confirmó interés actual y tipo de propiedad; falta presupuesto."]
  },
  "captured_data": {
    "interestType": "buy",
    "propertyType": "departamento",
    "zones": ["Zapopan"],
    "currency": "MXN",
    "summary": "Busca departamento en Zapopan; presupuesto no confirmado.",
    "nextBestAction": "Pedir presupuesto aproximado."
  },
  "missing_data": ["budgetMax"],
  "internal_report": {
    "summary": "Lead respondió que sigue buscando departamento en Zapopan. Falta presupuesto.",
    "status": "perfilando",
    "traffic_light": "yellow",
    "next_step": "Esperar presupuesto del lead."
  }
}
```

## Compatibilidad Con n8n Actual

El workflow existente espera estos campos planos. Si el servicio responde con el formato v1 anterior, el bridge debe mapearlo así:

```json
{
  "reply_text": "reply.text",
  "intent": "decision.intent",
  "lead_status": "decision.lead_status",
  "currentStage": "decision.currentStage",
  "nextStep": "decision.nextStep",
  "awaitingField": "decision.awaitingField",
  "should_send_reply": "reply.should_send",
  "should_escalate": "handoff.required",
  "handoff_ready": "handoff.ready",
  "handoff_reason": "handoff.reason",
  "assigned_seller": "handoff.assigned_seller",
  "qualification": "qualification",
  "collected": "captured_data",
  "internal_note": "internal_report.summary"
}
```

Mientras n8n no tenga ese bridge, el endpoint puede responder directamente en el formato plano documentado en `docs/rioble_whatsapp_mvp_contract_and_tests.md`.

## Reglas Comerciales Duras

- Sofía conversa solo por WhatsApp.
- Una pregunta por mensaje.
- No mostrar inventario, precios, promociones ni disponibilidad final.
- Si el cliente pide opciones, visita, llamada o asesor, evaluar handoff inmediato.
- Si el cliente pide no recibir mensajes, marcar `do_not_contact`, no hacer handoff y responder breve.
- Si el cliente dice que no le interesa, usar el cierre autorizado de Rioble sobre posible venta, salvo opt-out explícito.
- En handoff no cerrar con pregunta. Debe afirmar el siguiente paso.
- No decir "canalizar"; usar "te conecto" o "te paso con un compañero especialista".
