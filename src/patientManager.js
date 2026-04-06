import { queries } from './database.js';

// ─── Gerenciamento de Pacientes ────────────────────────────────────────────────

/**
 * Busca paciente pelo número de telefone.
 * Tenta match exato, depois por contact_phone, depois variações (com/sem DDI, com/sem 9).
 */
export function getPatientByPhone(rawPhone) {
  const phone = normalizePhone(rawPhone);
  
  // 1. Match exato por phone
  let patient = queries.getPatientByPhone.get(phone);
  if (patient) return patient;
  
  // 2. Match por contact_phone (pacientes registrados via LID)
  patient = queries.getPatientByContactPhone.get(phone);
  if (patient) return patient;
  
  // 3. Tentar variações do número (com/sem DDI 55, com/sem nono dígito 9)
  const variations = getPhoneVariations(phone);
  for (const v of variations) {
    patient = queries.getPatientByPhone.get(v);
    if (patient) return patient;
    patient = queries.getPatientByContactPhone.get(v);
    if (patient) return patient;
  }
  
  return null;
}

/**
 * Gera variações de um número BR: com/sem DDI 55, com/sem nono dígito 9.
 */
function getPhoneVariations(phone) {
  const variations = new Set();
  let p = String(phone).replace(/\D/g, '');
  
  if (p.startsWith('55') && p.length >= 12) {
    const semDDI = p.substring(2);
    variations.add(semDDI);
    const ddd = semDDI.substring(0, 2);
    const num = semDDI.substring(2);
    if (num.length === 8) {
      variations.add('55' + ddd + '9' + num);
      variations.add(ddd + '9' + num);
    }
    if (num.length === 9 && num.startsWith('9')) {
      variations.add('55' + ddd + num.substring(1));
      variations.add(ddd + num.substring(1));
    }
  } else if (p.length >= 10 && p.length <= 11) {
    variations.add('55' + p);
    const ddd = p.substring(0, 2);
    const num = p.substring(2);
    if (num.length === 8) {
      variations.add(ddd + '9' + num);
      variations.add('55' + ddd + '9' + num);
    }
    if (num.length === 9 && num.startsWith('9')) {
      variations.add(ddd + num.substring(1));
      variations.add('55' + ddd + num.substring(1));
    }
  }
  
  return [...variations];
}

/**
 * Cria um novo paciente no banco de dados.
 * O registro começa incompleto (registration_complete = 0) até coletar nome, nascimento e telefone.
 */
export function createPatient({ name = 'Novo Paciente', phone, birth_date = null, contact_phone = null, email = null, specialty = null, notes = null, registration_complete = 0 }) {
  const normalized = normalizePhone(phone);
  const today = new Date().toISOString().split('T')[0];

  const result = queries.insertPatient.run({
    name,
    phone: normalized,
    birth_date,
    contact_phone,
    email,
    specialty,
    first_appointment_date: today,
    notes,
    registration_complete,
  });

  return queries.getPatientById.get(result.lastInsertRowid);
}

/**
 * Atualiza o cadastro do paciente com nome, data de nascimento e telefone de contato.
 * Marca o registro como completo.
 */
/**
 * Registra o consentimento LGPD do paciente.
 */
export function setLgpdConsent(patientId) {
  queries.setLgpdConsent.run(patientId);
}

export function completePatientRegistration(patientId, { name, birth_date, contact_phone }) {
  queries.updatePatientRegistration.run({
    id: patientId,
    name,
    birth_date,
    contact_phone,
  });
  return queries.getPatientById.get(patientId);
}

/**
 * Registra a alta do paciente e agenda todos os follow-ups automaticamente.
 * @param {number} patientId
 * @param {string|null} dischargeDate - formato YYYY-MM-DD, padrão = hoje
 */
export function confirmDischarge(patientId, dischargeDate = null) {
  const date = dischargeDate || new Date().toISOString().split('T')[0];

  // Atualiza status do paciente
  queries.confirmDischarge.run({ id: patientId, discharge_date: date });

  // Cancela follow-ups pendentes anteriores (se houver)
  queries.cancelFollowupsByPatient.run(patientId);

  // Agenda os follow-ups automáticos
  scheduleFollowups(patientId, date);

  return queries.getPatientById.get(patientId);
}

/**
 * Agenda todos os follow-ups para um paciente após a alta.
 * - Pesquisa de satisfação: 1 dia após o primeiro atendimento (ou imediato se já passou)
 * - 1 mês, 3 meses, 6 meses e 12 meses após a alta
 */
