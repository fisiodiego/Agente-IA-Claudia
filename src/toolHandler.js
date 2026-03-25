// ─── Handler de Execução de Tools ──────────────────────────────────────────────
// Recebe tool_name + tool_input do Claude response e executa via crmApi

import {
  listProfessionals,
  checkAvailability,
  findOrCreatePatient,
  createAppointment,
  cancelAppointment,
  rescheduleAppointment,
  getPatientAppointments,
  getPatientPackages,
  addToWaitlist,
} from './crmApi.js';

/**
 * Executa uma tool e retorna o resultado formatado para tool_result.
 */
export async function handleToolCall(toolName, toolInput) {
  console.log(`🔧 Tool call: ${toolName}`, JSON.stringify(toolInput));

  try {
    switch (toolName) {
      case 'list_professionals': {
        const result = await listProfessionals();
        if (!result.ok) return JSON.stringify({ error: result.error });

        let professionals = result.data;

        if (toolInput.specialty) {
          professionals = professionals.filter(
            (p) => p.specialty === toolInput.specialty
          );
        }

        if (professionals.length === 0) {
          return JSON.stringify({
            message: 'Nenhum profissional encontrado para essa especialidade.',
            professionals: [],
          });
        }

        return JSON.stringify({
          message: `Encontrados ${professionals.length} profissional(is).`,
          professionals: professionals.map((p) => ({
            id: p.id,
            name: p.name,
            specialty: p.specialty,
          })),
        });
      }

      case 'check_availability': {
        const { professionalId, date, duration } = toolInput;
        const result = await checkAvailability(professionalId, date, duration);
        if (!result.ok) return JSON.stringify({ error: result.error });

        const { professionalName, dayOfWeek, slots } = result.data;

        // Filtrar slots com mínimo 12h de antecedência
        const nowBRT = new Date(Date.now() - 3 * 3600000); // UTC-3
        const minTime = new Date(nowBRT.getTime() + 12 * 3600000); // +12h
        const filteredSlots = slots.filter(slot => {
          const slotDate = new Date(`${date}T${slot}:00`);
          return slotDate >= minTime;
        });

        if (filteredSlots.length === 0) {
          return JSON.stringify({
            message: `Não há horários disponíveis para ${professionalName} em ${formatDateBR(date)} (${dayOfWeek}). Agendamentos precisam de no mínimo 12h de antecedência.`,
            dayOfWeek,
            slots: [],
          });
        }

        return JSON.stringify({
          message: `Horários disponíveis para ${professionalName} em ${formatDateBR(date)} (${dayOfWeek}):`,
          professionalName,
          date,
          dayOfWeek,
          slots: filteredSlots,
        });
      }

      case 'find_or_create_patient': {
        const result = await findOrCreatePatient(toolInput);
        if (!result.ok) return JSON.stringify({ error: result.error });

        const { patient, created } = result.data;
        return JSON.stringify({
          message: created
            ? `Paciente ${patient.name} cadastrado com sucesso no CRM.`
            : `Paciente ${patient.name} já existe no CRM.`,
          patientId: patient.id,
          patientName: patient.name,
          created,
        });
      }

      case 'create_appointment': {
        // Validar mínimo 12h de antecedência
        const aptDate = new Date(`${toolInput.date}T${toolInput.time}:00`);
        const nowBRT2 = new Date(Date.now() - 3 * 3600000);
        const minTime2 = new Date(nowBRT2.getTime() + 12 * 3600000);
        if (aptDate < minTime2) {
          return JSON.stringify({ error: 'Não é possível agendar com menos de 12 horas de antecedência. Por favor, escolha um horário mais adiante.' });
        }
        const result = await createAppointment(toolInput);
        if (!result.ok) {
          return JSON.stringify({
            error: result.error,
            message: `Não foi possível criar o agendamento: ${result.error}`,
          });
        }

        const apt = result.data;
        const response = {
          message: `Agendamento criado com sucesso!`,
          appointmentId: apt.id,
          date: apt.date,
          time: apt.time,
          duration: apt.duration,
          status: apt.status,
        };

        // Se foi vinculado a um pacote, incluir info
        if (apt.packageInfo) {
          response.packageInfo = apt.packageInfo;
          response.message = `Agendamento criado com sucesso! Sessão vinculada ao pacote "${apt.packageInfo.packageName}" (${apt.packageInfo.usedSessions + apt.packageInfo.scheduledAfter}/${apt.packageInfo.totalSessions} usadas/agendadas, restam ${apt.packageInfo.remainingAfter}).`;
        }

        return JSON.stringify(response);
      }

      case 'cancel_appointment': {
        const { appointmentId, reason } = toolInput;
        const result = await cancelAppointment(appointmentId, reason);
        if (!result.ok) return JSON.stringify({ error: result.error });

        const response = {
          message: 'Agendamento cancelado com sucesso.',
          appointmentId,
        };

        // Se há pacientes na lista de espera, incluir na resposta
        if (result.data.waitlistMatches && result.data.waitlistMatches.length > 0) {
          response.waitlistMatches = result.data.waitlistMatches;
          response.message += ` Há ${result.data.waitlistMatches.length} paciente(s) na lista de espera para esta data/profissional.`;
        }

        return JSON.stringify(response);
      }

      case 'reschedule_appointment': {
        const { appointmentId, newDate, newTime, duration } = toolInput;
        const result = await rescheduleAppointment(appointmentId, newDate, newTime, duration);
        if (!result.ok) {
          return JSON.stringify({
            error: result.error,
            message: `Não foi possível reagendar: ${result.error}`,
          });
        }

        const apt = result.data;
        return JSON.stringify({
          message: `Agendamento reagendado com sucesso!`,
          appointmentId: apt.id,
          newDate: apt.date,
          newTime: apt.time,
          duration: apt.duration,
          status: apt.status,
        });
      }

      case 'get_patient_appointments': {
        const { phone } = toolInput;
        const result = await getPatientAppointments(phone);
        if (!result.ok) return JSON.stringify({ error: result.error });

        const appointments = result.data;
        if (appointments.length === 0) {
          return JSON.stringify({
            message: 'Nenhum agendamento futuro encontrado para este paciente.',
            appointments: [],
          });
        }

        return JSON.stringify({
          message: `Encontrados ${appointments.length} agendamento(s) futuro(s).`,
          appointments: appointments.map((a) => ({
            id: a.id,
            date: formatDateBR(a.date),
            time: a.time,
            duration: a.duration,
            professionalName: a.professionalName,
            status: a.status,
          })),
        });
      }

      case 'get_patient_packages': {
        const { phone } = toolInput;
        const result = await getPatientPackages(phone);
        if (!result.ok) return JSON.stringify({ error: result.error });

        const packages = result.data;
        if (packages.length === 0) {
          return JSON.stringify({
            message: 'Paciente não possui pacotes de tratamento ativos. Será agendada uma consulta avulsa.',
            packages: [],
          });
        }

        return JSON.stringify({
          message: `Paciente possui ${packages.length} pacote(s) ativo(s).`,
          packages: packages.map((p) => ({
            id: p.id,
            name: p.productName,
            totalSessions: p.totalSessions,
            usedSessions: p.usedSessions,
            scheduledSessions: p.scheduledSessions,
            freeSessions: p.freeSessions,
            amountPaid: p.amountPaid,
            amountTotal: p.amountTotal,
          })),
        });
      }

      case 'add_to_waitlist': {
        const { patientId, professionalId, preferredDate, preferredPeriod } = toolInput;
        const result = await addToWaitlist(patientId, professionalId, preferredDate, preferredPeriod || 'qualquer');
        if (!result.ok) {
          return JSON.stringify({
            error: result.error,
            message: `Não foi possível adicionar à lista de espera: ${result.error}`,
          });
        }

        return JSON.stringify({
          message: `Paciente adicionado à lista de espera para ${formatDateBR(preferredDate)}. Será notificado automaticamente quando abrir uma vaga!`,
          waitlistId: result.data.id,
          preferredDate,
          preferredPeriod: preferredPeriod || 'qualquer',
        });
      }

      default:
        return JSON.stringify({ error: `Tool desconhecida: ${toolName}` });
    }
  } catch (err) {
    console.error(`❌ Erro ao executar tool ${toolName}:`, err.message);
    return JSON.stringify({
      error: `Erro interno ao executar ${toolName}: ${err.message}`,
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDateBR(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}
