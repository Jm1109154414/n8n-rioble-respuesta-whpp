# WhatsApp Inmobiliaria MVP: `/decide-whatsapp`

Contrato v1 recomendado para Sofía por WhatsApp:
`docs/sofia_whatsapp_endpoint_contract_v1.md`

Workflow export:

`workflows/WF_Inbox_WhatsApp_Rioble_Real_Estate_MVP.json`

Nombre interno del workflow:

`WF Inbox WhatsApp Inmobiliaria - Supabase`

Debe permanecer inactivo hasta probar manualmente que no duplica respuestas ni notificaciones.

## Etapas

Usar estos valores en `currentStage`:

```text
new_reply
detect_interest
qualify_buyer
qualify_seller
qualify_renter
qualify_investor
ready_for_handoff
handoff_sent
nurture
not_interested
do_not_contact
```

Usar estos valores en `status`:

```text
nuevo
en_conversacion
perfil_incompleto
necesidad_detectada
prospecto_caliente
asignado_a_vendedor
seguimiento_humano
nutricion
no_interesado
no_contactar
```

## Avance

`new_reply`: primera respuesta entrante. Responder natural y detectar interés real.

`detect_interest`: clasificar compra, venta, renta, inversión, duda general o no interesado.

`qualify_buyer`: pedir lo mínimo según falte: zona, tipo, presupuesto aproximado, timeline. Útiles: pago/crédito, habitaciones, requisitos clave.

`qualify_seller`: pedir lo mínimo según falte: tipo, ubicación/zona, precio esperado o valuación, timeline. Útiles: m2, habitaciones, estado, documentos.

`qualify_renter`: pedir zona, tipo, presupuesto mensual y fecha de mudanza.

`ready_for_handoff`: ya hay necesidad concreta y datos suficientes para que un vendedor no empiece desde cero.

`handoff_sent`: n8n ya notificó internamente; no degradar a etapas anteriores.

`nurture`: interés ambiguo o exploratorio; responder sin presión.

`not_interested` / `do_not_contact`: no insistir. Si pide baja/no contacto, no mandar handoff.

## Criterios De Handoff

Comprador caliente: `handoff_ready=true` si cumple al menos una regla fuerte:

- Tiene zona + presupuesto + tipo.
- Pide ver opciones, visita, llamada o hablar con asesor.
- Tiene timeline inmediato o menor a 3 meses.
- Menciona crédito preaprobado o pago de contado.

Vendedor caliente:

- Quiere vender y dio ubicación + tipo.
- Tiene precio esperado o pide valuación.
- Tiene urgencia o timeline claro.
- Pide llamada, visita o asesor.

Warm: interés real, pero faltan datos clave. Hacer una sola pregunta.

Cold/nurture: interés ambiguo o no quiere hablar ahora. Guardar contexto.

## Request A `/decide-whatsapp`

El nodo `Build Conversation Context` manda:

```json
{
  "source_system": "real-estate-whatsapp-agent-runtime",
  "workflow": "WhatsApp Inmobiliaria",
  "channel": "whatsapp",
  "conversation_key": "whatsapp:5213312345678",
  "message_id": "wamid...",
  "external_lead_id": "wa:5213312345678",
  "sender_id": "5213312345678",
  "sender_username": "Nombre WhatsApp",
  "message_text": "Texto del cliente",
  "timestamp": "2026-08-04T00:00:00.000Z",
  "lead": {
    "fullName": "",
    "phone": "",
    "interestType": "buy | sell | rent | invest | unknown | not_interested",
    "propertyType": "casa | departamento | terreno | local | oficina | bodega | otro",
    "zones": [],
    "budgetMin": "",
    "budgetMax": "",
    "rentBudget": "",
    "currency": "MXN",
    "timeline": "inmediato | 1-3_meses | 3-6_meses | explorando",
    "paymentMethod": "contado | credito | mixto | no_definido",
    "financingStatus": "preaprobado | buscando_credito | no_aplica | no_definido",
    "bedrooms": "",
    "mustHaves": [],
    "sellerPropertyAddress": "",
    "sellerAskingPrice": "",
    "sellerPropertyCondition": "",
    "sellerPropertySize": "",
    "urgency": "",
    "summary": "",
    "nextBestAction": "",
    "assignedSeller": "",
    "assignedSellerPhone": "",
    "qualification": {
      "level": "hot | warm | cold | nurture | do_not_contact",
      "score": 0,
      "reasons": []
    },
    "handoffReady": false
  },
  "missing_fields": [],
  "recent_messages": [],
  "context": {
    "company_name": "Rioble Inmobiliaria",
    "advisor_name": "Sofía Tapia",
    "service_area": "Jalisco, principalmente Guadalajara metropolitana y Puerto Vallarta",
    "booking_link": "",
    "default_seller_name": "Dueño Rioble",
    "default_seller_phone": "+5213316994400",
    "seller_notify_phone": "+5213316994400",
    "current_stage": "new_reply",
    "next_step": "Detectar interés real",
    "source_account": "WhatsApp Inmobiliaria",
    "message_signals": {
      "optOutSignal": false,
      "notInterestedSignal": false,
      "handoffSignal": false,
      "interestTypeSignal": "",
      "propertyTypeSignal": "",
      "zones": [],
      "budget": "",
      "rentBudget": "",
      "timelineSignal": "",
      "paymentMethodSignal": ""
    },
    "handoff_rules": {
      "should_notify_when": [
        "agentDecision.should_escalate",
        "agentDecision.handoff_ready",
        "currentStage=ready_for_handoff"
      ],
      "never_notify_twice": true,
      "missing_data_label": "no confirmado"
    }
  },
  "today": "2026-08-04"
}
```

