const fs = require('fs');
const path = require('path');

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath || !outputPath) {
  console.error('Usage: node tools/extend_live_respuestas_workflow.js <live-workflow.json> <output.json>');
  process.exit(1);
}

const source = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const workflow = Array.isArray(source) ? source[0] : source;

function nodeByName(name) {
  const node = workflow.nodes.find((item) => item.name === name);
  if (!node) throw new Error(`Missing node: ${name}`);
  return node;
}

function postgresCredentials() {
  return nodeByName('Insertar conversacion').credentials;
}

function codeNode(name, id, position, jsCode) {
  return {
    parameters: { mode: 'runOnceForEachItem', jsCode },
    id,
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
  };
}

function postgresNode(name, id, position, query, queryReplacement) {
  return {
    parameters: {
      operation: 'executeQuery',
      query,
      options: {
        queryBatching: 'independently',
        queryReplacement,
        replaceEmptyStrings: false,
      },
    },
    id,
    name,
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.6,
    position,
    alwaysOutputData: true,
    credentials: postgresCredentials(),
  };
}

function ifNode(name, id, position, expression) {
  return {
    parameters: {
      conditions: {
        combinator: 'and',
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'strict',
          version: 3,
        },
        conditions: [
          {
            leftValue: expression,
            rightValue: true,
            operator: { type: 'boolean', operation: 'equals' },
          },
        ],
      },
      options: { ignoreCase: true },
    },
    id,
    name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position,
  };
}

function allowlistIfNode(name, id, position) {
  return ifNode(
    name,
    id,
    position,
    "={{(() => { const allowed = String($env.RIOBLE_TEST_ALLOWLIST_PHONE || '').replace(/\\D/g, ''); const incoming = String($('Normalizar mensajes').first().json.telefono || '').replace(/\\D/g, ''); if (!allowed) return false; const variants = new Set([allowed]); if (allowed.length === 10) variants.add('52' + allowed); if (allowed.startsWith('521') && allowed.length === 13) variants.add('52' + allowed.slice(3)); if (allowed.startsWith('52') && allowed.length === 12) variants.add('521' + allowed.slice(2)); return variants.has(incoming); })()}}"
  );
}

function httpNode(name, id, position, parameters) {
  return {
    parameters,
    id,
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    alwaysOutputData: true,
    continueOnFail: true,
  };
}

workflow.id = 'rioble-whatsapp-respuestas-mvp-inmobiliaria';
workflow.name = 'Rioble WhatsApp - Respuestas MVP Inmobiliaria';
workflow.active = false;
workflow.versionId = undefined;
workflow.activeVersionId = undefined;
workflow.versionCounter = undefined;
workflow.versionMetadata = undefined;
workflow.triggerCount = undefined;
workflow.staticData = null;
workflow.shared = undefined;
workflow.createdAt = undefined;
workflow.updatedAt = undefined;
workflow.description = 'Copia inactiva del webhook de respuestas con calificación inmobiliaria y handoff a vendedor.';

// Avoid webhook-path collision if somebody accidentally activates the copy.
nodeByName('Meta Webhook Verify').parameters.path = 'rioble-whatsapp-webhook-mvp';
nodeByName('Meta Webhook Mensajes').parameters.path = 'rioble-whatsapp-webhook-mvp';
delete nodeByName('Meta Webhook Verify').webhookId;
delete nodeByName('Meta Webhook Mensajes').webhookId;
delete workflow.meta;

const insertInboundQuery = `WITH incoming AS (
 SELECT regexp_replace(coalesce($1::text, ''), '\\D', '', 'g') AS phone_digits
),
variants AS (
 SELECT phone_digits FROM incoming WHERE phone_digits != ''
 UNION
 SELECT '52' || phone_digits FROM incoming WHERE length(phone_digits) = 10
 UNION
 SELECT '52' || substring(phone_digits from 4) FROM incoming WHERE phone_digits LIKE '521%' AND length(phone_digits) = 13
 UNION
 SELECT '521' || substring(phone_digits from 3) FROM incoming WHERE phone_digits LIKE '52%' AND length(phone_digits) = 12
),
matched AS (
 SELECT e.id, e.nombre
 FROM envios e
 JOIN variants v ON e.telefono_digits = v.phone_digits
 ORDER BY e.ultimo_envio DESC NULLS LAST, e.id DESC
 LIMIT 1
)
INSERT INTO conversaciones (
 id,
 timestamp,
 direccion,
 telefono,
 wa_id,
 nombre_perfil,
 mensaje,
 tipo,
 message_id,
 phone_number_id,
 display_phone_number,
 payload
)
VALUES (
 (SELECT id FROM matched),
 NULLIF($2::text, '')::timestamptz,
 NULLIF($3::text, ''),
 NULLIF($4::text, ''),
 NULLIF($5::text, ''),
 COALESCE(NULLIF($6::text, ''), (SELECT nombre FROM matched), ''),
 NULLIF($7::text, ''),
 NULLIF($8::text, ''),
 NULLIF($9::text, ''),
 NULLIF($10::text, ''),
 NULLIF($11::text, ''),
 COALESCE(NULLIF($12::text, '')::jsonb, '{}'::jsonb)
)
ON CONFLICT (message_id) WHERE message_id IS NOT NULL
DO NOTHING
RETURNING
 conversation_pk,
 id,
 timestamp,
 direccion,
 telefono,
 wa_id,
 nombre_perfil,
 mensaje,
 tipo,
 message_id;`;

nodeByName('Insertar conversacion').parameters = {
  operation: 'executeQuery',
  query: insertInboundQuery,
  options: {
    queryBatching: 'independently',
    queryReplacement: "={{ [ $json.telefono || '', $json.timestamp || '', $json.direccion || '', $json.telefono || '', $json.wa_id || '', $json.nombre_perfil || '', $json.mensaje || '', $json.tipo || '', $json.message_id || '', $json.phone_number_id || '', $json.display_phone_number || '', (typeof $json.payload === 'string' ? $json.payload : JSON.stringify($json.payload || {})) ] }}",
    replaceEmptyStrings: false,
  },
};

