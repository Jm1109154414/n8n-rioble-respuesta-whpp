#!/usr/bin/env python3
"""Local HTTP bridge between n8n and the OpenClaw Sofía agent."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


DEFAULT_AGENT_ID = "realestate-sales"
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8787
MAX_BODY_BYTES = 256 * 1024
ALLOWED_ACTIONS = {"reply", "ask_next_question", "handoff", "mark_do_not_contact", "close", "no_action"}
ALLOWED_LEAD_STATUSES = {
    "nuevo",
    "en_conversacion",
    "perfil_incompleto",
    "necesidad_detectada",
    "prospecto_caliente",
    "asignado_a_vendedor",
    "seguimiento_humano",
    "nutricion",
    "no_interesado",
    "no_contactar",
}
ALLOWED_STAGES = {
    "new_reply",
    "detect_interest",
    "qualify_buyer",
    "qualify_seller",
    "qualify_renter",
    "qualify_investor",
    "ready_for_handoff",
    "handoff_sent",
    "nurture",
    "not_interested",
    "do_not_contact",
}
ALLOWED_LIGHTS = {"green", "yellow", "red", "unknown"}
ALLOWED_LEVELS = {"hot", "warm", "cold", "nurture", "do_not_contact"}


def normalize_phone(value: Any) -> str:
    digits = re.sub(r"\D+", "", str(value or ""))
    if digits.startswith("00"):
        digits = digits[2:]
    return f"+{digits}" if digits else ""


def phones_match(left: Any, right: Any) -> bool:
    return normalize_phone(left) == normalize_phone(right)


def response_template(reason: str, status: str = "error") -> dict[str, Any]:
    should_send = status not in {"error", "ignored"}
    return {
        "ok": status != "error",
        "decision": {
            "action": "no_action",
            "intent": "system_guard",
            "lead_status": "en_conversacion",
            "currentStage": "detect_interest",
            "nextStep": reason,
            "awaitingField": "",
            "traffic_light": "unknown",
        },
        "reply": {
            "should_send": should_send,
            "text": "",
        },
        "handoff": {
            "required": False,
            "ready": False,
            "reason": "",
            "assigned_seller": os.environ.get("DEFAULT_SELLER_NAME", "Dueño Rioble"),
            "assigned_seller_phone": os.environ.get("DEFAULT_SELLER_PHONE", "+5213316994400"),
        },
        "qualification": {
            "level": "nurture",
            "score": 0,
            "reasons": [reason],
        },
        "captured_data": {},
        "missing_data": [],
        "internal_report": {
            "summary": reason,
            "status": status,
            "traffic_light": "unknown",
            "next_step": reason,
        },
    }


def coerce_choice(value: Any, allowed: set[str], fallback: str) -> str:
    text = str(value or "").strip()
    return text if text in allowed else fallback


def coerce_int(value: Any, minimum: int, maximum: int, fallback: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, number))


def coerce_response_contract(response: dict[str, Any]) -> dict[str, Any]:
    decision = response.setdefault("decision", {})
    reply = response.setdefault("reply", {})
    handoff = response.setdefault("handoff", {})
    qualification = response.setdefault("qualification", {})
    internal_report = response.setdefault("internal_report", {})

    action = coerce_choice(decision.get("action"), ALLOWED_ACTIONS, "reply")
    handoff_required = bool(handoff.get("required") or action == "handoff")
    do_not_contact = action == "mark_do_not_contact"

    decision["action"] = "handoff" if handoff_required else action
    decision["intent"] = str(decision.get("intent") or "unknown")
    decision["traffic_light"] = coerce_choice(decision.get("traffic_light"), ALLOWED_LIGHTS, "unknown")

    if do_not_contact:
        decision["lead_status"] = "no_contactar"
        decision["currentStage"] = "do_not_contact"
    elif handoff_required:
        decision["lead_status"] = "prospecto_caliente"
        decision["currentStage"] = "ready_for_handoff"
        decision["traffic_light"] = "green"
    else:
        decision["lead_status"] = coerce_choice(decision.get("lead_status"), ALLOWED_LEAD_STATUSES, "necesidad_detectada")
        decision["currentStage"] = coerce_choice(decision.get("currentStage"), ALLOWED_STAGES, "qualify_buyer")

    decision["nextStep"] = str(decision.get("nextStep") or "")
    decision["awaitingField"] = str(decision.get("awaitingField") or "")

    reply["should_send"] = bool(reply.get("should_send"))
    reply["text"] = str(reply.get("text") or "")

    handoff["required"] = handoff_required
    handoff["ready"] = bool(handoff.get("ready") or handoff_required)
    handoff["reason"] = str(handoff.get("reason") or "")
    handoff["assigned_seller"] = str(handoff.get("assigned_seller") or os.environ.get("DEFAULT_SELLER_NAME", "Dueño Rioble"))
    handoff["assigned_seller_phone"] = str(
        handoff.get("assigned_seller_phone") or os.environ.get("DEFAULT_SELLER_PHONE", "+5213316994400")
    )

    qualification["level"] = coerce_choice(qualification.get("level"), ALLOWED_LEVELS, "warm")
    qualification["score"] = coerce_int(qualification.get("score"), 0, 100, 50)
    reasons = qualification.get("reasons")
    qualification["reasons"] = reasons if isinstance(reasons, list) else []

    if not isinstance(response.get("captured_data"), dict):
        response["captured_data"] = {}
    if not isinstance(response.get("missing_data"), list):
        response["missing_data"] = []

    internal_report["summary"] = str(internal_report.get("summary") or "")
    internal_report["status"] = str(internal_report.get("status") or decision["lead_status"])
    internal_report["traffic_light"] = coerce_choice(internal_report.get("traffic_light"), ALLOWED_LIGHTS, decision["traffic_light"])
    internal_report["next_step"] = str(internal_report.get("next_step") or decision["nextStep"])

    response["ok"] = bool(response.get("ok", True))
    return response


def extract_json_object(text: str) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    for idx, char in enumerate(text):
        if char != "{":
            continue
        try:
            value, _end = decoder.raw_decode(text[idx:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise ValueError("No JSON object found in OpenClaw output")


def extract_agent_text(cli_stdout: str) -> str:
    parsed = extract_json_object(cli_stdout)
    result = parsed.get("result") or {}
    meta = result.get("meta") or {}
    text = meta.get("finalAssistantVisibleText") or meta.get("finalAssistantRawText")
    if isinstance(text, str) and text.strip():
        return text.strip()

    payloads = result.get("payloads") or []
    for payload in payloads:
        if isinstance(payload, dict) and isinstance(payload.get("text"), str):
            candidate = payload["text"].strip()
            if candidate:
                return candidate

    raise ValueError("OpenClaw output did not include assistant text")


def normalize_agent_response(agent_text: str) -> dict[str, Any]:
    response = extract_json_object(agent_text)

    if "decision" in response and "reply" in response:
        return coerce_response_contract(response)

    return coerce_response_contract({
        "ok": bool(response.get("ok", True)),
        "decision": {
            "action": response.get("action") or "reply",
            "intent": response.get("intent") or "unknown",
            "lead_status": response.get("lead_status") or "en_conversacion",
            "currentStage": response.get("currentStage") or response.get("current_stage") or "detect_interest",
            "nextStep": response.get("nextStep") or response.get("next_step") or "",
            "awaitingField": response.get("awaitingField") or response.get("awaiting_field") or "",
            "traffic_light": response.get("traffic_light") or "unknown",
        },
        "reply": {
            "should_send": bool(response.get("should_send_reply", response.get("should_send", True))),
            "text": response.get("reply_text") or response.get("text") or "",
        },
        "handoff": {
            "required": bool(response.get("should_escalate", False)),
            "ready": bool(response.get("handoff_ready", False)),
            "reason": response.get("handoff_reason") or "",
            "assigned_seller": response.get("assigned_seller") or os.environ.get("DEFAULT_SELLER_NAME", "Dueño Rioble"),
            "assigned_seller_phone": response.get("assigned_seller_phone") or os.environ.get("DEFAULT_SELLER_PHONE", "+5213316994400"),
        },
        "qualification": response.get("qualification") or {"level": "nurture", "score": 0, "reasons": []},
        "captured_data": response.get("collected") or response.get("captured_data") or {},
        "missing_data": response.get("missing_data") or [],
        "internal_report": {
            "summary": response.get("internal_note") or "",
            "status": response.get("lead_status") or "en_conversacion",
            "traffic_light": response.get("traffic_light") or "unknown",
            "next_step": response.get("nextStep") or response.get("next_step") or "",
        },
    })


def build_agent_prompt(payload: dict[str, Any]) -> str:
    lead = payload.get("lead") or {}
    phone = normalize_phone(lead.get("phone"))
    seller_name = os.environ.get("DEFAULT_SELLER_NAME", "Dueño Rioble")
    seller_phone = os.environ.get("DEFAULT_SELLER_PHONE", "+5213316994400")

    return (
        "Tarea interna para Sofía Tapia / Rioble WhatsApp.\n"
        "\n"
        "Recibiste este evento desde n8n. Decide qué debe contestar Sofía al lead.\n"
        "No envíes mensajes por herramientas externas; solo devuelve la decisión.\n"
        "Respeta estrictamente las reglas de Sofía: WhatsApp, una pregunta por mensaje, sin emojis, "
        "sin precios/inventario/promociones, handoff cuando corresponda y cierre exacto para no interesado.\n"
        "Orden obligatorio de recalificación: si la intención actual no está clara, primero pregunta si busca comprar, "
        "vender, invertir o rentar. No preguntes tipo de propiedad hasta saber esa intención. "
        "Si responde compra/inversión/renta, después pregunta qué tipo de propiedad busca. "
        "Si responde venta, después pregunta qué propiedad quiere vender o en qué zona está.\n"
        "\n"
        "Devuelve únicamente JSON válido, sin Markdown, sin explicación y sin texto fuera del objeto.\n"
        "El JSON debe tener exactamente esta forma general:\n"
        "{\n"
        '  "ok": true,\n'
        '  "decision": {"action": "reply|ask_next_question|handoff|mark_do_not_contact|close|no_action", '
        '"intent": "string", "lead_status": "nuevo|en_conversacion|perfil_incompleto|necesidad_detectada|prospecto_caliente|asignado_a_vendedor|seguimiento_humano|nutricion|no_interesado|no_contactar", '
        '"currentStage": "new_reply|detect_interest|qualify_buyer|qualify_seller|qualify_renter|qualify_investor|ready_for_handoff|handoff_sent|nurture|not_interested|do_not_contact", '
        '"nextStep": "string", "awaitingField": "string", "traffic_light": "green|yellow|red|unknown"},\n'
        '  "reply": {"should_send": true, "text": "string"},\n'
        f'  "handoff": {{"required": false, "ready": false, "reason": "", "assigned_seller": "{seller_name}", "assigned_seller_phone": "{seller_phone}"}},\n'
        '  "qualification": {"level": "hot|warm|cold|nurture|do_not_contact", "score": 0, "reasons": ["string"]},\n'
        '  "captured_data": {},\n'
        '  "missing_data": [],\n'
        '  "internal_report": {"summary": "string", "status": "string", "traffic_light": "green|yellow|red|unknown", "next_step": "string"}\n'
        "}\n"
        "\n"
        f"Telefono normalizado para continuidad de sesion: {phone}\n"
        "Payload n8n:\n"
        f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n"
    )


def run_openclaw_agent(payload: dict[str, Any]) -> dict[str, Any]:
    lead = payload.get("lead") or {}
    phone = normalize_phone(lead.get("phone")) or "unknown"
    session_suffix = re.sub(r"[^0-9A-Za-z_.:-]+", "-", phone.strip("+")) or "unknown"
    session_key = f"agent:{os.environ.get('OPENCLAW_AGENT_ID', DEFAULT_AGENT_ID)}:whatsapp-{session_suffix}"
    prompt = build_agent_prompt(payload)

    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".md", delete=False) as handle:
        handle.write(prompt)
        prompt_path = handle.name

    try:
        command = [
            "openclaw",
            "agent",
            "--agent",
            os.environ.get("OPENCLAW_AGENT_ID", DEFAULT_AGENT_ID),
            "--session-key",
            session_key,
            "--message-file",
            prompt_path,
            "--json",
            "--timeout",
            os.environ.get("OPENCLAW_AGENT_TIMEOUT", "120"),
        ]
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=int(os.environ.get("OPENCLAW_AGENT_TIMEOUT", "120")) + 15,
        )
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip() or completed.stdout.strip() or "OpenClaw command failed")

        agent_text = extract_agent_text(completed.stdout)
        return normalize_agent_response(agent_text)
    finally:
        try:
            os.unlink(prompt_path)
        except OSError:
            pass


class Handler(BaseHTTPRequestHandler):
    server_version = "SofiaOpenClawBridge/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}", flush=True)

    def send_json(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_json(200, {"ok": True, "service": "sofia-openclaw-bridge"})
            return
        self.send_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self) -> None:
        if self.path != "/decide-whatsapp":
            self.send_json(404, {"ok": False, "error": "not_found"})
            return

        expected_token = os.environ.get("AGENT_DECISION_TOKEN", "")
        if expected_token:
            auth_header = self.headers.get("Authorization", "")
            if auth_header != f"Bearer {expected_token}":
                self.send_json(401, {"ok": False, "error": "unauthorized"})
                return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"ok": False, "error": "invalid_content_length"})
            return

        if content_length <= 0 or content_length > MAX_BODY_BYTES:
            self.send_json(413, {"ok": False, "error": "invalid_body_size"})
            return

        try:
            body = self.rfile.read(content_length)
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(400, {"ok": False, "error": "invalid_json"})
            return

        allow_phone = os.environ.get("RIOBLE_TEST_ALLOWLIST_PHONE", "")
        lead_phone = ((payload.get("lead") or {}).get("phone")) if isinstance(payload, dict) else ""
        if allow_phone and not phones_match(lead_phone, allow_phone):
            self.send_json(200, response_template("Telefono fuera de allowlist de pruebas.", status="ignored"))
            return

        try:
            decision = run_openclaw_agent(payload)
        except Exception as exc:
            self.send_json(200, response_template(f"Error llamando a OpenClaw: {exc}"))
            return

        self.send_json(200, decision)


def main() -> None:
    parser = argparse.ArgumentParser(description="Expose Sofía/OpenClaw as /decide-whatsapp for n8n.")
    parser.add_argument("--host", default=os.environ.get("SOFIA_BRIDGE_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=int(os.environ.get("SOFIA_BRIDGE_PORT", DEFAULT_PORT)))
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Sofía OpenClaw bridge listening on http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
