import { USE_MOCK } from '../config';
import { request } from './client';

const data = (p) => p.then((r) => r.data);

// Every call the frontend makes. This is also the contract for the backend team (see README).
export const api = {
  patient: (pid) => data(request(`/api/patients/${pid}`)),
  visits: (pid) => data(request(`/api/patients/${pid}/visits`)),
  compare: (pid, a, b) => data(request(`/api/patients/${pid}/compare?a=${a}&b=${b}`)),
  submitFlags: (pid, body, key) =>
    data(request(`/api/patients/${pid}/flags`, { method: 'POST', body, idempotencyKey: key })),

  tickets: (params = {}) => data(request(`/api/tickets?${new URLSearchParams(params)}`)),
  ticket: (id) => data(request(`/api/tickets/${id}`)),
  claim: (id, version, key) =>
    data(request(`/api/tickets/${id}/claim`, { method: 'POST', ifMatch: version, idempotencyKey: key })),
  release: (id, version, key) =>
    data(request(`/api/tickets/${id}/release`, { method: 'POST', ifMatch: version, idempotencyKey: key })),
  resolve: (id, version, body, key) =>
    data(request(`/api/tickets/${id}/resolve`, { method: 'POST', ifMatch: version, body, idempotencyKey: key })),

  audit: (cursor) => data(request(`/api/audit?limit=15${cursor ? `&cursor=${cursor}` : ''}`)),

  uploads: (pid) => data(request(`/api/uploads?patientId=${pid}`)),
  upload: (id) => data(request(`/api/uploads/${id}`)),
  createUpload: (body, key) => data(request('/api/uploads', { method: 'POST', body, idempotencyKey: key })),
  // Real mode: uploadUrl is a presigned storage URL, so the file never passes through the API server.
  putFile: (uploadUrl, file) => request(uploadUrl, { method: 'PUT', body: file, timeoutMs: 120_000 }),
  completeUpload: (id) =>
    data(request(`/api/uploads/${id}/complete`, { method: 'POST', idempotencyKey: `complete_${id}` })),

  patientView: (pid) => data(request(`/api/patients/${pid}/patient-view`)),
  handover: (pid, key) => data(request(`/api/patients/${pid}/handover`, { method: 'POST', idempotencyKey: key })),
};

// Demo controls: served by the mock and by the Python backend when DEMO_MODE=true.
export const demoApi = {
  stats: () => data(request('/api/__demo/stats', { noDedupe: true })),
  reset: () => data(request('/api/__demo/reset', { method: 'POST' })),
  settings: () => data(request('/api/__demo/settings', { noDedupe: true })),
  setHighLoad: (highLoad) => data(request('/api/__demo/settings', { method: 'PUT', body: { highLoad } })),
};

export const BACKEND_LABEL = USE_MOCK ? 'Mock backend' : 'Python backend';