## Response Esperado

El endpoint debe responder JSON estricto:

```json
{
  "reply_text": "Mensaje breve de Sofía.",
  "intent": "detect_interest",
  "lead_status": "en_conversacion",
  "currentStage": "qualify_buyer",
  "nextStep": "Pedir presupuesto aproximado",
  "awaitingField": "budgetMax",
  "should_send_reply": true,
  "should_escalate": false,
  "handoff_ready": false,
  "handoff_reason": "",
  "assigned_seller": "Dueño Rioble",
  "qualification": {
    "level": "warm",
    "score": 55,
    "reasons": ["interés real pero falta presupuesto"]
  },
  "collected": {
    "interestType": "buy",
    "propertyType": "departamento",
    "zones": ["Zapopan"],
    "budgetMax": "",
    "timeline": "",
    "paymentMethod": "",
    "summary": "Busca departamento en Zapopan; presupuesto no confirmado.",
    "nextBestAction": "Pedir presupuesto aproximado.",
    "assignedSeller": "Dueño Rioble",
    "assignedSellerPhone": "+5213316994400"
  },
  "internal_note": ""
}
```

Cuando ya debe pasar a vendedor:

```json
{
  "reply_text": "Perfecto, ya tengo lo importante. Te conecto con un compañero especialista para que te comparta el siguiente paso.",
  "intent": "ready_for_handoff",
  "lead_status": "prospecto_caliente",
  "currentStage": "ready_for_handoff",
  "nextStep": "Notificar vendedor con resumen",
  "awaitingField": "none",
  "should_send_reply": true,
  "should_escalate": true,
  "handoff_ready": true,
  "handoff_reason": "Tiene zona, tipo de propiedad y presupuesto.",
  "assigned_seller": "Dueño Rioble",
  "qualification": {
    "level": "hot",
    "score": 85,
    "reasons": ["zona + presupuesto + tipo"]
  },
  "collected": {
    "interestType": "buy",
    "propertyType": "departamento",
    "zones": ["Zapopan"],
    "budgetMax": "3000000",
    "currency": "MXN",
    "summary": "Busca departamento en Zapopan con presupuesto aproximado de 3 mdp.",
    "nextBestAction": "Mandarle 2-3 opciones que encajen y proponer llamada/visita.",
    "assignedSeller": "Dueño Rioble",
    "assignedSellerPhone": "+5213316994400",
    "handoffReady": true
  },
  "internal_note": ""
}
```

Nota de tono para Rioble: aunque el MD genérico usa “canalizar”, ante prospectos Sofía debe decir “te conecto” o “te paso con un compañero especialista”.

## Variables

```text
META_WHATSAPP_TOKEN
META_WHATSAPP_PHONE_NUMBER_ID
AGENT_DECISION_URL
AGENT_DECISION_TOKEN
REAL_ESTATE_COMPANY_NAME
DEFAULT_SELLER_PHONE
DEFAULT_SELLER_NAME
SELLER_NOTIFY_PHONE
SELLER_NOTIFY_PHONE_NUMBER_ID
REAL_ESTATE_BOOKING_LINK
```

Si la notificación al vendedor sale del mismo número de Cloud API, `SELLER_NOTIFY_PHONE_NUMBER_ID` puede ser igual a `META_WHATSAPP_PHONE_NUMBER_ID`.

## SQL

Usar:

`sql/rioble_whatsapp_mvp_safe_changes.sql`

Opción rápida: guardar perfil en:

```text
leads.raw_source->'real_estate_profile'
leads.raw_source->'qualification'
leads.raw_source->'handoff'
```

Opción limpia: el SQL agrega columnas inmobiliarias opcionales y `seller_handoffs`.

## Pruebas Manuales

1. Comprador, primer mensaje:
   `Sí, busco departamento en Zapopan para vivir, máximo 3 millones.`
   Esperado: crea lead, guarda inbound, detecta `interestType=buy`, no pide datos ya dados, puede marcar `ready_for_handoff`.

2. Comprador, segundo mensaje:
   `Me gustaría verlo esta semana, tengo crédito preaprobado.`
   Esperado: usa historial, no vuelve a pedir zona/presupuesto, marca `handoff_ready=true`, notifica vendedor una sola vez.

3. Vendedor:
   `Quiero vender un terreno en Casa Fuerte, necesito valuación.`
   Esperado: `interestType=sell`, resumen de propiedad, handoff si pide valuación/contacto.

4. Opt-out:
   `No me escriban más.`
   Esperado: `currentStage=do_not_contact`, `status=no_contactar`, no handoff, una confirmación breve.

5. No interesado:
   `No me interesa por ahora.`
   Esperado: `currentStage=not_interested`, `status=no_interesado`, cierre suave, sin handoff.

6. Duplicado:
   Repetir mismo `message_id`.
   Esperado: `Acknowledge Duplicate Event`, sin segunda respuesta y sin segundo handoff.

7. Status event de Meta:
   Enviar status `sent/delivered/read/failed`.
   Esperado: guarda status y, si corresponde a un outbound del agente, actualizar `whatsapp_messages.status`.

## Checklist De Activación

- Importar el workflow nuevo, no editar el outbound inicial existente.
- Confirmar credenciales Postgres y Meta WhatsApp.
- Confirmar `AGENT_DECISION_URL` apuntando a `/decide-whatsapp`.
- Aplicar SQL en staging.
- Probar comprador, vendedor, opt-out, no interesado, duplicado y status event.
- Revisar que `seller_handoffs` solo tenga una fila por `conversation_key`.
- Activar solo cuando el workflow nuevo responda bien y el anterior no duplique webhooks.
