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
    try {
      const body = await res.json();
      if (typeof body.detail === 'string') message = body.detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
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
  getPipeline: (id) => request(`/patients/${encodeURIComponent(id)}/pipeline`),
  // 12-month progression forecast (trajectory, conversion probability, projected tier)
  getProgression: (id) => request(`/patients/${encodeURIComponent(id)}/progression`),
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
  scorePatient: (features) =>
    request('/patients/score', {
      method: 'POST',
      body: JSON.stringify({ features }),
    }),
};

export { API_BASE };