const readContextQuery = `with inbound as (
  select
    nullif($1::text, '')::integer as envio_id,
    regexp_replace(coalesce($2::text, ''), '\\D', '', 'g') as phone_digits,
    nullif($3::text, '') as inbound_message_id
), variants as (
  select phone_digits from inbound where phone_digits <> ''
  union
  select '52' || phone_digits from inbound where length(phone_digits) = 10
  union
  select '52' || substring(phone_digits from 4) from inbound where phone_digits like '521%' and length(phone_digits) = 13
  union
  select '521' || substring(phone_digits from 3) from inbound where phone_digits like '52%' and length(phone_digits) = 12
), lead_match as (
  select e.*
  from public.envios e
  where e.id = (select envio_id from inbound)
     or e.telefono_digits in (select phone_digits from variants)
  order by case when e.id = (select envio_id from inbound) then 0 else 1 end,
           e.ultimo_envio desc nulls last,
           e.id desc
  limit 1
), recent as (
  select c.*
  from public.conversaciones c
  where c.id = (select id from lead_match)
     or c.telefono_digits in (select phone_digits from variants)
  order by c.timestamp desc, c.created_at desc
  limit 12
), handoff as (
  select sh.*
  from public.seller_handoffs sh
  where sh.envio_id = (select id from lead_match)
     or sh.conversation_key = 'envios:' || (select id from lead_match)::text
  order by sh.created_at desc
  limit 1
)
select
  lm.id,
  lm.nombre,
  lm.telefono,
  lm.telefono_digits,
  lm.estado,
  lm.no_enviar,
  lm.ultimo_envio,
  lm.ultimo_evento,
  lm.message_id as outbound_message_id,
  lm.etapa_conversacion,
  lm.estatus_comercial,
  lm.perfil_inmobiliario::text as perfil_inmobiliario,
  lm.qualification_level,
  lm.qualification_score,
  lm.assigned_seller,
  lm.handoff_status,
  lm.handoff_at,
  coalesce(
    (select jsonb_agg(to_jsonb(r) order by r.timestamp, r.created_at) from recent r),
    '[]'::jsonb
  )::text as recent_messages,
  coalesce((select status from handoff), '') as seller_handoff_status,
  coalesce((select provider_message_id from handoff), '') as seller_handoff_message_id
from lead_match lm;`;

