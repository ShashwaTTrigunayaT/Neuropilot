// The dashboard's ONLY data source is the FastAPI backend.
// In dev: defaults to http://127.0.0.1:8000. In production: defaults to same-origin relative URLs.
const API_BASE = (
  import.meta.env.VITE_API_URL !== undefined
    ? import.meta.env.VITE_API_URL
    : (import.meta.env.PROD ? '' : 'http://127.0.0.1:8000')
).replace(/\/$/, '');

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch {
    throw new Error(`Cannot reach the API at ${API_BASE} — is the backend running?`);
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let fhir = null;
    try {
      const body = await res.json();
      if (body && body.resourceType === 'OperationOutcome') {
        // FHIR surfaces refusals as an OperationOutcome with one issue per
        // offender — keep every one of them, not just the first.
        fhir = body;
        const issues = (body.issue || [])
          .map((i) => i.diagnostics || i.code)
          .filter(Boolean);
        if (issues.length) message = issues.join('\n');
      } else if (typeof body.detail === 'string') {
        message = body.detail;
      }
    } catch {
      /* non-JSON error body */
    }
    const err = new Error(message);
    err.status = res.status;
    err.fhir = fhir;
    throw err;
  }
  return res.json();
}

export const api = {
  health: () => request('/health'),
  listPatients: (params = {}) => request(`/patients?${new URLSearchParams(params)}`),
  // Fetch the whole cohort, paging under the API's limit-200 guardrail.
  listAllPatients: async () => {
    const first = await request('/patients?limit=200&page=1');
    const items = [...first.items];
    const totalPages = Math.ceil(first.total / 200);
    const pages = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, i) => request(`/patients?limit=200&page=${i + 2}`))
    );
    pages.forEach((p) => items.push(...p.items));
    return items;
  },
  getPatient: (id) => request(`/patients/${encodeURIComponent(id)}`),
  // Rank 2..6 selected patients with the explicit tiebreak ladder
  comparePatients: (ids) =>
    request('/patients/compare', {
      method: 'POST',
      body: JSON.stringify({ patient_ids: ids }),
    }),
  getPipeline: (id) => request(`/patients/${encodeURIComponent(id)}/pipeline`),
  // Refined-model outlook (trajectory, projected score and tier).
  getOutlook: (id) => request(`/patients/${encodeURIComponent(id)}/refined`),
  advanceStage: (id, body = {}) =>
    request(`/patients/${encodeURIComponent(id)}/advance-stage`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // Autonomous cohort triage: model picks the subject itself
  workupNext: () => request('/workup/next', { method: 'POST' }),
  workupRun: (maxSteps = 25) =>
    request('/workup/run', { method: 'POST', body: JSON.stringify({ max_steps: maxSteps }) }),
  recordResult: (id, body = {}) =>
    request(`/patients/${encodeURIComponent(id)}/results`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  modelInfo: () => request('/model/info'),

  // ---- FHIR interoperability (Phases 1-4) ----------------------------------
  // Export (Phase 1), inbound ingestion (Phase 2), bidirectional orders and
  // results (Phase 3), SMART on FHIR launch (Phase 4).
  fhirStatus: () => request('/fhir/status'),
  fhirCapability: () => request('/fhir/metadata'),
  fhirEverything: (id) => request(`/fhir/Patient/${encodeURIComponent(id)}/$everything`),
  fhirServiceRequests: (id, status) => {
    const params = new URLSearchParams({ patient: id, count: '200' });
    if (status) params.set('status', status);
    return request(`/fhir/ServiceRequest?${params}`);
  },
  fhirDiagnosticReports: (id) =>
    request(`/fhir/DiagnosticReport?patient=${encodeURIComponent(id)}`),
  fhirIngest: (bundle) =>
    request('/fhir/Bundle', { method: 'POST', body: JSON.stringify(bundle) }),
  fhirPush: (id) => request(`/fhir/push/${encodeURIComponent(id)}`, { method: 'POST' }),
  smartStatus: () => request('/fhir/smart/status'),
  smartRefresh: () => request('/fhir/smart/refresh', { method: 'POST' }),
  smartLogout: () => request('/fhir/smart/logout', { method: 'POST' }),
  smartLaunchUrl: (params = {}) =>
    `${API_BASE}/fhir/smart/launch?${new URLSearchParams(params)}`,

  // ---- ABDM consent flow (FHIR plan.md Phases 4-5) -------------------------
  // NeuroPilot acts as the HIU: consent request -> grant callback -> records
  // request -> Fidelius-encrypted data push. Every call is a real HTTP round trip;
  // nothing about the exchange is simulated inside the browser.
  abdmStatus: () => request('/abdm/status'),
  abdmConsent: (body) =>
    request('/abdm/consent', { method: 'POST', body: JSON.stringify(body) }),
  abdmSession: (id) => request(`/abdm/consent/${encodeURIComponent(id)}`),
  abdmSessions: () => request('/abdm/sessions'),
  abdmRequestRecords: (id) =>
    request(`/abdm/consent/${encodeURIComponent(id)}/records`, { method: 'POST' }),
  abdmReset: () => request('/abdm/reset', { method: 'POST' }),
  // Mock-gateway admin. Best-effort: a deployment pointed at a real Consent
  // Manager has no /mock-abdm mounted, and that must not break the panel.
  abdmMockReset: async () => {
    try {
      return await request('/mock-abdm/reset', { method: 'POST' });
    } catch {
      return null;
    }
  },
  abdmMockDecision: async (decision) => {
    try {
      return await request(`/mock-abdm/decision/${decision}`, { method: 'POST' });
    } catch {
      return null;
    }
  },

  scorePatient: (features) =>
    request('/patients/score', {
      method: 'POST',
      body: JSON.stringify({ features }),
    }),
};

export { API_BASE };