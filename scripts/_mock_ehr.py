"""THROWAWAY mock SMART-on-FHIR server + EHR for manual verification only.

Run:  python scripts/_mock_ehr.py     (listens on 127.0.0.1:8123)
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ISS = "http://127.0.0.1:8123/fhir"
TOKEN = "mock-token-123"
PID = "smart-88"
NP = "urn:neuropilot:codes"
LOINC = "http://loinc.org"
SCOPE = ("launch/patient openid fhirUser patient/Patient.read patient/Observation.read "
         "patient/DiagnosticReport.read patient/RiskAssessment.read patient/RiskAssessment.write")

PATIENT = {
    "resourceType": "Patient", "id": PID, "gender": "male", "birthDate": "1949-07-19",
    "name": [{"text": "EHR Import Demo"}],
    "identifier": [{"system": "http://hospital.test/mrn", "value": "MRN-2291"}],
}


def obs(oid, system, code, value, unit):
    return {
        "resourceType": "Observation", "id": oid, "status": "final",
        "code": {"coding": [{"system": system, "code": code}]},
        "subject": {"reference": f"Patient/{PID}"},
        "effectiveDateTime": "2026-08-20",
        "valueQuantity": {"value": value, "unit": unit,
                          "system": "http://unitsofmeasure.org", "code": unit},
    }


OBSERVATIONS = [
    obs("o-mmse", LOINC, "72106-8", 22, "{score}"),
    obs("o-ptau217", NP, "ptau217-plasma", 0.66, "pg/mL"),
    obs("o-nfl", NP, "nfl-plasma", 33.1, "pg/mL"),
    obs("o-hippo", NP, "hippocampal-volume", 2.62, "cm3"),
    obs("o-cent", NP, "centiloids", 77, "1"),
    obs("o-hr", LOINC, "8867-4", 68, "/min"),
]
REPORTS = [{
    "resourceType": "DiagnosticReport", "id": "dr-blood", "status": "final",
    "code": {"coding": [{"system": NP, "code": "panel-blood-plasma-ad"}]},
    "subject": {"reference": f"Patient/{PID}"},
    "issued": "2026-08-21T09:00:00Z", "conclusion": "abnormal",
}]
CAPABILITY = {"resourceType": "CapabilityStatement", "fhirVersion": "4.0.1",
              "kind": "instance", "software": {"name": "Mock SMART EHR"},
              "rest": [{"mode": "server"}]}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _json(self, payload, code=200):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/fhir+json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path.rstrip("/")
        if path.endswith("/.well-known/smart-configuration"):
            return self._json({"authorization_endpoint": f"{ISS}/authorize",
                               "token_endpoint": f"{ISS}/token",
                               "code_challenge_methods_supported": ["S256"]})
        if path.endswith("/metadata"):
            return self._json(CAPABILITY)
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            return self._json({"resourceType": "OperationOutcome", "issue": [
                {"severity": "error", "code": "login", "diagnostics": "missing or bad bearer token"}]}, 401)
        if path.endswith(f"/Patient/{PID}"):
            return self._json(PATIENT)
        if path.endswith("/Observation"):
            return self._json({"resourceType": "Bundle", "type": "searchset",
                               "entry": [{"resource": o} for o in OBSERVATIONS]})
        if path.endswith("/DiagnosticReport"):
            return self._json({"resourceType": "Bundle", "type": "searchset",
                               "entry": [{"resource": r} for r in REPORTS]})
        return self._json({"resourceType": "OperationOutcome"}, 404)

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if urlparse(self.path).path.rstrip("/").endswith("/token"):
            return self._json({"access_token": TOKEN, "token_type": "Bearer", "expires_in": 3600,
                               "scope": SCOPE, "patient": f"Patient/{PID}",
                               "refresh_token": "mock-refresh"})
        return self._json({"resourceType": "OperationOutcome"}, 404)


if __name__ == "__main__":
    print(f"[mock-ehr] {ISS} (token={TOKEN}, patient={PID})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8123), Handler).serve_forever()