const buildContextCode = `const input = $json || {};
let normalized = {};
try { normalized = $('Normalizar mensajes').first().json || {}; } catch {}
let inserted = {};
try { inserted = $('Insertar conversacion').first().json || {}; } catch {}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const clean = String(value).trim();
    if (clean) return clean;
  }
  return '';
}
function parseJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
function asArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}
function has(text, regex) {
  return regex.test(String(text || '').toLowerCase());
}

const profile = parseJson(input.perfil_inmobiliario, {});
const recentMessages = parseJson(input.recent_messages, []);
const currentText = String(normalized.mensaje || inserted.mensaje || '').trim();
const lower = currentText.toLowerCase();

const optOutSignal = has(lower, /\\b(no me escribas|no contactar|baja|cancelar mensajes|dejen de escribir|no quiero recibir|no molestar|stop|unsubscribe)\\b/i);
const notInterestedSignal = has(lower, /\\b(no me interesa|ya no busco|ya compr[eé]|por ahora no|no gracias|no quiero invertir)\\b/i);
const handoffSignal = has(lower, /\\b(quiero verla|quiero verlo|me llamas|ll[aá]mame|tienes opciones|m[aá]ndame opciones|quiero vender|necesito valuaci[oó]n|aval[uú]o|que me contacte|hablar con asesor|visita|cita|llamada)\\b/i);

let interestTypeSignal = '';
if (!optOutSignal && !notInterestedSignal) {
  if (has(lower, /\\b(vender|vendo|venta de mi|poner en venta|valuaci[oó]n|aval[uú]o|cu[aá]nto vale)\\b/i)) interestTypeSignal = 'sell';
  else if (has(lower, /\\b(rentar|renta|arrendar|alquilar|mudanza|mensual)\\b/i)) interestTypeSignal = 'rent';
  else if (has(lower, /\\b(invertir|inversi[oó]n|plusval[ií]a|rentabilidad|patrimonio)\\b/i)) interestTypeSignal = 'invest';
  else if (has(lower, /\\b(comprar|compra|busco comprar|quiero comprar|adquirir)\\b/i)) interestTypeSignal = 'buy';
}

let propertyTypeSignal = '';
for (const [label, regex] of [
  ['departamento', /\\b(depa|departamento|apartamento)\\b/i],
  ['casa', /\\b(casa|residencia)\\b/i],
  ['terreno', /\\b(terreno|lote)\\b/i],
  ['local', /\\b(local|comercial)\\b/i],
  ['oficina', /\\b(oficina|corporativ)\\b/i],
  ['bodega', /\\b(bodega|nave industrial)\\b/i],
]) {
  if (regex.test(lower)) {
    propertyTypeSignal = label;
    break;
  }
}

const zones = [];
for (const zone of ['Zapopan', 'Guadalajara', 'Providencia', 'Andares', 'Puerta de Hierro', 'Chapalita', 'Tlaquepaque', 'Tonalá', 'Tlajomulco', 'Puerto Vallarta', 'Jalisco', 'Casa Fuerte']) {
  if (new RegExp(zone, 'i').test(currentText)) zones.push(zone);
}

const amountMatch = currentText.match(/(?:\\$\\s*)?(\\d+(?:[.,]\\d+)?)\\s*(mdp|millones?|millon|mil|k)?/i);
const amountText = amountMatch && /(presupuesto|hasta|m[aá]ximo|aprox|alrededor|millones?|mdp|\\$|renta|mensual|precio|pido|vale)/i.test(currentText)
  ? amountMatch[0].trim()
  : '';
const rentBudget = /(renta|mensual|mudanza)/i.test(currentText) ? amountText : '';
const purchaseBudget = rentBudget ? '' : amountText;

let timelineSignal = '';
if (has(lower, /\\b(ya|inmediato|este mes|cuanto antes|urgente)\\b/i)) timelineSignal = 'inmediato';
else if (has(lower, /\\b(1\\s*-\\s*3|uno a tres|tres meses|pr[oó]ximos meses)\\b/i)) timelineSignal = '1-3_meses';
else if (has(lower, /\\b(3\\s*-\\s*6|seis meses|mediano plazo)\\b/i)) timelineSignal = '3-6_meses';
else if (has(lower, /\\b(explorando|viendo|sondeando|sin prisa|m[aá]s adelante)\\b/i)) timelineSignal = 'explorando';

let paymentMethodSignal = '';
if (has(lower, /\\b(contado|cash)\\b/i)) paymentMethodSignal = 'contado';
else if (has(lower, /\\b(cr[eé]dito|hipotecario|infonavit|banco|preaprobado|pre aprobado)\\b/i)) paymentMethodSignal = 'credito';
else if (has(lower, /\\b(mixto)\\b/i)) paymentMethodSignal = 'mixto';

const currentProfile = {
  fullName: firstNonEmpty(profile.fullName, input.nombre, normalized.nombre_perfil),
  phone: firstNonEmpty(profile.phone, input.telefono_digits, normalized.telefono),
  interestType: firstNonEmpty(interestTypeSignal, profile.interestType, 'unknown'),
  propertyType: firstNonEmpty(propertyTypeSignal, profile.propertyType),
  zones: Array.from(new Set([...asArray(profile.zones), ...zones])),
  budgetMin: firstNonEmpty(profile.budgetMin),
  budgetMax: firstNonEmpty(purchaseBudget, profile.budgetMax),
  rentBudget: firstNonEmpty(rentBudget, profile.rentBudget),
  currency: firstNonEmpty(profile.currency, 'MXN'),
  timeline: firstNonEmpty(timelineSignal, profile.timeline),
  paymentMethod: firstNonEmpty(paymentMethodSignal, profile.paymentMethod),
  financingStatus: firstNonEmpty(profile.financingStatus, /preaprobado|pre aprobado/i.test(currentText) ? 'preaprobado' : ''),
  bedrooms: firstNonEmpty(profile.bedrooms, (currentText.match(/\\b(\\d+)\\s*(?:rec[aá]maras?|habitaciones?)\\b/i) || [])[1]),
  mustHaves: asArray(profile.mustHaves),
  sellerPropertyAddress: firstNonEmpty(profile.sellerPropertyAddress),
  sellerAskingPrice: firstNonEmpty(profile.sellerAskingPrice),
  sellerPropertyCondition: firstNonEmpty(profile.sellerPropertyCondition),
  sellerPropertySize: firstNonEmpty(profile.sellerPropertySize),
  urgency: firstNonEmpty(profile.urgency, timelineSignal === 'inmediato' ? 'alta' : ''),
  summary: firstNonEmpty(profile.summary),
  nextBestAction: firstNonEmpty(profile.nextBestAction),
  assignedSeller: firstNonEmpty(profile.assignedSeller, input.assigned_seller, $env.DEFAULT_SELLER_NAME, 'Dueño Rioble'),
  assignedSellerPhone: firstNonEmpty(profile.assignedSellerPhone, $env.SELLER_NOTIFY_PHONE, $env.DEFAULT_SELLER_PHONE, '+5213316994400'),
};
if (currentProfile.interestType === 'sell' && amountText) currentProfile.sellerAskingPrice = firstNonEmpty(amountText, profile.sellerAskingPrice);

const buyerComplete = ['buy', 'invest'].includes(currentProfile.interestType) && currentProfile.zones.length && currentProfile.propertyType && currentProfile.budgetMax;
const renterComplete = currentProfile.interestType === 'rent' && currentProfile.zones.length && currentProfile.propertyType && currentProfile.rentBudget;
const sellerComplete = currentProfile.interestType === 'sell' && (currentProfile.sellerPropertyAddress || currentProfile.zones.length) && currentProfile.propertyType && (currentProfile.sellerAskingPrice || /valuaci[oó]n|aval[uú]o/i.test(lower));
const fastTimeline = ['inmediato', '1-3_meses'].includes(currentProfile.timeline);
const strongPayment = ['contado', 'credito'].includes(currentProfile.paymentMethod) || currentProfile.financingStatus === 'preaprobado';
const handoffReady = Boolean(!optOutSignal && !notInterestedSignal && (buyerComplete || sellerComplete || renterComplete || handoffSignal || fastTimeline || strongPayment));

let qualification = { level: input.qualification_level || 'nurture', score: Number(input.qualification_score || 0), reasons: [] };
if (optOutSignal) qualification = { level: 'do_not_contact', score: 0, reasons: ['pidió no contacto'] };
else if (handoffReady) qualification = { level: 'hot', score: Math.max(80, qualification.score), reasons: ['criterio de prospecto importante'] };
else if (currentProfile.interestType !== 'unknown') qualification = { level: 'warm', score: Math.max(40, qualification.score), reasons: ['interés real con datos pendientes'] };

function deriveStage() {
  if (String(input.etapa_conversacion || '') === 'handoff_sent' || String(input.estatus_comercial || '') === 'seguimiento_humano') {
    return { currentStage: 'handoff_sent', status: 'asignado_a_vendedor', nextStep: 'Evitar recalificar; seguimiento humano', awaitingField: 'none' };
  }
  if (optOutSignal || input.no_enviar === true) return { currentStage: 'do_not_contact', status: 'no_contactar', nextStep: 'No insistir', awaitingField: 'none' };
  if (notInterestedSignal) return { currentStage: 'not_interested', status: 'no_interesado', nextStep: 'Cerrar suave sin insistir', awaitingField: 'none' };
  if (handoffReady) return { currentStage: 'ready_for_handoff', status: 'prospecto_caliente', nextStep: 'Notificar vendedor con resumen', awaitingField: 'none' };
  if (!currentProfile.interestType || currentProfile.interestType === 'unknown') return { currentStage: input.etapa_conversacion || 'new_reply', status: 'nuevo', nextStep: 'Detectar interés real', awaitingField: 'interestType' };
  if (currentProfile.interestType === 'buy') return { currentStage: 'qualify_buyer', status: 'perfil_incompleto', nextStep: 'Pedir dato clave de compra', awaitingField: !currentProfile.zones.length ? 'zones' : !currentProfile.propertyType ? 'propertyType' : !currentProfile.budgetMax ? 'budgetMax' : 'timeline' };
  if (currentProfile.interestType === 'sell') return { currentStage: 'qualify_seller', status: 'perfil_incompleto', nextStep: 'Pedir dato clave de venta', awaitingField: !(currentProfile.sellerPropertyAddress || currentProfile.zones.length) ? 'sellerPropertyAddress' : !currentProfile.propertyType ? 'propertyType' : !currentProfile.sellerAskingPrice ? 'sellerAskingPrice' : 'timeline' };
  if (currentProfile.interestType === 'rent') return { currentStage: 'qualify_renter', status: 'perfil_incompleto', nextStep: 'Pedir dato clave de renta', awaitingField: !currentProfile.zones.length ? 'zones' : !currentProfile.propertyType ? 'propertyType' : !currentProfile.rentBudget ? 'rentBudget' : 'moveInDate' };
  if (currentProfile.interestType === 'invest') return { currentStage: 'qualify_investor', status: 'perfil_incompleto', nextStep: 'Pedir objetivo de inversión o presupuesto', awaitingField: !currentProfile.zones.length ? 'zones' : !currentProfile.budgetMax ? 'budgetMax' : 'timeline' };
  return { currentStage: 'nurture', status: 'nutricion', nextStep: 'Guardar contexto sin presión', awaitingField: 'none' };
}

const stage = deriveStage();
const missingFields = [];
if (stage.awaitingField && stage.awaitingField !== 'none') missingFields.push(stage.awaitingField);

return {
  json: {
    envio: input,
    inbound: normalized,
    recent_messages: recentMessages,
    currentProfile,
    qualification,
    derivedStage: stage,
    missingFields,
    handoffReady,
    sellerHandoffStatus: input.seller_handoff_status || '',
    agentPayload: {
      source_system: 'real-estate-whatsapp-agent-runtime',
      workflow: 'Rioble WhatsApp - Respuestas MVP Inmobiliaria',
      channel: 'whatsapp',
      conversation_key: 'envios:' + String(input.id || ''),
      message_id: normalized.message_id || '',
      external_lead_id: input.id ? 'envios:' + String(input.id) : '',
      sender_id: normalized.telefono || input.telefono_digits || '',
      sender_username: normalized.nombre_perfil || input.nombre || '',
      message_text: currentText,
      timestamp: normalized.timestamp || new Date().toISOString(),
      lead: { ...currentProfile, qualification, handoffReady },
      missing_fields: missingFields,
      recent_messages: recentMessages,
      context: {
        company_name: $env.REAL_ESTATE_COMPANY_NAME || 'Rioble Inmobiliaria',
        advisor_name: 'Sofía Tapia',
        service_area: 'Jalisco, principalmente Guadalajara metropolitana y Puerto Vallarta',
        default_seller_name: $env.DEFAULT_SELLER_NAME || 'Dueño Rioble',
        seller_notify_phone: $env.SELLER_NOTIFY_PHONE || $env.DEFAULT_SELLER_PHONE || '+5213316994400',
        current_stage: stage.currentStage,
        next_step: stage.nextStep,
        source_account: 'WhatsApp Inmobiliaria',
        phone_number_id: normalized.phone_number_id || '',
        message_signals: { optOutSignal, notInterestedSignal, handoffSignal, interestTypeSignal, propertyTypeSignal, zones, budget: purchaseBudget, rentBudget, timelineSignal, paymentMethodSignal }
      },
      today: new Date().toISOString().slice(0, 10)
    }
  }
};`;

