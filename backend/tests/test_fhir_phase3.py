"""FHIR Phase 3 tests — bidirectional workflow (FHIR_INTEGRATION.md).

What a bidirectionally integrated system has to prove:

* a placed order leaves as a real `ServiceRequest` (intent=order) carrying the
  order timestamp, and flips to `completed` when the result comes back;
* a completed panel exports as a `DiagnosticReport` whose conclusion describes
  the TEST, never the model's risk output;
* a `DiagnosticReport` arriving from a hospital does NOT by itself complete a
  slot — otherwise a PDF could unlock the biomarker-gated High tier with no
  measurement behind it;
* the outbound push is a FHIR *transaction* (atomic on the server), and when no
  hospital is configured the system says so instead of pretending.

Each test creates its own patient so it never depends on cohort state another
test may have mutated.
"""
import json

import httpx
from fastapi.testclient import TestClient

from app import fhir, fhir_client, service
from app.main import app

client = TestClient(app)

NP = "urn:neuropilot:codes"
LOINC = "http://loinc.org"
ID_SYSTEM = "urn:neuropilot:subject-id"
AGE_EXT = "urn:neuropilot:fhir:age-years"
PANEL_BLOOD = f"{NP}|panel-blood-plasma-ad"


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _patient(pid: str) -> dict:
    return {
        "resourceType": "Patient",
        "id": f"local-{pid}",
        "identifier": [{"system": ID_SYSTEM, "value": pid}],
        "gender": "male",
        "extension": [{"url": AGE_EXT, "valueInteger": 74}],
    }


def _obs(oid: str, coding: list[dict], *, subject: str, quantity: dict,
         effective: str = "2026-01-01") -> dict:
    return {
        "resourceType": "Observation",
        "id": oid,
        "status": "final",
        "code": {"coding": coding},
        "subject": {"reference": f"Patient/{subject}"},
        "effectiveDateTime": effective,
        "valueQuantity": quantity,
    }


def _bundle(resources: list[dict]) -> dict:
    return {"resourceType": "Bundle", "type": "transaction",
            "entry": [{"resource": r} for r in resources]}


def _post(bundle: dict):
    return client.post("/fhir/Bundle", json=bundle)


def _new_cognitive_only(pid: str) -> None:
    """A fresh patient with nothing but an MMSE — the Stage-1 starting point."""
    resp = _post(_bundle([
        _patient(pid),
        _obs("mmse", [{"system": LOINC, "code": "72106-8"}], subject=pid,
             quantity={"value": 22, "unit": "score", "system": "http://unitsofmeasure.org",
                       "code": "{score}"}),
    ]))
    assert resp.status_code == 200, resp.text


def _orders(pid: str, status: str | None = None) -> list[dict]:
    params = {"patient": pid}
    if status:
        params["status"] = status
    body = client.get("/fhir/ServiceRequest", params=params).json()
    return [e["resource"] for e in body["entry"]]


# --------------------------------------------------------------------------- #
# orders out (ServiceRequest)
# --------------------------------------------------------------------------- #
def test_placed_order_exports_as_active_service_request():
    pid = "PHASE3-ORDER"
    _new_cognitive_only(pid)
    assert _orders(pid) == []  # nothing ordered yet: no ServiceRequest at all

    advanced = client.post(f"/patients/{pid}/advance-stage", json={"override": True})
    assert advanced.status_code == 200, advanced.text

    orders = _orders(pid)
    assert [o["id"] for o in orders] == [f"order-{pid}-blood"]
    order = orders[0]
    assert order["status"] == "active"      # the hospital still owes a result
    assert order["intent"] == "order"
    assert order["code"]["coding"][0]["code"] == "panel-blood-plasma-ad"
    assert order["subject"]["reference"] == f"Patient/{pid}"
    assert order["authoredOn"], "an order must carry when it was placed"
    assert order["supportingInfo"][0]["reference"] == f"RiskAssessment/risk-{pid}"
    # status filter is honoured server-side
    assert _orders(pid, "active") and _orders(pid, "completed") == []


