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
  getFollowUpsByPhone,
  updateFollowUp,
} from './crmApi.js';

// ─── Rastreamento de última check_availability por paciente (phone) ─────────
// Usado para detectar divergência de data entre check_availability e create_appointment.
const lastAvailabilityCheck = new Map(); // phone -> { professionalId, date, ts }
const AVAILABILITY_TTL_MS = 5 * 60 * 1000; // 5 min

// ─── Rastreamento de create_appointment bem-sucedidos por paciente (phone) ──
// Usado para avisar o LLM quando ele chama check_availability na mesma data
// logo após criar um agendamento — evita interpretar o próprio slot como "ocupado
// por outro paciente". Casos Lidia/Carol (12/mai) e Dimitri/Anna (12/mai).
const recentCreates = new Map(); // phone -> [{ professionalId, date, time, ts }, ...]
const RECENT_CREATE_TTL_MS = 10 * 60 * 1000; // 10 min

/**
 * Executa uma tool e retorna o resultado formatado para tool_result.
 */
export async function handleToolCall(toolName, toolInput, phone = null) {
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

        const { professionalName, dayOfWeek, slots, holidayName } = result.data;

        // ⚠️ Detectar se essa data já teve create_appointment recente (< 10 min).
        // Se sim, o LLM pode interpretar o slot ocupado como conflito externo
        // quando na verdade foi ele mesmo que criou. Avisar explicitamente.
        const ownCreates = phone
          ? (recentCreates.get(phone) || []).filter(
              c => c.professionalId === professionalId
                && c.date === date
                && (Date.now() - c.ts) < RECENT_CREATE_TTL_MS
            )
          : [];

        // Feriado: clínica fechada, retornar mensagem específica.
        // Backend já zera os slots quando é feriado ativo na tabela holidays.
        if (holidayName) {
          return JSON.stringify({
            message: `${formatDateBR(date)} é feriado (${holidayName}) e a clínica não funciona. Sugira outra data ao paciente.`,
            isHoliday: true,
            holidayName,
            dayOfWeek,
            slots: [],
          });
        }

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

        // Registrar último check para validação cruzada em create_appointment
        if (phone) {
          lastAvailabilityCheck.set(phone, {
            professionalId,
            date,
            ts: Date.now(),
          });
        }

        const response = {
          message: `Horários disponíveis para ${professionalName} em ${formatDateBR(date)} (${dayOfWeek}):`,
          professionalName,
          date,
          dayOfWeek,
          slots: filteredSlots,
        };

        // Se houver creates recentes nessa data, anexar aviso explícito.
        if (ownCreates.length > 0) {
          const horarios = ownCreates.map(c => c.time).join(', ');
          response.warning =
            `⚠️ ATENÇÃO: você acabou de criar agendamento(s) nesta data nos horários: ${horarios}. ` +
            `Esses slots NÃO aparecem na lista 'slots' acima (estão ocupados) porque VOCÊ MESMA os criou. ` +
            `NÃO interprete como conflito ou indisponibilidade. NÃO volte atrás dizendo "não está disponível" ` +
            `os horários que você acabou de agendar. Se o paciente confirmou, a marcação é FINAL.`;
          response.ownRecentCreates = ownCreates.map(c => ({ time: c.time, createdAgo: `${Math.round((Date.now() - c.ts)/1000)}s` }));
        }

        return JSON.stringify(response);
      }

      case 'find_or_create_patient': {
        // GUARD: ao CRIAR paciente novo, birthDate é OBRIGATÓRIO.
        // Schema da tool diz "opcional" mas o LLM precisa pedir antes de
        // criar. Caso Lílian, Luise Pierote, Mauricio (04/05/2026) — várias
        // pacientes nasceram no banco sem birth_date porque Claudia pulou
        // o pedido seguindo o schema. Aqui rejeitamos a chamada quando
        // tenta criar paciente novo sem birthDate, forçando a IA a coletar.
        //
        // Se paciente JÁ EXISTE no CRM (encontrado por phone), birthDate
        // é desnecessário — tool retorna existente e pula validação.
        const { searchPatientByPhone } = await import('./crmApi.js');
        const existingResult = await searchPatientByPhone(toolInput.phone);
        const exists = existingResult?.ok && existingResult?.data?.found;

        if (!exists && !toolInput.birthDate) {
          return JSON.stringify({
            error: 'BIRTHDATE_REQUIRED',
            message: 'Paciente não está cadastrado no CRM. Antes de criar o cadastro, peça a data de nascimento ao paciente (formato DD/MM/AAAA). Só chame find_or_create_patient novamente DEPOIS de obter a data.',
          });
        }

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
        // ⚠️ Validar consistência com último check_availability (defense-in-depth)
        if (phone) {
          const last = lastAvailabilityCheck.get(phone);
          if (last && (Date.now() - last.ts) < AVAILABILITY_TTL_MS) {
            const sameProf = last.professionalId === toolInput.professionalId;
            const sameDate = last.date === toolInput.date;
            if (sameProf && !sameDate) {
              console.warn(`⚠️ Date mismatch bloqueado — paciente ${phone}: check=${last.date}, create=${toolInput.date}`);
              return JSON.stringify({
                error: 'DATE_MISMATCH',
                message: `Inconsistência detectada: você verificou disponibilidade para ${last.date} mas tentou agendar ${toolInput.date}. Chame check_availability novamente com a data correta antes de agendar.`,
              });
            }
          }
        }

        // ⚠️ GUARD: bloqueia create_appointment se paciente já tem agendamento
        // ativo na MESMA DATA com o mesmo profissional. Permite consultas em
        // datas diferentes (avaliação + retorno, sequência de pacote).
        //
        // Caso real (Caio Santos, 08/05/2026): Claudia agendou 14h, paciente
        // pediu mudar pra 13h, LLM chamou create_appointment de novo em vez
        // de reschedule_appointment → 2 agendamentos paralelos no mesmo dia.
        //
        // Bypass via toolInput.forceCreate=true: usado quando paciente confirma
        // explicitamente que quer outra consulta no mesmo dia (raro: pacote
        // intensivo, 2 consultas seguidas, etc.).
        if (
          !toolInput.forceCreate &&
          phone &&
          toolInput.patientId &&
          toolInput.professionalId &&
          toolInput.date
        ) {
          try {
            const aptsResult = await getPatientAppointments(phone);
            if (aptsResult?.ok && Array.isArray(aptsResult.data)) {
              const conflict = aptsResult.data.find((a) =>
                a.professionalId === toolInput.professionalId &&
                a.date === toolInput.date &&
                (a.status === 'agendado' || a.status === 'confirmado')
              );
              if (conflict) {
                console.warn(`⚠️ EXISTING_APPOINTMENT bloqueado — paciente ${phone} já tem ${conflict.id} em ${conflict.date} ${conflict.time}`);
                return JSON.stringify({
                  error: 'EXISTING_APPOINTMENT',
                  message: `Esse paciente já tem agendamento ativo em ${conflict.date} às ${conflict.time} (id: ${conflict.id}).\n\n` +
                    `Se o paciente quer MUDAR DE HORÁRIO: use reschedule_appointment com appointmentId="${conflict.id}", newDate="${toolInput.date}", newTime="${toolInput.time}".\n\n` +
                    `Se o paciente confirmou EXPLICITAMENTE que quer DUAS consultas no MESMO DIA (caso raro — pacote intensivo, sessões seguidas): chame create_appointment novamente passando forceCreate=true.\n\n` +
                    `Se você não tem certeza qual cenário é: PERGUNTE ao paciente antes de tentar de novo.`,
                  existingAppointment: {
                    id: conflict.id,
                    date: conflict.date,
                    time: conflict.time,
                    status: conflict.status,
                  },
                });
              }
            }
          } catch (e) {
            // Falha no guard não bloqueia o fluxo principal — só loga
            console.warn('⚠️ Falha no guard EXISTING_APPOINTMENT:', e.message);
          }
        }
        if (toolInput.forceCreate) {
          console.log(`🟡 forceCreate=true — bypass do guard EXISTING_APPOINTMENT pra ${phone}`);
        }

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

        // Registrar create bem-sucedido em recentCreates pra evitar confusão se LLM
        // chamar check_availability na mesma data logo depois.
        if (phone) {
          const arr = recentCreates.get(phone) || [];
          arr.push({
            professionalId: toolInput.professionalId,
            date: apt.date,
            time: apt.time,
            ts: Date.now(),
          });
          // Limpar entradas expiradas pra Map não crescer indefinido
          const cutoff = Date.now() - RECENT_CREATE_TTL_MS;
          recentCreates.set(phone, arr.filter(c => c.ts > cutoff));
        }

        const response = {
          message: `Agendamento criado com sucesso! IMPORTANTE: a marcação é FINAL. NÃO chame check_availability nesta data nos próximos turnos. NÃO volte atrás dizendo "não está disponível".`,
          appointmentId: apt.id,
          date: apt.date,
          time: apt.time,
          duration: apt.duration,
          status: apt.status,
        };

        // Se foi vinculado a um pacote, incluir info
        if (apt.packageInfo) {
          response.packageInfo = apt.packageInfo;
          response.message = `Agendamento criado com sucesso! Sessão vinculada ao pacote "${apt.packageInfo.packageName}" (${apt.packageInfo.usedSessions + apt.packageInfo.scheduledAfter}/${apt.packageInfo.totalSessions} usadas/agendadas, restam ${apt.packageInfo.remainingAfter}). IMPORTANTE: marcação é FINAL.`;
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

        // Fechar follow-up "reagendar_pendente" (se existir) → status 'agendou'
        try {
          const phoneToCheck = apt.patientPhone || apt.phone;
          if (phoneToCheck) {
            const fuResult = await getFollowUpsByPhone(phoneToCheck);
            const fuArr = Array.isArray(fuResult?.data) ? fuResult.data : [];
            const pending = fuArr.find(f =>
              f.source === 'reagendar_pendente' &&
              f.status !== 'agendou' &&
              f.status !== 'perdido' &&
              typeof f.notes === 'string' &&
              f.notes.includes(`[apt_id:${appointmentId}]`)
            );
            if (pending) {
              const [y, m, d] = String(apt.date || '').split('-');
              const dateBR = y && m && d ? `${d}/${m}` : (apt.date || '?');
              const newNotes = `${pending.notes || ''} | Reagendado para ${dateBR} ${apt.time || ''}`.trim();
              await updateFollowUp(pending.id, { status: 'agendou', notes: newNotes });
              console.log(`✅ Follow-up reagendar_pendente ${pending.id} → 'agendou' (apt ${appointmentId})`);
            }
          }
        } catch (err) {
          console.warn('⚠️ Erro ao fechar follow-up reagendar_pendente:', err.message);
        }

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