const resolveDecisionCode = `const http = $json || {};
const base = $('Build Conversation Context').first().json;
const stage = base.derivedStage?.currentStage || 'new_reply';

function fallbackReply(currentStage, profile = {}) {
  if (currentStage === 'do_not_contact') return 'Claro, entiendo. Ya no te escribo por este medio.';
  if (currentStage === 'not_interested') return 'Claro, entiendo perfecto.\\n\\nDe cualquier forma, aprovecho para comentarte que en Rioble Inmobiliaria también podemos ayudarte si en algún momento quieres vender alguna propiedad.\\n\\nTenemos clientes buscando oportunidades en diferentes zonas y podríamos ayudarte a revisar si tu propiedad encaja con alguno de ellos.\\n\\n¿Actualmente tienes alguna propiedad que estés considerando vender?';
  if (currentStage === 'new_reply' || currentStage === 'detect_interest') return 'Claro. Para ubicarte bien, ¿estás buscando comprar, vender, rentar o invertir?';
  if (currentStage === 'qualify_buyer') {
    if (!profile.zones?.length) return 'Va. ¿En qué zona de Jalisco te gustaría buscar?';
    if (!profile.propertyType) return 'Perfecto. ¿Qué tipo de propiedad tienes en mente?';
    if (!profile.budgetMax) return 'Bien. ¿Qué presupuesto aproximado traes contemplado?';
    return 'Va. ¿En qué plazo te gustaría comprar?';
  }
  if (currentStage === 'qualify_seller') {
    if (!(profile.sellerPropertyAddress || profile.zones?.length)) return 'Entiendo. ¿En qué zona está la propiedad que quieres vender?';
    if (!profile.propertyType) return 'Va. ¿Qué tipo de propiedad es?';
    if (!profile.sellerAskingPrice) return 'Perfecto. ¿Ya tienes un precio esperado o buscas que la valuemos?';
    return '¿En qué plazo te gustaría venderla?';
  }
  if (currentStage === 'qualify_renter') return 'Perfecto. ¿En qué zona te gustaría rentar?';
  if (currentStage === 'qualify_investor') return 'Bien. ¿Buscas invertir para renta, plusvalía o patrimonio familiar?';
  if (currentStage === 'ready_for_handoff') {
    if (profile.interestType === 'sell') return 'Perfecto, ya tengo los datos base. Te conecto con un compañero especialista para revisar tu propiedad y el siguiente paso.';
    if (profile.interestType === 'buy' || profile.interestType === 'invest') return 'Perfecto, con eso ya puedo ubicar mejor opciones. Te conecto con un compañero especialista para que te comparta propiedades que encajen contigo.';
    return 'Perfecto, ya tengo lo importante. Te conecto con un compañero especialista para que te comparta el siguiente paso.';
  }
  return 'Va, lo dejamos sin presión. ¿Qué sería lo más importante para ti en este momento?';
}
function sensitive(value) {
  return /(token|tokens|contrase(?:ñ|n)a|password|api[_\\s-]?key|credenciales?|secret|secreto|prompt|instrucciones internas?|accesos?)/i.test(String(value || ''));
}

const fallback = {
  reply_text: fallbackReply(stage, base.currentProfile),
  intent: stage,
  lead_status: base.derivedStage?.status || 'en_conversacion',
  currentStage: stage,
  nextStep: base.derivedStage?.nextStep || 'Continuar conversación',
  awaitingField: base.derivedStage?.awaitingField || '',
  should_send_reply: true,
  should_escalate: stage === 'ready_for_handoff',
  handoff_ready: stage === 'ready_for_handoff',
  handoff_reason: '',
  assigned_seller: $env.DEFAULT_SELLER_NAME || 'Dueño Rioble',
  qualification: base.qualification || { level: 'nurture', score: 0, reasons: [] },
  collected: {},
  internal_note: 'fallback_agent_decision'
};

const rawPayload = http.reply_text || http.intent || http.currentStage || http.decision || http.reply
  ? http
  : (http.body && (http.body.reply_text || http.body.intent || http.body.currentStage || http.body.decision || http.body.reply) ? http.body : null);
function flattenDecision(payload) {
  if (!payload) return null;
  if (payload.reply_text || payload.intent || payload.currentStage) return payload;
  const decision = payload.decision && typeof payload.decision === 'object' ? payload.decision : {};
  const reply = payload.reply && typeof payload.reply === 'object' ? payload.reply : {};
  const handoff = payload.handoff && typeof payload.handoff === 'object' ? payload.handoff : {};
  const internal = payload.internal_report && typeof payload.internal_report === 'object' ? payload.internal_report : {};
  return {
    reply_text: reply.text || '',
    intent: decision.intent || decision.action || '',
    lead_status: decision.lead_status || internal.status || '',
    currentStage: decision.currentStage || decision.current_stage || '',
    nextStep: decision.nextStep || decision.next_step || internal.next_step || '',
    awaitingField: decision.awaitingField || decision.awaiting_field || '',
    should_send_reply: reply.should_send !== false,
    should_escalate: Boolean(handoff.required),
    handoff_ready: Boolean(handoff.ready),
    handoff_reason: handoff.reason || '',
    assigned_seller: handoff.assigned_seller || '',
    qualification: payload.qualification,
    collected: payload.captured_data || {},
    internal_note: internal.summary || ''
  };
}
const payload = flattenDecision(rawPayload);
const chosen = payload || fallback;
const rawCollected = (chosen.collected && typeof chosen.collected === 'object') ? chosen.collected : {};
const qualification = chosen.qualification && typeof chosen.qualification === 'object'
  ? chosen.qualification
  : fallback.qualification;

const normalized = {
  reply_text: String(chosen.reply_text || fallback.reply_text || '').trim() || fallback.reply_text,
  intent: String(chosen.intent || fallback.intent || 'info').trim() || 'info',
  lead_status: String(chosen.lead_status || chosen.status || fallback.lead_status || 'en_conversacion').trim() || 'en_conversacion',
  currentStage: String(chosen.currentStage || chosen.current_stage || fallback.currentStage || '').trim() || fallback.currentStage,
  nextStep: String(chosen.nextStep || chosen.next_step || fallback.nextStep || '').trim() || fallback.nextStep,
  awaitingField: String(chosen.awaitingField || chosen.awaiting_field || fallback.awaitingField || '').trim(),
  should_send_reply: chosen.should_send_reply !== false,
  should_escalate: Boolean(chosen.should_escalate || chosen.handoff_ready),
  handoff_ready: Boolean(chosen.handoff_ready || rawCollected.handoffReady),
  handoff_reason: String(chosen.handoff_reason || '').trim(),
  assigned_seller: String(chosen.assigned_seller || rawCollected.assignedSeller || fallback.assigned_seller || '').trim(),
  do_not_contact: Boolean(chosen.do_not_contact || rawCollected.doNotContact || qualification.level === 'do_not_contact' || chosen.currentStage === 'do_not_contact'),
  qualification: {
    level: String(qualification.level || 'nurture'),
    score: Number(qualification.score || 0),
    reasons: Array.isArray(qualification.reasons) ? qualification.reasons.map(String) : []
  },
  collected: rawCollected,
  internal_note: String(chosen.internal_note || '').trim()
};
if (normalized.handoff_ready) normalized.should_escalate = true;
if (sensitive(base.inbound?.mensaje || '')) {
  normalized.should_escalate = false;
  normalized.handoff_ready = false;
  normalized.reply_text = 'Permíteme confirmarlo y te digo bien para no darte un dato a medias.';
  normalized.internal_note = [normalized.internal_note, 'security_block_without_handoff'].filter(Boolean).join(' | ');
}

return { json: { ...base, agentDecision: normalized, rawAgentDecision: rawPayload || chosen, agentDecisionStatus: payload ? 'agent_ok' : 'agent_fallback' } };`;

