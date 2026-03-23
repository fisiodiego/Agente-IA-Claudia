// ─── Definições de Tools para Claude API (tool_use) ────────────────────────────
// Cada tool mapeia para um endpoint do CRM Holiz

export const CRM_TOOLS = [
  {
    name: 'list_professionals',
    description: 'Lista os profissionais ativos da clínica com nome e especialidade. Use quando o paciente perguntar quais profissionais estão disponíveis ou quando precisar do ID de um profissional para agendar.',
    input_schema: {
      type: 'object',
      properties: {
        specialty: {
          type: 'string',
          description: 'Filtrar por especialidade (opcional): osteopatia, quiropraxia, psicologia',
          enum: ['osteopatia', 'quiropraxia', 'psicologia'],
        },
      },
      required: [],
    },
  },
  {
    name: 'check_availability',
    description: 'Consulta os horários disponíveis de um profissional em uma data específica. Retorna uma lista de horários livres. Use quando o paciente quiser saber horários disponíveis ou quando precisar verificar se um horário está livre antes de agendar.',
    input_schema: {
      type: 'object',
      properties: {
        professionalId: {
          type: 'string',
          description: 'ID do profissional (obtido via list_professionals)',
        },
        date: {
          type: 'string',
          description: 'Data desejada no formato YYYY-MM-DD',
        },
        duration: {
          type: 'number',
          description: 'Duração da consulta em minutos (padrão: 60)',
        },
      },
      required: ['professionalId', 'date'],
    },
  },
  {
    name: 'find_or_create_patient',
    description: 'Busca um paciente pelo telefone no CRM. Se não existir, cria um novo cadastro. Use antes de criar um agendamento para obter o patientId.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Nome completo do paciente',
        },
        phone: {
          type: 'string',
          description: 'Telefone do paciente (apenas dígitos)',
        },
        birthDate: {
          type: 'string',
          description: 'Data de nascimento no formato YYYY-MM-DD (opcional)',
        },
        email: {
          type: 'string',
          description: 'Email do paciente (opcional)',
        },
      },
      required: ['name', 'phone'],
    },
  },
  {
    name: 'create_appointment',
    description: 'Cria um novo agendamento no CRM. Valida automaticamente: disponibilidade do profissional, conflitos de horário e bloqueios de agenda. Use após confirmar com o paciente o horário desejado.',
    input_schema: {
      type: 'object',
      properties: {
        patientId: {
          type: 'string',
          description: 'ID do paciente (obtido via find_or_create_patient)',
        },
        professionalId: {
          type: 'string',
          description: 'ID do profissional (obtido via list_professionals)',
        },
        date: {
          type: 'string',
          description: 'Data do agendamento no formato YYYY-MM-DD',
        },
        time: {
          type: 'string',
          description: 'Horário do agendamento no formato HH:MM (ex: 09:00, 14:30)',
        },
        duration: {
          type: 'number',
          description: 'Duração em minutos (padrão: 60)',
        },
        notes: {
          type: 'string',
          description: 'Observações sobre o agendamento (opcional)',
        },
      },
      required: ['patientId', 'professionalId', 'date', 'time'],
    },
  },
  {
    name: 'cancel_appointment',
    description: 'Cancela um agendamento existente. Use quando o paciente solicitar cancelamento de uma consulta.',
    input_schema: {
      type: 'object',
      properties: {
        appointmentId: {
          type: 'string',
          description: 'ID do agendamento a ser cancelado (obtido via get_patient_appointments)',
        },
        reason: {
          type: 'string',
          description: 'Motivo do cancelamento (opcional)',
        },
      },
      required: ['appointmentId'],
    },
  },
  {
    name: 'reschedule_appointment',
    description: 'Reagenda um agendamento existente para nova data e/ou horário. Valida automaticamente disponibilidade e conflitos. Use quando o paciente quiser mudar a data ou horário de uma consulta já agendada, em vez de cancelar e criar um novo.',
    input_schema: {
      type: 'object',
      properties: {
        appointmentId: {
          type: 'string',
          description: 'ID do agendamento a ser reagendado (obtido via get_patient_appointments)',
        },
        newDate: {
          type: 'string',
          description: 'Nova data no formato YYYY-MM-DD',
        },
        newTime: {
          type: 'string',
          description: 'Novo horário no formato HH:MM (ex: 09:00, 14:30)',
        },
        duration: {
          type: 'number',
          description: 'Nova duração em minutos (opcional, mantém a anterior se não informado)',
        },
      },
      required: ['appointmentId', 'newDate', 'newTime'],
    },
  },
  {
    name: 'get_patient_appointments',
    description: 'Lista os agendamentos futuros de um paciente. Use quando o paciente perguntar sobre suas próximas consultas ou quando precisar encontrar um agendamento para cancelar ou reagendar.',
    input_schema: {
      type: 'object',
      properties: {
        phone: {
          type: 'string',
          description: 'Telefone do paciente (apenas dígitos)',
        },
      },
      required: ['phone'],
    },
  },
  {
    name: 'get_patient_packages',
    description: 'Lista os pacotes de tratamento ativos de um paciente (ex: Osteopatia 5 sessões). Use ANTES de agendar para verificar se o paciente possui pacote ativo — se tiver, o agendamento será vinculado automaticamente ao pacote.',
    input_schema: {
      type: 'object',
      properties: {
        phone: {
          type: 'string',
          description: 'Telefone do paciente (apenas dígitos)',
        },
      },
      required: ['phone'],
    },
  },
  {
    name: 'add_to_waitlist',
    description: 'Adiciona um paciente à lista de espera para uma data e profissional específicos. Use quando não houver horários disponíveis e o paciente quiser ser notificado caso abra uma vaga.',
    input_schema: {
      type: 'object',
      properties: {
        patientId: {
          type: 'string',
          description: 'ID do paciente (obtido via find_or_create_patient)',
        },
        professionalId: {
          type: 'string',
          description: 'ID do profissional',
        },
        preferredDate: {
          type: 'string',
          description: 'Data preferida no formato YYYY-MM-DD',
        },
        preferredPeriod: {
          type: 'string',
          description: 'Período preferido: manha, tarde, qualquer',
          enum: ['manha', 'tarde', 'qualquer'],
        },
      },
      required: ['patientId', 'professionalId', 'preferredDate'],
    },
  },
];
