const env = import.meta.env || {};

export const USE_MOCK = String(env.VITE_USE_MOCK ?? 'true') !== 'false';
export const API_URL = env.VITE_API_URL || '';

// The demo works on one synthetic patient. Replace with patient search once the backend exists.
export const PATIENT_ID = 'SYN-20481';

// Polling intervals (ms). Under high load the app slows background refreshes on purpose.
export const POLL = {
  queue: { normal: 10_000, high: 60_000 },
  ticket: { normal: 15_000, high: 45_000 },
  uploads: { normal: 2_500, high: 8_000 },
};