const applyRulesCode = `const input = $json;
const decision = input.agentDecision || {};
const envio = input.envio || {};
const inbound = input.inbound || {};
const baseProfile = input.currentProfile || {};
const collected = decision.collected && typeof decision.collected === 'object' ? decision.collected : {};

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const clean = String(value).trim();
    if (clean) return clean;
  }
  return '';
}
function asArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}
function missing(value) {
  const clean = String(value || '').trim();
  return clean || 'no confirmado';
}

const qualification = decision.qualification || input.qualification || { level: 'nurture', score: 0, reasons: [] };
const profile = {
  ...baseProfile,
  fullName: firstNonEmpty(collected.fullName, baseProfile.fullName, envio.nombre, inbound.nombre_perfil),
  phone: firstNonEmpty(collected.phone, baseProfile.phone, inbound.telefono, envio.telefono_digits),
  interestType: firstNonEmpty(collected.interestType, baseProfile.interestType, 'unknown'),
  propertyType: firstNonEmpty(collected.propertyType, baseProfile.propertyType),
  zones: Array.from(new Set([...asArray(baseProfile.zones), ...asArray(collected.zones)])),
  budgetMin: firstNonEmpty(collected.budgetMin, baseProfile.budgetMin),
  budgetMax: firstNonEmpty(collected.budgetMax, baseProfile.budgetMax),
  rentBudget: firstNonEmpty(collected.rentBudget, baseProfile.rentBudget),
  timeline: firstNonEmpty(collected.timeline, baseProfile.timeline),
  paymentMethod: firstNonEmpty(collected.paymentMethod, baseProfile.paymentMethod),
  financingStatus: firstNonEmpty(collected.financingStatus, baseProfile.financingStatus),
  bedrooms: firstNonEmpty(collected.bedrooms, baseProfile.bedrooms),
  sellerPropertyAddress: firstNonEmpty(collected.sellerPropertyAddress, baseProfile.sellerPropertyAddress),
  sellerAskingPrice: firstNonEmpty(collected.sellerAskingPrice, baseProfile.sellerAskingPrice),
  summary: firstNonEmpty(collected.summary, baseProfile.summary),
  nextBestAction: firstNonEmpty(collected.nextBestAction, baseProfile.nextBestAction, decision.nextStep),
  assignedSeller: firstNonEmpty(decision.assigned_seller, collected.assignedSeller, baseProfile.assignedSeller, $env.DEFAULT_SELLER_NAME, 'Dueño Rioble'),
  assignedSellerPhone: firstNonEmpty(collected.assignedSellerPhone, baseProfile.assignedSellerPhone, $env.SELLER_NOTIFY_PHONE, $env.DEFAULT_SELLER_PHONE, '+5213316994400'),
  qualificationLevel: firstNonEmpty(qualification.level, baseProfile.qualificationLevel, 'nurture'),
  qualificationScore: Number(qualification.score || baseProfile.qualificationScore || 0),
  qualificationReasons: Array.isArray(qualification.reasons) ? qualification.reasons : [],
};

const doNotContact = Boolean(decision.do_not_contact || profile.qualificationLevel === 'do_not_contact' || decision.currentStage === 'do_not_contact');
const alreadyHandoff = String(envio.etapa_conversacion || '') === 'handoff_sent' || ['sent', 'delivered', 'read'].includes(String(envio.handoff_status || input.sellerHandoffStatus || '').toLowerCase());

let currentStage = decision.currentStage || input.derivedStage?.currentStage || 'new_reply';
let commercialStatus = decision.lead_status || input.derivedStage?.status || 'en_conversacion';
let awaitingField = decision.awaitingField || input.derivedStage?.awaitingField || '';
let nextStep = decision.nextStep || input.derivedStage?.nextStep || 'Continuar conversación';

if (alreadyHandoff) {
  currentStage = 'handoff_sent';
  commercialStatus = 'asignado_a_vendedor';
  awaitingField = 'none';
  nextStep = 'Seguimiento humano por vendedor';
} else if (doNotContact) {
  currentStage = 'do_not_contact';
  commercialStatus = 'no_contactar';
  awaitingField = 'none';
  nextStep = 'No insistir';
} else if (decision.currentStage === 'not_interested' || profile.interestType === 'not_interested') {
  currentStage = 'not_interested';
  commercialStatus = 'no_interesado';
  awaitingField = 'none';
  nextStep = 'Cerrar suave sin insistir';
} else if (decision.should_escalate || decision.handoff_ready || currentStage === 'ready_for_handoff') {
  currentStage = 'ready_for_handoff';
  commercialStatus = 'prospecto_caliente';
  awaitingField = 'none';
  nextStep = 'Notificar vendedor con resumen';
}

const defaultHandoffReply = profile.interestType === 'sell'
  ? 'Perfecto, ya tengo los datos base. Te conecto con un compañero especialista para revisar tu propiedad y el siguiente paso.'
  : profile.interestType === 'buy' || profile.interestType === 'invest'
    ? 'Perfecto, con eso ya puedo ubicar mejor opciones. Te conecto con un compañero especialista para que te comparta propiedades que encajen contigo.'
    : 'Perfecto, ya tengo lo importante. Te conecto con un compañero especialista para que te comparta el siguiente paso.';
const replyText = String(decision.reply_text || '').trim() || (currentStage === 'ready_for_handoff' ? defaultHandoffReply : '');
const canReplyWithoutHandoff = Boolean(replyText && !alreadyHandoff && !doNotContact);
const budget = profile.interestType === 'rent' ? profile.rentBudget : (profile.budgetMax || profile.sellerAskingPrice);
const profileSummary = profile.summary || [
  'Interés: ' + missing(profile.interestType),
  'Tipo: ' + missing(profile.propertyType),
  'Zona: ' + (profile.zones?.length ? profile.zones.join(', ') : missing(profile.sellerPropertyAddress)),
  'Presupuesto/precio: ' + missing(budget),
  'Plazo: ' + missing(profile.timeline)
].join(' | ');

const suggestedNext = profile.nextBestAction || (profile.interestType === 'sell'
  ? 'Llamar para validar datos de la propiedad y agendar valuación.'
  : 'Mandarle 2-3 opciones que encajen y proponer llamada/visita.');
const conversationKey = 'envios:' + String(envio.id || '');
const lastInboundMessage = String(inbound.mensaje || '').trim();
const sellerMessage = [
  'Nuevo prospecto inmobiliario',
  '',
  'Nombre: ' + missing(profile.fullName || inbound.nombre_perfil),
  'Telefono: +' + (String(profile.phone || inbound.telefono || '').replace(/^\\+/, '') || 'no confirmado'),
  'Tipo: ' + missing(profile.interestType),
  'Calificacion: ' + missing(profile.qualificationLevel) + ' (' + Number(profile.qualificationScore || 0) + '/100)',
  '',
  'Resumen:',
  missing(profile.summary || profileSummary),
  '',
  'Datos clave:',
  '- Zona: ' + (profile.zones?.length ? profile.zones.join(', ') : missing(profile.sellerPropertyAddress)),
  '- Propiedad: ' + missing(profile.propertyType),
  '- Presupuesto/precio: ' + missing(budget),
  '- Timeline: ' + missing(profile.timeline),
  '- Pago/credito: ' + missing(profile.paymentMethod || profile.financingStatus),
  '',
  'Ultimo mensaje:',
  '"' + missing(lastInboundMessage) + '"',
  '',
  'Siguiente paso sugerido:',
  suggestedNext,
  '',
  'Conversation key: ' + conversationKey
].join('\\n');

return {
  json: {
    ...input,
    envioId: envio.id,
    phone: profile.phone || inbound.telefono || envio.telefono_digits,
    phoneNumberId: inbound.phone_number_id || '',
    profile,
    profileSummary,
    currentStage,
    commercialStatus,
    awaitingField,
    nextStep,
    reply_text: replyText,
    shouldSendReply: Boolean(canReplyWithoutHandoff && (decision.should_send_reply !== false || currentStage !== 'ready_for_handoff')),
    shouldNotifySeller: Boolean((decision.should_escalate || decision.handoff_ready || currentStage === 'ready_for_handoff') && !doNotContact && !alreadyHandoff),
    noEnviar: doNotContact,
    sellerHandoffPayload: {
      envioId: envio.id,
      conversationKey,
      sellerName: profile.assignedSeller || 'Dueño Rioble',
      sellerPhone: profile.assignedSellerPhone || '+5213316994400',
      summary: sellerMessage,
      handoffPayload: { profile, qualification: { level: profile.qualificationLevel, score: profile.qualificationScore, reasons: profile.qualificationReasons }, nextBestAction: suggestedNext, source_message_id: inbound.message_id || '' }
    },
    technicalStatus: [input.agentDecisionStatus, currentStage, input.sellerHandoffStatus ? 'handoff_exists' : 'handoff_new'].filter(Boolean).join(';')
  }
};`;

