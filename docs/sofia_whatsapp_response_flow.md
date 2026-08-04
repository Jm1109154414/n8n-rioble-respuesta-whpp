# Flujo De Respuestas WhatsApp Sofía

Objetivo: después de que el workflow outbound manda el primer mensaje de reactivación, el workflow de respuestas debe continuar la conversación con quien conteste hasta dejarlo en uno de estos cierres:

- `handoff_sent`: lead listo y avisado al vendedor/dueño.
- `not_interested`: no interesado; se cierra suave y se pregunta si tiene propiedad para vender.
- `do_not_contact`: pidió no recibir mensajes; se marca no contactar y no se insiste.
- `nurture`: interés ambiguo o exploratorio; queda guardado sin presión.

## Workflows

No tocar el workflow outbound que manda el primer mensaje.

```text
Rioble Whatsapp
```

Ese flujo se encarga de enviar el mensaje 1 y dejar registro en `envios`.

El flujo que se adapta es el de respuestas:

```text
Rioble WhatsApp - Respuestas
```

La extensión debe colgar después de:

```text
Marcar envio respondio
```

No debe colgar del acuse rápido a Meta, porque ese nodo solo confirma recepción del webhook.

## Rama Objetivo

```text
Normalizar mensajes
Insertar conversacion
Marcar envio respondio
Leer contexto inmobiliario
Build Conversation Context
Call Agent Decision
Resolve Final Decision
Apply Business Rules
Actualizar perfil envio
Should Notify Seller?
Send WhatsApp to Seller
Record Handoff Event
Should Send Reply?
Send WhatsApp Reply
Insertar respuesta outbound
```

Notas:

- Si no hay handoff, `Should Notify Seller?` salta directo a `Should Send Reply?`.
- Si hay handoff, primero se notifica internamente y luego Sofía responde al lead confirmando el siguiente paso.
- `seller_handoffs.conversation_key` evita notificar dos veces al vendedor por el mismo lead.
- Si ya existe `handoff_sent`, el flujo no recalifica ni vuelve a contestar como Sofía.

## Endpoint De Decisión

El nodo `Call Agent Decision` llama:

```http
POST /decide-whatsapp
```

Documentación:

```text
docs/sofia_whatsapp_endpoint_contract_v1.md
```

En pruebas, ese endpoint lo atiende el bridge local:

```bash
RIOBLE_TEST_ALLOWLIST_PHONE=+5218445283282 python3 integraciones/sofia_openclaw_bridge.py
```

Desde n8n debe apuntar a:

```text
http://host.docker.internal:8787/decide-whatsapp
```

Para el MVP, el endpoint puede responder en formato plano compatible con n8n o en el contrato v1 estructurado. El nodo `Resolve Final Decision` normaliza ambos formatos.

## Estados Finales

`ready_for_handoff`:

El lead ya trae datos suficientes o pidió avanzar con opciones, visita, llamada, valuación o especialista.

`handoff_sent`:

Ya se notificó al vendedor/dueño. A partir de aquí Sofía no vuelve a perfilar.

`not_interested`:

El lead dijo que no busca comprar/invertir. Sofía responde una sola vez con el mensaje autorizado para detectar si tiene una propiedad para vender.

`do_not_contact`:

El lead pidió baja/no contacto. Se marca `no_enviar=true`, no hay handoff y no se insiste.

## SQL Necesario

Aplicar antes de importar o activar el flujo adaptado:

```text
sql/rioble_respuestas_mvp_additive.sql
```

Ese SQL agrega campos de etapa/perfil a `envios` y crea `seller_handoffs` para idempotencia de handoffs.

## Generar Workflow Adaptado

Exportar desde n8n el workflow vivo `Rioble WhatsApp - Respuestas` y correr:

```bash
node tools/extend_live_respuestas_workflow.js <live-workflow.json> workflows/Rioble_WhatsApp_Respuestas_MVP_Inmobiliaria.json
```

Importar el JSON generado como copia inactiva, probar manualmente y activar solo cuando no duplique respuestas ni notificaciones.

## Artefacto Generado

La copia importable actual queda en:

```text
workflows/generated/Rioble_WhatsApp_Respuestas_MVP_Inmobiliaria.json
```

Debe importarse en n8n como workflow inactivo. El path del webhook se cambia a `rioble-whatsapp-webhook-mvp` para evitar choque con el flujo vivo.

## Modo Prueba Con Allowlist

El workflow generado incluye el nodo:

```text
Only Test Phone?
```

Ese nodo deja pasar a Sofía solo cuando el teléfono entrante coincide con:

```text
RIOBLE_TEST_ALLOWLIST_PHONE
```

Para la prueba inicial:

```text
RIOBLE_TEST_ALLOWLIST_PHONE=+5218445283282
```

Si llega una respuesta de otro número, el flujo puede guardar la conversación y marcar `respondio`, pero no llama a Sofía ni manda respuesta automática.