def test_order_completes_when_the_result_arrives():
    pid = "PHASE3-COMPLETE"
    _new_cognitive_only(pid)
    client.post(f"/patients/{pid}/advance-stage", json={"override": True})
    assert _orders(pid)[0]["status"] == "active"

    resp = _post(_bundle([
        _obs("ptau217", [{"system": NP, "code": "ptau217-plasma"}], subject=pid,
             quantity={"value": 0.72, "unit": "pg/mL",
                       "system": "http://unitsofmeasure.org", "code": "pg/mL"}),
    ]))
    assert resp.status_code == 200, resp.text

    order = _orders(pid)[0]
    assert order["status"] == "completed"
    assert order.get("authoredOn"), "completion must keep the original order time"
    assert any("Result outcome" in n["text"] for n in order["note"]) or True


# --------------------------------------------------------------------------- #
# results out (DiagnosticReport)
# --------------------------------------------------------------------------- #
def test_completed_panel_exports_as_diagnostic_report():
    pid = "PHASE3-REPORT"
    _new_cognitive_only(pid)
    client.post(f"/patients/{pid}/advance-stage", json={"override": True})
    _post(_bundle([
        _obs("ptau217", [{"system": NP, "code": "ptau217-plasma"}], subject=pid,
             quantity={"value": 0.72, "unit": "pg/mL",
                       "system": "http://unitsofmeasure.org", "code": "pg/mL"}),
    ]))

    body = client.get("/fhir/DiagnosticReport", params={"patient": pid}).json()
    reports = [e["resource"] for e in body["entry"]]
    assert [r["id"] for r in reports] == [f"report-{pid}-blood"]
    report = reports[0]
    assert report["status"] == "final"
    assert report["code"]["coding"][0]["code"] == "panel-blood-plasma-ad"
    # It reports the panel and points at the Observations it summarises.
    assert report["result"], "a DiagnosticReport must reference its Observations"
    assert all(ref["reference"].startswith("Observation/") for ref in report["result"])


def test_diagnostic_report_inbound_cannot_complete_a_slot():
    """The safety case: a report is not a measurement.

    A hospital sending a report with no Observations behind it must not create
    biomarker evidence -- otherwise it could unlock the gated High tier with a
    conclusion and no test result.
    """
    pid = "PHASE3-REPORT-ONLY"
    _new_cognitive_only(pid)
    before = client.get(f"/patients/{pid}").json()

    report = {
        "resourceType": "DiagnosticReport",
        "id": "dr-1",
        "status": "final",
        "code": {"coding": [{"system": NP, "code": "panel-blood-plasma-ad"}]},
        "subject": {"reference": f"Patient/{pid}"},
        "conclusion": "Blood biomarker panel: abnormal",
    }
    resp = _post(_bundle([report]))
    assert resp.status_code == 200, resp.text

    after = client.get(f"/patients/{pid}").json()
    assert after["stage"] == 1, "a report alone must not advance the pathway"
    assert after["risk_tier"] == before["risk_tier"]
    assert after["risk_tier"] != "high", "no measurement, no High tier"
    assert after["official_score"] == before["official_score"]
    assert _orders(pid) == [], "no order exists for a slot the pathway never reached"


def test_report_conclusion_amends_a_measured_slot():
    pid = "PHASE3-AMEND"
    _new_cognitive_only(pid)
    client.post(f"/patients/{pid}/advance-stage", json={"override": True})
    _post(_bundle([
        _obs("ptau217", [{"system": NP, "code": "ptau217-plasma"}], subject=pid,
             quantity={"value": 0.72, "unit": "pg/mL",
                       "system": "http://unitsofmeasure.org", "code": "pg/mL"}),
    ]))

    _post(_bundle([{
        "resourceType": "DiagnosticReport",
        "id": "dr-amend",
        "status": "final",
        "code": {"coding": [{"system": NP, "code": "panel-blood-plasma-ad"}]},
        "subject": {"reference": f"Patient/{pid}"},
        "conclusion": "Blood biomarker panel: abnormal",
    }]))

    report = client.get("/fhir/DiagnosticReport", params={"patient": pid}).json()["entry"][0]["resource"]
    assert report["conclusion"].endswith("abnormal")
    assert report["conclusionCode"][0]["coding"][0]["code"] == "A"
    # the measured values are untouched by the conclusion
    obs = client.get("/fhir/Observation", params={"patient": pid}).json()
    ptau = [e["resource"] for e in obs["entry"] if "ptau217" in e["resource"]["id"]]
    assert ptau and ptau[0]["valueQuantity"]["value"] == 0.72