const updateProfileQuery = `update public.envios
set
  etapa_conversacion = nullif($2::text, ''),
  estatus_comercial = nullif($3::text, ''),
  awaiting_field = nullif($4::text, ''),
  next_step = nullif($5::text, ''),
  perfil_inmobiliario = coalesce(nullif($6::text, '')::jsonb, '{}'::jsonb),
  qualification_level = nullif($7::text, ''),
  qualification_score = nullif($8::text, '')::integer,
  assigned_seller = nullif($9::text, ''),
  no_enviar = case when nullif($10::text, '')::boolean then true else no_enviar end,
  no_contactar_at = case when nullif($10::text, '')::boolean then coalesce(no_contactar_at, now()) else no_contactar_at end,
  estado = case
    when nullif($10::text, '')::boolean then 'no_contactar'
    when $2::text = 'not_interested' then 'no_interesado'
    else estado
  end,
  updated_at = now()
where id = nullif($1::text, '')::integer
returning id, estado, etapa_conversacion, estatus_comercial, handoff_status;`;

const sendReplyCode = `let input = $json;
try {
  const base = $('Apply Business Rules').first().json;
  if (base && (base.reply_text || base.sellerHandoffPayload) && !($json.reply_text || $json.sellerHandoffPayload)) {
    input = base;
  }
} catch {}
const apiVersion = String($env.META_GRAPH_VERSION || 'v25.0').trim();
const phoneNumberId = String(input.phoneNumberId || $env.META_PHONE_NUMBER_ID || $env.META_WHATSAPP_PHONE_NUMBER_ID || '').trim();
const token = String($env.META_WA_TOKEN || $env.META_WHATSAPP_TOKEN || '').trim();
if (!phoneNumberId || !token) throw new Error('Faltan META_PHONE_NUMBER_ID o META_WA_TOKEN');

function normalizeWhatsappPhone(value) {
  let phone = String(value || '').replace(/[^\\d+]/g, '');
  if (phone.startsWith('+')) phone = phone.slice(1);
  if (phone.startsWith('00')) phone = phone.slice(2);
  if (phone.startsWith('011')) phone = phone.slice(3);
  phone = phone.replace(/\\D/g, '');
  if (phone.length === 10) phone = '52' + phone;
  if (phone.startsWith('521') && phone.length === 13) phone = '52' + phone.slice(3);
  if (!/^\\d{8,15}$/.test(phone)) throw new Error('Telefono invalido para WhatsApp Cloud API: ' + value);
  return phone;
}

const to = normalizeWhatsappPhone(input.phone);
const body = String(input.reply_text || '').slice(0, 4096);
const response = await this.helpers.httpRequest({
  method: 'POST',
  url: 'https://graph.facebook.com/' + apiVersion + '/' + phoneNumberId + '/messages',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body } },
  json: true,
  returnFullResponse: true,
  ignoreHttpStatusErrors: true,
});
const responseBody = typeof response.body === 'string' ? { raw: response.body } : (response.body || {});
const statusCode = response.statusCode || response.status;
const providerMessageId = String(responseBody.messages?.[0]?.id || '').trim();
return {
  json: {
    ...input,
    replySendStatus: statusCode >= 200 && statusCode < 300 && providerMessageId ? 'sent' : 'failed',
    replyProviderMessageId: providerMessageId,
    replySentAt: new Date().toISOString(),
    replyApiResponse: responseBody,
    replyError: statusCode >= 200 && statusCode < 300 ? '' : ('HTTP ' + statusCode)
  }
};`;

