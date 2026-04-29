// ─── Cliente API do CRM Holiz ──────────────────────────────────────────────────
// Módulo para comunicação com os endpoints de integração do CRM

const BASE_URL = process.env.CRM_API_URL || 'https://crm.holiz.com.br/api/integration';
const API_KEY = process.env.CRM_API_KEY || '';

/**
 * Requisição genérica ao CRM.
 */
async function crmFetch(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const { method = 'GET', body } = options;

  const headers = {
    'X-API-Key': API_KEY,
    'Content-Type': 'application/json',
  };

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    });

    const data = await res.json();

    if (!res.ok) {
      return { ok: false, status: res.status, error: data.error || 'Erro desconhecido' };
    }

    return { ok: true, status: res.status, data };
  } catch (err) {
    console.error(`❌ CRM API error (${method} ${path}):`, err.message);
    return { ok: false, status: 0, error: `Falha na conexão: ${err.message}` };
  }
}

// ── Endpoints ────────────────────────────────────────────────────────────────

/**
 * Lista profissionais ativos da clínica.
 */
export async function listProfessionals() {
  return crmFetch('/professionals');
}

/**
 * Consulta horários disponíveis para um profissional em uma data.
 */
export async function checkAvailability(professionalId, date, duration = 60) {
  const params = new URLSearchParams({
    professionalId,
    date,
    duration: String(duration),
  });
  return crmFetch(`/availability?${params}`);
}

/**
 * Busca paciente por telefone ou cria novo se não existir.
 */
export async function findOrCreatePatient(data) {
  return crmFetch('/patients', {
    method: 'POST',
    body: data,
  });
}

/**
 * Cria um agendamento no CRM.
 */
export async function createAppointment(data) {
  return crmFetch('/appointments', {
    method: 'POST',
    body: data,
  });
}

/**
 * Cancela um agendamento.
 */
export async function cancelAppointment(appointmentId, reason) {
  return crmFetch(`/appointments/${appointmentId}/cancel`, {
    method: 'PUT',
    body: { reason },
  });
}


/**
 * Confirma um agendamento (muda status para confirmado).
 */
export async function confirmAppointment(appointmentId) {
  return crmFetch(`/appointments/${appointmentId}/confirm`, {
    method: 'PUT',
  });
}
/**
 * Reagenda um agendamento existente (altera data/hora).
 */
export async function rescheduleAppointment(appointmentId, newDate, newTime, duration) {
  return crmFetch(`/appointments/${appointmentId}/reschedule`, {
    method: 'PUT',
    body: { date: newDate, time: newTime, duration },
  });
}

/**
 * Lista agendamentos futuros de um paciente (por telefone).
 */
export async function getPatientAppointments(phone) {
  const params = new URLSearchParams({ phone });
  return crmFetch(`/appointments?${params}`);
}

/**
 * Lista agendamentos de uma data específica (para lembretes).
 */
export async function getUpcomingAppointments(date, { includeConfirmed = false } = {}) {
  const params = new URLSearchParams({ date });
  return crmFetch(`/appointments/upcoming?${params}`);
}

/**
 * Lista pacotes ativos de um paciente (por telefone).
 */
export async function getPatientPackages(phone) {
  const params = new URLSearchParams({ phone });
  return crmFetch(`/patient-packages?${params}`);
}

/**
 * Lista pacientes com alta recente no CRM (para agendar follow-ups).
 * @param {string} since - ISO datetime string
 */
export async function getRecentDischarges(since) {
  const params = new URLSearchParams({ since });
  return crmFetch(`/discharges?${params}`);
}


/**
 * Lista pacotes ativos sem agendamento futuro (para lembretes de retorno).
 */
export async function getStalePackages() {
  return crmFetch('/packages/stale');
}

/**
 * Lista agendamentos com falta recente (para reagendamento).
 * @param {string} since - YYYY-MM-DD ou ISO datetime
 */
export async function getRecentNoShows(since) {
  const params = new URLSearchParams({ since });
  return crmFetch(`/appointments/no-shows?${params}`);
}

/**
 * Adiciona paciente à lista de espera.
 */
export async function addToWaitlist(patientId, professionalId, preferredDate, preferredPeriod) {
  return crmFetch('/waitlist', {
    method: 'POST',
    body: { patientId, professionalId, preferredDate, preferredPeriod },
  });
}

/**
 * Busca matches de waitlist para data/profissional.
 */
export async function getWaitlistMatches(professionalId, date) {
  const params = new URLSearchParams({ professionalId, date });
  return crmFetch(`/waitlist/matches?${params}`);
}

/**
 * Remove paciente da lista de espera (marca como notified).
 */
export async function removeFromWaitlist(waitlistId) {
  return crmFetch(`/waitlist/${waitlistId}`, { method: 'DELETE' });
}

/**
 * Lista consultas concluídas recentemente (para pós-consulta check-in).
 * @param {string} since - YYYY-MM-DD
 */
export async function getCompletedAppointments(since) {
  const params = new URLSearchParams({ since });
  return crmFetch(`/appointments/completed?${params}`);
}

/**
 * Lista pacientes que fazem aniversário em uma data (MM-DD).
 */
export async function getBirthdays(monthDay) {
  const params = new URLSearchParams({ monthDay });
  return crmFetch(`/patients/birthdays?${params}`);
}

/**
 * Lista pacientes inativos (sem consulta há N dias, sem agendamento futuro).
 */
export async function getInactivePatients(minDaysInactive = 90) {
  const params = new URLSearchParams({ minDaysInactive: String(minDaysInactive) });
  return crmFetch(`/patients/inactive?${params}`);
}

/**
 * Relatório semanal da clínica.
 */
export async function getWeeklyReport(startDate, endDate) {
  const params = new URLSearchParams({ startDate, endDate });
  return crmFetch(`/reports/weekly?${params}`);
}

/**
 * Pacotes com todas as sessões utilizadas (concluídos mas ainda ativos).
 */
export async function getCompletedPackages() {
  return crmFetch('/packages/completed');
}


// ── Log de atividade da Claudia ────────────────────────────────────────────

export async function logClaudiaActivity(type, { patientId = '', patientName = '', phone = '', details = {} } = {}) {
  try {
    const result = await crmFetch('/claudia/log', {
      method: 'POST',
      body: JSON.stringify({ type, patientId, patientName, phone, details }),
    });
    return result;
  } catch (err) {
    // Silenciosamente falhar - não queremos que falhas de log afetem o fluxo principal
    console.warn('⚠️ Erro ao registrar atividade Claudia:', err.message);
    return { ok: false };
  }
}

/**
 * Busca paciente no CRM por telefone (sem criar).
 */
export async function searchPatientByPhone(phone) {
  const params = new URLSearchParams({ phone });
  return crmFetch(`/patients/search?${params}`);
}

export async function searchPatientByName(name) {
  const params = new URLSearchParams({ name });
  return crmFetch(`/patients/search?${params}`);
}

// ── Follow-ups: buscar por telefone e atualizar status ─────────────────────

export async function getFollowUpsByPhone(phone) {
  return crmFetch(`/follow-ups/by-phone/${encodeURIComponent(phone)}`);
}

export async function updateFollowUpStatus(id, status) {
  return crmFetch(`/follow-ups/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status, respondedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
  });
}

// Atualiza campos arbitrários de um follow-up (status, notes, etc.)
export async function updateFollowUp(id, patch) {
  return crmFetch(`/follow-ups/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...patch, updatedAt: new Date().toISOString() }),
  });
}

// Cria um follow-up no Kanban do CRM
export async function createFollowUp(body) {
  return crmFetch('/follow-ups', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