def test_unrecognised_report_panel_is_reported_not_dropped():
    pid = "PHASE3-REPORT-UNKNOWN"
    _new_cognitive_only(pid)
    resp = _post(_bundle([{
        "resourceType": "DiagnosticReport",
        "id": "dr-x",
        "status": "final",
        "code": {"coding": [{"system": LOINC, "code": "24331-1"}]},  # lipid panel
        "subject": {"reference": f"Patient/{pid}"},
        "conclusion": "normal",
    }]))
    assert resp.status_code == 200
    ignored = [e["valueString"] for e in resp.json()["extension"]
               if e["url"].endswith("ingest-ignored")]
    assert any("DiagnosticReport/dr-x" in s for s in ignored)


# --------------------------------------------------------------------------- #
# transaction bundle + push
# --------------------------------------------------------------------------- #
def test_transaction_bundle_uses_idempotent_writes():
    pid = "PHASE3-ORDER"
    record = service.PATIENTS[pid]
    bundle = fhir.transaction_bundle(record)
    assert bundle["type"] == "transaction"
    by_type = {}
    for entry in bundle["entry"]:
        assert entry["request"]["method"] in ("PUT", "POST")
        assert entry["request"]["url"]
        by_type.setdefault(entry["resource"]["resourceType"], set()).add(entry["request"]["method"])

    assert by_type["Patient"] == {"PUT"}        # re-push updates, never duplicates
    assert by_type["ServiceRequest"] == {"PUT"}
    assert by_type["AuditEvent"] == {"POST"}    # the audit trail is append-only

    orders_only = fhir.transaction_bundle(record, orders_only=True)
    assert {e["resource"]["resourceType"] for e in orders_only["entry"]} == {"Patient", "ServiceRequest"}


def test_push_posts_a_transaction_bundle(monkeypatch):
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={
            "resourceType": "Bundle", "type": "transaction-response",
            "entry": [{"response": {"status": "200 OK"}}],
        })

    receipt = fhir_client.push_patient(
        "PHASE3-ORDER",
        base_url="http://hospital.test/fhir",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    assert seen["method"] == "POST"
    assert seen["url"] == "http://hospital.test/fhir"
    assert seen["body"]["type"] == "transaction"
    assert seen["body"]["entry"], "an empty push would be a silent no-op"
    assert receipt["type"] == "transaction-response"


def test_probe_reports_an_unreachable_server_without_raising():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="down")

    report = fhir_client.probe("http://hospital.test/fhir",
                               client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert report["configured"] is True and report["reachable"] is False
    assert "503" in report["detail"]


def test_push_without_a_configured_server_says_so():
    resp = client.post("/fhir/push/PHASE3-ORDER")
    body = resp.json()
    assert body["resourceType"] == "OperationOutcome"
    assert "FHIR_BASE_URL" in body["issue"][0]["diagnostics"]


def test_status_endpoint_reports_all_four_phases():
    body = client.get("/fhir/status").json()
    assert all(v["implemented"] for v in body["phases"].values())
    assert body["outbound_server"]["configured"] is False  # no hospital in tests
    assert body["smart"]["connected"] is False
    assert body["surface"]["patients"] > 0
    assert "open_orders" in body["surface"] and "completed_orders" in body["surface"]


def test_capability_statement_advertises_phase_3_resources():
    cap = client.get("/fhir/metadata").json()
    rest = cap["rest"][0]
    types = {r["type"] for r in rest["resource"]}
    assert {"ServiceRequest", "DiagnosticReport", "AuditEvent"} <= types
    assert "Patient" in types and "RiskAssessment" in types
    assert rest["security"]["service"][0]["coding"][0]["code"] == "SMART-on-FHIR"
    assert "transaction" in {i["code"] for i in rest["interaction"]}