const insertReplyQuery = `insert into public.conversaciones (
  id,
  timestamp,
  direccion,
  telefono,
  wa_id,
  nombre_perfil,
  mensaje,
  tipo,
  message_id,
  phone_number_id,
  display_phone_number,
  payload
)
values (
  nullif($1::text, '')::integer,
  coalesce(nullif($2::text, '')::timestamptz, now()),
  'saliente',
  nullif($3::text, ''),
  nullif($3::text, ''),
  'Sofía Tapia',
  nullif($4::text, ''),
  'text',
  nullif($5::text, ''),
  nullif($6::text, ''),
  nullif($7::text, ''),
  coalesce(nullif($8::text, '')::jsonb, '{}'::jsonb)
)
on conflict (message_id) where message_id is not null
do nothing
returning conversation_pk, id, timestamp, direccion, message_id;`;

const sendSellerCode = sendReplyCode
  .replace('const to = normalizeWhatsappPhone(input.phone);', "const to = normalizeWhatsappPhone(input.sellerHandoffPayload?.sellerPhone || $env.SELLER_NOTIFY_PHONE || $env.DEFAULT_SELLER_PHONE || '+5213316994400');")
  .replace("const body = String(input.reply_text || '').slice(0, 4096);", "const body = String(input.sellerHandoffPayload?.summary || '').slice(0, 4096);")
  .replace(/replySendStatus/g, 'sellerNotifyStatus')
  .replace(/replyProviderMessageId/g, 'sellerNotifyProviderMessageId')
  .replace(/replySentAt/g, 'sellerNotifySentAt')
  .replace(/replyApiResponse/g, 'sellerNotifyApiResponse')
  .replace(/replyError/g, 'sellerNotifyError');

const recordHandoffQuery = `with inserted as (
  insert into public.seller_handoffs (
    envio_id,
    conversation_key,
    seller_name,
    seller_phone,
    status,
    provider_message_id,
    handoff_payload,
    error_message,
    n8n_execution_id
  )
  values (
    nullif($1::text, '')::integer,
    nullif($2::text, ''),
    nullif($3::text, ''),
    nullif($4::text, ''),
    coalesce(nullif($5::text, ''), 'sent'),
    nullif($6::text, ''),
    coalesce(nullif($7::text, '')::jsonb, '{}'::jsonb),
    nullif($8::text, ''),
    nullif($9::text, '')
  )
  on conflict (conversation_key)
  do update set
    seller_name = coalesce(excluded.seller_name, public.seller_handoffs.seller_name),
    seller_phone = coalesce(excluded.seller_phone, public.seller_handoffs.seller_phone),
    status = case when public.seller_handoffs.status in ('sent', 'delivered', 'read') then public.seller_handoffs.status else excluded.status end,
    provider_message_id = coalesce(public.seller_handoffs.provider_message_id, excluded.provider_message_id),
    handoff_payload = coalesce(public.seller_handoffs.handoff_payload, '{}'::jsonb) || excluded.handoff_payload,
    error_message = coalesce(excluded.error_message, public.seller_handoffs.error_message),
    updated_at = now()
  returning *
), updated_envio as (
  update public.envios e
  set
    handoff_status = inserted.status,
    handoff_at = case when inserted.status in ('sent', 'delivered', 'read') then now() else e.handoff_at end,
    etapa_conversacion = case when inserted.status in ('sent', 'delivered', 'read') then 'handoff_sent' else e.etapa_conversacion end,
    estatus_comercial = case when inserted.status in ('sent', 'delivered', 'read') then 'asignado_a_vendedor' else e.estatus_comercial end,
    next_step = case when inserted.status in ('sent', 'delivered', 'read') then 'Seguimiento humano por vendedor' else e.next_step end,
    updated_at = now()
  from inserted
  where e.id = inserted.envio_id
  returning e.id
)
select inserted.id::text as "handoffUuid", inserted.status, inserted.provider_message_id as "providerMessageId", (select count(*) from updated_envio)::int as "updatedEnvioCount"
from inserted;`;

