-- Additive schema for the copied workflow:
-- "Rioble WhatsApp - Respuestas MVP Inmobiliaria".
-- It extends the current Postgres flow based on envios/conversaciones.

alter table public.envios
  add column if not exists etapa_conversacion text,
  add column if not exists estatus_comercial text,
  add column if not exists awaiting_field text,
  add column if not exists next_step text,
  add column if not exists perfil_inmobiliario jsonb not null default '{}'::jsonb,
  add column if not exists qualification_level text,
  add column if not exists qualification_score integer,
  add column if not exists assigned_seller text,
  add column if not exists handoff_status text,
  add column if not exists handoff_at timestamptz,
  add column if not exists no_contactar_at timestamptz;

create index if not exists envios_etapa_conversacion_idx
  on public.envios (etapa_conversacion);

create index if not exists envios_estatus_comercial_idx
  on public.envios (estatus_comercial);

create index if not exists envios_handoff_status_idx
  on public.envios (handoff_status);

create index if not exists envios_perfil_inmobiliario_gin_idx
  on public.envios using gin (perfil_inmobiliario);

create table if not exists public.seller_handoffs (
  id uuid primary key default gen_random_uuid(),
  envio_id integer references public.envios(id) on delete set null,
  conversation_key text not null,
  seller_name text,
  seller_phone text,
  status text not null default 'pending',
  provider_message_id text,
  handoff_payload jsonb not null default '{}'::jsonb,
  error_message text,
  n8n_execution_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seller_handoffs_status_check
    check (status in ('pending', 'sent', 'delivered', 'read', 'failed', 'cancelled', 'config_error'))
);

create unique index if not exists seller_handoffs_conversation_key_unique
  on public.seller_handoffs (conversation_key);

create index if not exists seller_handoffs_envio_id_idx
  on public.seller_handoffs (envio_id);

create index if not exists seller_handoffs_provider_message_id_idx
  on public.seller_handoffs (provider_message_id)
  where provider_message_id is not null;

create index if not exists seller_handoffs_status_idx
  on public.seller_handoffs (status);