function scheduleFollowups(patientId, dischargeDate) {
  const base = new Date(dischargeDate + 'T09:00:00'); // enviar às 9h

  const patient = queries.getPatientById.get(patientId);
  const firstAppointment = patient?.first_appointment_date
    ? new Date(patient.first_appointment_date + 'T09:00:00')
    : new Date();

  // Pesquisa de satisfação: 1 dia após o primeiro atendimento
  const satisfactionDate = new Date(firstAppointment);
  satisfactionDate.setDate(satisfactionDate.getDate() + 1);
  // Se já passou, agendar para amanhã
  if (satisfactionDate <= new Date()) {
    satisfactionDate.setTime(Date.now() + 5 * 60 * 1000); // 5 min a partir de agora
  }

  const followups = [
    { type: 'pesquisa_satisfacao', date: satisfactionDate },
    { type: 'lembrete_1mes',       date: addMonths(base, 1) },
    { type: 'lembrete_3meses',     date: addMonths(base, 3) },
    { type: 'lembrete_6meses',     date: addMonths(base, 6) },
    { type: 'lembrete_12meses',    date: addMonths(base, 12) },
  ];

  for (const f of followups) {
    queries.insertFollowup.run({
      patient_id:     patientId,
      type:           f.type,
      scheduled_date: f.date.toISOString().replace('T', ' ').slice(0, 19),
    });
  }

  console.log(`📅 Follow-ups agendados para paciente #${patientId}:`);
  followups.forEach(f =>
    console.log(`  - ${f.type}: ${f.date.toLocaleString('pt-BR')}`));
}

/**
 * Agenda um check-in para o dia seguinte após o paciente confirmar o agendamento.
 * Enviado às 10h do dia seguinte à confirmação.
 */
export function schedulePostConfirmationFollowup(patientId) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(10, 0, 0, 0); // Envia às 10h do dia seguinte

  const scheduledDate = tomorrow.toISOString().replace('T', ' ').slice(0, 19);

  queries.insertFollowup.run({
    patient_id:     patientId,
    type:           'pos_confirmacao_d1',
    scheduled_date: scheduledDate,
  });

  console.log(`📅 Check-in pós-consulta agendado para ${tomorrow.toLocaleString('pt-BR')} — paciente #${patientId}`);
}

/**
 * Retorna o histórico de conversas do paciente (para contexto da IA).
 */
export function getConversationHistory(patientId) {
  const rows = queries.getConversationHistory.all(patientId);
  // A query retorna em ordem DESC, revertemos para order cronológica
  return rows.reverse().map(r => ({ role: r.role, content: r.content }));
}

/**
 * Salva uma mensagem no histórico do paciente.
 */
export function saveMessage(patientId, role, content) {
  queries.insertMessage.run(patientId, role, content);
}

/**
 * Salva log de mensagem enviada/recebida.
 */
export function logMessage(phone, direction, content, type = 'text') {
  queries.logMessage.run(phone, direction, content, type);
}

/**
 * Retorna todos os follow-ups pendentes que devem ser enviados agora.
 */
export function getPendingFollowups() {
  return queries.getPendingFollowups.all();
}

/**
 * Marca follow-up como enviado.
 */
export function markFollowupSent(followupId) {
  queries.markFollowupSent.run(followupId);
}

/**
 * Marca follow-up como respondido.
 */
export function markFollowupResponded(followupId, response) {
  queries.markFollowupResponded.run({ id: followupId, response });
}

/**
 * Lista todos os pacientes.
 */
export function listAllPatients() {
  return queries.getAllPatients.all();
}

/**
 * Lista pacientes com alta confirmada.
 */
export function listDischargedPatients() {
  return queries.getDischargedPatients.all();
}

/**
 * Retorna todos os follow-ups de um paciente.
 */
export function getPatientFollowups(patientId) {
  return queries.getFollowupsByPatient.all(patientId);
}

// ─── Utilitários ──────────────────────────────────────────────────────────────

/**
 * Normaliza número de telefone para o formato usado no banco (sem caracteres especiais).
 * Ex: +55 (11) 99999-9999 → 5511999999999
 */
function normalizePhone(phone) {
  return String(phone).replace(/\D/g, '');
}

/**
 * Adiciona N meses a uma data, mantendo o mesmo horário.
 */
function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}