const newNodes = [
  postgresNode('Leer contexto inmobiliario', 'leer_contexto_inmobiliario', [1780, 180], readContextQuery, "={{ [ $json.id || '', $('Normalizar mensajes').first().json.telefono || '', $('Normalizar mensajes').first().json.message_id || '' ] }}"),
  ifNode('New Inbound Message?', 'new_inbound_message_inmobiliario', [1560, 208], '={{Boolean($json.conversation_pk && $json.id)}}'),
  allowlistIfNode('Only Test Phone?', 'only_test_phone_inmobiliario', [2000, 180]),
  codeNode('Build Conversation Context', 'build_conversation_context_inmobiliario', [2220, 180], buildContextCode),
  httpNode('Call Agent Decision', 'call_agent_decision_inmobiliario', [2440, 180], {
    method: 'POST',
    url: "={{(() => { const base = String($env.AGENT_DECISION_URL || '').trim(); if (!base) return 'http://host.docker.internal:8787/decide-whatsapp'; return base.replace(/\\/+$/, '').replace(/\\/decide(?:-instagram|-whatsapp)?$/, '') + '/decide-whatsapp'; })()}}",
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Authorization', value: "= {{$env.AGENT_DECISION_TOKEN ? `Bearer ${$env.AGENT_DECISION_TOKEN}` : ''}}" },
        { name: 'X-RealEstate-Bridge-Source', value: 'real-estate-whatsapp-agent-runtime' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{$json.agentPayload}}',
    options: { response: { response: { neverError: true, responseFormat: 'json' } } },
  }),
  codeNode('Resolve Final Decision', 'resolve_final_decision_inmobiliario', [2660, 180], resolveDecisionCode),
  codeNode('Apply Business Rules', 'apply_business_rules_inmobiliario', [2880, 180], applyRulesCode),
  postgresNode('Actualizar perfil envio', 'actualizar_perfil_envio', [3100, 180], updateProfileQuery, "={{ [ $json.envioId || '', $json.currentStage || '', $json.commercialStatus || '', $json.awaitingField || '', $json.nextStep || '', JSON.stringify($json.profile || {}), $json.profile?.qualificationLevel || '', String($json.profile?.qualificationScore || 0), $json.profile?.assignedSeller || '', String(Boolean($json.noEnviar)) ] }}"),
  ifNode('Should Notify Seller?', 'should_notify_seller_inmobiliario', [3320, 80], "={{Boolean($('Apply Business Rules').first().json.shouldNotifySeller)}}"),
  codeNode('Send WhatsApp to Seller', 'send_whatsapp_to_seller_inmobiliario', [3540, -20], sendSellerCode),
  postgresNode('Record Handoff Event', 'record_handoff_event_inmobiliario', [3760, -20], recordHandoffQuery, "={{ [ $json.sellerHandoffPayload?.envioId || '', $json.sellerHandoffPayload?.conversationKey || '', $json.sellerHandoffPayload?.sellerName || '', $json.sellerHandoffPayload?.sellerPhone || '', $json.sellerNotifyStatus || '', $json.sellerNotifyProviderMessageId || '', JSON.stringify($json.sellerHandoffPayload?.handoffPayload || {}), $json.sellerNotifyError || '', String($execution.id) ] }}"),
  ifNode('Should Send Reply?', 'should_send_reply_inmobiliario', [3980, 180], "={{(() => { const base = $('Apply Business Rules').first().json; let sellerStatus = ''; try { sellerStatus = String($('Send WhatsApp to Seller').first().json.sellerNotifyStatus || ''); } catch {} return Boolean(base.shouldSendReply && (!base.shouldNotifySeller || sellerStatus === 'sent')); })()}}"),
  codeNode('Send WhatsApp Reply', 'send_whatsapp_reply_inmobiliario', [4200, 80], sendReplyCode),
  postgresNode('Insertar respuesta outbound', 'insertar_respuesta_outbound_inmobiliario', [4420, 80], insertReplyQuery, "={{ [ $json.envioId || '', $json.replySentAt || '', $json.phone || '', $json.reply_text || '', $json.replyProviderMessageId || '', $json.phoneNumberId || '', '', JSON.stringify({ source: 'agent_reply', response: $json.replyApiResponse || {}, status: $json.replySendStatus || '', error: $json.replyError || '' }) ] }}"),
];

workflow.nodes.push(...newNodes);

workflow.connections['Marcar envio respondio'] = {
  main: [[{ node: 'Leer contexto inmobiliario', type: 'main', index: 0 }]],
};
workflow.connections['Insertar conversacion'] = {
  main: [[{ node: 'New Inbound Message?', type: 'main', index: 0 }]],
};
workflow.connections['New Inbound Message?'] = {
  main: [[{ node: 'Marcar envio respondio', type: 'main', index: 0 }], []],
};
workflow.connections['Leer contexto inmobiliario'] = {
  main: [[{ node: 'Only Test Phone?', type: 'main', index: 0 }]],
};
workflow.connections['Only Test Phone?'] = {
  main: [[{ node: 'Build Conversation Context', type: 'main', index: 0 }], []],
};
workflow.connections['Build Conversation Context'] = {
  main: [[{ node: 'Call Agent Decision', type: 'main', index: 0 }]],
};
workflow.connections['Call Agent Decision'] = {
  main: [[{ node: 'Resolve Final Decision', type: 'main', index: 0 }]],
};
workflow.connections['Resolve Final Decision'] = {
  main: [[{ node: 'Apply Business Rules', type: 'main', index: 0 }]],
};
workflow.connections['Apply Business Rules'] = {
  main: [[{ node: 'Actualizar perfil envio', type: 'main', index: 0 }]],
};
workflow.connections['Actualizar perfil envio'] = {
  main: [[{ node: 'Should Notify Seller?', type: 'main', index: 0 }]],
};
workflow.connections['Should Notify Seller?'] = {
  main: [
    [{ node: 'Send WhatsApp to Seller', type: 'main', index: 0 }],
    [{ node: 'Should Send Reply?', type: 'main', index: 0 }],
  ],
};
workflow.connections['Send WhatsApp to Seller'] = {
  main: [[{ node: 'Record Handoff Event', type: 'main', index: 0 }]],
};
workflow.connections['Record Handoff Event'] = {
  main: [[{ node: 'Should Send Reply?', type: 'main', index: 0 }]],
};
workflow.connections['Should Send Reply?'] = {
  main: [
    [{ node: 'Send WhatsApp Reply', type: 'main', index: 0 }],
    [],
  ],
};
workflow.connections['Send WhatsApp Reply'] = {
  main: [[{ node: 'Insertar respuesta outbound', type: 'main', index: 0 }]],
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(workflow, null, 2) + '\n');
